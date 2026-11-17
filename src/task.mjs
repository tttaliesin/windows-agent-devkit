const TOOLS = new Set(['node', 'npm', 'python', 'uv', 'go', 'cargo', 'rustc', 'zig', 'dotnet', 'pwsh']);

export async function runProjectTask({ projectPath, task, execute = false, query, timeoutMs = 30000 }) {
  if (!task || task.context !== 'native') return null;
  const base = { context: 'windows-native', command: 'selected_project_task', execution: 'not_run', stdout: 'not_collected', stderr: 'not_collected' };
  if (!execute) return { ...base, status: 'skipped', reason: 'execute_required' };
  if (task.trusted !== true || !TOOLS.has(task.tool) || !Array.isArray(task.args) || task.args.length > 128 || task.args.some((i) => typeof i !== 'string' || /[\0\r\n]/.test(i))) return { ...base, status: 'fail', reason: 'trusted_task_required' };
  const result = await query(task.tool, task.args, { cwd: projectPath, timeoutMs, execute: true, projectTask: true });
  return { ...base, tool: task.tool, status: result.state === 'succeeded' && result.exitCode === 0 ? result.forced ? 'warn' : 'pass' : result.state === 'not_run' ? 'unknown' : 'fail', reason: result.state, execution: result.state, executable: result.executable ?? null, exitCode: result.exitCode ?? null,
    ...(typeof result.treeTerminated === 'boolean' ? { cleanup: { confirmed: result.treeTerminated, forced: result.forced === true, proof: result.proof ?? null } } : {}) };
}
