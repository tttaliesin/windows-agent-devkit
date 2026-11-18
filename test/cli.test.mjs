import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lstat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions, formatReport } from '../src/cli.mjs';

test('프로젝트 경로를 코드로 보간하지 않고 옵션 데이터로 유지한다', () => {
  const options = parseOptions(['--project', 'a path; Write-Output sample', '--format', 'json', '--languages', 'node,python', '--wsl']);
  assert.ok(options.projectPath.endsWith('a path; Write-Output sample'));
  assert.deepEqual(options.languages, ['node', 'python']);
  assert.equal(options.wsl, true);
});

test('지원하지 않는 언어·형식·제한 시간과 임의 위치 인수를 거부한다', () => {
  for (const args of [['--languages', 'ruby'], ['--format', 'yaml'], ['--timeout-ms', '5s'], ['--timeout-ms', '0'], ['--timeout-ms', '30001'], ['arbitrary']]) assert.throws(() => parseOptions(args));
});

test('WSL 등록 옵션은 등록 명령 범위 안에서만 사용하고 중복 지정을 거부한다', () => {
  const options = parseOptions(['wsl-register', '--task-name', 'check', '--project', 'project',
    '--distro', 'Ubuntu-24.04', '--linux-cwd', '/home/example/project', '--task-file', 'wsl-task.json']);
  assert.equal(options.action, 'wsl-register');
  assert.equal(options.name, 'check');
  assert.equal(options.linuxCwd, '/home/example/project');
  assert.equal(options.execute, false);
  const invalid = [
    ['wsl-register', '--task-name', 'one', '--task-name', 'two'],
    ['wsl-register', '--confirm', 'example'],
    ['wsl-register', '--state-dir', 'project'],
    ['wsl-tasks', '--execute'],
    ['wsl-unregister', '--task-file', 'wsl-task.json'],
    ['validate', '--confirm', 'example'],
  ];
  for (const args of invalid) assert.throws(() => parseOptions(args), args.join(' '));
});

test('WSL 등록 미리보기는 실제 CLI에서 작업 정의를 확인하고 실행 파일과 규칙을 만들지 않는다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'windows-agent-wsl-preview-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const taskPath = join(root, 'task.json');
  const args = ['--noprofile', '--norc', './scripts/check-registration-only-arg.sh'];
  await writeFile(taskPath, JSON.stringify({ context: 'wsl', trusted: true, tool: '/usr/bin/bash', args }));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const run = promisify(execFile);
  const selection = [cli, 'wsl-register', '--project', root, '--task-name', 'check', '--distro', 'Ubuntu-24.04',
    '--linux-cwd', '/home/example/project', '--task-file', taskPath];
  const preview = await run(process.execPath, selection);
  assert.match(JSON.parse(preview.stdout).confirmation, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(preview.stdout, /check-registration-only-arg/);
  await assert.rejects(run(process.execPath, [...selection, '--execute', '--confirm', '0'.repeat(64)]),
    (error) => error.code === 2);
  await assert.rejects(run(process.execPath, [cli, 'wsl-unregister', '--project', root, '--task-name', 'check']),
    (error) => error.code === 2);
  await assert.rejects(lstat(join(root, '.codex')), { code: 'ENOENT' });
});

test('도움말은 호스트 조회 없이 실행하고 잘못된 옵션은 종료 코드 2를 반환한다', async () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const run = promisify(execFile);
  const help = await run(process.execPath, [cli, '--help']);
  assert.match(help.stdout, /설치·다운로드·프로필 변경·서비스 기동/);
  await assert.rejects(run(process.execPath, [cli, '--format', 'invalid']), (error) => error.code === 2 && /진단을 완료하지 못했습니다/.test(error.stderr));
});

test('한국어 텍스트는 미확인과 요구 위반을 구분한다', () => {
  const text = formatReport({ pluginVersion: '0.1.0', project: { root: 'C:/example' }, context: { platform: 'win32' }, checks: [{ checkId: 'NODE-01', status: 'unknown', message: '조회 보류' }, { checkId: 'PY-01', status: 'fail', message: '요구 위반' }], summary: { pass: 0, fail: 1, warn: 0, unknown: 1, skipped: 0 } });
  assert.match(text, /\[미확인\] NODE-01/);
  assert.match(text, /\[요구 위반\] PY-01/);
});

test('텍스트 보고서에서 버전 위반의 선언 근거와 다음 조치를 읽을 수 있다', () => {
  const text = formatReport({
    pluginVersion: '0.3.1', project: { root: 'C:/example' }, context: { platform: 'win32' },
    checks: [{
      checkId: 'NODE-01', status: 'fail', message: '관찰한 버전이 요구 범위를 벗어납니다.', observed: '26.1.0',
      requirement: [{ source: 'package.json', field: 'engines.node', kind: 'range', value: '>=24 <25' }],
      nextAction: '프로젝트가 지정한 버전을 선택합니다.',
    }],
    summary: { pass: 0, fail: 1, warn: 0, unknown: 0, skipped: 0 },
  });
  assert.match(text, /관찰: 26\.1\.0/);
  assert.match(text, /요구: >=24 <25 \(package\.json \/ engines\.node\)/);
  assert.match(text, /다음 조치: 프로젝트가 지정한 버전을 선택합니다\./);
});

test('잘못된 작업 JSON의 값과 원문은 CLI 오류에 공개하지 않는다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'windows-agent-invalid-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'task.json'), secret = 'PRIVATE_TASK_ENV_VALUE';
  await writeFile(file, `{"env":{"TOKEN":${secret}}}`);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'validate', '--project', root, '--task-file', file]), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /JSON 파일의 구문/);
    assert.ok(!error.stderr.includes(secret));
    assert.ok(!error.stdout.includes(secret));
    return true;
  });
});
