import { mkdtemp, rm, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildEnvironment, runBounded, verifyExecutable, decodeOutput } from './windows.mjs';
import { startServiceSession } from './service-session.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAFE_ROOT_VARIABLES = ['MISE_DATA_DIR', 'MISE_CONFIG_DIR', 'MISE_CACHE_DIR', 'RUSTUP_HOME', 'CARGO_HOME', 'DOTNET_ROOT', 'DOTNET_ROOT_X64', 'DOTNET_ROOT_X86', 'DOCKER_CONFIG', 'VSCODE_PORTABLE'];
const mutatingTools = new Set(['winget', 'mise', 'docker', 'process-compose', 'wsl', 'rustup', 'rustc', 'npm', 'dotnet', 'go', 'cargo', 'node', 'python', 'pwsh', 'uv', 'zig']);
const INJECTION = /^(NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|DOTNET_STARTUP_HOOKS|DOTNET_ADDITIONAL_DEPS|DOTNET_SHARED_STORE|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/i;

function envGet(environment, name) {
  return Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1];
}

export function queryEnvironment(environment, { execute = false } = {}) {
  const child = createChildEnvironment(environment);
  for (const name of SAFE_ROOT_VARIABLES) {
    const value = envGet(environment, name);
    if (typeof value === 'string' && isAbsolute(value) && !/[\r\n\0]/.test(value)) child[name] = value;
  }
  if (execute) {
    // Explicit project/service execution may need its ordinary environment.
    // Keep hooks/startup injection disabled while preserving project variables.
    Object.assign(child, environment);
    for (const name of Object.keys(child)) {
      if (INJECTION.test(name)) delete child[name];
    }
  }
  return Object.assign(child, { MISE_OFFLINE: execute ? 'false' : 'true', MISE_AUTO_INSTALL: '0', COREPACK_ENABLE_NETWORK: execute ? '1' : '0', COREPACK_ENABLE_AUTO_PIN: '0', PNPM_PACKAGE_MANAGER_STRICT: 'false', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false' });
}

function strippedArgs(tool, args) {
  let result = [...args];
  if (tool === 'git') {
    while (['-C', '-c'].includes(result[0])) result = result.slice(2);
  }
  if (tool === 'docker' && ['--context', '-c', '--host', '-H'].includes(result[0])) result = result.slice(2);
  return result;
}

export function isReadOnlyQuery(tool, args) {
  if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) return false;
  const words = strippedArgs(tool, args);
  if (['node', 'python', 'rustc', 'cargo', 'rg', 'gh', 'winget', 'code', 'codex'].includes(tool) && words.length === 1 && words[0] === '--version') return true;
  if (tool === 'zig') return words.length === 1 && words[0] === 'version';
  if (tool === 'git') return ['--version', 'rev-parse', 'ls-files', 'check-attr'].includes(words[0]) || (words[0] === 'config' && words.some((word) => ['--get', '--get-all', '--get-regexp', '--list'].includes(word)));
  if (tool === 'mise') return words[0] === '--version' || (words[0] === 'ls' && words.includes('--installed') && words.includes('--json')) || (words[0] === 'which' && words.length === 2 && ['node', 'python', 'go', 'rustc', 'cargo', 'zig', 'dotnet', 'uv', 'lazydocker', 'process-compose'].includes(words[1]));
  if (tool === 'dotnet') return words.length === 1 && ['--list-sdks', '--list-runtimes', '--version', '--info'].includes(words[0]);
  if (tool === 'docker') return words[0] === '--version' || ['show', 'inspect', 'ls'].includes(words[1]) && words[0] === 'context' || words[0] === 'compose' && words[1] === 'version';
  if (tool === 'docker-compose') return words[0] === 'version' && words.every((word) => ['version', '--short', '--format', 'json'].includes(word));
  if (tool === 'wsl') return [['--version'], ['--status'], ['--list', '--verbose'], ['--list', '--quiet']].some((allowed) => JSON.stringify(allowed) === JSON.stringify(words));
  if (tool === 'vswhere') return words.includes('-format') && words.includes('json');
  if (tool === 'fsutil') return words[0] === 'devdrv' && words[1] === 'query';
  if (tool === 'codex') return words[0] === 'plugin' && ['list', 'marketplace'].includes(words[1]) && !words.some((word) => ['add', 'remove', 'upgrade'].includes(word));
  if (tool === 'gh') return JSON.stringify(words) === JSON.stringify(['auth', 'status', '--active', '--hostname', 'github.com']);
  if (tool === 'pwsh' || tool === 'powershell') {
    if (words[0] !== '-NoProfile' || words[1] !== '-NonInteractive' || words[2] !== '-File') return false;
    if (words[3] === resolve(ROOT, 'scripts', 'collect-host.ps1')) return words.length === 4 || words.length === 6 && words[4] === '-ProjectPath' && isAbsolute(words[5]);
    return words.length === 6 && words[3] === resolve(ROOT, 'scripts', 'collect-advanced.ps1') && words[4] === '-TargetPath' && isAbsolute(words[5]);
  }
  return false;
}

function denied(reason, executable = null, args = []) {
  return { state: 'not_run', stdout: '', stderr: '', exitCode: null, executable, arguments: args, reason };
}

async function shimTarget(tool, candidate) {
  if (!candidate?.path || !/[\\/]shims[\\/]/i.test(candidate.path)) return candidate;
  try {
    const data = await readFile(candidate.path.replace(/\.(?:exe|cmd|ps1)$/i, '.shim'), 'utf8');
    if (data.length > 8192 || /^args\s*=\s*(?!\[\]\s*$).+/m.test(data)) return candidate;
    const match = /^path\s*=\s*"([^"\r\n]+)"\s*$/m.exec(data);
    if (match && isAbsolute(match[1]) && !/[%$]/.test(match[1])) return { ...candidate, path: match[1], commandType: 'Application', shimSource: candidate.path };
  } catch { /* Only verified sidecars may redirect a query. */ }
  return candidate;
}

