import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createQuery, isReadOnlyQuery, queryEnvironment } from '../src/query.mjs';
import { runProjectTask } from '../src/task.mjs';
import { INVENTORY_NAMES, createWindowsInspector, parseVersionOutput, runBounded, selectCommandCandidate } from '../src/windows.mjs';

const PRIVATE = 'TASK_EXECUTION_PRIVATE_SENTINEL';
const WINDOWS = { skip: process.platform !== 'win32' && 'Windows PE 경로 검증 fixture' };
const nativeTask = (tool = 'task', extra = {}) => ({ context: 'native', trusted: true, tool, args: ['build'], ...extra });
const succeeded = (extra = {}) => ({ state: 'succeeded', exitCode: 0, stdout: PRIVATE, stderr: PRIVATE, ...extra });
const application = (name, file) => ({ name: `${name}.exe`, commandType: 'Application', path: file });

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const base = await realpath(await mkdtemp(path.join(parent, 'windows-agent-task-')));
  const identity = await lstat(base);
  t.after(async () => {
    assert.equal(path.dirname(base), parent);
    assert.ok(path.basename(base).startsWith('windows-agent-task-'));
    assert.equal(await realpath(base), base);
    const current = await lstat(base);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await rm(base, { recursive: true });
  });
  const projectPath = path.join(base, 'project');
  const directory = path.join(base, 'tools');
  const subdirectory = path.join(projectPath, 'packages', 'app');
  const outside = path.join(base, 'project-other');
  await mkdir(subdirectory, { recursive: true });
  await mkdir(directory);
  await mkdir(path.join(outside, 'child'), { recursive: true });
  const pe = Buffer.alloc(132);
  pe.write('MZ'); pe.writeUInt32LE(128, 60); pe.write('PE\0\0', 128, 'binary');
  const host = { commands: {} };
  for (const tool of ['task', 'just', 'make', 'mise']) {
    const file = path.join(directory, `${tool}.exe`);
    await writeFile(file, pe);
    host.commands[tool] = [application(tool, file)];
  }
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return succeeded(); };
  const environment = { PATH: directory, SystemRoot: 'C:\\Windows', NODE_OPTIONS: PRIVATE, MISE_AUTO_INSTALL: '1', mise_task_run_auto_install: '1' };
  return { base, projectPath, directory, subdirectory, outside, pe, host, calls, options: { projectPath, host, environment, run } };
}

test('새 작업 실행기의 읽기 전용 경로는 정확한 --version만 허용한다', () => {
  for (const tool of ['task', 'just', 'make', 'mise']) {
    assert.equal(isReadOnlyQuery(tool, ['--version']), true, tool);
    for (const args of [[], ['--version', 'build'], ['--version', '--list'], ['version'], ['--version\n'], ['run', 'build']]) {
      assert.equal(isReadOnlyQuery(tool, args), false, `${tool}: ${JSON.stringify(args)}`);
    }
  }
  for (const [tool, args] of [['task', ['--list']], ['task', ['--list-all']], ['just', ['--list']], ['just', ['--summary']], ['make', ['-n']], ['make', ['--dry-run']], ['make', ['-qp']], ['mise', ['tasks']], ['mise', ['tasks', '--json']]]) {
    assert.equal(isReadOnlyQuery(tool, args), false, tool);
  }
  assert.equal(isReadOnlyQuery('mise', ['ls', '--installed', '--json']), true);
  assert.equal(isReadOnlyQuery('mise', ['ls', '--installed', '--json', '--exec', PRIVATE]), false);
});

test('execute가 정확한 true가 아니면 task 검증과 query 호출을 시작하지 않는다', async () => {
  let calls = 0;
  const query = async () => { calls++; throw new Error(PRIVATE); };
  for (const execute of [undefined, false, null, 'true', 1, {}]) {
    const result = await runProjectTask({ task: nativeTask('mise', { cwd: PRIVATE, env: { NODE_OPTIONS: PRIVATE } }), execute, query });
    assert.equal(result.status, 'skipped');
    assert.equal(result.execution, 'not_run');
    assert.equal(result.reason, 'execute_required');
    assert.ok(!JSON.stringify(result).includes(PRIVATE));
  }
  assert.equal(calls, 0);
  assert.equal(await runProjectTask({ task: nativeTask('make', { context: 'wsl' }), execute: true, query }), null);
});

