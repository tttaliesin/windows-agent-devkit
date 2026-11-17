// Fixed policy, not a command interpreter. Callers select roles and exact releases.
export const POLICY_VERSION = 'setup-2';
export const RUNTIMES = Object.freeze(['node', 'python', 'go', 'rust', 'zig', 'dotnet']);
export const APPS = Object.freeze({
  mise: 'jdx.mise', powershell: 'Microsoft.PowerShell', git: 'Git.Git',
  vscode: 'Microsoft.VisualStudioCode', docker: 'Docker.DockerDesktop',
  'windows-terminal': 'Microsoft.WindowsTerminal',
});
export const MISE_TOOLS = Object.freeze({
  node: 'core:node', python: 'core:python', go: 'core:go', rust: 'core:rust', zig: 'core:zig',
  uv: 'aqua:astral-sh/uv', lazydocker: 'aqua:jesseduffield/lazydocker',
  'process-compose': 'aqua:F1bonacc1/process-compose',
});
export const ROLES = Object.freeze([
  'runtime-version-manager', 'powershell-profile', ...RUNTIMES,
  ...Object.keys(APPS), 'uv', 'lazydocker', 'process-compose',
]);
const ALIASES = Object.freeze({
  'project-mise': 'runtime-version-manager', 'runtime-versions': 'runtime-version-manager',
  'shell-activation': 'powershell-profile', 'mise-activation': 'powershell-profile',
  'shell-profile': 'powershell-profile', pwsh: 'powershell', code: 'vscode',
  nodejs: 'node', golang: 'go', 'dotnet-sdk': 'dotnet',
});

export function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function canonicalRole(value, { known = true } = {}) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw failure('INVALID_ROLE');
  const role = Object.hasOwn(ALIASES, value) ? ALIASES[value] : value;
  if (known && !ROLES.includes(role)) throw failure('UNKNOWN_ROLE');
  return role;
}

export function exactVersion(value, role) {
  // No moving channels, URL, option, template, shell syntax, or implicit latest.
  if (typeof value !== 'string' || value.length > 80 ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) {
    throw failure('EXACT_VERSION_REQUIRED');
  }
  if (RUNTIMES.includes(role) && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) throw failure('EXACT_VERSION_REQUIRED');
  return value;
}

export function selection(roles = [], versions = {}) {
  if (!Array.isArray(roles) || roles.length > 32 || !versions ||
      Object.getPrototypeOf(versions) !== Object.prototype || Object.keys(versions).length > 24) {
    throw failure('INVALID_SELECTION');
  }
  const selected = [...new Set(roles.map((role) => canonicalRole(role)))].sort();
  const releases = {};
  for (const [key, value] of Object.entries(versions)) {
    const role = canonicalRole(key);
    if (!Object.hasOwn(APPS, role) && !Object.hasOwn(MISE_TOOLS, role) && role !== 'dotnet') throw failure('INVALID_VERSION_ROLE');
    if (Object.hasOwn(releases, role)) throw failure('DUPLICATE_VERSION_ROLE');
    releases[role] = exactVersion(value, role);
  }
  return { roles: selected, versions: Object.fromEntries(Object.entries(releases).sort(([a], [b]) => a.localeCompare(b))) };
}

export function installation(role, version) {
  exactVersion(version, role);
  let packageId = Object.hasOwn(APPS, role) ? APPS[role] : null;
  if (role === 'dotnet') {
    const major = version.split('.')[0];
    if (!['8', '9', '10', '11'].includes(major)) throw failure('UNSUPPORTED_DOTNET_RELEASE');
    packageId = `Microsoft.DotNet.SDK.${major}`;
  }
  const manager = packageId ? 'winget' : 'mise';
  if (!packageId && !Object.hasOwn(MISE_TOOLS, role)) throw failure('UNSUPPORTED_INSTALL');
  const tool = packageId ?? MISE_TOOLS[role];
  const args = manager === 'winget'
    ? ['install', '--id', tool, '--exact', '--version', version, '--source', 'winget',
      '--no-upgrade', '--silent', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements']
    : ['install', `${tool}@${version}`];
  return {
    type: 'install', role, manager, tool, version, command: { tool: manager, args },
    updateOwner: role === 'rust' ? 'mise/rustup' : manager,
    provenance: manager === 'winget' ? 'winget-community' : tool,
    rollback: { automatic: false, capability: 'manual', reason: 'shared_installation_retained' },
  };
}

// Official command references checked 2026-11-17; host availability is verified separately.
export const SOURCES = Object.freeze([
  'https://mise.jdx.dev/cli/install.html',
  'https://mise.jdx.dev/cli/activate.html',
  'https://learn.microsoft.com/windows/package-manager/winget/install',
  'https://mise.jdx.dev/cli/ls.html',
  'https://mise.jdx.dev/configuration/settings.html',
  'https://mise.jdx.dev/registry.html',
]);
