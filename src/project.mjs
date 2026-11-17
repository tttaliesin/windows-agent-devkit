import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

const LANGUAGES = ['node', 'python', 'go', 'rust', 'zig', 'dotnet'];
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 4096;
const MAX_FILES = 128;
const UNKNOWN = Symbol('지원하지 않는 정적 표현');
const has = (object, key) => Object.hasOwn(object, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => [...new Set(values)];

const NODE_LOCKS = {
  'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun',
};
const PYTHON_LOCKS = { 'uv.lock': 'uv', 'poetry.lock': 'poetry', 'Pipfile.lock': 'pipenv' };
const ALIASES = Object.assign(Object.create(null), { node: 'node', nodejs: 'node', python: 'python', go: 'go', golang: 'go', rust: 'rust', zig: 'zig', dotnet: 'dotnet' });
const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^v?\d+(?:\.\d+){0,2}$/;
const GO_VERSION = /^1\.\d+(?:\.\d+)?(?:(?:rc|beta)\d+)?$/;
const RUST_CHANNEL = /^(?:stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?(?:-(?:x86_64|i686|aarch64)-(?:pc-windows-(?:msvc|gnu)|unknown-linux-(?:gnu|musl)|apple-darwin))?$/;

function classifyVersion(value, language, channels = false) {
  if (typeof value !== 'string' || value.length > 160 || value.trim() !== value || !value) return null;
  if (EXACT.test(value)) return 'exact';
  if (PARTIAL.test(value)) return 'range';
  if (channels && (
    (language === 'rust' && RUST_CHANNEL.test(value)) ||
    value === 'latest' ||
    (language === 'node' && /^(?:stable|current|node|lts|lts\/\*|lts\/-\d+)$/.test(value)) ||
    (language === 'node' && /^lts\/(?:argon|boron|carbon|dubnium|erbium|fermium|gallium|hydrogen|iron|jod|krypton)$/.test(value))
  )) return 'channel';
  // Only recognize a small, explicit version grammar; URLs, templates and shell text never enter reports.
  const atom = language === 'python'
    ? '(?:\\d+(?:\\.(?:\\d+|\\*)){0,2}(?:(?:a|b|rc)\\d+)?|\\*)'
    : '(?:v?\\d+(?:\\.(?:\\d+|[xX*])){0,2}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?|[xX*])';
  const operators = language === 'python' ? '(?:~=|==|!=|>=|<=|>|<|\\^|~|=)?' : '(?:>=|<=|>|<|\\^|~|=)?';
  const term = new RegExp(`^${operators}\\s*${atom}$`);
  const alternatives = value.split('||');
  if (alternatives.every((alternative) => {
    if (new RegExp(`^\\s*${atom}\\s+-\\s+${atom}\\s*$`).test(alternative)) return language !== 'python';
    const terms = alternative.trim().replace(/([><=~^!]+)\s+(?=[v\d*xX])/g, '$1').split(/[\s,]+/);
    return terms.length > 0 && terms.every((part) => term.test(part));
  })) return 'range';
  return null;
}

function splitOutside(text, delimiter) {
  const parts = [];
  let quote = '', depth = 0, start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (!depth && char === delimiter) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function tomlString(text) {
  if (text.startsWith('"""') || text.startsWith("'''")) return UNKNOWN;
  if (/^'[^'\r\n]*'$/.test(text)) return text.slice(1, -1);
  if (text[0] !== '"' || text.at(-1) !== '"') throw new Error();
  try { return JSON.parse(text); } catch { throw new Error(); }
}

function tomlKey(text) {
  return splitOutside(text, '.').map((part) => {
    const key = part.trim();
    if (/^[\w-]+$/.test(key)) return key;
    const decoded = tomlString(key);
    if (typeof decoded !== 'string' || !decoded || decoded.includes('\0')) throw new Error();
    return decoded;
  });
}

function tomlValue(raw, depth = 0) {
  if (depth > 16) return UNKNOWN;
  const text = raw.trim();
  if (text.startsWith('"') || text.startsWith("'")) return tomlString(text);
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^[+-]?\d+(?:_\d+)*(?:\.\d+)?$/.test(text)) return Number(text.replaceAll('_', ''));
  if (text.startsWith('[') && text.endsWith(']')) {
    const items = splitOutside(text.slice(1, -1), ',');
    if (!items.at(-1).trim()) items.pop();
    return items.map((item) => tomlValue(item, depth + 1));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const result = Object.create(null);
    const fields = splitOutside(text.slice(1, -1), ',');
    if (fields.length === 1 && !fields[0].trim()) return result;
    for (const field of fields) {
      const pair = splitOutside(field, '=');
      if (pair.length !== 2) return UNKNOWN;
      const keys = tomlKey(pair[0]);
      if (keys.length !== 1 || has(result, keys[0])) return UNKNOWN;
      result[keys[0]] = tomlValue(pair[1], depth + 1);
    }
    return result;
  }
  // A few legal TOML scalars outside the fields we use remain opaque.
  if (/^[+-]?(?:inf|nan|\d[\d_]*(?:\.[\d_]+)?[eE][+-]?[\d_]+)$/.test(text) ||
      /^0[xob][0-9a-fA-F_]+$/.test(text) || /^\d{4}-\d\d-\d\d(?:[Tt ][\d:.+-]+[Zz]?)?$/.test(text)) return UNKNOWN;
  throw new Error();
}

// A bounded TOML reader, not a TOML evaluator.
// Multiline strings are kept opaque so their contents cannot masquerade as declarations.
function parseToml(text) {
  const statements = [];
  let current = '', quote = '', triple = false, depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"') { current += text[++index] ?? ''; continue; }
      if (triple && text.slice(index, index + 3) === quote.repeat(3)) {
        current += quote.repeat(2); index += 2; quote = ''; triple = false;
      } else if (!triple && char === quote) quote = '';
      else if (!triple && (char === '\n' || char === '\r')) throw new Error();
      continue;
    }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      index -= 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char; triple = text.slice(index, index + 3) === char.repeat(3);
      if (triple) { current += char.repeat(2); index += 2; }
    }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
    if (depth < 0 || depth > 32) throw new Error();
    if (char === '\n' && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += char;
  }
  if (quote || depth) throw new Error();
  if (current.trim()) statements.push(current.trim());
  if (statements.length > 4096) throw new Error();
  const values = new Map(), tables = [], explicitTables = new Set();
  let section = [], arrayIndex = 0;
  const keyOf = (keys) => keys.join('\0');
  const put = (keys, value) => {
    const key = keyOf(keys);
    if (values.has(key)) throw new Error();
    for (let size = 1; size < keys.length; size += 1) {
      if (values.has(keyOf(keys.slice(0, size)))) throw new Error();
    }
    if ([...values.keys()].some((other) => other.startsWith(`${key}\0`))) throw new Error();
    values.set(key, value);
  };
  for (const statement of statements) {
    if (statement.startsWith('[')) {
      const array = statement.startsWith('[[');
      const close = array ? ']]' : ']';
      if (!statement.endsWith(close)) throw new Error();
      section = tomlKey(statement.slice(array ? 2 : 1, -close.length));
      const key = keyOf(section);
      if (!array && explicitTables.has(key)) throw new Error();
      if (values.has(key)) throw new Error();
      if (!array) explicitTables.add(key);
      tables.push(section);
      if (array) section = [...section, `#${arrayIndex++}`];
      continue;
    }
    const assignment = splitOutside(statement, '=');
    // The first '=' separates a key and value; later '=' may belong to an opaque expression.
    if (assignment.length < 2) throw new Error();
    put([...section, ...tomlKey(assignment.shift())], tomlValue(assignment.join('=')));
  }
  return {
    entries: [...values.entries()].map(([key, value]) => ({ keys: key.split('\0'), value })),
    tables,
    get(...keys) {
      for (let size = keys.length; size > 0; size -= 1) {
        const key = keyOf(keys.slice(0, size));
        if (!values.has(key)) continue;
        let value = values.get(key);
        for (const part of keys.slice(size)) {
          if (!object(value) || !has(value, part)) return undefined;
          value = value[part];
        }
        return value;
      }
      return undefined;
    },
    contains(...keys) {
      const prefix = keyOf(keys);
      return tables.some((table) => keyOf(table) === prefix || keyOf(table).startsWith(`${prefix}\0`)) ||
        [...values.keys()].some((key) => key === prefix || key.startsWith(`${prefix}\0`));
    },
  };
}

