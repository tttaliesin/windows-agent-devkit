import { argv, linuxTool, validPath } from './inputs.mjs';
import { ok, queryExecution, queryState } from './query.mjs';

export function step(entry, phase, status, reason, message, facts = {}) {
  const observation = { phase, status, reason, message, ...facts };
  entry.steps.push(observation);
  return observation;
}

export function outcome(state) {
  return ['not_found', 'failed', 'timed_out'].includes(state) ? 'fail' : 'unknown';
}

export function skipTask(entry, reason, message) {
  return step(entry, 'task', 'skipped', reason, message, { execution: 'not_run', exitCode: null });
}

export function recordUnstartedServiceSteps(entry, prefixes) {
  for (const prefix of prefixes) {
    for (const [phase, label] of [['start', '시작'], ['ready', '준비 검사'], ['stop', '종료']]) {
      if (!entry.steps.some((item) => item.phase === prefix + phase)) {
        step(entry, prefix + phase, 'skipped', 'not_started', `선행 조건을 충족하지 못해 ${label} 단계를 수행하지 않았습니다.`);
      }
    }
  }
}

export async function selectedTask(context, entry, call, options, cwd, prefix = []) {
  const task = options.task;
  if (!task || task.context !== context) return;
  if (task.trusted !== true || !validPath(task.tool) || task.tool.startsWith('-') || !argv(task.args)) {
    skipTask(entry, 'trusted_task_required', '실행할 도구·인수 배열과 trusted: true가 지정된 작업이 필요합니다.');
    return;
  }
  if (context === 'wsl' && !linuxTool(task.tool)) {
    skipTask(entry, 'linux_task_required', '지정 배포판의 Linux 실행 파일 경로가 필요합니다.');
    return;
  }
  const result = await call(context === 'wsl' ? 'wsl' : task.tool,
    context === 'wsl' ? [...prefix, task.tool, ...task.args] : task.args, { cwd });
  const state = result.state === 'succeeded' && !ok(result) ? 'failed' : queryState(result.state);
  step(entry, 'task', state === 'succeeded' ? 'pass' : outcome(state), state,
    state === 'succeeded' ? '선택한 신뢰 작업이 정상 종료했습니다.' : '선택한 신뢰 작업의 실행을 완료하지 못했습니다.',
    { execution: queryExecution(state), exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null });
}
