import { createHash, randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { existingEntry, inside, MAX_BYTES } from './project/files.mjs';
import { parseJsonObject } from './project/json.mjs';
import { argv, linuxPath, linuxTool, safe } from './validation/inputs.mjs';
import { provisionWslLauncher } from './wsl-launcher.mjs';
import {
  absolutePath, appendExclude, assertDirectory, checkedExecutable, childDirectory, failure,
  plainDirectory, publishRule, readChecked, removeMatching, removeMatchingRule, writeExclusive,
} from './wsl-registrations/files.mjs';
import { withNameLock } from './wsl-registrations/lock.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME_PREFIX = 'task-';
const LEASE = 'active.lease';
const RETIRED = 'retired';
const TASK = 'task.json';
const RECORD = 'registration.json';
const TASK_FIELDS = ['context', 'trusted', 'tool', 'args'];
const UNAVAILABLE_LOCAL_DATA = new Set(['WSL_LOCAL_APP_DATA_REQUIRED', 'EACCES', 'EPERM']);
const PROVISION_ERRORS = {
  WSL_LAUNCHER_WINDOWS_REQUIRED: 'WSL 전용 실행 파일을 생성하려면 Windows x64 또는 ARM64에서 실행하세요.',
  WSL_LAUNCHER_TOOL_REQUIRED: 'Windows 시스템 경로와 설치된 Windows용 Go, WSL, PowerShell 7, Node.js 실행 파일을 확인하세요.',
  WSL_LAUNCHER_INPUTS_INVALID: 'WSL 실행 파일에 사용할 등록 파일과 배포판·작업 경로를 확인한 뒤 미리보기를 다시 검토하세요.',
  WSL_LAUNCHER_LINUX_UNVERIFIED: '지정한 WSL 배포판이 실행되는지 확인하고 Linux 네이티브 파일 시스템의 실제 작업 디렉터리와 실행 파일을 지정하세요.',
  WSL_LAUNCHER_BUILD_FAILED: '설치된 Windows용 Go로 WSL 전용 실행 파일을 빌드할 수 없습니다. 로컬 Go 설치와 LOCALAPPDATA 쓰기 권한을 확인하세요.',
  WSL_LAUNCHER_INSTALLATION_INVALID: '설치본의 dist/cli.mjs, PowerShell 수집기, Windows 실행 파일을 확인하세요.',
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const ruleName = (name, id) => `windows-agent-devkit-wsl-${name}-${id}.rules`;
const ruleBytes = (executable) => Buffer.from(`prefix_rule(pattern = [${JSON.stringify(executable)}], decision = "allow")\n`);
const normalizedLinuxPath = (value) => linuxPath(value) && value.isWellFormed() && path.posix.normalize(value) === value;

function nameKey(name) {
  if (!safe(name, NAME)) throw failure('WSL_INVALID_NAME', 'WSL 작업 이름에는 영문자, 숫자, 하이픈, 밑줄을 사용하세요. 첫 글자는 영문자 또는 숫자여야 합니다.');
  return name.toLowerCase();
}

async function canonicalProject(projectPath) {
  const requested = absolutePath(projectPath);
  const canonical = requested && absolutePath(await realpath(requested).catch(() => null));
  const directory = canonical && await plainDirectory(canonical).catch(() => null);
  if (!directory) throw failure('WSL_INVALID_PROJECT', '기존 프로젝트의 로컬 절대 디렉터리를 지정하세요.');
  // realpath resolves project aliases and supplies the stored casing on Windows.
  return { ...directory, requested, key: sha256(canonical) };
}

function taskFromBytes(bytes) {
  try {
    const task = parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (task.context === 'wsl' && task.trusted === true && normalizedLinuxPath(task.tool) && linuxTool(task.tool)
      && argv(task.args) && task.args.length <= 107 && task.args.every((arg) => arg.isWellFormed() && !/[\r\n]/.test(arg))
      && Object.keys(task).length === TASK_FIELDS.length && TASK_FIELDS.every((key) => Object.hasOwn(task, key))) {
      return Object.freeze({ context: 'wsl', trusted: true, tool: task.tool, args: Object.freeze(task.args) });
    }
  } catch { /* The input and parser error can contain private arguments. */ }
  throw failure('WSL_INVALID_TASK', '작업 JSON에는 context "wsl", trusted true, Linux 절대 실행 경로 tool, 문자열 배열 args를 지정하세요.');
}

function confirmationFor(project, { name, distro, linuxCwd, version }, task) {
  return sha256(JSON.stringify([project.filename, name, distro, linuxCwd, task, version]));
}

async function selection(options) {
  const { name, distro, linuxCwd, version } = options;
  nameKey(name);
  if (!safe(distro) || !normalizedLinuxPath(linuxCwd) || !safe(version)) {
    throw failure('WSL_INVALID_TARGET', '배포판 이름, Linux 절대 작업 경로, 플러그인 버전을 지정하세요.');
  }
  const project = await canonicalProject(options.projectPath);
  let taskFile = absolutePath(options.taskFile);
  if (taskFile && inside(project.requested, taskFile)) {
    taskFile = path.join(project.filename, path.relative(project.requested, taskFile));
  }
  const taskDirectory = taskFile && await plainDirectory(path.dirname(taskFile));
  const input = taskDirectory && await readChecked(taskDirectory, path.basename(taskFile), MAX_BYTES);
  if (!input) throw failure('WSL_TASK_FILE_REQUIRED', '읽을 수 있는 일반 작업 JSON 파일의 절대 경로를 지정하세요.');
  const task = taskFromBytes(input.bytes);
  const target = { name, distro, linuxCwd, version };
  const summary = {
    projectPath: project.filename, ...target, confirmation: confirmationFor(project, target, task),
    task: { path: taskFile, tool: task.tool, argCount: task.args.length },
  };
  return { project, summary, task };
}

export async function previewWslRegistration(options) {
  return { state: 'review_required', ...(await selection(options)).summary };
}

async function gitRoot(project) {
  for (let folder = project.filename; ; folder = path.dirname(folder)) {
    if (await existingEntry(path.join(folder, '.git'))) return folder;
    if (path.dirname(folder) === folder) return null;
  }
}

async function registry(project, localAppData, platform, create = false) {
  if (platform !== 'win32') throw failure('WSL_WINDOWS_REQUIRED', 'Windows 호스트의 Node.js에서 WSL 등록 명령을 실행하세요.');
  const local = absolutePath(localAppData);
  const anchor = local && await plainDirectory(local);
  if (!anchor) throw failure('WSL_LOCAL_APP_DATA_REQUIRED', 'LOCALAPPDATA가 기존 로컬 사용자 데이터 디렉터리를 가리키는지 확인하세요.');
  const repo = await gitRoot(project);
  const store = path.join(local, 'WindowsAgentDevkit', 'approved-wsl');
  if (inside(repo ?? project.filename, store) || inside(store, project.filename)) {
    throw failure('WSL_STATE_INSIDE_PROJECT', 'WSL 등록 상태는 프로젝트와 Git 작업 트리 밖의 LOCALAPPDATA에 있어야 합니다.');
  }
  const product = await childDirectory(anchor, 'WindowsAgentDevkit', { create });
  const root = product && await childDirectory(product, 'approved-wsl', { create });
  return root && await childDirectory(root, project.key, { create });
}

async function listRegistry(project, localAppData, platform, userProfile) {
  const profile = platform === 'win32' && absolutePath(userProfile);
  const fallback = profile && path.join(profile, 'AppData', 'Local');
  if (!fallback || fallback.toLowerCase() === absolutePath(localAppData)?.toLowerCase()) {
    return registry(project, localAppData, platform);
  }

  let primaryError;
  try {
    const root = await registry(project, localAppData, platform);
    if (root) return root;
  } catch (error) {
    if (!UNAVAILABLE_LOCAL_DATA.has(error.code)) throw error;
    primaryError = error;
  }

  const root = await registry(project, fallback, platform).catch((error) => {
    if (error.code !== 'WSL_LOCAL_APP_DATA_REQUIRED') throw error;
    return null;
  });
  if (!root && primaryError) throw primaryError;
  return root;
}

function generation(project, key, id, directory) {
  // This marker is bound to one path and generation. An approval never reuses it.
  const leaseValue = sha256(JSON.stringify(['windows-agent-devkit-wsl-lease', project.key, key, id]));
  return { id, directory, leaseValue, lease: Buffer.from(leaseValue) };
}

async function currentGenerations(project, key, nameDir) {
  await assertDirectory(nameDir);
  const current = [];
  for (const id of (await readdir(nameDir.filename)).sort()) {
    if (!UUID.test(id)) continue;
    const directory = await childDirectory(nameDir, id);
    if (!directory) continue;
    const entry = generation(project, key, id, directory);
    const retired = await readChecked(directory, RETIRED, 64);
    if (!retired?.bytes.equals(entry.lease) || await readChecked(directory, LEASE, 64)) current.push(entry);
  }
  return current;
}

async function ruleDirectory(project, create = false) {
  const codex = await childDirectory(project, '.codex', { create });
  return codex && await childDirectory(codex, 'rules', { create });
}

async function excludeRule(project, filename) {
  try {
    const repo = await gitRoot(project);
    if (!repo) return false;
    const repoDir = await plainDirectory(repo);
    // Linked worktrees and repositories with redirected Git metadata use a .git file.
    const gitDir = await childDirectory(repoDir, '.git');
    if (!gitDir || await existingEntry(path.join(gitDir.filename, 'commondir'))) return false;
    const infoDir = await childDirectory(gitDir, 'info', { create: true });
    const relative = path.relative(repo, path.join(project.filename, '.codex', 'rules', filename));
    const literal = relative.split(path.sep).map((part) => part.replace(/[\\*?\[\]]/g, '\\$&')).join('/');
    await appendExclude(infoDir, `/${literal}\n`);
    return true;
  } catch { return false; }
}

async function verifyFile(directory, name, expected) {
  const current = await readChecked(directory, name, expected.length);
  if (!current?.bytes.equals(expected)) throw failure('WSL_REGISTRATION_CONFLICT', '등록을 준비하는 중 작업 또는 규칙 파일이 변경되었습니다.');
}

async function provisionGeneration(provision, plan, entry) {
  const { directory, leaseValue } = entry;
  const { project, summary, task } = plan;
  const fixture = await childDirectory(directory, 'fixture', { create: true, exclusive: true });
  const state = await childDirectory(directory, 'state', { create: true, exclusive: true });
  const fixedTask = jsonBytes(task);
  await writeExclusive(directory, TASK, fixedTask);
  let result;
  try {
    result = await provision({
      directory: directory.filename, fixturePath: fixture.filename, statePath: state.filename,
      taskPath: path.join(directory.filename, TASK), leasePath: path.join(directory.filename, LEASE), leaseValue,
      projectPath: project.filename, distro: summary.distro, linuxCwd: summary.linuxCwd, task, version: summary.version,
    });
  } catch (error) {
    const code = error?.code;
    if (typeof code === 'string' && Object.hasOwn(PROVISION_ERRORS, code)) {
      const tool = code === 'WSL_LAUNCHER_TOOL_REQUIRED' && typeof error.message === 'string'
        && /^WSL launcher provisioning requires an installed native (node|pwsh|wsl|go)\.exe\.$/.exec(error.message)?.[1];
      throw failure(code, tool ? `등록에 필요한 Windows용 ${tool}.exe 설치와 경로를 확인하세요.` : PROVISION_ERRORS[code]);
    }
    throw failure('WSL_PROVISION_FAILED', 'WSL 전용 실행 파일 생성에 실패했습니다. Windows에서 사용 가능한 로컬 Go 컴파일러와 WSL 설치를 확인하세요.');
  }
  await assertDirectory(fixture);
  await assertDirectory(state);
  await verifyFile(directory, TASK, fixedTask);
  const executable = (await checkedExecutable(directory, result?.executable)).filename;
  const { name, distro, linuxCwd, version, confirmation, task: taskSummary } = summary;
  const registration = {
    schemaVersion: 2, projectKey: project.key, id: entry.id, name, distro, linuxCwd, version,
    confirmation, taskFile: taskSummary.path, executable: path.relative(directory.filename, executable),
  };
  const record = jsonBytes({ ...registration, checksum: sha256(jsonBytes(registration)) });
  await writeExclusive(directory, RECORD, record);
  return { executable, fixedTask, record };
}

async function retire(entry) {
  const previous = await readChecked(entry.directory, RETIRED, 64);
  if (!previous) await writeExclusive(entry.directory, RETIRED, entry.lease);
  else if (!previous.bytes.equals(entry.lease)) throw failure('WSL_REGISTRATION_CONFLICT', 'WSL 등록의 해제 기록이 변경되었습니다.');
}

export async function registerWslTask(options, {
  provision = provisionWslLauncher, localAppData = process.env.LOCALAPPDATA, platform = process.platform,
} = {}) {
  if (options.execute !== true || !safe(options.confirm, HASH)) {
    throw failure('WSL_CONFIRMATION_REQUIRED', 'WSL 등록 미리보기를 검토한 뒤 --execute와 --confirm을 함께 지정하세요.');
  }
  const plan = await selection(options);
  const { project, summary } = plan;
  if (options.confirm !== summary.confirmation) {
    throw failure('WSL_CONFIRMATION_MISMATCH', 'WSL 등록 입력이 검토한 값과 다릅니다. 미리보기를 다시 생성하고 검토하세요.');
  }
  // Reject existing project-side links before creating any registration state.
  await ruleDirectory(project);
  const key = nameKey(summary.name);
  const root = await registry(project, localAppData, platform, true);
  const nameDir = await childDirectory(root, `${NAME_PREFIX}${key}`, { create: true });
  return withNameLock(nameDir, async () => {
    if ((await currentGenerations(project, key, nameDir)).length) {
      throw failure('WSL_NAME_IN_USE', '이 이름의 WSL 작업이 이미 등록되었거나 등록을 완료하지 못했습니다.');
    }
    const id = randomUUID();
    const directory = await childDirectory(nameDir, id, { create: true, exclusive: true });
    const entry = generation(project, key, id, directory);
    const filename = ruleName(summary.name, id);
    let rules, bytes, published = false;
    try {
      const { executable, fixedTask, record } = await provisionGeneration(provision, plan, entry);
      if (await readChecked(directory, LEASE, 64)) throw failure('WSL_REGISTRATION_CONFLICT', '규칙을 게시하기 전에 활성화 표식이 생성되었습니다.');
      rules = await ruleDirectory(project, true);
      bytes = ruleBytes(executable);
      await publishRule(rules, filename, bytes);
      published = true;
      const gitExcluded = await excludeRule(project, filename);
      await checkedExecutable(directory, executable);
      await verifyFile(directory, TASK, fixedTask);
      await verifyFile(directory, RECORD, record);
      await verifyFile(rules, filename, bytes);
      await writeExclusive(directory, LEASE, entry.lease);
      return { state: 'registered', ...summary, id, executable, rulePath: path.join(rules.filename, filename), gitExcluded };
    } catch (error) {
      // A failed registration retires only this generation. Disable its launcher first.
      const lease = await removeMatching(directory, LEASE, entry.lease).catch(() => 'conflict');
      if (published) await removeMatchingRule(rules, filename, bytes).catch(() => {});
      if (lease !== 'conflict') await retire(entry).catch(() => {});
      throw error;
    }
  });
}

async function registrationRecord(project, key, entry) {
  const record = await readChecked(entry.directory, RECORD, MAX_BYTES);
  if (!record) return null;
  let stored, checksum;
  try { ({ checksum, ...stored } = parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(record.bytes))); }
  catch { /* A torn record has no authority. */ }
  const legacy = stored?.schemaVersion === 1 && checksum === undefined && stored.executable === 'wsl-task.exe';
  const sealed = stored?.schemaVersion === 2 && safe(checksum, HASH) && checksum === sha256(jsonBytes(stored));
  if ((!legacy && !sealed) || stored.projectKey !== project.key || stored.id !== entry.id
    || !safe(stored.name, NAME) || nameKey(stored.name) !== key || !safe(stored.distro)
    || !normalizedLinuxPath(stored.linuxCwd) || !safe(stored.version)
    || !safe(stored.confirmation, HASH) || !absolutePath(stored.taskFile) || typeof stored.executable !== 'string') {
    throw failure('WSL_REGISTRATION_CONFLICT', 'WSL 등록 기록이 변경되었거나 불완전합니다.');
  }
  if (legacy) {
    const snapshot = await readChecked(entry.directory, TASK, MAX_BYTES);
    if (!snapshot || confirmationFor(project, stored, taskFromBytes(snapshot.bytes)) !== stored.confirmation) {
      throw failure('WSL_REGISTRATION_CONFLICT', '이전 WSL 등록 기록과 검토한 작업 파일이 일치하지 않습니다.');
    }
  }
  const executable = path.join(entry.directory.filename, stored.executable);
  if (!absolutePath(executable) || !inside(entry.directory.filename, executable)
    || path.relative(entry.directory.filename, executable) !== stored.executable || path.extname(executable).toLowerCase() !== '.exe') {
    throw failure('WSL_REGISTRATION_CONFLICT', 'WSL 등록 기록의 실행 파일 경로가 유효하지 않습니다.');
  }
  const { name, distro, linuxCwd, version, taskFile, confirmation } = stored;
  return { name, distro, linuxCwd, version, taskFile, confirmation, executable };
}

async function describeRegistration(project, key, entry) {
  const { id, directory, lease } = entry;
  const fallback = { state: 'conflict', name: key, id };
  try {
    const record = await registrationRecord(project, key, entry);
    if (!record) return { ...fallback, state: await readChecked(directory, LEASE, 64) ? 'conflict' : 'pending' };
    const { name, distro, linuxCwd, version, taskFile, executable, confirmation } = record;
    const fixedTask = await readChecked(directory, TASK, MAX_BYTES);
    const task = fixedTask && taskFromBytes(fixedTask.bytes);
    const rules = await ruleDirectory(project);
    const filename = ruleName(name, id);
    const expectedRule = ruleBytes(executable);
    const rule = rules && await readChecked(rules, filename, expectedRule.length);
    await checkedExecutable(directory, executable);
    if (!task || confirmationFor(project, record, task) !== confirmation || !rule?.bytes.equals(expectedRule)
      || !(await readChecked(directory, LEASE, 64))?.bytes.equals(lease)) return { ...fallback, name };
    return {
      state: 'active', id, name, distro, linuxCwd, version, executable, rulePath: rule.filename,
      task: { path: taskFile, tool: task.tool, argCount: task.args.length },
    };
  } catch { return fallback; }
}

export async function listWslTasks(options, dependencies = {}) {
  const { localAppData = process.env.LOCALAPPDATA, platform = process.platform, userProfile } = dependencies;
  const profile = userProfile ?? (Object.hasOwn(dependencies, 'localAppData') ? undefined : process.env.USERPROFILE);
  const project = await canonicalProject(options.projectPath);
  const root = await listRegistry(project, localAppData, platform, profile);
  const tasks = [];
  if (root) {
    await assertDirectory(root);
    for (const folder of (await readdir(root.filename)).sort()) {
      const key = folder.slice(NAME_PREFIX.length);
      if (!folder.startsWith(NAME_PREFIX) || !NAME.test(key) || key !== key.toLowerCase()) continue;
      try {
        const nameDir = await childDirectory(root, folder);
        if (!nameDir) continue;
        const current = await currentGenerations(project, key, nameDir);
        if (current.length > 1) tasks.push({ state: 'conflict', name: key });
        if (current.length === 1) tasks.push(await describeRegistration(project, key, current[0]));
      } catch { tasks.push({ state: 'conflict', name: key }); }
    }
  }
  return { state: 'listed', projectPath: project.filename, tasks };
}

export async function unregisterWslTask(options, { localAppData = process.env.LOCALAPPDATA, platform = process.platform } = {}) {
  if (options.execute !== true) throw failure('WSL_EXECUTE_REQUIRED', 'WSL 작업 등록을 해제하려면 --execute를 지정하세요.');
  const { name } = options;
  const key = nameKey(name);
  const project = await canonicalProject(options.projectPath);
  const root = await registry(project, localAppData, platform);
  const nameDir = root && await childDirectory(root, `${NAME_PREFIX}${key}`);
  const result = { projectPath: project.filename, name };
  if (!nameDir) return { state: 'not_found', ...result };
  return withNameLock(nameDir, async () => {
    const current = await currentGenerations(project, key, nameDir);
    if (!current.length) return { state: 'not_found', ...result };
    if (current.length !== 1) throw failure('WSL_REGISTRATION_CONFLICT', '한 이름에서 여러 WSL 등록 세대를 발견했습니다.');
    const [entry] = current;
    // Revoke stale cached approvals even if the rule or the metadata has changed.
    const lease = await removeMatching(entry.directory, LEASE, entry.lease);
    if (lease === 'conflict') return { state: 'conflict', ...result, id: entry.id, lease, rule: 'preserved' };
    let rule = { state: 'conflict' };
    try {
      const record = await registrationRecord(project, key, entry);
      if (record) {
        const rules = await ruleDirectory(project);
        rule = rules ? await removeMatchingRule(rules, ruleName(record.name, entry.id), ruleBytes(record.executable)) : { state: 'absent' };
      }
    } catch { /* Unknown rule bytes stay in place. */ }
    await retire(entry);
    return {
      state: rule.state === 'conflict' ? 'conflict' : 'revoked', ...result, id: entry.id, lease, rule: rule.state,
      ...(rule.recoveryPath ? { recoveryPath: rule.recoveryPath } : {}),
    };
  });
}
