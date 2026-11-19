import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { analyzeProject } from '../src/project.mjs';
import { VALIDATION_CHECK_IDS, validateEnvironment } from '../src/validation.mjs';
import { startServiceSession } from '../src/service-session.mjs';

const PROJECT = path.resolve('test validation project; $(literal)');
const LABEL = 'io.windows-agent-devkit.validation';
const CID = 'a'.repeat(64), IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const HELP = '--token-file --port --address --no-deps --tui --config --keep-project --no-watch';
const success = (stdout = '', extra = {}) => ({ state: 'succeeded', exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', executable: process.execPath, arguments: [], ...extra });
const failure = (state = 'failed', stderr = 'SECRET_MUST_NOT_LEAK') => ({ state, exitCode: state === 'failed' ? 1 : null, stdout: '', stderr, reason: stderr });
const check = (report, id) => report.checks.find((item) => item.checkId === id);
const stages = (report, id) => report.evidence[id].steps;
const has = (report, id, phase, status) => stages(report, id).some((item) => item.phase === phase && item.status === status);
const taskStep = (report, id) => stages(report, id).find((item) => item.phase === 'task');
const LINUX_CONTEXT = 'OS=Linux\nARCH=x86_64\nCWD=/src\nsh=/bin/sh';

async function fixture(action, { probe = true, extra = '' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'validation-test-'));
  const config = `version: "0.5"\nprocesses:\n  api:\n    command: node server.mjs\n${probe ? '    readiness_probe:\n      http_get:\n        host: 127.0.0.1\n        port: 34567\n' : ''}${extra}`;
  await writeFile(path.join(directory, 'process-compose.yaml'), config);
  try { return await action(directory, config); }
  finally {
    assert.ok(path.basename(directory).startsWith('validation-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeSession({ start = 'running', downCloses = true } = {}) {
  let state = start, forced = 0;
  return {
    started: Promise.resolve({ state, pid: 12345 }),
    status: () => ({ state }),
    down() { if (downCloses) state = 'succeeded'; },
    async wait() { return { state: state === 'running' ? 'timed_out' : state, exitCode: state === 'succeeded' ? 0 : null }; },
    async stop() {
      const running = state === 'running';
      if (running) { forced++; state = 'failed'; }
      return { state, exitCode: state === 'succeeded' ? 0 : null, treeTerminated: true, forced: running, proof: 'controlled_fixture_tree' };
    },
    get forced() { return forced; },
  };
}

function processQuery(session, ready = () => [{ name: 'api', status: 'Running', is_running: true, is_ready: 'Ready' }]) {
  const calls = [];
  const query = async (tool, args, options) => {
    calls.push({ tool, args, options });
    assert.equal(tool, 'process-compose');
    if (args.includes('--help')) return success(HELP);
    if (args[0] === 'process') return success(ready());
    if (args[0] === 'down') { session.down(); return success(); }
    assert.fail(`Unexpected command: ${args[0]}`);
  };
  return { calls, query };
}

function dockerQuery({ createFails = false, startFailure, ready = true, foreign = false, cleanupFails = false, volumes = false, imageArch = 'amd64', inspectFails = false, serverFails = false } = {}) {
  const calls = [];
  let owner, created = false, started = false, removed = false;
  const resource = () => ({ Id: CID, Config: { Labels: { [LABEL]: foreign ? 'someone-else' : owner } }, State: { Running: started && !ready, Status: started && ready ? 'exited' : started ? 'running' : 'created', ExitCode: 0 } });
  const query = async (tool, original, options) => {
    assert.equal(tool, 'docker');
    calls.push({ args: original, options });
    if (original[0] === 'context') return success({ Name: 'chosen', Endpoints: { docker: { Host: 'tcp://user:password@remote.example:2376?token=hidden' } } });
    assert.deepEqual(original.slice(0, 2), ['--context', 'chosen']);
    assert.equal(options.execute, true);
    const args = original.slice(2);
    if (args[0] === 'version') return serverFails ? failure('timed_out') : success({ Os: 'linux', Arch: 'amd64' });
    if (args[0] === 'image') return success([{ Id: IMAGE_ID, Os: 'linux', Architecture: imageArch, Config: { Volumes: volumes ? { '/data': {} } : {} } }]);
    if (args[0] === 'create') { owner = args[args.indexOf('--label') + 1].split('=')[1]; created = true; return createFails ? failure('timed_out') : success(CID); }
    if (args[0] === 'inspect') return inspectFails || !created || removed ? failure() : success([resource()]);
    if (args[0] === 'ps') return success(created && !removed && !foreign ? `${CID}\n` : '');
    if (args[0] === 'start') { started = true; return startFailure ? failure(startFailure) : success(CID); }
    if (args[0] === 'rm') { assert.equal(args.at(-1), CID); if (cleanupFails) return failure(); removed = true; return success(CID); }
    assert.fail(`Unexpected Docker command: ${args[0]}`);
  };
  return { query, calls };
}

test('실행 동의가 없으면 모든 지정 대상에 scoped skipped를 반환하고 query·세션을 호출하지 않는다', async () => {
  assert.deepEqual(VALIDATION_CHECK_IDS, ['RUST-02', 'WSL-02', 'CTR-02', 'PC-02']);
  for (const execute of [undefined, false, 'true', 1]) {
    let calls = 0;
    const report = await validateEnvironment({ projectPath: PROJECT, project: { requirements: { rust: { state: 'required' } } },
      options: { execute, rustTarget: 'x86_64-pc-windows-msvc', distro: 'Ubuntu', linuxCwd: '/home/user/source', dockerContext: 'chosen', serviceConfig: 'process-compose.yaml', services: ['api'], startSession: () => { calls++; } },
      query: async () => { calls++; assert.fail('No query without consent'); } });
    assert.equal(calls, 0);
    assert.deepEqual(report.checks.map((item) => item.checkId), VALIDATION_CHECK_IDS);
    assert.deepEqual(report.checks.map((item) => [item.status, item.reason, item.execution]), Array(4).fill(['skipped', 'execute_required', 'not_run']));
    assert.equal(report.evidence['WSL-02'].scope.cwd, '/home/user/source');
    assert.deepEqual(report.evidence['PC-02'].scope.services, ['api']);
  }
});

test('선택되지 않은 선택적 도구는 execute 동의가 있어도 조회하지 않는다', async () => {
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true }, query: () => assert.fail('unselected') });
  assert.ok(report.checks.every((item) => item.status === 'skipped' && item.reason === 'target_not_selected'));
});

test('Cargo 선언이 있어도 native 작업의 실행 요청은 Rust 링크 검증을 선택하지 않는다', async () => fixture(async (directory) => {
  await writeFile(path.join(directory, 'Cargo.toml'), '[package]\nname = "validation-fixture"\nversion = "0.1.0"\n');
  const project = await analyzeProject(directory);
  assert.equal(project.requirements.rust.state, 'required');
  const probes = [];
  const task = { context: 'native', trusted: true, tool: 'npm', args: ['test'] };
  const report = await validateEnvironment({ projectPath: directory, project, options: { execute: true, task }, query: async (tool, args) => {
    if (tool === 'rustc' && args[0] === '-vV') {
      probes.push('compiler');
      return success('host: x86_64-pc-windows-msvc');
    }
    probes.push(tool === 'rustc' && args.includes('--emit=link') ? 'link' : 'unexpected');
    return success();
  } });
  assert.deepEqual(probes, []);
  const { applicability, status, execution } = check(report, 'RUST-02');
  assert.deepEqual([applicability, status, execution], ['not_required', 'skipped', 'not_run']);
}));

test('누락된 명시적 경로·서비스와 잘못된 제한 시간은 기동 전에 보류한다', async () => {
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, distro: 'Ubuntu', serviceConfig: 'services.yaml' }, query: () => assert.fail('no implicit target') });
  assert.equal(check(report, 'WSL-02').reason, 'linux_cwd_required');
  assert.equal(check(report, 'PC-02').reason, 'service_selection_required');
  for (const timeoutMs of [0, -1, NaN, Infinity, 300001, '10']) {
    const invalid = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', timeoutMs }, query: () => assert.fail('invalid timeout') });
    assert.equal(check(invalid, 'CTR-02').reason, 'invalid_options');
  }
});

