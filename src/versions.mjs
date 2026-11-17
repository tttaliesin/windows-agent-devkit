// Unsupported expressions remain unknown instead of being treated as satisfied.
function tuple(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(?:v|go)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match || match.slice(1).some((part) => part !== undefined && (!Number.isSafeInteger(Number(part)) || /^0\d/.test(part)))) return null;
  return { values: match.slice(1).map((part) => Number(part ?? 0)), parts: match.slice(1).filter((part) => part !== undefined).length };
}

function compare(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function termMatches(actual, term, language) {
  if (term === '*' || /^x$/i.test(term)) return true;
  const match = term.match(/^(>=|<=|>|<|==|=|!=|\^|~=?|)(v?\d+(?:\.(?:\d+|x|\*)){0,2})$/i);
  if (!match) return null;
  const [, operator, text] = match;
  if (language === 'node' && ['==', '!=', '~='].includes(operator)) return null;
  if (language === 'python' && /x/i.test(text)) return null;
  const wildcard = text.search(/[x*]/i);
  const target = tuple(wildcard >= 0 ? text.slice(0, wildcard).replace(/\.$/, '') : text);
  if (!target) return null;
  const order = compare(actual, target.values);
  if (wildcard >= 0 && !['', '=', '==', '!='].includes(operator)) return null;
  if (['>=', '>', '<=', '<'].includes(operator)) {
    if (language === 'node' && target.parts < 3 && ['>', '<='].includes(operator)) {
      const upper = [...target.values];
      upper[target.parts - 1]++;
      for (let i = target.parts; i < 3; i++) upper[i] = 0;
      return operator === '>' ? compare(actual, upper) >= 0 : compare(actual, upper) < 0;
    }
    return { '>=': order >= 0, '>': order > 0, '<=': order <= 0, '<': order < 0 }[operator];
  }
  if (operator === '^' || operator === '~' || operator === '~=') {
    const upper = [...target.values];
    let position;
    if (operator === '^') position = upper[0] > 0 || target.parts === 1 ? 0 : upper[1] > 0 || target.parts === 2 ? 1 : 2;
    else if (operator === '~=') position = target.parts < 3 ? 0 : 1;
    else position = target.parts < 2 ? 0 : 1;
    upper[position]++;
    for (let i = position + 1; i < 3; i++) upper[i] = 0;
    return order >= 0 && compare(actual, upper) < 0;
  }
  const equal = language === 'python' && wildcard < 0 && ['==', '!='].includes(operator)
    ? order === 0
    : target.values.slice(0, target.parts).every((part, i) => actual[i] === part);
  return operator === '!=' ? !equal : equal;
}

function rangeMatches(actual, expression, language) {
  if (typeof expression !== 'string' || expression.length > 512 || !expression.trim()) return null;
  const unions = expression.trim().split(/\s*\|\|\s*/);
  const outcomes = unions.map((part) => {
    const compact = part.replace(/(>=|<=|!=|==|~=|>|<|=|\^|~)\s+/g, '$1');
    const terms = compact.split(/[\s,]+/).filter(Boolean);
    if (!terms.length) return null;
    const matches = terms.map((term) => termMatches(actual, term, language));
    if (matches.includes(null)) return null;
    return !matches.includes(false);
  });
  if (outcomes.includes(null)) return null;
  return outcomes.includes(true);
}

function sdkMatches(actual, requested, metadata) {
  const target = tuple(requested);
  if (!target || target.parts !== 3) return null;
  const options = metadata.sdk ?? metadata.globalJson?.sdk ?? metadata;
  if (options.paths?.length || metadata.paths?.length) return null;
  const policy = options.rollForward ?? 'patch';
  const sameMajor = actual[0] === target.values[0];
  const sameMinor = sameMajor && actual[1] === target.values[1];
  const sameBand = sameMinor && Math.floor(actual[2] / 100) === Math.floor(target.values[2] / 100);
  const atLeast = compare(actual, target.values) >= 0;
  switch (policy) {
    case 'disable': return compare(actual, target.values) === 0;
    case 'patch': case 'latestPatch': return sameBand && atLeast;
    case 'feature': case 'latestFeature': return sameMinor && atLeast;
    case 'minor': case 'latestMinor': return sameMajor && atLeast;
    case 'major': case 'latestMajor': return atLeast;
    default: return null;
  }
}

export function evaluateVersion(observed, requests, metadata = {}) {
  const actual = tuple(observed);
  if (!actual) return { compatibility: 'unknown', reason: 'unsupported_observed_version' };
  if (!requests?.length) return { compatibility: 'unknown', reason: 'no_version_requirement' };
  const outcomes = requests.filter((request) => request.kind !== 'preferred').map((request) => {
    if (request.kind === 'channel') return null;
    if (request.kind === 'minimum') {
      const target = tuple(request.value);
      return target ? compare(actual.values, target.values) >= 0 : null;
    }
    if (request.kind === 'sdk') return sdkMatches(actual.values, request.value, metadata);
    return rangeMatches(actual.values, request.value, metadata.language ?? 'node');
  });
  if (outcomes.includes(false)) return { compatibility: 'violated', reason: 'version_mismatch' };
  if (!outcomes.length || outcomes.includes(null)) return { compatibility: 'unknown', reason: 'unsupported_requirement' };
  return { compatibility: 'satisfied', reason: 'version_satisfied' };
}
