import { createHash, randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonObject } from '../project/json.mjs';
import {
  assertDirectory, childDirectory, failure, publishRule, readChecked, removeEmptyDirectory, removeMatching, writeExclusive,
} from './files.mjs';
import { withNameLock } from './lock.mjs';

const DIRECTORY = 'project-runner-v1';
const EXECUTABLE = 'wsl-run.exe';
const RECORD = 'runner.json';
const MAX_EXECUTABLE = 32 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

export const RUNNER_RULE = 'windows-agent-devkit-wsl-runner.rules';
export const runnerExecutable = (registryPath) => path.join(registryPath, DIRECTORY, EXECUTABLE);
export const ruleBytes = (executable) => Buffer.from(`prefix_rule(pattern = [${JSON.stringify(executable)}], decision = "allow")\n`);
export const runnerDirectory = (root) => childDirectory(root, DIRECTORY);
export const dispatchFile = (id) => `${id}.json`;
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

const conflict = () => failure('WSL_RUNNER_CONFLICT', '프로젝트 고정 실행기나 허용 규칙이 변경되었거나 불완전합니다. 기존 파일을 확인하세요.');
const pin = (bytes) => ({ size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') });

function validPin(value) {
  return Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_EXECUTABLE
    && typeof value.hash === 'string' && HASH.test(value.hash);
}

export function validDispatchEntry(value, key) {
  return value && Object.keys(value).length === 4 && value.schemaVersion === 1 && value.name === key && validPin(value);
}

export async function dispatchEntry(directory, key) {
  const file = await readChecked(directory, 'wsl-task.exe', MAX_EXECUTABLE);
  if (!file?.bytes.length) throw conflict();
  return { schemaVersion: 1, name: key, ...pin(file.bytes) };
}

async function checkRunner(directory, projectKey) {
  const record = await readChecked(directory, RECORD, 1024);
  const binary = await readChecked(directory, EXECUTABLE, MAX_EXECUTABLE);
  let metadata;
  try { metadata = record && parseJsonObject(record.bytes.toString('utf8')); }
  catch { throw conflict(); }
  if (!metadata || Object.keys(metadata).length !== 4 || metadata.schemaVersion !== 1 || metadata.projectKey !== projectKey
    || !validPin(metadata) || binary?.info.size !== metadata.size || pin(binary.bytes).hash !== metadata.hash) throw conflict();
}

export async function readProjectRunner(root, project, rules) {
  const directory = await runnerDirectory(root);
  const rule = rules && await readChecked(rules, RUNNER_RULE, 4096);
  if (!directory && rule) throw conflict();
  if (!directory) return null;
  await checkRunner(directory, project.key);
  const executable = runnerExecutable(root.filename);
  const expected = ruleBytes(executable);
  if (!rule?.bytes.equals(expected)) throw conflict();
  return { directory, executable, rulePath: rule.filename };
}

async function prepareRunner(root, project, provision) {
  const staging = await childDirectory(root, `.runner-${randomUUID()}.tmp`, { create: true, exclusive: true });
  let binary, metadata, published = false;
  try {
    const result = await provision({ directory: staging.filename, registryPath: root.filename, projectPath: project.filename });
    binary = await readChecked(staging, EXECUTABLE, MAX_EXECUTABLE);
    if (!binary?.bytes.length || result?.executable !== binary.filename) throw conflict();
    metadata = jsonBytes({ schemaVersion: 1, projectKey: project.key, ...pin(binary.bytes) });
    await writeExclusive(staging, RECORD, metadata);
    await checkRunner(staging, project.key);
    await assertDirectory(root);
    await rename(staging.filename, path.join(root.filename, DIRECTORY));
    published = true;
  } finally {
    if (!published) {
      if (metadata) await removeMatching(staging, RECORD, metadata).catch(() => {});
      if (binary) await removeMatching(staging, EXECUTABLE, binary.bytes).catch(() => {});
      await removeEmptyDirectory(staging).catch(() => {});
    }
  }
}

export async function installProjectRunner(root, project, rules, provision) {
  return withNameLock(root, async () => {
    const expected = ruleBytes(runnerExecutable(root.filename));
    const rule = await readChecked(rules, RUNNER_RULE, 4096);
    const directory = await runnerDirectory(root);
    // A cached rule must never resolve to a replacement binary at the same path.
    if (rule && (!directory || !rule.bytes.equals(expected))) throw conflict();
    if (!directory) await prepareRunner(root, project, provision);
    await checkRunner(await runnerDirectory(root), project.key);
    if (!rule) await publishRule(rules, RUNNER_RULE, expected);
    return readProjectRunner(root, project, rules);
  });
}
