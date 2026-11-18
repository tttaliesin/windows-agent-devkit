import { randomUUID } from 'node:crypto';
import { readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { assertDirectory, childDirectory, failure, readChecked, removeEmptyDirectory, removeMatching, writeExclusive } from './files.mjs';

const LOCK = 'mutation.lock';
const OWNER = /^owner-([1-9]\d{0,9})-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MARKER = Buffer.from('windows-agent-devkit-wsl-mutation-lock\n');
const EXISTING_DIRECTORY = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']);
const CHANGED_DIRECTORY = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST', 'WSL_UNSAFE_PATH']);

const busy = () => failure('WSL_REGISTRATION_BUSY', '이 이름의 WSL 작업 등록 또는 해제 잠금을 안전하게 확보하지 못했습니다.');

function ownerExited(pid) {
  if (pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  return false;
}

async function removeEmptyLock(directory) {
  try { await removeEmptyDirectory(directory); }
  catch (error) {
    if (!CHANGED_DIRECTORY.has(error.code)) throw error;
  }
}

async function recoverLock(lock) {
  try {
    await assertDirectory(lock);
    const entries = await readdir(lock.filename);
    if (entries.length === 1) {
      const [name] = entries;
      const owner = OWNER.exec(name);
      if (!owner || !ownerExited(Number(owner[1]))) throw busy();
      const marker = await readChecked(lock, name, MARKER.length);
      if (marker && !marker.bytes.equals(MARKER)) throw busy();
      if (await removeMatching(lock, name, MARKER) === 'conflict') throw busy();
    } else if (entries.length !== 0) {
      throw busy();
    }
    // A contender can race cleanup, but a newly acquired lock already has its own marker.
    await removeEmptyLock(lock);
  } catch (error) {
    if (!CHANGED_DIRECTORY.has(error.code)) throw error;
  }
}

export async function withNameLock(directory, action) {
  const id = randomUUID();
  const owner = `owner-${process.pid}-${id}`;
  let owned = await childDirectory(directory, `.mutation-${id}.tmp`, { create: true, exclusive: true });
  const target = path.join(directory.filename, LOCK);
  try {
    // Publish only after the owner is durable, so an interrupted publisher does not leave an ownerless lock.
    await writeExclusive(owned, owner, MARKER);
    for (let attempt = 0; attempt < 5; attempt++) {
      await assertDirectory(directory);
      try { await rename(owned.filename, target); }
      catch (error) {
        if (!EXISTING_DIRECTORY.has(error.code)) throw error;
        const lock = await childDirectory(directory, LOCK);
        if (!lock) {
          if (error.code === 'EPERM' || error.code === 'EACCES') throw error;
          continue;
        }
        await recoverLock(lock);
        continue;
      }
      owned = { ...owned, filename: target };
      await assertDirectory(owned);
      return await action();
    }
    throw busy();
  } finally {
    let disposition;
    try { disposition = await removeMatching(owned, owner, MARKER); }
    catch (error) {
      if (!CHANGED_DIRECTORY.has(error.code)) throw error;
    }
    if (disposition === 'removed' || disposition === 'absent') await removeEmptyLock(owned);
  }
}
