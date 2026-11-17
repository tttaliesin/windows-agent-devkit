import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['src/cli.mjs'], outfile: 'dist/cli.mjs',
  platform: 'node', target: 'node24', format: 'esm', bundle: true,
  banner: { js: 'import { createRequire as __devkitCreateRequire } from "node:module"; const require = __devkitCreateRequire(import.meta.url);' },
  legalComments: 'eof', sourcemap: false,
});
process.stdout.write('설치용 CLI 번들 빌드 완료: dist/cli.mjs\n');