test('Rust MSVC·GNU target은 임시 소스의 실제 링크 산출물로 검사하고 프로젝트 파일은 보존한다', async () => {
  const calls = [], paths = [];
  const targets = ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu'];
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, rustTargets: targets }, query: async (tool, args, options) => {
    calls.push({ tool, args, options });
    assert.equal(tool, 'rustc'); assert.equal(options.env.RUSTUP_AUTO_INSTALL, '0');
    if (args[0] === '-vV') return success('rustc 1.92.0\nhost: x86_64-pc-windows-msvc\n');
    const source = args[args.indexOf('--emit=link') + 1];
    assert.match(await readFile(source, 'utf8'), /fn main/);
    const artifact = args[args.indexOf('-o') + 1];
    paths.push(path.dirname(artifact));
    await writeFile(artifact, 'controlled linked artifact');
    return success();
  } });
  assert.equal(check(report, 'RUST-02').status, 'pass');
  assert.equal(report.evidence['RUST-02'].host, targets[0]);
  assert.deepEqual(stages(report, 'RUST-02').map((item) => item.abi), ['msvc', 'gnu']);
  for (const directory of paths) await assert.rejects(readdir(directory), { code: 'ENOENT' });
  assert.equal(calls.length, 3); assert.ok(calls.every((item) => item.options.execute === true));
});

test('Rust의 target 부재·linker/SDK 부재·미지원 target을 구분하며 원시 오류를 노출하지 않는다', async () => {
  for (const [stderr, reason] of [["error[E0463]: can't find crate for `std` SECRET", 'target_not_installed'], ['linker `link.exe` not found SECRET', 'linker_sdk_unavailable']]) {
    const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, rustTarget: 'x86_64-pc-windows-msvc' }, query: async (tool, args) => args[0] === '-vV' ? success('host: x86_64-pc-windows-msvc') : failure('failed', stderr) });
    assert.equal(check(report, 'RUST-02').reason, reason);
    assert.doesNotMatch(JSON.stringify(report), /SECRET|stderr|fn main/);
  }
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, rustTarget: 'aarch64-unknown-linux-gnu' }, query: async () => success('host: x86_64-pc-windows-msvc') });
  assert.equal(check(report, 'RUST-02').status, 'unknown');
});

test('Rust가 성공해도 링크 파일이 없으면 완료로 보고하지 않는다', async () => {
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, rustTarget: 'x86_64-pc-windows-msvc' }, query: async (tool, args) => success(args[0] === '-vV' ? 'host: x86_64-pc-windows-msvc' : '') });
  assert.equal(check(report, 'RUST-02').status, 'unknown');
});

test('Rust 작업을 명시하면 프로젝트 target으로 링크를 검증한 뒤 선택한 작업을 실행한다', async () => {
  const target = 'aarch64-pc-windows-msvc';
  const project = { requirements: { rust: { state: 'required', metadata: { targets: [target] } } } };
  const task = { context: 'rust', tool: 'cargo', args: ['check'], trusted: true };
  const calls = [];
  const report = await validateEnvironment({ projectPath: PROJECT, project, options: { execute: true, task }, query: async (tool, args) => {
    if (tool === 'cargo') { calls.push('task'); return success(); }
    assert.equal(tool, 'rustc');
    if (args[0] === '-vV') { calls.push('compiler'); return success('host: x86_64-pc-windows-msvc'); }
    assert.equal(args[args.indexOf('--target') + 1], target);
    assert.ok(args.includes('--emit=link'));
    calls.push('link');
    await writeFile(args[args.indexOf('-o') + 1], 'controlled linked artifact');
    return success();
  } });
  assert.deepEqual(calls, ['compiler', 'link', 'task']);
  const { applicability, status, execution } = check(report, 'RUST-02');
  assert.deepEqual([applicability, status, execution], ['required', 'pass', 'succeeded']);
  assert.equal(taskStep(report, 'RUST-02').exitCode, 0);
});

