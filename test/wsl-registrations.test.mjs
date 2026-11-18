import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listWslTasks, previewWslRegistration, registerWslTask, unregisterWslTask } from '../src/wsl-registrations.mjs';

const PREFIX = 'windows-agent-wsl-registration-';
const TASK = { context: 'wsl', trusted: true, tool: '/usr/bin/make', args: ['check', 'private argument && quoted "value"'] };
const missing = (filename) => assert.rejects(lstat(filename), { code: 'ENOENT' });
const taskAt = (definition, file) => writeFile(file, JSON.stringify(definition));
const ruleText = (executable) => 'prefix_rule(pattern = [' + JSON.stringify(executable) + '], decision = "allow")\n';

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const base = await realpath(await mkdtemp(path.join(parent, PREFIX)));
  const identity = await lstat(base);
  t.after(async () => {
    const child = path.relative(parent, base);
    assert.equal(child, path.basename(base));
    assert.ok(child.startsWith(PREFIX));
    assert.equal(await realpath(base), base);
    const current = await lstat(base);
    assert.deepEqual([current.dev, current.ino], [identity.dev, identity.ino]);
    await rm(base, { recursive: true, force: true });
  });
  const projectPath = path.join(base, 'Project [개발]');
  const userProfile = path.join(base, 'User Profile');
  const localAppData = path.join(userProfile, 'AppData', 'Local');
  const taskFile = path.join(projectPath, 'select-task.json');
  await Promise.all([mkdir(projectPath), mkdir(localAppData, { recursive: true })]);
  await taskAt(TASK, taskFile);
  const options = { projectPath, name: 'check', distro: 'Ubuntu-24.04', linuxCwd: '/home/me/project', taskFile, version: '0.3.2' };
  const invocations = [];
  const provision = async (input) => {
    invocations.push(input);
    assert.equal(input.projectPath, await realpath(input.projectPath));
    assert.equal(path.dirname(input.taskPath), input.directory);
    assert.equal(path.dirname(input.leasePath), input.directory);
    assert.match(input.leaseValue, /^[0-9a-f]{64}$/);
    assert.ok(path.relative(localAppData, input.directory).startsWith(path.join('WindowsAgentDevkit', 'approved-wsl') + path.sep));
    assert.deepEqual(JSON.parse(await readFile(input.taskPath, 'utf8')), input.task);
    assert.deepEqual(await readdir(input.fixturePath), []);
    assert.deepEqual(await readdir(input.statePath), []);
    await missing(input.leasePath);
    const executable = path.join(input.directory, 'wsl task.exe');
    await writeFile(executable, 'fixture executable', { flag: 'wx' });
    return { executable };
  };
  return { base, userProfile, projectPath, localAppData, taskFile, options, invocations, dependencies: { provision, localAppData, platform: 'win32' } };
}

async function register(ctx, overrides = {}, dependencies = ctx.dependencies) {
  const options = { ...ctx.options, ...overrides };
  const { confirmation } = await previewWslRegistration(options);
  return registerWslTask({ ...options, execute: true, confirm: confirmation }, dependencies);
}

const revoke = (ctx, name = ctx.options.name) => unregisterWslTask({ ...ctx.options, name, execute: true }, ctx.dependencies);
const list = (ctx) => listWslTasks(ctx.options, ctx.dependencies);
const junction = (target, alias) => symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
const permitsLaunch = async ({ leasePath, leaseValue }) => (await readFile(leasePath, 'utf8').catch(() => null)) === leaseValue;

