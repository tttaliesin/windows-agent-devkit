import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { resolvePowerShell } from './windows.mjs';

const HELPER = fileURLToPath(new URL('../scripts/start-owned-session.ps1', import.meta.url));
const PROTOCOL = 2;
const absolute = (value) => typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value)) && !/[\0\r\n]/.test(value);
const pid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;

/** pwshPath is an optional parent-verified PowerShell 7 executable.
 * Environment stays in the inherited environment, never the settings file.
 * Only an authenticated, empty-job handshake plus helper exit proves cleanup.
 */
export function createWindowsJobSession(executable, args, {
  cwd = process.cwd(), env = process.env, timeoutMs = 30000, cleanupTimeoutMs = 1000,
  startupTimeoutMs = 15000, pwshPath, signal, spawnImpl = spawn,
} = {}) {
  let helper, helperPid = null, rootPid = null, directory, settingsPath, stopping, result, startedResult;
  let launchTimer, lifetimeTimer, startupDeadline, handshake;
  let ready = false, startAuthorized = false, startupTimedOut = false, stopRequested = false, protocolFailed = false;
  let outputBytes = 0, pending = '';
  const token = randomBytes(32).toString('hex'), decoder = new StringDecoder('utf8');
  let resolveStarted, resolveFinished;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const start = (value) => { if (!startedResult) resolveStarted(startedResult = value); };
  const tree = () => ({ treeState: result ? result.treeTerminated ? 'clean' : 'unknown' : rootPid ? 'owned' : helperPid ? 'unknown' : 'not_started',
    treeTerminated: result?.treeTerminated === true, proof: result?.proof ?? (rootPid ? 'windows_job_owned' : 'windows_job_pending'), rootPid, helperPid,
    ...(result && !result.treeTerminated ? { recovery: { parentPid: rootPid, helperPid, reason: result.proof } } : {}) });
  const finish = async (code, reason = 'windows_job_helper_exited') => {
    if (result) return;
    clearTimeout(launchTimer); clearTimeout(lifetimeTimer); signal?.removeEventListener('abort', abort);
    const proven = !protocolFailed && code === 0 && handshake?.activeProcesses === 0 && handshake.pid === (rootPid ?? 0);
    const timedOut = startupTimedOut || handshake?.timedOut;
    result = { state: reason === 'invalid_session_options' ? 'not_run' : timedOut ? 'timed_out' : proven && rootPid && handshake.exitCode === 0 ? 'succeeded' : 'failed', exitCode: handshake?.exitCode ?? null,
      forced: handshake?.forced === true, treeTerminated: proven, proof: proven ? 'windows_job_empty' : reason, rootPid, helperPid };
    start({ ...result, pid: rootPid });
    helper?.stdin?.destroy(); helper?.stdout?.destroy(); helper?.stderr?.destroy(); helper?.unref?.();
    if (directory) {
      const relative = path.relative(tmpdir(), directory);
      if (relative.startsWith('windows-agent-job-') && !relative.includes(path.sep)) {
        try { await rm(directory, { recursive: true, force: true }); } catch { result.settingsCleanup = 'unknown'; }
      }
    }
    resolveFinished({ ...result, ...tree() });
  };
  const wait = async (ms = 1000) => {
    let timer;
    try { return await Promise.race([finished, new Promise((resolve) => { timer = setTimeout(() => resolve({ state: 'timed_out', exitCode: null, ...tree() }), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const requestStop = () => {
    stopRequested = true;
    try { helper?.stdin?.end('stop\n'); } catch {}
  };
  const stop = ({ graceMs = 1000 } = {}) => {
    if (stopping) return stopping;
    stopping = (async () => {
      requestStop();
      await wait(Math.max(1, graceMs) + cleanupTimeoutMs + (rootPid ? 250 : startupTimeoutMs));
      if (!result) {
        // Closing the only job owner triggers KILL_ON_JOB_CLOSE, but is not an empty-job proof.
        try { helper?.kill(); } catch {}
        await wait(Math.max(100, graceMs));
      }
      if (!result) await finish(null, 'windows_job_helper_unresponsive');
      return finished;
    })();
    return stopping;
  };
  const abort = () => { void stop({ graceMs: 250 }); };
  const expireStartup = () => {
    if (stopRequested) return;
    startupTimedOut = true;
    void stop({ graceMs: 100 });
  };
  const withinStartup = () => {
    if (performance.now() >= startupDeadline) expireStartup();
    return !stopRequested;
  };
  const rejectProtocol = () => {
    protocolFailed = true;
    void stop({ graceMs: 100 });
  };
  const session = { started, finished, wait, stop, tree, status: () => result ?? { state: 'running', pid: rootPid, helperPid } };
  const receive = (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 64 * 1024) { rejectProtocol(); return; }
    pending += decoder.write(chunk);
    for (let end; (end = pending.indexOf('\n')) >= 0;) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { rejectProtocol(); continue; }
      if (!message || message.protocol !== PROTOCOL || message.token !== token || !['ready', 'started', 'finished'].includes(message.event)
        || !Number.isInteger(message.activeProcesses) || message.activeProcesses < 0) {
        rejectProtocol(); continue;
      }
      if (message.event === 'ready') {
        if (ready || handshake || message.pid !== 0 || message.activeProcesses !== 0) { rejectProtocol(); continue; }
        ready = true;
        // The helper waits for this grant before creating the process.
        if (withinStartup()) {
          startAuthorized = true;
          try { helper.stdin.write('start\n'); }
          catch { startAuthorized = false; rejectProtocol(); }
        }
      } else if (message.event === 'started') {
        // A short-lived root may already have exited after ResumeThread.
        if (!startAuthorized || rootPid || handshake || !pid(message.pid)) { rejectProtocol(); continue; }
        rootPid = message.pid; clearTimeout(launchTimer);
        if (withinStartup()) start({ state: 'running', pid: rootPid, helperPid });
      } else {
        if (handshake || (rootPid && message.pid !== rootPid) || (!rootPid && message.pid !== 0)
          || typeof message.forced !== 'boolean' || !(message.exitCode === null || Number.isInteger(message.exitCode) && message.exitCode >= 0 && message.exitCode <= 0xffffffff)) {
          rejectProtocol(); continue;
        }
        handshake = { pid: message.pid, exitCode: message.exitCode, activeProcesses: message.activeProcesses, forced: message.forced, timedOut: message.reason === 'timed_out' };
      }
    }
  };
  void (async () => {
    try {
      if (!absolute(executable) || !/\.exe$/i.test(executable) || !absolute(cwd) || !Array.isArray(args)
        || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000
        || ![cleanupTimeoutMs, startupTimeoutMs].every((ms) => Number.isInteger(ms) && ms >= 1 && ms <= 60000)) {
        await finish(null, 'invalid_session_options');
        return;
      }
      if (signal?.aborted) { await finish(null, 'session_aborted'); return; }
      const shell = pwshPath ?? await resolvePowerShell(env, { projectPath: cwd });
      if (!absolute(shell) || path.win32.basename(shell).toLowerCase() !== 'pwsh.exe') throw new Error();
      if (stopRequested || signal?.aborted) { await finish(null, 'session_aborted'); return; }
      directory = await mkdtemp(path.join(tmpdir(), 'windows-agent-job-'));
      settingsPath = path.join(directory, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ executable, arguments: args, cwd, timeoutMs, cleanupMs: cleanupTimeoutMs, token }), { flag: 'wx', mode: 0o600 });
      if (stopRequested || signal?.aborted) { await finish(null, 'session_aborted'); return; }
      helper = spawnImpl(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', HELPER, '-SettingsPath', settingsPath],
        { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      startupDeadline = performance.now() + startupTimeoutMs;
      helperPid = pid(helper.pid) ? helper.pid : null;
      helper.stdin?.on('error', () => {});
      helper.stdout?.on('data', receive);
      helper.stderr?.on('data', (chunk) => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > 64 * 1024) rejectProtocol(); });
      helper.on('error', () => { void finish(null, 'windows_job_helper_failed'); });
      helper.once('close', (code) => { void finish(code); });
      launchTimer = setTimeout(expireStartup, startupTimeoutMs);
      lifetimeTimer = setTimeout(() => { void stop({ graceMs: 250 }); }, startupTimeoutMs + timeoutMs + cleanupTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (stopRequested || signal?.aborted) requestStop();
    } catch { await finish(null, 'windows_job_start_failed'); }
  })();
  return session;
}
