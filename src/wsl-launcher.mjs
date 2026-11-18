import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { posix, win32 as path } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { argv, linuxPath, linuxTool, safe } from './validation/inputs.mjs';
import { verifyExecutable } from './windows.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const MAX_TASK_BYTES = 2 * 1024 * 1024;
const GO_ARCH = { x64: 'amd64', arm64: 'arm64' };

// Check each mount before following a link in it. A final realpath alone could
// hide an intermediate symlink controlled by a Windows or remote filesystem.
const LINUX_PROBE = [
  'set -eu',
  'native_mount() {',
  '  case "$(/usr/bin/findmnt -n -r -o FSTYPE -T "$1")" in',
  '    ext2|ext3|ext4|btrfs|xfs|f2fs|tmpfs) return 0 ;;',
  '    *) return 1 ;;',
  '  esac',
  '}',
  'native_path() (',
  '  case "$1" in /*) ;; *) return 1 ;; esac',
  '  rest=${1#/} current= hops=0 components=0',
  '  native_mount / || return 1',
  '  while [ -n "$rest" ]; do',
  '    components=$((components+1))',
  '    [ "$components" -le 128 ] || return 1',
  '    part=${rest%%/*}',
  '    if [ "$rest" = "$part" ]; then rest=; else rest=${rest#*/}; fi',
  '    case "$part" in ""|.) continue ;; ..) current=${current%/*}; continue ;; esac',
  '    next=$current/$part',
  '    if [ -L "$next" ]; then',
  '      hops=$((hops+1))',
  '      [ "$hops" -le 40 ] || return 1',
  '      link=$(/usr/bin/readlink -n -- "$next" && printf .) || return 1',
  '      link=${link%.}',
  '      case "$link" in ""|*[[:cntrl:]]*) return 1 ;; /*) current= ;; esac',
  '      rest=$link${rest:+/$rest}',
  '      continue',
  '    fi',
  '    native_mount "$next" || return 1',
  '    if [ -n "$rest" ]; then [ -d "$next" ] || return 1; fi',
  '    current=$next',
  '  done',
  '  printf "%s\\n" "${current:-/}"',
  ')',
  'cwd=$(native_path "$1") && [ "$cwd" = "$1" ] && cd -P "$cwd" || exit 1',
  'tool=$(native_path "$2") && [ -f "$2" ] && [ -x "$2" ] || exit 1',
  // These are the PATH lookups the validation CLI does before running the task.
  'for name in sh bash uname; do',
  '  candidate=$(command -v "$name") && checked=$(native_path "$candidate") || exit 1',
  '  [ -f "$checked" ] && [ -x "$checked" ] || exit 1',
  'done',
  'uid=$(/usr/bin/id -u) || exit 1',
  'printf "%s\\n" "$cwd" "${tool%/*}/" "$tool" "$uid"',
].join('\n');

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function localPath(value) {
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)
    && !/[\u0000-\u001f:]/.test(value.slice(2));
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..\\') && !path.isAbsolute(relative);
}

async function directoryPath(value, empty = false) {
  if (!localPath(value) || !(await lstat(value)).isDirectory()) throw new Error();
  const canonical = await realpath(value);
  if (!localPath(canonical)) throw new Error();
  if (empty) {
    const dir = await opendir(canonical);
    try { if (await dir.read()) throw new Error(); }
    finally { await dir.close(); }
  }
  return canonical;
}

async function filePath(value) {
  if (!localPath(value) || !(await lstat(value)).isFile()) throw new Error();
  const canonical = await realpath(value);
  if (!localPath(canonical)) throw new Error();
  return canonical;
}

async function childOf(directory, value) {
  if (!localPath(value) || await directoryPath(path.dirname(value)) !== directory) throw new Error();
  const child = path.join(directory, path.basename(value));
  if (path.dirname(child) !== directory) throw new Error();
  return child;
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pinFile(value, project) {
  const file = await filePath(value);
  if (file.toLowerCase() !== value.toLowerCase() || inside(project, file)) throw new Error();
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(file)) {
    size += bytes.length;
    hash.update(bytes);
  }
  return { path: file, size, hash: hash.digest('hex') };
}

async function findNative(name, paths, projectPath) {
  for (const directory of paths) {
    if (!localPath(directory)) continue;
    const candidate = { path: path.join(directory, `${name}.exe`), commandType: 'Application' };
    const { executable } = await verifyExecutable(name, candidate, { projectPath });
    if (executable) return executable;
  }
  throw failure('WSL_LAUNCHER_TOOL_REQUIRED', `WSL launcher provisioning requires an installed native ${name}.exe.`);
}

function isTask(task) {
  return task?.context === 'wsl' && task.trusted === true
    && linuxTool(task.tool) && posix.normalize(task.tool) === task.tool
    && argv(task.args) && task.args.every((arg) => !/[\r\n]/.test(arg));
}