test('WSL 등록 미리보기는 현재 검토 입력을 묶고 쓰기와 argv 공개 없이 반환한다', async (t) => {
  const ctx = await fixture(t);
  const preview = await previewWslRegistration(ctx.options);
  assert.equal(preview.state, 'review_required');
  assert.match(preview.confirmation, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.task, { path: ctx.taskFile, tool: TASK.tool, argCount: 2 });
  assert.doesNotMatch(JSON.stringify(preview), /private argument|"args"|"env"/);
  const confirmed = { ...ctx.options, execute: true, confirm: preview.confirmation };
  await assert.rejects(registerWslTask({ ...confirmed, execute: 'true' }, ctx.dependencies), { code: 'WSL_CONFIRMATION_REQUIRED' });
  await assert.rejects(registerWslTask({ ...confirmed, confirm: undefined }, ctx.dependencies), { code: 'WSL_CONFIRMATION_REQUIRED' });
  for (const change of [{ name: 'CHECK' }, { distro: 'ubuntu-24.04' }, { linuxCwd: '/home/me/other' }, { version: '0.3.3' }]) {
    await assert.rejects(registerWslTask({ ...confirmed, ...change }, ctx.dependencies), { code: 'WSL_CONFIRMATION_MISMATCH' });
  }
  const other = path.join(ctx.base, 'Other project');
  await mkdir(other);
  await assert.rejects(registerWslTask({ ...confirmed, projectPath: other }, ctx.dependencies), { code: 'WSL_CONFIRMATION_MISMATCH' });
  await taskAt({ args: TASK.args, tool: TASK.tool, trusted: true, context: 'wsl' }, ctx.taskFile);
  assert.equal((await previewWslRegistration(ctx.options)).confirmation, preview.confirmation);
  for (const changed of [{ ...TASK, tool: '/usr/bin/true' }, { ...TASK, args: [...TASK.args].reverse() }]) {
    await taskAt(changed, ctx.taskFile);
    await assert.rejects(registerWslTask(confirmed, ctx.dependencies), { code: 'WSL_CONFIRMATION_MISMATCH' });
  }
  assert.deepEqual((await list(ctx)).tasks, []);
  assert.deepEqual(ctx.invocations, []);
  await missing(path.join(ctx.projectPath, '.codex'));
  await missing(path.join(ctx.localAppData, 'WindowsAgentDevkit'));
});

test('WSL 등록 입력은 도구·인수·중복 키와 이름을 백엔드 실행 범위에서 검증한다', async (t) => {
  const ctx = await fixture(t);
  for (const name of ['../escape', 'a/b', 'a\\b', 'has space', '.hidden', 'a:b', 'a".rules', 'a'.repeat(65)]) {
    await assert.rejects(previewWslRegistration({ ...ctx.options, name }), { code: 'WSL_INVALID_NAME' });
  }
  for (const change of [{ distro: '--import' }, { linuxCwd: 'relative' }, { linuxCwd: '/home/../project' }, { linuxCwd: '/home//project' }]) {
    await assert.rejects(previewWslRegistration({ ...ctx.options, ...change }), { code: 'WSL_INVALID_TARGET' });
  }
  for (const task of [
    null, [TASK], { ...TASK, trusted: 'true' }, { ...TASK, context: 'native' }, { ...TASK, cwd: '/home' },
    { ...TASK, env: { PRIVATE_VALUE: 'hidden' } }, { ...TASK, args: undefined }, { ...TASK, args: ['\0'] },
    { ...TASK, args: [null] }, { ...TASK, args: ['a\nb'] }, { ...TASK, args: ['a\rb'] }, { ...TASK, args: ['\uD800'] },
    { ...TASK, args: Array(108).fill('') }, { ...TASK, tool: 'make' }, { ...TASK, tool: '/usr/bin/./make' },
    { ...TASK, tool: '/mnt/c/bin/make' }, { ...TASK, tool: '/home/me/shims/make' }, { ...TASK, tool: '/usr/bin/make.exe' },
  ]) {
    await taskAt(task, ctx.taskFile);
    await assert.rejects(previewWslRegistration(ctx.options), { code: 'WSL_INVALID_TASK' });
  }
  await writeFile(ctx.taskFile, '{"context":"wsl","trusted":true,"tool":"/usr/bin/make","args":["private value"],"\\u0061rgs":[]}');
  await assert.rejects(previewWslRegistration(ctx.options), (error) => {
    assert.equal(error.code, 'WSL_INVALID_TASK');
    assert.doesNotMatch(error.message, /private value/);
    return true;
  });
  await taskAt({ ...TASK, args: Array(107).fill('') }, ctx.taskFile);
  assert.equal((await previewWslRegistration(ctx.options)).task.argCount, 107);
});