test('일부 WSL 옵션 또는 WSL 작업만 지정해도 선택되며 배포판과 절대 경로가 없으면 미실행을 보고한다', async () => {
  let calls = 0;
  const task = { context: 'wsl', tool: '/bin/bash', args: ['check.sh'], trusted: true };
  for (const options of [{ distro: 'Ubuntu' }, { linuxCwd: '/src' }, { linuxTools: ['bash'] }, { task }, { distro: 'Ubuntu', linuxCwd: 'src', task }]) {
    const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, ...options }, query: async () => { calls++; return success(); } });
    const { applicability, status, reason, execution } = check(report, 'WSL-02');
    assert.deepEqual([applicability, status, reason, execution], ['required', 'skipped', 'linux_cwd_required', 'not_run']);
    if (options.task) assert.equal(taskStep(report, 'WSL-02').execution, 'not_run');
  }
  assert.equal(calls, 0);
});

test('Rust와 WSL의 선행 조회가 실패하거나 실행되지 않으면 작업 미실행 근거를 남긴다', async () => {
  const rust = { task: { context: 'rust', tool: 'cargo', args: ['check'], trusted: true } };
  const wsl = { distro: 'Ubuntu', linuxCwd: '/src', linuxTools: ['bash'], task: { context: 'wsl', tool: '/bin/bash', args: ['check.sh'], trusted: true } };
  for (const [id, options, phase, firstOutput] of [
    ['RUST-02', rust, 'link', 'host: x86_64-pc-windows-msvc'],
    ['WSL-02', wsl, 'tool', `${LINUX_CONTEXT}\nbash=/bin/bash`],
  ]) {
    for (const [state, expectedStatus] of [['failed', 'fail'], ['not_run', 'unknown']]) {
      let calls = 0;
      const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, ...options }, query: async () => ++calls === 1 ? success(firstOutput) : failure(state) });
      assert.equal(calls, 2);
      const { applicability, status, reason, execution } = check(report, id);
      assert.deepEqual([applicability, status, reason, execution], ['required', expectedStatus, state, 'not_run']);
      assert.ok(has(report, id, phase, expectedStatus));
      const task = taskStep(report, id);
      assert.deepEqual([task.status, task.reason, task.execution, task.exitCode], ['skipped', 'not_started', 'not_run', null]);
    }
  }
});

test('WSL은 지정 distro·Linux cwd·셸·도구 버전으로 검사하고 신뢰 작업만 argv로 실행한다', async () => {
  const cwd = '/home/test/source $(literal); dir', calls = [];
  const project = { requirements: { node: { state: 'required', versionRequests: [{ kind: 'range', value: '>=24 <25' }], metadata: {} } } };
  const task = { context: 'wsl', trusted: true, tool: '/usr/bin/node', args: ['test task.mjs', '$(literal)'] };
  const report = await validateEnvironment({ projectPath: PROJECT, project, options: { execute: true, distro: 'Ubuntu', linuxCwd: cwd, task }, query: async (tool, args, options) => {
    calls.push({ tool, args, options });
    assert.equal(tool, 'wsl'); assert.deepEqual(args.slice(0, 6), ['--distribution', 'Ubuntu', '--cd', cwd, '--exec', '/usr/bin/env']);
    assert.equal(options.execute, true);
    if (args.includes('-c')) return success(`OS=Linux\nARCH=x86_64\nCWD=${cwd}\nsh=/usr/bin/sh\nbash=/usr/bin/bash\nmise=/usr/local/bin/mise\nnode=/usr/bin/node\n`);
    if (args.includes('/usr/bin/bash')) return success('GNU bash, version 5.2.15');
    if (args.includes('/usr/local/bin/mise')) return success('mise 2026.11.0');
    if (args.includes('--version')) return success('v24.18.1');
    assert.deepEqual(args.slice(-3), ['/usr/bin/node', ...task.args]); return success('PRIVATE_TASK_OUTPUT');
  } });
  assert.equal(check(report, 'WSL-02').status, 'pass');
  assert.equal(check(report, 'WSL-02').execution, 'succeeded');
  assert.equal(taskStep(report, 'WSL-02').exitCode, 0);
  assert.equal(report.evidence['WSL-02'].context.cwd, cwd);
  assert.equal(calls.length, 5);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TASK_OUTPUT|literal\)"\]/);
});

test('WSL의 Windows 실행 파일·shim과 요구 버전 위반을 Linux 준비 완료로 보고하지 않는다', async () => {
  for (const location of ['/mnt/c/node.exe', '/home/test/.local/share/mise/shims/node', 'node']) {
    let calls = 0;
    const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, distro: 'Ubuntu', linuxCwd: '/src', linuxTools: ['node'] }, query: async () => { calls++; return success(`OS=Linux\nARCH=x86_64\nCWD=/src\nsh=/usr/bin/sh\nnode=${location}\n`); } });
    assert.equal(check(report, 'WSL-02').status, 'fail'); assert.equal(calls, 1);
  }
  const report = await validateEnvironment({ projectPath: PROJECT, project: { requirements: { node: { state: 'required', versionRequests: [{ kind: 'range', value: '>=24' }] } } }, options: { execute: true, distro: 'Ubuntu', linuxCwd: '/src', linuxTools: ['node'] }, query: async (tool, args) => success(args.includes('-c') ? 'OS=Linux\nARCH=x86_64\nCWD=/src\nsh=/usr/bin/sh\nnode=/usr/bin/node' : 'v22.1.0') });
  assert.equal(check(report, 'WSL-02').status, 'fail');
});

test('신뢰하지 않은 WSL 작업은 실행하지 않는다', async () => {
  let calls = 0;
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, distro: 'Ubuntu', linuxCwd: '/src', linuxTools: [], task: { context: 'wsl', tool: '/usr/bin/node', args: ['test.mjs'] } }, query: async () => { calls++; return success(LINUX_CONTEXT); } });
  assert.equal(calls, 1);
  const { applicability, status, reason, execution } = check(report, 'WSL-02');
  assert.deepEqual([applicability, status, reason, execution], ['required', 'unknown', 'trusted_task_required', 'not_run']);
  const task = taskStep(report, 'WSL-02');
  assert.deepEqual([task.status, task.execution, task.exitCode], ['skipped', 'not_run', null]);
});

