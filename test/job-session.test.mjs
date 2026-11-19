import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWindowsJobSession } from '../src/windows-job-session.mjs';
import { startServiceSession } from '../src/service-session.mjs';
import { resolvePowerShell } from '../src/windows.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const native = { skip: process.platform !== 'win32', timeout: 45000 };
const APP = 'C:\\Trusted\\process-compose.exe', SHELL = 'C:\\Trusted\\pwsh.exe';

function fakeJob({
  forged, missing = false, active = 0, startedActive = 1, forced = false, exitCode = 0, reason = 'natural_exit',
  helperExitCode = 0, startupTimeoutMs = 1000, waitForStop, unsolicited = false,
} = {}) {
  let launch, settingsPath, settings, control = '';
  const session = createWindowsJobSession(APP, ['up', 'arg with spaces', 'SECRET_ARGUMENT'], {
    cwd: path.resolve('.'), env: { PRIVATE_MARKER: 'SECRET_ENV_VALUE' }, pwshPath: SHELL, startupTimeoutMs,
    spawnImpl: (file, args, options) => {
      launch = { file, args, options }; settingsPath = args[args.indexOf('-SettingsPath') + 1];
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const child = new EventEmitter(); child.pid = 4444;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      let closed = false;
      const emit = (event, pid, value) => {
        const token = forged === event ? '0'.repeat(64) : settings.token;
        child.stdout.write(`${JSON.stringify({ protocol: 2, token, event, pid, ...value })}\n`);
      };
      const ready = () => emit('ready', 0, { activeProcesses: 0 });
      const finish = (pid) => {
        closed = true;
        if (pid) emit('started', pid, { activeProcesses: startedActive });
        if (!missing) emit('finished', pid, pid
          ? { activeProcesses: active, forced, exitCode, reason }
          : { activeProcesses: active, forced: false, exitCode: null, reason: 'start_cancelled' });
        child.emit('close', helperExitCode);
      };
      child.stdin.on('data', (data) => {
        const command = data.toString();
        control += command;
        queueMicrotask(() => {
          if (closed) return;
          if (command === 'stop\n') {
            if (waitForStop === 'ready') ready();
            finish(control.startsWith('start\n') ? 5555 : 0);
          } else if (command === 'start\n' && waitForStop !== 'started') {
            finish(5555);
          }
        });
      });
      child.kill = () => { queueMicrotask(() => child.emit('close', null)); };
      queueMicrotask(() => {
        if (unsolicited) finish(5555);
        else if (waitForStop !== 'ready') ready();
      });
      return child;
    },
  });
  return { session, get launch() { return launch; }, get settingsPath() { return settingsPath; }, get settings() { return settings; }, get control() { return control; } };
}

