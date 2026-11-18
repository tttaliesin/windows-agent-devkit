import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { provisionWslLauncher } from '../src/wsl-launcher.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const enabled = process.platform === 'win32' && process.env.WINDOWS_DEVKIT_TEST_WSL_LAUNCHER === '1';

test('native WSL launcher binds the frozen task, context and lease', {
  skip: !enabled && 'enable with WINDOWS_DEVKIT_TEST_WSL_LAUNCHER=1 on Windows with Go, PowerShell and Ubuntu-24.04',
  timeout: 240000,
}, async (t) => {
  const tmp = await realpath(tmpdir());
  const scratch = await mkdtemp(join(tmp, 'windows-devkit-launcher-test-'));
  t.after(async () => {
    if (await realpath(scratch) === scratch && dirname(scratch) === tmp) {
      await rm(scratch, { recursive: true, force: true, maxRetries: 4 });
    }
  });
  const projectPath = join(scratch, 'sample project');
  const directory = join(scratch, 'protected registration');
  const fixturePath = join(directory, 'fixture');
  const statePath = join(directory, 'state');
  const taskPath = join(directory, 'task.json');
  const leasePath = join(directory, 'lease');
  await mkdir(projectPath);
  await mkdir(directory);
  await Promise.all([mkdir(fixturePath), mkdir(statePath)]);

  const distro = 'Ubuntu-24.04';
  const wsl = (program, args) => run(join(process.env.SystemRoot, 'System32', 'wsl.exe'),
    ['--distribution', distro, '--cd', '/', '--exec', program, ...args],
    { cwd: tmp, maxBuffer: 16384, timeout: 15000, windowsHide: true });
  const linuxCwd = (await wsl('/usr/bin/mktemp', ['-d', '/tmp/windows-devkit-test.XXXXXXXX'])).stdout.trim();
  assert.match(linuxCwd, /^\/tmp\/windows-devkit-test\.[A-Za-z0-9]{8}$/);
  const tool = `${linuxCwd}/native-sh`;
  await wsl('/usr/bin/ln', ['-s', '--', '/usr/bin/sh', tool]);
  try {
    const marker = 'test-only private argv "marker"';
    const task = {
      context: 'wsl', trusted: true, tool,
      args: ['-c', 'test "$(/usr/bin/pwd -P)" = "$1" && test -z "${DEVKIT_LAUNCHER_TEST_VALUE-}" && printf "%s" "$2"',
        'sh', linuxCwd, marker],
    };
    await writeFile(taskPath, JSON.stringify(task), { flag: 'wx' });
    const taskBytes = await readFile(taskPath);
    const { stdout: versionOutput } = await run(process.execPath, [cli, '--version']);
    const version = versionOutput.trim();
    const leaseValue = 'test-lease-검증\n';
    const options = { directory, projectPath, fixturePath, statePath, taskPath, leasePath, leaseValue, distro, linuxCwd, task, version };
    const windowsMount = `/mnt/${process.env.SystemDrive[0].toLowerCase()}`;
    await assert.rejects(provisionWslLauncher({ ...options, linuxCwd: windowsMount }), { code: 'WSL_LAUNCHER_LINUX_UNVERIFIED' });

    const { executable } = await provisionWslLauncher(options);
    assert.equal(dirname(executable), await realpath(directory));
    const env = { ...process.env, NODE_OPTIONS: '--invalid-for-devkit-test',
      WSLENV: 'DEVKIT_LAUNCHER_TEST_VALUE/u', DEVKIT_LAUNCHER_TEST_VALUE: marker };
    const invoke = (args = [], cwd = projectPath) => run(executable, args,
      { cwd, env, timeout: 110000, maxBuffer: 16384, windowsHide: true });
    await assert.rejects(invoke(), { code: 1, stdout: '', stderr: 'The WSL task lease is missing or changed.\n' });
    await writeFile(leasePath, leaseValue, { flag: 'wx' });
    await assert.rejects(invoke([marker]), { code: 2, stdout: '', stderr: 'This WSL task launcher accepts no arguments.\n' });
    await assert.rejects(invoke([], scratch), { code: 1, stdout: '', stderr: 'Run this WSL task from its registered Windows project directory.\n' });

    const { stdout, stderr } = await invoke();
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), {
      pluginVersion: version, checkId: 'WSL-02', status: 'pass', cliExitCode: 0, verified: true,
      context: { distro, cwd: linuxCwd, os: 'Linux' },
      task: { phase: 'task', status: 'pass', execution: 'succeeded', exitCode: 0 },
    });

    await writeFile(taskPath, Buffer.concat([taskBytes, Buffer.from(' ')]));
    await assert.rejects(invoke(), { code: 1, stdout: '', stderr: 'A pinned WSL launcher input is missing or changed.\n' });
    await writeFile(taskPath, taskBytes);
    await wsl('/usr/bin/ln', ['-sfn', '--', '/usr/bin/true', tool]);
    await assert.rejects(invoke(), { code: 1, stdout: '', stderr: 'The registered Linux working directory or executable could not be verified.\n' });

    await writeFile(leasePath, leaseValue.trimEnd());
    await assert.rejects(invoke(), { code: 1, stdout: '', stderr: 'The WSL task lease is missing or changed.\n' });
    await unlink(leasePath);
    await assert.rejects(invoke(), { code: 1, stdout: '', stderr: 'The WSL task lease is missing or changed.\n' });
  } finally {
    await wsl('/usr/bin/rm', ['-f', '--', tool]);
    await wsl('/usr/bin/rmdir', ['--', linuxCwd]);
  }
});
