import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { startServiceSession } from '../service-session.mjs';
import { temporary } from './cleanup.mjs';
import { list, validPath } from './inputs.mjs';
import { json, ok, pause, text } from './query.mjs';
import { outcome, step } from './steps.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function validateProcessCompose(entry, { options, call, timeoutMs, projectPath, host }) {
  if (!validPath(options.serviceConfig) || !list(options.services)) {
    step(entry, 'scope', 'skipped', 'service_selection_required', 'serviceConfig와 시작할 services 배열을 명시해야 합니다.'); return;
  }
  const configPath = path.resolve(projectPath, options.serviceConfig);
  let config;
  try {
    if ((await stat(configPath)).size > 256 * 1024) throw new Error();
    config = parseYaml(await readFile(configPath, 'utf8'), { maxAliasCount: 64 });
  } catch { step(entry, 'config', 'fail', 'config_unreadable', '지정한 Process Compose 설정을 안전하게 읽지 못했습니다.'); return; }
  if (!config?.processes || options.services.some((name) => !Object.hasOwn(config.processes, name) || !config.processes[name])) {
    step(entry, 'config', 'fail', 'service_not_declared', '선택한 서비스가 지정 설정에 선언되어 있지 않습니다.'); return;
  }
  if (options.services.some((name) => {
    const service = config.processes[name];
    return service.is_daemon || service.is_elevated || service.is_interactive || service.is_foreground || service.replicas > 1 || service.extends || service.schedule;
  }) || ['mcp_server', 'include', 'includes', 'extends', 'vars'].some((key) => Object.hasOwn(config, key))
    || Object.values(config.processes).some((service) => service && Object.hasOwn(service, 'vars'))) {
    step(entry, 'config', 'unknown', 'service_lifecycle_unsupported', '분리·승격·대화형 실행이나 확장된 수명주기가 있는 설정은 이 검증에서 지원하지 않습니다.'); return;
  }
  const help = await call('process-compose', ['up', '--help']);
  const flags = text(help.stdout);
  if (!ok(help) || !['--token-file', '--port', '--address', '--no-deps', '--tui', '--config', '--keep-project'].every((flag) => flags.includes(flag))) {
    step(entry, 'capability', ok(help) ? 'unknown' : outcome(help.state), ok(help) ? 'flags_unsupported' : help.state, '설치된 Process Compose에서 격리 실행에 필요한 공식 플래그를 확인하지 못했습니다.'); return;
  }
  await temporary(async (directory) => {
    const port = await (options.portFactory ?? freePort)();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error();
    entry.api = { address: '127.0.0.1', port };
    const tokenFile = path.join(directory, 'token');
    await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key,
      /^(?:PC_|NODE_OPTIONS$|PYTHONSTARTUP$|DOTNET_STARTUP_HOOKS$|DOTNET_ADDITIONAL_DEPS$|DOTNET_SHARED_STORE$)/i.test(key) ? undefined : value]));
    const common = ['--address', '127.0.0.1', '--port', String(port), '--token-file', tokenFile, '--log-file', path.join(directory, 'server.log')];
    const args = ['up', '--config', configPath, '--tui=false', '--keep-project', '--no-deps', ...common, ...(flags.includes('--no-watch') ? ['--no-watch'] : []), ...options.services];
    const factory = options.startSession ?? startServiceSession;
    let session, authenticated = false, sessionPid = null;
    const servicePids = new Set();
    try {
      session = factory(help.executable, args, { cwd: projectPath, env, timeoutMs: timeoutMs + Math.min(timeoutMs, 5000), pwshPath: host?.context?.diagnosticShell?.path });
      const started = await session.started;
      sessionPid = Number.isSafeInteger(started.pid) && started.pid > 0 ? started.pid : null;
      step(entry, 'start', started.state === 'running' ? 'pass' : outcome(started.state), started.state, started.state === 'running' ? '고유 API 포트와 토큰으로 선택 서비스의 세션을 시작했습니다.' : 'Process Compose 자식 세션을 시작하지 못했습니다.');
      if (started.state !== 'running') return;
      const deadline = Date.now() + timeoutMs;
      do {
        if (session.status().state !== 'running') { step(entry, 'ready', 'fail', 'session_exited', 'Process Compose 세션이 준비 전에 종료했습니다.'); return; }
        const response = await call('process-compose', ['process', 'list', '--output', 'json', ...common.slice(0, -2), '--log-file', path.join(directory, 'client.log')], { cwd: projectPath, env }, Math.max(1, deadline - Date.now()));
        const rows = json(response.stdout);
        if (ok(response) && Array.isArray(rows)) {
          authenticated = true;
          for (const row of rows) if (Number.isSafeInteger(row?.pid) && row.pid > 0) servicePids.add(row.pid);
          const selected = options.services.map((name) => rows.find((row) => row?.name === name));
          if (selected.some((row) => row && (row.status === 'Error' || (row.status === 'Completed' && row.exit_code !== 0)))) {
            step(entry, 'ready', 'fail', 'service_failed', '선택한 서비스가 준비 전에 실패했습니다.'); return;
          }
          if (selected.every((row) => row?.status === 'Running' && row.is_running === true)) {
            const probes = options.services.every((name) => config.processes[name].readiness_probe || config.processes[name].ready_log_line);
            if (!probes) { step(entry, 'ready', 'unknown', 'readiness_not_configured', '서비스는 실행 중이지만 명시적인 준비 검사가 없어 준비 완료를 확정하지 않습니다.'); return; }
            if (selected.every((row) => row.is_ready === 'Ready')) { step(entry, 'ready', 'pass', 'services_ready', '선택한 서비스의 실행 상태와 준비 검사를 확인했습니다.'); return; }
          }
        }
        await pause(Math.min(100, Math.max(1, deadline - Date.now())));
      } while (Date.now() < deadline);
      step(entry, 'ready', 'fail', 'timed_out', '선택 서비스의 준비 제한 시간을 초과했습니다.');
    } finally {
      if (session) {
        let down;
        if (authenticated && session.status().state === 'running') down = await call('process-compose', ['down', ...common.slice(0, -2), '--log-file', path.join(directory, 'client.log')], { cwd: projectPath, env }, Math.min(timeoutMs, 5000));
        await session.wait(ok(down) ? Math.min(timeoutMs, 5000) : 1);
        // Always reconcile the owned tree, including when the root has already exited.
        const stopped = await session.stop({ graceMs: Math.min(timeoutMs, 1000) });
        const forced = stopped.forced === true;
        const unconfirmed = stopped.state === 'timed_out' || stopped.treeTerminated !== true || down?.operation?.settled === false;
        if (unconfirmed) (entry.recovery ??= []).push({ kind: 'process-session', ...(stopped.recovery ?? {}),
          parentPid: stopped.rootPid ?? sessionPid, reportedServicePids: [...servicePids], api: entry.api,
          reason: stopped.proof ?? 'owned_tree_unverified', automaticPidKillAllowed: false });
        step(entry, 'stop', unconfirmed ? 'unknown' : forced ? 'warn' : ok(down) && stopped.exitCode === 0 ? 'pass' : 'unknown',
          unconfirmed ? 'owned_tree_cleanup_unverified' : forced ? 'owned_session_terminated' : ok(down) ? 'session_stopped' : 'shutdown_unverified',
          unconfirmed ? '부모 종료와 하위 프로세스 정리를 구분해 기록하며 확인되지 않은 소유 트리의 복구 PID를 남겼습니다.' : forced ? '소유 프로세스 트리의 종료 근거를 확인했습니다.' : '소유 자식 세션과 하위 프로세스 정리의 근거를 확인했습니다.',
          { forced, exitCode: stopped.exitCode ?? null, treeTerminated: stopped.treeTerminated === true, treeProof: stopped.proof ?? null });
      }
    }
  });
}
