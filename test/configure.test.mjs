import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, writeFile, readFile, readdir, realpath, lstat, rm, symlink, link, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlan, applyPlan, rollbackPlan, saveException, loadExceptions } from '../src/configure.mjs';

const PREFIX = 'windows-agent-devkit-configure-';
async function fixture(t, entries = {}) {
  const base = await realpath(tmpdir());
  const folder = await realpath(await mkdtemp(path.join(base, PREFIX))), identity = await lstat(folder);
  t.after(async () => {
    assert.equal(path.dirname(folder), base);
    assert.ok(path.basename(folder).startsWith(PREFIX));
    const current = await lstat(folder);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(await realpath(folder), folder);
    await rm(folder, { recursive: true });
  });
  const projectPath = path.join(folder, 'project'), stateDir = path.join(folder, 'private-state');
  await mkdir(projectPath);
  for (const [name, value] of Object.entries(entries)) {
    const target = path.resolve(projectPath, name), relative = path.relative(projectPath, target);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof value === 'object' ? JSON.stringify(value) : value);
  }
  return { projectPath, stateDir, folder };
}

const options = (ctx, extra = {}) => ({ projectPath: ctx.projectPath, stateDir: ctx.stateDir, ...extra });
const text = (ctx, name) => readFile(path.join(ctx.projectPath, name), 'utf8');
const code = (expected) => (error) => error.code === expected;
const selected = { roles: ['runtime-version-manager'], versions: { node: '24.10.0' } };

test('계획은 안정적인 해시와 구체적인 선언만 반환하며 실행하지 않는다', async (t) => {
  const ctx = await fixture(t, { 'package.json': { engines: { node: '^24.0.0' }, config: { token: 'NEVER_PRINT_ME' } } });
  const plan = await createPlan(options(ctx, selected));
  const repeated = await createPlan(options(ctx, selected));
  assert.equal(plan.hash, repeated.hash);
  assert.equal(plan.id, plan.hash);
  assert.deepEqual(plan.operations.map((item) => item.type), ['write-mise']);
  assert.deepEqual(plan.operations[0].versions, { node: '24.10.0' });
  assert.ok(!JSON.stringify(plan).includes('NEVER_PRINT_ME'));
  assert.equal(plan.operations[0].beforeHash, null);
  assert.match(plan.operations[0].afterHash, /^[a-f0-9]{64}$/);
  const preview = await applyPlan(options(ctx, { plan, query: () => { throw Error('must not run'); } }));
  assert.equal(preview.status, 'planned');
  await assert.rejects(text(ctx, 'mise.toml'), { code: 'ENOENT' });
});

test('적용은 반복해도 같은 저널을 사용하고 복구 후 다시 계획할 수 있다', async (t) => {
  const ctx = await fixture(t);
  const plan = await createPlan(options(ctx, selected));
  const applied = await applyPlan(options(ctx, { plan, execute: true }));
  assert.equal(applied.status, 'applied');
  assert.match(await text(ctx, 'mise.toml'), /node = "24.10.0"/);
  assert.ok(!applied.journalPath.startsWith(ctx.projectPath + path.sep));
  const repeated = await applyPlan(options(ctx, { plan, execute: true }));
  assert.equal(repeated.status, 'already_applied');
  assert.equal(repeated.journal.id, applied.journal.id);
  const rollbackPreview = await rollbackPlan(options(ctx, { journal: applied.journal }));
  assert.equal(rollbackPreview.changes[0].status, 'would_restore');
  assert.match(await text(ctx, 'mise.toml'), /24.10.0/);
  const restored = await rollbackPlan(options(ctx, { id: applied.journal.id, execute: true }));
  assert.equal(restored.status, 'rolled_back');
  await assert.rejects(text(ctx, 'mise.toml'), { code: 'ENOENT' });
  assert.equal((await rollbackPlan(options(ctx, { journalPath: applied.journalPath, execute: true }))).status, 'rolled_back');
  assert.equal((await applyPlan(options(ctx, { plan, execute: true }))).status, 'applied');
});

test('이미 정렬된 선언과 선택 없는 요청은 정상적인 무변경 결과다', async (t) => {
  const ctx = await fixture(t, { 'mise.toml': '[tools]\nnode = "24.10.0"\n' });
  const plan = await createPlan(options(ctx, { roles: ['runtime-version-manager'] }));
  assert.deepEqual(plan.operations, []);
  assert.equal((await applyPlan(options(ctx, { plan, execute: true }))).status, 'no_changes');
  const empty = await createPlan(options(ctx));
  assert.deepEqual(empty.operations, []);
});

