import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