async function fixture(action) {
  const directory = await mkdtemp(path.join(tmpdir(), 'job-session-test-'));
  try {
    const pwshPath = await resolvePowerShell(process.env, { projectPath: directory });
    return await action(directory, { cwd: directory, pwshPath, timeoutMs: 5000, startupTimeoutMs: 25000 });
  } finally {
    assert.ok(path.basename(directory).startsWith('job-session-test-'));
    // Retry transient file locks during Windows fixture removal.
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function recorded(file) {
  const deadline = Date.now() + 4000;
  do {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
    await pause(20);
  } while (Date.now() < deadline);
  assert.fail('통제된 fixture가 소유 PID를 기록하지 못했습니다.');
}

async function gone(id) {
  assert.ok(Number.isInteger(id) && id > 0 && id !== process.pid);
  const deadline = Date.now() + 3000;
  do {
    try { process.kill(id, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await pause(20);
  } while (Date.now() < deadline);
  assert.fail(`통제된 fixture의 프로세스가 남았습니다: ${id}`);
}

function descendants(record, natural) {
  return `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({parent:process.pid,child:child.pid})); child.unref();
${natural ? 'setTimeout(()=>process.exit(0),100);' : 'setInterval(()=>{},1000);'}`;
}

test('job handshake는 실제 root PID와 빈 job 증거를 반환하고 private settings에 env를 기록하지 않는다', async () => {
  const fixture = fakeJob();
  const started = await fixture.session.started, finished = await fixture.session.finished;
  assert.equal(started.pid, 5555); assert.equal(started.helperPid, 4444);
  assert.equal(fixture.control, 'start\n');
  assert.equal(finished.state, 'succeeded'); assert.equal(finished.exitCode, 0);
  assert.equal(finished.forced, false); assert.equal(finished.treeTerminated, true); assert.equal(finished.proof, 'windows_job_empty');
  assert.equal(fixture.launch.file, SHELL);
  assert.equal(fixture.launch.options.shell, false); assert.equal(fixture.launch.options.windowsHide, true);
  assert.ok(fixture.launch.args.includes('-NoProfile')); assert.ok(fixture.launch.args.includes('-File'));
  assert.doesNotMatch(JSON.stringify(fixture.launch.args), /SECRET_ARGUMENT|SECRET_ENV_VALUE|Command/);
  assert.doesNotMatch(JSON.stringify(fixture.settings), /SECRET_ENV_VALUE|PRIVATE_MARKER|"env"/);
  assert.doesNotMatch(JSON.stringify(finished), /SECRET_|token|settings/);
  await assert.rejects(readFile(fixture.settingsPath), { code: 'ENOENT' });
  assert.equal((await fixture.session.stop()).proof, 'windows_job_empty');
});

test('인증된 timeout handshake의 실행 상태를 일반 실패로 소실하지 않는다', async () => {
  const fixture = fakeJob({ forced: true, exitCode: 1, reason: 'timed_out' });
  const result = await fixture.session.finished;
  assert.equal(result.state, 'timed_out');
  assert.equal(result.forced, true);
  assert.equal(result.treeTerminated, true);
  assert.equal(result.proof, 'windows_job_empty');
});

test('잘못된 token·누락된 종료 handshake·남은 job 프로세스·helper 실패는 cleanup 성공으로 바뀌지 않는다', async () => {
  for (const options of [{ forged: 'ready' }, { forged: 'finished' }, { missing: true }, { active: 1 }, { helperExitCode: 1 }]) {
    const { session } = fakeJob(options);
    await session.started;
    const finished = await session.finished;
    assert.equal(finished.treeTerminated, false); assert.notEqual(finished.proof, 'windows_job_empty');
    assert.equal(finished.state, 'failed');
    assert.equal(finished.recovery.helperPid, 4444);
  }
});

test('승인 없이 도착한 started는 root나 빈 job 증거를 확정하지 않는다', async () => {
  const fixture = fakeJob({ unsolicited: true });
  const started = await fixture.session.started, finished = await fixture.session.finished;
  assert.equal(started.state, 'failed');
  assert.equal(finished.state, 'failed');
  assert.equal(finished.rootPid, null);
  assert.equal(finished.treeTerminated, false);
  assert.notEqual(finished.proof, 'windows_job_empty');
  assert.equal(fixture.control, 'stop\n');
});

test('기동 제한 시간 뒤 도착한 ready는 승인을 받지 않고 빈 job 증거를 보존한다', { timeout: 5000 }, async () => {
  const fixture = fakeJob({ startupTimeoutMs: 100, waitForStop: 'ready' });
  const started = await fixture.session.started, finished = await fixture.session.finished;
  assert.equal(fixture.control, 'stop\n');
  assert.equal(started.state, 'timed_out');
  assert.equal(started.pid, null);
  assert.equal(finished.state, 'timed_out');
  assert.equal(finished.rootPid, null);
  assert.equal(finished.exitCode, null);
  assert.equal(finished.forced, false);
  assert.equal(finished.treeTerminated, true);
  assert.equal(finished.proof, 'windows_job_empty');
});

test('기동 시간 초과 뒤 finished가 누락되면 빈 job 증거를 만들지 않는다', { timeout: 5000 }, async () => {
  const { session } = fakeJob({ startupTimeoutMs: 100, waitForStop: 'ready', missing: true });
  const started = await session.started, finished = await session.finished;
  assert.equal(started.state, 'timed_out');
  assert.equal(finished.state, 'timed_out');
  assert.equal(finished.rootPid, null);
  assert.equal(finished.treeTerminated, false);
  assert.notEqual(finished.proof, 'windows_job_empty');
});

test('승인 뒤 기동 제한 시간을 넘긴 started는 정리에 필요한 root PID만 확정한다', { timeout: 5000 }, async () => {
  const fixture = fakeJob({ startupTimeoutMs: 500, waitForStop: 'started', forced: true, exitCode: 1, reason: 'stop_requested' });
  const started = await fixture.session.started, finished = await fixture.session.finished;
  assert.equal(fixture.control, 'start\nstop\n');
  assert.equal(started.state, 'timed_out');
  assert.equal(finished.state, 'timed_out');
  assert.equal(finished.rootPid, 5555);
  assert.equal(finished.exitCode, 1);
  assert.equal(finished.forced, true);
  assert.equal(finished.treeTerminated, true);
  assert.equal(finished.proof, 'windows_job_empty');
});

test('자연 종료 뒤 잔존 트리 정리는 forced로 구분하고 root 종료 코드도 보존한다', async () => {
  const { session } = fakeJob({ forced: true, exitCode: 7 });
  const finished = await session.finished;
  assert.equal(finished.exitCode, 7); assert.equal(finished.forced, true);
  assert.equal(finished.treeTerminated, true); assert.equal(finished.proof, 'windows_job_empty');
});

test('매우 빠른 root가 시작 handshake 전에 종료되어도 정상 빈 job 증거를 수용한다', async () => {
  const { session } = fakeJob({ startedActive: 0 });
  assert.equal((await session.started).pid, 5555);
  assert.equal((await session.finished).proof, 'windows_job_empty');
});

test('기동 전 취소와 잘못된 실행 파일은 helper를 만들지 않는다', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const session = createWindowsJobSession(APP, [], { pwshPath: SHELL, signal: controller.signal, spawnImpl: () => { calls++; } });
  await session.finished; assert.equal(calls, 0);
  const invalid = createWindowsJobSession('wrapper.cmd', [], { pwshPath: SHELL, spawnImpl: () => assert.fail('invalid command') });
  assert.equal((await invalid.started).state, 'not_run');
});

test('실제 Windows 기본 세션은 자연 종료 뒤 jobempty proof와 forced:false를 반환한다', native, async () => fixture(async (directory, options) => {
  const session = startServiceSession(process.execPath, ['-e', 'process.exit(0)'], options);
  try {
    const [started, finished] = await Promise.all([session.started, session.finished]);
    const { state, exitCode, forced, treeTerminated, proof, rootPid, helperPid } = finished;
    const details = JSON.stringify({
      startedState: started.state, startedPid: started.pid, state, exitCode, forced, treeTerminated, proof, rootPid, helperPid,
    });
    assert.equal(started.state, 'running', details);
    assert.notEqual(started.pid, started.helperPid, details);
    assert.equal(state, 'succeeded', details);
    assert.equal(exitCode, 0, details);
    assert.equal(forced, false, details);
    assert.equal(treeTerminated, true, details);
    assert.equal(proof, 'windows_job_empty', details);
    assert.equal((await session.stop()).forced, false);
  } finally { await session.stop(); }
}));

test('실제 Windows helper가 ready를 알리기 전에 취소하면 root 없이 빈 job 증거를 반환한다', native, async () => fixture(async (directory, options) => {
  const controller = new AbortController();
  const session = createWindowsJobSession(process.execPath, ['-e', 'process.exit(0)'], {
    ...options, signal: controller.signal,
    spawnImpl: (file, args, settings) => {
      const helper = spawn(file, args, settings);
      controller.abort();
      return helper;
    },
  });
  try {
    const [started, finished] = await Promise.all([session.started, session.finished]);
    assert.notEqual(started.state, 'running');
    assert.equal(started.pid, null);
    assert.equal(finished.rootPid, null);
    assert.equal(finished.exitCode, null);
    assert.ok(Number.isInteger(finished.helperPid) && finished.helperPid > 0);
    assert.equal(finished.forced, false);
    assert.equal(finished.treeTerminated, true);
    assert.equal(finished.proof, 'windows_job_empty');
  } finally { await session.stop(); }
}));

test('실제 Windows argv 인용·빈 인수·환경 상속은 유지하고 환경 값을 설정 파일에 쓰지 않는다', native, async () => fixture(async (directory, options) => {
  const output = path.join(directory, 'arguments.json'), marker = randomUUID();
  const values = ['', 'space text', 'trailing\\', 'quote"\\', '한글 $() ; &', 'line\nbreak'];
  const source = "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({args:process.argv.slice(2),marker:process.env.JOB_TEST_MARKER}))";
  const session = createWindowsJobSession(process.execPath, ['-e', source, output, ...values], { ...options, env: { ...process.env, JOB_TEST_MARKER: marker },
    spawnImpl: (file, args, settings) => {
      assert.doesNotMatch(readFileSync(args.at(-1), 'utf8'), new RegExp(marker));
      return spawn(file, args, settings);
    } });
  try {
    assert.equal((await session.finished).proof, 'windows_job_empty');
    assert.deepEqual(await recorded(output), { args: values, marker });
  } finally { await session.stop(); }
}));

test('실제 Windows 부모가 먼저 종료되어도 job의 잔존 하위 프로세스를 정리한다', native, async () => fixture(async (directory, options) => {
  const output = path.join(directory, 'descendants.json');
  const session = createWindowsJobSession(process.execPath, ['-e', descendants(output, true)], options);
  try {
    const started = await session.started, pids = await recorded(output), finished = await session.finished;
    assert.equal(started.pid, pids.parent); assert.equal(finished.exitCode, 0);
    assert.equal(finished.forced, true); assert.equal(finished.proof, 'windows_job_empty');
    await gone(pids.parent); await gone(pids.child);
  } finally { await session.stop(); }
}));

test('실제 Windows AbortSignal의 stdin stop은 소유 root와 하위 프로세스만 종료한다', native, async () => fixture(async (directory, options) => {
  const output = path.join(directory, 'descendants.json'), controller = new AbortController();
  const session = createWindowsJobSession(process.execPath, ['-e', descendants(output, false)], { ...options, signal: controller.signal });
  try {
    await session.started; const pids = await recorded(output);
    controller.abort(); const finished = await session.finished;
    assert.equal(finished.forced, true); assert.equal(finished.proof, 'windows_job_empty');
    await gone(pids.parent); await gone(pids.child);
  } finally { await session.stop(); }
}));

test('실제 Windows helper 강제 종료도 kill-on-close로 하위 프로세스를 정리하며 proof를 위조하지 않는다', native, async () => fixture(async (directory, options) => {
  const output = path.join(directory, 'descendants.json'); let helper;
  const session = createWindowsJobSession(process.execPath, ['-e', descendants(output, false)], { ...options,
    spawnImpl: (file, args, settings) => { helper = spawn(file, args, settings); return helper; } });
  try {
    await session.started; const pids = await recorded(output);
    helper.kill(); const finished = await session.finished;
    assert.equal(finished.treeTerminated, false); assert.notEqual(finished.proof, 'windows_job_empty');
    assert.equal(finished.recovery.parentPid, pids.parent);
    await gone(pids.parent); await gone(pids.child);
  } finally { await session.stop(); }
}));

test('실제 Windows runtime 제한 시간은 job 전체를 종료하고 종료 증거를 남긴다', native, async () => fixture(async (directory, options) => {
  const session = createWindowsJobSession(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 80 });
  try {
    const started = await session.started, finished = await session.finished;
    assert.equal(finished.state, 'timed_out');
    assert.equal(started.state, 'running'); assert.equal(finished.forced, true);
    assert.equal(finished.treeTerminated, true); assert.equal(finished.proof, 'windows_job_empty');
    await gone(started.pid);
  } finally { await session.stop(); }
}));