test('WSL 세대는 프로젝트별 작업을 분리하고 규칙 하나만 게시하며 재등록 시 실행 경로를 재사용하지 않는다', async (t) => {
  const ctx = await fixture(t);
  const codex = path.join(ctx.projectPath, '.codex');
  const rules = path.join(codex, 'rules');
  const exclude = path.join(ctx.projectPath, '.git', 'info', 'exclude');
  const foreignRule = path.join(rules, 'existing.rules');
  await Promise.all([mkdir(rules, { recursive: true }), mkdir(path.dirname(exclude), { recursive: true })]);
  await Promise.all([
    writeFile(path.join(codex, 'config.toml'), '# project settings'), writeFile(foreignRule, '# existing rule'),
    writeFile(exclude, '# local exclude\n/cache'), writeFile(path.join(ctx.projectPath, '.gitignore'), '/shared-cache\n'),
  ]);
  const first = await register(ctx);
  assert.equal(first.state, 'registered');
  assert.equal(first.gitExcluded, true);
  assert.equal(await readFile(first.rulePath, 'utf8'), ruleText(first.executable));
  assert.deepEqual((await readdir(rules)).sort(), ['existing.rules', path.basename(first.rulePath)].sort());
  assert.equal(await readFile(exclude, 'utf8'), '# local exclude\n/cache\n/.codex/rules/' + path.basename(first.rulePath) + '\n');
  assert.equal(await permitsLaunch(ctx.invocations[0]), true);
  await assert.rejects(register(ctx, { name: 'CHECK' }), { code: 'WSL_NAME_IN_USE' });
  const second = await register(ctx, { name: 'lint' });
  assert.notEqual(first.executable, second.executable);
  assert.deepEqual((await list(ctx)).tasks.map(({ state, name }) => [state, name]), [['active', 'check'], ['active', 'lint']]);

  const otherProject = path.join(ctx.base, 'Other project');
  await mkdir(otherProject);
  const other = await register(ctx, { projectPath: otherProject });
  assert.notEqual(other.executable, first.executable);
  assert.deepEqual((await listWslTasks({ projectPath: otherProject }, ctx.dependencies)).tasks.map(({ id }) => id), [other.id]);
  assert.deepEqual((await list(ctx)).tasks.map(({ id }) => id), [first.id, second.id]);
  await taskAt({ ...TASK, args: ['new source input'] }, ctx.taskFile);
  assert.deepEqual(JSON.parse(await readFile(ctx.invocations[0].taskPath, 'utf8')), TASK);
  assert.deepEqual(await revoke(ctx, 'CHECK'), {
    state: 'revoked', projectPath: ctx.projectPath, name: 'CHECK', id: first.id, lease: 'removed', rule: 'removed',
  });
  await missing(first.rulePath);
  assert.equal(await permitsLaunch(ctx.invocations[0]), false);
  assert.equal(await permitsLaunch(ctx.invocations[1]), true);
  assert.equal(await permitsLaunch(ctx.invocations[2]), true);
  assert.equal(await readFile(first.executable, 'utf8'), 'fixture executable');
  assert.equal((await revoke(ctx)).state, 'not_found');

  const replacement = await register(ctx);
  assert.notEqual(first.id, replacement.id);
  assert.notEqual(first.executable, replacement.executable);
  assert.notEqual(first.rulePath, replacement.rulePath);
  assert.equal(await permitsLaunch(ctx.invocations[0]), false);
  assert.equal(await permitsLaunch(ctx.invocations[3]), true);
  assert.equal(await readFile(foreignRule, 'utf8'), '# existing rule');
  assert.equal(await readFile(path.join(codex, 'config.toml'), 'utf8'), '# project settings');
  assert.equal(await readFile(path.join(ctx.projectPath, '.gitignore'), 'utf8'), '/shared-cache\n');
});

test('동시에 같은 이름의 등록과 해제를 거부하면서 다른 이름은 진행한다', async (t) => {
  const ctx = await fixture(t);
  const started = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const work = register(ctx, {}, {
    ...ctx.dependencies,
    provision: async (input) => {
      started.resolve(input);
      await proceed.promise;
      return ctx.dependencies.provision(input);
    },
  });
  try {
    const pending = await Promise.race([started.promise, work]);
    await missing(pending.leasePath);
    assert.equal((await list(ctx)).tasks[0].state, 'pending');
    await assert.rejects(register(ctx), { code: 'WSL_REGISTRATION_BUSY' });
    await assert.rejects(revoke(ctx), { code: 'WSL_REGISTRATION_BUSY' });
    assert.equal((await register(ctx, { name: 'lint' })).state, 'registered');
  } finally {
    proceed.resolve();
    await work;
  }
  assert.deepEqual((await list(ctx)).tasks.map(({ state }) => state), ['active', 'active']);
});

