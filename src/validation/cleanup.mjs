import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function temporary(action) {
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