test('WSL 선행 조회에 성공해도 작업의 미실행과 종료 코드가 있는 실패를 그대로 기록한다', async () => {
  const task = { context: 'wsl', tool: '/usr/bin/node', args: ['PRIVATE_TASK_ARG'], trusted: true };
  for (const [state, exitCode, expectedStatus, expectedExecution] of [
    ['not_run', null, 'unknown', 'not_run'], ['not_found', null, 'fail', 'not_run'], ['failed', 23, 'fail', 'failed'],
  ]) {
    let calls = 0;
    const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, distro: 'Ubuntu', linuxCwd: '/src', linuxTools: [], task },
      query: async () => ++calls === 1 ? success(LINUX_CONTEXT) : { ...failure(state), exitCode, arguments: task.args, stdout: 'PRIVATE_TASK_OUTPUT' } });
    assert.equal(calls, 2);
    const { applicability, status, reason, execution } = check(report, 'WSL-02');
    assert.deepEqual([applicability, status, reason, execution], ['required', expectedStatus, state, expectedExecution]);
    const phase = taskStep(report, 'WSL-02');
    assert.deepEqual([phase.status, phase.reason, phase.execution, phase.exitCode], [expectedStatus, state, expectedExecution, exitCode]);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TASK_|SECRET_MUST_NOT_LEAK/);
  }
});

test('Docker는 context endpoint와 서버 OS·아키텍처를 구분하고 endpoint의 비밀 값을 제거한다', async () => {
  const { query, calls } = dockerQuery();
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen' }, query });
  assert.equal(check(report, 'CTR-02').status, 'pass');
  assert.deepEqual(report.evidence['CTR-02'].server, { os: 'linux', arch: 'amd64' });
  assert.equal(report.evidence['CTR-02'].endpoint, 'tcp://remote.example:2376');
  assert.equal(report.evidence['CTR-02'].locality, 'remote');
  assert.equal(calls.length, 2); assert.doesNotMatch(JSON.stringify(report), /password|token=hidden|SECRET/);
});

test('Docker 설치 부재와 엔진 연결 실패·지원하지 않는 응답을 구분한다', async () => {
  const missing = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen' }, query: async () => failure('not_found') });
  assert.equal(check(missing, 'CTR-02').reason, 'not_found'); assert.equal(check(missing, 'CTR-02').resolution, 'not_resolved');
  const { query } = dockerQuery({ serverFails: true });
  const failed = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen' }, query });
  assert.equal(check(failed, 'CTR-02').reason, 'timed_out');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});

test('이미지 smoke는 로컬 이미지로만 생성·시작·준비·소유권 확인 후 삭제한다', async () => {
  const { query, calls } = dockerQuery();
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', image: 'alpine:existing', imageCommand: ['true'] }, query });
  assert.equal(check(report, 'CTR-02').status, 'pass');
  for (const phase of ['image.start', 'image.ready', 'image.stop']) assert.ok(has(report, 'CTR-02', phase, 'pass'));
  const create = calls.find((item) => item.args[2] === 'create').args;
  assert.ok(create.includes('--pull=never')); assert.ok(create.includes('none')); assert.equal(create.at(-1), 'true');
  assert.deepEqual(calls.find((item) => item.args[2] === 'rm').args.slice(2), ['rm', '--force', CID]);
  assert.ok(calls.every((item) => !item.args.some((arg) => ['pull', 'prune', 'rmi', 'volume'].includes(arg))));
});

test('이미지 생성·시작 실패와 준비 시간 초과에도 소유 자원을 정리한다', async () => {
  for (const [changes, stopStatus] of [
    [{ createFails: true }, 'unknown'],
    [{ startFailure: 'failed' }, 'pass'],
    [{ startFailure: 'timed_out' }, 'unknown'],
    [{ ready: false }, 'pass'],
  ]) {
    const { query, calls } = dockerQuery(changes);
    const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', image: 'existing:local', timeoutMs: 20 }, query });
    assert.equal(check(report, 'CTR-02').status, 'fail');
    assert.ok(calls.some((item) => item.args[2] === 'rm'));
    assert.ok(has(report, 'CTR-02', 'image.stop', stopStatus));
  }
});

test('이미지 소유권 불일치·정리 실패·플랫폼 차이·자동 볼륨은 사실대로 보고한다', async () => {
  for (const changes of [{ foreign: true }, { cleanupFails: true }, { volumes: true }, { imageArch: 'arm64' }]) {
    const { query, calls } = dockerQuery(changes);
    const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', image: 'existing:local', cleanupGraceMs: 30 }, query });
    assert.notEqual(check(report, 'CTR-02').status, 'pass');
    if (!changes.cleanupFails) assert.ok(!calls.some((item) => item.args[2] === 'rm'));
    if (changes.volumes || changes.imageArch) assert.ok(!calls.some((item) => item.args[2] === 'create'));
  }
});

const COMPOSE_NETWORK_ID = 'c'.repeat(64);