test('신뢰한 task·just·make·mise run은 인수 배열과 제한 시간을 그대로 전달한다', async (t) => {
  const f = await fixture(t);
  for (const tool of ['task', 'just', 'make', 'mise']) {
    const args = [...(tool === 'mise' ? ['run'] : []), 'build', '--', '', 'space argument', '한글', 'literal; $(unchanged)', PRIVATE];
    const task = nativeTask(tool, { args });
    let called = 0;
    const report = await runProjectTask({ projectPath: f.projectPath, task, execute: true, timeoutMs: 251, query: async (selected, argv, options) => {
      called++;
      assert.equal(selected, tool);
      assert.deepEqual(argv, args);
      assert.notEqual(argv, args);
      assert.equal(options.cwd, f.projectPath);
      assert.equal(options.timeoutMs, 251);
      assert.equal(options.execute, true);
      assert.equal(options.projectTask, true);
      if (tool === 'mise') assert.deepEqual(options.env, { MISE_AUTO_INSTALL: '0', MISE_TASK_RUN_AUTO_INSTALL: '0' });
      else assert.equal(options.env, undefined);
      return succeeded({ executable: path.join(f.directory, `${tool}.exe`) });
    } });
    assert.equal(called, 1);
    assert.equal(report.tool, tool);
    assert.equal(report.executable, path.join(f.directory, `${tool}.exe`));
    assert.equal(report.status, 'pass');
    assert.equal(report.execution, 'succeeded');
    assert.equal(report.exitCode, 0);
    assert.equal(report.cwd, f.projectPath);
    assert.equal(report.stdout, 'not_collected');
    assert.equal(report.stderr, 'not_collected');
    assert.ok(!JSON.stringify(report).includes(PRIVATE));
    assert.equal(report.arguments, undefined);
  }
});

test('신뢰·도구·argv 거부와 mise의 run 외 경로는 query까지 도달하지 않는다', async () => {
  const query = async () => assert.fail('거부한 task를 실행했습니다.');
  for (const task of [nativeTask('cmd'), nativeTask('bash'), nativeTask('task', { trusted: false }), nativeTask('task', { trusted: 'true' }), nativeTask('task', { args: 'build' }), nativeTask('task', { args: Array(129).fill('build') }), nativeTask('task', { args: ['a\0b'] }), nativeTask('task', { args: ['a\nb'] }), nativeTask('task', { args: [3] })]) {
    const report = await runProjectTask({ projectPath: 'C:/project', task, execute: true, query });
    assert.equal(report.status, 'fail');
    assert.equal(report.reason, 'trusted_task_required');
    assert.equal(report.execution, 'not_run');
  }
  for (const args of [[], ['tasks'], ['exec', '--', 'make'], ['install'], ['--cd', 'other', 'run', 'build']]) {
    const report = await runProjectTask({ task: nativeTask('mise', { args }), execute: true, query });
    assert.equal(report.status, 'fail');
    assert.equal(report.reason, 'mise_run_required');
  }
});

test('task env는 문자열 map만 전달하고 보고서에는 이름만 기록한다', async (t) => {
  const f = await fixture(t);
  const env = { APP_MODE: PRIVATE, PUBLIC_LABEL: '한글', EMPTY: '' };
  const original = { ...env };
  const report = await runProjectTask({ projectPath: f.projectPath, task: nativeTask('just', { env }), execute: true, query: async (_tool, _args, options) => {
    assert.deepEqual(options.env, env);
    assert.notEqual(options.env, env);
    return succeeded();
  } });
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.environmentKeys, ['APP_MODE', 'EMPTY', 'PUBLIC_LABEL']);
  assert.deepEqual(env, original);
  assert.equal(report.env, undefined);
  assert.ok(!JSON.stringify(report).includes(PRIVATE));
});

