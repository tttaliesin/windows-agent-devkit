import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageData = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(await readFile(resolve(root, 'plugin.json'), 'utf8'));
assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.match(plugin.name, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
assert.ok(plugin.name.length <= 64 && !plugin.name.includes('--') && !plugin.name.includes('..'));
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
assert.equal(plugin.name, packageData.name);
assert.equal(plugin.version, packageData.version);
assert.ok(!packageData.dependencies && !packageData.devDependencies);
for (const key of ['skills', 'mcpServers', 'apps', 'interface']) assert.ok(!(key in plugin), `portable manifest: ${key}`);

const skillPath = resolve(root, 'skills/environment-doctor/SKILL.md');
const skill = await readFile(skillPath, 'utf8');
assert.match(skill, /^---\nname: environment-doctor\ndescription: \S[^\n]*\n---\n/);
assert.ok(Buffer.byteLength(skill) <= 1024 * 1024);
await readFile(resolve(root, 'src/cli.mjs'));
await readFile(resolve(root, 'scripts/collect-host.ps1'));
await readFile(resolve(dirname(skillPath), '../../docs/diagnostic-cli.md'));

const files = ['README.md', 'AGENTS.md', 'package.json', 'plugin.json', ...await readdir(resolve(root, 'docs')).then((names) => names.filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`))];
for (const directory of ['src', 'scripts', 'test']) {
  for (const name of await readdir(resolve(root, directory))) {
    if (/\.(mjs|ps1)$/.test(name)) files.push(`${directory}/${name}`);
  }
}
files.push('skills/environment-doctor/SKILL.md', '.github/workflows/test.yml');
let links = 0;
for (const file of files) {
  const text = await readFile(resolve(root, file), 'utf8');
  assert.ok(text.endsWith('\n'), `마지막 줄바꿈: ${file}`);
  assert.ok(!text.includes('\r'), `LF: ${file}`);
  assert.ok(!/[\u3040-\u30ff]|\u65e2\u5b58/.test(text), `의도하지 않은 문구: ${file}`);
  if (!file.endsWith('.md')) continue;
  assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `코드 블록: ${file}`);
  for (const match of text.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:|^#/i.test(match[1])) continue;
    await readFile(resolve(dirname(resolve(root, file)), match[1].split('#')[0]));
    links++;
  }
  for (const match of text.matchAll(/^```json\n([\s\S]*?)^```/gm)) JSON.parse(match[1]);
}
process.stdout.write(`플러그인 기본 형식·Skill·참조 파일·문서 링크 ${links}개 검사 통과\n`);
