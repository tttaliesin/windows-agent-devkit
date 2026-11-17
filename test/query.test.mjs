import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createQuery, queryEnvironment, isReadOnlyQuery } from '../src/query.mjs';
import { runBounded } from '../src/windows.mjs';

const WINDOWS = process.platform === 'win32' || '실제 Windows 경로의 PE 검증을 사용하는 정적 fixture';
const SECRET = 'QUERY_PRIVATE_SENTINEL';
const success = () => ({ state: 'succeeded', exitCode: 0, stdout: Buffer.from('v24.18.1\n'), stderr: Buffer.alloc(0) });

async function fixture(t, { inside = false, tool = 'node', extension = 'exe' } = {}) {
  const parent = await realpath(tmpdir());
  const base = await realpath(await mkdtemp(path.join(parent, 'windows-agent-query-')));
  const identity = await lstat(base);
  t.after(async () => {
    assert.equal(path.dirname(base), parent);
    assert.ok(path.basename(base).startsWith('windows-agent-query-'));
    assert.equal(await realpath(base), base);
    const current = await lstat(base);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    await rm(base, { recursive: true });
  });
  const projectPath = path.join(base, 'project');
  const directory = path.join(inside ? projectPath : base, 'tools');
  await mkdir(projectPath); await mkdir(directory);
  const executable = path.join(directory, `${tool}.${extension}`);
  const pe = Buffer.alloc(132); pe.write('MZ'); pe.writeUInt32LE(128, 60); pe.write('PE\0\0', 128, 'binary');
  await writeFile(executable, extension === 'exe' ? pe : `@echo ${SECRET}\n`);
  const host = { commands: { [tool]: [{ name: `${tool}.${extension}`, path: executable, commandType: 'Application' }] } };
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return success(); };
  const environment = { PATH: directory, PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows', GH_TOKEN: SECRET, NODE_OPTIONS: `--require ${SECRET}` };
  const options = { projectPath, host, run, environment, timeoutMs: 1234 };
  return { base, projectPath, directory, executable, host, calls, options, pe };
}

test('읽기 전용 정책은 고정 조회를 허용하고 설치·서비스·프로젝트 코드 실행을 거부한다', () => {
  for (const [tool, args] of [['node', ['--version']], ['git', ['--version']], ['git', ['config', '--get-all', 'credential.helper']], ['mise', ['ls', '--installed', '--json']], ['mise', ['which', 'node']], ['dotnet', ['--list-sdks']], ['docker', ['context', 'show']], ['docker-compose', ['version', '--format', 'json']], ['wsl', ['--list', '--verbose']]]) assert.equal(isReadOnlyQuery(tool, args), true, `${tool} ${args}`);
  for (const [tool, args] of [['node', ['-e', SECRET]], ['python', ['-c', SECRET]], ['npm', ['--version']], ['npm', ['install']], ['go', ['version']], ['mise', ['install', 'node@24.18.1']], ['docker', ['compose', 'up']], ['docker', ['start', 'existing']], ['process-compose', ['up']], ['wsl', ['--exec', 'sh']], ['node', ['--version\n']], ['node', [null]]]) assert.equal(isReadOnlyQuery(tool, args), false, `${tool} ${args}`);
});

test('version이라는 프로젝트 파일을 실행하는 argv를 버전 조회로 허용하지 않는다', () => {
  for (const tool of ['node', 'python']) assert.equal(isReadOnlyQuery(tool, ['version']), false, `${tool} version은 프로젝트 스크립트를 실행할 수 있습니다.`);
});

test('고정 PowerShell 수집기 경로를 덧붙여도 -Command 실행은 읽기 전용으로 허용하지 않는다', () => {
  const collector = fileURLToPath(new URL('../scripts/collect-host.ps1', import.meta.url));
  assert.equal(isReadOnlyQuery('pwsh', ['-NoProfile', '-NonInteractive', '-File', collector]), true);
  assert.equal(isReadOnlyQuery('pwsh', ['-NoProfile', '-Command', `Write-Output ${SECRET}`, '-File', collector]), false);
});