test('task env의 hook·설치 활성화·중복 이름·잘못된 map과 크기 초과는 거부한다', async () => {
  const query = async () => assert.fail('거부한 환경으로 실행했습니다.');
  const keys = ['NODE_OPTIONS', 'node_path', 'PYTHONSTARTUP', 'PYTHONPATH', 'DOTNET_STARTUP_HOOKS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_SSH_COMMAND', 'BASH_ENV', 'ENV', 'PSModulePath', 'RUSTC_WRAPPER', 'GOFLAGS', 'MAKEFLAGS', 'MAKEFILES', 'LD_PRELOAD', 'MISE_AUTO_INSTALL', 'mise_task_run_auto_install', 'RUSTUP_AUTO_INSTALL', 'COREPACK_ENABLE_NETWORK', 'GOTOOLCHAIN'];
  const invalid = [null, [], 'string', { APP: 1 }, { APP: null }, { APP: { value: PRIVATE } }, { 'BAD=NAME': PRIVATE }, { APP: 'a\0b' }, { APP: 'a\nb' }, { APP: 'x'.repeat(8193) }, { APP: 'a', app: 'b' }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`KEY_${i}`, 'value'])), Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`KEY_${i}`, 'x'.repeat(8192)])), ...keys.map((key) => ({ [key]: PRIVATE }))];
  for (const env of invalid) {
    const report = await runProjectTask({ projectPath: 'C:/project', task: nativeTask('task', { env }), execute: true, query });
    assert.equal(report.status, 'fail');
    assert.equal(report.reason, 'invalid_task_environment');
    assert.ok(!JSON.stringify(report).includes(PRIVATE));
  }
});

test('task cwd는 프로젝트 내부의 실제 일반 디렉터리만 전달한다', async (t) => {
  const f = await fixture(t);
  for (const cwd of ['packages/app', f.subdirectory, '.']) {
    const expected = cwd === '.' ? f.projectPath : f.subdirectory;
    const report = await runProjectTask({ projectPath: f.projectPath, task: nativeTask('task', { cwd }), execute: true, query: async (_tool, _args, options) => {
      assert.equal(options.cwd, expected);
      return succeeded();
    } });
    assert.equal(report.status, 'pass');
    assert.equal(report.cwd, expected);
  }
});

test('task cwd는 상위·다른 프로젝트·UNC·파일·누락 디렉터리를 거부한다', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.projectPath, 'file'), PRIVATE);
  const query = async () => assert.fail('거부한 cwd로 실행했습니다.');
  for (const cwd of [null, 1, '', '..', '../project-other', 'packages/../packages/app', f.outside, path.join(f.outside, 'child'), 'missing', 'file', '//server/share', '\\\\server\\share', '\\\\?\\C:\\project', 'C:relative', 'file://project', 'a\0b', 'a\nb']) {
    const report = await runProjectTask({ projectPath: f.projectPath, task: nativeTask('make', { cwd }), execute: true, query });
    assert.equal(report.status, 'fail', String(cwd));
    assert.equal(report.reason, 'invalid_task_cwd', String(cwd));
    assert.equal(report.cwd, undefined);
    assert.ok(!JSON.stringify(report).includes(PRIVATE));
  }
});

test('task cwd의 symlink·junction leaf와 중간 디렉터리의 realpath 탈출을 거부한다', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.projectPath, 'escape');
  await symlink(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const cwd of ['escape', path.join('escape', 'child')]) {
    const report = await runProjectTask({ projectPath: f.projectPath, task: nativeTask('just', { cwd }), execute: true, query: async () => assert.fail('프로젝트 밖 링크를 실행했습니다.') });
    assert.equal(report.reason, 'invalid_task_cwd');
    assert.equal(report.execution, 'not_run');
  }
});