test('기존 선언·패키지 관리자·잠금·CI·스테이징을 바꾸지 않는다', async (t) => {
  const entries = {
    '.nvmrc': 'v24.10.0\r\n',
    'package.json': { engines: { node: '>=24 <25' }, packageManager: 'pnpm@10.20.0', scripts: { build: 'keep-build' } },
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    '.github/workflows/ci.yml': 'run: pnpm build\n', '.git/index': 'opaque staged content\0',
    'mise.toml': '\uFEFF# credentials MUST_STAY_PRIVATE\r\n[env]\r\nAPI_TOKEN = "MUST_STAY_PRIVATE"\r\n\r\n[tools]\r\npython = "3.13.8" # user comment\r\n',
  };
  const ctx = await fixture(t, entries), original = {};
  for (const name of Object.keys(entries)) original[name] = await readFile(path.join(ctx.projectPath, name));
  const plan = await createPlan(options(ctx, { roles: ['runtime-version-manager'] }));
  assert.ok(!JSON.stringify(plan).includes('MUST_STAY_PRIVATE'));
  const applied = await applyPlan(options(ctx, { plan, execute: true }));
  assert.equal(applied.status, 'applied');
  const configured = await text(ctx, 'mise.toml');
  assert.ok(configured.startsWith('\uFEFF# credentials'));
  assert.ok(configured.includes('python = "3.13.8" # user comment\r\n'));
  for (const name of Object.keys(entries).filter((name) => name !== 'mise.toml')) assert.deepEqual(await readFile(path.join(ctx.projectPath, name)), original[name]);
  assert.ok(!JSON.stringify(applied).includes('MUST_STAY_PRIVATE'));
  assert.equal((await rollbackPlan(options(ctx, { id: applied.journal.id, execute: true }))).status, 'rolled_back');
  assert.deepEqual(await readFile(path.join(ctx.projectPath, 'mise.toml')), original['mise.toml']);
});

test('충돌한 고정 버전은 유지하고 범위 요구에는 명시한 정확한 버전이 필요하다', async (t) => {
  const ctx = await fixture(t, { '.node-version': '22.20.0\n' });
  const plan = await createPlan(options(ctx, selected));
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.differences.find((item) => item.role === 'node').status, 'blocked');
  assert.equal(await text(ctx, '.node-version'), '22.20.0\n');
  await writeFile(path.join(ctx.projectPath, '.node-version'), '24\n');
  const range = await createPlan(options(ctx, { roles: ['runtime-version-manager'] }));
  assert.equal(range.differences.find((item) => item.role === 'node').reason, 'EXPLICIT_EXACT_VERSION_REQUIRED');
});

test('편집된 계획과 다시 해시한 명령 주입 계획을 거부한다', async (t) => {
  const ctx = await fixture(t), plan = await createPlan(options(ctx, selected));
  const edited = structuredClone(plan); edited.operations[0].path = path.join(ctx.folder, 'outside.txt');
  await assert.rejects(applyPlan(options(ctx, { plan: edited, execute: true })), code('PLAN_HASH_MISMATCH'));
  const malicious = structuredClone(plan);
  malicious.operations.push({ type: 'command', command: 'pwsh', args: ['-Command', 'write-secret'] });
  const { hash, id, ...body } = malicious;
  const stable = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  malicious.id = malicious.hash = createHash('sha256').update(stable(body)).digest('hex');
  await assert.rejects(applyPlan(options(ctx, { plan: malicious, execute: true })), code('PLAN_NOT_REVIEWED'));
  await assert.rejects(createPlan(options(ctx, { roles: ['git'], versions: { git: '2.47.0 --override malicious' } })), code('EXACT_VERSION_REQUIRED'));
  assert.deepEqual(await readdir(ctx.projectPath), []);
});

test('선언·잠금·CI 변경과 새 선언 추가는 적용 전에 오래된 계획을 거부한다', async (t) => {
  for (const filename of ['package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', '.node-version']) {
    const ctx = await fixture(t, { 'package.json': { engines: { node: '^24.0.0' } }, 'pnpm-lock.yaml': 'old' });
    const plan = await createPlan(options(ctx, selected));
    await mkdir(path.dirname(path.join(ctx.projectPath, filename)), { recursive: true });
    await writeFile(path.join(ctx.projectPath, filename), filename === 'package.json' ? '{"engines":{"node":"22"}}' : 'concurrent edit');
    await assert.rejects(applyPlan(options(ctx, { plan, execute: true })), code('STALE_PLAN'));
    await assert.rejects(text(ctx, 'mise.toml'), { code: 'ENOENT' });
  }
});

test('프로필의 관리 블록은 선택한 임시 파일에만 추가하고 기존 내용을 복구한다', async (t) => {
  const ctx = await fixture(t), profilePath = path.join(ctx.folder, 'profile', 'Microsoft.PowerShell_profile.ps1');
  await mkdir(path.dirname(profilePath));
  const original = '\uFEFF# PRIVATE_PROFILE\r\nSet-Alias ll Get-ChildItem\r\n';
  await writeFile(profilePath, original);
  const plan = await createPlan(options(ctx, { roles: ['powershell-profile'], profilePath }));
  assert.ok(!JSON.stringify(plan).includes('PRIVATE_PROFILE'));
  const applied = await applyPlan(options(ctx, { plan, execute: true }));
  assert.equal(applied.status, 'applied');
  assert.ok((await readFile(profilePath, 'utf8')).startsWith(original));
  const next = await createPlan(options(ctx, { roles: ['powershell-profile'], profilePath }));
  assert.deepEqual(next.operations, []);
  await rollbackPlan(options(ctx, { id: applied.journal.id, execute: true }));
  assert.equal(await readFile(profilePath, 'utf8'), original);
});

test('복구는 동시 사용자 편집을 보존하고 다른 자체 변경은 복구한다', async (t) => {
  const ctx = await fixture(t), profilePath = path.join(ctx.folder, 'profile.ps1');
  const plan = await createPlan(options(ctx, { ...selected, roles: ['runtime-version-manager', 'powershell-profile'], profilePath }));
  const applied = await applyPlan(options(ctx, { plan, execute: true }));
  await writeFile(path.join(ctx.projectPath, 'mise.toml'), '# user edit\n[tools]\nnode="24.10.0"\n');
  const result = await rollbackPlan(options(ctx, { id: applied.journal.id, execute: true }));
  assert.equal(result.status, 'rollback_conflict');
  assert.match(await text(ctx, 'mise.toml'), /user edit/);
  await assert.rejects(readFile(profilePath), { code: 'ENOENT' });
});