test('기본 조회 환경은 비밀·proxy·hook을 제거하고 원본 환경은 보존한다', () => {
  const projectSettings = { GOFLAGS: '-mod=vendor', RUSTC_WRAPPER: 'C:/Tools/sccache.exe', MAKEFLAGS: '-j2', MAKEFILES: 'C:/project/build-settings.mk', PSModulePath: 'C:/project/modules' };
  const environment = { Path: 'C:\\Tools', pAtHeXt: '.EXE;.CMD', SystemRoot: 'C:\\Windows', GH_TOKEN: SECRET, AWS_SECRET_ACCESS_KEY: SECRET, HTTP_PROXY: `https://${SECRET}@example.test`, node_options: SECRET, PYTHONPATH: SECRET, DOTNET_STARTUP_HOOKS: SECRET, GIT_CONFIG_KEY_0: SECRET, MISE_DATA_DIR: 'C:\\Tools\\mise', RUSTUP_HOME: 'relative', GOTOOLCHAIN: 'auto', ...projectSettings };
  const original = { ...environment };
  const env = queryEnvironment(environment);
  assert.equal(env.PATH, environment.Path);
  assert.equal(env.PATHEXT, environment.pAtHeXt);
  assert.equal(env.GOTOOLCHAIN, 'local');
  assert.equal(env.GOTELEMETRY, 'off');
  assert.equal(env.MISE_AUTO_INSTALL, '0');
  assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(env.RUSTUP_HOME, undefined);
  if (process.platform === 'win32') assert.equal(env.MISE_DATA_DIR, environment.MISE_DATA_DIR);
  assert.ok(!JSON.stringify(env).includes(SECRET));
  assert.deepEqual(environment, original);
  const executed = queryEnvironment({ ...environment, APP_MODE: 'test' }, { execute: true });
  assert.equal(executed.APP_MODE, 'test');
  assert.equal(executed.GH_TOKEN, SECRET);
  for (const [key, value] of Object.entries(projectSettings)) {
    assert.equal(env[key], undefined, `read-only: ${key}`);
    assert.equal(executed[key], value, `project execution: ${key}`);
  }
  for (const key of ['node_options', 'PYTHONPATH', 'DOTNET_STARTUP_HOOKS', 'GIT_CONFIG_KEY_0']) assert.equal(executed[key], undefined, key);
});

test('query는 execute:true와 검증된 PE를 요구하고 제한·argv·환경을 runner에 전달한다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t);
  const query = createQuery(f.options);
  for (const execute of [undefined, false, 'true', 1]) assert.equal((await query('node', ['test.mjs'], { execute })).state, 'not_run');
  assert.deepEqual(f.calls, []);
  const signal = new AbortController().signal;
  const result = await query('node', ['test.mjs', 'literal; $(text)'], { execute: true, signal, timeoutMs: 321, maxOutputBytes: 4096, env: { APP_MODE: 'test', nOdE_OpTiOnS: SECRET, PythonPath: SECRET, DOTNET_STARTUP_HOOKS: SECRET, GIT_CONFIG_VALUE_0: SECRET } });
  assert.equal(result.state, 'succeeded');
  assert.equal(typeof result.stdout, 'string');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, f.executable);
  assert.deepEqual(f.calls[0].args, ['test.mjs', 'literal; $(text)']);
  assert.equal(f.calls[0].options.cwd, f.projectPath);
  assert.equal(f.calls[0].options.signal, signal);
  assert.equal(f.calls[0].options.timeoutMs, 321);
  assert.equal(f.calls[0].options.maxOutputBytes, 4096);
  assert.equal(f.calls[0].options.env.APP_MODE, 'test');
  for (const name of Object.keys(f.calls[0].options.env)) assert.ok(!/^(node_options|pythonpath|dotnet_startup_hooks|git_config_value_0)$/i.test(name), name);
});