async function composeLifecycle({ timedOutRemoval, resourceRemains = false, networkDisappearsBeforeInspect = false } = {}) {
  const calls = [];
  const resources = new Set();
  let owner, snapshot, commands;
  const remove = (id) => {
    if (id !== timedOutRemoval || !resourceRemains) resources.delete(id);
    return id === timedOutRemoval ? failure('timed_out') : success();
  };
  const query = async (tool, args) => {
    assert.equal(tool, 'docker');
    if (args[0] === 'context') return success({ Name: 'chosen', Endpoints: { docker: { Host: 'npipe:////./pipe/docker_engine' } } });
    assert.deepEqual(args.slice(0, 2), ['--context', 'chosen']);
    const command = args.slice(2);
    if (command[0] === 'version') return success({ Os: 'linux', Arch: 'amd64' });
    if (command[0] === 'image' && command[1] === 'inspect') return success([{ Id: IMAGE_ID, Os: 'linux', Architecture: 'amd64', Config: {} }]);
    if (command[0] === 'ps' || (command[0] === 'network' && command[1] === 'ls')) {
      assert.ok(command.includes(`label=com.docker.compose.project=${owner}`));
      const id = command[0] === 'ps' ? CID : COMPOSE_NETWORK_ID;
      return success(resources.has(id) ? id : '');
    }
    if (command[0] === 'volume') return success();
    if (command[0] === 'network') {
      assert.equal(command.at(-1), COMPOSE_NETWORK_ID);
      if (command[1] === 'inspect') {
        if (networkDisappearsBeforeInspect) resources.delete(COMPOSE_NETWORK_ID);
        if (!resources.has(COMPOSE_NETWORK_ID)) return failure('failed', `network ${COMPOSE_NETWORK_ID} not found`);
        return success([{ Id: COMPOSE_NETWORK_ID, Name: `${owner}_default`, Labels: { 'com.docker.compose.project': owner } }]);
      }
      if (command[1] === 'rm') return remove(COMPOSE_NETWORK_ID);
    }
    if (command[0] === 'inspect') {
      assert.equal(command.at(-1), CID);
      return resources.has(CID) ? success([{ Id: CID, Config: { Labels: { [LABEL]: owner, 'com.docker.compose.project': owner } } }]) : failure();
    }
    if (command[0] === 'rm') { assert.deepEqual(command, ['rm', '--force', CID]); return remove(CID); }
    assert.equal(command[0], 'compose'); owner = command[command.indexOf('--project-name') + 1];
    assert.match(owner, /^devkit-[a-f0-9-]+$/);
    const file = command[command.indexOf('--file') + 1];
    const op = command[5];
    if (op === 'config') return success({ name: owner, services: { api: { image: 'existing:local', command: ['node', 'server.mjs'], healthcheck: { test: ['CMD', 'true'] } } }, networks: { default: { name: `${owner}_default` } } });
    snapshot = file; commands = JSON.parse(await readFile(snapshot, 'utf8')).services.api.command;
    if (op === 'up') {
      assert.deepEqual(command.slice(-1), ['api']);
      assert.ok(command.includes('--no-deps'));
      resources.add(CID);
      resources.add(COMPOSE_NETWORK_ID);
      return success();
    }
    if (op === 'ps') return success([{ Project: owner, Service: 'api', State: 'running', Health: 'healthy' }]);
    assert.fail(`Unexpected compose operation: ${op}`);
  };
  const report = await validateEnvironment({
    projectPath: PROJECT,
    options: { execute: true, dockerContext: 'chosen', composeFile: 'compose.yaml', composeServices: ['api'], cleanupGraceMs: 120 },
    query: async (tool, args) => {
      const result = await query(tool, args);
      calls.push({ command: args.slice(2), state: result.state, stdout: result.stdout });
      return result;
    },
  });
  return { report, calls, resources, snapshot, commands };
}

test('Compose는 고유 프로젝트와 설정 snapshot으로 선택 서비스만 기동하고 이미지를 보존한다', async () => {
  const { report, resources, snapshot, commands } = await composeLifecycle();
  assert.equal(check(report, 'CTR-02').status, 'pass');
  assert.deepEqual(commands, ['node', 'server.mjs']);
  assert.equal(resources.size, 0);
  for (const phase of ['compose.start', 'compose.ready', 'compose.stop']) assert.ok(has(report, 'CTR-02', phase, 'pass'));
  await assert.rejects(readFile(snapshot), { code: 'ENOENT' });
});

test('Compose 삭제 응답이 시간 초과여도 재조회에서 소유 자원 부재를 확인하면 종료에 성공한다', async (t) => {
  for (const [resource, id] of [['컨테이너', CID], ['네트워크', COMPOSE_NETWORK_ID]]) {
    await t.test(resource, async () => {
      const { report, calls } = await composeLifecycle({ timedOutRemoval: id });
      for (const phase of ['compose.start', 'compose.ready']) assert.ok(has(report, 'CTR-02', phase, 'pass'));
      const deletions = calls.filter(({ command }) => command.includes('rm'));
      assert.ok(deletions.some(({ command, state }) => command.at(-1) === id && state === 'timed_out'));
      const freshEmptyListings = calls.slice(calls.indexOf(deletions.at(-1)) + 1)
        .filter(({ state, stdout }) => state === 'succeeded' && stdout === '');
      assert.ok(freshEmptyListings.some(({ command }) => command[0] === 'ps'));
      assert.ok(freshEmptyListings.some(({ command }) => command[0] === 'network' && command[1] === 'ls'));

      const stop = stages(report, 'CTR-02').find(({ phase }) => phase === 'compose.stop');
      assert.equal(stop.absenceConfirmed, true);
      assert.equal(stop.status, 'pass');
      assert.equal(check(report, 'CTR-02').status, 'pass');
      assert.deepEqual([...stop.removedIds].sort(), [CID, COMPOSE_NETWORK_ID]);
      assert.deepEqual(report.evidence['CTR-02'].recovery ?? [], []);
    });
  }
});

test('Compose 삭제 응답이 시간 초과되고 소유 자원이 남으면 종료를 미확인으로 보고한다', async () => {
  const { report, calls } = await composeLifecycle({ timedOutRemoval: COMPOSE_NETWORK_ID, resourceRemains: true });
  for (const phase of ['compose.start', 'compose.ready']) assert.ok(has(report, 'CTR-02', phase, 'pass'));
  assert.ok(calls.some(({ command, state }) => command[0] === 'network' && command[1] === 'rm' && state === 'timed_out'));
  const evidence = report.evidence['CTR-02'];
  const stop = evidence.steps.find(({ phase }) => phase === 'compose.stop');
  assert.equal(stop.status, 'unknown');
  assert.equal(check(report, 'CTR-02').status, 'unknown');
  assert.equal(stop.absenceConfirmed, false);
  assert.deepEqual(stop.removedIds, [CID]);
  assert.deepEqual(evidence.recovery[0].remainingIds, [COMPOSE_NETWORK_ID]);
});