test('프로젝트별 유지 예외는 역할과 이유·범위로 저장하고 다음 제안을 억제한다', async (t) => {
  const ctx = await fixture(t, { '.node-version': '24.10.0\n' });
  assert.deepEqual(await loadExceptions(options(ctx)), []);
  const entry = { role: 'runtime-version-manager', reason: '기업 정책으로 기존 관리자를 유지합니다.', scope: 'project' };
  assert.equal((await saveException(options(ctx, entry))).status, 'saved');
  assert.equal((await saveException(options(ctx, entry))).status, 'unchanged');
  const saved = await loadExceptions(options(ctx));
  assert.equal(saved.length, 1); assert.equal(saved[0].reason, entry.reason);
  assert.equal(saved[0].projectPath, await realpath(ctx.projectPath));
  const plan = await createPlan(options(ctx, selected));
  assert.deepEqual(plan.operations, []);
  assert.ok(plan.differences.some((item) => item.status === 'kept_exception'));
  await assert.rejects(saveException(options(ctx, { role: 'node', reason: '' })), code('EXCEPTION_REASON_AND_SCOPE_REQUIRED'));
});

test('저장소 내부 상태 디렉터리와 다른 프로젝트의 계획·저널을 거부한다', async (t) => {
  const ctx = await fixture(t), other = await fixture(t);
  await assert.rejects(createPlan({ projectPath: ctx.projectPath, stateDir: path.join(ctx.projectPath, 'private-state') }), code('STATE_DIR_MUST_BE_OUTSIDE_REPOSITORY'));
  const plan = await createPlan(options(ctx, selected));
  await assert.rejects(applyPlan(options(other, { plan, execute: true })), code('INVALID_PLAN'));
  const applied = await applyPlan(options(ctx, { plan, execute: true }));
  const edited = structuredClone(applied.journal); edited.entries[0].path = path.join(ctx.folder, 'outside.txt');
  await assert.rejects(rollbackPlan(options(ctx, { journal: edited, execute: true })), code('JOURNAL_MISMATCH'));
  await assert.rejects(rollbackPlan(options(ctx, { journalPath: path.join(ctx.folder, 'foreign.json'), execute: true })), code('UNSAFE_JOURNAL_PATH'));
});

function miseRunner({ installed = {}, fail = false, leak = 'DO_NOT_PRINT_INSTALL_OUTPUT' } = {}) {
  const calls = [];
  const query = async (tool, args, settings) => {
    calls.push({ tool, args, settings });
    if (args[0] === 'ls') return { state: 'succeeded', exitCode: 0, stdout: JSON.stringify(installed) };
    if (fail) return { state: 'failed', exitCode: 1, stdout: leak, stderr: leak };
    const [backend, version] = args[1].split('@'), role = backend.split(':').at(-1);
    installed[role] = [...(installed[role] ?? []), { version }];
    return { state: 'succeeded', exitCode: 0, stdout: leak, stderr: leak };
  };
  return { query, calls, installed };
}

test('설치는 선택한 역할·정확한 버전·고정 명령만 실행하며 반복 적용은 재설치하지 않는다', async (t) => {
  const ctx = await fixture(t), mock = miseRunner();
  const plan = await createPlan(options(ctx, { roles: ['node'], versions: { node: '24.10.0', git: '2.47.0' } }));
  assert.deepEqual(plan.operations.filter((entry) => entry.type === 'install').map((entry) => entry.role), ['node']);
  await assert.rejects(applyPlan(options(ctx, { plan, execute: true })), code('INSTALL_RUNNER_REQUIRED'));
  const result = await applyPlan(options(ctx, { plan, execute: true, query: mock.query }));
  assert.equal(result.status, 'applied');
  assert.deepEqual(mock.calls.find((call) => call.args[0] === 'install').args, ['install', 'core:node@24.10.0']);
  assert.ok(mock.calls.every((call) => !call.settings.cwd.startsWith(ctx.projectPath + path.sep)));
  assert.ok(!JSON.stringify(result).includes('DO_NOT_PRINT_INSTALL_OUTPUT'));
  const length = mock.calls.length;
  assert.equal((await applyPlan(options(ctx, { plan, execute: true, query: mock.query }))).status, 'already_applied');
  assert.equal(mock.calls.length, length);
  const rolledBack = await rollbackPlan(options(ctx, { id: result.journal.id, execute: true, query: mock.query }));
  assert.equal(rolledBack.status, 'partially_rolled_back');
  assert.equal(mock.calls.length, length);
  assert.deepEqual(mock.installed.node, [{ version: '24.10.0' }]);
});

test('설치 실패 시 자체 파일 변경을 복구하고 외부 출력은 반환하지 않는다', async (t) => {
  const ctx = await fixture(t), mock = miseRunner({ fail: true });
  const plan = await createPlan(options(ctx, { roles: ['node'], versions: { node: '24.10.0' } }));
  const result = await applyPlan(options(ctx, { plan, execute: true, query: mock.query }));
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'INSTALL_FAILED');
  await assert.rejects(text(ctx, 'mise.toml'), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(result).includes('DO_NOT_PRINT_INSTALL_OUTPUT'));
});

