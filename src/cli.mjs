#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { diagnose, VERSION } from './doctor.mjs';

const LANGUAGES = ['node', 'python', 'go', 'rust', 'zig', 'dotnet'];
const STATUS_LABELS = { pass: '통과', fail: '요구 위반', warn: '검토', unknown: '미확인', skipped: '생략' };

export const HELP = `Windows Agent Devkit ${VERSION}

사용법: node src/cli.mjs [옵션]

  --project <경로>          점검할 프로젝트 디렉터리, 기본값은 현재 경로
  --format <text|json>      출력 형식, 기본값은 text
  --languages <목록>       auto 또는 node,python,go,rust,zig,dotnet의 쉼표 목록
  --native                 컨테이너 선언이 있어도 호스트 언어 도구 점검을 명시
  --wsl                    WSL 호스트 메타데이터 점검 요청
  --containers             Docker 클라이언트와 Lazydocker 점검 요청
  --process-compose        Process Compose 메타데이터 점검 요청
  --timeout-ms <정수>      조회별 제한 시간, 기본값 5000, 범위 100..30000
  --output <파일>          요청한 파일에 저장, 기존 파일은 덮어쓰지 않음
  --help                   이 도움말 표시
  --version                진단 CLI 버전 표시

프로젝트의 선언 파일을 먼저 읽고 필요한 언어만 조회합니다.
설치·다운로드·프로필 변경·서비스 기동은 수행하지 않습니다.
unknown은 확인되지 않았다는 뜻이며 전체 환경의 정상 동작을 보장하지 않습니다.
종료 코드: 0=보고서 생성 및 확인한 요구 위반 없음, 1=요구 위반, 2=실행 오류
`;

export function parseOptions(args) {
  const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
    project: { type: 'string' }, format: { type: 'string', default: 'text' },
    languages: { type: 'string', default: 'auto' }, wsl: { type: 'boolean', default: false },
    containers: { type: 'boolean', default: false }, 'process-compose': { type: 'boolean', default: false }, native: { type: 'boolean', default: false },
    'timeout-ms': { type: 'string', default: '5000' }, output: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  } });
  if (!['text', 'json'].includes(values.format)) throw new Error('--format은 text 또는 json이어야 합니다.');
  const languages = values.languages === 'auto' ? [] : [...new Set(values.languages.split(',').map((item) => item.trim()))];
  if (languages.some((language) => !LANGUAGES.includes(language))) throw new Error('--languages에 지원하지 않는 계열이 있습니다.');
  if (!/^\d+$/.test(values['timeout-ms'])) throw new Error('--timeout-ms는 정수여야 합니다.');
  const timeoutMs = Number(values['timeout-ms']);
  if (timeoutMs < 100 || timeoutMs > 30000) throw new Error('--timeout-ms는 100..30000 범위여야 합니다.');
  return { projectPath: resolve(values.project ?? process.cwd()), format: values.format, languages, wsl: values.wsl, containers: values.containers, processCompose: values['process-compose'], native: values.native, timeoutMs, output: values.output ? resolve(values.output) : null, help: values.help, version: values.version };
}

export function formatReport(report) {
  const lines = [`Windows Agent Devkit ${report.pluginVersion}`, `프로젝트: ${report.project.root}`, `실행 환경: ${report.context.platform}, ${report.context.diagnosticShell?.name ?? '미확인'} ${report.context.diagnosticShell?.version ?? ''}`, ''];
  for (const check of report.checks) {
    lines.push(`[${STATUS_LABELS[check.status]}] ${check.checkId}: ${check.message}`);
    if (check.resolvedPath) lines.push(`  경로: ${check.resolvedPath}`);
    if (typeof check.observed === 'string') lines.push(`  관찰: ${check.observed}`);
  }
  lines.push('', `결과: 통과 ${report.summary.pass}, 요구 위반 ${report.summary.fail}, 검토 ${report.summary.warn}, 미확인 ${report.summary.unknown}, 생략 ${report.summary.skipped}`, '공식 지원·전체 빌드·테스트·앱의 플러그인 로딩은 별도 검증이 필요합니다.');
  return lines.join('\n');
}

export async function main(args, { inspect } = {}) {
  const options = parseOptions(args);
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  const report = await diagnose({ ...options, inspect });
  const output = options.format === 'json' ? JSON.stringify(report, null, 2) : formatReport(report);
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${output}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(`${output}\n`);
  return report.summary.fail ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    const message = error.code === 'EEXIST' ? '지정한 보고서 파일이 이미 존재합니다. 새 경로를 선택하세요.' : error.message;
    process.stderr.write(`진단을 완료하지 못했습니다: ${message}\n`);
    process.exitCode = 2;
  }
}