test('기본 조회는 options.env의 hook·자동 설치 우회도 제거한다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t);
  await createQuery(f.options)('node', ['--version'], { env: { NODE_OPTIONS: SECRET, COREPACK_ENABLE_NETWORK: '1', MISE_AUTO_INSTALL: '1', MISE_NO_HOOKS: '0', MISE_NO_ENV: '0' } });
  const env = f.calls[0].options.env;
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(env.MISE_AUTO_INSTALL, '0');
  assert.equal(env.MISE_NO_HOOKS, '1');
  assert.equal(env.MISE_NO_ENV, '1');
  assert.ok(!JSON.stringify(env).includes(SECRET));
});

test('projectTask:true만으로는 프로젝트 실행 파일을 허용하지 않고 execute:true도 함께 필요하다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t, { inside: true });
  const query = createQuery(f.options);
  for (const options of [{}, { projectTask: true }, { execute: true }, { execute: true, projectTask: 'true' }]) assert.equal((await query('node', ['--version'], options)).state, 'not_run');
  assert.equal(f.calls.length, 0);
  assert.equal((await query('node', ['test.mjs'], { execute: true, projectTask: true })).state, 'succeeded');
  assert.equal(f.calls.length, 1);
  await writeFile(f.executable, 'not a PE');
  assert.equal((await query('node', ['test.mjs'], { execute: true, projectTask: true })).state, 'not_run');
  assert.equal(f.calls.length, 1);
});

test('npm 래퍼는 같은 설치의 npm 메타데이터를 확인한 후 node.exe와 npm-cli.js로 실행한다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t, { tool: 'npm', extension: 'cmd', inside: true });
  const npm = path.join(f.directory, 'node_modules', 'npm');
  await mkdir(path.join(npm, 'bin'), { recursive: true });
  const cli = path.join(npm, 'bin', 'npm-cli.js');
  await writeFile(cli, `throw new Error('${SECRET}');\n`);
  await writeFile(path.join(npm, 'package.json'), JSON.stringify({ name: 'npm', version: '11.6.0' }));
  await writeFile(path.join(f.directory, 'node.exe'), f.pe);
  const query = createQuery(f.options);
  for (const options of [{}, { execute: true }, { projectTask: true }]) assert.equal((await query('npm', ['run', 'test'], options)).state, 'not_run');
  assert.equal(f.calls.length, 0);
  const result = await query('npm', ['run', 'test', '--', 'literal; $(text)'], { execute: true, projectTask: true });
  assert.equal(result.state, 'succeeded');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, path.join(f.directory, 'node.exe'));
  assert.deepEqual(f.calls[0].args, [cli, 'run', 'test', '--', 'literal; $(text)']);
  await writeFile(path.join(npm, 'package.json'), JSON.stringify({ name: 'unrelated', version: '11.6.0' }));
  assert.equal((await query('npm', ['run', 'test'], { execute: true, projectTask: true })).state, 'not_run');
  assert.equal(f.calls.length, 1);
});

