import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { analyzeProject } from './project.mjs';
import { evaluateVersion } from './versions.mjs';
import {
  POLICY_VERSION, RUNTIMES, APPS, MISE_TOOLS, SOURCES,
  canonicalRole, exactVersion, failure, selection, installation,
} from './configuration-policy.mjs';

const LIMIT = 8 * 1024 * 1024;
const PROFILE_START = '# >>> WindowsAgentDevkit mise >>>';
const PROFILE_END = '# <<< WindowsAgentDevkit mise <<<';
const PROFILE_BODY = [PROFILE_START, '(&mise activate pwsh) | Out-String | Invoke-Expression', PROFILE_END];
const HASH = /^[a-f0-9]{64}$/;
const JOURNAL_ID = /^[a-f0-9]{16}-[a-f0-9-]{36}$/;
const RELEVANT = /^(?:package\.json|pnpm-workspace\.ya?ml|.*(?:lock|shrinkwrap)(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.nvmrc|\.(?:node|python|go|zig)-version|\.tool-versions|\.?mise(?:\.[\w-]+)?\.toml|pyproject\.toml|Pipfile|requirements[^/]*\.txt|environment\.ya?ml|go\.(?:mod|work|sum)|Cargo\.toml|rust-toolchain(?:\.toml)?|build\.zig(?:\.zon)?|global\.json|Directory\..*|NuGet\.Config|.*\.(?:csproj|sln|slnx)|AGENTS\.md|\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile)$/i;
const parseDeclaration = (text) => parseToml(text, { maxDepth: 64, integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' });

function stable(value) {
  if (typeof value === 'bigint') return `{"$tomlInteger":${JSON.stringify(String(value))}}`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => stable(left) === stable(right);
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const projectKey = (root) => process.platform === 'win32' ? root.toLowerCase() : root;

async function statMaybe(filename) {
  try { return await lstat(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('PATH_UNREADABLE');
  }
}

// Resolve existing ancestors of a not-yet-created path, without following a link during mutations.
async function physical(filename) {
  let current = path.resolve(filename);
  const missing = [];
  while (!(await statMaybe(current))) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw failure('INVALID_PATH');
    current = parent;
  }
  return path.join(await realpath(current), ...missing);
}

async function safeParents(filename) {
  let current = path.parse(filename).root;
  for (const part of path.relative(current, filename).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await statMaybe(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure('UNSAFE_PATH');
  }
}

async function readBytes(filename) {
  await safeParents(path.dirname(filename));
  const before = await statMaybe(filename);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > LIMIT) throw failure('UNSAFE_FILE');
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev) throw failure('FILE_CHANGED');
    const buffer = Buffer.alloc(Math.min(info.size + 1, LIMIT + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > LIMIT || after.size !== info.size || after.mtimeMs !== info.mtimeMs || length !== info.size) throw failure('FILE_CHANGED');
    return buffer.subarray(0, length);
  } finally { await handle?.close(); }
}

const fileHash = async (filename) => { const bytes = await readBytes(filename); return bytes === null ? null : digest(bytes); };
function decode(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes ?? Buffer.alloc(0));
    if (text.includes('\0')) throw failure('UNSUPPORTED_ENCODING');
    return text;
  } catch { throw failure('UNSUPPORTED_ENCODING'); }
}

async function context(projectPath, stateDir) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw failure('PROJECT_REQUIRED');
  const root = await realpath(path.resolve(projectPath)).catch(() => { throw failure('PROJECT_NOT_FOUND'); });
  if (!(await lstat(root)).isDirectory()) throw failure('PROJECT_NOT_DIRECTORY');
  let repo = root;
  for (let folder = root; ; folder = path.dirname(folder)) {
    if (await statMaybe(path.join(folder, '.git'))) { repo = folder; break; }
    if (path.dirname(folder) === folder) break;
  }
  const supplied = stateDir !== undefined;
  if (supplied && (typeof stateDir !== 'string' || !path.isAbsolute(stateDir))) throw failure('ABSOLUTE_STATE_DIR_REQUIRED');
  const candidate = supplied ? stateDir : process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'WindowsAgentDevkit', 'state');
  if (!candidate) throw failure('STATE_DIR_REQUIRED');
  await safeParents(path.resolve(candidate));
  const state = await physical(candidate);
  if (inside(repo, state) || inside(state, root) || state === path.parse(state).root || state === await physical(tmpdir())) {
    throw failure('STATE_DIR_MUST_BE_OUTSIDE_REPOSITORY');
  }
  await safeParents(state);
  return { root, repo, state, key: digest(projectKey(root)), supplied };
}