function wingetRunner({ installed = null, fail = false, unknown = false } = {}) {
  const calls = [];
  const query = async (tool, args, settings) => {
    calls.push({ tool, args, settings });
    assert.equal(tool, 'winget');
    assert.equal(settings.execute, true, '부모 실행기의 명시적인 실행 경계가 필요합니다.');
    if (args[0] === 'list') {
      if (unknown) return { state: 'succeeded', exitCode: 0, stdout: 'unexpected output' };
      if (!installed) return { state: 'failed', exitCode: 0x8a150014 | 0, stdout: 'localized no match' };
      return { state: 'succeeded', exitCode: 0, stdout: `Name Id Version Source\nGit Git.Git ${installed} winget\n` };
    }
    if (fail) return { state: 'failed', exitCode: 1, stderr: 'PRIVATE_INSTALL_FAILURE' };
    installed = args[args.indexOf('--version') + 1];
    return { state: 'succeeded', exitCode: 0, stdout: 'PRIVATE_INSTALL_RESULT' };
  };
  return { query, calls };
}

test('WinGet의 정확한 ID·버전·업그레이드 차단과 설치 후 검증을 사용한다', async (t) => {
  const ctx = await fixture(t), mock = wingetRunner();
  const plan = await createPlan(options(ctx, { roles: ['git'], versions: { git: '2.47.0' } }));
  const operation = plan.operations[0];
  assert.equal(operation.type, 'install'); assert.equal(operation.tool, 'Git.Git');
  assert.equal(operation.rollback.automatic, false);
  assert.equal(plan.differences[0].current.updateOwner, 'unknown');
  assert.equal(plan.differences[0].proposed.updateOwner, 'winget');
  const result = await applyPlan(options(ctx, { plan, execute: true, query: mock.query }));
  assert.equal(result.status, 'applied');
  const install = mock.calls.find((call) => call.args[0] === 'install');
  assert.ok(install.args.includes('--no-upgrade')); assert.ok(install.args.includes('--exact'));
  assert.ok(!install.args.includes('--override')); assert.ok(!install.args.includes('--force'));
  assert.equal(mock.calls.length, 3);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_INSTALL_RESULT'));
  const rolledBack = await rollbackPlan(options(ctx, { journal: result.journal, execute: true }));
  assert.equal(rolledBack.status, 'partially_rolled_back');
  const repeated = await rollbackPlan(options(ctx, { journal: result.journal, execute: true }));
  assert.equal(repeated.status, 'partially_rolled_back');
  assert.equal(mock.calls.length, 3);
});

test('이미 설치된 앱은 재설치하거나 업그레이드하지 않고 미확인 조회도 설치하지 않는다', async (t) => {
  for (const installed of ['2.47.0', '2.46.0', '2.48.0', null]) {
    const ctx = await fixture(t), mock = wingetRunner({ installed, unknown: installed === null });
    const plan = await createPlan(options(ctx, { roles: ['git'], versions: { git: '2.47.0' } }));
    const result = await applyPlan(options(ctx, { plan, execute: true, query: mock.query }));
    assert.equal(mock.calls.filter((call) => call.args[0] === 'install').length, 0);
    assert.equal(result.status, installed === '2.47.0' ? 'applied' : 'failed');
    if (installed !== '2.47.0') assert.equal(result.reason, installed ? 'EXISTING_INSTALLATION_PRESERVED' : 'INSTALL_INVENTORY_UNKNOWN');
    assert.equal((await rollbackPlan(options(ctx, { id: result.journal.id, execute: true }))).status, 'rolled_back');
  }
});

test('필수 설치 선택·버전과 공식 .NET SDK 예외를 명확히 구분한다', async (t) => {
  const ctx = await fixture(t, { 'global.json': { sdk: { version: '10.0.100', rollForward: 'disable' } } });
  const plan = await createPlan(options(ctx, { roles: ['dotnet', 'git'], versions: { dotnet: '10.0.100', node: '24.10.0' } }));
  assert.deepEqual(plan.operations.map((item) => [item.type, item.tool]), [['install', 'Microsoft.DotNet.SDK.10']]);
  assert.equal(plan.differences.find((item) => item.role === 'git').reason, 'EXPLICIT_EXACT_VERSION_REQUIRED');
  assert.equal(plan.differences.find((item) => item.role === 'dotnet').proposed.updateOwner, 'Microsoft .NET installer');
  assert.equal(await text(ctx, 'global.json'), JSON.stringify({ sdk: { version: '10.0.100', rollForward: 'disable' } }));
  for (const version of ['latest', '24', '--version', '24.1.0;pwsh', '24.1.0\nwhoami', 'https://x.invalid/tool', '${TOKEN}', '01.2.3']) {
    await assert.rejects(createPlan(options(ctx, { roles: ['node'], versions: { node: version } })), code('EXACT_VERSION_REQUIRED'));
  }
  await assert.rejects(createPlan(options(ctx, { roles: ['execute-anything'] })), code('UNKNOWN_ROLE'));
});

