#!/usr/bin/env node
import { mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { diagnose, VERSION } from './doctor.mjs';
import { createPlan, applyPlan, rollbackPlan, saveException } from './configure.mjs';
import { createQuery } from './query.mjs';
import { VALIDATION_CHECK_IDS } from './validation.mjs';

const LANGUAGES = ['node', 'python', 'go', 'rust', 'zig', 'dotnet'];
const ACTIONS = ['doctor', 'plan', 'apply', 'rollback', 'exception', 'validate'];
const TASK_CONTEXTS = ['native', 'rust', 'wsl'];
const STATUS_LABELS = { pass: '통과', fail: '요구 위반', warn: '검토', unknown: '미확인', skipped: '생략' };
export const HELP = `Windows Agent Devkit ${VERSION}

사용법: node dist/cli.mjs [doctor|plan|apply|rollback|exception|validate] [옵션]

  --project <경로>          프로젝트 디렉터리, 기본값 현재 경로
  --format <text|json>      출력 형식, 기본값 text
  --languages <목록>       auto 또는 node,python,go,rust,zig,dotnet 쉼표 목록
  --native                 호스트의 언어 도구 요구를 명시
  --wsl / --containers / --process-compose   해당 도구 점검 선택
  --app                    앱과 공유하는 플러그인 설치 목록 조회
  --codex-executable <경로> 검증할 Codex 네이티브 실행 파일
  --ide                    VS Code와 네이티브 빌드 도구 점검 선택
  --storage <경로>          대상 볼륨·Dev Drive 메타데이터 조회
  --github-auth            GitHub CLI 원격 인증 조회 선택
  --timeout-ms <정수>      조회별 제한 시간, 기본값 5000, 범위 100..30000
  --output <파일>          출력 저장, 기존 파일은 덮어쓰지 않음

설정 계획과 복구:
  plan --roles <쉼표 목록> --versions <역할=고정버전,...>
  --profile <경로>         mise 활성화를 넣을 PowerShell 프로필 명시
  --state-dir <경로>       저장소 밖의 개인 상태 디렉터리
  apply --plan <JSON 파일> --execute
  rollback --journal <저널 ID> --execute
  exception --role <역할> --reason <유지 사유> --scope <project> --execute

실행 검증 대상:
  validate --execute --distro <배포판> --linux-cwd <Linux 절대 경로>
  --linux-tools <쉼표 목록> 배포판에서 확인할 Linux 도구의 범위
  validate --execute --docker-context <이름> [--image <기존 이미지>]
  --image-readiness <exit|running|healthy>  컨테이너 준비 판정 방식
  --compose-file <경로> --services <쉼표 목록>  격리 Compose 검증
  --service-config <경로> --services <쉼표 목록>  Process Compose 검증
  --rust-targets <쉼표 목록>  실행할 Rust 링크 검사의 target 선택
  --task-file <JSON 파일>   신뢰한 작업의 context·tool·args·trusted·cwd?·env?
                          Go Task의 Taskfile을 받는 옵션이 아닙니다.

  --help / -h              도움말
  --version                CLI 버전

기본 doctor는 설치·다운로드·프로필 변경·서비스 기동을 수행하지 않습니다.
plan은 개인 상태 디렉터리에 계획을 저장합니다.
apply·rollback·exception·실행 검증에는 --execute가 필요합니다.
unknown은 확인되지 않았다는 뜻입니다.
종료 코드: 0=성공, 1=보고된 실패·적용 충돌·선택한 실행 미완료, 2=입력·실행 오류
`;

function list(value) { return value ? [...new Set(value.split(',').map((i) => i.trim()))] : []; }
export function parseOptions(args) {
  const tokens = [...args];
  const action = tokens[0] && !tokens[0].startsWith('-') ? tokens.shift() : 'doctor';
  if (!ACTIONS.includes(action)) throw new Error('지원하지 않는 명령입니다.');
  const strings = ['project', 'languages', 'timeout-ms', 'output', 'roles', 'versions', 'profile', 'state-dir', 'plan', 'journal', 'role', 'reason', 'scope', 'distro', 'linux-cwd', 'linux-tools', 'docker-context', 'image', 'image-readiness', 'compose-file', 'service-config', 'services', 'rust-targets', 'task-file', 'storage', 'codex-executable'];
  const booleans = ['wsl', 'containers', 'process-compose', 'native', 'execute', 'app', 'ide', 'github-auth', 'version'];
  const schema = Object.fromEntries([...strings.map((key) => [key, { type: 'string' }]), ...booleans.map((key) => [key, { type: 'boolean', default: false }])]);
  schema.format = { type: 'string', default: 'text' }; schema.help = { type: 'boolean', short: 'h' };
  const { values: v } = parseArgs({ args: tokens, allowPositionals: false, strict: true, options: schema });
  if (!['text', 'json'].includes(v.format)) throw new Error('--format은 text 또는 json이어야 합니다.');
  const languages = !v.languages || v.languages === 'auto' ? [] : list(v.languages);
  if (languages.some((i) => !LANGUAGES.includes(i))) throw new Error('--languages에 지원하지 않는 계열이 있습니다.');
  const timeout = v['timeout-ms'] ?? '5000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 100 || Number(timeout) > 30000) throw new Error('--timeout-ms는 100..30000 범위의 정수여야 합니다.');
  const versions = {};
  for (const item of list(v.versions)) {
    const match = /^([a-z][a-z0-9-]*)=(\d[^=]*)$/.exec(item);
    if (!match || Object.hasOwn(versions, match[1])) throw new Error('--versions는 역할=고정버전의 쉼표 목록이어야 합니다.');
    versions[match[1]] = match[2];
  }
  if (v.execute && action === 'doctor') throw new Error('코드·서비스 실행에는 validate 명령을 사용하세요.');
  if (v['image-readiness'] && !['exit', 'running', 'healthy'].includes(v['image-readiness'])) throw new Error('--image-readiness는 exit, running, healthy 중 하나여야 합니다.');
  const file = (key) => v[key] === undefined ? undefined : resolve(v[key]);
  return { action, projectPath: resolve(v.project ?? process.cwd()), format: v.format, languages, wsl: v.wsl, containers: v.containers, processCompose: v['process-compose'], native: v.native, timeoutMs: Number(timeout), output: file('output') ?? null, help: v.help, version: v.version, execute: v.execute, roles: list(v.roles), versions, profilePath: file('profile'), stateDir: file('state-dir'), planFile: file('plan'), journal: v.journal, role: v.role, reason: v.reason, scope: v.scope ?? 'project', distro: v.distro, linuxCwd: v['linux-cwd'], linuxTools: v['linux-tools'] ? list(v['linux-tools']) : undefined, dockerContext: v['docker-context'], image: v.image, imageReadiness: v['image-readiness'], composeFile: v['compose-file'], serviceConfig: v['service-config'], services: v.services ? list(v.services) : undefined, rustTargets: v['rust-targets'] ? list(v['rust-targets']) : undefined, taskFile: file('task-file'), app: v.app, ide: v.ide, storage: file('storage'), githubAuth: v['github-auth'], codexExecutable: file('codex-executable') };
}

export function formatReport(report) {
  const lines = [`Windows Agent Devkit ${report.pluginVersion}`, `프로젝트: ${report.project.root}`, `실행 환경: ${report.context.platform}, ${report.context.diagnosticShell?.name ?? '미확인'} ${report.context.diagnosticShell?.version ?? ''}`, ''];
  for (const check of report.checks) {
    lines.push(`[${STATUS_LABELS[check.status]}] ${check.checkId}: ${check.message}`);
    if (check.resolvedPath) lines.push(`  경로: ${check.resolvedPath}`);
    if (typeof check.observed === 'string') lines.push(`  관찰: ${check.observed}`);
    if (check.support?.status && check.support.status !== 'unknown') lines.push(`  공식 지원 계열: ${check.support.status} (${check.support.checkedOn})`);
    const selectedValidation = check.applicability === 'required' && VALIDATION_CHECK_IDS.includes(check.checkId);
    if (check.status === 'fail' || check.status === 'warn' || selectedValidation && check.status === 'unknown') {
      for (const requirement of Array.isArray(check.requirement) ? check.requirement : []) {
        if (typeof requirement.value !== 'string') continue;
        const declaration = [requirement.source, requirement.field].filter(Boolean).join(' / ');
        lines.push(`  요구: ${requirement.value}${declaration ? ` (${declaration})` : ''}`);
      }
      if (check.nextAction) lines.push(`  다음 조치: ${check.nextAction}`);
    }
  }
  if (report.taskRunners) {
    lines.push('', `작업 실행기 권장: mise tasks (${report.taskRunners.recommendation.status})`);
    for (const item of report.taskRunners.declarations) lines.push(`  ${item.tool}: ${item.source} (${item.state}), 작업: ${item.tasks.join(', ') || '미확인'}`);
    for (const item of report.taskRunners.tools) lines.push(`  실행 파일 ${item.tool}: ${item.version ?? '버전 미확인'} (${item.execution})${item.executable ? `, ${item.executable}` : ''}`);
  }
  if (report.task) lines.push('', `선택한 작업: ${report.task.tool ?? '미확인'} [${STATUS_LABELS[report.task.status]}], 실행: ${report.task.execution}, 종료 코드: ${report.task.exitCode ?? '없음'}`);
  lines.push('', `결과: 통과 ${report.summary.pass}, 요구 위반 ${report.summary.fail}, 검토 ${report.summary.warn}, 미확인 ${report.summary.unknown}, 생략 ${report.summary.skipped}`);
  return lines.join('\n');
}
async function readJson(file) {
  if (!file) throw new Error('JSON 파일 경로가 필요합니다.');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('일반 JSON 파일만 최대 2MiB까지 읽습니다.');
  const contents = await readFile(file, 'utf8');
  try { return JSON.parse(contents); }
  catch { throw new Error('JSON 파일의 구문을 해석하지 못했습니다. 원문은 오류에 포함하지 않습니다.'); }
}

function hasIncompleteExecution(options, report) {
  if (options.action !== 'validate' || !options.execute) return false;
  const incomplete = (status) => status === 'unknown' || status === 'skipped';
  return incomplete(report.task?.status) || report.checks.some((check) =>
    VALIDATION_CHECK_IDS.includes(check.checkId) && check.applicability === 'required' && incomplete(check.status));
}

export async function main(args, { inspect, query } = {}) {
  const options = parseOptions(args);
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  let payload;
  if (options.action === 'plan') payload = await createPlan(options);
  else if (options.action === 'apply') payload = await applyPlan({ ...options, plan: await readJson(options.planFile), query: query ?? createQuery(options) });
  else if (options.action === 'rollback') payload = await rollbackPlan({ ...options, id: options.journal });
  else if (options.action === 'exception') {
    if (!options.execute) throw new Error('예외 저장에는 --execute가 필요합니다.');
    payload = await saveException(options);
  } else {
    if (options.taskFile) {
      options.task = await readJson(options.taskFile);
      if (!TASK_CONTEXTS.includes(options.task?.context)) throw new Error('작업 JSON의 context는 native, rust, wsl 중 하나여야 합니다.');
    }
    payload = await diagnose({ ...options, execute: options.action === 'validate' && options.execute, inspect, query });
  }
  const output = options.format === 'json' || !payload.checks ? JSON.stringify(payload, null, 2) : formatReport(payload);
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${output}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(`${output}\n`);
  const failed = payload.summary?.fail || payload.task?.status === 'fail' || /conflict|failed|partial/.test(payload.status ?? '');
  return failed || hasIncompleteExecution(options, payload) ? 1 : 0;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    const message = error.code === 'EEXIST' ? '지정한 보고서 파일이 이미 존재합니다. 새 경로를 선택하세요.' : error.message;
    process.stderr.write(`진단을 완료하지 못했습니다: ${message}\n`);
    process.exitCode = 2;
  }
}