async function writeExclusive(filename, bytes, mode = 0o600) {
  await safeParents(path.dirname(filename));
  const handle = await open(filename, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function atomicState(filename, data) {
  await safeParents(path.dirname(filename));
  if (await statMaybe(filename)) await readBytes(filename);
  const staging = path.join(path.dirname(filename), `.state-${randomUUID()}.tmp`);
  try { await writeExclusive(staging, `${stable(data)}\n`); await rename(staging, filename); }
  finally { await unlink(staging).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

async function ensureOwnedDirectory(folder) {
  await safeParents(folder);
  const marker = path.join(folder, 'owner.json');
  if (!(await statMaybe(marker))) {
    const names = await readdir(folder).catch((error) => { if (error.code === 'ENOENT') return []; throw failure('STATE_UNREADABLE'); });
    if (names.length) throw failure('STATE_DIR_NOT_OWNED');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await safeParents(folder);
    await privatize(folder);
    try { await writeExclusive(marker, '{"owner":"WindowsAgentDevkit","schemaVersion":1}\n'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!same(await readJson(marker), { owner: 'WindowsAgentDevkit', schemaVersion: 1 })) throw failure('STATE_DIR_NOT_OWNED');
}

async function ensureState(ctx) {
  await ensureOwnedDirectory(ctx.state);
  for (const folder of ['plans', 'journals', 'backups', 'applications', 'exceptions', 'runner']) {
    const target = path.join(ctx.state, folder);
    await safeParents(target);
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
}

async function recoveryRoot(ctx, filename) {
  let ancestor = path.dirname(filename);
  while (!(await statMaybe(ancestor))) ancestor = path.dirname(ancestor);
  if ((await lstat(ancestor)).dev === (await lstat(ctx.state)).dev) return path.join(ctx.state, 'recovery');
  // rename must stay on one filesystem. A second private store is necessary when
  // LOCALAPPDATA and the project are on different volumes; never capture inside Git.
  const base = inside(ctx.repo, filename) ? path.dirname(ctx.repo) : path.dirname(filename);
  const folder = path.join(base, '.WindowsAgentDevkitRecovery');
  if (inside(ctx.repo, folder)) throw failure('PRIVATE_RECOVERY_UNAVAILABLE');
  return folder;
}

async function privatize(folder) {
  if (process.platform !== 'win32') { await chmod(folder, 0o700); return; }
  // Node's mode bits do not set a Windows DACL. Restrict only our empty state directory.
  // https://learn.microsoft.com/windows-server/administration/windows-commands/icacls
  const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const run = promisify(execFile), options = { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 };
  try {
    const { stdout } = await run(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options);
    const sid = stdout.match(/\bS-1-(?:\d+-)+\d+\b/)?.[0];
    if (!sid) throw failure('PRIVATE_STATE_UNAVAILABLE');
    await run(path.join(system, 'icacls.exe'), [folder, '/reset', '/Q'], options);
    await run(path.join(system, 'icacls.exe'), [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/Q'], options);
  } catch { throw failure('PRIVATE_STATE_UNAVAILABLE'); }
}

async function privatizeCapture(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw failure('UNSAFE_FILE');
  if (process.platform !== 'win32') { await chmod(filename, 0o600); return; }
  // A same-volume move can retain the old DACL. Inherit only our private capture directory's ACL.
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  try { await promisify(execFile)(executable, [filename, '/reset', '/Q'], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }); }
  catch { throw failure('PRIVATE_STATE_UNAVAILABLE'); }
}

async function readJson(filename) {
  const bytes = await readBytes(filename);
  if (bytes === null) return null;
  try { return JSON.parse(decode(bytes)); } catch { throw failure('INVALID_STATE'); }
}

async function locked(ctx, fn) {
  await ensureState(ctx);
  const filename = path.join(ctx.state, 'mutation.lock');
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(filename, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await statMaybe(filename), owner = await readJson(filename);
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw failure('STATE_BUSY');
      try { process.kill(owner.pid, 0); throw failure('STATE_BUSY'); }
      catch (probeError) { if (probeError.code !== 'ESRCH') throw failure('STATE_BUSY'); }
      const current = await statMaybe(filename);
      if (!current || current.ino !== info?.ino || current.dev !== info?.dev || !same(await readJson(filename), owner)) throw failure('STATE_BUSY');
      await unlink(filename);
    }
  }
  if (!handle) throw failure('STATE_BUSY');
  try {
    await handle.writeFile(`${stable({ pid: process.pid, token: randomUUID() })}\n`); await handle.sync();
    return await fn();
  } finally { await handle.close(); await unlink(filename); }
}

async function inputs(ctx, profilePath) {
  const files = new Set();
  let count = 0;
  const scan = async (folder, depth, all = false) => {
    const info = await statMaybe(folder);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('UNSAFE_INPUT_DIRECTORY');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++count > 4096) throw failure('INPUT_LIMIT');
      const target = path.join(folder, entry.name);
      if (entry.isDirectory() && depth > 0) await scan(target, depth - 1, all);
      else if ((all && entry.isFile()) || RELEVANT.test(entry.name)) files.add(target);
    }
  };
  // Watch relevant ancestor declarations, lock files and CI without reading .env or Git's index.
  for (let folder = ctx.root; ; folder = path.dirname(folder)) {
    await scan(folder, 0);
    for (const name of ['mise.toml', '.mise.toml', '.tool-versions', 'global.json', 'package.json']) files.add(path.join(folder, name));
    if (folder === ctx.repo || path.dirname(folder) === folder) break;
  }
  for (const folder of ['.github/workflows', '.config/mise', '.mise']) await scan(path.join(ctx.root, folder), 4, true);
  const discovered = await analyzeProject(ctx.root);
  const boundary = path.resolve(ctx.root, discovered.metadata?.scope?.boundary ?? '.');
  const sources = [...(discovered.files ?? []), ...(discovered.metadata?.declarations ?? []).map((entry) => entry.source),
    ...Object.values(discovered.requirements ?? {}).flatMap((entry) => [...(entry.versionRequests ?? []), ...(entry.packageManagers ?? [])].map((item) => item.source))];
  for (const source of sources) {
    if (typeof source !== 'string' || !source || source.length > 1024 || /[\x00-\x1f]/.test(source)) continue;
    const target = path.resolve(ctx.root, source);
    if (inside(ctx.repo, target) || (inside(boundary, ctx.root) && inside(boundary, target)) ||
        (inside(path.dirname(target), ctx.root) && RELEVANT.test(path.basename(target)))) files.add(target);
  }
  if (profilePath) files.add(profilePath);
  if (files.size > 512) throw failure('INPUT_LIMIT');
  return Promise.all([...files].sort().map(async (filename) => ({ path: filename, hash: await fileHash(filename) })));
}

function appendMise(bytes, additions) {
  const text = decode(bytes), bom = text.startsWith('\uFEFF') ? '\uFEFF' : '', body = text.slice(bom.length);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let parsed;
  try { parsed = parseDeclaration(body); } catch { throw failure('INVALID_MISE_DECLARATION'); }
  if (parsed.tools !== undefined && (!parsed.tools || typeof parsed.tools !== 'object' || Array.isArray(parsed.tools))) throw failure('UNSUPPORTED_MISE_DECLARATION');
  const tools = parsed.tools ?? {};
  for (const key of Object.keys(additions)) if (Object.hasOwn(tools, key)) throw failure('EXISTING_VERSION_PRESERVED');
  const expected = { ...parsed, tools: { ...tools, ...additions } };
  const lines = Object.entries(additions).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(eol);
  const candidates = [];
  for (const match of body.matchAll(/^\s*\[tools\][ \t]*(?:#[^\r\n]*)?\r?$/gm)) {
    const end = match.index + match[0].replace(/\r$/, '').length;
    candidates.push(body.slice(0, end) + eol + lines + body.slice(end));
  }
  candidates.push(`${body}${body && !body.endsWith('\n') ? eol : ''}${body ? eol : ''}[tools]${eol}${lines}${eol}`);
  candidates.push(`${Object.entries(additions).map(([key, value]) => `tools.${key} = ${JSON.stringify(value)}`).join(eol)}${eol}${body}`);
  for (const candidate of candidates) {
    try { if (same(parseDeclaration(candidate), expected)) return Buffer.from(bom + candidate); } catch { /* Try another lossless insertion. */ }
  }
  throw failure('MISE_REQUIRES_MANUAL_EDIT');
}

function appendProfile(bytes) {
  const text = decode(bytes), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const starts = text.split(PROFILE_START).length - 1, ends = text.split(PROFILE_END).length - 1;
  if (starts || ends) {
    if (starts !== 1 || ends !== 1 || !text.includes(PROFILE_BODY.join(eol))) throw failure('MANAGED_PROFILE_BLOCK_CONFLICT');
    return bytes;
  }
  if (/\bmise\s+(?:activate|hook-env)\b/i.test(text)) throw failure('EXISTING_PROFILE_ACTIVATION_PRESERVED');
  return Buffer.from(`${text}${text && !text.endsWith('\n') ? eol : ''}${text ? eol : ''}${PROFILE_BODY.join(eol)}${eol}`);
}

async function renderOperation(operation) {
  const before = await readBytes(operation.path);
  const after = operation.type === 'write-mise' ? appendMise(before, operation.versions) : appendProfile(before);
  return { before, after, beforeHash: before === null ? null : digest(before), afterHash: digest(after) };
}

const exceptionFile = (ctx) => path.join(ctx.state, 'exceptions', `${ctx.key}.json`);
async function exceptions(ctx) {
  const saved = await readJson(exceptionFile(ctx));
  if (saved === null) return [];
  if (saved.projectPath !== ctx.root || !Array.isArray(saved.exceptions)) throw failure('INVALID_EXCEPTIONS');
  for (const entry of saved.exceptions) {
    canonicalRole(entry.role, { known: false });
    if (typeof entry.reason !== 'string' || !entry.reason.trim() || typeof entry.scope !== 'string') throw failure('INVALID_EXCEPTIONS');
  }
  return saved.exceptions;
}

/** Persist a keep decision for this canonical project and role, never as a global policy. */
export async function saveException({ projectPath, role, reason, scope = 'project', stateDir } = {}) {
  const ctx = await context(projectPath, stateDir);
  role = canonicalRole(role, { known: false });
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000 || /[\x00-\x1f]/.test(reason) ||
      typeof scope !== 'string' || !scope.trim() || scope.length > 256 || /[\x00-\x1f]/.test(scope)) throw failure('EXCEPTION_REASON_AND_SCOPE_REQUIRED');
  return locked(ctx, async () => {
    const saved = await exceptions(ctx), entry = { projectPath: ctx.root, role, reason: reason.trim(), scope: scope.trim() };
    const previous = saved.find((item) => item.role === role);
    if (!same(previous ?? null, entry)) await atomicState(exceptionFile(ctx), {
      projectPath: ctx.root, exceptions: [...saved.filter((item) => item.role !== role), entry].sort((a, b) => a.role.localeCompare(b.role)),
    });
    return { status: same(previous ?? null, entry) ? 'unchanged' : 'saved', ...entry };
  });
}

export async function loadExceptions({ projectPath, stateDir } = {}) {
  return exceptions(await context(projectPath, stateDir));
}

/** Plan output contains declarations and hashes, never original file contents or command output.
 * roles: runtime-version-manager / powershell-profile / language or known app names.
 * versions: { node: '24.10.0', mise: '2026.11.9', ... }; no version implies no install.
 * analysis is advisory only: reread declarations for every decision that can mutate a file.
 */
export async function createPlan({ projectPath, roles = [], versions = {}, profilePath, stateDir, analysis } = {}) {
  const ctx = await context(projectPath, stateDir), selected = selection(roles, versions);
  if (profilePath !== undefined && (typeof profilePath !== 'string' || !path.isAbsolute(profilePath) || path.extname(profilePath).toLowerCase() !== '.ps1')) throw failure('INVALID_PROFILE_PATH');
  if (profilePath) {
    if (!selected.roles.includes('powershell-profile')) throw failure('PROFILE_ROLE_REQUIRED');
    // A profile is explicitly scoped; it must not alias a project declaration or private state.
    await safeParents(path.dirname(profilePath));
    profilePath = path.resolve(profilePath);
    if (inside(ctx.repo, profilePath) || inside(ctx.state, profilePath)) throw failure('PROFILE_MUST_BE_OUTSIDE_REPOSITORY');
  }
  return locked(ctx, async () => {
    const beforeInputs = await inputs(ctx, profilePath);
    const project = await analyzeProject(ctx.root);
    const kept = await exceptions(ctx), differences = [], operations = [];
    const excepted = (role) => kept.find((entry) => entry.role === role);
    const runtimeSelected = selected.roles.includes('runtime-version-manager') || selected.roles.includes('mise');
    const additions = {};
    const existingMise = [];
    for (const name of ['mise.toml', '.mise.toml']) if (await statMaybe(path.join(ctx.root, name))) existingMise.push(name);
    const misePath = path.join(ctx.root, existingMise[0] ?? 'mise.toml');
    let mise = {}, miseProblem = existingMise.length > 1 ? 'MULTIPLE_MISE_DECLARATIONS' : null;
    try { mise = parseDeclaration(decode(await readBytes(misePath)).replace(/^\uFEFF/, '')); }
    catch (error) { miseProblem = error.code ?? 'INVALID_MISE_DECLARATION'; }
    for (const role of selected.roles) {
      const keep = excepted(role) ?? (RUNTIMES.includes(role) ? excepted('runtime-version-manager') : null);
      if (keep) { differences.push({ role, status: 'kept_exception', exception: keep }); continue; }
      if (!RUNTIMES.includes(role) && role !== 'runtime-version-manager' && role !== 'powershell-profile' && !selected.versions[role]) {
        differences.push({ role, status: 'blocked', reason: 'EXPLICIT_EXACT_VERSION_REQUIRED' });
      }
      if (role === 'powershell-profile') {
        if (!profilePath) { differences.push({ role, status: 'blocked', reason: 'PROFILE_PATH_REQUIRED' }); continue; }
        const operation = { type: 'write-profile', role, path: profilePath, recoveryRoot: await recoveryRoot(ctx, profilePath), updateOwner: 'WindowsAgentDevkit managed block' };
        try {
          const rendered = await renderOperation(operation);
          if (rendered.beforeHash !== rendered.afterHash) operations.push({ ...operation, beforeHash: rendered.beforeHash, afterHash: rendered.afterHash, rollback: { automatic: true, capability: 'unchanged_file_only' } });
          differences.push({ role, status: rendered.beforeHash === rendered.afterHash ? 'aligned' : 'different', reason: 'managed_mise_activation' });
        } catch (error) { differences.push({ role, status: 'blocked', reason: error.code ?? 'PROFILE_UNREADABLE' }); }
      }
    }
    for (const language of RUNTIMES) {
      if (!runtimeSelected && !selected.roles.includes(language)) continue;
      const keep = excepted(language) ?? excepted('runtime-version-manager') ?? (runtimeSelected ? excepted('mise') : null);
      if (keep) {
        if (!differences.some((item) => item.role === language)) differences.push({ role: language, status: 'kept_exception', exception: keep });
        continue;
      }
      const requirement = project.requirements?.[language];
      const requests = requirement?.versionRequests ?? [];
      const pins = [...new Set(requests.filter((request) => ['exact', 'sdk'].includes(request.kind)).map((request) => request.value.replace(/^v/, '')))];
      let version = selected.versions[language] ?? (pins.length === 1 ? pins[0] : undefined), reason;
      if (!version && requirement?.state === 'not_required') continue;
      try { if (version) exactVersion(version, language); } catch { version = undefined; }
      if (!version) reason = 'EXPLICIT_EXACT_VERSION_REQUIRED';
      else if (requirement?.state === 'unknown') reason = 'PROJECT_REQUIREMENT_UNKNOWN';
      else if (requests.length && evaluateVersion(version, requests, { ...requirement.metadata, language }).compatibility !== 'satisfied') reason = 'EXISTING_VERSION_PRESERVED';
      else if (miseProblem && language !== 'dotnet') reason = miseProblem;
      const owner = language === 'dotnet' ? 'Microsoft .NET installer' : 'mise';
      const current = { sources: [...new Set(requests.map((item) => item.source))],
        updateOwners: [...new Set([...(requirement?.metadata?.versionManagers ?? []),
          ...requests.flatMap((item) => /(?:^|\/)\.nvmrc$/.test(item.source) ? ['existing Node manager'] : /rust-toolchain/.test(item.source) ? ['rustup'] : /global\.json$/.test(item.source) ? ['Microsoft .NET installer'] : [])])],
        provenance: 'project_declarations', packageManagers: [...new Set((requirement?.packageManagers ?? []).map((item) => item.name))] };
      differences.push({ role: language, status: reason ? 'blocked' : 'different', ...(reason ? { reason } : {}), current, proposed: { version: version ?? null, updateOwner: owner, provenance: language === 'dotnet' ? 'official-sdk' : MISE_TOOLS[language] } });
      if (reason || language === 'dotnet') continue;
      const aliases = language === 'node' ? ['node', 'nodejs'] : language === 'go' ? ['go', 'golang'] : [language];
      const existing = Object.keys(mise.tools ?? {}).find((key) => aliases.includes(key.split(':').at(-1)));
      if (existing) {
        const declared = mise.tools[existing];
        if (declared === version || declared?.version === version) differences.at(-1).status = 'aligned';
        else { differences.at(-1).status = 'blocked'; differences.at(-1).reason = 'EXISTING_MISE_VERSION_PRESERVED'; }
      } else additions[language] = version;
    }
    if (Object.keys(additions).length) {
      const operation = { type: 'write-mise', role: 'runtime-version-manager', path: misePath, recoveryRoot: await recoveryRoot(ctx, misePath), versions: additions, updateOwner: 'mise' };
      try {
        const rendered = await renderOperation(operation);
        operations.unshift({ ...operation, beforeHash: rendered.beforeHash, afterHash: rendered.afterHash, rollback: { automatic: true, capability: 'unchanged_file_only' } });
      } catch (error) { differences.push({ role: 'runtime-version-manager', status: 'blocked', reason: error.code ?? 'MISE_REQUIRES_MANUAL_EDIT' }); }
    }
    for (const [role, version] of Object.entries(selected.versions)) {
      const explicitlySelected = selected.roles.includes(role) || (role === 'mise' && runtimeSelected);
      if (!explicitlySelected || excepted(role) || ((RUNTIMES.includes(role) || role === 'mise') && excepted('runtime-version-manager'))) continue;
      if (differences.some((item) => item.role === role && item.status === 'blocked')) continue;
      if (!Object.hasOwn(APPS, role) && !Object.hasOwn(MISE_TOOLS, role) && role !== 'dotnet') continue;
      const operation = installation(role, version);
      operations.push(operation);
      if (!differences.some((entry) => entry.role === role)) differences.push({ role, status: 'unknown',
        reason: 'installation_inventory_required', current: { updateOwner: 'unknown', provenance: 'not_queried' },
        proposed: { version, updateOwner: operation.updateOwner, provenance: operation.provenance } });
    }
    if (!same(beforeInputs, await inputs(ctx, profilePath))) throw failure('PROJECT_CHANGED_DURING_PLANNING');
    const body = {
      schemaVersion: 1, policyVersion: POLICY_VERSION, projectPath: ctx.root,
      selection: selected, profilePath: profilePath ?? null, inputs: beforeInputs,
      operations, differences, exceptionsHash: digest(stable(kept)),
      preserve: ['runtime declarations', 'package manager', 'lock files', 'build scripts', 'CI', 'Git index'],
      sources: SOURCES, sourceCheckedOn: '2026-11-17',
    };
    const hash = digest(stable(body)), plan = { ...body, id: hash, hash };
    await atomicState(path.join(ctx.state, 'plans', `${hash}.json`), plan);
    return plan;
  });
}

async function validatePlan(ctx, plan) {
  if (!plan || !HASH.test(plan.id) || plan.id !== plan.hash || plan.projectPath !== ctx.root) throw failure('INVALID_PLAN');
  const { id, hash, ...body } = plan;
  if (digest(stable(body)) !== hash) throw failure('PLAN_HASH_MISMATCH');
  const saved = await readJson(path.join(ctx.state, 'plans', `${id}.json`));
  if (!saved || !same(saved, plan)) throw failure('PLAN_NOT_REVIEWED');
  if (plan.schemaVersion !== 1 || plan.policyVersion !== POLICY_VERSION || !Array.isArray(plan.operations)) throw failure('INVALID_PLAN');
  if (digest(stable(await exceptions(ctx))) !== plan.exceptionsHash) throw failure('EXCEPTIONS_CHANGED');
  selection(plan.selection.roles, plan.selection.versions);
  for (const operation of plan.operations) {
    if (operation.type === 'install') {
      if (!same(operation, installation(operation.role, operation.version))) throw failure('UNSAFE_OPERATION');
    } else if (operation.type === 'write-mise') {
      if (!['mise.toml', '.mise.toml'].some((name) => operation.path === path.join(ctx.root, name))) throw failure('UNSAFE_OPERATION');
      for (const [role, version] of Object.entries(operation.versions)) {
        if (!RUNTIMES.includes(role) || role === 'dotnet') throw failure('UNSAFE_OPERATION');
        exactVersion(version, role);
      }
    } else if (operation.type === 'write-profile') {
      if (!plan.profilePath || operation.path !== plan.profilePath || inside(ctx.repo, operation.path) || inside(ctx.state, operation.path)) throw failure('UNSAFE_OPERATION');
    } else throw failure('UNSAFE_OPERATION');
    if (operation.type !== 'install' && operation.recoveryRoot !== await recoveryRoot(ctx, operation.path)) throw failure('UNSAFE_OPERATION');
  }
}

function publicJournal(journal) {
  return {
    schemaVersion: journal.schemaVersion, id: journal.id, planId: journal.planId,
    projectPath: journal.projectPath, status: journal.status,
    entries: journal.entries.map(({ type, path: target, role, beforeHash, afterHash, status, rollback, outcome, captures }) => ({
      type, role, ...(target ? { path: target, beforeHash, afterHash } : {}), status, rollback, ...(outcome ? { outcome } : {}),
      ...(captures?.length ? { recovery: captures.map(({ path: retained, phase, status: captureStatus, observedHash }) => ({ path: retained, phase, status: captureStatus, observedHash })) } : {}),
    })),
  };
}

async function readJournal(ctx, id) {
  if (!JOURNAL_ID.test(id)) throw failure('INVALID_JOURNAL_ID');
  const journal = await readJson(path.join(ctx.state, 'journals', `${id}.json`));
  if (!journal || journal.id !== id || journal.projectPath !== ctx.root || !HASH.test(journal.planId)) throw failure('JOURNAL_NOT_FOUND');
  const plan = await readJson(path.join(ctx.state, 'plans', `${journal.planId}.json`));
  // Exceptions may change after an apply; they must not prevent restoring our own files.
  const { hash, id: planId, ...body } = plan ?? {};
  if (hash !== journal.planId || planId !== hash || digest(stable(body)) !== hash || plan.projectPath !== ctx.root ||
      !Array.isArray(journal.entries) || journal.entries.length !== plan.operations.length) throw failure('INVALID_JOURNAL');
  journal.entries.forEach((entry, index) => {
    const operation = plan.operations[index];
    if (!same(entry.operation, operation) || entry.type !== operation.type || entry.role !== operation.role ||
        (entry.installAttempted !== undefined && typeof entry.installAttempted !== 'boolean') || !Array.isArray(entry.createdDirectories) ||
        entry.createdDirectories.some((directory) => typeof directory?.path !== 'string' || !inside(directory.path, operation.path ?? '') || directory.path === path.parse(directory.path).root) ||
        (operation.type !== 'install' && (entry.path !== operation.path || entry.beforeHash !== operation.beforeHash || entry.afterHash !== operation.afterHash))) throw failure('INVALID_JOURNAL');
    if (!Array.isArray(entry.captures) || entry.captures.some((capture) => !capture || typeof capture.path !== 'string' ||
        path.basename(capture.path) !== 'original' || path.dirname(path.dirname(capture.path)) !== operation.recoveryRoot ||
        !path.basename(path.dirname(capture.path)).startsWith(`${journal.id}-`) || !['apply', 'rollback', 'compensate'].includes(capture.phase))) throw failure('INVALID_JOURNAL');
  });
  return { journal, plan };
}
const saveJournal = (ctx, journal) => atomicState(path.join(ctx.state, 'journals', `${journal.id}.json`), journal);
const recoveryPaths = (journal) => [...new Set((journal?.entries ?? []).flatMap((entry) => (entry.captures ?? []).map((capture) => capture.path)))];

async function assertFresh(ctx, plan, journal) {
  const actual = await inputs(ctx, plan.profilePath);
  const expected = plan.inputs.map((entry) => ({ ...entry }));
  for (const entry of journal?.entries ?? []) {
    if (entry.type === 'install') continue;
    const current = actual.find((item) => item.path === entry.path);
    if (journal.status === 'applied' && current?.hash !== entry.afterHash) throw Object.assign(failure('STALE_PLAN'), { recoveryPaths: recoveryPaths(journal) });
    if (current?.hash === entry.afterHash && ['writing', 'written', 'conflict'].includes(entry.status)) expected.find((item) => item.path === entry.path).hash = entry.afterHash;
  }
  if (!same(actual, expected)) throw Object.assign(failure('STALE_PLAN'), { recoveryPaths: recoveryPaths(journal) });
}

async function makeParents(filename, entry, ctx, journal) {
  const missing = [];
  for (let folder = path.dirname(filename); !(await statMaybe(folder)); folder = path.dirname(folder)) missing.unshift(folder);
  for (const folder of missing) {
    // Record intent durably before creating a user directory.
    const directory = { path: folder, ino: null, dev: null };
    entry.createdDirectories.push(directory);
    await saveJournal(ctx, journal);
    await safeParents(path.dirname(folder));
    await mkdir(folder, { mode: 0o700 });
    const info = await lstat(folder);
    directory.ino = info.ino; directory.dev = info.dev;
    await saveJournal(ctx, journal);
  }
}

async function publishExclusive(filename, bytes, mode, beforePublish) {
  const staging = path.join(path.dirname(filename), `.wad-${randomUUID()}.tmp`);
  try {
    await writeExclusive(staging, bytes, mode);
    await beforePublish?.();
    await link(staging, filename);
  } finally { await unlink(staging).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Lossless capture plus exclusive publication, NOT an atomic compare-and-swap.
 * The pathname is briefly absent between rename and publication. Non-cooperating
 * writers can recreate it, mutate it after verification, or keep writing through
 * an old open handle. We never overwrite a recreated name. Every moved inode is
 * retained (even on success), so late writes through old handles stay recoverable.
 * Hashes describe observations, not a guarantee against subsequent writes. The
 * private journal/state lock serializes this tool only, not other applications.
 * fileHooks is an optional in-process test seam; hooks are never read from JSON.
 */
async function replaceFile(ctx, journal, entry, bytes, expected, phase, fileHooks = {}) {
  const filename = entry.path, mode = entry.mode;
  await safeParents(path.dirname(filename));
  if (await fileHash(filename) !== expected) throw failure('FILE_CONFLICT');
  let capture, capturedBytes, published = false;
  const event = () => ({ path: filename, capturePath: capture?.path ?? null, phase });
  try {
    if (expected !== null) {
      await ensureOwnedDirectory(entry.operation.recoveryRoot);
      const folder = await mkdtemp(path.join(entry.operation.recoveryRoot, `${journal.id}-`));
      capture = { path: path.join(folder, 'original'), phase, status: 'prepared', expectedHash: expected, observedHash: null };
      entry.captures.push(capture); await saveJournal(ctx, journal);
      await fileHooks.beforeCapture?.(event());
      // The destination is a fresh private directory; rename retains the entire
      // source inode instead of replacing it with our version or deleting it.
      await rename(filename, capture.path);
      capture.status = 'captured'; await saveJournal(ctx, journal);
      await privatizeCapture(capture.path);
      await fileHooks.afterCapture?.(event());
      capturedBytes = await readBytes(capture.path);
      capture.observedHash = capturedBytes === null ? null : digest(capturedBytes);
      if (capture.observedHash !== expected) throw failure('CAPTURE_CONFLICT');
      capture.status = 'verified'; await saveJournal(ctx, journal);
    }
    if (bytes !== null) {
      await publishExclusive(filename, bytes, mode, async () => {
        await fileHooks.beforePublish?.(event());
        if (capture && await fileHash(capture.path) !== expected) throw failure('CAPTURE_CONFLICT');
      });
      published = true;
    } else {
      await fileHooks.beforePublish?.(event());
      if (capture && await fileHash(capture.path) !== expected) throw failure('CAPTURE_CONFLICT');
      if (await statMaybe(filename)) throw failure('FILE_CONFLICT');
    }
    if (capture) { capture.status = bytes === null ? 'retained_removed' : 'retained_replaced'; await saveJournal(ctx, journal); }
    await fileHooks.afterPublish?.(event());
    if (await fileHash(filename) !== (bytes === null ? null : digest(bytes))) throw failure('FILE_CONFLICT');
  } catch (error) {
    if (!published) entry.status = 'preserved';
    if (capture) {
      capture.status = 'conflict_retained';
      // Restore a missing name without overwriting a concurrently recreated one.
      // The capture remains private and retained, including unverified content.
      try {
        const observed = await readBytes(capture.path);
        if (observed !== null) {
          capture.observedHash = digest(observed);
          await publishExclusive(filename, observed, mode);
        }
      } catch { /* Current and captured versions are both retained on conflict. */ }
      await saveJournal(ctx, journal);
    }
    throw Object.assign(failure(error.code === 'CAPTURE_CONFLICT' ? 'CAPTURE_CONFLICT' : 'FILE_CONFLICT'), { recoveryPaths: recoveryPaths(journal) });
  }
}

async function recoverInterrupted(ctx, journal) {
  for (const entry of journal.entries) {
    if (entry.type === 'install') continue;
    const capture = entry.captures.at(-1);
    if (!capture || !['prepared', 'captured', 'verified'].includes(capture.status)) continue;
    if (await statMaybe(capture.path)) await privatizeCapture(capture.path);
    const bytes = await readBytes(capture.path);
    if (bytes === null) continue; // The process stopped before rename.
    capture.observedHash = digest(bytes);
    const current = await fileHash(entry.path);
    if (current === null) {
      try { await publishExclusive(entry.path, bytes, entry.mode); }
      catch { throw Object.assign(failure('FILE_CONFLICT'), { recoveryPaths: recoveryPaths(journal) }); }
      entry.status = capture.observedHash === entry.beforeHash ? 'pending' : capture.observedHash === entry.afterHash ? 'written' : 'preserved';
      capture.status = 'interrupted_capture_retained';
    } else if (current === entry.afterHash && capture.phase === 'apply') {
      entry.status = 'written'; capture.status = 'retained_replaced';
    } else if (current === entry.beforeHash) {
      entry.status = 'restored'; capture.status = 'interrupted_capture_retained';
    } else { entry.status = 'preserved'; capture.status = 'conflict_retained'; }
    await saveJournal(ctx, journal);
  }
}

async function probeInstall(operation, query, options) {
  const args = operation.manager === 'winget'
    ? ['list', '--id', operation.tool, '--exact', '--source', 'winget', '--disable-interactivity', '--accept-source-agreements']
    : ['ls', '--installed', '--json', '--backend', operation.tool.split(':')[0]];
  const result = await invokeQuery(query, operation.manager, args, { ...options, execute: operation.manager === 'winget' });
  if (operation.manager === 'winget') {
    // APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND (0x8A150014).
    if ((Number(result?.exitCode) >>> 0) === 0x8a150014) return 'absent';
    if (result?.state !== 'succeeded' || result.exitCode !== 0 || typeof result.stdout !== 'string') throw failure('INSTALL_INVENTORY_UNKNOWN');
    const line = result.stdout.split(/\r?\n/).find((value) => value.split(/\s+/).includes(operation.tool));
    if (!line) throw failure('INSTALL_INVENTORY_UNKNOWN');
    const words = line.trim().split(/\s+/), actual = words[words.indexOf(operation.tool) + 1];
    return actual === operation.version ? 'present' : 'different';
  }
  if (result?.state !== 'succeeded' || result.exitCode !== 0 || typeof result.stdout !== 'string') throw failure('INSTALL_INVENTORY_UNKNOWN');
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw failure('INSTALL_INVENTORY_UNKNOWN'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('INSTALL_INVENTORY_UNKNOWN');
  const name = operation.role, entries = data[name] ?? data[operation.tool] ?? [];
  if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.version !== 'string')) throw failure('INSTALL_INVENTORY_UNKNOWN');
  return entries.some((entry) => entry.version === operation.version) ? 'present' : 'absent';
}

async function invokeQuery(query, tool, args, options) {
  try { return await query(tool, [...args], structuredClone(options)); }
  catch { throw failure('INSTALL_RUNNER_FAILED'); }
}

async function runnerOptions(ctx) {
  const cwd = path.join(ctx.state, 'runner');
  const config = path.join(cwd, 'mise.toml');
  if (!(await statMaybe(config))) await writeExclusive(config, '# WindowsAgentDevkit isolated install context\n');
  return { cwd, env: {
    MISE_CONFIG_DIR: cwd, MISE_GLOBAL_CONFIG_FILE: config, MISE_SYSTEM_CONFIG_FILE: config,
    MISE_CEILING_PATHS: path.dirname(cwd), MISE_OVERRIDE_CONFIG_FILENAMES: 'mise.toml',
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: '.wad-unused-tool-versions',
    MISE_ENV: '', MISE_NO_ENV: '1', MISE_NO_HOOKS: '1', MISE_LOCKFILE: 'false', MISE_YES: '1', MISE_PARANOID: '1',
  }, timeoutMs: 300000, maxOutputBytes: 1024 * 1024 };
}

/** Default is a verified preview. query is supplied by the parent CLI, never read from a plan. */
export async function applyPlan({ projectPath, plan, execute = false, stateDir, query, fileHooks = {} } = {}) {
  // Do not retain references a caller could edit while the transaction awaits I/O.
  try { plan = structuredClone(plan); } catch { throw failure('INVALID_PLAN'); }
  const ctx = await context(projectPath, stateDir);
  return locked(ctx, async () => {
    await validatePlan(ctx, plan);
    const pointer = await readJson(path.join(ctx.state, 'applications', `${plan.id}.json`));
    let journal = pointer ? (await readJournal(ctx, pointer.id)).journal : null;
    if (journal?.status === 'rolled_back' || journal?.status === 'partially_rolled_back') journal = null;
    if (execute === true && journal) await recoverInterrupted(ctx, journal);
    await assertFresh(ctx, plan, journal);
    if (execute !== true) return { status: 'planned', executed: false, planId: plan.id, operations: plan.operations };
    if (journal?.status === 'applied') return { status: 'already_applied', executed: false, planId: plan.id, journal: publicJournal(journal), recoveryPaths: recoveryPaths(journal), journalPath: path.join(ctx.state, 'journals', `${journal.id}.json`) };
    if (!plan.operations.length) return { status: 'no_changes', executed: false, planId: plan.id };
    if (plan.operations.some((item) => item.type === 'install') && typeof query !== 'function') throw failure('INSTALL_RUNNER_REQUIRED');
    if (!journal) {
      journal = { schemaVersion: 1, id: `${plan.id.slice(0, 16)}-${randomUUID()}`, planId: plan.id, projectPath: ctx.root, status: 'prepared', entries: [] };
      const backupFolder = path.join(ctx.state, 'backups', journal.id);
      await mkdir(backupFolder, { mode: 0o700 });
      for (const [index, operation] of plan.operations.entries()) {
        const entry = { type: operation.type, role: operation.role, status: 'pending', rollback: operation.rollback, operation, createdDirectories: [], captures: [] };
        if (operation.type !== 'install') {
          const rendered = await renderOperation(operation);
          if (rendered.beforeHash !== operation.beforeHash || rendered.afterHash !== operation.afterHash) throw failure('STALE_PLAN');
          entry.path = operation.path; entry.beforeHash = rendered.beforeHash; entry.afterHash = rendered.afterHash;
          const info = await statMaybe(operation.path);
          entry.mode = info ? info.mode & 0o777 : 0o600;
          if (rendered.before !== null) await writeExclusive(path.join(backupFolder, `${index}.bin`), rendered.before);
        }
        journal.entries.push(entry);
      }
      await saveJournal(ctx, journal);
      await atomicState(path.join(ctx.state, 'applications', `${plan.id}.json`), { id: journal.id });
    }
    try {
      delete journal.failureCode;
      journal.status = 'applying'; await saveJournal(ctx, journal);
      const options = plan.operations.some((item) => item.type === 'install') ? await runnerOptions(ctx) : null;
      for (const entry of journal.entries) {
        await assertFresh(ctx, plan, journal);
        const operation = entry.operation;
        if (entry.type === 'install') {
          if (entry.status === 'verified' || entry.status === 'skipped') continue;
          const state = await probeInstall(operation, query, options);
          if (state === 'different') throw failure('EXISTING_INSTALLATION_PRESERVED');
          if (state === 'present') {
            entry.status = 'skipped';
            entry.outcome = entry.installAttempted ? 'observed_after_install_attempt_ownership_unknown' : 'already_present';
          }
          else {
            await assertFresh(ctx, plan, journal);
            entry.status = 'running'; entry.installAttempted = true;
            entry.outcome = 'installation_may_have_changed_shared_state'; await saveJournal(ctx, journal);
            // Derive executable and arguments again from the fixed policy, never dispatch JSON commands.
            const fixed = installation(operation.role, operation.version);
            const result = await invokeQuery(query, fixed.command.tool, fixed.command.args, { ...options, execute: true });
            if (result?.state !== 'succeeded' || result.exitCode !== 0) throw failure('INSTALL_FAILED');
            if (await probeInstall(operation, query, options) !== 'present') throw failure('INSTALL_NOT_VERIFIED');
            entry.status = 'verified'; entry.outcome = 'installed_shared_state_retained_on_rollback';
          }
        } else {
          const current = await fileHash(entry.path);
          if (current === entry.afterHash && ['writing', 'written'].includes(entry.status)) { entry.status = 'written'; continue; }
          if (current !== entry.beforeHash) throw failure('FILE_CONFLICT');
          const rendered = await renderOperation(operation);
          if (rendered.afterHash !== entry.afterHash) throw failure('STALE_PLAN');
          await makeParents(entry.path, entry, ctx, journal);
          entry.status = 'writing'; await saveJournal(ctx, journal);
          await replaceFile(ctx, journal, entry, rendered.after, entry.beforeHash, 'apply', fileHooks);
          entry.status = 'written';
        }
        await saveJournal(ctx, journal);
      }
      await assertFresh(ctx, plan, journal);
      for (const entry of journal.entries) if (entry.type !== 'install' && await fileHash(entry.path) !== entry.afterHash) throw failure('FILE_CONFLICT');
      journal.status = 'applied'; await saveJournal(ctx, journal);
    } catch (error) {
      journal.failureCode = /^[_A-Z0-9]+$/.test(error.code ?? '') ? error.code : 'APPLY_FAILED';
      await restore(ctx, journal, true, fileHooks, 'compensate');
      journal.status = journal.entries.some((entry) => entry.status === 'conflict' || entry.installAttempted) ? 'partial' : 'failed';
      await saveJournal(ctx, journal);
    }
    return { status: journal.status, executed: true, planId: plan.id, ...(journal.failureCode ? { reason: journal.failureCode } : {}), recoveryPaths: recoveryPaths(journal), journal: publicJournal(journal), journalPath: path.join(ctx.state, 'journals', `${journal.id}.json`) };
  });
}

async function restore(ctx, journal, execute = true, fileHooks = {}, phase = 'rollback') {
  const results = [], actions = [];
  for (let index = journal.entries.length - 1; index >= 0; index--) {
    const entry = journal.entries[index];
    if (entry.type === 'install') {
      results.push({ role: entry.role, status: entry.installAttempted ? 'manual' : 'unchanged', reason: 'shared_installation_retained' });
      continue;
    }
    let current;
    try { current = await fileHash(entry.path); } catch {
      if (execute) entry.status = 'conflict';
      results.push({ path: entry.path, status: 'conflict', reason: 'concurrent_edit_preserved' }); continue;
    }
    if (current === entry.beforeHash) {
      if (execute) entry.status = 'restored';
      results.push({ path: entry.path, status: 'unchanged' }); continue;
    }
    if (current !== entry.afterHash || !['writing', 'written', 'conflict'].includes(entry.status)) {
      if (execute) entry.status = 'conflict';
      results.push({ path: entry.path, status: 'conflict', reason: 'concurrent_edit_preserved' }); continue;
    }
    const backup = entry.beforeHash === null ? null : await readBytes(path.join(ctx.state, 'backups', journal.id, `${index}.bin`));
    if (entry.beforeHash !== null && (backup === null || digest(backup) !== entry.beforeHash)) throw failure('BACKUP_CORRUPTED');
    if (!execute) { results.push({ path: entry.path, status: 'would_restore' }); continue; }
    actions.push({ entry, backup });
  }
  // Verify all backups before restoring any file. Each replacement then checks its own hash again.
  for (const { entry, backup } of actions) {
    try {
      await replaceFile(ctx, journal, entry, backup, entry.afterHash, phase, fileHooks);
    } catch {
      entry.status = 'conflict';
      results.push({ path: entry.path, status: 'conflict', reason: 'concurrent_edit_preserved' }); continue;
    }
    entry.status = 'restored'; await saveJournal(ctx, journal);
    for (const directory of [...entry.createdDirectories].reverse()) {
      const folder = directory.path, info = await statMaybe(folder);
      if (!info || !info.isDirectory() || info.isSymbolicLink() || info.ino !== directory.ino || info.dev !== directory.dev ||
          !inside(folder, entry.path) || inside(ctx.repo, folder) || folder === ctx.root) continue;
      await safeParents(folder);
      await rmdir(folder).catch((error) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    }
    results.push({ path: entry.path, status: 'restored' });
  }
  return results;
}

/** Only a locally recorded journal is authoritative; supplied paths/commands never drive rollback. */
export async function rollbackPlan({ projectPath, journal: supplied, journalPath, id, execute = false, stateDir, fileHooks = {} } = {}) {
  const ctx = await context(projectPath, stateDir);
  return locked(ctx, async () => {
    const selected = id ?? (typeof supplied === 'string' ? supplied : supplied?.id) ?? (typeof journalPath === 'string' ? path.basename(journalPath, '.json') : null);
    if (journalPath && journalPath !== path.join(ctx.state, 'journals', `${selected}.json`)) throw failure('UNSAFE_JOURNAL_PATH');
    if (id && supplied && selected !== (typeof supplied === 'string' ? supplied : supplied.id)) throw failure('INVALID_JOURNAL');
    const { journal } = await readJournal(ctx, selected);
    const identity = ({ status, entries, ...record }) => ({ ...record, entries: entries.map(({ status: entryStatus, outcome, recovery, ...entry }) => entry) });
    if (supplied && typeof supplied === 'object' && (!Array.isArray(supplied.entries) || !same(identity(supplied), identity(publicJournal(journal))))) throw failure('JOURNAL_MISMATCH');
    if (supplied && typeof supplied === 'object') supplied.entries.forEach((entry, index) => {
      if (entry.recovery !== undefined && (!Array.isArray(entry.recovery) || entry.recovery.some((capture) =>
        !journal.entries[index].captures.some((record) => record.path === capture?.path && record.phase === capture?.phase)))) throw failure('JOURNAL_MISMATCH');
    });
    if (execute === true) await recoverInterrupted(ctx, journal);
    const changes = await restore(ctx, journal, execute === true, fileHooks);
    if (execute === true) {
      journal.status = changes.some((item) => item.status === 'conflict') ? 'rollback_conflict'
        : changes.some((item) => item.status === 'manual') ? 'partially_rolled_back' : 'rolled_back';
      await saveJournal(ctx, journal);
    }
    return { status: execute === true ? journal.status : 'planned', executed: execute === true, changes, recoveryPaths: recoveryPaths(journal), journal: publicJournal(journal), journalPath: path.join(ctx.state, 'journals', `${journal.id}.json`) };
  });
}