test('종료된 프로세스의 잠금을 회수해 활성 WSL 등록을 철회하고 새 경로로 다시 등록한다', async (t) => {
  const ctx = await fixture(t);
  const first = await register(ctx);
  const [original] = ctx.invocations;
  const lockDirectory = path.join(path.dirname(original.directory), 'mutation.lock');
  const otherRule = path.join(path.dirname(first.rulePath), 'existing.rules');
  const otherRuleText = '# existing rule\n';
  await writeFile(otherRule, otherRuleText, { flag: 'wx' });

  const owner = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  assert.deepEqual(await once(owner, 'close'), [0, null]);
  assert.ok(Number.isInteger(owner.pid) && owner.pid > 0);
  assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
  await mkdir(lockDirectory);
  await writeFile(path.join(lockDirectory, `owner-${owner.pid}-${randomUUID()}`),
    'windows-agent-devkit-wsl-mutation-lock\n', { flag: 'wx' });

  assert.equal(await permitsLaunch(original), true);
  assert.equal(await readFile(first.rulePath, 'utf8'), ruleText(first.executable));
  assert.deepEqual((await list(ctx)).tasks.map(({ id, state }) => [id, state]), [[first.id, 'active']]);
  assert.deepEqual(await revoke(ctx), {
    state: 'revoked', projectPath: ctx.projectPath, name: ctx.options.name, id: first.id, lease: 'removed', rule: 'removed',
  });
  await missing(lockDirectory);
  await missing(original.leasePath);
  await missing(first.rulePath);
  assert.equal(await readFile(otherRule, 'utf8'), otherRuleText);
  assert.deepEqual((await list(ctx)).tasks, []);

  const replacement = await register(ctx);
  assert.notEqual(replacement.id, first.id);
  assert.notEqual(replacement.executable, first.executable);
  assert.notEqual(replacement.rulePath, first.rulePath);
  assert.equal(await permitsLaunch(original), false);
  assert.equal(await permitsLaunch(ctx.invocations[1]), true);
});

test('백엔드 오류는 알려진 코드만 보존하고 실패한 세대는 활성화하지 않는다', async (t) => {
  const ctx = await fixture(t);
  const existing = await register(ctx, { name: 'lint' });
  const attempts = [
    ['WSL_LAUNCHER_TOOL_REQUIRED', 'WSL launcher provisioning requires an installed native go.exe.', 'WSL_LAUNCHER_TOOL_REQUIRED', /go\.exe/],
    ['WSL_LAUNCHER_LINUX_UNVERIFIED', 'private argv and command output', 'WSL_LAUNCHER_LINUX_UNVERIFIED', /Linux/],
    ['WSL_LAUNCHER_UNKNOWN', 'private argv and command output', 'WSL_PROVISION_FAILED', /Go/],
  ];
  for (const [code, message, expected, diagnosis] of attempts) {
    await assert.rejects(register(ctx, {}, {
      ...ctx.dependencies,
      provision: async () => { throw Object.assign(new Error(message), { code }); },
    }), (error) => {
      assert.equal(error.code, expected);
      assert.match(error.message, diagnosis);
      assert.doesNotMatch(error.message, /private argv and command output/);
      return true;
    });
  }
  assert.deepEqual((await list(ctx)).tasks.map(({ id }) => id), [existing.id]);
  assert.equal((await register(ctx)).state, 'registered');
});

test('외부 실행 파일과 기존 규칙 이름 충돌은 전용 실행 승인으로 게시되지 않는다', async (t) => {
  const ctx = await fixture(t);
  const rules = path.join(ctx.projectPath, '.codex', 'rules');
  const git = path.join(ctx.projectPath, '.git');
  await Promise.all([mkdir(rules, { recursive: true }), mkdir(git)]);
  const outsider = path.join(ctx.base, 'outside.exe');
  await writeFile(outsider, 'outside file');
  await assert.rejects(register(ctx, {}, {
    ...ctx.dependencies, provision: async () => ({ executable: outsider }),
  }), { code: 'WSL_UNSAFE_PATH' });
  assert.deepEqual(await readdir(rules), []);
  let blockedRule, blockedLease;
  await assert.rejects(register(ctx, {}, {
    ...ctx.dependencies,
    provision: async (input) => {
      blockedRule = path.join(rules, 'windows-agent-devkit-wsl-check-' + path.basename(input.directory) + '.rules');
      blockedLease = input.leasePath;
      await writeFile(blockedRule, '# concurrently created user rule', { flag: 'wx' });
      return ctx.dependencies.provision(input);
    },
  }), { code: 'EEXIST' });
  assert.equal(await readFile(blockedRule, 'utf8'), '# concurrently created user rule');
  await missing(blockedLease);
  await missing(path.join(git, 'info'));
  const registered = await register(ctx);
  assert.equal(registered.gitExcluded, true);
  assert.equal(await readFile(path.join(git, 'info', 'exclude'), 'utf8'), '/.codex/rules/' + path.basename(registered.rulePath) + '\n');
});

