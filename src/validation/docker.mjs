import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from './cleanup.mjs';
import { ARCH, argv, list, safe, validPath } from './inputs.mjs';
import { json, ok, pause, text } from './query.mjs';
import { outcome, step } from './steps.mjs';

const LABEL = 'io.windows-agent-devkit.validation';
const IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*)(?:@sha256:[a-f0-9]{64})?$/;
const ID = /^[a-f0-9]{12,64}$/;

function endpoint(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['npipe:', 'unix:', 'tcp:', 'ssh:', 'http:', 'https:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return { endpoint: url.toString(), locality: ['npipe:', 'unix:'].includes(url.protocol) ? 'local' : 'remote' };
  } catch { return null; }
}

function container(value) { const parsed = json(value); return Array.isArray(parsed) ? parsed[0] : parsed; }
function owned(value, owner) { return ID.test(value?.Id ?? '') && value?.Config?.Labels?.[LABEL] === owner; }

async function reconcileDocker(entry, { docker, owner, name, projectName, mutations, cleanupGraceMs, phase }) {
  const deadline = Date.now() + cleanupGraceMs;
  const observed = new Set(), removed = new Set();
  const filter = `label=${projectName ? 'com.docker.compose.project' : LABEL}=${owner}`;
  const uncertain = () => mutations.some((item) => item.state === 'timed_out' || item.operation?.settled === false);
  const pending = () => mutations.some((item) => item.operation?.settled === false);
  const run = (args) => docker(args, Math.max(1, Math.min(500, deadline - Date.now())));
  const ids = (response) => {
    if (!ok(response)) return null;
    const values = text(response.stdout).trim().split(/\r?\n/).filter(Boolean);
    return values.every((value) => ID.test(value)) ? values : null;
  };
  let absenceConfirmed = false, foreign = false, remaining = [];
  do {
    const candidates = new Set();
    if (name) {
      const target = container((await run(['inspect', name])).stdout);
      if (target?.Id) {
        if (owned(target, owner)) candidates.add(target.Id);
        else foreign = true;
      }
    }
    const containers = ids(await run(['ps', '--all', '--no-trunc', '--filter', filter, '--format', '{{.ID}}']));
    for (const id of containers ?? []) candidates.add(id);
    let changed = false;
    for (const id of candidates) {
      const target = container((await run(['inspect', id])).stdout);
      if (!owned(target, owner) || (projectName && target.Config.Labels['com.docker.compose.project'] !== projectName)) { foreign = true; continue; }
      observed.add(id);
      const response = await run(['rm', '--force', id]); mutations.push(response);
      if (ok(response)) { removed.add(id); changed = true; }
    }
    const networks = projectName ? ids(await run(['network', 'ls', '--no-trunc', '--filter', filter, '--format', '{{.ID}}'])) : [];
    for (const id of networks ?? []) {
      const network = container((await run(['network', 'inspect', id])).stdout);
      if (network?.Labels?.['com.docker.compose.project'] !== projectName || !network.Name?.startsWith(`${projectName}_`) || network.Id !== id) { foreign = true; continue; }
      observed.add(id);
      const response = await run(['network', 'rm', id]); mutations.push(response);
      if (ok(response)) { removed.add(id); changed = true; }
    }
    remaining = [...(containers ?? []), ...(networks ?? [])].filter((id) => !removed.has(id));
    absenceConfirmed = containers !== null && networks !== null && !containers.length && !networks.length && !candidates.size;
    if (!uncertain() && (absenceConfirmed || foreign)) break;
    if (!changed) await pause(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  const confirmed = absenceConfirmed && !foreign && !uncertain();
  const facts = { absenceConfirmed, pendingClient: pending(), remoteCompletionUncertain: uncertain(), observedIds: [...observed], removedIds: [...removed] };
  if (!confirmed) {
    (entry.recovery ??= []).push({ kind: projectName ? 'docker-compose' : 'docker-container',
      dockerContext: entry.scope.dockerContext, endpoint: entry.endpoint, ...(name ? { name } : { projectName }),
      labels: { [LABEL]: owner, ...(projectName ? { 'com.docker.compose.project': projectName } : {}) },
      remainingIds: remaining, ...facts });
  }
  step(entry, phase, confirmed ? 'pass' : 'unknown', confirmed ? 'owned_resources_removed' : pending() ? 'query_pending_cleanup_uncertain' : 'cleanup_unverified',
    confirmed ? '소유권을 확인한 시험 자원만 정리하고 남은 자원이 없음을 조회했습니다.' : '제한된 정리 재조회 이후에도 종료 확정 근거가 부족해 복구 식별자를 남겼습니다.', facts);
}

async function imageSmoke(entry, { options, docker, timeoutMs, cleanupGraceMs }) {
  if (!safe(options.image, IMAGE) || (options.imageCommand !== undefined && !argv(options.imageCommand))
    || (options.imageReadiness !== undefined && !['exit', 'running', 'healthy'].includes(options.imageReadiness))) {
    step(entry, 'image', 'fail', 'invalid_image_request', 'image와 선택 명령 인수·준비 조건을 명시적인 값으로 지정해야 합니다.'); return;
  }
  const inspected = await docker(['image', 'inspect', options.image]);
  const image = container(inspected.stdout);
  if (!ok(inspected) || !safe(image?.Id, /^sha256:[a-f0-9]{64}$/)) {
    step(entry, 'image', ok(inspected) ? 'unknown' : outcome(inspected.state), ok(inspected) ? 'image_metadata_unknown' : inspected.state, '선택 엔진의 로컬 이미지 조회를 완료하지 못했습니다.'); return;
  }
  if (Object.keys(image.Config?.Volumes ?? {}).length > 0) {
    step(entry, 'image', 'unknown', 'image_volumes_unsupported', '자동 볼륨을 선언한 이미지는 이 격리 시험에서 지원하지 않습니다.'); return;
  }
  const normalizedArch = (arch) => ({ x86_64: 'amd64', aarch64: 'arm64' })[arch] ?? arch;
  if (image.Os !== entry.server.os || normalizedArch(image.Architecture) !== normalizedArch(entry.server.arch)) {
    step(entry, 'image', 'unknown', 'image_platform_mismatch', '이미지와 엔진의 OS·아키텍처가 달라 이 시험에서 실행하지 않습니다.'); return;
  }
  const owner = randomUUID(), name = `devkit-${owner}`;
  let attempted = false, resource;
  const mutations = [];
  try {
    attempted = true;
    const created = await docker(['create', '--pull=never', '--name', name, '--label', `${LABEL}=${owner}`, '--network', 'none', '--restart', 'no', image.Id, ...(options.imageCommand ?? [])]);
    mutations.push(created);
    resource = container((await docker(['inspect', name])).stdout);
    if (!owned(resource, owner)) {
      step(entry, 'image.start', ok(created) ? 'unknown' : outcome(created.state), ok(created) ? 'ownership_unverified' : created.state, '이미지 시험 컨테이너의 생성·소유권을 확인하지 못했습니다.'); return;
    }
    if (!ok(created)) {
      step(entry, 'image.start', outcome(created.state), created.state, '컨테이너 생성 요청이 정상 완료되지 않았습니다.'); return;
    }
    const started = await docker(['start', resource.Id]);
    mutations.push(started);
    step(entry, 'image.start', ok(started) ? 'pass' : outcome(started.state), started.state, ok(started) ? '소유권이 확인된 시험 컨테이너를 시작했습니다.' : '시험 컨테이너를 시작하지 못했습니다.');
    if (!ok(started)) return;
    const deadline = Date.now() + timeoutMs;
    do {
      const state = container((await docker(['inspect', resource.Id], Math.max(1, deadline - Date.now()))).stdout);
      if (!owned(state, owner)) {
        step(entry, 'image.ready', 'unknown', 'ownership_lost', '준비 조회에서 시험 컨테이너의 소유권을 확인하지 못했습니다.'); return;
      }
      const policy = options.imageReadiness ?? 'exit';
      const ready = policy === 'exit' ? state.State?.Status === 'exited' && state.State?.ExitCode === 0
        : policy === 'healthy' ? state.State?.Running === true && state.State?.Health?.Status === 'healthy' : state.State?.Running === true;
      if (ready) { step(entry, 'image.ready', 'pass', 'image_ready', '요청한 이미지 시험의 준비 조건을 충족했습니다.', { readiness: policy }); return; }
      if (['dead', 'exited'].includes(state.State?.Status)) { step(entry, 'image.ready', 'fail', 'container_exited', '시험 컨테이너가 준비 조건을 충족하지 못하고 종료했습니다.'); return; }
      await pause(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    step(entry, 'image.ready', 'fail', 'timed_out', '이미지 시험의 준비 제한 시간을 초과했습니다.');
  } finally {
    if (attempted) {
      await reconcileDocker(entry, { docker, owner, name, mutations, cleanupGraceMs, phase: 'image.stop' });
    }
  }
}

export async function validateDocker(entry, { options, call, timeoutMs, cleanupGraceMs, projectPath }) {
  const env = { DOCKER_HOST: '', DOCKER_CONTEXT: '', DOCKER_API_VERSION: '', COMPOSE_PROJECT_NAME: '', COMPOSE_FILE: '' };
  const metadata = await call('docker', ['context', 'inspect', options.dockerContext, '--format', '{{json .}}'], { env });
  const context = container(metadata.stdout);
  const connection = endpoint(context?.Endpoints?.docker?.Host);
  if (!ok(metadata) || !connection || context?.Name !== options.dockerContext) {
    step(entry, 'context', ok(metadata) ? 'unknown' : outcome(metadata.state), ok(metadata) ? 'endpoint_unknown' : metadata.state, '선택한 Docker context의 endpoint를 확인하지 못했습니다.'); return;
  }
  Object.assign(entry, connection);
  const docker = (args, ms = timeoutMs) => call('docker', ['--context', options.dockerContext, ...args], { cwd: projectPath, env }, ms);
  const response = await docker(['version', '--format', '{{json .Server}}']);
  const server = json(response.stdout);
  const os = server?.Os ?? server?.os, arch = server?.Arch ?? server?.arch;
  if (!ok(response) || !['linux', 'windows'].includes(os) || !safe(arch, ARCH)) {
    step(entry, 'server', ok(response) ? 'unknown' : outcome(response.state), ok(response) ? 'server_metadata_unknown' : response.state, '선택 endpoint의 Docker 서버 OS·아키텍처를 확인하지 못했습니다.'); return;
  }
  entry.server = { os, arch };
  step(entry, 'server', 'pass', 'server_connected', '선택한 endpoint의 Docker 서버 응답과 OS·아키텍처를 확인했습니다.');
  if (options.image) await imageSmoke(entry, { options, docker, timeoutMs, cleanupGraceMs });
  if (options.composeFile) await composeSmoke(entry, { options, docker, timeoutMs, cleanupGraceMs, projectPath });
}

// Compose is intentionally restricted to isolated, image-only services.
// Fixed names, mounts and host namespaces cannot safely be isolated by -p alone.
async function composeSmoke(entry, { options, docker, timeoutMs, cleanupGraceMs, projectPath }) {
  const services = options.composeServices ?? options.services;
  if (!validPath(options.composeFile) || !list(services)) {
    step(entry, 'compose.scope', 'skipped', 'compose_services_required', 'composeFile과 선택한 composeServices 또는 services가 필요합니다.'); return;
  }
  const owner = `devkit-${randomUUID()}`;
  const base = ['compose', '--project-name', owner, '--file', path.resolve(projectPath, options.composeFile)];
  const result = await docker([...base, 'config', '--format', 'json']);
  const config = json(result.stdout);
  if (!ok(result) || !config?.services) {
    step(entry, 'compose.config', ok(result) ? 'unknown' : outcome(result.state), 'compose_config_unavailable', '선택한 Compose 설정을 해석하지 못했습니다.'); return;
  }
  const risky = Object.entries(config.networks ?? {}).some(([key, value]) => value.external || (value.name && value.name !== `${owner}_${key}`))
    || Object.keys(config.volumes ?? {}).length > 0 || Object.keys(config.secrets ?? {}).length > 0 || Object.keys(config.configs ?? {}).length > 0
    || services.some((name) => {
      const service = config.services[name];
      return !Object.hasOwn(config.services, name) || !service || !safe(service.image, IMAGE) || service.build || service.container_name || service.volumes?.length
        || service.secrets?.length || service.configs?.length || service.privileged || service.devices?.length
        || service.network_mode || service.pid || service.ipc || service.provider || service.external_links?.length || service.volumes_from?.length
        || service.ports?.some((port) => typeof port !== 'object' || (port.published && String(port.published) !== '0'));
    });
  if (risky) {
    step(entry, 'compose.config', 'unknown', 'compose_isolation_unsupported', '고정 이름·공유 자원·호스트 결합이 있는 Compose 설정은 이 격리 시험에서 지원하지 않습니다.'); return;
  }
  for (const resource of [['ps', '--all'], ['network', 'ls'], ['volume', 'ls']]) {
    const existing = await docker([...resource, '--filter', `label=com.docker.compose.project=${owner}`, '--format', resource[0] === 'volume' ? '{{.Name}}' : '{{.ID}}']);
    if (!ok(existing) || text(existing.stdout).trim()) {
      step(entry, 'compose.scope', 'unknown', 'project_ownership_unverified', '고유 Compose 프로젝트 이름의 기존 자원 부재를 확인하지 못했습니다.'); return;
    }
  }
  // Never pull images, run builds or start dependencies outside the selected services.
  for (const name of services) {
    const response = await docker(['image', 'inspect', config.services[name].image]);
    const image = container(response.stdout);
    if (!ok(response) || !safe(image?.Id, /^sha256:[a-f0-9]{64}$/)) {
      step(entry, 'compose.image', ok(response) ? 'unknown' : outcome(response.state), 'local_image_unverified', '선택한 Compose 서비스의 기존 로컬 이미지를 확인하지 못했습니다.'); return;
    }
    if (Object.keys(image.Config?.Volumes ?? {}).length > 0 || image.Os !== entry.server.os || image.Architecture !== entry.server.arch) {
      step(entry, 'compose.image', 'unknown', 'image_isolation_unsupported', '이미지의 자동 볼륨 또는 플랫폼 차이를 이 격리 시험에서 지원하지 않습니다.'); return;
    }
    config.services[name].image = image.Id;
    config.services[name].labels = { ...config.services[name].labels, [LABEL]: owner };
  }
  let attempted = false;
  const mutations = [];
  try {
    // Snapshot the resolved configuration so later file changes cannot widen the run/down scope.
    await temporary(async (directory) => {
      const snapshot = path.join(directory, 'compose.json');
      await writeFile(snapshot, JSON.stringify(config), { mode: 0o600 });
      const scoped = ['compose', '--project-name', owner, '--file', snapshot];
      attempted = true;
      try {
        const started = await docker([...scoped, 'up', '--detach', '--no-build', '--pull', 'never', '--no-deps', ...services]);
        mutations.push(started);
        step(entry, 'compose.start', ok(started) ? 'pass' : outcome(started.state), started.state, ok(started) ? '고유 Compose 프로젝트에서 선택 서비스만 시작했습니다.' : '선택 Compose 서비스의 시작을 완료하지 못했습니다.');
        if (!ok(started)) return;
        const deadline = Date.now() + timeoutMs;
        do {
          const response = await docker([...scoped, 'ps', '--all', '--format', 'json'], Math.max(1, deadline - Date.now()));
          const data = json(response.stdout);
          const rows = Array.isArray(data) ? data : text(response.stdout).trim().split(/\r?\n/).map(json);
          const selected = rows.filter((row) => services.includes(row?.Service) && row.Project === owner);
          if (ok(response) && services.every((name) => selected.some((row) => row.Service === name)) && selected.every((row) => row.State === 'running')) {
            if (services.some((name) => !config.services[name].healthcheck || config.services[name].healthcheck.disable)) {
              step(entry, 'compose.ready', 'unknown', 'readiness_not_configured', 'Compose 서비스는 실행 중이지만 명시적인 준비 검사가 없습니다.'); return;
            }
            if (selected.every((row) => row.Health === 'healthy')) {
              step(entry, 'compose.ready', 'pass', 'compose_healthy', '선택한 Compose 서비스의 준비 상태를 확인했습니다.'); return;
            }
          }
          if (ok(response) && rows.some((row) => services.includes(row?.Service) && ['exited', 'dead'].includes(row.State))) {
            step(entry, 'compose.ready', 'fail', 'service_exited', '선택한 Compose 서비스가 준비 전에 종료했습니다.'); return;
          }
          await pause(Math.min(100, Math.max(1, deadline - Date.now())));
        } while (Date.now() < deadline);
        step(entry, 'compose.ready', 'fail', 'timed_out', 'Compose 준비 상태의 제한 시간을 초과했습니다.');
      } finally {
        await reconcileDocker(entry, { docker, owner, projectName: owner, mutations, cleanupGraceMs, phase: 'compose.stop' });
      }
    });
  } finally { if (!attempted) step(entry, 'compose.stop', 'skipped', 'not_started', 'Compose 자원을 생성하지 않았습니다.'); }
}