async function registrationInputs({ directory, fixturePath, statePath, taskPath, leasePath, task, leaseValue, projectPath }) {
  try {
    const [root, project] = await Promise.all([directoryPath(directory), directoryPath(projectPath)]);
    if (inside(project, root) || inside(root, project)) throw new Error();
    const [fixture, state, snapshot, lease] = await Promise.all([
      childOf(root, fixturePath).then((value) => directoryPath(value, true)),
      childOf(root, statePath).then((value) => directoryPath(value, true)),
      childOf(root, taskPath).then(filePath),
      childOf(root, leasePath),
    ]);
    if ([fixture, state, snapshot].some((value) => path.dirname(value) !== root)
      || new Set([fixture, state, snapshot, lease].map((value) => value.toLowerCase())).size !== 4) throw new Error();
    const existingLease = await lstat(lease).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existingLease || (await lstat(snapshot)).size > MAX_TASK_BYTES) throw new Error();
    const bytes = await readFile(snapshot);
    if (!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), task)) throw new Error();
    const leaseBytes = Buffer.from(leaseValue, 'utf8');
    return {
      root, project, fixture, state, snapshot,
      lease: { path: lease, size: leaseBytes.length, hash: hashBytes(leaseBytes) },
      taskPin: { path: snapshot, size: bytes.length, hash: hashBytes(bytes) },
    };
  } catch {
    throw failure('WSL_LAUNCHER_INPUTS_INVALID', 'The protected WSL launcher inputs are missing, active, or inconsistent.');
  }
}

async function probeLinux(wsl, distro, linuxCwd, tool, cwd, env) {
  const args = ['--distribution', distro, '--cd', '/', '--exec', '/usr/bin/env',
    'LC_ALL=C', 'BASH_ENV=/dev/null', 'ENV=/dev/null', '/bin/sh', '-c', LINUX_PROBE, 'wsl-task-probe', linuxCwd, tool];
  try {
    const { stdout } = await run(wsl, args, { cwd, env, timeout: 15000, maxBuffer: 16384, windowsHide: true });
    const [reportedCwd, reportedParent, reportedTool, uid, end, ...extra] = stdout.split('\n');
    if (reportedCwd !== linuxCwd || !linuxTool(reportedTool) || end !== '' || extra.length
      || !/^\d{1,10}$/.test(uid)
      || reportedParent !== `${posix.dirname(reportedTool).replace(/\/$/, '')}/`) throw new Error();
    return { args, expected: stdout };
  } catch {
    throw failure('WSL_LAUNCHER_LINUX_UNVERIFIED', 'WSL could not verify the canonical working directory and executable on Linux-native filesystems.');
  }
}

async function buildLauncher(root, go, binding, env, filename = 'wsl-task.exe') {
  const scratch = await mkdtemp(path.join(root, 'build-'));
  try {
    const source = path.join(scratch, 'main.go');
    const config = path.join(scratch, 'bindings.go');
    const built = path.join(scratch, 'launcher.exe');
    const cache = path.join(scratch, 'cache');
    const temp = path.join(scratch, 'tmp');
    const template = await filePath(path.join(ROOT, 'scripts', 'wsl-task-launcher.go'));
    if (inside(binding.project, template)) throw new Error();
    await Promise.all([
      copyFile(template, source, constants.COPYFILE_EXCL),
      writeFile(config, `package main\n\nconst bindingJSON = ${JSON.stringify(JSON.stringify(binding))}\n`, { flag: 'wx' }),
      mkdir(cache),
      mkdir(temp),
    ]);
    await run(go, ['build', '-trimpath', '-buildvcs=false', '-o', built, source, config], {
      cwd: scratch, timeout: 180000, maxBuffer: 128 * 1024, windowsHide: true,
      env: {
        SystemRoot: env.SystemRoot, WINDIR: env.WINDIR, SystemDrive: env.SystemDrive,
        PATH: path.join(env.SystemRoot, 'System32'), PATHEXT: '.EXE',
        TEMP: temp, TMP: temp, APPDATA: scratch, LOCALAPPDATA: scratch, USERPROFILE: scratch,
        GOROOT: path.dirname(path.dirname(go)), GOOS: 'windows', GOARCH: GO_ARCH[process.arch],
        GOENV: 'off', GOWORK: 'off', GO111MODULE: 'off', GOTOOLCHAIN: 'local', CGO_ENABLED: '0',
        GOPROXY: 'off', GOSUMDB: 'off', GOCACHE: cache, GOPATH: path.join(scratch, 'gopath'),
      },
    });
    const executable = path.join(root, filename);
    await copyFile(built, executable, constants.COPYFILE_EXCL);
    return { executable };
  } catch {
    throw failure('WSL_LAUNCHER_BUILD_FAILED', 'The installed Go toolchain could not build and publish the WSL launcher.');
  } finally {
    // Only remove this private build directory, even if its path has changed.
    if (await directoryPath(scratch).catch(() => null) === scratch && path.dirname(scratch) === root) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function launcherHost() {
  if (process.platform !== 'win32' || !Object.hasOwn(GO_ARCH, process.arch)) {
    throw failure('WSL_LAUNCHER_WINDOWS_REQUIRED', 'WSL launcher provisioning requires Windows x64 or ARM64.');
  }
  const systemRoot = await directoryPath(process.env.SystemRoot).catch(() => null);
  if (!systemRoot) throw failure('WSL_LAUNCHER_TOOL_REQUIRED', 'The Windows system directory could not be verified.');
  const system = path.join(systemRoot, 'System32');
  const paths = String(process.env.PATH ?? '').split(';').map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'));
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: path.parse(systemRoot).root.slice(0, 2), PATHEXT: '.EXE' };
  return { system, paths, env };
}

export async function provisionWslProjectRunner({ directory, registryPath, projectPath }) {
  const { system, paths, env } = await launcherHost();
  const [root, registry, project] = await Promise.all([directoryPath(directory), directoryPath(registryPath), directoryPath(projectPath)]);
  if (path.dirname(root) !== registry || inside(project, registry) || inside(registry, project)) {
    throw failure('WSL_LAUNCHER_INPUTS_INVALID', 'The protected WSL runner directory and project could not be verified.');
  }
  const [go, pwsh] = await Promise.all([
    findNative('go', paths, project),
    findNative('pwsh', [system, ...paths], project),
  ]);
  try {
    const { stdout } = await run(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)'], {
      cwd: system, env: { ...env, PATH: system, POWERSHELL_TELEMETRY_OPTOUT: '1' },
      timeout: 10000, maxBuffer: 16384, windowsHide: true,
    });
    const local = await directoryPath(stdout.trim());
    const expected = path.join(local, 'WindowsAgentDevkit', 'approved-wsl', path.basename(registry));
    if (expected.toLowerCase() !== registry.toLowerCase() || /(?:^|\\)#!sandbox\./i.test(local)) throw new Error();
  } catch {
    // A redirected LOCALAPPDATA must not put the allowed executable in the sandbox's storage.
    throw failure('WSL_RUNNER_LOCAL_APP_DATA', 'The fixed WSL runner requires the Windows Local Application Data directory outside the sandbox.');
  }
  return buildLauncher(root, go, {
    project, dispatcher: { registry },
    environment: Object.entries({ ...env, PATH: system }).map(([name, value]) => `${name}=${value}`),
  }, env, 'wsl-run.exe');
}