test('변경된 규칙과 등록 기록은 보존하고 해제된 lease는 이전 세대의 실행을 막는다', async (t) => {
  const ctx = await fixture(t);
  const edited = await register(ctx);
  const editedRule = ruleText(edited.executable) + '# locally edited\n';
  await writeFile(edited.rulePath, editedRule);
  assert.equal((await list(ctx)).tasks[0].state, 'conflict');
  const editedResult = await revoke(ctx);
  assert.deepEqual([editedResult.state, editedResult.lease, editedResult.rule], ['conflict', 'removed', 'conflict']);
  assert.equal(await readFile(edited.rulePath, 'utf8'), editedRule);
  assert.equal(await permitsLaunch(ctx.invocations[0]), false);

  const torn = await register(ctx);
  const record = path.join(path.dirname(torn.executable), 'registration.json');
  const stored = JSON.parse(await readFile(record, 'utf8'));
  await writeFile(record, JSON.stringify({ ...stored, executable: 'another.exe' }));
  assert.equal((await list(ctx)).tasks[0].state, 'conflict');
  const tornResult = await revoke(ctx);
  assert.deepEqual([tornResult.state, tornResult.lease, tornResult.rule], ['conflict', 'removed', 'conflict']);
  assert.equal(await readFile(torn.rulePath, 'utf8'), ruleText(torn.executable));
  assert.equal(await permitsLaunch(ctx.invocations[1]), false);
});

test('Windows 경로 별칭은 프로젝트를 하나로 유지하고 등록·규칙·입력 파일의 링크는 거부한다', async (t) => {
  const ctx = await fixture(t);
  const alias = path.join(ctx.base, 'Project alias');
  await junction(ctx.projectPath, alias);
  const aliasOptions = { ...ctx.options, projectPath: alias, taskFile: path.join(alias, path.basename(ctx.taskFile)) };
  assert.equal((await previewWslRegistration(aliasOptions)).confirmation, (await previewWslRegistration(ctx.options)).confirmation);
  const alternateTask = path.join(ctx.base, 'other-task.json');
  await link(ctx.taskFile, alternateTask);
  await assert.rejects(previewWslRegistration({ ...ctx.options, taskFile: alternateTask }), { code: 'WSL_UNSAFE_PATH' });
  if (process.platform === 'win32') {
    await assert.rejects(previewWslRegistration({ ...ctx.options, taskFile: ctx.taskFile + ':stream' }), { code: 'WSL_TASK_FILE_REQUIRED' });
  }
  const fresh = path.join(ctx.projectPath, 'new-task.json');
  await taskAt(TASK, fresh);
  const external = path.join(ctx.base, 'external');
  await mkdir(external);
  const product = path.join(ctx.localAppData, 'WindowsAgentDevkit');
  await junction(external, product);
  await assert.rejects(register(ctx, { taskFile: fresh }), { code: 'WSL_UNSAFE_PATH' });
  await missing(path.join(external, 'approved-wsl'));
  const local = path.join(ctx.base, 'another local app data');
  await mkdir(local);
  await junction(external, path.join(ctx.projectPath, '.codex'));
  await assert.rejects(register(ctx, { taskFile: fresh }, { ...ctx.dependencies, localAppData: local }), { code: 'WSL_UNSAFE_PATH' });
  assert.deepEqual(await readdir(external), []);
});

test('목록은 명시한 사용자 프로필의 로컬 저장소만 보조 조회하고 변경은 주 경로만 사용한다', async (t) => {
  const ctx = await fixture(t);
  const active = await register(ctx);
  const sandboxLocal = path.join(ctx.base, 'Sandbox Local AppData');
  await mkdir(sandboxLocal);
  const different = { ...ctx.dependencies, localAppData: sandboxLocal };
  const withFallback = { ...different, userProfile: ctx.userProfile };
  assert.deepEqual((await listWslTasks(ctx.options, different)).tasks, []);
  assert.deepEqual((await listWslTasks(ctx.options, withFallback)).tasks.map(({ id }) => id), [active.id]);
  const same = { ...ctx.dependencies, userProfile: ctx.userProfile };
  assert.deepEqual(await listWslTasks(ctx.options, same), await list(ctx));
  assert.equal((await unregisterWslTask({ ...ctx.options, execute: true }, withFallback)).state, 'not_found');
  assert.equal(await permitsLaunch(ctx.invocations[0]), true);
  await missing(path.join(sandboxLocal, 'WindowsAgentDevkit'));
  await assert.rejects(register(ctx, { name: 'other' }, { ...ctx.dependencies, platform: 'linux' }), { code: 'WSL_WINDOWS_REQUIRED' });
  await assert.rejects(register(ctx, { name: 'other' }, { ...ctx.dependencies, localAppData: ctx.projectPath }), { code: 'WSL_STATE_INSIDE_PROJECT' });
});