test('WinGet AppExecutionAlias 예외는 execute:true의 정확한 LOCALAPPDATA 경로에만 적용한다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t);
  const local = path.join(f.base, 'LocalAppData');
  const alias = path.join(local, 'Microsoft', 'WindowsApps', 'winget.exe');
  const host = { commands: { winget: [{ name: 'winget.exe', commandType: 'Application', path: alias }] } };
  const query = createQuery({ ...f.options, host, environment: { ...f.options.environment, LOCALAPPDATA: local } });
  // No alias body is created or inspected; the injected runner never invokes Windows.
  assert.equal((await query('winget', ['--version'])).state, 'not_run');
  assert.equal((await query('winget', ['--version'], { execute: false })).state, 'not_run');
  assert.equal((await query('winget', ['--version'], { execute: 'true' })).state, 'not_run');
  assert.equal(f.calls.length, 0);
  const args = ['install', '--id', 'Git.Git', '--exact', '--version', '2.52.0'];
  const result = await query('winget', args, { execute: true });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.resolutionMethod, 'explicit_windows_app_execution_alias');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, alias);
  assert.deepEqual(f.calls[0].args, args);
  for (const executable of [path.join(f.base, 'OtherLocalAppData', 'Microsoft', 'WindowsApps', 'winget.exe'), path.join(local, 'Microsoft', 'WindowsApps', 'winget.cmd'), path.join(local, 'Microsoft', 'WindowsApps', 'other.exe')]) {
    assert.equal((await query('winget', args, { execute: true, executable })).state, 'not_run', executable);
  }
  assert.equal((await query('node', ['--version'], { execute: true, executable: path.join(local, 'Microsoft', 'WindowsApps', 'node.exe') })).state, 'not_run');
  assert.equal(f.calls.length, 1);
});

test('WinGet 예외 추가 후에도 일반 조회의 PE 검증을 생략하지 않는다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.executable, 'plain text is not executable metadata');
  const result = await createQuery(f.options)('node', ['--version']);
  assert.equal(result.state, 'not_run');
  assert.equal(f.calls.length, 0);
});

test('직접 Compose 버전 조회도 명시 경로의 PE를 검증하고 docker 플러그인 탐색을 호출하지 않는다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t, { tool: 'docker-compose' });
  const query = createQuery(f.options);
  assert.equal((await query('docker-compose', ['version', '--format', 'json'], { executable: f.executable })).state, 'succeeded');
  assert.deepEqual(f.calls.map(({ file, args }) => ({ file, args })), [{ file: f.executable, args: ['version', '--format', 'json'] }]);
  await writeFile(f.executable, 'unverified plugin');
  assert.equal((await query('docker-compose', ['version', '--format', 'json'], { executable: f.executable })).state, 'not_run');
  assert.equal(f.calls.length, 1);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = 0; child.kill = () => { child.kills++; return true; }; child.unref = () => {};
  return child;
}

test('query timeout은 runBounded에 전달되고 자기 자식만 중지하며 원문을 제거한다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t);
  const child = fakeChild(), unrelated = fakeChild();
  let spawnOptions;
  const query = createQuery({ ...f.options, run: (file, args, options) => runBounded(file, args, { ...options, spawnImpl: (_file, _args, input) => {
    spawnOptions = input;
    queueMicrotask(() => { child.stdout.write(SECRET); child.stderr.write(SECRET); });
    return child;
  } }) });
  const result = await query('node', ['--version'], { timeoutMs: 10 });
  assert.equal(result.state, 'timed_out');
  assert.equal(child.kills, 1); assert.equal(unrelated.kills, 0);
  assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.windowsHide, true);
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  child.emit('close', 0); assert.equal(child.kills, 1);
});

test('미리 취소된 query는 runner를 호출하지 않고 실행 중 취소는 자기 자식만 중지한다', { skip: WINDOWS !== true && WINDOWS }, async (t) => {
  const f = await fixture(t);
  const preaborted = new AbortController(); preaborted.abort();
  assert.equal((await createQuery(f.options)('node', ['--version'], { signal: preaborted.signal })).state, 'not_run');
  assert.equal(f.calls.length, 0);
  const controller = new AbortController(), child = fakeChild();
  const query = createQuery({ ...f.options, run: (file, args, options) => {
    assert.equal(options.signal, controller.signal);
    return runBounded(file, args, { ...options, spawnImpl: () => { queueMicrotask(() => controller.abort()); return child; } });
  } });
  const result = await query('node', ['--version'], { signal: controller.signal });
  assert.equal(result.state, 'timed_out');
  assert.equal(child.kills, 1);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
});
