import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'index.html must contain an inline script');
const source = match[1];

// Contract: keep the inline application script syntactically compilable.
assert.doesNotThrow(() => new Function(source), 'inline script must compile');

function assignedLiteral(name) {
  const assignment = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`).exec(source);
  assert.ok(assignment, `${name} must be assigned`);
  const start = assignment.index + assignment[0].length;
  const pairs = { '{': '}', '[': ']' };
  assert.ok(source[start] in pairs, `${name} must use an object or array literal`);
  const stack = [];
  let quote = '';
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      assert.notEqual(i, -1, `${name} has an unterminated line comment`);
      continue;
    }
    if (char === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      assert.notEqual(i, -1, `${name} has an unterminated block comment`);
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char in pairs) stack.push(pairs[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${name} literal must be balanced`);
}

function namedFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${name} must have a body`);
  let depth = 0;
  let quote = '';
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      assert.notEqual(i, -1, `${name} has an unterminated line comment`);
      continue;
    }
    if (char === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      assert.notEqual(i, -1, `${name} has an unterminated block comment`);
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${name} function must be balanced`);
}

const TYPES = new Function(`return (${assignedLiteral('TYPES')})`)();
const FIELDS = new Function(`return (${assignedLiteral('FIELDS')})`)();
const CAPTURE_KINDS = new Function(`return (${assignedLiteral('CAPTURE_KINDS')})`)();

assert.deepEqual(
  TYPES.filter(({ id }) => ['memo', 'inspiration', 'idea', 'sound'].includes(id)),
  [
    { id: 'memo', e: '💭', l: '메모' },
    { id: 'inspiration', e: '💡', l: '영감' },
    { id: 'idea', e: '📒', l: '아이디어' },
    { id: 'sound', e: '🎧', l: '들은 소리' },
  ],
  'collection buttons must be exact independent objects',
);

assert.doesNotMatch(source, /MEMO_KINDS/, 'memo-kind branching must be removed');
assert.doesNotMatch(source, /memo\s*:\s*\{[^}]*\[\s*['\"]kind['\"]\s*,\s*['\"]종류['\"]\s*,\s*['\"]sel:/s,
  'generic memo must not show a kind selector');

assert.deepEqual(FIELDS.memo, {}, 'generic memo has no extra fields');
assert.deepEqual(FIELDS.inspiration, {
  detail: [['perception', '왜 눈에 띄었나', 'area'], ['source', '출처', 'text']],
}, 'inspiration fields must stay on inspiration');
assert.deepEqual(FIELDS.idea, {
  basic: [['gubun', '구분', 'sel:업무|사이드프로젝트|일상|기타'],
          ['title', '제목', 'text']],
  detail: [['note', '비고', 'area']],
}, 'idea fields must stay on idea');
assert.deepEqual(FIELDS.sound, {
  detail: [
    ['place', '장소', 'text'], ['sound', '소리', 'text'],
    ['situation', '상황', 'area'], ['observation', '관찰', 'area'],
    ['mood', '기분', 'text'],
  ],
}, 'sound fields must stay on sound');
assert.deepEqual(CAPTURE_KINDS, {
  inspiration: '영감', idea: '아이디어', sound: '사운드',
}, 'collection UI types must map to the exact legacy kinds');
assert.match(source, /type\s*:\s*CAPTURE_KINDS\[uiType\]\s*\?\s*['\"]memo['\"]\s*:\s*uiType/,
  'collection submissions must remap to legacy memo payloads');
assert.match(source, /if\s*\(CAPTURE_KINDS\[uiType\]\)\s*p\.kind\s*=\s*CAPTURE_KINDS\[uiType\]/,
  'collection submissions must include the exact legacy kind');
assert.match(source, /submit\(p[^,]*,\s*undefined\s*,\s*uiType\)/,
  'recent entries must receive the UI type independently of the payload type');

for (const label of ['아이디어', '들은 소리']) {
  assert.match(source, new RegExp(`VIEW_TYPES\\s*=\\s*\\[[^\\]]*['\"]${label}['\"]`), `${label} must be filterable`);
  assert.match(source, new RegExp(`COLOR\\s*=\\s*\\{[^}]*['\"]${label}['\"]`), `${label} must have a color`);
  assert.match(source, new RegExp(`DIGEST\\s*=\\s*\\[[^\\]]*['\"]${label}['\"]`), `${label} must appear in the digest`);
}
assert.match(source, /\(r\.detail\|\|\[\]\)\.join\(['\"] ['\"]\)/,
  'record detail must remain searchable');

const prepareRecords = new Function('DATA', `
  let ALL = [];
  ${namedFunction('recordDate')}
  ${namedFunction('recordSavedAt')}
  ${namedFunction('prepData')}
  prepData();
  return ALL;
`);
const prepared = prepareRecords({ records: [
  { body: 'early', date: '2026-08-17', saved: '08:00' },
  { body: 'saved next day', date: '2026-08-16', saved: '08-17 20:00' },
  { body: 'missing time', date: '2026-08-17', saved: '' },
  { body: 'late', date: '2026-08-17', saved: '18:00' },
  { body: 'yesterday', date: '2026-08-16', saved: '23:59' },
] });
assert.deepEqual(
  prepared.map(({ body }) => body),
  ['saved next day', 'late', 'early', 'missing time', 'yesterday'],
  'view cards must sort by the actual saved timestamp newest first',
);

console.log('capture collection contracts pass');