test('예외는 상위 관리자 설치까지 억제하고 다른 프로젝트에는 적용되지 않는다', async (t) => {
  const ctx = await fixture(t), other = await fixture(t);
  const originalPlan = await createPlan(options(ctx, selected));
  await saveException(options(ctx, { role: 'runtime-version-manager', reason: '기존 관리자를 유지합니다.', scope: 'company-policy' }));
  const kept = await createPlan(options(ctx, { roles: ['runtime-version-manager'], versions: { node: '24.10.0', mise: '2026.11.9' } }));
  assert.deepEqual(kept.operations, []);
  await assert.rejects(applyPlan(options(ctx, { plan: originalPlan, execute: true })), code('EXCEPTIONS_CHANGED'));
  assert.deepEqual(await loadExceptions(options(other, { stateDir: ctx.stateDir })), []);
  const different = await createPlan(options(other, { ...selected, stateDir: ctx.stateDir }));
  assert.ok(different.operations.length);
});

test('상위 작업 공간 선언과 CI는 오래된 계획 판정에 포함된다', async (t) => {
  const ctx = await fixture(t);
  await writeFile(path.join(ctx.projectPath, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await mkdir(path.join(ctx.projectPath, 'packages', 'app'), { recursive: true });
  await writeFile(path.join(ctx.projectPath, '.node-version'), '24.10.0\n');
  const nested = { ...ctx, projectPath: path.join(ctx.projectPath, 'packages', 'app') };
  const plan = await createPlan(options(nested, { roles: ['runtime-version-manager'] }));
  assert.ok(plan.inputs.some((entry) => entry.path === path.join(ctx.projectPath, '.node-version')));
  await mkdir(path.join(ctx.projectPath, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(ctx.projectPath, '.github', 'workflows', 'ci.yml'), 'jobs: {}\n');
  await assert.rejects(applyPlan(options(nested, { plan, execute: true })), code('STALE_PLAN'));
});

test('임시 프로필의 새 디렉터리는 도구가 만든 동일한 빈 디렉터리일 때만 제거한다', async (t) => {
  const ctx = await fixture(t), profilePath = path.join(ctx.folder, 'new', 'nested', 'profile.ps1');
  const plan = await createPlan(options(ctx, { roles: ['powershell-profile'], profilePath }));
  const result = await applyPlan(options(ctx, { plan, execute: true }));
  assert.equal(result.status, 'applied');
  await writeFile(path.join(ctx.folder, 'new', 'user.txt'), 'keep');
  const restored = await rollbackPlan(options(ctx, { journal: result.journal, execute: true }));
  assert.equal(restored.status, 'rolled_back');
  await assert.rejects(lstat(path.dirname(profilePath)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(ctx.folder, 'new', 'user.txt'), 'utf8'), 'keep');
});

test('프로필 기존 활성화·편집한 관리 블록과 확장 불가능한 TOML은 보존한다', async (t) => {
  for (const contents of ['mise activate pwsh | Invoke-Expression\n', '# >>> WindowsAgentDevkit mise >>>\n# edited\n# <<< WindowsAgentDevkit mise <<<\n']) {
    const ctx = await fixture(t), profilePath = path.join(ctx.folder, 'profile.ps1');
    await writeFile(profilePath, contents);
    const plan = await createPlan(options(ctx, { roles: ['powershell-profile'], profilePath }));
    assert.deepEqual(plan.operations, []); assert.equal(plan.differences[0].status, 'blocked');
    assert.equal(await readFile(profilePath, 'utf8'), contents);
  }
  const ctx = await fixture(t, { 'mise.toml': 'tools = { python = "3.13.8" }\n' });
  const plan = await createPlan(options(ctx, selected));
  assert.deepEqual(plan.operations, []);
  assert.ok(plan.differences.some((entry) => entry.reason === 'MISE_REQUIRES_MANUAL_EDIT'));
  assert.equal(await text(ctx, 'mise.toml'), 'tools = { python = "3.13.8" }\n');
});

test('파일 심볼릭 링크를 안전하게 거부한다', async (t) => {
  const ctx = await fixture(t), target = path.join(ctx.folder, 'outside.toml');
  await writeFile(target, '[tools]\n');
  const link = path.join(ctx.projectPath, 'mise.toml');
  try { await symlink(target, link); }
  catch (error) { if (error.code === 'EPERM') { t.skip('호스트에 파일 심볼릭 링크 권한이 없습니다.'); return; } throw error; }
  await assert.rejects(createPlan(options(ctx, selected)), code('UNSAFE_FILE'));
  assert.equal(await readFile(target, 'utf8'), '[tools]\n');
});

test('하드링크·지원하지 않는 인코딩과 상태 디렉터리 junction을 거부한다', async (t) => {
  const ctx = await fixture(t), target = path.join(ctx.folder, 'outside.toml'), filename = path.join(ctx.projectPath, 'mise.toml');
  await writeFile(target, '[tools]\n');
  await link(target, filename);
  await assert.rejects(createPlan(options(ctx, selected)), code('UNSAFE_FILE'));
  assert.equal(await readFile(target, 'utf8'), '[tools]\n');
  await unlink(filename);
  await writeFile(filename, Buffer.from([0xff, 0xfe, 0x00, 0x00]));
  const plan = await createPlan(options(ctx, selected));
  assert.deepEqual(plan.operations, []);
  assert.ok(plan.differences.some((entry) => entry.status === 'blocked'));
  await mkdir(path.join(ctx.folder, 'redirected'));
  await symlink(path.join(ctx.folder, 'redirected'), path.join(ctx.folder, 'linked-state'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createPlan(options(ctx, { stateDir: path.join(ctx.folder, 'linked-state') })), code('UNSAFE_PATH'));
});

test('롤백은 적용 후 링크로 바뀐 파일을 보존하며 다른 변경은 복구한다', async (t) => {
  const ctx = await fixture(t), profilePath = path.join(ctx.folder, 'profile.ps1');
  const plan = await createPlan(options(ctx, { ...selected, roles: ['runtime-version-manager', 'powershell-profile'], profilePath }));
  const result = await applyPlan(options(ctx, { plan, execute: true }));
  const target = path.join(ctx.projectPath, 'mise.toml'), relocated = path.join(ctx.folder, 'relocated.toml');
  await rename(target, relocated);
  try { await symlink(relocated, target); }
  catch (error) { if (error.code === 'EPERM') { t.skip('호스트에 파일 심볼릭 링크 권한이 없습니다.'); return; } throw error; }
  const rollback = await rollbackPlan(options(ctx, { id: result.journal.id, execute: true }));
  assert.equal(rollback.status, 'rollback_conflict'); assert.ok((await lstat(target)).isSymbolicLink());
  assert.match(await readFile(relocated, 'utf8'), /24.10.0/);
  await assert.rejects(readFile(profilePath), { code: 'ENOENT' });
});

test('설치 사전 조회 중 입력 변경과 실행기 예외는 안전하게 복구한다', async (t) => {
  const ctx = await fixture(t), mock = miseRunner();
  const plan = await createPlan(options(ctx, { roles: ['node'], versions: { node: '24.10.0' } }));
  const query = async (...args) => {
    await writeFile(path.join(ctx.projectPath, '.node-version'), '22.20.0\n');
    return mock.query(...args);
  };
  const result = await applyPlan(options(ctx, { plan, execute: true, query }));
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'STALE_PLAN');
  assert.ok(mock.calls.every((call) => call.args[0] !== 'install'));
  assert.equal(await text(ctx, '.node-version'), '22.20.0\n');
  await assert.rejects(text(ctx, 'mise.toml'), { code: 'ENOENT' });
  const fresh = await fixture(t);
  const next = await createPlan(options(fresh, { roles: ['node'], versions: { node: '24.10.0' } }));
  const failure = await applyPlan(options(fresh, { plan: next, execute: true, query: () => { throw new Error('SECRET_RUNNER_MESSAGE'); } }));
  assert.equal(failure.reason, 'INSTALL_RUNNER_FAILED');
  assert.ok(!JSON.stringify(failure).includes('SECRET_RUNNER_MESSAGE'));
});

test('백업 손상은 어떤 복구 쓰기보다 먼저 거부한다', async (t) => {
  const ctx = await fixture(t, { 'mise.toml': '# original\n' }), profilePath = path.join(ctx.folder, 'profile.ps1');
  await writeFile(profilePath, '# original profile\n');
  const plan = await createPlan(options(ctx, { ...selected, roles: ['runtime-version-manager', 'powershell-profile'], profilePath }));
  const result = await applyPlan(options(ctx, { plan, execute: true }));
  const written = await text(ctx, 'mise.toml'), profile = await readFile(profilePath, 'utf8');
  await writeFile(path.join(ctx.stateDir, 'backups', result.journal.id, '0.bin'), 'corrupted');
  await assert.rejects(rollbackPlan(options(ctx, { id: result.journal.id, execute: true })), code('BACKUP_CORRUPTED'));
  assert.equal(await text(ctx, 'mise.toml'), written); assert.equal(await readFile(profilePath, 'utf8'), profile);
});

test('중단된 파일 쓰기는 기존 저널로 재개하고 살아 있는 상태 잠금은 우회하지 않는다', async (t) => {
  const ctx = await fixture(t), plan = await createPlan(options(ctx, selected));
  const result = await applyPlan(options(ctx, { plan, execute: true }));
  const journal = JSON.parse(await readFile(result.journalPath, 'utf8'));
  journal.status = 'applying'; journal.entries[0].status = 'writing';
  await writeFile(result.journalPath, JSON.stringify(journal));
  const replay = await applyPlan(options(ctx, { plan, execute: true }));
  assert.equal(replay.status, 'applied'); assert.equal(replay.journal.id, result.journal.id);
  await writeFile(path.join(ctx.stateDir, 'mutation.lock'), JSON.stringify({ pid: process.pid, token: 'active' }));
  await assert.rejects(applyPlan(options(ctx, { plan, execute: true })), code('STATE_BUSY'));
  await unlink(path.join(ctx.stateDir, 'mutation.lock'));
  await writeFile(path.join(ctx.stateDir, 'mutation.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  assert.equal((await applyPlan(options(ctx, { plan, execute: true }))).status, 'already_applied');
});

test('설치 중단 후 같은 버전을 발견해도 공유 설치 제거를 약속하지 않는다', async (t) => {
  const ctx = await fixture(t), mock = miseRunner();
  const plan = await createPlan(options(ctx, { roles: ['node'], versions: { node: '24.10.0' } }));
  const result = await applyPlan(options(ctx, { plan, execute: true, query: mock.query }));
  const journal = JSON.parse(await readFile(result.journalPath, 'utf8'));
  journal.status = 'applying'; journal.entries[1].status = 'running';
  await writeFile(result.journalPath, JSON.stringify(journal));
  const replay = await applyPlan(options(ctx, { plan, execute: true, query: mock.query }));
  assert.equal(replay.status, 'applied');
  assert.equal(mock.calls.filter((call) => call.args[0] === 'install').length, 1);
  assert.equal((await rollbackPlan(options(ctx, { id: result.journal.id, execute: true }))).status, 'partially_rolled_back');
});

test('완료 후 사용자 원복도 반복 적용에서 덮어쓰지 않는다', async (t) => {
  const ctx = await fixture(t), plan = await createPlan(options(ctx, selected));
  await applyPlan(options(ctx, { plan, execute: true }));
  await unlink(path.join(ctx.projectPath, 'mise.toml'));
  await assert.rejects(applyPlan(options(ctx, { plan, execute: true })), code('STALE_PLAN'));
  await assert.rejects(text(ctx, 'mise.toml'), { code: 'ENOENT' });
});

test('Windows Terminal은 역할 선택과 정확한 고정 버전이 모두 있을 때만 설치한다', async (t) => {
  const ctx = await fixture(t), version = '1.23.13503.0';
  const plan = await createPlan(options(ctx, { roles: ['windows-terminal'], versions: { 'windows-terminal': version } }));
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].tool, 'Microsoft.WindowsTerminal');
  assert.equal(plan.operations[0].version, version);
  assert.deepEqual(plan.operations[0].command.args.slice(0, 7), ['install', '--id', 'Microsoft.WindowsTerminal', '--exact', '--version', version, '--source']);
  assert.equal((await createPlan(options(ctx, { roles: ['windows-terminal'] }))).operations.length, 0);
  assert.equal((await createPlan(options(ctx, { versions: { 'windows-terminal': version } }))).operations.length, 0);
  for (const unsupported of ['latest', 'stable', '1.23', '1.23.13503.0 --override cmd']) {
    await assert.rejects(createPlan(options(ctx, { roles: ['windows-terminal'], versions: { 'windows-terminal': unsupported } })), code('EXACT_VERSION_REQUIRED'));
  }
  const calls = []; let present = false;
  const query = async (tool, args, settings) => {
    calls.push({ tool, args, settings });
    if (args[0] === 'list') return present
      ? { state: 'succeeded', exitCode: 0, stdout: `Windows Terminal Microsoft.WindowsTerminal ${version} winget\n` }
      : { state: 'failed', exitCode: 0x8a150014 | 0, stdout: '' };
    assert.equal(settings.execute, true); present = true;
    return { state: 'succeeded', exitCode: 0, stdout: '' };
  };
  const result = await applyPlan(options(ctx, { plan, execute: true, query }));
  assert.equal(result.status, 'applied'); assert.equal(calls.length, 3);
});

test('적용의 해시 검사와 이동 사이 편집은 포착해 보존하고 복구 경로를 공개한다', async (t) => {
  const ctx = await fixture(t, { 'mise.toml': '# original\n' });
  const plan = await createPlan(options(ctx, selected));
  let injected = false;
  const result = await applyPlan(options(ctx, { plan, execute: true, fileHooks: {
    beforeCapture: async ({ path: target, phase }) => {
      if (phase === 'apply') { injected = true; await writeFile(target, '# concurrent edit between hash and rename\n'); }
    },
  } }));
  assert.equal(injected, true); assert.equal(result.status, 'partial'); assert.equal(result.reason, 'CAPTURE_CONFLICT');
  assert.equal(await text(ctx, 'mise.toml'), '# concurrent edit between hash and rename\n');
  assert.equal(result.recoveryPaths.length, 1);
  assert.ok(result.recoveryPaths.every((filename) => !filename.startsWith(ctx.projectPath + path.sep)));
  assert.equal(await readFile(result.recoveryPaths[0], 'utf8'), '# concurrent edit between hash and rename\n');
  assert.equal(result.journal.entries[0].recovery[0].path, result.recoveryPaths[0]);
  assert.equal(result.journal.entries[0].recovery[0].status, 'conflict_retained');
});

test('적용의 포착 후 재생성한 현재 파일과 포착한 원래 파일을 모두 보존한다', async (t) => {
  const ctx = await fixture(t, { 'mise.toml': '# original retained\n' });
  const plan = await createPlan(options(ctx, selected));
  const result = await applyPlan(options(ctx, { plan, execute: true, fileHooks: {
    afterCapture: async ({ path: target, phase }) => { if (phase === 'apply') await writeFile(target, '# concurrent recreated name\n', { flag: 'wx' }); },
  } }));
  assert.equal(result.status, 'partial'); assert.equal(result.reason, 'FILE_CONFLICT');
  assert.equal(await text(ctx, 'mise.toml'), '# concurrent recreated name\n');
  assert.equal(await readFile(result.recoveryPaths[0], 'utf8'), '# original retained\n');
});

test('원래 없던 파일의 롤백에서 해시 검사 후 편집도 삭제하지 않는다', async (t) => {
  const ctx = await fixture(t), plan = await createPlan(options(ctx, selected));
  const applied = await applyPlan(options(ctx, { plan, execute: true }));
  assert.deepEqual(applied.recoveryPaths, []);
  const result = await rollbackPlan(options(ctx, { id: applied.journal.id, execute: true, fileHooks: {
    beforeCapture: async ({ path: target, phase }) => { if (phase === 'rollback') await writeFile(target, '# rollback concurrent edit\n'); },
  } }));
  assert.equal(result.status, 'rollback_conflict');
  assert.equal(await text(ctx, 'mise.toml'), '# rollback concurrent edit\n');
  assert.equal(await readFile(result.recoveryPaths[0], 'utf8'), '# rollback concurrent edit\n');
});

test('롤백의 포착 이후 새 현재 파일이 생겨도 현재 파일과 포착 파일을 모두 유지한다', async (t) => {
  for (const existed of [false, true]) {
    const ctx = await fixture(t, existed ? { 'mise.toml': '# original\n' } : {}), plan = await createPlan(options(ctx, selected));
    const applied = await applyPlan(options(ctx, { plan, execute: true })), written = await text(ctx, 'mise.toml');
    const result = await rollbackPlan(options(ctx, { id: applied.journal.id, execute: true, fileHooks: {
      afterCapture: async ({ path: target, phase }) => { if (phase === 'rollback') await writeFile(target, '# new rollback name\n', { flag: 'wx' }); },
    } }));
    assert.equal(result.status, 'rollback_conflict');
    assert.equal(await text(ctx, 'mise.toml'), '# new rollback name\n');
    const capture = result.journal.entries[0].recovery.find((entry) => entry.phase === 'rollback');
    assert.equal(await readFile(capture.path, 'utf8'), written);
  }
});

test('성공 후에도 이전 열린 핸들의 늦은 쓰기를 포착 파일에 남긴다', async (t) => {
  const ctx = await fixture(t, { 'mise.toml': '# original\n' }), plan = await createPlan(options(ctx, selected));
  let previousHandle;
  let result;
  try {
    result = await applyPlan(options(ctx, { plan, execute: true, fileHooks: {
      beforeCapture: async ({ path: target, phase }) => { if (phase === 'apply') previousHandle = await open(target, 'r+'); },
      afterPublish: async ({ phase }) => {
        if (phase === 'apply') { await previousHandle.truncate(0); await previousHandle.writeFile('# late old-handle edit\n'); await previousHandle.sync(); }
      },
    } }));
  } finally { await previousHandle?.close(); }
  assert.equal(result.status, 'applied');
  assert.match(await text(ctx, 'mise.toml'), /node = "24.10.0"/);
  assert.equal(await readFile(result.recoveryPaths[0], 'utf8'), '# late old-handle edit\n');
  const rolledBack = await rollbackPlan(options(ctx, { id: result.journal.id, execute: true }));
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(await text(ctx, 'mise.toml'), '# original\n');
  assert.equal(await readFile(result.recoveryPaths[0], 'utf8'), '# late old-handle edit\n');
});

test('새 파일의 배타적 게시를 가로챈 같은 내용의 사용자 파일도 자체 변경으로 오인하지 않는다', async (t) => {
  const ctx = await fixture(t), plan = await createPlan(options(ctx, selected));
  const contents = '[tools]\nnode = "24.10.0"\n';
  const result = await applyPlan(options(ctx, { plan, execute: true, fileHooks: {
    beforePublish: async ({ path: target, phase }) => { if (phase === 'apply') await writeFile(target, contents, { flag: 'wx' }); },
  } }));
  assert.equal(result.status, 'partial');
  assert.equal(await text(ctx, 'mise.toml'), contents); assert.deepEqual(result.recoveryPaths, []);
});

test('이름을 포착한 뒤 중단된 적용은 기존 저널과 보관 파일로 재개한다', async (t) => {
  const ctx = await fixture(t, { 'mise.toml': '# original\n' }), plan = await createPlan(options(ctx, selected));
  const applied = await applyPlan(options(ctx, { plan, execute: true }));
  const journal = JSON.parse(await readFile(applied.journalPath, 'utf8'));
  journal.status = 'applying'; journal.entries[0].status = 'writing'; journal.entries[0].captures[0].status = 'verified';
  await unlink(path.join(ctx.projectPath, 'mise.toml'));
  await writeFile(applied.journalPath, JSON.stringify(journal));
  const replay = await applyPlan(options(ctx, { plan, execute: true }));
  assert.equal(replay.status, 'applied'); assert.equal(replay.journal.id, applied.journal.id);
  assert.equal(replay.recoveryPaths.length, 2);
  assert.match(await text(ctx, 'mise.toml'), /24.10.0/);
  assert.equal(await readFile(applied.recoveryPaths[0], 'utf8'), '# original\n');
});

test('기본 CLI 상태는 제품 루트의 기존 desktop-state와 분리한 state 하위 폴더다', async (t) => {
  const ctx = await fixture(t), originalLocalAppData = process.env.LOCALAPPDATA;
  const product = path.join(ctx.folder, 'WindowsAgentDevkit');
  await mkdir(path.join(product, 'desktop-state'), { recursive: true });
  await writeFile(path.join(product, 'desktop-state', 'existing.json'), '{"keep":true}\n');
  try {
    process.env.LOCALAPPDATA = ctx.folder;
    const plan = await createPlan({ projectPath: ctx.projectPath, ...selected });
    const applied = await applyPlan({ projectPath: ctx.projectPath, plan, execute: true });
    assert.equal(applied.status, 'applied');
    assert.ok(applied.journalPath.startsWith(path.join(product, 'state', 'journals') + path.sep));
    assert.equal(await readFile(path.join(product, 'desktop-state', 'existing.json'), 'utf8'), '{"keep":true}\n');
    assert.equal(await lstat(path.join(product, 'state', 'owner.json')).then((info) => info.isFile()), true);
  } finally {
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
  }
});