test('task 결과는 종료 코드·timeout·미실행·정리 증거를 보존하고 원문을 제외한다', async () => {
  const cases = [
    [succeeded(), 'pass'],
    [succeeded({ exitCode: 7, state: 'failed' }), 'fail'],
    [succeeded({ state: 'timed_out', exitCode: null, treeTerminated: true, forced: true, proof: 'windows_job_empty' }), 'fail'],
    [succeeded({ forced: true, treeTerminated: true, proof: 'windows_job_empty' }), 'warn'],
    [succeeded({ state: 'failed', treeTerminated: false, proof: 'windows_job_helper_unresponsive' }), 'fail'],
    [succeeded({ treeTerminated: false, proof: 'windows_job_helper_unresponsive' }), 'fail'],
    [succeeded({ state: 'not_run', exitCode: null }), 'unknown'],
    [succeeded({ state: 'not_found', exitCode: null }), 'fail'],
    [undefined, 'fail'],
  ];
  for (const [response, status] of cases) {
    const report = await runProjectTask({ projectPath: 'C:/project', task: nativeTask(), execute: true, query: async () => response });
    assert.equal(report.status, status);
    assert.equal(report.exitCode, response?.exitCode ?? null);
    if (typeof response?.treeTerminated === 'boolean') assert.deepEqual(report.cleanup, { confirmed: response.treeTerminated, forced: response.forced === true, proof: response.proof });
    assert.ok(!JSON.stringify(report).includes(PRIVATE));
  }
  const thrown = await runProjectTask({ projectPath: 'C:/project', task: nativeTask(), execute: true, query: async () => { throw new Error(PRIVATE); } });
  assert.equal(thrown.status, 'fail');
  assert.equal(thrown.reason, 'task_query_failed');
  assert.ok(!JSON.stringify(thrown).includes(PRIVATE));
});

test('query는 새 runner의 정확한 실행 경로와 argv를 요구하며 원문을 버린다', WINDOWS, async (t) => {
  const f = await fixture(t);
  const query = createQuery(f.options);
  for (const tool of ['task', 'just', 'make', 'mise']) {
    const args = [...(tool === 'mise' ? ['run'] : []), 'build', '', 'literal; $(unchanged)', PRIVATE];
    for (const options of [{}, { execute: false }, { execute: 'true', projectTask: true }, { execute: true }, { execute: true, projectTask: 'true' }]) assert.equal((await query(tool, args, options)).state, 'not_run');
    const result = await query(tool, args, { execute: true, projectTask: true, cwd: f.subdirectory, timeoutMs: 432 });
    assert.equal(result.state, 'succeeded');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const call = f.calls.at(-1);
    assert.equal(call.file, path.join(f.directory, `${tool}.exe`));
    assert.deepEqual(call.args, args);
    assert.equal(call.options.cwd, f.subdirectory);
    assert.equal(call.options.timeoutMs, 432);
  }
  assert.equal(f.calls.length, 4);
  for (const args of [['tasks'], ['exec', '--', 'make'], ['--cd', f.subdirectory, 'run', 'build'], ['install']]) assert.equal((await query('mise', args, { execute: true, projectTask: true })).state, 'not_run');
  assert.equal(f.calls.length, 4);
});

test('호출 환경은 대소문자 우회에도 mise 자동 설치를 끄고 원본 map을 보존한다', WINDOWS, async (t) => {
  const f = await fixture(t);
  const environment = { ...f.options.environment, APP_MODE: 'original' };
  const original = { ...environment };
  const overrides = { mise_AUTO_INSTALL: '1', MISE_task_RUN_auto_INSTALL: '1', nOdE_oPtIoNs: PRIVATE, app_mode: 'override' };
  await createQuery({ ...f.options, environment })('mise', ['run', 'build'], { execute: true, projectTask: true, env: overrides });
  const env = f.calls[0].options.env;
  for (const key of ['MISE_AUTO_INSTALL', 'MISE_TASK_RUN_AUTO_INSTALL']) {
    assert.equal(env[key], '0');
    assert.deepEqual(Object.keys(env).filter((name) => name.toUpperCase() === key), [key]);
  }
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.nOdE_oPtIoNs, undefined);
  assert.equal(env.APP_MODE, undefined);
  assert.equal(env.app_mode, 'override');
  assert.deepEqual(environment, original);
  assert.deepEqual(overrides, { mise_AUTO_INSTALL: '1', MISE_task_RUN_auto_INSTALL: '1', nOdE_oPtIoNs: PRIVATE, app_mode: 'override' });
  const readonly = queryEnvironment({ mise_AUTO_INSTALL: '1', mise_task_run_auto_install: '1' });
  assert.equal(readonly.MISE_TASK_RUN_AUTO_INSTALL, '0');
});

