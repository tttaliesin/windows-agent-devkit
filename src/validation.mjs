import { validateDocker } from './validation/docker.mjs';
import { linuxPath, list, safe, validPath } from './validation/inputs.mjs';
import { validateProcessCompose } from './validation/process-compose.mjs';
import { createValidationQuery, queryExecution } from './validation/query.mjs';
import { rustScope, validateRust } from './validation/rust.mjs';
import { recordUnstartedServiceSteps, skipTask, step } from './validation/steps.mjs';
import { validateWsl } from './validation/wsl.mjs';

export const VALIDATION_CHECK_IDS = Object.freeze(['RUST-02', 'WSL-02', 'CTR-02', 'PC-02']);

const validators = {
  'RUST-02': validateRust,
  'WSL-02': validateWsl,
  'CTR-02': validateDocker,
  'PC-02': validateProcessCompose,
};

/** Optional execution only. query resolves trusted executables and must not install tools.
 * WSL: distro, linuxCwd, linuxTools?; Docker: dockerContext, image?, imageCommand?,
 * imageReadiness? ('exit'|'running'|'healthy'), composeFile?, composeServices?;
 * PC: serviceConfig, services; Rust: rustTarget/rustTargets; all: execute, timeoutMs.
 * task?: {context:'rust'|'wsl', trusted:true, tool, args}; no command-string inference.
 * cancellationGraceMs/cleanupGraceMs: 1..5000 ms; timeoutMs is per operation/ready phase.
 * Tests may inject startSession/portFactory; production uses the owned spawn session.
 */
export async function validateEnvironment({ projectPath, project = {}, host = {}, options = {}, query } = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const cancellationGraceMs = options.cancellationGraceMs ?? Math.min(1000, Math.max(50, timeoutMs));
  const cleanupGraceMs = options.cleanupGraceMs ?? Math.min(5000, Math.max(250, timeoutMs));
  const validTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000
    && [cancellationGraceMs, cleanupGraceMs].every((ms) => Number.isInteger(ms) && ms > 0 && ms <= 5000);
  const root = projectPath ?? project.root;
  const taskContext = options.task?.context;
  const taskCheckId = taskContext === 'rust' ? 'RUST-02' : taskContext === 'wsl' ? 'WSL-02' : null;
  const selected = {
    'RUST-02': options.rustTarget !== undefined || options.rustTargets !== undefined || taskCheckId === 'RUST-02',
    'WSL-02': options.distro !== undefined || options.linuxCwd !== undefined
      || options.linuxTools !== undefined || taskCheckId === 'WSL-02',
    'CTR-02': options.dockerContext !== undefined,
    'PC-02': options.serviceConfig !== undefined,
  };
  const scopes = {
    'RUST-02': selected['RUST-02'] ? rustScope(project, options) : { targets: [] },
    'WSL-02': { distro: safe(options.distro) ? options.distro : null, cwd: linuxPath(options.linuxCwd) ? options.linuxCwd : null },
    'CTR-02': { dockerContext: safe(options.dockerContext) ? options.dockerContext : null, imageRequested: Boolean(options.image), composeRequested: Boolean(options.composeFile) },
    'PC-02': { serviceConfig: validPath(options.serviceConfig) ? options.serviceConfig : null, services: list(options.services) ? [...new Set(options.services)] : [] },
  };
  const context = { project, host, options, projectPath: root, timeoutMs, cleanupGraceMs };
  const validations = VALIDATION_CHECK_IDS.map((id) => {
    const entry = { steps: [], scope: scopes[id] };
    return { id, entry, queries: createValidationQuery(entry, query, { timeoutMs, cancellationGraceMs }) };
  });
  // Independent environments can be checked concurrently; each owns its own cleanup.
  await Promise.all(validations.map(async ({ id, entry, queries: { call } }) => {
    if (!selected[id]) {
      step(entry, 'scope', 'skipped', 'target_not_selected', '이 실행 검증의 구체적인 대상이 선택되지 않았습니다.');
      return;
    }
    if (options.execute !== true) {
      step(entry, 'consent', 'skipped', 'execute_required', '배포판·엔진·서비스 기동이나 코드 실행에는 options.execute: true가 필요합니다.');
      return;
    }
    if (!validTimeout || !validPath(root)) {
      step(entry, 'scope', 'fail', 'invalid_options', '유효한 projectPath와 1~300000ms 범위의 timeoutMs가 필요합니다.');
      return;
    }
    if (id === 'CTR-02' && !safe(options.dockerContext)) {
      step(entry, 'scope', 'fail', 'invalid_context', '명시적인 Docker context 이름이 필요합니다.');
      return;
    }
    try {
      await validators[id](entry, { ...context, call });
    } catch {
      step(entry, 'validation', 'fail', 'validation_failed', '실행 검증 중 오류가 발생했습니다.');
    }
  }));
  const checks = validations.map(({ id: checkId, entry, queries }) => {
    queries.summarize();
    if (entry.pendingQueries) step(entry, 'cancellation', 'unknown', 'query_still_pending', '취소 유예 시간 이후에도 완료되지 않은 조회가 있어 실행 종료를 확정하지 않습니다.');
    const prefixes = checkId === 'PC-02' && selected[checkId] ? [''] : checkId === 'CTR-02'
      ? [...(options.image ? ['image.'] : []), ...(options.composeFile ? ['compose.'] : [])] : [];
    recordUnstartedServiceSteps(entry, prefixes);
    const task = checkId === taskCheckId
      ? (entry.steps.find((item) => item.phase === 'task')
        ?? skipTask(entry, 'not_started', '선행 조건을 충족하지 못해 선택한 작업을 실행하지 않았습니다.')) : null;
    const deciding = ['fail', 'unknown', 'warn', 'skipped', 'pass'].map((status) => entry.steps.find((item) => item.status === status)).find(Boolean);
    const executed = entry.queries?.some((item) => queryExecution(item.state) !== 'not_run')
      || entry.steps.some((item) => item.phase === 'start' && item.reason === 'running');
    const status = deciding?.status === 'skipped' && executed ? 'unknown' : deciding?.status ?? 'unknown';
    const missing = entry.queries?.some((item) => item.state === 'not_found');
    const execution = task?.execution ?? (!executed ? 'not_run'
      : deciding?.reason === 'timed_out' ? 'timed_out' : status === 'fail' ? 'failed' : 'succeeded');
    return { checkId, status, reason: deciding?.reason ?? 'unverified', message: deciding?.message ?? '실행 근거가 없습니다.',
      applicability: selected[checkId] ? 'required' : 'not_required', resolution: executed ? 'resolved' : missing ? 'not_resolved' : 'unknown',
      execution, compatibility: status === 'pass' ? 'satisfied' : status === 'fail' ? 'violated' : 'unknown',
      support: { status: 'unknown', source: null, checkedOn: null }, recommendation: { status: 'unknown' },
      nextAction: status === 'skipped' ? '구체적인 대상과 실행 동의를 지정해 다시 요청합니다.' : '이 결과가 확인한 실행 문맥과 단계별 근거를 확인합니다.', evidence: entry };
  });
  const evidence = Object.fromEntries(validations.map(({ id, entry }) => [id, entry]));
  return { checks, evidence };
}
