import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { evaluateVersion } from './versions.mjs';
import { startServiceSession } from './service-session.mjs';

const IDS = ['RUST-02', 'WSL-02', 'CTR-02', 'PC-02'];
const LABEL = 'io.windows-agent-devkit.validation';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TARGET = /^[a-zA-Z0-9_]+(?:-[a-zA-Z0-9_]+){2,5}$/;
const IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*)(?:@sha256:[a-f0-9]{64})?$/;
const ID = /^[a-f0-9]{12,64}$/;
const ARCH = /^(?:amd64|arm64|arm|386|ppc64le|s390x|riscv64|mips64le|x86_64|aarch64|i686|armv[5-8]l)$/;
const safe = (value, pattern = NAME) => typeof value === 'string' && pattern.test(value);
const text = (value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
const json = (value) => { try { return JSON.parse(text(value)); } catch { return null; } };
const ok = (value) => value?.state === 'succeeded' && value.exitCode === 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validPath = (value) => typeof value === 'string' && value.length > 0 && value.length < 32768 && !/[\0\r\n]/.test(value);
const argv = (value) => Array.isArray(value) && value.length <= 128 && value.every((arg) => typeof arg === 'string' && arg.length <= 32768 && !arg.includes('\0'));
const list = (value) => Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every((item) => safe(item));
const linuxPath = (value) => validPath(value) && value.startsWith('/') && !value.startsWith('//');
const linuxTool = (value) => linuxPath(value) && !/^\/mnt\/[a-z](?:\/|$)/i.test(value)
  && !/\.(?:exe|cmd|bat|ps1)$/i.test(value) && !/\/(?:shims?|proxies)\//i.test(value)
  && !/\/\.cargo\/bin\/(?:rustc|cargo)$/i.test(value);

function step(entry, phase, status, reason, message, facts = {}) {
  const observation = { phase, status, reason, message, ...facts };
  entry.steps.push(observation);
  return observation;
}

function outcome(state) {
  return ['not_found', 'failed', 'timed_out'].includes(state) ? 'fail' : 'unknown';
}

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

async function temporary(action) {
  const directory = await mkdtemp(path.join(tmpdir(), 'windows-agent-validation-'));
  try { return await action(directory); }
  finally {
    // mkdtemp's exact directory is the only recursively deleted filesystem resource.
    const relative = path.relative(tmpdir(), directory);
    if (relative.startsWith('windows-agent-validation-') && !relative.includes(path.sep)) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function selectedTask(context, entry, call, options, cwd, prefix = []) {
  const task = options.task;
  if (!task || task.context !== context) return;
  if (task.trusted !== true || !validPath(task.tool) || task.tool.startsWith('-') || !argv(task.args)) {
    step(entry, 'task', 'skipped', 'trusted_task_required', '실행할 도구·인수 배열과 trusted: true가 지정된 작업이 필요합니다.');
    return;
  }
  if (context === 'wsl' && !linuxTool(task.tool)) {
    step(entry, 'task', 'skipped', 'linux_task_required', '지정 배포판의 Linux 실행 파일 경로가 필요합니다.');
    return;
  }
  const result = await call(context === 'wsl' ? 'wsl' : task.tool,
    context === 'wsl' ? [...prefix, task.tool, ...task.args] : task.args, { cwd });
  step(entry, 'task', ok(result) ? 'pass' : outcome(result.state), result.state,
    ok(result) ? '선택한 신뢰 작업이 정상 종료했습니다.' : '선택한 신뢰 작업의 실행을 완료하지 못했습니다.', { exitCode: result.exitCode ?? null });
}

async function rust(entry, { project, options, call, projectPath }) {
  const env = { RUSTUP_AUTO_INSTALL: '0', CARGO_NET_OFFLINE: 'true' };
  const compiler = await call('rustc', ['-vV'], { cwd: projectPath, env });
  if (!ok(compiler)) {
    step(entry, 'compiler', outcome(compiler.state), compiler.state, '선택한 Rust 컴파일러의 host를 조회하지 못했습니다.');
    return;
  }
  const host = text(compiler.stdout).match(/^host:\s*(\S+)\s*$/m)?.[1];
  if (!safe(host, TARGET)) {
    step(entry, 'compiler', 'unknown', 'host_unknown', 'Rust host triple을 확인하지 못했습니다.');
    return;
  }
  entry.host = host;
  const declared = project?.requirements?.rust?.metadata?.targets;
  const targets = options.rustTargets ?? (options.rustTarget ? [options.rustTarget] : declared?.length ? declared : [host]);
  if (!Array.isArray(targets) || !targets.length || targets.length > 16 || !targets.every((target) => safe(target, TARGET))) {
    step(entry, 'target', 'fail', 'invalid_target', 'Rust target은 명시적인 triple 배열이어야 합니다.'); return;
  }
  await temporary(async (directory) => {
    const source = path.join(directory, 'readiness.rs');
    await writeFile(source, 'fn main() { std::process::exit(0); }\n');
    for (const target of new Set(targets)) {
      const abi = target.endsWith('-windows-msvc') ? 'msvc' : target.endsWith('-windows-gnu') ? 'gnu' : null;
      if (!abi) {
        step(entry, 'link', 'unknown', 'unsupported_target', '이 검증은 Windows MSVC·GNU target의 링크 준비 상태만 확인합니다.', { target }); continue;
      }
      const output = path.join(directory, `${target}.exe`);
      const result = await call('rustc', ['--crate-name', 'devkit_readiness', '--edition=2021', '--target', target, '--emit=link', source, '-o', output], { cwd: directory, env });
      const artifact = ok(result) && await stat(output).then((value) => value.isFile() && value.size > 0, () => false);
      const failure = /E0463|target may not be installed|can't find crate for [`'](?:std|core)/i.test(text(result.stderr)) ? 'target_not_installed'
        : /linker.*not found|link\.exe.*not found|cannot find.*(?:kernel32|ucrt|msvcrt)|LNK1104/i.test(text(result.stderr)) ? 'linker_sdk_unavailable' : result.state;
      step(entry, 'link', artifact ? 'pass' : ok(result) ? 'unknown' : outcome(result.state), artifact ? 'fixture_linked' : failure,
        artifact ? '생성한 최소 Rust 소스의 링크 산출물을 확인했습니다.' : '해당 target의 링크 산출물을 확인하지 못했습니다.',
        { target, abi, linker: abi === 'msvc' ? 'MSVC compatible' : 'GNU compatible', windowsSdk: abi === 'msvc' ? (artifact ? 'link_verified' : 'unverified') : 'not_applicable', artifactVerified: Boolean(artifact) });
    }
  });
  if (entry.steps.every((item) => item.status === 'pass')) await selectedTask('rust', entry, call, options, projectPath);
}

const LINUX = {
  bash: { args: ['--noprofile', '--norc', '--version'] }, mise: { args: ['--version'] },
  node: { args: ['--version'], language: 'node' }, python3: { args: ['-I', '-S', '-B', '--version'], language: 'python' },
  go: { args: ['version'], language: 'go' }, rustc: { args: ['--version'], language: 'rust' },
  zig: { args: ['version'], language: 'zig' }, dotnet: { args: ['--version'], language: 'dotnet' },
};
const LINUX_ENV = ['GOTOOLCHAIN=local', 'GOENV=off', 'GOTELEMETRY=off', 'GOPROXY=off', 'RUSTUP_AUTO_INSTALL=0', 'CARGO_NET_OFFLINE=true', 'MISE_AUTO_INSTALL=0', 'MISE_OFFLINE=1', 'MISE_NO_HOOKS=1', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1', 'DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=true', 'NODE_OPTIONS=', 'PYTHONSTARTUP=', 'BASH_ENV=/dev/null', 'ENV=/dev/null'];

async function wsl(entry, { options, project, call }) {
  const cwd = options.linuxCwd;
  if (!safe(options.distro) || !linuxPath(cwd)) {
    step(entry, 'scope', 'skipped', 'linux_cwd_required', 'distro와 linuxCwd에 명시적인 배포판과 Linux 절대 경로가 필요합니다.'); return;
  }
  const tools = options.linuxTools ?? Object.keys(LINUX).filter((name) => ['bash', 'mise'].includes(name) || project?.requirements?.[LINUX[name].language]?.state === 'required');
  if (!Array.isArray(tools) || tools.length > 16 || !tools.every((name) => Object.hasOwn(LINUX, name))) {
    step(entry, 'scope', 'fail', 'unsupported_linux_tool', 'linuxTools에 지원하는 Linux 도구 이름을 지정해야 합니다.'); return;
  }
  const prefix = ['--distribution', options.distro, '--cd', cwd, '--exec', '/usr/bin/env', ...LINUX_ENV];
  // Only fixed tool names enter this shell program; user paths/tasks remain argv elements.
  const script = ['printf "OS=%s\\nARCH=%s\\nCWD=%s\\n" "$(uname -s)" "$(uname -m)" "$(pwd -P)"',
    'printf "sh=%s\\n" "$(command -v sh)"', ...[...new Set(tools)].map((name) => `printf '${name}=%s\\n' "$(command -v ${name})"`)].join('\n');
  const result = await call('wsl', [...prefix, '/bin/sh', '-c', script]);
  if (!ok(result)) {
    step(entry, 'start', outcome(result.state), result.state, '지정 배포판과 작업 경로에서 Linux 조회를 실행하지 못했습니다.'); return;
  }
  const lines = Object.fromEntries(text(result.stdout).trim().split(/\r?\n/).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (lines.OS !== 'Linux' || !linuxPath(lines.CWD) || !safe(lines.ARCH, ARCH) || !linuxTool(lines.sh)) {
    step(entry, 'context', 'fail', 'linux_context_unverified', '배포판의 Linux 작업 경로·아키텍처·셸을 확인하지 못했습니다.'); return;
  }
  entry.context = { distro: options.distro, cwd: lines.CWD, os: 'Linux', arch: lines.ARCH, shell: lines.sh };
  step(entry, 'context', 'pass', 'linux_context_verified', '지정 배포판의 Linux 셸과 실제 작업 경로를 확인했습니다.');
  for (const name of new Set(tools)) {
    if (!linuxTool(lines[name])) {
      step(entry, 'tool', 'fail', 'linux_tool_unavailable', 'Linux 실행 파일을 찾지 못했거나 Windows 실행 파일·관리자 shim 경로입니다.', { tool: name }); continue;
    }
    const probe = await call('wsl', [...prefix, lines[name], ...LINUX[name].args]);
    const version = ok(probe) ? text(probe.stdout).match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] : null;
    const language = LINUX[name].language;
    const requirement = project?.requirements?.[language];
    const assessment = version && requirement ? evaluateVersion(version, requirement.versionRequests ?? [], { ...requirement.metadata, language }) : null;
    const status = !ok(probe) ? outcome(probe.state) : !version ? 'unknown' : assessment?.compatibility === 'violated' ? 'fail'
      : assessment?.compatibility === 'unknown' && assessment.reason !== 'no_version_requirement' ? 'unknown' : 'pass';
    step(entry, 'tool', status, !ok(probe) ? probe.state : !version ? 'version_unknown' : assessment?.reason ?? 'version_queried',
      status === 'pass' ? 'Linux 도구의 실행 버전을 확인했습니다.' : 'Linux 도구의 실행 버전 또는 프로젝트 요구 충족을 확인하지 못했습니다.',
      { tool: name, path: lines[name], version: version ?? null });
  }
  if (entry.steps.every((item) => item.status === 'pass')) await selectedTask('wsl', entry, call, options, undefined, prefix);
  // Never terminate a distro: it can contain pre-existing user work.
}

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

async function dockerCheck(entry, { options, call, timeoutMs, cleanupGraceMs, projectPath }) {
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

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function processCompose(entry, { options, call, timeoutMs, projectPath, host }) {
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

/** Optional execution only. query resolves trusted executables and must not install tools.
 * WSL: distro, linuxCwd, linuxTools?; Docker: dockerContext, image?, imageCommand?,
 * imageReadiness? ('exit'|'running'|'healthy'), composeFile?, composeServices?;
 * PC: serviceConfig, services; Rust: rustTarget/rustTargets; all: execute, timeoutMs.
 * task?: {context:'rust'|'wsl', trusted:true, tool, args}; no command-string inference.
 * cancellationGraceMs/cleanupGraceMs: 1..5000 ms; timeoutMs is per operation/ready phase.
 * Tests may inject startSession/portFactory; production uses the owned spawn session.
 */
export async function validateEnvironment({ projectPath, project = {}, host = {}, options = {}, query } = {}) {
  const evidence = Object.fromEntries(IDS.map((id) => [id, { steps: [] }]));
  const timeoutMs = options.timeoutMs ?? 15000;
  const cancellationGraceMs = options.cancellationGraceMs ?? Math.min(1000, Math.max(50, timeoutMs));
  const cleanupGraceMs = options.cleanupGraceMs ?? Math.min(5000, Math.max(250, timeoutMs));
  const validTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000
    && [cancellationGraceMs, cleanupGraceMs].every((ms) => Number.isInteger(ms) && ms > 0 && ms <= 5000);
  const root = projectPath ?? project.root;
  const requestedTargets = options.rustTargets ?? (options.rustTarget ? [options.rustTarget] : project.requirements?.rust?.metadata?.targets ?? []);
  const scopes = {
    'RUST-02': { targets: Array.isArray(requestedTargets) ? requestedTargets.filter((target) => safe(target, TARGET)) : [] },
    'WSL-02': { distro: safe(options.distro) ? options.distro : null, cwd: linuxPath(options.linuxCwd) ? options.linuxCwd : null },
    'CTR-02': { dockerContext: safe(options.dockerContext) ? options.dockerContext : null, imageRequested: Boolean(options.image), composeRequested: Boolean(options.composeFile) },
    'PC-02': { serviceConfig: validPath(options.serviceConfig) ? options.serviceConfig : null, services: list(options.services) ? [...new Set(options.services)] : [] },
  };
  const selected = {
    'RUST-02': (project.requirements?.rust?.state === 'required' && project.metadata?.execution?.hostLanguages?.rust !== 'not_required')
      || options.rustTarget !== undefined || options.rustTargets !== undefined || options.task?.context === 'rust',
    'WSL-02': options.distro !== undefined,
    'CTR-02': options.dockerContext !== undefined,
    'PC-02': options.serviceConfig !== undefined,
  };
  const context = { project, host, options, projectPath: root, timeoutMs, cleanupGraceMs,
    call: (tool, args, extra = {}, ms = timeoutMs) => bounded(query, tool, args, { ...extra, execute: true }, ms, cancellationGraceMs) };
  const operations = new Map(IDS.map((id) => [id, []]));
  const validators = { 'RUST-02': rust, 'WSL-02': wsl, 'CTR-02': dockerCheck, 'PC-02': processCompose };
  // Independent environments can be checked concurrently; each owns its own cleanup.
  await Promise.all(IDS.map(async (id) => {
    const entry = evidence[id]; entry.scope = scopes[id];
    if (!selected[id]) { step(entry, 'scope', 'skipped', 'target_not_selected', '이 실행 검증의 구체적인 대상이 선택되지 않았습니다.'); return; }
    if (options.execute !== true) { step(entry, 'consent', 'skipped', 'execute_required', '배포판·엔진·서비스 기동이나 코드 실행에는 options.execute: true가 필요합니다.'); return; }
    if (!validTimeout || !validPath(root)) { step(entry, 'scope', 'fail', 'invalid_options', '유효한 projectPath와 1~300000ms 범위의 timeoutMs가 필요합니다.'); return; }
    if (id === 'CTR-02' && !safe(options.dockerContext)) { step(entry, 'scope', 'fail', 'invalid_context', '명시적인 Docker context 이름이 필요합니다.'); return; }
    const local = { ...context, call: async (tool, args, extra = {}, ms = timeoutMs) => {
      const result = await context.call(tool, args, extra, ms);
      (entry.queries ??= []).push({ tool: ['rustc', 'wsl', 'docker', 'process-compose'].includes(tool) ? tool : 'selected_task',
        state: ['succeeded', 'failed', 'not_found', 'not_run', 'timed_out'].includes(result.state) ? result.state : 'not_run', exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        ...(result.cancellationRequested ? { cancellationRequested: true } : {}) });
      operations.get(id).push(result.operation);
      return result;
    } };
    try { await validators[id](entry, local); }
    catch { step(entry, 'validation', 'fail', 'validation_failed', '실행 검증 중 오류가 발생했습니다.'); }
  }));
  const checks = IDS.map((checkId) => {
    const entry = evidence[checkId];
    for (let index = 0; index < (entry.queries?.length ?? 0); index++) {
      if (entry.queries[index].cancellationRequested) entry.queries[index].cancellationSettled = operations.get(checkId)[index]?.settled === true;
    }
    entry.pendingQueries = operations.get(checkId).filter((operation) => operation?.settled === false).length;
    if (entry.pendingQueries) step(entry, 'cancellation', 'unknown', 'query_still_pending', '취소 유예 시간 이후에도 완료되지 않은 조회가 있어 실행 종료를 확정하지 않습니다.');
    const prefixes = checkId === 'PC-02' && selected[checkId] ? [''] : checkId === 'CTR-02' ? [...(options.image ? ['image.'] : []), ...(options.composeFile ? ['compose.'] : [])] : [];
    for (const prefix of prefixes) for (const [phase, label] of [['start', '시작'], ['ready', '준비 검사'], ['stop', '종료']]) {
      if (!entry.steps.some((item) => item.phase === prefix + phase)) step(entry, prefix + phase, 'skipped', 'not_started', `선행 조건을 충족하지 못해 ${label} 단계를 수행하지 않았습니다.`);
    }
    const deciding = ['fail', 'unknown', 'warn', 'skipped', 'pass'].map((status) => entry.steps.find((item) => item.status === status)).find(Boolean);
    const executed = entry.queries?.some((item) => ['succeeded', 'failed', 'timed_out'].includes(item.state)) || entry.steps.some((item) => item.phase === 'start' && item.reason === 'running');
    const status = deciding?.status === 'skipped' && executed ? 'unknown' : deciding?.status ?? 'unknown';
    const missing = entry.queries?.some((item) => item.state === 'not_found');
    return { checkId, status, reason: deciding?.reason ?? 'unverified', message: deciding?.message ?? '실행 근거가 없습니다.',
      applicability: selected[checkId] ? 'required' : 'not_required', resolution: executed ? 'resolved' : missing ? 'not_resolved' : 'unknown',
      execution: executed ? deciding?.reason === 'timed_out' ? 'timed_out' : status === 'fail' ? 'failed' : 'succeeded' : 'not_run', compatibility: status === 'pass' ? 'satisfied' : status === 'fail' ? 'violated' : 'unknown',
      support: { status: 'unknown', source: null, checkedOn: null }, recommendation: { status: 'unknown' },
      nextAction: status === 'skipped' ? '구체적인 대상과 실행 동의를 지정해 다시 요청합니다.' : '이 결과가 확인한 실행 문맥과 단계별 근거를 확인합니다.', evidence: entry };
  });
  return { checks, evidence };
}
