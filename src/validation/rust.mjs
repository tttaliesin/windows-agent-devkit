import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from './cleanup.mjs';
import { safe } from './inputs.mjs';
import { ok, text } from './query.mjs';
import { outcome, selectedTask, step } from './steps.mjs';

const TARGET = /^[a-zA-Z0-9_]+(?:-[a-zA-Z0-9_]+){2,5}$/;

function requestedTargets(project, options, fallback) {
  const declared = project?.requirements?.rust?.metadata?.targets;
  if (options.rustTargets != null) return options.rustTargets;
  if (options.rustTarget) return [options.rustTarget];
  return declared?.length ? declared : fallback;
}

export function rustScope(project, options) {
  const targets = requestedTargets(project, options, []);
  return { targets: Array.isArray(targets) ? targets.filter((target) => safe(target, TARGET)) : [] };
}

export async function validateRust(entry, { project, options, call, projectPath }) {
  const env = { RUSTUP_AUTO_INSTALL: '0', CARGO_NET_OFFLINE: 'true' };
  const compiler = await call('rustc', ['-vV'], { cwd: projectPath, env });
  if (!ok(compiler)) {
    step(entry, 'compiler', outcome(compiler.state), compiler.state, '선택한 Rust 컴파일러의 host를 조회하지 못했습니다.');
    return;
  }
  const host = text(compiler.stdout).match(/^host:\s*(\S+)\s*$/m)?.[1];
  if (!safe(host, TARGET)) {
    step(entry, 'compiler', 'unknown', 'host_unknown', 'Rust host triple을 확인하지 못했습니다.');
    return;
  }
  entry.host = host;
  const targets = requestedTargets(project, options, [host]);
  if (!Array.isArray(targets) || !targets.length || targets.length > 16 || !targets.every((target) => safe(target, TARGET))) {
    step(entry, 'target', 'fail', 'invalid_target', 'Rust target은 명시적인 triple 배열이어야 합니다.'); return;
  }
  await temporary(async (directory) => {
    const source = path.join(directory, 'readiness.rs');
    await writeFile(source, 'fn main() { std::process::exit(0); }\n');
    for (const target of new Set(targets)) {
      const abi = target.endsWith('-windows-msvc') ? 'msvc' : target.endsWith('-windows-gnu') ? 'gnu' : null;
      if (!abi) {
        step(entry, 'link', 'unknown', 'unsupported_target', '이 검증은 Windows MSVC·GNU target의 링크 준비 상태만 확인합니다.', { target }); continue;
      }
      const output = path.join(directory, `${target}.exe`);
      const result = await call('rustc', ['--crate-name', 'devkit_readiness', '--edition=2021', '--target', target, '--emit=link', source, '-o', output], { cwd: directory, env });
      const artifact = ok(result) && await stat(output).then((value) => value.isFile() && value.size > 0, () => false);
      const failure = /E0463|target may not be installed|can't find crate for [`'](?:std|core)/i.test(text(result.stderr)) ? 'target_not_installed'
        : /linker.*not found|link\.exe.*not found|cannot find.*(?:kernel32|ucrt|msvcrt)|LNK1104/i.test(text(result.stderr)) ? 'linker_sdk_unavailable' : result.state;
      step(entry, 'link', artifact ? 'pass' : ok(result) ? 'unknown' : outcome(result.state), artifact ? 'fixture_linked' : failure,
        artifact ? '생성한 최소 Rust 소스의 링크 산출물을 확인했습니다.' : '해당 target의 링크 산출물을 확인하지 못했습니다.',
        { target, abi, linker: abi === 'msvc' ? 'MSVC compatible' : 'GNU compatible', windowsSdk: abi === 'msvc' ? (artifact ? 'link_verified' : 'unverified') : 'not_applicable', artifactVerified: Boolean(artifact) });
    }
  });
  if (entry.steps.every((item) => item.status === 'pass')) await selectedTask('rust', entry, call, options, projectPath);
}
