import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { stringify as yaml } from 'yaml';

if (process.platform !== 'win32') throw new Error('Windows 호스트 검증입니다.');
const { values } = parseArgs({ options: { 'process-compose-executable': { type: 'string' }, output: { type: 'string' } } });
const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const run = promisify(execFile), base = await mkdtemp(join(tmpdir(), 'windows-agent-devkit-smoke-'));
const project = join(base, 'project'), state = join(base, 'state'), profile = join(base, 'profile', 'Microsoft.PowerShell_profile.ps1');
const env = { ...process.env };
if (values['process-compose-executable']) env.PATH = `${dirname(resolve(values['process-compose-executable']))}${delimiter}${process.env.PATH}`;
const results = {};
let succeeded = false;
async function command(args, expected = 0) {
  let stdout, code = 0;
  try { ({ stdout } = await run(process.execPath, [cli, '--project', project, '--state-dir', state, '--format', 'json', ...args], { cwd: project, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 })); }
  catch (error) { stdout = error.stdout; code = error.code; }
  assert.equal(code, expected, `CLI 종료 코드: ${args[0] ?? 'doctor'}`);
  return JSON.parse(stdout);
}
// Place the action before its options; command() accepts an options-first doctor only.
async function action(name, args = [], expected = 0) {
  let stdout, code = 0;
  try { ({ stdout } = await run(process.execPath, [cli, name, '--project', project, '--state-dir', state, '--format', 'json', ...args], { cwd: project, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 })); }
  catch (error) { stdout = error.stdout; code = error.code; }
  if (code !== expected && stdout) {
    try { const report = JSON.parse(stdout); results.failure = { action: name, checks: report.checks?.filter((c) => c.status === 'fail' || c.checkId === 'PC-02'), status: report.status }; } catch {}
  }
  assert.equal(code, expected, `CLI 종료 코드: ${name}`);
  return JSON.parse(stdout);
}
try {
  await mkdir(project); await mkdir(dirname(profile));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'devkit-owned-smoke', private: true, engines: { node: '>=24' }, scripts: { smoke: 'node task.mjs' } }));
  await writeFile(join(project, '.npmrc'), '//example.invalid/:_authToken=SMOKE_ONLY_SENTINEL\n');
  const original = '# Existing profile\r\n$env:DEVKIT_SMOKE = "kept"\r\n';
  await writeFile(profile, original);
  await writeFile(join(project, 'task.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('task-ran.txt','owned task'); console.log('SMOKE_ONLY_SENTINEL');\n");
  await writeFile(join(project, 'task.json'), JSON.stringify({ context: 'native', trusted: true, tool: 'npm', args: ['run', 'smoke'] }));
  const initial = await command([]);
  assert.equal(initial.checks.length, 30); assert.equal(new Set(initial.checks.map((c) => c.checkId)).size, 30);
  assert.ok(!JSON.stringify(initial).includes('SMOKE_ONLY_SENTINEL'));
  const planFile = join(base, 'reviewed-plan.json');
  const plan = await action('plan', ['--roles', 'runtime-version-manager,powershell-profile', '--versions', `node=${process.versions.node}`, '--profile', profile, '--output', planFile]);
  assert.ok(plan.operations.some((i) => i.type === 'write-mise')); assert.ok(plan.operations.some((i) => i.type === 'write-profile')); assert.ok(!plan.operations.some((i) => i.type === 'install'));
  assert.ok(!JSON.stringify(plan).includes('SMOKE_ONLY_SENTINEL'));
  const preview = await action('apply', ['--plan', planFile]); assert.equal(preview.executed, false);
  assert.equal(await readFile(profile, 'utf8'), original);
  const applied = await action('apply', ['--plan', planFile, '--execute']); assert.equal(applied.status, 'applied');
  const repeated = await action('apply', ['--plan', planFile, '--execute']); assert.equal(repeated.status, 'already_applied');
  const rolled = await action('rollback', ['--journal', applied.journal.id, '--execute']); assert.equal(rolled.status, 'rolled_back');
  assert.equal(await readFile(profile, 'utf8'), original);
  results.configuration = { plan: true, preview: true, apply: true, idempotent: true, rollback: true, sentinelNotDisclosed: true };
  const task = await action('validate', ['--execute', '--task-file', join(project, 'task.json')]);
  assert.equal(task.task.status, 'pass'); assert.equal(await readFile(join(project, 'task-ran.txt'), 'utf8'), 'owned task');
  assert.equal(task.task.cleanup?.confirmed, true);
  assert.equal(task.task.cleanup.proof, 'windows_job_empty');
  assert.ok(!JSON.stringify(task).includes('SMOKE_ONLY_SENTINEL'));
  results.projectTask = { tool: 'npm', status: task.task.status, cleanup: task.task.cleanup, rawOutputNotDisclosed: true };
  let installedSdks;
  try {
    const inventory = await run('dotnet.exe', ['--list-sdks'], { cwd: project, env, timeout: 15000, maxBuffer: 256 * 1024 });
    installedSdks = [...inventory.stdout.matchAll(/^(\d+\.\d+\.\d+) \[/gm)].map((match) => match[1]);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installedSdks?.length) {
    const sdk = installedSdks.at(-1);
    await writeFile(join(project, 'global.json'), JSON.stringify({ sdk: { version: sdk, rollForward: 'disable', allowPrerelease: false } }));
    const report = await command(['--native']);
    const checked = report.checks.find((check) => check.checkId === 'DOTNET-01');
    assert.equal(checked.compatibility, 'satisfied');
    assert.equal(checked.observed.selectedSdk, sdk);
    results.dotnet = { status: 'pass', sdk, sdkSelection: checked.observed.sdkSelection.state, patchCurrency: checked.support.patchCurrency };
  } else results.dotnet = { status: 'skipped', reason: 'native_sdk_not_resolved' };
  await action('exception', ['--role', 'runtime-version-manager', '--reason', '통제된 검증의 기존 도구 유지', '--execute']);
  const withException = await command([]); assert.equal(withException.exceptions[0].role, 'runtime-version-manager');
  results.exception = { saved: true, includedInDoctor: true };
  if (values['process-compose-executable']) {
    await writeFile(join(project, 'service.mjs'), "console.log('DEVKIT_READY'); setInterval(()=>{},1000);\n");
    const shell = process.env.PSHOME ? join(process.env.PSHOME, 'pwsh.exe') : 'pwsh';
    // ShellArgument is one argv element in Process Compose, not a list of flags.
    const service = { version: '0.5', shell: { shell_command: shell.replaceAll('\\', '/'), shell_argument: '-Command' }, processes: { smoke: { command: `& '${process.execPath.replaceAll('\\', '/').replaceAll("'", "''")}' service.mjs`, ready_log_line: 'DEVKIT_READY' } } };
    await writeFile(join(project, 'process-compose.yaml'), yaml(service));
    const report = await action('validate', ['--execute', '--service-config', 'process-compose.yaml', '--services', 'smoke', '--timeout-ms', '15000']);
    const check = report.checks.find((c) => c.checkId === 'PC-02');
    results.processCompose = check;
    assert.equal(check.status, 'pass', JSON.stringify(check));
  } else results.processCompose = { status: 'skipped', reason: 'verified_binary_not_selected' };
  succeeded = true;
} finally {
  if (succeeded) {
    const actual = await realpath(base), parent = await realpath(tmpdir()), child = relative(parent, actual);
    if (!isAbsolute(child) && child.startsWith('windows-agent-devkit-smoke-') && !child.includes('..') && !child.includes('/') && !child.includes('\\')) await rm(actual, { recursive: true, force: true });
  } else results.recoveryDirectory = base;
  if (values.output) await writeFile(resolve(values.output), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
