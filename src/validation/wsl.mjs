import { evaluateVersion } from '../versions.mjs';
import { ARCH, linuxPath, linuxTool, safe } from './inputs.mjs';
import { ok, text } from './query.mjs';
import { outcome, selectedTask, step } from './steps.mjs';

const LINUX = {
  bash: { args: ['--noprofile', '--norc', '--version'] }, mise: { args: ['--version'] },
  node: { args: ['--version'], language: 'node' }, python3: { args: ['-I', '-S', '-B', '--version'], language: 'python' },
  go: { args: ['version'], language: 'go' }, rustc: { args: ['--version'], language: 'rust' },
  zig: { args: ['version'], language: 'zig' }, dotnet: { args: ['--version'], language: 'dotnet' },
};
const LINUX_ENV = ['GOTOOLCHAIN=local', 'GOENV=off', 'GOTELEMETRY=off', 'GOPROXY=off', 'RUSTUP_AUTO_INSTALL=0', 'CARGO_NET_OFFLINE=true', 'MISE_AUTO_INSTALL=0', 'MISE_OFFLINE=1', 'MISE_NO_HOOKS=1', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1', 'DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=true', 'NODE_OPTIONS=', 'PYTHONSTARTUP=', 'BASH_ENV=/dev/null', 'ENV=/dev/null'];

export async function validateWsl(entry, { options, project, call }) {
  const cwd = options.linuxCwd;
  if (!safe(options.distro) || !linuxPath(cwd)) {
    step(entry, 'scope', 'skipped', 'linux_cwd_required', 'distro와 linuxCwd에 명시적인 배포판과 Linux 절대 경로가 필요합니다.'); return;
  }
  const tools = options.linuxTools ?? Object.keys(LINUX).filter((name) => ['bash', 'mise'].includes(name) || project?.requirements?.[LINUX[name].language]?.state === 'required');
  if (!Array.isArray(tools) || tools.length > 16 || !tools.every((name) => Object.hasOwn(LINUX, name))) {
    step(entry, 'scope', 'fail', 'unsupported_linux_tool', 'linuxTools에 지원하는 Linux 도구 이름을 지정해야 합니다.'); return;
  }
  const prefix = ['--distribution', options.distro, '--cd', cwd, '--exec', '/usr/bin/env', ...LINUX_ENV];
  // Keep the fixed shell program in one argv element without literal line breaks.
  // User paths and tasks are passed as separate arguments.
  const script = ['printf "OS=%s\\nARCH=%s\\nCWD=%s\\n" "$(uname -s)" "$(uname -m)" "$(pwd -P)"',
    'printf "sh=%s\\n" "$(command -v sh)"', ...[...new Set(tools)].map((name) => `printf '${name}=%s\\n' "$(command -v ${name})"`)].join('; ');
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