test('runner의 wrapper·shim·잘못된 PE는 다른 후보가 있어도 검증을 우회하지 못한다', WINDOWS, async (t) => {
  const f = await fixture(t);
  for (const tool of ['task', 'just', 'make', 'mise']) {
    for (const extension of ['cmd', 'bat', 'ps1']) {
      const wrapper = path.join(f.directory, `${tool}.${extension}`);
      await writeFile(wrapper, PRIVATE);
      const host = { commands: { [tool]: [application(tool, wrapper), ...f.host.commands[tool]] } };
      const result = await createQuery({ ...f.options, host })(tool, tool === 'mise' ? ['run', 'build'] : ['build'], { execute: true, projectTask: true });
      assert.equal(result.state, 'not_run');
    }
  }
  await writeFile(path.join(f.directory, 'task.exe.shim'), 'unverified sidecar');
  assert.equal((await createQuery(f.options)('task', ['build'], { execute: true, projectTask: true })).state, 'not_run');
  await writeFile(path.join(f.directory, 'just.exe'), 'not a PE');
  assert.equal((await createQuery(f.options)('just', ['build'], { execute: true, projectTask: true })).state, 'not_run');
  assert.equal(f.calls.length, 0);
});

test('shim의 메타데이터 대상도 일반 PE 검증을 통과해야 실행한다', WINDOWS, async (t) => {
  const f = await fixture(t);
  const shims = path.join(f.base, 'shims');
  await mkdir(shims);
  const file = path.join(shims, 'task.exe');
  await writeFile(file, f.pe);
  const target = path.join(f.directory, 'task.exe');
  await writeFile(path.join(shims, 'task.shim'), `path = "${target}"\nargs = []\n`);
  const host = { commands: { task: [application('task', file)] } };
  const query = createQuery({ ...f.options, host });
  assert.equal((await query('task', ['build'], { execute: true, projectTask: true })).state, 'succeeded');
  assert.equal(f.calls[0].file, target);
  await writeFile(path.join(shims, 'task.shim'), `path = "${target}"\nargs = ["unexpected"]\n`);
  assert.equal((await query('task', ['build'], { execute: true, projectTask: true })).state, 'not_run');
  await writeFile(path.join(shims, 'task.shim'), `path = "${target}"\nargs = []\n`);
  await writeFile(target, 'not PE');
  assert.equal((await query('task', ['build'], { execute: true, projectTask: true })).state, 'not_run');
  assert.equal(f.calls.length, 1);
});

test('mise 활성화 function만 Application 후보를 선택하며 검증 실패는 실행하지 않는다', WINDOWS, async (t) => {
  const f = await fixture(t);
  const fn = { name: 'mise', commandType: 'Function', path: null };
  const app = f.host.commands.mise[0];
  assert.equal(selectCommandCandidate('mise', [fn, app]), app);
  assert.equal(selectCommandCandidate('task', [fn, app]), fn);
  f.host.commands.mise = [fn, app];
  const query = createQuery(f.options);
  assert.equal((await query('mise', ['--version'])).state, 'succeeded');
  assert.equal(f.calls[0].file, app.path);
  await writeFile(app.path, PRIVATE);
  assert.equal((await query('mise', ['run', 'build'], { execute: true, projectTask: true })).state, 'not_run');
  assert.equal(f.calls.length, 1);
});

test('make 실행 파일이 없으면 query는 not_found이고 명시한 task는 fail이다', async (t) => {
  const f = await fixture(t);
  const query = createQuery({ ...f.options, host: { commands: { make: [] } }, environment: { PATH: '' } });
  assert.equal((await query('make', ['--version'])).state, 'not_found');
  const report = await runProjectTask({ projectPath: f.projectPath, task: nativeTask('make'), execute: true, query });
  assert.equal(report.status, 'fail');
  assert.equal(report.execution, 'not_found');
  assert.equal(report.exitCode, null);
  assert.equal(f.calls.length, 0);
});