function description(name) {
  if (name === '.gitattributes' || name === '.editorconfig') return {};
  if (name === 'package.json') return { languages: ['node'], parser: 'node' };
  if (has(NODE_LOCKS, name)) return { languages: ['node'], manager: NODE_LOCKS[name], lock: true };
  if (name === '.nvmrc' || name === '.node-version') return { languages: ['node'], parser: 'pin' };
  if (name === 'pyproject.toml') return { languages: ['python'], parser: 'python' };
  if (has(PYTHON_LOCKS, name)) return { languages: ['python'], manager: PYTHON_LOCKS[name], lock: true };
  if (/^requirements[^/\\]*\.txt$/i.test(name) || name === 'Pipfile') return { languages: ['python'], manager: name === 'Pipfile' ? 'pipenv' : 'pip' };
  if (name === '.python-version') return { languages: ['python'], parser: 'pin' };
  if (/^environment\.ya?ml$/.test(name)) return { languages: ['python'], manager: 'conda', parser: 'conda' };
  if (name === 'go.mod' || name === 'go.work') return { languages: ['go'], manager: 'go', parser: 'go' };
  if (name === '.go-version') return { languages: ['go'], parser: 'pin' };
  if (name === 'go.sum' || name === 'go.work.sum') return { languages: ['go'], integrity: true };
  if (name === 'Cargo.toml') return { languages: ['rust'], manager: 'cargo', parser: 'cargo' };
  if (name === 'Cargo.lock') return { languages: ['rust'], manager: 'cargo', lock: true };
  if (name === 'rust-toolchain' || name === 'rust-toolchain.toml') return { languages: ['rust'], parser: 'rust' };
  if (name === '.zig-version') return { languages: ['zig'], parser: 'pin' };
  if (name === 'build.zig.zon') return { languages: ['zig'], parser: 'zig' };
  if (name === 'build.zig') return { languages: ['zig'] };
  if (name === 'global.json') return { languages: ['dotnet'], parser: 'dotnet' };
  if (/\.(?:csproj|sln|slnx)$/i.test(name)) return { languages: ['dotnet'], manager: 'nuget' };
  if (name === 'mise.toml' || name === '.mise.toml') return { languages: LANGUAGES, parser: 'mise', shared: true };
  if (name === '.tool-versions') return { languages: LANGUAGES, parser: 'tools', shared: true };
  if (/^(?:Dockerfile(?:\.[\w.-]+)?|(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml|\.devcontainer\.json|\.devcontainer\/devcontainer\.json)$/.test(name)) return { environment: 'containers' };
  if (/^process-compose(?:\.[\w.-]+)?\.ya?ml$/.test(name)) return { environment: 'processCompose' };
  return null;
}

/** Discover declarations at the requested root without running project or tool code. */
export async function analyzeProject(projectPath) {
  const requirements = Object.fromEntries(LANGUAGES.map((language) => [language, {
    state: 'not_required', versionRequests: [], packageManagers: [], lockFiles: [], metadata: {}, notes: [],
  }]));
  const result = { root: null, requirements, environment: { containers: 'not_required', processCompose: 'not_required' }, files: [], issues: [] };
  const issue = (source, message) => {
    if (!result.issues.some((entry) => entry.source === source && entry.message === message)) result.issues.push({ source, message });
  };
  const mark = (language) => {
    if (requirements[language].state !== 'unknown') requirements[language].state = 'required';
  };
  const unknown = (languages, source, message) => {
    for (const language of languages) requirements[language].state = 'unknown';
    issue(source, message);
  };
  const note = (language, text) => { requirements[language].notes.push(text); };
  const manager = (language, name, source, version) => {
    requirements[language].packageManagers.push({ name, source, ...(version ? { version } : {}) });
  };
  const request = (language, source, field, value, options = {}) => {
    const kind = classifyVersion(value, language, options.channels);
    if (!kind || (options.validate && !options.validate(value))) {
      unknown([language], source, `${field} 필드의 버전 표현을 정적으로 해석할 수 없습니다.`);
      return;
    }
    mark(language);
    requirements[language].versionRequests.push({ source, field, kind: options.kind ?? kind, value });
  };
  const packageVersion = (language, name, source, field, version) => {
    const kind = classifyVersion(version, language);
    if (!kind) { unknown([language], source, `${field} 필드의 도구 버전 표현을 해석할 수 없습니다.`); return; }
    const metadata = requirements[language].metadata;
    (metadata.packageManagerRequests ??= []).push({ name, source, field, kind, value: version });
  };
  const asToml = (text, languages, source) => {
    try { return parseToml(text); } catch {
      unknown(languages, source, 'TOML 선언의 문법이 잘못되었거나 지원하는 정적 분석 범위를 벗어났습니다.');
      return null;
    }
  };
  const asJson = (text, languages, source) => {
    try {
      const value = JSON.parse(text);
      if (!object(value)) throw new Error();
      // JSON.parse accepts duplicate keys; keep ambiguous declarations unknown instead of choosing the last one.
      const stack = [];
      const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '{') stack.push(new Set());
        else if (token === '[') stack.push(null);
        else if (token === '}' || token === ']') stack.pop();
        else if (token.startsWith('"') && tokens[index + 1] === ':') {
          const key = JSON.parse(token), keys = stack.at(-1);
          if (!keys || keys.has(key)) throw new Error();
          keys.add(key);
        }
      }
      return value;
    } catch {
      unknown(languages, source, 'JSON 선언을 객체로 읽을 수 없습니다.');
      return null;
    }
  };

  function nodeDeclaration(text, source) {
    const data = asJson(text, ['node'], source);
    if (!data) return;
    if (has(data, 'engines')) {
      if (!object(data.engines)) unknown(['node'], source, 'engines 필드의 형식을 확인할 수 없습니다.');
      else {
        if (has(data.engines, 'node')) request('node', source, 'engines.node', data.engines.node);
        for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
          if (has(data.engines, name)) { manager('node', name, source); packageVersion('node', name, source, `engines.${name}`, data.engines[name]); }
        }
      }
    }
    if (has(data, 'packageManager')) {
      const match = typeof data.packageManager === 'string' && data.packageManager.match(/^(npm|pnpm|yarn|bun)@([^+]+)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/);
      if (!match || !EXACT.test(match[2])) unknown(['node'], source, 'packageManager 필드의 관리자 또는 고정 버전 형식을 지원하지 않습니다.');
      else {
        manager('node', match[1], source, classifyVersion(match[2], 'node') ? match[2] : undefined);
        packageVersion('node', match[1], source, 'packageManager', match[2]);
      }
    }
    if (!has(data, 'devEngines')) return;
    if (!object(data.devEngines)) { unknown(['node'], source, 'devEngines 필드의 형식을 확인할 수 없습니다.'); return; }
    for (const field of ['runtime', 'packageManager']) {
      if (!has(data.devEngines, field)) continue;
      const list = Array.isArray(data.devEngines[field]) ? data.devEngines[field] : [data.devEngines[field]];
      if (!list.length || list.length > 32) { unknown(['node'], source, 'devEngines 선언 목록의 형식을 지원하지 않습니다.'); continue; }
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index], key = `devEngines.${field}${Array.isArray(data.devEngines[field]) ? `[${index}]` : ''}`;
        const names = field === 'runtime' ? ['node'] : ['npm', 'pnpm', 'yarn', 'bun'];
        if (!object(entry) || !names.includes(entry.name)) { unknown(['node'], source, `${key} 필드의 도구 선언을 지원하지 않습니다.`); continue; }
        const policy = entry.onFail ?? 'error';
        if (!['warn', 'error', 'ignore'].includes(policy)) unknown(['node'], source, `${key}.onFail 필드의 정책을 지원하지 않습니다.`);
        (requirements.node.metadata.devEngines ??= []).push({ field: key, name: entry.name, onFail: ['warn', 'error', 'ignore'].includes(policy) ? policy : 'unknown' });
        if (field === 'packageManager') manager('node', entry.name, source, classifyVersion(entry.version, 'node') ? entry.version : undefined);
        if (has(entry, 'version')) {
          if (field === 'runtime') request('node', source, `${key}.version`, entry.version);
          else packageVersion('node', entry.name, source, `${key}.version`, entry.version);
        }
      }
    }
  }

  function pythonDeclaration(text, source) {
    const data = asToml(text, ['python'], source);
    if (!data) return;
    const version = data.get('project', 'requires-python');
    if (version !== undefined) request('python', source, 'project.requires-python', version);
    const project = data.get('project');
    if (project !== undefined && !object(project)) unknown(['python'], source, 'project 필드의 테이블 형식을 확인할 수 없습니다.');
    const dynamic = data.get('project', 'dynamic');
    if (dynamic !== undefined && (!Array.isArray(dynamic) || !dynamic.every((item) => typeof item === 'string'))) unknown(['python'], source, 'project.dynamic 필드의 문자열 목록을 확인할 수 없습니다.');
    if (dynamic === UNKNOWN || (Array.isArray(dynamic) && dynamic.includes('requires-python'))) unknown(['python'], source, '동적으로 정하는 requires-python 요구는 실행 없이 확인할 수 없습니다.');
    const poetry = data.get('tool', 'poetry', 'dependencies', 'python');
    if (poetry !== undefined) request('python', source, 'tool.poetry.dependencies.python', object(poetry) ? poetry.version : poetry);
    const tools = ['uv', 'poetry', 'pdm', 'hatch', 'rye'].filter((name) => data.contains('tool', name));
    for (const name of tools) manager('python', name, source);
    if (tools.length) requirements.python.metadata.tools = tools;
    const uvVersion = data.get('tool', 'uv', 'required-version');
    if (uvVersion !== undefined) packageVersion('python', 'uv', source, 'tool.uv.required-version', uvVersion);
    const backend = data.get('build-system', 'build-backend');
    if (typeof backend === 'string') {
      const known = ['poetry.core.masonry.api', 'pdm.backend', 'hatchling.build', 'setuptools.build_meta', 'setuptools.build_meta:__legacy__', 'uv_build'];
      if (known.includes(backend)) requirements.python.metadata.buildBackend = backend;
    }
  }

  function pin(text, source, language) {
    const lines = text.split(/\r?\n/).map((line) => line.replace(/\s*#.*$/, '').trim()).filter(Boolean);
    if (!lines.length || (language !== 'python' && lines.length !== 1) || lines.length > 32) {
      unknown([language], source, '버전 파일의 단일 선언 또는 지원하는 버전 목록을 확인할 수 없습니다.'); return;
    }
    for (const value of lines) request(language, source, 'version', value, { channels: true });
    if (lines.length > 1) note(language, '여러 인터프리터 선언을 보존했으며 실제 선택 순서는 확인하지 않았습니다.');
  }

  function goDeclaration(text, source) {
    // Keep line boundaries while making quoted paths and comments opaque.
    let stripped = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index], pair = text.slice(index, index + 2);
      if (pair === '//') {
        while (index < text.length && text[index] !== '\n') index += 1;
        stripped += '\n';
      } else if (pair === '/*') {
        const end = text.indexOf('*/', index + 2);
        if (end < 0) { unknown(['go'], source, 'Go 선언의 주석이 완결되지 않았습니다.'); return; }
        stripped += ' ' + text.slice(index, end + 2).replace(/[^\n]/g, '');
        index = end + 1;
      } else if (char === '"' || char === '`') {
        const quote = char;
        let closed = false;
        for (index += 1; index < text.length; index += 1) {
          if (text[index] === '\\' && quote === '"') { index += 1; continue; }
          if (text[index] === quote) { closed = true; break; }
          if (quote === '"' && /[\r\n]/.test(text[index])) break;
        }
        if (!closed) { unknown(['go'], source, 'Go 선언의 문자열이 완결되지 않았습니다.'); return; }
        stripped += '"정적문자열"';
      } else stripped += char;
    }
    let block = false;
    const seen = new Set();
    for (const raw of stripped.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (block) { if (line === ')') block = false; continue; }
      if (/^(?:require|exclude|replace|retract|use|tool|godebug)\s*\($/.test(line)) { block = true; continue; }
      const match = line.match(/^(go|toolchain)(?:\s+(.*))?$/);
      if (!match) {
        if (/^module\s+\S+$/.test(line) && source === 'go.mod') {
          if (seen.has('module')) unknown(['go'], source, 'module 지시문이 중복되어 있습니다.');
          seen.add('module');
        } else if (!/^(?:require|exclude|replace|retract|use|tool|godebug)\s+\S/.test(line)) unknown(['go'], source, 'Go 선언에서 지원하지 않거나 잘못된 최상위 지시문을 발견했습니다.');
        continue;
      }
      if (seen.has(match[1])) unknown(['go'], source, '동일한 Go 도구 모음 지시문이 중복되어 있습니다.');
      seen.add(match[1]);
      const value = match[2] ?? '';
      if (match[1] === 'go') request('go', source, 'go', value, { kind: 'minimum', validate: (item) => GO_VERSION.test(item) });
      else if (value === 'default') requirements.go.metadata.toolchainDefault = true;
      else if (/^go/.test(value) && GO_VERSION.test(value.slice(2))) {
        requirements.go.versionRequests.push({ source, field: 'toolchain', kind: 'preferred', value });
      } else unknown(['go'], source, 'toolchain 필드의 선호 Go 도구 모음 표현을 지원하지 않습니다.');
    }
    if (block) unknown(['go'], source, 'Go 선언의 블록이 완결되지 않았습니다.');
    if ((source === 'go.mod' && !seen.has('module')) || (source === 'go.work' && !seen.has('go'))) unknown(['go'], source, 'Go 선언의 필수 module 또는 go 지시문을 확인할 수 없습니다.');
    note('go', 'go 지시문은 최소 요구이며 toolchain 지시문은 선호 도구 모음입니다.');
  }

  function cargoDeclaration(text, source) {
    const data = asToml(text, ['rust'], source);
    if (!data) return;
    const minimum = (field, value) => request('rust', source, field, value, { kind: 'minimum', validate: (item) => /^\d+\.\d+(?:\.\d+)?$/.test(item) });
    const workspace = data.get('workspace', 'package', 'rust-version');
    if (workspace !== undefined) minimum('workspace.package.rust-version', workspace);
    const value = data.get('package', 'rust-version');
    const inherited = data.get('package', 'rust-version', 'workspace');
    if (inherited === true) {
      requirements.rust.metadata.workspaceRustVersion = true;
      if (workspace === undefined) unknown(['rust'], source, '상위 작업 공간의 rust-version 요구는 현재 루트에서 확인할 수 없습니다.');
    } else if (value !== undefined) minimum('package.rust-version', value);
    else if (inherited !== undefined) unknown(['rust'], source, 'rust-version 작업 공간 상속 표현을 지원하지 않습니다.');
  }

  function rustDeclaration(text, source) {
    if (source === 'rust-toolchain' && !text.trimStart().startsWith('[')) { pin(text, source, 'rust'); return; }
    const data = asToml(text, ['rust'], source);
    if (!data) return;
    if (!data.contains('toolchain')) { unknown(['rust'], source, 'toolchain 테이블을 확인할 수 없습니다.'); return; }
    const channel = data.get('toolchain', 'channel');
    const customPath = data.get('toolchain', 'path');
    if (['channel', 'path', 'components', 'targets', 'profile'].every((field) => data.get('toolchain', field) === undefined)) unknown(['rust'], source, 'toolchain 테이블에서 지원하는 도구 모음 속성을 확인할 수 없습니다.');
    if (channel !== undefined) request('rust', source, 'toolchain.channel', channel, { channels: true });
    if (customPath !== undefined) unknown(['rust'], source, '사용자 지정 Rust 경로의 버전은 정적으로 확인하지 않습니다.');
    for (const field of ['components', 'targets']) {
      const value = data.get('toolchain', field);
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && /^[\w-]{1,100}$/.test(item))) unknown(['rust'], source, `toolchain.${field} 필드의 형식을 지원하지 않습니다.`);
      else requirements.rust.metadata[field] = value;
    }
    const profile = data.get('toolchain', 'profile');
    if (profile !== undefined) {
      if (['minimal', 'default', 'complete'].includes(profile)) requirements.rust.metadata.profile = profile;
      else unknown(['rust'], source, 'toolchain.profile 필드의 프로필을 지원하지 않습니다.');
    }
    if (channel === undefined) note('rust', '도구 모음 버전 선택에는 기본값 또는 외부 설정의 확인이 필요합니다.');
  }

  function zigDeclaration(text, source) {
    // ZON is data, but do not interpret Zig expressions or search dependency subobjects.
    const tokens = text.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[A-Za-z_][\w]*|\s+|./gs) ?? [];
    const significant = tokens.filter((token) => !/^\s|^\/\//.test(token) && !token.startsWith('/*'));
    if (significant[0] !== '.' || significant[1] !== '{' || significant.at(-1) !== '}') {
      unknown(['zig'], source, 'ZON 선언의 최상위 객체를 확인할 수 없습니다.'); return;
    }
    let depth = 0, count = 0;
    const brackets = [], pairs = { '}': '{', ']': '[', ')': '(' };
    for (let index = 0; index < significant.length; index += 1) {
      const token = significant[index];
      if (token === '"') { unknown(['zig'], source, 'ZON 선언의 문자열이 완결되지 않았습니다.'); return; }
      if (token === '{' || token === '[' || token === '(') { depth += 1; brackets.push(token); }
      if (token === '}' || token === ']' || token === ')') {
        depth -= 1;
        if (brackets.pop() !== pairs[token]) { unknown(['zig'], source, 'ZON 선언의 괄호가 일치하지 않습니다.'); return; }
      }
      if (depth < 0) break;
      if (depth !== 1 || token !== '.' || significant[index + 1] !== 'minimum_zig_version') continue;
      count += 1;
      const valueToken = significant[index + 3], end = significant[index + 4];
      if (significant[index + 2] !== '=' || !valueToken?.startsWith('"') || ![',', '}'].includes(end)) {
        unknown(['zig'], source, 'minimum_zig_version 필드의 정적 문자열 표현을 지원하지 않습니다.'); continue;
      }
      let value;
      try { value = JSON.parse(valueToken); } catch { value = UNKNOWN; }
      request('zig', source, 'minimum_zig_version', value, { kind: 'minimum', validate: (item) => EXACT.test(item) });
    }
    if (depth || count > 1) unknown(['zig'], source, 'ZON 선언의 중괄호 또는 중복 최소 버전을 확인해야 합니다.');
  }

  function dotnetDeclaration(text, source) {
    const data = asJson(text, ['dotnet'], source);
    if (!data) return;
    note('dotnet', 'SDK 선택과 대상 런타임은 별개이며 상위 폴더의 global.json은 조회하지 않았습니다.');
    if (!has(data, 'sdk')) return;
    if (!object(data.sdk)) { unknown(['dotnet'], source, 'sdk 필드의 객체 형식을 확인할 수 없습니다.'); return; }
    const sdk = data.sdk, options = {};
    if (has(sdk, 'version')) {
      request('dotnet', source, 'sdk.version', sdk.version, { kind: 'sdk', validate: (item) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item) });
      if (typeof sdk.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(sdk.version)) options.version = sdk.version;
    }
    if (has(sdk, 'rollForward')) {
      const policies = ['patch', 'feature', 'minor', 'major', 'latestPatch', 'latestFeature', 'latestMinor', 'latestMajor', 'disable'];
      if (!policies.includes(sdk.rollForward) || (!has(sdk, 'version') && sdk.rollForward !== 'latestMajor')) unknown(['dotnet'], source, 'sdk.rollForward 필드의 정책 또는 필수 버전을 확인할 수 없습니다.');
      else options.rollForward = sdk.rollForward;
    }
    if (has(sdk, 'allowPrerelease')) {
      if (typeof sdk.allowPrerelease !== 'boolean') unknown(['dotnet'], source, 'sdk.allowPrerelease 필드의 불리언 형식을 확인할 수 없습니다.');
      else options.allowPrerelease = sdk.allowPrerelease;
    }
    if (has(sdk, 'paths')) {
      // Keep local path options, never URLs, credentials or expanded environment values.
      const safe = (item) => typeof item === 'string' && item.length > 0 && item.length <= 240 &&
        !/[\x00-\x1f@?{}]|:\/\//.test(item) && (item === '$host$' || !/[$%]/.test(item));
      if (!Array.isArray(sdk.paths) || sdk.paths.length > 32 || !sdk.paths.every(safe)) unknown(['dotnet'], source, 'sdk.paths 필드에 지원하지 않는 경로 표현이 있습니다.');
      else options.paths = sdk.paths;
    }
    requirements.dotnet.metadata.sdk = options;
  }

  function miseDeclaration(text, source) {
    const data = asToml(text, LANGUAGES, source);
    if (!data) return;
    if (data.contains('include')) unknown(LANGUAGES, source, 'mise 외부 포함 선언은 따라가지 않으므로 추가 요구를 확인할 수 없습니다.');
    const entries = new Map();
    for (const entry of data.entries) {
      if (entry.keys[0] !== 'tools' || entry.keys.length < 2) continue;
      const key = entry.keys[1];
      let value = data.get('tools', key);
      if (value === undefined) {
        value = Object.create(null);
        for (const nested of data.entries.filter((item) => item.keys[0] === 'tools' && item.keys[1] === key)) {
          if (nested.keys.length !== 3) { value = UNKNOWN; break; }
          value[nested.keys[2]] = nested.value;
        }
      }
      entries.set(key, value);
    }
    for (const table of data.tables) if (table[0] === 'tools' && table.length > 1 && !entries.has(table[1])) entries.set(table[1], UNKNOWN);
    const inline = data.get('tools');
    if (inline !== undefined) {
      if (!object(inline)) unknown(LANGUAGES, source, 'mise tools 필드의 정적 테이블 형식을 지원하지 않습니다.');
      else for (const [key, value] of Object.entries(inline)) entries.set(key, value);
    }
    for (const [key, value] of entries) {
      const language = ALIASES[key.split(':').at(-1)];
      if (!language) continue;
      mark(language);
      (requirements[language].metadata.versionManagers ??= []).push('mise');
      if (key.includes(':')) { unknown([language], source, '명시적 mise 백엔드의 버전 해석은 지원하지 않습니다.'); continue; }
      const versions = Array.isArray(value) ? value : [value];
      if (!versions.length || versions.length > 32) { unknown([language], source, 'mise 버전 목록의 형식을 지원하지 않습니다.'); continue; }
      for (const item of versions) {
        const version = object(item) && Object.keys(item).every((field) => field === 'version') ? item.version : item;
        request(language, source, `tools.${key}`, version, { channels: true });
      }
    }
  }

  function toolVersions(text, source) {
    const seen = new Set();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s*#.*$/, '').trim();
      if (!line) continue;
      const [key, ...versions] = line.split(/\s+/), language = ALIASES[key];
      if (!language) continue;
      mark(language);
      (requirements[language].metadata.versionManagers ??= []).push('asdf');
      if (seen.has(language)) unknown([language], source, '같은 언어의 .tool-versions 선언이 중복되어 있습니다.');
      seen.add(language);
      if (!versions.length || versions.length > 32) unknown([language], source, '.tool-versions 버전 목록의 형식을 지원하지 않습니다.');
      for (const version of versions.slice(0, 32)) request(language, source, key, version, { channels: true });
    }
  }

  function condaDeclaration(text, source) {
    // Only a plain dependency list's Python entry is interpreted; channels and pip options stay private.
    let dependencies = false, indentation = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, '');
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (/^\S/.test(line) && !/^(?:[\w-]+\s*:|---\s*$|\.\.\.\s*$|\{\s*\}\s*$)/.test(line)) unknown(['python'], source, 'Conda 선언의 최상위 YAML 필드 형식을 지원하지 않습니다.');
      if (/^dependencies:\s*(?:#.*)?$/.test(line)) { dependencies = true; continue; }
      if (/^dependencies\s*:/.test(line)) {
        if (!/^dependencies:\s*\[\s*\]\s*$/.test(line)) unknown(['python'], source, 'Conda dependencies 필드의 인라인 또는 동적 표현을 지원하지 않습니다.');
        dependencies = false;
        continue;
      }
      if (!dependencies) continue;
      if (/^\S/.test(line)) { dependencies = false; continue; }
      const item = line.match(/^(\s+)-\s+/);
      if (item && !indentation) indentation = item[1].length;
      if (!item || item[1].length !== indentation) continue;
      let dependency = line.slice(item[0].length).trim();
      if (/^[&*!{[]/.test(dependency)) { unknown(['python'], source, 'Conda 의존성의 별칭 또는 구조 표현을 지원하지 않습니다.'); continue; }
      if (/^['"]/.test(dependency)) {
        if (dependency.at(-1) !== dependency[0]) { unknown(['python'], source, 'Conda 의존성 문자열이 완결되지 않았습니다.'); continue; }
        dependency = dependency.slice(1, -1);
      }
      const match = dependency.match(/^python(?=$|[\s=<>!~])([\s\S]*)$/);
      if (!match) continue;
      const version = match[1].trim();
      if (!version) continue;
      request('python', source, 'dependencies.python', version.replace(/^=(?!=)/, ''));
    }
  }

  let root, physicalRoot;
  try {
    if (typeof projectPath !== 'string' || !projectPath) throw new Error();
    root = path.resolve(projectPath);
    result.root = root;
  } catch {
    unknown(LANGUAGES, '.', '대상 프로젝트 경로를 해석할 수 없습니다.');
    result.environment = { containers: 'unknown', processCompose: 'unknown' };
    return result;
  }
  const candidates = [];
  try {
    physicalRoot = await realpath(root);
    let count = 0;
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (++count > MAX_ENTRIES) {
        unknown(LANGUAGES, '.', '루트 항목 수가 정적 탐색 한도를 초과하여 요구의 부재를 확정하지 않았습니다.');
        result.environment = { containers: 'unknown', processCompose: 'unknown' };
        break;
      }
      if (description(entry.name)) candidates.push(entry.name);
      if (entry.name === '.devcontainer') {
        try {
          const folder = await lstat(path.join(root, entry.name));
          if (folder.isDirectory() && !folder.isSymbolicLink()) {
            try { await lstat(path.join(root, entry.name, 'devcontainer.json')); candidates.push('.devcontainer/devcontainer.json'); }
            catch (error) { if (error.code !== 'ENOENT') { result.environment.containers = 'unknown'; issue('.devcontainer/devcontainer.json', '컨테이너 선언의 존재 여부를 확인할 수 없습니다.'); } }
          } else { result.environment.containers = 'unknown'; issue('.devcontainer', '컨테이너 설정 폴더의 링크 또는 비표준 항목은 따라가지 않습니다.'); }
        } catch { result.environment.containers = 'unknown'; issue('.devcontainer', '컨테이너 설정 폴더를 확인할 수 없습니다.'); }
      }
    }
  } catch {
    unknown(LANGUAGES, '.', '프로젝트 루트의 선언 파일 목록을 읽을 수 없습니다.');
    result.environment = { containers: 'unknown', processCompose: 'unknown' };
  }
  result.files = unique(candidates).sort();
  const parsers = { node: nodeDeclaration, python: pythonDeclaration, go: goDeclaration, cargo: cargoDeclaration, rust: rustDeclaration, zig: zigDeclaration, dotnet: dotnetDeclaration, mise: miseDeclaration, tools: toolVersions, conda: condaDeclaration };
  for (let index = 0; index < result.files.length; index += 1) {
    const source = result.files[index], spec = description(source);
    if (!spec.shared) for (const language of spec.languages ?? []) mark(language);
    if (spec.environment) {
      if (spec.environment === 'containers') {
        result.environment.containers = 'unknown';
        issue(source, '컨테이너 선언의 존재만으로 모든 작업의 컨테이너 실행 요구를 확정하지 않습니다.');
      } else if (result.environment.processCompose !== 'unknown') result.environment.processCompose = 'required';
    }
    const fail = (message) => {
      if (spec.environment) { result.environment[spec.environment] = 'unknown'; issue(source, message); }
      else if (spec.languages) unknown(spec.languages, source, message);
      else issue(source, message);
    };
    if (index >= MAX_FILES) { fail('선언 파일 수가 정적 분석 한도를 초과했습니다.'); continue; }
    let handle;
    try {
      const filename = path.join(root, source);
      const before = await lstat(filename);
      if (!before.isFile() || before.isSymbolicLink()) { fail('선언 파일이 일반 파일이 아니거나 링크이므로 읽지 않았습니다.'); continue; }
      const relative = path.relative(physicalRoot, await realpath(filename));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { fail('프로젝트 루트 밖의 선언 대상은 읽지 않았습니다.'); continue; }
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) { fail('조회 중 선언 파일의 대상이 변경되어 읽지 않았습니다.'); continue; }
      if (spec.manager) for (const language of spec.languages) manager(language, spec.manager, source);
      if (spec.lock) requirements[spec.languages[0]].lockFiles.push(source);
      if (spec.integrity) {
        (requirements.go.metadata.integrityFiles ??= []).push(source);
        note('go', 'go.sum 계열 파일은 의존성 무결성 해시이며 잠금 파일이나 Go 버전 선언이 아닙니다.');
      }
      if (!spec.parser) continue;
      if (info.size > MAX_BYTES) { fail('선언 파일이 256 KiB 읽기 한도를 초과했습니다.'); continue; }
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_BYTES) { fail('선언 파일이 256 KiB 읽기 한도를 초과했습니다.'); continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).replace(/^\uFEFF/, ''); }
      catch { fail('선언 파일을 UTF-8 텍스트로 읽을 수 없습니다.'); continue; }
      if (text.includes('\0')) { fail('선언 파일에 지원하지 않는 바이너리 데이터가 있습니다.'); continue; }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) { fail('조회 중 선언 파일의 내용이 변경되어 요구를 확정하지 않았습니다.'); continue; }
      if (spec.parser === 'pin') pin(text, source, spec.languages[0]);
      else parsers[spec.parser](text, source);
    } catch {
      fail('선언 파일을 안전하게 읽거나 정적으로 분석할 수 없습니다.');
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  for (const language of LANGUAGES) {
    const requirement = requirements[language];
    requirement.packageManagers = [...new Map(requirement.packageManagers.map((item) => [`${item.name}\0${item.source}\0${item.version ?? ''}`, item])).values()];
    requirement.notes = unique(requirement.notes);
    if (requirement.metadata.versionManagers) requirement.metadata.versionManagers = unique(requirement.metadata.versionManagers);
    const pins = requirement.versionRequests.filter((entry) => entry.kind === 'exact');
    // Multiple versions within one file can be intentional alternatives (pyenv/mise).
    const sources = unique(pins.map((entry) => entry.source));
    if (sources.length > 1 && sources.every((source) => pins.filter((entry) => entry.source === source).length === 1) && unique(pins.map((entry) => entry.value.replace(/^v/, ''))).length > 1) {
      unknown([language], sources.join(', '), '서로 다른 파일의 고정 버전 선언이 충돌하므로 선택된 버전을 확정하지 않았습니다.');
    }
    if (language === 'node' && unique(requirement.packageManagers.map((item) => item.name)).length > 1) issue(unique(requirement.packageManagers.map((item) => item.source)).join(', '), '여러 Node.js 패키지 관리자 선언이 발견되어 작업에 적용되는 관리자를 확인해야 합니다.');
    if (requirement.state === 'required' && !requirement.versionRequests.length) note(language, '관련 선언은 있으나 정적으로 확인한 언어 버전 요구는 없습니다.');
  }
  if (result.files.includes('rust-toolchain') && result.files.includes('rust-toolchain.toml')) unknown(['rust'], 'rust-toolchain, rust-toolchain.toml', 'Rust 도구 모음 파일이 둘 다 존재하여 선택 우선순위를 별도로 확인해야 합니다.');
  return result;
}
