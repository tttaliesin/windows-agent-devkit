import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diagnose } from '../src/doctor.mjs';

// On-demand real-host check. Uses installed runners; never installs or trusts tools.
export async function smokeTaskRunners({ root = fileURLToPath(new URL('../', import.meta.url)), diagnoseProject = diagnose } = {}) {
  const output = path.join(root, '.local', 'task-runners');
  await mkdir(output, { recursive: true });
  const fixture = await mkdtemp(path.join(output, 'fixture-'));
  assert.ok((await realpath(fixture)).startsWith(`${await realpath(output)}${path.sep}`));
  await mkdir(path.join(fixture, '.git'));
  const marker = `const fs = require('node:fs');
const tool = process.argv[2];
fs.writeFileSync(tool + '.marker.json', JSON.stringify({ tool, cwd: process.cwd(), autoInstall: process.env.MISE_AUTO_INSTALL ?? null, taskAutoInstall: process.env.MISE_TASK_RUN_AUTO_INSTALL ?? null, projectValue: process.env.DEVKIT_CHECK ?? null }));
`;
  const files = {
    'marker.cjs': marker,
    'mise.toml': '[tasks.check]\ndescription = "Controlled runner check"\nshell = "pwsh -NoLogo -NoProfile -Command"\nrun = "node ./marker.cjs mise"\n',
    'Taskfile.yml': 'version: "3"\ntasks:\n  check:\n    cmds:\n      - pwsh -NoLogo -NoProfile -Command "node ./marker.cjs task"\n',
    Justfile: 'set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]\n\ncheck:\n    node ./marker.cjs just\n',
    Makefile: '.PHONY: check\ncheck:\n\tnode ./marker.cjs make\n',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(fixture, name), text);
  const common = { projectPath: fixture, stateDir: path.join(output, 'state'), timeoutMs: 10000 };
  const diagnostic = await diagnoseProject(common);
  assert.equal(diagnostic.checks.length, 30);
  assert.deepEqual(new Set(diagnostic.taskRunners.declarations.map((item) => item.tool)), new Set(['mise', 'task', 'just', 'make']));
  const results = [];
  for (const tool of ['mise', 'task', 'just', 'make']) {
    const task = { context: 'native', trusted: true, tool, args: tool === 'mise' ? ['run', 'check'] : ['check'], env: { DEVKIT_CHECK: 'controlled-fixture', ...(tool === 'mise' ? { MISE_STATE_DIR: path.join(fixture, 'mise-state') } : {}) } };
    const taskFile = path.join(fixture, `${tool}.task.json`);
    await writeFile(taskFile, `${JSON.stringify(task, null, 2)}\n`);
    const report = await diagnoseProject({ ...common, execute: true, task });
    await writeFile(path.join(output, `${path.basename(fixture)}-${tool}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
    const executable = report.taskRunners.tools.find((item) => item.tool === tool);
    if (executable?.resolution === 'not_resolved') {
      assert.equal(report.task.status, 'fail');
      results.push({ tool, taskFile, status: 'unavailable', execution: report.task.execution, reason: report.task.reason });
      continue;
    }
    assert.equal(report.task.status, 'pass', `${tool}: ${report.task.reason}`);
    assert.equal(report.task.exitCode, 0);
    const observed = JSON.parse(await readFile(path.join(fixture, `${tool}.marker.json`), 'utf8'));
    assert.equal(observed.tool, tool);
    assert.equal(await realpath(observed.cwd), await realpath(fixture));
    assert.equal(observed.projectValue, 'controlled-fixture');
    if (tool === 'mise') {
      assert.equal(observed.autoInstall, '0');
      assert.equal(observed.taskAutoInstall, '0');
    }
    if (process.platform === 'win32') assert.equal(report.task.cleanup?.confirmed, true);
    results.push({ tool, taskFile, status: 'passed', version: executable?.version, execution: report.task.execution, cleanup: report.task.cleanup });
  }
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(path.join(fixture, name), 'utf8'), text, `Source preserved: ${name}`);
  const result = { fixture, pluginVersion: diagnostic.pluginVersion, diagnostics: { ids: diagnostic.checks.length, recommendation: diagnostic.taskRunners.recommendation }, results };
  await writeFile(path.join(output, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.stdout.write(`${JSON.stringify(await smokeTaskRunners())}\n`);