test('Compose 네트워크가 목록 조회와 상세 조회 사이에 사라지면 재조회로 종료를 확인한다', async () => {
  const { report, calls } = await composeLifecycle({ networkDisappearsBeforeInspect: true });
  const listed = calls.findIndex(({ command, state, stdout }) => command[0] === 'network' && command[1] === 'ls'
    && state === 'succeeded' && stdout === COMPOSE_NETWORK_ID);
  const inspected = calls.findIndex(({ command, state }) => command[0] === 'network' && command[1] === 'inspect'
    && command.at(-1) === COMPOSE_NETWORK_ID && state === 'failed');
  assert.ok(listed >= 0 && inspected > listed);
  assert.ok(calls.slice(inspected + 1).some(({ command, state, stdout }) => command[0] === 'network' && command[1] === 'ls'
    && state === 'succeeded' && stdout === ''));
  assert.ok(!calls.some(({ command }) => command[0] === 'network' && command[1] === 'rm'));

  const stop = stages(report, 'CTR-02').find(({ phase }) => phase === 'compose.stop');
  assert.equal(stop.absenceConfirmed, true);
  assert.equal(stop.status, 'pass');
  assert.deepEqual(stop.removedIds, [CID]);
  assert.equal(check(report, 'CTR-02').status, 'pass');
});

test('Compose 고정 이름과 기존 볼륨을 발견하면 기동·정리 명령을 실행하지 않는다', async () => {
  for (const changes of [{ container_name: 'existing-user-service' }, { volumes: [{ type: 'bind', source: '/user', target: '/data' }] }, { network_mode: 'host' }]) {
    const calls = [];
    const query = async (tool, args) => {
      calls.push(args);
      if (args[0] === 'context') return success({ Name: 'chosen', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } });
      if (args[2] === 'version') return success({ Os: 'linux', Arch: 'amd64' });
      return success({ services: { api: { image: 'existing:local', ...changes } } });
    };
    const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', composeFile: 'compose.yaml', services: ['api'] }, query });
    assert.equal(check(report, 'CTR-02').reason, 'compose_isolation_unsupported');
    assert.ok(!calls.some((args) => args.includes('up') || args.includes('down')));
  }
});

test('Process Compose 시작·준비·정상 종료를 구분하고 서비스 설정과 작업 경로를 보존한다', async () => fixture(async (directory, config) => {
  const session = fakeSession(), { query, calls } = processQuery(session);
  let launch, tokenFile;
  const report = await validateEnvironment({ projectPath: directory, options: { execute: true, serviceConfig: 'process-compose.yaml', services: ['api'], portFactory: () => 41234,
    startSession: (executable, args, options) => { launch = { executable, args, options }; tokenFile = args[args.indexOf('--token-file') + 1]; return session; } }, query });
  assert.equal(check(report, 'PC-02').status, 'pass');
  for (const phase of ['start', 'ready', 'stop']) assert.ok(has(report, 'PC-02', phase, 'pass'));
  assert.equal(session.forced, 0); assert.equal(launch.options.cwd, directory);
  assert.equal(launch.args.at(-1), 'api'); assert.ok(launch.args.includes('--no-deps'));
  assert.ok(launch.args.includes('--tui=false')); assert.ok(!launch.args.includes('--detached'));
  assert.ok(calls.filter((item) => !item.args.includes('--help')).every((item) => item.args.includes('--token-file') && item.args.includes('41234')));
  assert.equal(await readFile(path.join(directory, 'process-compose.yaml'), 'utf8'), config);
  assert.deepEqual(await readdir(directory), ['process-compose.yaml']);
  await assert.rejects(readFile(tokenFile), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(report), /server\.mjs|readiness_probe|token|server\.log/);
}));

test('Process Compose 시작 실패·준비 실패·시간 초과에 자식 세션만 정리한다', async () => fixture(async (directory) => {
  for (const scenario of ['failed', 'unready', 'query_error', 'down_error']) {
    const session = fakeSession({ start: scenario === 'failed' ? 'failed' : 'running', downCloses: scenario !== 'down_error' });
    const base = processQuery(session, () => [{ name: 'api', status: 'Running', is_running: true, is_ready: 'Not Ready' }]);
    const query = async (tool, args, options) => {
      if (scenario === 'query_error' && args[0] === 'process') throw new Error('PRIVATE_ERROR');
      if (scenario === 'down_error' && args[0] === 'down') return failure();
      return base.query(tool, args, options);
    };
    const report = await validateEnvironment({ projectPath: directory, options: { execute: true, timeoutMs: 20, serviceConfig: 'process-compose.yaml', services: ['api'], portFactory: () => 41234, startSession: () => session }, query });
    assert.equal(check(report, 'PC-02').status, 'fail');
    assert.ok(stages(report, 'PC-02').some((item) => item.phase === 'stop'));
    if (['query_error', 'down_error'].includes(scenario)) assert.equal(session.forced, 1);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ERROR|SECRET/);
  }
}));

test('Process Compose의 준비 검사 부재는 실행 중 상태와 구분한다', async () => fixture(async (directory) => {
  const session = fakeSession(), { query } = processQuery(session);
  const report = await validateEnvironment({ projectPath: directory, options: { execute: true, serviceConfig: 'process-compose.yaml', services: ['api'], startSession: () => session }, query });
  assert.equal(check(report, 'PC-02').reason, 'readiness_not_configured');
  assert.ok(has(report, 'PC-02', 'stop', 'pass'));
}, { probe: false }));

test('기존 사용자 서비스를 조작할 수 있는 daemon 설정과 없는 서비스를 기동하지 않는다', async () => fixture(async (directory) => {
  for (const services of [['api'], ['missing']]) {
    const report = await validateEnvironment({ projectPath: directory, options: { execute: true, serviceConfig: 'process-compose.yaml', services, startSession: () => assert.fail('no session') }, query: () => assert.fail('no query') });
    assert.notEqual(check(report, 'PC-02').status, 'pass');
  }
}, { extra: '    is_daemon: true\n' }));

test('알 수 없는 Process Compose 플래그와 도구 부재는 임의 대체 실행을 하지 않는다', async () => fixture(async (directory) => {
  for (const result of [success('--tui --port'), failure('not_found')]) {
    const report = await validateEnvironment({ projectPath: directory, options: { execute: true, serviceConfig: 'process-compose.yaml', services: ['api'], startSession: () => assert.fail('unsupported') }, query: async () => result });
    assert.equal(check(report, 'PC-02').status, result.state === 'not_found' ? 'fail' : 'unknown');
  }
}));

