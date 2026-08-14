import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'index.html must contain an inline script');
const source = match[1];

// Contract: keep the inline application script syntactically compilable.
assert.doesNotThrow(() => new Function(source), 'inline script must compile');

const type = (id, label) => new RegExp(`\\{\\s*id\\s*:\\s*['\"]${id}['\"][\\s\\S]*?l\\s*:\\s*['\"]${label}['\"]\\s*\\}`);
for (const [id, label] of [
  ['memo', '메모'],
  ['inspiration', '영감'],
  ['idea', '아이디어'],
  ['sound', '들은 소리'],
]) assert.match(source, type(id, label), `${id} must be its own capture button`);

assert.doesNotMatch(source, /MEMO_KINDS/, 'memo-kind branching must be removed');
assert.doesNotMatch(source, /memo\s*:\s*\{[^}]*\[\s*['\"]kind['\"]\s*,\s*['\"]종류['\"]\s*,\s*['\"]sel:/s,
  'generic memo must not show a kind selector');

assert.match(source, /memo\s*:\s*\{\s*\}/, 'generic memo has no extra fields');
assert.match(source, /inspiration\s*:\s*\{\s*detail\s*:\s*\[\s*\[\s*['\"]perception['\"]\s*,\s*['\"]왜 눈에 띄었나['\"]\s*,\s*['\"]area['\"]\s*\]\s*,\s*\[\s*['\"]source['\"]\s*,\s*['\"]출처['\"]\s*,\s*['\"]text['\"]\s*\]/s,
  'inspiration fields must stay on inspiration');
assert.match(source, /idea\s*:\s*\{\s*detail\s*:\s*\[\s*\[\s*['\"]title['\"]\s*,\s*['\"]제목['\"]\s*,\s*['\"]text['\"]\s*\]\s*,\s*\[\s*['\"]note['\"]\s*,\s*['\"]비고['\"]\s*,\s*['\"]area['\"]\s*\]/s,
  'idea fields must stay on idea');
for (const key of ['place', 'sound', 'situation', 'observation', 'mood']) {
  assert.match(source, new RegExp(`sound\\s*:\\s*\\{[\\s\\S]*?['\"]${key}['\"]`), `sound must include ${key}`);
}

for (const [id, kind] of [['inspiration', '영감'], ['idea', '아이디어'], ['sound', '사운드']]) {
  assert.match(source, new RegExp(`${id}\\s*:\\s*['\"]${kind}['\"]`), `${id} must map to ${kind}`);
}
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

console.log('capture collection contracts pass');