export async function provisionWslLauncher(options) {
  const host = await launcherHost();
  const { distro, linuxCwd, task, version, leaseValue } = options;
  if (!safe(distro) || !safe(version) || !linuxPath(linuxCwd) || posix.normalize(linuxCwd) !== linuxCwd
    || !isTask(task) || typeof leaseValue !== 'string' || !leaseValue || Buffer.byteLength(leaseValue) > 16384) {
    throw failure('WSL_LAUNCHER_INPUTS_INVALID', 'WSL launcher provisioning requires a trusted WSL task and explicit execution scope.');
  }
  const { root, project, fixture, state, snapshot, lease, taskPin } = await registrationInputs(options);
  const { system, paths } = host;
  const [node, pwsh, wsl, go] = await Promise.all([
    findNative('node', [path.dirname(process.execPath)], project),
    findNative('pwsh', [system, ...paths], project),
    findNative('wsl', [system], project),
    findNative('go', paths, project),
  ]);
  const searchPaths = [...new Set([system, path.dirname(pwsh)])];
  if (searchPaths.some((value) => value.includes(';'))) {
    throw failure('WSL_LAUNCHER_TOOL_REQUIRED', 'A native runtime directory cannot be used in the fixed launcher environment.');
  }
  const env = {
    ...host.env, PATH: searchPaths.join(';'), TEMP: state, TMP: state,
    POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off',
    PSModuleAnalysisCachePath: 'NUL',
  };
  const cli = path.join(ROOT, 'dist', 'cli.mjs');
  const collectors = ['collect-host.ps1', 'collect-advanced.ps1'].map((file) => path.join(ROOT, 'scripts', file));
  const [probe, pins] = await Promise.all([
    probeLinux(wsl, distro, linuxCwd, task.tool, fixture, env),
    Promise.all([node, pwsh, wsl, cli, ...collectors].map((file) => pinFile(file, project))).catch(() => {
      throw failure('WSL_LAUNCHER_INSTALLATION_INVALID', 'The installed CLI bundle, PowerShell collectors, or native runtimes could not be pinned.');
    }),
  ]);
  return buildLauncher(root, go, {
    project, fixture, state, lease, files: [taskPin, ...pins], node, wsl, cli,
    distro, linuxCwd, version, probe,
    cliArgs: ['validate', '--project', fixture, '--execute', '--distro', distro, '--linux-cwd', linuxCwd,
      '--linux-tools', 'bash', '--task-file', snapshot, '--state-dir', state, '--format', 'json', '--timeout-ms', '15000'],
    environment: Object.entries(env).map(([name, value]) => `${name}=${value}`),
  }, env);
}