test('멈춘 조회를 제한 시간 내 보고하며 raw 오류와 인수를 반환하지 않는다', async () => {
  const start = Date.now();
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', timeoutMs: 20 }, query: async () => new Promise(() => {}) });
  assert.equal(check(report, 'CTR-02').reason, 'timed_out'); assert.ok(Date.now() - start < 2000);
});

test('세션 helper는 shell:false·windowsHide로 소유 자식만 만들고 통제된 실제 fixture를 종료한다', async () => {
  let invocation;
  const { spawn } = await import('node:child_process');
  const session = startServiceSession(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 3000, spawnImpl: (file, args, options) => { invocation = { file, args, options }; return spawn(file, args, options); } });
  assert.equal((await session.started).state, 'running');
  assert.equal(invocation.options.shell, false); assert.equal(invocation.options.windowsHide, true);
  assert.equal((await session.wait(10)).state, 'timed_out');
  assert.notEqual((await session.stop({ graceMs: 1000 })).state, 'timed_out');
  assert.notEqual(session.status().state, 'running');
});

test('세션 helper는 Windows에서 생성한 PID의 트리만 종료하고 실행 파일 오류를 처리한다', async () => {
  const calls = []; let child;
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const emitter = new EventEmitter(); emitter.stdout = new PassThrough(); emitter.stderr = new PassThrough(); emitter.pid = 12345;
    emitter.kill = () => queueMicrotask(() => emitter.emit('close', null));
    if (calls.length === 1) { child = emitter; queueMicrotask(() => emitter.emit('spawn')); }
    else queueMicrotask(() => { child.emit('close', null); emitter.emit('close', 0); });
    return emitter;
  };
  const session = startServiceSession('C:\\Tools\\process-compose.exe', ['up'], { platform: 'win32', timeoutMs: 5000, spawnImpl, env: { SystemRoot: 'C:\\Windows' } });
  await session.started; await session.stop();
  assert.deepEqual(calls[1].args, ['/PID', '12345', '/T', '/F']);
  assert.equal(calls[1].file, 'C:\\Windows\\System32\\taskkill.exe');
  assert.equal(calls[1].options.shell, false);
  const failed = startServiceSession(process.execPath, [], { spawnImpl: () => { throw new Error('private'); } });
  assert.equal((await failed.started).state, 'failed');
  const invalid = startServiceSession('wrapper.cmd', []);
  assert.equal((await invalid.started).state, 'not_run');
});

test('세션 helper는 출력 한도와 watchdog에서 소유 그룹만 종료하고 내용을 반환하지 않는다', async () => {
  for (const overflow of [true, false]) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
    const kills = []; let alive = true;
    const session = startServiceSession(process.execPath, ['-e', 'fixture'], { platform: 'linux', maxOutputBytes: 2, timeoutMs: 20,
      spawnImpl: () => { queueMicrotask(() => { child.emit('spawn'); if (overflow) child.stdout.write('PRIVATE_OUTPUT'); }); return child; },
      killImpl: (pid, signal) => {
        if (signal === 0) { if (!alive) throw Object.assign(new Error(), { code: 'ESRCH' }); return; }
        kills.push({ pid, signal }); alive = false; queueMicrotask(() => child.emit('close', null));
      } });
    await session.started;
    assert.equal((await session.finished).state, 'failed');
    assert.deepEqual(kills, [{ pid: -12345, signal: 'SIGTERM' }]);
    assert.doesNotMatch(JSON.stringify(await session.stop()), /PRIVATE_OUTPUT/);
  }
});

test('deadline은 query 취소 완료를 유예 시간 안에서 기다린 후 timed_out으로 보고한다', async () => {
  let cancelled = false, settled = false;
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', timeoutMs: 10, cancellationGraceMs: 100 },
    query: async (tool, args, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { cancelled = true; setTimeout(() => { settled = true; resolve(failure('timed_out')); }, 30); }, { once: true });
    }) });
  assert.equal(cancelled, true); assert.equal(settled, true);
  assert.equal(check(report, 'CTR-02').reason, 'timed_out');
  assert.equal(report.evidence['CTR-02'].pendingQueries, 0);
  assert.equal(report.evidence['CTR-02'].queries[0].cancellationSettled, true);
});

test('Docker create가 첫 cleanup 조회 뒤 완료되어도 grace 안에서 라벨로 발견해 정리한다', async () => {
  const base = dockerQuery(); let completion;
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', image: 'existing:local', timeoutMs: 10, cancellationGraceMs: 10, cleanupGraceMs: 160 },
    query: async (tool, args, options) => {
      if (args[2] !== 'create') return base.query(tool, args, options);
      return new Promise((resolve) => { completion = setTimeout(async () => resolve(await base.query(tool, args, options)), 65); });
    } });
  clearTimeout(completion);
  const evidence = report.evidence['CTR-02'];
  assert.equal(check(report, 'CTR-02').status, 'fail');
  assert.ok(base.calls.some((item) => item.args[2] === 'rm'));
  assert.ok(has(report, 'CTR-02', 'image.stop', 'unknown'));
  assert.equal(evidence.recovery[0].dockerContext, 'chosen');
  assert.equal(evidence.recovery[0].pendingClient, false);
  assert.equal(evidence.recovery[0].remoteCompletionUncertain, true);
  assert.deepEqual(evidence.recovery[0].removedIds, [CID]);
  assert.ok(evidence.recovery[0].labels[LABEL]);
});

test('무응답 create와 grace 이후 생성에는 성공 대신 안정적인 복구 라벨·context를 반환한다', async () => {
  const base = dockerQuery(); let finishCreate, request;
  const started = Date.now();
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', image: 'existing:local', timeoutMs: 10, cancellationGraceMs: 10, cleanupGraceMs: 30 },
    query: async (tool, args, options) => {
      if (args[2] !== 'create') return base.query(tool, args, options);
      request = { tool, args, options }; return new Promise((resolve) => { finishCreate = resolve; });
    } });
  assert.ok(Date.now() - started < 2000);
  const recovery = report.evidence['CTR-02'].recovery[0];
  assert.equal(recovery.pendingClient, true); assert.equal(recovery.absenceConfirmed, true);
  assert.equal(recovery.dockerContext, 'chosen'); assert.match(recovery.name, /^devkit-/);
  assert.equal(report.evidence['CTR-02'].pendingQueries, 1);
  assert.ok(!has(report, 'CTR-02', 'image.stop', 'pass'));
  const before = JSON.stringify(report);
  finishCreate(await base.query(request.tool, request.args, request.options));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(report), before);
  assert.equal(request.args[request.args.indexOf('--label') + 1], `${LABEL}=${recovery.labels[LABEL]}`);
});

