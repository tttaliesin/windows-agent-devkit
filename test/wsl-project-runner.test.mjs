import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const childSource = `package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	_, inherited := os.LookupEnv("DEVKIT_TEST_CALLER")
	json.NewEncoder(os.Stdout).Encode(map[string]any{
		"args": os.Args[1:], "cwd": cwd,
		"fixed": os.Getenv("DEVKIT_TEST_FIXED"), "inherited": inherited,
	})
	fmt.Fprintln(os.Stderr, "fixture child stderr")
	if _, err := os.Stat("exit-37"); err == nil {
		os.Exit(37)
	}
}
`;

test('native WSL project runner dispatches only verified active generations', {
  skip: (process.platform !== 'win32' || !arch) && 'requires Windows x64 or ARM64',
  timeout: 240000,
}, async (t) => {
  const temp = await realpath(tmpdir());
  const scratch = await mkdtemp(join(temp, 'devkit-project-runner-'));
  const created = await lstat(scratch);
  t.after(async () => {
    const current = await lstat(scratch);
    if (dirname(scratch) === temp && await realpath(scratch) === scratch && current.isDirectory()
      && current.dev === created.dev && current.ino === created.ino) {
      await rm(scratch, { recursive: true, force: true, maxRetries: 4 });
    }
  });

  const goOptions = {
    cwd: scratch, timeout: 180000, windowsHide: true,
    env: {
      ...process.env, GOOS: 'windows', GOARCH: arch, CGO_ENABLED: '0', GOFLAGS: '',
      GOENV: 'off', GOTOOLCHAIN: 'local', GO111MODULE: 'off', GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off',
      GOCACHE: join(scratch, 'cache'), GOPATH: join(scratch, 'gopath'), GOTMPDIR: scratch,
      GOTELEMETRYDIR: join(scratch, 'telemetry'),
    },
  };
  let version;
  try {
    ({ stdout: version } = await run('go.exe', ['version'], goOptions));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('requires an installed Windows Go toolchain');
    return;
  }
  const parsed = /^go version go(\d+)\.(\d+)(?:\.\d+)? windows\/\w+$/.exec(version.trim());
  if (!parsed || Number(parsed[1]) === 1 && Number(parsed[2]) < 20) {
    t.skip('requires Windows Go 1.20 or later');
    return;
  }

  const id = 'f9a5fbca-f8ba-4069-87eb-cc945be98330';
  const name = 'check_build-1';
  const project = join(scratch, 'sample project');
  const registry = join(scratch, 'protected & registry \u2028 data', sha256(project));
  const runnerDir = join(registry, 'project-runner-v1');
  const generation = join(registry, `task-${name}`, id);
  await Promise.all([mkdir(project), mkdir(runnerDir, { recursive: true }), mkdir(generation, { recursive: true })]);

  const source = join(scratch, 'main.go');
  const bindings = join(scratch, 'bindings.go');
  const childMain = join(scratch, 'child.go');
  const runner = join(runnerDir, 'wsl-run.exe');
  const executable = join(generation, 'wsl-task.exe');
  const descriptorPath = join(runnerDir, `${id}.json`);
  const leasePath = join(generation, 'active.lease');
  const binding = {
    project, dispatcher: { registry },
    environment: [`SystemRoot=${process.env.SystemRoot}`, 'DEVKIT_TEST_FIXED=from binding'],
  };
  await Promise.all([
    copyFile(new URL('../scripts/wsl-task-launcher.go', import.meta.url), source),
    writeFile(bindings, `package main\n\nconst bindingJSON = ${JSON.stringify(JSON.stringify(binding))}\n`),
    writeFile(childMain, childSource),
  ]);
  const build = (output, ...files) => run('go.exe', ['build', '-trimpath', '-buildvcs=false', '-o', output, ...files], goOptions);
  await build(runner, source, bindings);
  await build(executable, childMain);

  const childBytes = await readFile(executable);
  const descriptor = { schemaVersion: 1, name, size: childBytes.length, hash: sha256(childBytes) };
  const descriptorJSON = JSON.stringify(descriptor);
  const lease = sha256(JSON.stringify(['windows-agent-devkit-wsl-lease', basename(registry), name, id]));
  await Promise.all([writeFile(descriptorPath, descriptorJSON), writeFile(leasePath, lease)]);

  const invoke = (args = [id], cwd = project) => run(runner, args, {
    cwd, timeout: 10000, windowsHide: true,
    env: { ...process.env, DEVKIT_TEST_CALLER: 'from caller', DEVKIT_TEST_FIXED: 'from caller' },
  });
  const rejected = (stderr, args = [id], cwd = project, code = 1) =>
    assert.rejects(invoke(args, cwd), { code, stdout: '', stderr });
  const childOutput = ({ stdout, stderr }) => {
    assert.deepEqual(JSON.parse(stdout), { args: [], cwd: project, fixed: 'from binding', inherited: false });
    assert.equal(stderr, 'fixture child stderr\n');
    return true;
  };

  await t.test('passes child stdout, stderr, and both zero and nonzero exit statuses', async () => {
    childOutput(await invoke());
    const exitMarker = join(project, 'exit-37');
    await writeFile(exitMarker, '');
    try {
      await assert.rejects(invoke(), (error) => error.code === 37 && childOutput(error));
    } finally {
      await unlink(exitMarker);
    }
  });

  await t.test('rejects missing, extra, and invalid arguments and the wrong directory', async () => {
    for (const args of [[], [id, 'extra'], ['invalid'], [id.toUpperCase()], [id.replace('-4069-', '-5069-')],
      [id.replace('-87eb-', '-77eb-')], [`${id}\n`]]) {
      await rejected(/exactly one lowercase version 4 UUID/, args, project, 2);
    }
    await rejected(/from its registered Windows project directory/, [id], scratch);
  });

  await t.test('rejects unknown IDs, missing descriptors, and missing or changed leases', async () => {
    await rejected(/descriptor is missing or invalid/, ['f9a5fbca-f8ba-4069-87eb-cc945be98331']);
    await unlink(descriptorPath);
    try {
      await rejected(/descriptor is missing or invalid/);
    } finally {
      await writeFile(descriptorPath, descriptorJSON);
    }
    await unlink(leasePath);
    try {
      await rejected(/lease is missing or changed/);
      await writeFile(leasePath, lease.toUpperCase());
      await rejected(/lease is missing or changed/);
    } finally {
      await writeFile(leasePath, lease);
    }
  });

  await t.test('rejects malformed, oversized, and nonconforming descriptors', async () => {
    try {
      for (const invalid of [
        '{', `${descriptorJSON}\n{}`, `${descriptorJSON}${' '.repeat(4096)}`,
        JSON.stringify({ ...descriptor, executable }), JSON.stringify({ ...descriptor, name: name.toUpperCase() }),
        descriptorJSON.replace('"name":', '"Name":'), `{"name":"${name}",${descriptorJSON.slice(1)}`,
      ]) {
        await writeFile(descriptorPath, invalid);
        await rejected(/descriptor is missing or invalid/);
      }
    } finally {
      await writeFile(descriptorPath, descriptorJSON);
    }
  });

  await t.test('rejects same-sized content changes and changed lengths before running the child', async () => {
    const modified = Buffer.from(childBytes);
    modified[0x20] ^= 1; // Reserved DOS header byte. The PE image and its length stay intact.
    try {
      for (const bytes of [modified, Buffer.concat([childBytes, Buffer.from(' ')])]) {
        await writeFile(executable, bytes);
        await rejected(/launcher is missing or changed/);
      }
    } finally {
      await writeFile(executable, childBytes);
    }
  });

  await t.test('rejects a launcher that is already open for writing', async () => {
    const writer = await open(executable, 'r+');
    try {
      await rejected(/launcher is missing or changed/);
    } finally {
      await writer.close();
    }
  });

  await t.test('rejects hard links to the descriptor, launcher, and lease', async (subtest) => {
    const alias = join(scratch, 'hardlink');
    for (const [path, stderr] of [[descriptorPath, /descriptor/], [executable, /launcher/], [leasePath, /lease/]]) {
      try {
        await link(path, alias);
      } catch (error) {
        if (!['ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
        subtest.skip('temporary filesystem does not support hard links');
        return;
      }
      try {
        await rejected(stderr);
      } finally {
        await unlink(alias);
      }
    }
  });

  await t.test('rejects a junction at the generation directory', async (subtest) => {
    const moved = join(dirname(generation), 'moved');
    await rename(generation, moved);
    try {
      try {
        await symlink(moved, generation, 'junction');
      } catch (error) {
        if (!['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
        subtest.skip(`junction creation unavailable (${error.code})`);
        return;
      }
      try {
        await rejected(/task directories are missing or changed/);
      } finally {
        await unlink(generation);
      }
    } finally {
      await rename(moved, generation);
    }
  });
});