export function createQuery({ projectPath, host, timeoutMs = 5000, environment = process.env, run = runBounded } = {}) {
  return async function query(tool, args, options = {}) {
    if (options.signal?.aborted) return denied('취소된 조회입니다.', null, args);
    const execute = options.execute === true;
    if ((!execute && !isReadOnlyQuery(tool, args)) || execute && !mutatingTools.has(tool)) return denied('허용한 조회 또는 명시적인 실행 작업이 아닙니다.', null, args);
    let candidate = options.executable ? { name: `${tool}.exe`, commandType: 'Application', path: options.executable } : host?.commands?.[tool]?.[0];
    if (!candidate && ['vswhere', 'fsutil'].includes(tool)) {
      const root = envGet(environment, tool === 'vswhere' ? 'PROGRAMFILES(X86)' : 'SYSTEMROOT');
      if (root && isAbsolute(root)) candidate = { name: `${tool}.exe`, commandType: 'Application', path: tool === 'vswhere' ? join(root, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe') : join(root, 'System32', 'fsutil.exe') };
    }
    if (!candidate) {
      const extension = process.platform === 'win32' ? '.exe' : '';
      for (const directory of String(envGet(environment, 'PATH') ?? '').split(process.platform === 'win32' ? ';' : ':')) {
        if (!isAbsolute(directory)) continue;
        try {
          const path = join(directory, `${tool}${extension}`);
          if ((await stat(path)).isFile()) { candidate = { name: `${tool}${extension}`, commandType: 'Application', path }; break; }
        } catch { /* Continue absolute PATH metadata discovery. */ }
      }
    }
    candidate = await shimTarget(tool, candidate);
    if (!candidate?.path) return { ...denied('현재 문맥에서 명령 후보를 찾지 못했습니다.', null, args), state: 'not_found' };
    if (execute && tool === 'npm' && /\.(?:cmd|ps1|exe)$/i.test(candidate.path)) {
      const directory = dirname(candidate.path);
      const cli = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      try {
        const metadata = JSON.parse(await readFile(join(directory, 'node_modules', 'npm', 'package.json'), 'utf8'));
        const info = await stat(cli);
        if (metadata.name === 'npm' && info.isFile() && info.size < 1024 * 1024) {
          return query('node', [cli, ...args], { ...options, executable: join(directory, 'node.exe') });
        }
      } catch { /* Unknown wrappers stay unexecuted. */ }
    }
    const appAlias = execute && tool === 'winget' && envGet(environment, 'LOCALAPPDATA') && resolve(candidate.path).toLowerCase() === resolve(envGet(environment, 'LOCALAPPDATA'), 'Microsoft', 'WindowsApps', 'winget.exe').toLowerCase();
    const assessment = appAlias ? { executable: candidate.path, reason: null } : await verifyExecutable(tool, candidate, { projectPath: execute && options.projectTask === true ? undefined : projectPath, commands: host?.commands });
    if (!assessment.executable) return denied(assessment.reason, candidate.path, args);
    candidate.path = assessment.executable;
    const cwd = options.cwd ?? projectPath;
    const env = { ...queryEnvironment(environment, { execute }), ...options.env };
    for (const name of Object.keys(env)) if (INJECTION.test(name)) delete env[name];
    if (!execute) Object.assign(env, { MISE_OFFLINE: '1', MISE_AUTO_INSTALL: '0', MISE_NO_HOOKS: '1', MISE_NO_ENV: '1', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0' });
    let temporary;
    if (tool === 'dotnet' && ['--version', '--info'].includes(args[0])) {
      temporary = await mkdtemp(join(tmpdir(), 'windows-agent-devkit-dotnet-'));
      env.DOTNET_CLI_HOME = temporary;
    }
    let actualArgs = args;
    if (tool === 'git') actualArgs = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', ...args];
    try {
      const response = execute && options.projectTask === true && process.platform === 'win32' && run === runBounded
        ? await startServiceSession(candidate.path, actualArgs, { cwd, env, signal: options.signal, timeoutMs: options.timeoutMs ?? timeoutMs, pwshPath: host?.context?.diagnosticShell?.path }).finished
        : await run(candidate.path, actualArgs, { cwd, env, signal: options.signal, timeoutMs: options.timeoutMs ?? timeoutMs, maxOutputBytes: options.maxOutputBytes ?? 256 * 1024 });
      return { ...response, stdout: decodeOutput(response.stdout), stderr: decodeOutput(response.stderr), executable: candidate.path, arguments: actualArgs, resolutionMethod: appAlias ? 'explicit_windows_app_execution_alias' : candidate.shimSource ? 'shim-target-metadata' : 'direct-executable' };
    } finally {
      if (temporary) {
        const absolute = await realpath(temporary);
        const parent = await realpath(tmpdir());
        const child = relative(parent, absolute);
        if (child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('windows-agent-devkit-dotnet-')) await rm(absolute, { recursive: true, force: true });
      }
    }
  };
}