test('runner timeout은 제한을 전달하고 자기 자식만 중지하며 argv를 셸에 넘기지 않는다', WINDOWS, async (t) => {
  const f = await fixture(t);
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0, spawnOptions;
  child.kill = () => { kills++; return true; };
  child.unref = () => {};
  const query = createQuery({ ...f.options, run: (file, args, options) => runBounded(file, args, { ...options, spawnImpl: (selected, argv, input) => {
    assert.equal(selected, path.join(f.directory, 'task.exe'));
    assert.deepEqual(argv, ['build', 'literal; $(unchanged)']);
    spawnOptions = input;
    queueMicrotask(() => { child.stdout.write(PRIVATE); child.stderr.write(PRIVATE); });
    return child;
  } }) });
  const report = await runProjectTask({ projectPath: f.projectPath, task: nativeTask('task', { args: ['build', 'literal; $(unchanged)'] }), execute: true, timeoutMs: 10, query });
  assert.equal(report.execution, 'timed_out');
  assert.equal(report.status, 'fail');
  assert.equal(report.exitCode, null);
  assert.equal(kills, 1);
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.windowsHide, true);
  assert.ok(!JSON.stringify(report).includes(PRIVATE));
  child.emit('close', 0);
  assert.equal(kills, 1);
});

test('호스트 collector와 inspector는 task·just·make를 수집하고 버전 조회만 실행한다', async () => {
  for (const tool of ['task', 'just', 'make']) assert.ok(INVENTORY_NAMES.includes(tool));
  const collector = await readFile(new URL('../scripts/collect-host.ps1', import.meta.url), 'utf8');
  for (const tool of ['task', 'just', 'make']) assert.ok(collector.includes(`'${tool}'`));
  const projectPath = 'C:\\project';
  const shell = 'C:\\Shell\\pwsh.exe';
  const commands = Object.fromEntries(INVENTORY_NAMES.map((tool) => [tool, []]));
  for (const tool of ['task', 'just', 'make']) commands[tool] = [application(tool, `C:\\Tools\\${tool}.exe`)];
  const inventory = { context: { platform: 'win32', cwd: projectPath, os: { name: 'Windows 11', version: '10.0.26100', build: '26100', architecture: 'x64' }, processArchitecture: 'x64', diagnosticShell: { name: 'pwsh', path: shell, version: '7.6.0', profileApplied: false } }, commands };
  const outputs = { task: 'Task version: v3.54.0', just: 'just 1.52.0', make: 'GNU Make 4.4.1' };
  const calls = [];
  const inspect = createWindowsInspector({ platform: 'win32', environment: {}, resolveShell: async () => shell, verify: async (_tool, value) => ({ executable: value.path }), run: async (file, args, options) => {
    if (args.includes('-File')) return succeeded({ stdout: JSON.stringify(inventory) });
    calls.push({ file, args, options });
    const tool = path.win32.basename(file, '.exe');
    return succeeded({ stdout: `${outputs[tool]}\n${PRIVATE}` });
  } });
  const report = await inspect({ projectPath, tools: ['task', 'just', 'make'] });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.args, ['--version']);
    assert.equal(call.options.env.MISE_AUTO_INSTALL, '0');
    assert.equal(call.options.env.MISE_TASK_RUN_AUTO_INSTALL, '0');
  }
  assert.equal(report.probes.task.version, '3.54.0');
  assert.equal(parseVersionOutput('task', ['--version'], '3.54.0')?.version, '3.54.0');
  assert.equal(report.probes.just.version, '1.52.0');
  assert.equal(report.probes.make.version, '4.4.1');
  assert.ok(!JSON.stringify(report).includes(PRIVATE));
  assert.equal(parseVersionOutput('task', ['--version'], PRIVATE), null);
  commands.make = [];
  const absent = await inspect({ projectPath, tools: ['make'] });
  assert.equal(absent.probes.make.state, 'not_found');
});
