import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existingEntry, inside } from '../project/files.mjs';

const WINDOWS = process.platform === 'win32';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

const unsafePath = () => failure('WSL_UNSAFE_PATH', 'WSL 등록 경로의 링크, 파일 형식 또는 대상을 안전하게 확인할 수 없습니다.');
const sameEntry = (a, b) => a?.ino === b.ino && a.dev === b.dev;
const samePath = (a, b) => WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;

export function absolutePath(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 32767 || /[\x00-\x1f]/.test(value)
    || !path.isAbsolute(value)) return null;
  if (WINDOWS && (!/^[a-z]:[\\/]/i.test(value) || value.slice(3).split(/[\\/]/).some((part) =>
    part !== '.' && part !== '..' && (/[<>:"|?*]|[. ]$/.test(part) || DEVICE.test(part))))) return null;
  return path.resolve(value);
}

export async function plainDirectory(filename) {
  const info = await existingEntry(filename);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(filename), filename)) throw unsafePath();
  return { filename, info };
}

export async function assertDirectory(directory) {
  const current = await plainDirectory(directory.filename);
  if (!sameEntry(current?.info, directory.info)) throw unsafePath();
}

export async function childDirectory(parent, name, { create = false, exclusive = false } = {}) {
  const filename = path.join(parent.filename, name);
  await assertDirectory(parent);
  if (create) {
    try { await mkdir(filename, { mode: 0o700 }); }
    catch (error) { if (exclusive || error.code !== 'EEXIST') throw error; }
  }
  const directory = await plainDirectory(filename);
  if (create && !directory) throw unsafePath();
  return directory;
}

export async function removeEmptyDirectory(directory) {
  await assertDirectory(directory);
  await rmdir(directory.filename);
}

async function fileEntry(parent, name) {
  await assertDirectory(parent);
  const filename = path.join(parent.filename, name);
  const info = await existingEntry(filename);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || !samePath(await realpath(filename), filename))) throw unsafePath();
  return { filename, info };
}

const unchanged = (before, after) => sameEntry(after, before) && after.nlink === 1
  && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs;

export async function readChecked(parent, name, limit) {
  const { filename, info } = await fileEntry(parent, name);
  if (!info) return null;
  if (info.size > limit) throw unsafePath();
  const handle = await open(filename, constants.O_RDONLY | NOFOLLOW);
  try {
    if (!unchanged(info, await handle.stat())) throw unsafePath();
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size || !unchanged(info, await handle.stat())
      || !unchanged(info, (await fileEntry(parent, name)).info)) throw unsafePath();
    return { bytes: bytes.subarray(0, offset), info, filename };
  } finally { await handle.close(); }
}

export async function writeExclusive(parent, name, bytes) {
  await assertDirectory(parent);
  const filename = path.join(parent.filename, name);
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    if (!sameEntry((await fileEntry(parent, name)).info, await handle.stat())) throw unsafePath();
  } finally { await handle.close(); }
}

export async function publishRule(parent, name, bytes) {
  const staging = `.windows-agent-devkit-${randomUUID()}.tmp`;
  await writeExclusive(parent, staging, bytes);
  const prepared = await readChecked(parent, staging, bytes.length);
  if (!prepared?.bytes.equals(bytes)) throw unsafePath();
  try { await link(prepared.filename, path.join(parent.filename, name)); }
  finally {
    // The temporary hard link is our entry. The published file must have one link.
    await assertDirectory(parent);
    if (sameEntry(await existingEntry(prepared.filename), prepared.info)) await unlink(prepared.filename);
  }
}

export async function removeMatching(parent, name, bytes) {
  const current = await readChecked(parent, name, Math.max(4096, bytes.length));
  if (!current) return 'absent';
  if (!current.bytes.equals(bytes) || !unchanged(current.info, (await fileEntry(parent, name)).info)) return 'conflict';
  await unlink(current.filename);
  return 'removed';
}

export async function removeMatchingRule(parent, name, bytes) {
  const current = await readChecked(parent, name, Math.max(4096, bytes.length));
  if (!current) return { state: 'absent' };
  if (!current.bytes.equals(bytes)) return { state: 'conflict' };

  const holding = await childDirectory(parent, `.windows-agent-devkit-${randomUUID()}.tmp`, { create: true, exclusive: true });
  const capturedPath = path.join(holding.filename, 'rule');
  let captured = false;
  try {
    if (!unchanged(current.info, (await fileEntry(parent, name)).info)) return { state: 'conflict' };
    await assertDirectory(holding);
    await rename(current.filename, capturedPath);
    captured = true;
    const moved = await readChecked(holding, 'rule', Math.max(4096, bytes.length));
    if (sameEntry(moved?.info, current.info) && moved.bytes.equals(bytes)
      && await removeMatching(holding, 'rule', bytes) === 'removed') {
      captured = false;
      return { state: await existingEntry(current.filename) ? 'conflict' : 'removed' };
    }
    // A concurrent edit may have replaced the path between the comparison and move.
    // Restore it exclusively and keep the capture if another writer has recreated the path.
    if (moved) {
      await assertDirectory(parent);
      await link(capturedPath, current.filename);
      if (sameEntry(await existingEntry(current.filename), moved.info)
        && sameEntry(await existingEntry(capturedPath), moved.info)) {
        await unlink(capturedPath);
        captured = false;
      }
    }
    return { state: 'conflict', ...(captured ? { recoveryPath: capturedPath } : {}) };
  } catch { return { state: 'conflict', ...(captured ? { recoveryPath: capturedPath } : {}) }; }
  finally { if (!captured) await removeEmptyDirectory(holding).catch(() => {}); }
}

export async function checkedExecutable(directory, executable) {
  const filename = absolutePath(executable);
  if (!filename || !inside(directory.filename, filename) || path.extname(filename).toLowerCase() !== '.exe') throw unsafePath();
  const parts = path.relative(directory.filename, filename).split(path.sep);
  const leaf = parts.pop();
  let parent = directory;
  for (const part of parts) {
    parent = await childDirectory(parent, part);
    if (!parent) throw unsafePath();
  }
  const file = await fileEntry(parent, leaf);
  if (!file.info || file.info.size === 0) throw unsafePath();
  return file;
}

export async function appendExclude(infoDir, line) {
  let entry = await fileEntry(infoDir, 'exclude');
  if (!entry.info) {
    try { await writeExclusive(infoDir, 'exclude', line); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    entry = await fileEntry(infoDir, 'exclude');
    if (!entry.info) throw unsafePath();
  }
  const { filename, info } = entry;
  const handle = await open(filename, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.nlink !== 1 || !sameEntry(opened, info) || !sameEntry((await fileEntry(infoDir, 'exclude')).info, info)) throw unsafePath();
    await handle.writeFile(`\n${line}`);
    await handle.sync();
  } finally { await handle.close(); }
}
