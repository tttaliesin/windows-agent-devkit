import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnose, P0_IDS, P1_IDS } from '../src/doctor.mjs';
import { summarizeTaskRunners, collectTaskRunnerTools } from '../src/task-runner-checks.mjs';
import { formatReport, main } from '../src/cli.mjs';

const SECRET = 'TASK_RUNNER_PRIVATE_OUTPUT';
const outputs = { mise: 'mise 2026.11.9 windows-x64', task: 'Task version: v3.54.0', just: 'just 1.52.0', make: 'GNU Make 4.4.1' };

test('CI의 mise 실행만으로 로컬 작업 채택이나 권장 차이를 확정하지 않는다', () => {
  const summary = summarizeTaskRunners({ metadata: { taskRunners: [], taskRunnerCI: [{ tool: 'mise', source: '.github/workflows/test.yml', state: 'declared', task: 'check' }] } });
  assert.deepEqual(summary.recommendation.observed, ['mise']);
  assert.equal(summary.recommendation.status, 'unknown');
  assert.equal(summary.recommendation.reason, 'mise_task_scope_unverified');
  const empty = summarizeTaskRunners({ metadata: { taskRunners: [{ tool: 'mise', state: 'declared', tasks: [] }] } });
  assert.equal(empty.recommendation.status, 'unknown');
});

async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'windows-agent-task-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const host = { context: { platform: 'win32', cwd: root, processArchitecture: 'x64', os: { name: 'Microsoft Windows 11 Pro', build: '26300' }, diagnosticShell: { name: 'pwsh', version: '7.6.9', profileApplied: false } }, commands: {}, probes: {} };
  const calls = [];
  const query = async (tool, args, options = {}) => {
    calls.push({ tool, args, options });
    return outputs[tool] && args.length === 1 && args[0] === '--version'
      ? { state: 'succeeded', exitCode: 0, executable: `C:/tools/${tool}.exe`, stdout: `${outputs[tool]}\n${SECRET}`, stderr: SECRET }
      : { state: 'not_found', exitCode: null, stdout: '', stderr: '' };
  };
  return { root, host, calls, query, options: { projectPath: root, stateDir: path.join(root, '.state'), now: '2026-11-17T00:00:00Z', inspect: async () => host, query } };
}

test('mise 작업 채택과 실행 성공을 분리하고 기존 실행기의 보존안을 제안한다', () => {
  for (const tool of ['task', 'just', 'make', 'npm']) {
    const summary = summarizeTaskRunners({ metadata: { taskRunners: [{ tool, source: 'fixture', state: 'declared', tasks: ['test'], notes: [] }] } });
    assert.equal(summary.recommended, 'mise');
    assert.equal(summary.recommendation.status, 'different');
    assert.ok(summary.proposal.preserve.includes('CI와 배포 경로'));
    assert.ok(summary.proposal.preserve.includes('기존 작업 정의와 빌드·테스트 명령'));
    assert.deepEqual(summary.tools, []);
  }
  const summary = summarizeTaskRunners({ metadata: { taskRunners: [{ tool: 'mise', source: 'mise.toml', state: 'declared', tasks: ['test'], notes: [] }] } });
  assert.equal(summary.recommendation.status, 'aligned');
  assert.equal(summarizeTaskRunners({ metadata: { taskRunners: [{ ...summary.declarations[0], state: 'unknown' }] } }).recommendation.status, 'unknown');
});

