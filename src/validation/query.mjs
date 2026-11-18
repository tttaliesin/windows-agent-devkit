export const text = (value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
export const json = (value) => { try { return JSON.parse(text(value)); } catch { return null; } };
export const ok = (value) => value?.state === 'succeeded' && value.exitCode === 0;
export const queryState = (state) => ['succeeded', 'failed', 'not_found', 'not_run', 'timed_out'].includes(state) ? state : 'not_run';
export const queryExecution = (state) => ['succeeded', 'failed', 'timed_out'].includes(state) ? state : 'not_run';
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Never expose a tool's stdout, stderr, reason, environment or task arguments.
// A parent query should honor timeoutMs/signal as well, especially for remote mutations.
async function bounded(query, tool, args, options, timeoutMs, cancellationGraceMs) {
  if (typeof query !== 'function') return { state: 'not_run', exitCode: null };
  let timer;
  const controller = new AbortController();
  const operation = { settled: false };
  const pending = Promise.resolve().then(() => query(tool, args, { ...options, timeoutMs, signal: controller.signal }))
    .then((value) => { operation.settled = true; return value; }, () => { operation.settled = true; return { state: 'failed', exitCode: null }; });
  const expired = Symbol('deadline');
  try {
    let result = await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(() => { resolve(expired); controller.abort(); }, timeoutMs);
      }),
    ]);
    if (result === expired) {
      // Aborting a client is not proof that the client or remote daemon stopped.
      // Wait for the query's cancellation handler, then retain a live settlement handle.
      let grace;
      try {
        await Promise.race([pending, new Promise((resolve) => { grace = setTimeout(resolve, cancellationGraceMs); })]);
      } finally { clearTimeout(grace); }
      return { state: 'timed_out', exitCode: null, cancellationRequested: true, operation };
    }
    if (!result || typeof result !== 'object') return { state: 'failed', exitCode: null };
    if (Buffer.byteLength(text(result.stdout)) + Buffer.byteLength(text(result.stderr)) > 1024 * 1024) {
      return { state: 'failed', exitCode: null };
    }
    return { ...result, operation };
  } catch { return { state: 'failed', exitCode: null }; }
  finally { clearTimeout(timer); }
}

export function createValidationQuery(entry, query, { timeoutMs, cancellationGraceMs }) {
  const operations = [];
  return {
    async call(tool, args, extra = {}, ms = timeoutMs) {
      const result = await bounded(query, tool, args, { ...extra, execute: true }, ms, cancellationGraceMs);
      (entry.queries ??= []).push({
        tool: ['rustc', 'wsl', 'docker', 'process-compose'].includes(tool) ? tool : 'selected_task',
        state: queryState(result.state),
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        ...(result.cancellationRequested ? { cancellationRequested: true } : {}),
      });
      operations.push(result.operation);
      return result;
    },
    summarize() {
      for (const [index, observation] of (entry.queries ?? []).entries()) {
        if (observation.cancellationRequested) observation.cancellationSettled = operations[index]?.settled === true;
      }
      entry.pendingQueries = operations.filter((operation) => operation?.settled === false).length;
    },
  };
}
