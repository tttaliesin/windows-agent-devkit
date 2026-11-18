import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isEnvironmentInjection } from './windows.mjs';

const TOOLS = new Set(['node', 'npm', 'python', 'uv', 'go', 'cargo', 'rustc', 'zig', 'dotnet', 'pwsh', 'task', 'just', 'make', 'mise']);
const INSTALL_ENVIRONMENT = /^(?:MISE_AUTO_INSTALL|MISE_TASK_RUN_AUTO_INSTALL|RUSTUP_AUTO_INSTALL|GOTOOLCHAIN|COREPACK_ENABLE_NETWORK|COREPACK_ENABLE_AUTO_PIN)$/i;

function taskEnvironment(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const entries = Object.entries(value);
  if (entries.length > 64) return null;
  const keys = new Set();
  let bytes = 0;
  for (const [name, content] of entries) {
    const key = name.toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || keys.has(key)
      || isEnvironmentInjection(name) || INSTALL_ENVIRONMENT.test(name)
      || typeof content !== 'string' || content.length > 8192 || /[\0\r\n]/.test(content)) return null;
    keys.add(key);
    bytes += Buffer.byteLength(`${name}=${content}\0`, 'utf16le');
    if (bytes > 32768) return null;
  }
  return Object.fromEntries(entries);
}

function inside(root, target) {
  const child = relative(root, target);
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function taskCwd(projectPath, value) {
  if (typeof value !== 'string' || !value || value.length > 32767 || /[\0\r\n]/.test(value)
    || /(^|[\\/])\.\.([\\/]|$)/.test(value) || /^[\\/]{2}/.test(value)
    || /^[A-Za-z]:(?![\\/])/.test(value) || value.includes('://')
    || typeof projectPath !== 'string' || !isAbsolute(projectPath) || /^[\\/]{2}/.test(projectPath)) return null;
  if (process.platform === 'win32' && /^[\\/]/.test(value)) return null;
  const root = resolve(projectPath);
  const candidate = resolve(root, value);
  if (!inside(root, candidate)) return null;
  try {
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const realRoot = await realpath(root);
    const realCandidate = await realpath(candidate);
    if (!inside(realRoot, realCandidate)) return null;
    return realCandidate;
  } catch { return null; }
}

export async function runProjectTask({ projectPath, task, execute = false, query, timeoutMs = 30000 }) {
  if (!task || task.context !== 'native') return null;
  const base = { context: 'windows-native', command: 'selected_project_task', execution: 'not_run', stdout: 'not_collected', stderr: 'not_collected' };
  if (execute !== true) return { ...base, status: 'skipped', reason: 'execute_required' };
  if (task.trusted !== true || !TOOLS.has(task.tool) || !Array.isArray(task.args) || task.args.length > 128 || task.args.some((i) => typeof i !== 'string' || /[\0\r\n]/.test(i))) return { ...base, status: 'fail', reason: 'trusted_task_required' };
  if (task.tool === 'mise' && task.args[0] !== 'run') return { ...base, tool: task.tool, status: 'fail', reason: 'mise_run_required' };
  const env = taskEnvironment(task.env);
  if (!env) return { ...base, tool: task.tool, status: 'fail', reason: 'invalid_task_environment' };
  const cwd = task.cwd === undefined ? projectPath : await taskCwd(projectPath, task.cwd);
  if (!cwd) return { ...base, tool: task.tool, status: 'fail', reason: 'invalid_task_cwd' };
  if (task.tool === 'mise') Object.assign(env, { MISE_AUTO_INSTALL: '0', MISE_TASK_RUN_AUTO_INSTALL: '0' });
  const summary = { ...base, tool: task.tool, cwd, environmentKeys: Object.keys(env).sort() };
  let result;
  try {
    result = await query(task.tool, [...task.args], { cwd, timeoutMs, execute: true, projectTask: true, ...(Object.keys(env).length ? { env } : {}) });
  } catch { return { ...summary, status: 'fail', reason: 'task_query_failed', exitCode: null }; }
  const state = ['succeeded', 'failed', 'not_run', 'not_found', 'timed_out'].includes(result?.state) ? result.state : 'failed';
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
  const cleanupFailed = state === 'succeeded' && exitCode === 0 && result?.treeTerminated === false;
  return { ...summary, status: cleanupFailed ? 'fail' : state === 'succeeded' && exitCode === 0 ? result.forced ? 'warn' : 'pass' : state === 'not_run' ? 'unknown' : 'fail', reason: cleanupFailed ? 'task_cleanup_unconfirmed' : state, execution: state, executable: result?.executable ?? null, exitCode,
    ...(typeof result?.treeTerminated === 'boolean' ? { cleanup: { confirmed: result.treeTerminated, forced: result.forced === true, proof: result.proof ?? null } } : {}) };
}