test('doctor가 실제 작업 파일을 탐지하고 버전만 조회하며 30개 계약과 소스를 보존한다', async (t) => {
  const source = 'version: "3"\ntasks:\n  check:\n    cmds:\n      - node marker.mjs\n';
  const f = await fixture(t, { 'Taskfile.yml': source, 'marker.mjs': 'throw new Error("must not execute");' });
  const report = await diagnose(f.options);
  assert.deepEqual(report.checks.map((item) => item.checkId), [...P0_IDS, ...P1_IDS]);
  assert.equal(report.taskRunners.recommendation.status, 'different');
  assert.deepEqual(report.taskRunners.declarations.find((item) => item.tool === 'task')?.tasks, ['check']);
  assert.equal(report.taskRunners.tools.find((item) => item.tool === 'task')?.version, '3.54.0');
  assert.equal(report.taskRunners.tools[0].projectTaskExecution, 'not_run');
  assert.ok(f.calls.filter((item) => Object.hasOwn(outputs, item.tool)).every((item) => item.args.length === 1 && item.args[0] === '--version' && item.options.execute !== true));
  assert.equal(report.task, null);
  assert.equal(await readFile(path.join(f.root, 'Taskfile.yml'), 'utf8'), source);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  const text = formatReport(report);
  assert.match(text, /작업 실행기 권장: mise tasks/);
  assert.match(text, /Taskfile.yml/);
  assert.match(text, /3\.54\.0/);
  assert.ok(!text.includes(SECRET));
});

test('동적 Taskfile 분석을 통과나 강제 전환으로 보고하지 않는다', async (t) => {
  const f = await fixture(t, { 'Taskfile.yml': 'version: "3"\nincludes:\n  shared: https://example.invalid/Taskfile.yml\ntasks:\n  check:\n    cmds: [echo check]\n' });
  const report = await diagnose(f.options);
  assert.equal(report.taskRunners.recommendation.status, 'unknown');
  assert.equal(report.checks.find((item) => item.checkId === 'REQ-01').status, 'unknown');
  assert.ok(f.calls.every((item) => item.options.execute !== true));
});

test('선언된 Make를 Windows 필수 설치로 단정하지 않고 명시 선택 실패와 구분한다', async (t) => {
  const f = await fixture(t, { Makefile: '.PHONY: check\ncheck:\n\t@echo check\n' });
  const query = async () => ({ state: 'not_found', stdout: '', stderr: '', exitCode: null });
  const report = await diagnose({ ...f.options, query });
  assert.equal(report.taskRunners.tools.find((item) => item.tool === 'make')?.resolution, 'not_resolved');
  assert.equal(report.checks.find((item) => item.checkId === 'PATH-01').status, 'warn');
  const selected = await diagnose({ ...f.options, query, task: { context: 'native', trusted: true, tool: 'make', args: ['check'] }, execute: true });
  assert.equal(selected.task.status, 'fail');
  assert.equal(selected.checks.find((item) => item.checkId === 'PATH-01').status, 'fail');
});

test('지원하지 않는 버전 출력과 조회 실패를 성공한 실행기로 바꾸지 않는다', async () => {
  for (const response of [{ state: 'succeeded', exitCode: 0, stdout: SECRET }, { state: 'failed', exitCode: 1, stdout: outputs.just }, { state: 'timed_out', exitCode: null }]) {
    const tools = await collectTaskRunnerTools({ summary: { declarations: [{ tool: 'just' }], ci: [] }, host: { commands: {} }, query: async () => response });
    assert.equal(tools[0].status, 'unknown');
    assert.equal(tools[0].version, null);
    assert.ok(!JSON.stringify(tools).includes(SECRET));
  }
});

test('명시한 작업을 실행하지 못한 validate는 CLI 성공 코드로 자동화를 통과시키지 않는다', async (t) => {
  const f = await fixture(t, { 'package.json': '{"scripts":{"check":"node --test"}}' });
  const selected = path.join(f.root, 'task.json');
  await writeFile(selected, JSON.stringify({ context: 'native', trusted: true, tool: 'npm', args: ['run', 'check'] }));
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = (data) => { output += data; return true; };
  try {
    const code = await main(['validate', '--project', f.root, '--task-file', selected, '--execute', '--format', 'json', '--state-dir', path.join(f.root, '.state')], {
      inspect: async () => f.host, query: async () => ({ state: 'not_run', stdout: '', stderr: '', exitCode: null }),
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(output).task.status, 'unknown');
    assert.equal(JSON.parse(output).task.execution, 'not_run');
  } finally { process.stdout.write = original; }
});