test('Compose up 취소 후 늦게 생긴 컨테이너·네트워크도 소유 라벨로만 정리하고 복구 근거를 남긴다', async () => {
  const networkId = 'd'.repeat(64); let owner, created = false, network = false, delayed;
  const removed = [];
  const query = async (tool, original) => {
    if (original[0] === 'context') return success({ Name: 'chosen', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } });
    const args = original.slice(2);
    if (args[0] === 'version') return success({ Os: 'linux', Arch: 'amd64' });
    if (args[0] === 'image') return success([{ Id: IMAGE_ID, Os: 'linux', Architecture: 'amd64', Config: {} }]);
    if (args[0] === 'compose') {
      owner = args[args.indexOf('--project-name') + 1];
      if (args.includes('config')) return success({ services: { api: { image: 'existing:local' } } });
      if (args.includes('up')) { delayed = setTimeout(() => { created = true; network = true; }, 40); return failure('timed_out'); }
      assert.fail('No unscoped Compose cleanup');
    }
    if (args[0] === 'ps') return success(created ? CID : '');
    if (args[0] === 'volume') return success();
    if (args[0] === 'inspect') return success([{ Id: CID, Config: { Labels: { [LABEL]: owner, 'com.docker.compose.project': owner } } }]);
    if (args[0] === 'rm') { removed.push(CID); created = false; return success(); }
    if (args[0] === 'network' && args[1] === 'ls') return success(network ? networkId : '');
    if (args[0] === 'network' && args[1] === 'inspect') return success([{ Id: networkId, Name: `${owner}_default`, Labels: { 'com.docker.compose.project': owner } }]);
    if (args[0] === 'network' && args[1] === 'rm') { removed.push(networkId); network = false; return success(); }
    assert.fail('Unexpected command');
  };
  const report = await validateEnvironment({ projectPath: PROJECT, options: { execute: true, dockerContext: 'chosen', composeFile: 'compose.yaml', services: ['api'], timeoutMs: 10, cancellationGraceMs: 10, cleanupGraceMs: 120 }, query });
  clearTimeout(delayed);
  assert.deepEqual(removed, [CID, networkId]); assert.equal(created, false); assert.equal(network, false);
  assert.ok(has(report, 'CTR-02', 'compose.stop', 'unknown'));
  assert.equal(report.evidence['CTR-02'].recovery[0].projectName, owner);
});

test('Windows 부모가 먼저 닫히면 죽은 PID에 taskkill하지 않고 별도 트리 미확인과 복구 PID를 남긴다', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
  let calls = 0;
  const session = startServiceSession('C:\\Tools\\process-compose.exe', ['up'], { platform: 'win32', timeoutMs: 1000,
    spawnImpl: () => { calls++; queueMicrotask(() => child.emit('spawn')); return child; } });
  await session.started; child.emit('exit', 0);
  assert.equal((await session.finished).state, 'succeeded');
  const stopped = await session.stop({ graceMs: 10 });
  assert.equal(calls, 1); assert.equal(stopped.treeTerminated, false);
  assert.equal(stopped.treeState, 'unknown'); assert.equal(stopped.recovery.parentPid, 12345);
});

test('POSIX 부모가 먼저 닫혀도 소유 그룹에 남은 하위 프로세스를 검사·종료한다', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
  let groupAlive = true; const signals = [];
  const session = startServiceSession(process.execPath, [], { platform: 'linux', timeoutMs: 20,
    spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    killImpl: (pid, signal) => {
      assert.equal(pid, -12345);
      if (signal === 0) { if (!groupAlive) throw Object.assign(new Error(), { code: 'ESRCH' }); return; }
      signals.push(signal); groupAlive = false;
    } });
  await session.started; child.emit('exit', 0);
  const stopped = await session.stop({ graceMs: 10 });
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(stopped.treeTerminated, true);
  assert.equal(stopped.proof, 'owned_process_group_absent');
});

test('부모 종료만으로 그룹 종료를 확정하지 않고 남은 그룹에는 SIGKILL까지 적용한다', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
  let groupAlive = true; const signals = [];
  const session = startServiceSession(process.execPath, [], { platform: 'linux', timeoutMs: 1000,
    spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    killImpl: (pid, signal) => {
      if (signal === 0) { if (!groupAlive) throw Object.assign(new Error(), { code: 'ESRCH' }); return; }
      signals.push(signal);
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0));
      if (signal === 'SIGKILL') groupAlive = false;
    } });
  await session.started;
  const stopped = await session.stop({ graceMs: 10 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(stopped.treeTerminated, true);
});

test('PC의 root 종료 성공이 트리 정리 성공을 대신하지 않으며 recovery PID를 보고한다', async () => fixture(async (directory) => {
  const session = fakeSession(); const base = processQuery(session);
  session.stop = async () => ({ state: 'succeeded', exitCode: 0, forced: false, treeTerminated: false, rootPid: 12345, proof: 'windows_parent_exited_without_tree_proof' });
  const report = await validateEnvironment({ projectPath: directory, options: { execute: true, serviceConfig: 'process-compose.yaml', services: ['api'], startSession: () => session }, query: base.query });
  assert.equal(check(report, 'PC-02').status, 'unknown');
  assert.ok(has(report, 'PC-02', 'start', 'pass')); assert.ok(has(report, 'PC-02', 'ready', 'pass')); assert.ok(has(report, 'PC-02', 'stop', 'unknown'));
  assert.equal(report.evidence['PC-02'].recovery[0].parentPid, 12345);
  assert.equal(report.evidence['PC-02'].recovery[0].automaticPidKillAllowed, false);
}));
