import { spawn } from 'node:child_process';
import { isAbsolute, win32 } from 'node:path';
import { createWindowsJobSession } from './windows-job-session.mjs';

// A foreground, owned process session; Windows Process Compose has no --detached.
// Source checked 2026-11-17: process-compose v1.124.0/src/cmd/up.go.
export function startServiceSession(executable, args, {
  cwd, env = process.env, timeoutMs = 30000, maxOutputBytes = 1024 * 1024,
  spawnImpl = spawn, platform = process.platform, killImpl = process.kill,
  pwshPath, startupTimeoutMs, cleanupTimeoutMs, signal,
} = {}) {
  if (platform === 'win32' && spawnImpl === spawn) {
    return createWindowsJobSession(executable, args, { cwd, env, timeoutMs, pwshPath, startupTimeoutMs, cleanupTimeoutMs, signal });
  }
  let child, result, startedResult, timer, stopping, bytes = 0, rootPid = null, parentAlive = false;
  let treeState = 'not_started', proof = 'no_child_created';
  let resolveStarted, resolveFinished;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const start = (value) => { if (!startedResult) resolveStarted(startedResult = value); };
  const finish = (state, exitCode = null) => {
    if (result) return;
    parentAlive = false;
    result = { state, exitCode };
    start(result);
    resolveFinished(result);
    // Parent exit and descendant cleanup are independent facts.
    if (!stopping) {
      if (platform !== 'win32' && rootPid) void stop({ graceMs: Math.min(timeoutMs, 1000) });
      else {
        clearTimeout(timer);
        if (rootPid) { treeState = 'unknown'; proof = 'windows_parent_exited'; }
        releasePipes();
      }
    }
  };
  const releasePipes = () => {
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref?.();
  };
  const tree = () => ({ treeState, treeTerminated: ['clean', 'not_started'].includes(treeState), proof,
    rootPid, ...(platform === 'win32' ? {} : { processGroupId: rootPid }),
    ...(treeState === 'unknown' && rootPid ? { recovery: { parentPid: rootPid, ...(platform === 'win32' ? {} : { processGroupId: rootPid }), reason: proof } } : {}) });
  const wait = async (ms = 1000) => {
    if (result) return result;
    let timeout;
    try {
      return await Promise.race([finished, new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ state: 'timed_out', exitCode: null }), ms);
      })]);
    } finally { clearTimeout(timeout); }
  };
  const stop = ({ graceMs = 1000 } = {}) => {
    if (stopping) return stopping;
    stopping = (async () => {
      let forced = false;
      if (!rootPid) return { ...await wait(graceMs), ...tree(), forced };
      if (treeState === 'clean') return { ...await wait(graceMs), ...tree(), forced };
      treeState = 'unknown';
      if (platform === 'win32') {
        // taskkill cannot enumerate orphan descendants from a dead/reused parent PID.
        // Without a Job Object, retain recovery evidence rather than kill that PID.
        if (!parentAlive) proof = 'windows_parent_exited_without_tree_proof';
        else try {
          const root = env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows';
          const killer = spawnImpl(win32.join(root, 'System32', 'taskkill.exe'),
            ['/PID', String(rootPid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          forced = true;
          const killed = await new Promise((resolve) => {
            const killTimer = setTimeout(() => { try { killer.kill(); } catch {} resolve(false); }, graceMs);
            killer.once('error', () => { clearTimeout(killTimer); resolve(false); });
            killer.once('close', (code) => { clearTimeout(killTimer); resolve(code === 0); });
          });
          if (killed) { treeState = 'clean'; proof = 'live_parent_taskkill_tree_succeeded'; }
          else proof = 'taskkill_tree_unverified';
        } catch { proof = 'taskkill_tree_failed'; }
        if (parentAlive && treeState !== 'clean') {
          try { child.kill('SIGTERM'); forced = true; } catch {}
        }
      } else {
        const group = () => {
          try { killImpl(-rootPid, 0); return 'present'; }
          catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
        };
        const gone = async () => {
          const deadline = Date.now() + graceMs;
          do {
            if (group() === 'absent') return true;
            await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
          } while (Date.now() < deadline);
          return group() === 'absent';
        };
        let absent = group() === 'absent';
        if (!absent) {
          try { killImpl(-rootPid, 'SIGTERM'); forced = true; } catch {}
          absent = await gone();
        }
        if (!absent) {
          try { killImpl(-rootPid, 'SIGKILL'); forced = true; } catch {}
          absent = await gone();
        }
        treeState = absent ? 'clean' : 'unknown';
        proof = absent ? 'owned_process_group_absent' : 'owned_process_group_unverified';
      }
      const stopped = await wait(graceMs);
      clearTimeout(timer);
      releasePipes();
      return { ...stopped, ...tree(), forced };
    })();
    return stopping;
  };
  const session = { started, finished, wait, stop, tree, status: () => result ?? { state: 'running', pid: rootPid } };
  if (typeof executable !== 'string' || !(isAbsolute(executable) || win32.isAbsolute(executable))
    || /[\0\r\n]/.test(executable) || /\.(?:cmd|bat|ps1)$/i.test(executable)
    || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    finish('not_run');
    return session;
  }
  try {
    child = spawnImpl(executable, args, {
      cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rootPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    parentAlive = Boolean(rootPid);
    if (rootPid) { treeState = 'owned'; proof = platform === 'win32' ? 'live_child_handle' : 'created_process_group'; }
    child.once('spawn', () => start({ state: 'running', pid: rootPid }));
    child.on('error', () => { if (!rootPid) finish('failed'); else { start({ state: 'failed' }); void stop(); } });
    child.once('exit', (code) => finish(code === 0 ? 'succeeded' : 'failed', code));
    child.once('close', (code) => finish(code === 0 ? 'succeeded' : 'failed', code));
    const consume = (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) void stop();
    };
    child.stdout?.on('data', consume); child.stderr?.on('data', consume);
    timer = setTimeout(() => { void stop().then((value) => start(value)); }, timeoutMs);
  } catch { finish('failed'); }
  return session;
}
