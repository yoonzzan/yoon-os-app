import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'index.html must contain an inline script');
const source = match[1];

function namedFunction(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} must exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf('{', start);
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
    if (char === '/' && next === '/') { i = source.indexOf('\n', i + 2); continue; }
    if (char === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${name} function must be balanced`);
}

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
    if (char === '/' && next === '/') { i = source.indexOf('\n', i + 2); continue; }
    if (char === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char in pairs) stack.push(pairs[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${name} literal must be balanced`);
}

const { composeRecords, composeGraphFacts, validateEnrichments, validateGraphCurrent } = new Function(`
  ${namedFunction('normalizeEnrichmentTag')}
  ${namedFunction('validateEnrichments')}
  ${namedFunction('validateGraphCurrent')}
  ${namedFunction('composeGraphFacts')}
  ${namedFunction('composeRecords')}
  return { composeRecords, composeGraphFacts, validateEnrichments, validateGraphCurrent };
`)();

const HASH_A = `sha256-${'a'.repeat(64)}`;
const HASH_B = `sha256-${'b'.repeat(64)}`;
const fixturePath = resolve(import.meta.dirname, 'projector-sidecar.fixture.json');
const projectorRoot = process.env.LIFE_OS_ROOT
  || resolve(import.meta.dirname, '..', '..', 'automatic-record-enrichment');
function projectCurrentFixture() {
  const checkedIn = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const generator = resolve(projectorRoot, 'tests', 'projector_app_fixture.py');
  if(existsSync(generator)){
    const generated = JSON.parse(execFileSync('python3', [generator], {
      cwd:projectorRoot, encoding:'utf8',
    }));
    assert.deepEqual(generated, checkedIn,
      'the checked-in app fixture must exactly match the production Python projector output');
  }
  return checkedIn;
}
const records = [{ record_id: 'rec-a', source_hash: HASH_A, tags: ['수동'], body: '본문' }];
const sidecar = { schema_version: 1, records: {
  'rec-a': { record_id: 'rec-a', source_hash: HASH_A, status: 'completed',
    status_reason: 'completed', prompt_version: 1, redaction_version: 1,
    tags: [{ value: '수동', origin: 'source' }, { value: '자동분류', origin: 'auto' }],
    connections: [], event_receipts: {}, applied_event_ids: [], provenance: [] }
} };

assert.equal(validateEnrichments(sidecar).ok, true, 'a schema-v1 sidecar must validate');
const sourceScopedPrivacy = structuredClone(sidecar);
sourceScopedPrivacy.records['rec-a'].privacy_decision = {
  action:'allow_redacted', source_hash:HASH_A, redaction_version:1,
};
assert.equal(validateEnrichments(sourceScopedPrivacy).ok, true,
  'a source-scoped privacy decision matching the projected source hash must validate');
const contentScopedPrivacy = structuredClone(sidecar);
contentScopedPrivacy.records['rec-a'].content_hash = HASH_B;
contentScopedPrivacy.records['rec-a'].privacy_decision = {
  action:'allow_original', content_hash:HASH_B, redaction_version:1,
};
assert.equal(validateEnrichments(contentScopedPrivacy).ok, true,
  'a content-scoped privacy decision matching the projected content hash must validate');
const staleSourceScopedPrivacy = structuredClone(sourceScopedPrivacy);
staleSourceScopedPrivacy.records['rec-a'].privacy_decision.source_hash = HASH_B;
assert.equal(validateEnrichments(staleSourceScopedPrivacy).ok, false,
  'a source-scoped privacy decision must expire when its projected source hash changes');
const staleContentScopedPrivacy = structuredClone(contentScopedPrivacy);
staleContentScopedPrivacy.records['rec-a'].privacy_decision.content_hash = HASH_A;
assert.equal(validateEnrichments(staleContentScopedPrivacy).ok, false,
  'a content-scoped privacy decision must expire when its projected content hash changes');
for(const malformedPrivacyDecision of [
  { action:'allow_original', redaction_version:1 },
  { action:'allow_original', source_hash:HASH_A, content_hash:HASH_B, redaction_version:1 },
]){
  const malformedPrivacy = structuredClone(contentScopedPrivacy);
  malformedPrivacy.records['rec-a'].privacy_decision = malformedPrivacyDecision;
  assert.equal(validateEnrichments(malformedPrivacy).ok, false,
    'a privacy decision must contain exactly one canonical scope hash');
}
const canonicalProjection = projectCurrentFixture();
const canonicalEnrichment = canonicalProjection.enrichment_current || canonicalProjection;
assert.ok(canonicalProjection.graph_current,
  'the checked-in fixture must contain graph_current so graph cutover coverage never skips');
assert.equal(validateEnrichments(canonicalEnrichment).ok, true,
  'the strict browser validator must accept the canonical project_current output');
assert.deepEqual(composeRecords([
  { record_id:'rec-a', source_hash:HASH_A, tags:['Source Tag'], body:'본문' },
], canonicalEnrichment)[0].displayTags, ['수동', '자동분류'],
  'the actual projector fixture must feed the browser composition without a copied contract');
const canonicalWithExtraTargetField = structuredClone(canonicalEnrichment);
canonicalWithExtraTargetField.targets.records['rec-a'].unexpected = 'must-not-pass';
assert.equal(validateEnrichments(canonicalWithExtraTargetField).ok, false,
  'target catalog entries must reject fields outside the reduced projector contract');

{
  const graphCurrent = canonicalProjection.graph_current;
  const graphNodes = Object.fromEntries(graphCurrent.nodes.map(node => [node.node_id, node]));
  const scenarioRecord = (name, overrides = {}) => {
    const recordId = canonicalProjection.scenarios[name].record_id;
    const node = graphNodes[recordId];
    const status = canonicalProjection.enrichment_current.records[recordId];
    return {
      record_id:recordId, source_hash:status.source_hash, content_hash:node.content_hash,
      tags:['legacy fallback tag'], connections:[{ kind:'record', target_id:'rec-a' }], body:'fixture record',
      ...overrides,
    };
  };
  const graphFacts = composeGraphFacts(graphCurrent);
  assert.equal(validateGraphCurrent(graphCurrent).ok, true,
    'the actual Python graph projector output must satisfy the browser graph contract');
  const casefoldGraph = structuredClone(graphCurrent);
  const casefoldTag = casefoldGraph.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  casefoldTag.normalized_key = 'strasse';
  casefoldTag.raw_display_value = 'Straße';
  const casefoldTagNode = casefoldGraph.nodes.find(node => node.node_id === casefoldTag.target_id);
  casefoldTagNode.metadata = { normalized_key:'strasse', raw_display_value:'Straße' };
  assert.equal(validateGraphCurrent(casefoldGraph).ok, true,
    'a valid Python-casefolded tag key must not be rejected by JavaScript lowercasing');
  assert.deepEqual(composeGraphFacts(casefoldGraph).records[scenarioRecord('source_only').record_id].tags,
    [{ value:'Straße', origin:'source' }],
    'a casefolded graph tag retains its projector-provided raw display value');
  const cherokeeCasefoldGraph = structuredClone(graphCurrent);
  const cherokeeTag = cherokeeCasefoldGraph.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  cherokeeTag.normalized_key = 'Ꭰ';
  cherokeeTag.raw_display_value = 'ꭰ';
  cherokeeCasefoldGraph.nodes.find(node => node.node_id === cherokeeTag.target_id)
    .metadata = { normalized_key:'Ꭰ', raw_display_value:'ꭰ' };
  assert.equal(validateGraphCurrent(cherokeeCasefoldGraph).ok, true,
    'a valid Python-casefolded Cherokee key must not be reinterpreted with JavaScript lowercasing');
  const greekCasefoldGraph = structuredClone(graphCurrent);
  const greekTag = greekCasefoldGraph.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  greekTag.normalized_key = 'ΐ';
  greekTag.raw_display_value = 'ΐ';
  greekCasefoldGraph.nodes.find(node => node.node_id === greekTag.target_id)
    .metadata = { normalized_key:'ΐ', raw_display_value:'ΐ' };
  assert.equal(validateGraphCurrent(greekCasefoldGraph).ok, true,
    'a valid post-casefold decomposed Greek key must not be NFKC-normalized by the browser');
  const astralKey = '😀'.repeat(80);
  const astralBoundaryGraph = structuredClone(graphCurrent);
  const astralTag = astralBoundaryGraph.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  astralTag.normalized_key = astralKey;
  astralTag.raw_display_value = astralKey;
  astralBoundaryGraph.nodes.find(node => node.node_id === astralTag.target_id)
    .metadata = { normalized_key:astralKey, raw_display_value:astralKey };
  assert.equal(validateGraphCurrent(astralBoundaryGraph).ok, true,
    '80 astral Unicode code points are accepted even though they occupy 160 UTF-16 units');
  const longRawDisplay = '#'.repeat(100) + '😀'.repeat(80);
  const longRawDisplayGraph = structuredClone(graphCurrent);
  const longRawDisplayTag = longRawDisplayGraph.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  longRawDisplayTag.normalized_key = '😀'.repeat(80);
  longRawDisplayTag.raw_display_value = longRawDisplay;
  longRawDisplayGraph.nodes.find(node => node.node_id === longRawDisplayTag.target_id)
    .metadata = { normalized_key:'😀'.repeat(80), raw_display_value:longRawDisplay };
  assert.equal(validateGraphCurrent(longRawDisplayGraph).ok, true,
    'a production-valid 180-code-point raw display is accepted despite 260 UTF-16 units');
  const overlongRawDisplay = structuredClone(longRawDisplayGraph);
  const overlongRawDisplayTag = overlongRawDisplay.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  overlongRawDisplayTag.raw_display_value = '#'.repeat(177) + '😀'.repeat(80);
  overlongRawDisplay.nodes.find(node => node.node_id === overlongRawDisplayTag.target_id)
    .metadata.raw_display_value = '#'.repeat(177) + '😀'.repeat(80);
  assert.equal(validateGraphCurrent(overlongRawDisplay).ok, false,
    '257 Unicode code points remain above the canonical raw-display limit');
  const overlongAstralKey = structuredClone(astralBoundaryGraph);
  const overlongAstralTag = overlongAstralKey.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  overlongAstralTag.normalized_key = '😀'.repeat(81);
  overlongAstralKey.nodes.find(node => node.node_id === overlongAstralTag.target_id)
    .metadata.normalized_key = '😀'.repeat(81);
  assert.equal(validateGraphCurrent(overlongAstralKey).ok, false,
    '81 Unicode code points remain above the canonical tag-key limit');
  const controlCharacterKey = structuredClone(greekCasefoldGraph);
  const controlCharacterTag = controlCharacterKey.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  controlCharacterTag.normalized_key = 'bad\u0000key';
  controlCharacterKey.nodes.find(node => node.node_id === controlCharacterTag.target_id)
    .metadata.normalized_key = 'bad\u0000key';
  assert.equal(validateGraphCurrent(controlCharacterKey).ok, false,
    'a control character in the producer key remains rejected');
  const malformedTagMetadata = structuredClone(casefoldGraph);
  malformedTagMetadata.nodes.find(node => node.node_id === casefoldTag.target_id)
    .metadata.raw_display_value = 'bad\u0000metadata';
  assert.equal(validateGraphCurrent(malformedTagMetadata).ok, false,
    'malformed tag metadata remains rejected even when raw-to-key recomputation is not used');
  const mismatchedTagMembership = structuredClone(casefoldGraph);
  mismatchedTagMembership.nodes.find(node => node.node_id === casefoldTag.target_id)
    .metadata.normalized_key = 'different-tag';
  assert.equal(validateGraphCurrent(mismatchedTagMembership).ok, false,
    'a tag fact must belong to a tag node with the same canonical projector key');
  assert.deepEqual(graphFacts.records[canonicalProjection.scenarios.source_only.record_id].tags.map(tag => tag.value), ['source only'],
    'graph source facts are projected without copying fixture JSON into JavaScript');
  const boundaryGraph = structuredClone(graphCurrent);
  const sourceTag = boundaryGraph.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  sourceTag.source_locator = 'a'.repeat(1024);
  assert.equal(validateGraphCurrent(boundaryGraph).ok, true,
    'the canonical 1024-character source_locator boundary is accepted');
  sourceTag.source_locator += 'a';
  assert.equal(validateGraphCurrent(boundaryGraph).ok, false,
    'source_locator values above the canonical 1024-character boundary are rejected');
  const astralSourceLocatorGraph = structuredClone(graphCurrent);
  const astralSourceTag = astralSourceLocatorGraph.nodes.find(node => node.node_id === scenarioRecord('source_only').record_id).tags[0];
  astralSourceTag.source_locator = '😀'.repeat(1024);
  assert.equal(validateGraphCurrent(astralSourceLocatorGraph).ok, true,
    'a 1024-code-point astral source locator is accepted despite 2048 UTF-16 units');
  astralSourceTag.source_locator += '😀';
  assert.equal(validateGraphCurrent(astralSourceLocatorGraph).ok, false,
    'a 1025-code-point astral source locator remains above the canonical boundary');
  const multilineGraph = structuredClone(graphCurrent);
  const typedLink = multilineGraph.nodes.find(node => node.node_id === scenarioRecord('typed_links').record_id).links[0];
  const multilinePrefix = '첫 줄\n\t둘째 줄 ';
  typedLink.raw_text = `${multilinePrefix}${'x'.repeat(4096 - multilinePrefix.length)}`;
  assert.equal(validateGraphCurrent(multilineGraph).ok, true,
    'a link raw_text accepts canonical multiline tab/newline content through 4096 characters');
  typedLink.raw_text += 'x';
  assert.equal(validateGraphCurrent(multilineGraph).ok, false,
    'link raw_text above the canonical 4096-character boundary is rejected');
  const astralRawTextGraph = structuredClone(graphCurrent);
  const astralTypedLink = astralRawTextGraph.nodes.find(node => node.node_id === scenarioRecord('typed_links').record_id).links[0];
  astralTypedLink.raw_text = '😀'.repeat(4000);
  assert.equal(validateGraphCurrent(astralRawTextGraph).ok, true,
    'a 4000-code-point astral link raw_text is accepted despite 8000 UTF-16 units');
  astralTypedLink.raw_text += '😀'.repeat(97);
  assert.equal(validateGraphCurrent(astralRawTextGraph).ok, false,
    'a 4097-code-point astral link raw_text remains above the canonical boundary');
  const lineSeparatorGraph = structuredClone(graphCurrent);
  lineSeparatorGraph.nodes.find(node => node.node_id === scenarioRecord('typed_links').record_id).links[0].raw_text = '첫 줄\u2028둘째 줄';
  assert.equal(validateGraphCurrent(lineSeparatorGraph).ok, true,
    'multiline raw_text accepts every separator the production projector permits');
  const controlGraph = structuredClone(graphCurrent);
  controlGraph.nodes.find(node => node.node_id === scenarioRecord('typed_links').record_id).links[0].raw_text = 'bad\u0000control';
  assert.equal(validateGraphCurrent(controlGraph).ok, false,
    'a production-rejected control character invalidates graph current');
  assert.deepEqual(composeRecords([scenarioRecord('source_only')], canonicalProjection.enrichment_current, graphCurrent)[0].displayTags,
    ['source only'], 'a current graph node is the primary source of source tags');
  assert.deepEqual(composeRecords([scenarioRecord('auto_only')], canonicalProjection.enrichment_current, graphCurrent)[0].displayTags,
    ['auto only'], 'a current graph node is the primary source of auto tags');
  assert.deepEqual(composeRecords([scenarioRecord('mixed')], canonicalProjection.enrichment_current, graphCurrent)[0].displayTags,
    ['mixed auto', 'mixed source'], 'source and auto graph facts compose together');
  assert.deepEqual(composeRecords([scenarioRecord('user_remove')], canonicalProjection.enrichment_current, graphCurrent)[0].displayTags,
    [], 'an empty graph node preserves a user removal');
  const typed = composeRecords([scenarioRecord('typed_links')], canonicalProjection.enrichment_current, graphCurrent)[0];
  assert.deepEqual(typed.connections.map(link => link.kind).sort(), ['daily_note', 'project', 'record'],
    'graph link targets retain their validated node kinds');
  const knownEmpty = composeRecords([scenarioRecord('known_empty')], canonicalProjection.enrichment_current, graphCurrent)[0];
  assert.deepEqual(knownEmpty.displayTags, [],
    'a known-empty graph node must never re-merge legacy enrichment or raw tags');
  assert.deepEqual(knownEmpty.connections, [],
    'a known-empty graph node must never re-merge legacy enrichment links');
  assert.equal(knownEmpty.enrichmentStatus, 'completed',
    'enrichment current remains the sole source of processing status');
  const runtimeCompose = new Function('DATA', 'ENRICH', 'GRAPH', `
    let ALL = [];
    ${namedFunction('normalizeEnrichmentTag')}
    ${namedFunction('validateGraphCurrent')}
    ${namedFunction('composeGraphFacts')}
    ${namedFunction('composeRecords')}
    ${namedFunction('recordDate')}
    ${namedFunction('recordSavedAt')}
    ${namedFunction('resolveConnection')}
    ${namedFunction('resolveConnections')}
    ${namedFunction('prepData')}
    prepData();
    return structuredClone(ALL);
  `)({ records:[scenarioRecord('known_empty')] }, canonicalProjection.enrichment_current, graphCurrent);
  assert.deepEqual(runtimeCompose[0].displayTags, [],
    'prepData must pass GRAPH into runtime composition so known-empty facts stay empty');
  assert.deepEqual(runtimeCompose[0].connections, [],
    'runtime prepData must not re-merge legacy connections for a known-empty graph node');
  const tombstoned = structuredClone(graphCurrent);
  tombstoned.nodes.find(node => node.node_id === scenarioRecord('known_empty').record_id).deleted = true;
  const deletedKnownEmpty = composeRecords([scenarioRecord('known_empty')], canonicalProjection.enrichment_current, tombstoned)[0];
  assert.deepEqual(deletedKnownEmpty.displayTags, [],
    'a known tombstone record node suppresses legacy tags instead of falling back');
  assert.deepEqual(deletedKnownEmpty.connections, [],
    'a known tombstone record node suppresses legacy links instead of falling back');

  assert.deepEqual(composeRecords([scenarioRecord('known_empty')], canonicalProjection.enrichment_current, null)[0].displayTags,
    ['legacy fallback tag'], 'only an absent graph permits legacy facts');
  const unsupported = canonicalProjection.scenarios.incompatible_schema.graph_current;
  assert.equal(validateGraphCurrent(unsupported).ok, false, 'an unsupported graph schema is explicitly incompatible');
  assert.deepEqual(composeRecords([scenarioRecord('known_empty')], canonicalProjection.enrichment_current, unsupported)[0].displayTags,
    ['legacy fallback tag'], 'an unsupported graph schema falls back to legacy facts');
  const contentMismatch = structuredClone(graphCurrent);
  contentMismatch.nodes.find(node => node.node_id === scenarioRecord('known_empty').record_id).content_hash = HASH_B;
  assert.deepEqual(composeRecords([scenarioRecord('known_empty')], canonicalProjection.enrichment_current, contentMismatch)[0].displayTags,
    ['legacy fallback tag'], 'a graph content-hash mismatch falls back to legacy facts');
  const recordMismatch = structuredClone(graphCurrent);
  recordMismatch.nodes.find(node => node.node_id === scenarioRecord('known_empty').record_id).node_id = 'rec-mismatch';
  assert.deepEqual(composeRecords([scenarioRecord('known_empty')], canonicalProjection.enrichment_current, recordMismatch)[0].displayTags,
    ['legacy fallback tag'], 'a missing matching graph record falls back to legacy facts');
  const sourceHashChanged = canonicalProjection.scenarios.source_hash_only_change;
  const sourceHashRecord = { ...sourceHashChanged.changed_record, tags:['legacy fallback tag'], body:'fixture record' };
  assert.deepEqual(composeRecords([sourceHashRecord], sourceHashChanged.enrichment_current, sourceHashChanged.graph_current)[0].displayTags,
    ['source hash stable'], 'a source-hash-only change retains content-scoped graph facts');
  const contentHashChanged = canonicalProjection.scenarios.content_hash_change;
  const contentHashRecord = { ...contentHashChanged.changed_record, tags:['legacy fallback tag'], body:'fixture record' };
  assert.deepEqual(composeRecords([contentHashRecord], contentHashChanged.enrichment_current, contentHashChanged.graph_current)[0].displayTags,
    [], 'a changed content hash uses the current known-empty graph node rather than legacy facts');
}
assert.deepEqual(composeRecords(
  [{ record_id: 'rec-a', source_hash: 'sha256-a', tags: ['수동'] }],
  { schema_version: 1, records: { 'rec-a': {
    source_hash: 'sha256-a', status: 'completed', redaction_version: 1,
    tags: [{ value: '수동', origin: 'source' }, { value: '자동분류', origin: 'auto' }],
    connections: [], event_receipts: {}
  } } }
)[0].displayTags, ['수동', '자동분류'],
  'composition joins a schema-v1 projection only by the exact record and source IDs');
assert.deepEqual(composeRecords(records, sidecar)[0].displayTags, ['수동', '자동분류'],
  'a valid projection must display exactly its projected tags');
assert.deepEqual(composeRecords(records, sidecar)[0].tags, ['수동'],
  'composition must retain raw tags separately for diagnostics and compatibility');

const removedSourceTag = structuredClone(sidecar);
removedSourceTag.records['rec-a'].tags = [];
assert.deepEqual(composeRecords(records, removedSourceTag)[0].displayTags, [],
  'an empty projected tag list must preserve a user removal of a source tag');

assert.deepEqual(composeRecords(records, null)[0].displayTags, ['수동'],
  'an absent sidecar must preserve raw tags');
assert.deepEqual(composeRecords(records, { schema_version: 2, records: {} })[0].displayTags, ['수동'],
  'an unsupported sidecar must preserve raw tags');

const mismatched = structuredClone(sidecar);
mismatched.records['rec-a'].source_hash = HASH_B;
assert.deepEqual(composeRecords(records, mismatched)[0].displayTags, ['수동'],
  'a mismatched source hash must preserve raw tags');

const unknown = structuredClone(sidecar);
unknown.records['rec-b'] = unknown.records['rec-a'];
delete unknown.records['rec-a'];
assert.deepEqual(composeRecords(records, unknown)[0].displayTags, ['수동'],
  'an unknown record ID must not alter a raw record');

const duplicated = structuredClone(sidecar);
duplicated.records['rec-a'].tags = [
  { value: ' 자동분류 ', origin: 'auto' }, { value: '#자동분류', origin: 'user' },
];
assert.equal(validateEnrichments(duplicated).ok, false,
  'duplicate normalized projected tags must invalidate a sidecar before it is composed');
assert.deepEqual(composeRecords(records, validateEnrichments(duplicated).value)[0].displayTags, ['수동'],
  'duplicate normalized projected tags make a sidecar invalid and must preserve raw tags');

function makeSidecarLoader(gh, cache, decode = text => text) {
  return new Function('gh', 'b64decode', 'ls', 'cfg', `
    const LS = { e:'yz-enrich', ee:'yz-enrich-etag', ea:'yz-enrich-at' };
    let ENRICH = { schema_version:1, records:{}, targets:{ records:{}, projects:{} } };
    let enrichmentLoadState = 'unavailable';
    ${namedFunction('normalizeEnrichmentTag')}
    ${namedFunction('validateEnrichments')}
    function reconcileEnrichmentPending(){}
    ${namedFunction('loadEnrichments')}
    return async () => { await loadEnrichments(); return { ENRICH, enrichmentLoadState }; };
  `)(gh, decode, {
    get: (key, fallback) => cache.get(key) ?? fallback,
    set: (key, value) => cache.set(key, value),
  }, { branch: 'main' });
}

const cache = new Map([['yz-enrich', sidecar]]);
const cached = await makeSidecarLoader(async () => { throw new Error('offline'); }, cache)();
assert.equal(cached.enrichmentLoadState, 'cached', 'a remote failure may use only a valid cached sidecar');
assert.deepEqual(composeRecords(records, cached.ENRICH)[0].displayTags, ['수동', '자동분류'],
  'a cached compatible sidecar must not discard the original raw record');

const staleCache = new Map([['yz-enrich', mismatched]]);
const cachedMismatch = await makeSidecarLoader(async () => { throw new Error('offline'); }, staleCache)();
assert.deepEqual(composeRecords(records, cachedMismatch.ENRICH)[0].displayTags, ['수동'],
  'a cached sidecar with a mismatched source hash must preserve raw tags');

const invalidWithCache = await makeSidecarLoader(async () => ({ content: JSON.stringify({ schema_version: 2, records: {} }) }), cache)();
assert.equal(invalidWithCache.enrichmentLoadState, 'incompatible',
  'an incompatible remote schema must not be masked by cache');
assert.deepEqual(composeRecords(records, invalidWithCache.ENRICH)[0].displayTags, ['수동'],
  'an incompatible sidecar must preserve raw tags even when a cache exists');

const malformedWithCache = await makeSidecarLoader(async () => ({ content: '{not-json' }), cache)();
assert.equal(malformedWithCache.enrichmentLoadState, 'incompatible',
  'a decoded JSON failure must not fall back to a stale cached projection');
assert.deepEqual(composeRecords(records, malformedWithCache.ENRICH)[0].displayTags, ['수동'],
  'a decoded JSON failure must preserve raw tags');

const invalidBase64WithCache = await makeSidecarLoader(
  async () => ({ content: 'not-base64' }), cache, () => { throw new Error('invalid base64'); }
)();
assert.equal(invalidBase64WithCache.enrichmentLoadState, 'incompatible',
  'a base64 decode failure must not fall back to a stale cached projection');

function makeGraphLoader(gh, cache, config = { owner:'owner-a', repo:'repo-a', branch:'main' }, decode = text => text) {
  return new Function('gh', 'b64decode', 'ls', 'cfg', `
    let GRAPH = { schema_version:1, projection_sequence:0, nodes:[], contains:[] };
    let graphLoadState = 'unavailable';
    ${namedFunction('normalizeEnrichmentTag')}
    ${namedFunction('validateGraphCurrent')}
    ${namedFunction('graphCacheKeys')}
    ${namedFunction('loadGraphCurrent')}
    return async () => { await loadGraphCurrent(); return { GRAPH, graphLoadState }; };
  `)(gh, decode, {
    get: (key, fallback) => cache.get(key) ?? fallback,
    set: (key, value) => cache.set(key, value),
  }, config);
}

{
  const defaultGraphConfig = { owner:'owner-a', repo:'repo-a', branch:'main' };
  const defaultGraphKeys = new Function('cfg', `${namedFunction('graphCacheKeys')} return graphCacheKeys(cfg);`)(defaultGraphConfig);
  const graphCache = new Map([[defaultGraphKeys.current, canonicalProjection.graph_current]]);
  const cachedGraph = await makeGraphLoader(async () => { throw new Error('offline'); }, graphCache)();
  assert.equal(cachedGraph.graphLoadState, 'cached',
    'a remote graph failure reports an explicit cached state without breaking records');
  assert.equal(cachedGraph.GRAPH.nodes.length, canonicalProjection.graph_current.nodes.length,
    'a validated cached graph remains available for graph-primary composition');
  const incompatibleGraph = await makeGraphLoader(
    async () => ({ content:JSON.stringify(canonicalProjection.scenarios.incompatible_schema.graph_current) }), graphCache
  )();
  assert.equal(incompatibleGraph.graphLoadState, 'incompatible',
    'an unsupported remote graph schema is never masked by a stale graph cache');
  const unavailableGraph = await makeGraphLoader(async () => { throw new Error('missing'); }, new Map())();
  assert.equal(unavailableGraph.graphLoadState, 'unavailable',
    'a missing graph has an explicit fallback state rather than failing the whole app');
  const firstConfig = defaultGraphConfig;
  const switchedConfig = { owner:'owner-b', repo:'repo-b', branch:'main' };
  const firstKeys = new Function('cfg', `${namedFunction('graphCacheKeys')} return graphCacheKeys(cfg);`)(firstConfig);
  const switchedKeys = new Function('cfg', `${namedFunction('graphCacheKeys')} return graphCacheKeys(cfg);`)(switchedConfig);
  assert.notDeepEqual(firstKeys, switchedKeys,
    'graph cache, ETag, and timestamp keys must be namespaced by repository and branch');
  const switchedStore = new Map([[firstKeys.current, canonicalProjection.graph_current]]);
  const switchedGraph = await makeGraphLoader(async () => { throw new Error('offline'); }, switchedStore, switchedConfig)();
  assert.equal(switchedGraph.graphLoadState, 'unavailable',
    'switching repository configuration must not reuse the previous repository graph cache');
}

function makeReceiptSidecarLoader(gh, seed, decode = text => text) {
  return new Function('gh', 'b64decode', 'seed', 'cfg', `
    const LS = { e:'yz-enrich', ee:'yz-enrich-etag', ea:'yz-enrich-at',
      ep:'yz-enrich-pending', er:'yz-enrich-results' };
    let ENRICH = { schema_version:1, records:{}, targets:{ records:{}, projects:{} } };
    let enrichmentLoadState = 'unavailable', pendingWrites = 0;
    const ls = {
      get: (key, fallback) => seed.has(key) ? structuredClone(seed.get(key)) : fallback,
      set: (key, value) => { if(key === LS.ep) pendingWrites += 1; seed.set(key, structuredClone(value)); },
    };
    ${namedFunction('normalizeEnrichmentTag')}
    ${namedFunction('validateEnrichments')}
    ${namedFunction('resolveEnrichmentReceipt')}
    ${namedFunction('reconcileEnrichmentPending')}
    ${namedFunction('loadEnrichments')}
    return async () => {
      await loadEnrichments();
      return { ENRICH, enrichmentLoadState, pending:ls.get(LS.ep, {}),
        results:ls.get(LS.er, {}), pendingWrites };
    };
  `)(gh, decode, seed, { branch:'main' });
}

const cachedAppliedSidecar = structuredClone(sidecar);
cachedAppliedSidecar.records['rec-a'].event_receipts = {
  'event-123': { status:'applied', safe_reason:'applied' },
};
const cachedAppliedSeed = new Map([
  ['yz-enrich', cachedAppliedSidecar],
  ['yz-enrich-pending', { 'event-123':{ event_id:'event-123', record_id:'rec-a', source_hash:HASH_A, transport:'queued' } }],
]);
const cachedApplied = await makeReceiptSidecarLoader(async () => { throw new Error('offline'); }, cachedAppliedSeed)();
assert.equal(cachedApplied.enrichmentLoadState, 'cached', 'a valid cached sidecar remains a usable receipt source');
assert.deepEqual(cachedApplied.pending, {}, 'a cached same-record applied receipt must clear pending state');
assert.deepEqual(cachedApplied.results['rec-a'], {
  event_id:'event-123', state:'applied', reason:'applied',
}, 'an applied receipt must persist a fixed per-record UI result before clearing pending');
assert.equal(cachedApplied.pendingWrites, 1, 'a validated cached sidecar must reconcile exactly once');

const cachedRejectedSidecar = structuredClone(sidecar);
cachedRejectedSidecar.records['rec-a'].event_receipts = {
  'event-123': { status:'rejected', safe_reason:'invalid_introduction_metadata' },
};
const cachedRejectedSeed = new Map([
  ['yz-enrich', cachedRejectedSidecar],
  ['yz-enrich-pending', { 'event-123':{ event_id:'event-123', record_id:'rec-a', source_hash:HASH_A, transport:'queued' } }],
]);
const cachedRejected = await makeReceiptSidecarLoader(async () => { throw new Error('offline'); }, cachedRejectedSeed)();
assert.equal(cachedRejected.enrichmentLoadState, 'cached', 'a safe but unlabelled rejection code remains schema-valid');
assert.deepEqual(cachedRejected.pending, {}, 'a cached same-record rejected receipt must clear pending state');
assert.deepEqual(cachedRejected.results['rec-a'], {
  event_id:'event-123', state:'rejected', reason:'invalid_introduction_metadata',
}, 'a rejected receipt must persist a safe per-record UI result before clearing pending');
assert.equal(cachedRejected.pendingWrites, 1, 'a validated cached rejected receipt must reconcile exactly once');

const remoteAppliedSeed = new Map([['yz-enrich-pending', {
  'event-123':{ event_id:'event-123', record_id:'rec-a', source_hash:HASH_A, transport:'queued' },
}]]);
const remoteApplied = await makeReceiptSidecarLoader(async () => ({ content:JSON.stringify(cachedAppliedSidecar) }), remoteAppliedSeed)();
assert.deepEqual(remoteApplied.pending, {}, 'a validated remote sidecar must reconcile same-record receipts');
assert.equal(remoteApplied.pendingWrites, 1, 'a validated remote sidecar must reconcile exactly once');

for(const [name, gh, seed] of [
  ['unavailable', async () => { throw new Error('offline'); }, new Map([['yz-enrich-pending', {
    'event-123':{ event_id:'event-123', record_id:'rec-a', source_hash:HASH_A, transport:'queued' },
  }]])],
  ['incompatible', async () => ({ content:JSON.stringify({ schema_version:2, records:{} }) }), new Map([['yz-enrich-pending', {
    'event-123':{ event_id:'event-123', record_id:'rec-a', source_hash:HASH_A, transport:'queued' },
  }]])],
]){
  const result = await makeReceiptSidecarLoader(gh, seed)();
  assert.deepEqual(result.pending, { 'event-123':{ event_id:'event-123', record_id:'rec-a', source_hash:HASH_A, transport:'queued' } },
    `${name} sidecars must not falsely resolve pending events`);
  assert.equal(result.pendingWrites, 0, `${name} sidecars must not reconcile`);
}

const provenanceWithUnexpectedField = structuredClone(sidecar);
provenanceWithUnexpectedField.records['rec-a'].provenance = [{
  actor: 'user', provider: 'openai-codex', model_requested: 'configured',
  model_reported: 'reported', accepted_at: '2026-08-21T10:00:00Z',
  confidence: 0.9, reason: 'completed', secret: 'must-not-pass'
}];
assert.equal(validateEnrichments(provenanceWithUnexpectedField).ok, false,
  'provenance with a non-allowlisted field must make the sidecar incompatible');

const provenanceWithWrongType = structuredClone(sidecar);
provenanceWithWrongType.records['rec-a'].provenance = [{ actor: 1 }];
assert.equal(validateEnrichments(provenanceWithWrongType).ok, false,
  'provenance with wrong field types must make the sidecar incompatible');

const validProvenance = structuredClone(sidecar);
validProvenance.records['rec-a'].provenance = [{
  actor: 'user', provider: 'openai-codex', model_requested: 'configured',
  model_reported: 'reported', accepted_at: '2026-08-21T10:00:00Z',
  confidence: 0.9, reason: 'completed'
}];
assert.deepEqual(validateEnrichments(validProvenance).value.records['rec-a'].provenance, validProvenance.records['rec-a'].provenance,
  'only documented, well-typed provenance fields may be preserved');

const STATUS_LABEL = new Function(`return (${assignedLiteral('STATUS_LABEL')})`)();
const STATUS_REASON_LABEL = new Function(`return (${assignedLiteral('STATUS_REASON_LABEL')})`)();
const viewContracts = new Function('esc', `
  const STATUS_LABEL = ${JSON.stringify(STATUS_LABEL)};
  const STATUS_REASON_LABEL = ${JSON.stringify(STATUS_REASON_LABEL)};
  ${namedFunction('statusLabel')}
  ${namedFunction('recordDate')}
  ${namedFunction('enrichmentRejectionLabel')}
  ${namedFunction('enrichmentResultForRecord')}
  ${namedFunction('statusReasonLabel')}
  ${namedFunction('enrichmentWarning')}
  ${namedFunction('graphWarning')}
  ${namedFunction('resolveConnection')}
  ${namedFunction('resolveConnections')}
  ${namedFunction('recordSearchText')}
  ${namedFunction('toggleCardDetails')}
  ${namedFunction('renderProvenance')}
  return {
    statusLabel, statusReasonLabel, enrichmentWarning, graphWarning, resolveConnection, resolveConnections,
    recordSearchText, toggleCardDetails, renderProvenance
  };
`)(value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char])));

assert.deepEqual(Object.keys(STATUS_LABEL).sort(), [
  'completed', 'failed', 'pending', 'privacy_review_required', 'retry_wait', 'skipped',
], 'the six sidecar statuses must have fixed display labels');
for (const [status, label] of Object.entries(STATUS_LABEL)) {
  assert.equal(viewContracts.statusLabel(status), label, `${status} must use its fixed escaped label`);
  assert.equal(viewContracts.statusLabel(`<img src=x onerror=${status}>`), '상태 확인 필요',
    'an unknown status must never become card HTML');
}
assert.equal(viewContracts.statusReasonLabel('provider_timeout'), STATUS_REASON_LABEL.provider_timeout,
  'documented safe reasons must use their fixed labels');
assert.equal(viewContracts.statusReasonLabel('<img src=x onerror=alert(1)>'), '상태 확인 필요',
  'an unknown reason must never be rendered verbatim');

assert.equal(viewContracts.enrichmentWarning('loaded'), '', 'a current sidecar needs no warning');
assert.equal(viewContracts.enrichmentWarning('cached'), '자동 분석 상태가 최신이 아닐 수 있음',
  'cached sidecar state must be visible');
for (const state of ['unavailable', 'incompatible']) {
  assert.equal(viewContracts.enrichmentWarning(state), '자동 분석 상태를 불러오지 못함',
    `${state} sidecar state must leave raw records viewable with a warning`);
  assert.equal(viewContracts.graphWarning(state), '태그·연결 정보를 불러오지 못해 이전 정보로 표시 중',
    `${state} graph state must remain explicit while the app uses legacy facts`);
}
assert.equal(viewContracts.graphWarning('cached'), '태그·연결 정보가 최신이 아닐 수 있음',
  'a cached graph state remains visible to the reader');

const connectionRecords = [
  { record_id: 'rec-a', body: '원본 연결 제목' },
  { record_id: 'rec-b', body: '연결된 기록 본문' },
];
const projects = { 'project-a': { title: '생활 OS' } };
assert.deepEqual(viewContracts.resolveConnection(
  { kind: 'record', target_id: 'rec-b', origin: 'auto', label: '신뢰하면 안 되는 라벨' },
  connectionRecords, projects,
), { label: '연결된 기록 본문', href: '#record-rec-b' },
  'record connections must resolve only against current raw records');
assert.deepEqual(viewContracts.resolveConnection(
  { kind: 'project', target_id: 'project-a', origin: 'auto', label: '신뢰하면 안 되는 라벨' },
  connectionRecords, projects,
), { label: '생활 OS', href: '' },
  'project connections must resolve only against the projected project catalog');
assert.deepEqual(viewContracts.resolveConnection(
  { kind: 'record', target_id: 'gone', origin: 'auto' }, connectionRecords, projects,
), { label: '대상 없음', href: '' }, 'unknown targets must not render a link');
assert.match(viewContracts.recordSearchText({ body: '기록', displayTags: [], detail: [], relatedItems: [
  { label: '생활 OS', href: '' },
] }), /생활 OS/, 'resolved related labels must be searchable');

assert.deepEqual(viewContracts.toggleCardDetails(false), {
  open: true, expanded: 'true', hidden: false,
}, 'collapsed card details must transition to accessible expanded markup state');
assert.deepEqual(viewContracts.toggleCardDetails(true), {
  open: false, expanded: 'false', hidden: true,
}, 'expanded card details must transition back to accessible collapsed markup state');
assert.doesNotMatch(source, /class="mk"|상세 보기|접기/, 'card details must use the card body as the only visible toggle affordance');
const provenanceHtml = viewContracts.renderProvenance([{
  actor: 'user', provider: 'openai-codex', model_requested: 'configured', model_reported: 'reported',
  accepted_at: '2026-08-21T10:00:00Z', confidence: 0.9, reason: 'completed', secret: '<do-not-render>',
}]);
assert.match(provenanceHtml, /openai-codex/, 'allowlisted provenance is visible only through its fixed fields');
assert.doesNotMatch(provenanceHtml, /do-not-render|secret/, 'non-allowlisted provenance must never enter detail markup');

const eventContracts = new Function(`
  const STATUS_REASON_LABEL = ${JSON.stringify(STATUS_REASON_LABEL)};
  ${namedFunction('normalizeEnrichmentTag')}
  ${namedFunction('buildEnrichmentEvent')}
  ${namedFunction('canonicalizeQueuedEnrichment')}
  ${namedFunction('enrichmentRejectionLabel')}
  ${namedFunction('resolveEnrichmentReceipt')}
  return {
    buildEnrichmentEvent, canonicalizeQueuedEnrichment, enrichmentRejectionLabel,
    resolveEnrichmentReceipt,
  };
`)();

const EVENT_TIME = '2026-08-23T10:11:12+09:00';
const eventRecord = {
  record_id: 'rec-a', source_hash: HASH_A, redaction_version: 3,
};
const eventCatalog = {
  records: [eventRecord, { record_id: 'rec-b', source_hash: HASH_B, redaction_version: 1 }],
  projects: { 'project-a': { title: '생활 OS' } },
};
const eventBase = { event_id: 'event-123', client_created_at: EVENT_TIME, record:eventRecord };

const addTag = eventContracts.buildEnrichmentEvent('add_tag', {
  ...eventBase, tag:' ##  새로운   태그 ', origin:'forbidden', provider:'forbidden',
}, eventCatalog);
assert.equal(addTag.ok, true, 'a current record may build an add-tag correction');
assert.deepEqual(addTag.value, {
  schema_version:1, event_id:'event-123', record_id:'rec-a', source_hash:HASH_A,
  action:'add_tag', client_created_at:EVENT_TIME, tag:'새로운 태그',
}, 'the add-tag builder must emit its exact schema-v1 allowlist only');
assert.deepEqual(Object.keys(eventContracts.buildEnrichmentEvent('remove_tag', {
  ...eventBase, tag:'#새로운 태그',
}, eventCatalog).value).sort(), [
  'action', 'client_created_at', 'event_id', 'record_id', 'schema_version', 'source_hash', 'tag',
], 'remove-tag must not serialize a redaction scope or server-derived fields');

for(const [action, extra, keys] of [
  ['add_connection', { connection:{ kind:'record', target_id:'rec-b' } },
    ['action','client_created_at','connection','event_id','record_id','schema_version','source_hash']],
  ['remove_connection', { connection:{ kind:'project', target_id:'project-a' } },
    ['action','client_created_at','connection','event_id','record_id','schema_version','source_hash']],
  ['allow_redacted', {},
    ['action','client_created_at','event_id','record_id','redaction_version','schema_version','source_hash']],
  ['allow_original', {},
    ['action','client_created_at','event_id','record_id','redaction_version','schema_version','source_hash']],
  ['skip_enrichment', {},
    ['action','client_created_at','event_id','record_id','redaction_version','schema_version','source_hash']],
]){
  const built = eventContracts.buildEnrichmentEvent(action, { ...eventBase, ...extra }, eventCatalog);
  assert.equal(built.ok, true, `${action} must have an allowlisted builder`);
  assert.deepEqual(Object.keys(built.value).sort(), keys, `${action} must emit exact schema-v1 keys`);
  assert.equal(built.value.redaction_version ?? 3, 3, `${action} must use the current redaction scope when scoped`);
}
const oldPrivacyChoice = eventContracts.buildEnrichmentEvent('allow_redacted', eventBase, eventCatalog).value;
assert.equal(eventContracts.canonicalizeQueuedEnrichment({
  ...oldPrivacyChoice, redaction_version:2,
}, eventCatalog).ok, false,
  'an offline privacy choice must expire instead of being rewritten onto a newer redaction version');
assert.equal(eventContracts.buildEnrichmentEvent('add_connection', {
  ...eventBase, connection:{ kind:'record', target_id:'missing' },
}, eventCatalog).ok, false, 'a connection target must exist in the current record catalog');
assert.equal(eventContracts.buildEnrichmentEvent('add_connection', {
  ...eventBase, connection:{ kind:'record', target_id:'rec-a' },
}, eventCatalog).ok, false, 'a record cannot be connected to itself');
assert.deepEqual(eventContracts.buildEnrichmentEvent('add_tag', {
  ...eventBase, record:{ ...eventRecord, source_hash:HASH_B }, tag:'tag',
}, eventCatalog).value.source_hash, HASH_B,
  'record-scoped corrections preserve the source hash they were created against');
assert.equal(eventContracts.buildEnrichmentEvent('set_processing_status', eventBase, eventCatalog).ok, false,
  'the browser may not construct worker-only actions');

const canonicalQueued = eventContracts.canonicalizeQueuedEnrichment({
  ...addTag.value, injected:'must-not-survive', source_hash:HASH_A,
}, eventCatalog);
assert.deepEqual(canonicalQueued, addTag,
  'queued entries must be rebuilt through the action allowlist before transport');
const changedRecordCatalog = {
  ...eventCatalog,
  records:eventCatalog.records.map(record => record.record_id === 'rec-a'
    ? { ...record, source_hash:HASH_B, redaction_version:4 } : record),
};
assert.deepEqual(eventContracts.canonicalizeQueuedEnrichment(addTag.value, changedRecordCatalog), addTag,
  'queued tag corrections remain record-scoped and preserve their original source hash');
const queuedConnection = eventContracts.buildEnrichmentEvent('add_connection', {
  ...eventBase, connection:{ kind:'project', target_id:'project-a' },
}, eventCatalog);
assert.deepEqual(eventContracts.canonicalizeQueuedEnrichment(queuedConnection.value, changedRecordCatalog),
  queuedConnection, 'queued connection corrections remain record-scoped after a source change');
assert.equal(eventContracts.canonicalizeQueuedEnrichment(oldPrivacyChoice, changedRecordCatalog).ok, false,
  'queued privacy decisions remain source-and-redaction scoped after a source change');
assert.equal(eventContracts.canonicalizeQueuedEnrichment({
  ...addTag.value, record_id:'gone', source_hash:HASH_A,
}, eventCatalog).ok, false, 'a queued entry for an unknown record must be quarantined');

const receipts = {
  schema_version:1, records:{
    'rec-a': { event_receipts:{ 'event-123':{ status:'applied', safe_reason:'applied' } } },
    'rec-b': { event_receipts:{ 'event-other':{ status:'rejected', safe_reason:'stale_scope' } } },
  }, targets:{ records:{}, projects:{} },
};
assert.deepEqual(eventContracts.resolveEnrichmentReceipt({ event_id:'event-123', record_id:'rec-a' }, receipts), {
  state:'applied', reason:'applied',
}, 'only an applied receipt on the same record resolves a queued event');
assert.deepEqual(eventContracts.resolveEnrichmentReceipt({ event_id:'event-other', record_id:'rec-a' }, receipts), {
  state:'rejected', reason:'projection_inconsistent',
}, 'a receipt on another record must be rejected as incompatible');
assert.deepEqual(eventContracts.resolveEnrichmentReceipt({ event_id:'event-missing', record_id:'rec-a' }, receipts), {
  state:'waiting', reason:'',
}, 'PUT success must remain waiting until the same-record receipt exists');
assert.deepEqual(eventContracts.resolveEnrichmentReceipt({ event_id:'event-other', record_id:'rec-b' }, receipts), {
  state:'rejected', reason:'stale_scope',
}, 'a same-record rejected receipt clears waiting with a safe reason only');
const futureSafeReceipt = structuredClone(receipts);
futureSafeReceipt.records['rec-a'].event_receipts['event-future'] = {
  status:'rejected', safe_reason:'future_safe_reason',
};
assert.deepEqual(eventContracts.resolveEnrichmentReceipt({ event_id:'event-future', record_id:'rec-a' }, futureSafeReceipt), {
  state:'rejected', reason:'future_safe_reason',
}, 'a bounded future backend reason resolves instead of leaving the event waiting');
assert.equal(eventContracts.enrichmentRejectionLabel('stale_scope'), STATUS_REASON_LABEL.stale_scope,
  'known rejection reasons must have fixed display labels');
assert.equal(eventContracts.enrichmentRejectionLabel('<raw failure>'), '반영 실패',
  'unknown rejection reasons must not enter the UI');
assert.equal(eventContracts.enrichmentRejectionLabel('invalid_introduction_metadata'), '반영 실패',
  'a schema-safe but unlabelled rejection reason must use the fixed failure label');

const putCalls = [];
const putContract = new Function('gh', 'b64encode', 'cfg', `
  ${namedFunction('normalizeEnrichmentTag')}
  ${namedFunction('buildEnrichmentEvent')}
  ${namedFunction('canonicalizeQueuedEnrichment')}
  ${namedFunction('putEnrichment')}
  return putEnrichment;
`)(async (path, options) => { putCalls.push({ path, options }); return {}; }, value => `encoded:${value}`, {});
await putContract(addTag.value, eventCatalog);
assert.equal(putCalls.length, 1, 'a valid enrichment event may issue one PUT');
assert.equal(putCalls[0].path, 'enrichment/pending/event-123.json',
  'enrichment transport must write only its immutable pending event path');
assert.deepEqual(JSON.parse(putCalls[0].options.body).message, 'enrichment: add_tag event-123',
  'the commit message may contain only the safe action and event ID');

function makeMemoryStore(seed = {}) {
  const state = new Map(Object.entries(seed));
  return {
    state,
    get: (key, fallback) => state.has(key) ? structuredClone(state.get(key)) : fallback,
    set: (key, value) => state.set(key, structuredClone(value)),
  };
}
function makeQueueContracts(store, put) {
  return new Function('ls', 'putEnrichment', 'ALL', 'ENRICH', `
    const LS = { eq:'eq', ex:'ex', ep:'ep', er:'er' };
    ${namedFunction('normalizeEnrichmentTag')}
    ${namedFunction('buildEnrichmentEvent')}
    ${namedFunction('canonicalizeQueuedEnrichment')}
    ${namedFunction('currentEnrichmentCatalog')}
    ${namedFunction('quarantineEnrichment')}
    ${namedFunction('markEnrichmentPending')}
    ${namedFunction('flushEnrichments')}
    ${namedFunction('queueEnrichment')}
    ${namedFunction('submitEnrichmentEvent')}
    return { flushEnrichments, queueEnrichment, submitEnrichmentEvent };
  `)(store, put, eventCatalog.records, { targets:{ projects:eventCatalog.projects } });
}

const offlineStore = makeMemoryStore();
const offline = makeQueueContracts(offlineStore, async () => { throw new Error('offline'); });
const offlineResult = await offline.submitEnrichmentEvent('add_tag', {
  ...eventBase, tag:'offline tag',
});
assert.equal(offlineResult.transport, 'offline', 'a transport failure must keep the correction in the separate offline queue');
assert.deepEqual(offlineStore.get('eq', []), [{
  schema_version:1, event_id:'event-123', record_id:'rec-a', source_hash:HASH_A,
  action:'add_tag', client_created_at:EVENT_TIME, tag:'offline tag',
}], 'offline queue entries must retain only the canonical event schema');
assert.deepEqual(offlineStore.get('ep', {})['event-123'], {
  event_id:'event-123', record_id:'rec-a', source_hash:HASH_A, transport:'offline',
}, 'offline storage must mark delivery as pending rather than applied');

const uploaded = [];
const flushStore = makeMemoryStore({ eq:[
  { event_id:'event-tampered', record_id:'rec-a', source_hash:HASH_A, action:'invented', secret:'must-not-copy' },
  { ...addTag.value, injected:'must-not-upload' },
] });
const flushing = makeQueueContracts(flushStore, async entry => { uploaded.push(entry); return entry; });
await flushing.flushEnrichments(false);
assert.equal(uploaded.length, 1, 'a malformed local queue entry must not block a later valid event');
assert.deepEqual(uploaded[0], addTag.value, 'the later valid event must be rebuilt without tampered fields');
assert.deepEqual(flushStore.get('ex', []), [{ event_id:'event-tampered', reason:'invalid_action' }],
  'local quarantine must retain only the safe event ID and reason');
assert.deepEqual(flushStore.get('eq', []), [], 'a successful queued PUT is removed from the offline queue');
assert.equal(flushStore.get('ep', {})['event-123'].transport, 'queued',
  'a successful PUT is queued for projection, never treated as applied');

const controlStore = makeMemoryStore();
const controlContracts = new Function('esc', 'ls', 'STATUS_REASON_LABEL', `
  const LS = { er:'er' };
  ${namedFunction('privacyDecisionIsCurrent')}
  ${namedFunction('enrichmentRejectionLabel')}
  ${namedFunction('enrichmentResultForRecord')}
  ${namedFunction('enrichmentControlState')}
  ${namedFunction('connectionCandidates')}
  ${namedFunction('renderEnrichmentControls')}
  return { privacyDecisionIsCurrent, enrichmentControlState, connectionCandidates, renderEnrichmentControls };
`)(value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char])), controlStore, STATUS_REASON_LABEL);

const editableRecord = {
  record_id:'rec-a', source_hash:HASH_A, content_hash:HASH_B, redaction_version:3, enrichmentStatus:'completed',
  displayTags:['하나'], connections:[],
};
assert.deepEqual(controlContracts.enrichmentControlState(editableRecord, 'loaded'), {
  enabled:true, mode:'normal', actions:['add_tag','remove_tag','add_connection','remove_connection'],
  tagSlots:2, connectionSlots:3,
}, 'a compatible, currently scoped ordinary record exposes compact correction controls');
assert.equal(controlContracts.enrichmentControlState({ ...editableRecord, record_id:'' }, 'loaded').enabled, false,
  'a missing record ID must disable every enrichment action');
assert.equal(controlContracts.enrichmentControlState({ ...editableRecord, redaction_version:0 }, 'loaded').enabled, false,
  'a missing current redaction version must disable every enrichment action');
assert.equal(controlContracts.enrichmentControlState(editableRecord, 'incompatible').enabled, false,
  'an incompatible sidecar must not expose write actions');

const privacyRecord = { ...editableRecord, enrichmentStatus:'privacy_review_required' };
assert.deepEqual(controlContracts.enrichmentControlState(privacyRecord, 'cached'), {
  enabled:true, mode:'privacy', actions:['allow_redacted','allow_original','skip_enrichment'],
  tagSlots:2, connectionSlots:3,
}, 'privacy review exposes exactly the three scope-bound privacy choices from a valid cached sidecar');
const privacyControls = controlContracts.renderEnrichmentControls(privacyRecord, 'cached', {
  targets:{ records:{ 'rec-b':{ title:'후보 기록' }, 'rec-a':{ title:'현재 기록' } }, projects:{ 'project-a':{ title:'생활 OS' } } },
});
assert.match(privacyControls, /data-enrich-action="allow_redacted"/, 'privacy controls include redacted permission');
assert.match(privacyControls, /data-enrich-action="allow_original"/, 'privacy controls include original permission');
assert.match(privacyControls, /data-enrich-action="skip_enrichment"/, 'privacy controls include skip permission');
assert.doesNotMatch(privacyControls, /add_tag|add_connection/, 'privacy controls must not mix in ordinary correction actions');
const pendingControls = controlContracts.renderEnrichmentControls({ ...editableRecord, enrichmentStatus:'pending' }, 'loaded', {
  targets:{ records:{}, projects:{} },
});
assert.equal(pendingControls, '', 'ordinary correction controls stay hidden until automatic enrichment completes');
controlStore.set('er', { 'rec-a':{
  event_id:'event-future', state:'rejected', reason:'future_safe_reason',
} });
const rejectedControls = controlContracts.renderEnrichmentControls(editableRecord, 'loaded', {
  targets:{ records:{}, projects:{} },
});
assert.match(rejectedControls, /반영 실패/,
  'a rejected receipt must remain visible through a fixed per-record result after pending clears');
assert.doesNotMatch(rejectedControls, /future_safe_reason/,
  'an unlabelled rejection reason must never render raw text');

assert.equal(controlContracts.privacyDecisionIsCurrent({
  action:'allow_redacted', source_hash:HASH_A, redaction_version:3,
}, editableRecord), true, 'a privacy choice is current only for its exact source and redaction scope');
assert.equal(controlContracts.privacyDecisionIsCurrent({
  action:'allow_original', content_hash:HASH_B, redaction_version:3,
}, editableRecord), true, 'a privacy choice is current for its exact content and redaction scope');
assert.equal(controlContracts.privacyDecisionIsCurrent({
  action:'allow_redacted', source_hash:HASH_B, redaction_version:3,
}, editableRecord), false, 'a privacy choice expires when the source changes');
assert.equal(controlContracts.privacyDecisionIsCurrent({
  action:'allow_original', content_hash:HASH_A, redaction_version:3,
}, editableRecord), false, 'a privacy choice expires when the content changes');
assert.equal(controlContracts.privacyDecisionIsCurrent({
  action:'allow_redacted', source_hash:HASH_A, redaction_version:2,
}, editableRecord), false, 'a privacy choice expires when redaction changes');
assert.equal(controlContracts.privacyDecisionIsCurrent({
  action:'allow_original', source_hash:HASH_A, content_hash:HASH_B, redaction_version:3,
}, editableRecord), false, 'a malformed dual-scoped privacy decision is never current');

assert.deepEqual(controlContracts.connectionCandidates(editableRecord, {
  targets:{ records:{ 'rec-a':{ title:'현재 기록' }, 'rec-b':{ title:'후보 기록' } }, projects:{ 'project-a':{ title:'생활 OS' } } },
}), [
  { kind:'record', target_id:'rec-b', label:'후보 기록' },
  { kind:'project', target_id:'project-a', label:'생활 OS' },
], 'connection controls must offer only sidecar catalog candidates and never the current record');

const tagLimitControls = controlContracts.renderEnrichmentControls({
  ...editableRecord, displayTags:['하나','둘','셋'],
}, 'loaded', { targets:{ records:{}, projects:{} } });
assert.match(tagLimitControls, /data-enrich-add-tag[^>]*disabled/, 'adding tags is disabled after three projected tags');

const cardContracts = new Function('esc', 'COLOR', 'STATUS_LABEL', 'STATUS_REASON_LABEL', 'enrichmentLoadState', 'ENRICH', 'ls', 'LS', `
  ${namedFunction('statusLabel')}
  ${namedFunction('recordDate')}
  ${namedFunction('enrichmentRejectionLabel')}
  ${namedFunction('enrichmentResultForRecord')}
  ${namedFunction('enrichmentControlState')}
  ${namedFunction('visibleEnrichmentIssue')}
  ${namedFunction('renderEnrichmentIssue')}
  ${namedFunction('recordTokenSet')}
  ${namedFunction('rankConnectionCandidates')}
  ${namedFunction('connectionCandidates')}
  ${namedFunction('recordMetadataDomId')}
  ${namedFunction('renderRecordMetadata')}
  ${namedFunction('renderEnrichmentControls')}
  ${namedFunction('renderEnrichmentEditor')}
  ${namedFunction('card')}
  return { visibleEnrichmentIssue, renderEnrichmentIssue, rankConnectionCandidates, renderRecordMetadata, renderEnrichmentEditor, card };
`)(value => String(value).replace(/[&<>\"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;',
}[char])), { memo:'var(--c1)' }, STATUS_LABEL, STATUS_REASON_LABEL, 'loaded', { targets:{ records:{}, projects:{} } }, controlStore, { er:'er' });

for(const status of ['completed', 'pending', 'skipped']){
  const rendered = cardContracts.card({ ...editableRecord, type:'memo', body:'정상 본문', date:'2026-08-24',
    enrichmentStatus:status, enrichmentReason:status, detail:['제목: 원래 필드'], relatedItems:[] });
  assert.doesNotMatch(rendered, /분석 상태|태그 출처|분석 이력|사유/, `${status} cards hide enrichment diagnostics`);
  assert.match(rendered, /data-enrich-edit/, `${status} cards always expose an explicit edit button`);
}
const detailLessCard = cardContracts.card({ ...editableRecord, type:'memo', body:'상세 없는 긴 본문', date:'2026-08-24', detail:[], relatedItems:[] });
assert.match(detailLessCard, /<p class="card-body" role="button" tabindex="0" aria-expanded="false" aria-controls="metadata-main-rec-a">/,
  'a detail-less card body still has an accessible tap and keyboard expansion affordance');
assert.match(detailLessCard, /id="metadata-main-rec-a" class="record-metadata" data-card-metadata hidden/,
  'tags and connections stay hidden until the card is selected');
assert.deepEqual(cardContracts.visibleEnrichmentIssue({ enrichmentStatus:'completed' }), null,
  'completed status is not a card-level issue');
assert.deepEqual(cardContracts.visibleEnrichmentIssue({ enrichmentStatus:'retry_wait' }), {
  status:'retry_wait', message:'자동 분석 재시도 중',
}, 'retry state has only a concise user action message');
assert.match(cardContracts.renderEnrichmentIssue({ ...privacyRecord, type:'memo' }, 'loaded', {}), /개인정보 확인 필요/,
  'privacy review renders a concise issue rather than raw diagnostic fields');
for(const sidecarState of ['unavailable', 'incompatible']){
  const editor = cardContracts.renderEnrichmentEditor(editableRecord, sidecarState, { targets:{ records:{}, projects:{} } });
  assert.match(editor, /data-enrich-edit[^>]*disabled[^>]*분석 상태를 확인한 뒤 수정 가능/,
    `${sidecarState} sidecars disable editing with an accessible reason`);
}
const pendingEditor = cardContracts.renderEnrichmentEditor({ ...editableRecord, enrichmentStatus:'pending' }, 'loaded', { targets:{ records:{}, projects:{} } });
assert.match(pendingEditor, /data-enrich-edit[^>]*disabled[^>]*분석 완료 전에는 수정할 수 없음/,
  'pending enrichment disables editing with its specific accessible reason');
for(const status of ['retry_wait', 'failed', 'skipped']){
  const editor = cardContracts.renderEnrichmentEditor({ ...editableRecord, enrichmentStatus:status }, 'loaded', { targets:{ records:{}, projects:{} } });
  assert.match(editor, /data-enrich-edit(?![^>]*disabled)/, `${status} keeps its edit button enabled when scope is valid`);
  assert.match(editor, /enrich-editor-main-rec-a[\s\S]*enrich-controls/, `${status} provides a usable tag and connection edit panel`);
}
const mainCardMarkup = cardContracts.card({ ...editableRecord, type:'memo', body:'동일 기록', date:'2026-08-24', detail:['제목: 원래 필드'], relatedItems:[] }, 'main');
const subCardMarkup = cardContracts.card({ ...editableRecord, type:'memo', body:'동일 기록', date:'2026-08-24', detail:['제목: 원래 필드'], relatedItems:[] }, 'sub');
assert.match(mainCardMarkup, /id="record-main-rec-a"[\s\S]*aria-controls="details-main-rec-a metadata-main-rec-a"[\s\S]*id="details-main-rec-a"[\s\S]*id="metadata-main-rec-a"[\s\S]*aria-controls="enrich-editor-main-rec-a"/,
  'main cards use view-scoped record, detail, and editor IDs');
assert.match(subCardMarkup, /id="record-sub-rec-a"[\s\S]*aria-controls="details-sub-rec-a metadata-sub-rec-a"[\s\S]*id="details-sub-rec-a"[\s\S]*id="metadata-sub-rec-a"[\s\S]*aria-controls="enrich-editor-sub-rec-a"/,
  'subview cards use distinct view-scoped IDs and aria controls');
assert.doesNotMatch(subCardMarkup, /record-main-rec-a|details-main-rec-a|enrich-editor-main-rec-a/,
  'coexisting main and subview cards do not duplicate DOM IDs');
const ids = markup => [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const mainIds = new Set(ids(mainCardMarkup)), subIds = new Set(ids(subCardMarkup));
assert.deepEqual([...mainIds].filter(id => subIds.has(id)), [],
  'all main and subview card IDs, including inputs, are disjoint');
assert.match(mainCardMarkup, /for="enrich-tag-main-rec-a"[\s\S]*id="enrich-tag-main-rec-a"[\s\S]*id="enrich-connection-search-main-rec-a"/,
  'main editor labels target namespaced inputs');
assert.match(subCardMarkup, /for="enrich-tag-sub-rec-a"[\s\S]*id="enrich-tag-sub-rec-a"[\s\S]*id="enrich-connection-search-sub-rec-a"/,
  'subview editor labels target namespaced inputs');
const bindSource = namedFunction('bind');
assert.match(bindSource, /const metadata = c\.querySelector\('\[data-card-metadata\]'\)/,
  'card binding tracks the separately rendered metadata section');
assert.match(bindSource, /c\.classList\.toggle\('selected', next\.open\)/,
  'selecting a card makes its metadata state explicit');
assert.match(bindSource, /metadata\.hidden = !next\.open/,
  'metadata is revealed only while the card is selected');
assert.doesNotMatch(bindSource, /c\.id\.replace\(\/\^record-\//,
  'namespaced cards never derive a logical record ID from their DOM ID');
assert.match(bindSource, /item\.record_id === c\.dataset\.recordId/,
  'edit opening and connection search resolve records from data-record-id');
const privacyEditor = cardContracts.renderEnrichmentEditor(privacyRecord, 'loaded', { targets:{ records:{}, projects:{} } });
assert.match(privacyEditor, /allow_redacted[\s\S]*allow_original[\s\S]*skip_enrichment/,
  'privacy review keeps all three privacy actions behind its explicit edit control');

const ranked = cardContracts.rankConnectionCandidates({ ...editableRecord, body:'ＡＩ 모바일 자동화', date:'2026-08-20' }, [
  { record_id:'rec-z', body:'ai 자동화', displayTags:['모바일'], date:'2026-08-21' },
  { record_id:'rec-b', body:'AI 자동화', displayTags:['모바일'], date:'2026-08-22' },
  { record_id:'rec-a', body:'self', displayTags:[], date:'2026-08-23' },
], { targets:{ records:{}, projects:{ 'project-a':{ title:'AI 자동화' } } } });
assert.deepEqual(ranked.map(candidate => `${candidate.kind}:${candidate.target_id}`), ['record:rec-b', 'record:rec-z', 'project:project-a'],
  'recommendations use NFKC common-token score, newest date, and target ID ordering');
assert.match(cardContracts.renderRecordMetadata({ ...editableRecord, relatedItems:[
  { label:'관련 기록', href:'#record-rec-b' },
  { label:'생활 OS', href:'' },
], connections:[
  { kind:'record', target_id:'rec-b' }, { kind:'project', target_id:'project-a' },
] }), /분류·관계 메타데이터[\s\S]*태그[\s\S]*metadata-connections[\s\S]*연결[\s\S]*data-focus-record/,
  'metadata has labeled tags and neutral connected-record chips separate from external URLs');
assert.match(html, /metadata-connections \.metadata-values\{[^}]*flex-wrap:nowrap[^}]*overflow:hidden/,
  'connection metadata is constrained to a single visible line');
assert.match(html, /html\{-webkit-text-size-adjust:100%;text-size-adjust:100%\}/,
  'mobile text autosizing is fixed without disabling full-page pinch zoom');
assert.match(html, /\.card\{[^}]*width:100%;min-width:0;max-width:100%\}/,
  'record cards keep a fixed width inside responsive grid tracks');
assert.match(html, /\.card p\{[^}]*overflow-wrap:anywhere;word-break:break-word;/,
  'long record text wraps instead of expanding the card width');

const focusState = { q:'현재 검색', tag:'memo', undone:true };
const visibleSubCard = { classList:{ add(){} }, scrollIntoView(){} };
const focusContracts = new Function('ALL', 'toast', 'renderList', 'renderSub', '$', `
  let forcedConnectedRecordId = '', highlightedRecordId = '', subType = '';
  ${namedFunction('focusConnectedRecord')}
  ${namedFunction('appendForcedConnectedRecord')}
  return { focusConnectedRecord, appendForcedConnectedRecord, setSubType:value => { subType=value; }, state:() => ({ forcedConnectedRecordId, highlightedRecordId, subType }) };
`)([
  { record_id:'rec-in-filter', type:'memo' }, { record_id:'rec-outside', type:'idea' },
], message => { focusContractsMessage = message; }, () => { focusContractsRendered += 1; }, () => { focusContractsSubRendered += 1; }, id => ({ querySelector:selector => id === 'sub-list' && selector === '[data-record-id="rec-outside"]' ? visibleSubCard : null }));
let focusContractsMessage = '', focusContractsRendered = 0, focusContractsSubRendered = 0;
focusContracts.focusConnectedRecord('rec-outside');
assert.deepEqual(focusState, { q:'현재 검색', tag:'memo', undone:true },
  'focusing a connection does not mutate the current filter state');
assert.equal(focusContractsRendered, 1, 'focusing a connected record renders exactly once');
assert.deepEqual(focusContracts.appendForcedConnectedRecord([{ record_id:'rec-in-filter' }], focusContracts.state().forcedConnectedRecordId, [
  { record_id:'rec-in-filter' }, { record_id:'rec-outside' },
]).map(record => record.record_id), ['rec-outside', 'rec-in-filter'],
  'renderList prepends a linked target outside the active filter or 80-item window once');
assert.equal(focusContracts.state().highlightedRecordId, 'rec-outside', 'the forced target is marked for highlight');
focusContracts.setSubType('읽을거리');
focusContracts.focusConnectedRecord('rec-outside');
assert.equal(focusContractsSubRendered, 1, 'an active subview rerenders itself for connected-record focus');
assert.deepEqual(focusContracts.appendForcedConnectedRecord([], focusContracts.state().forcedConnectedRecordId, [
  { record_id:'rec-outside' },
]).map(record => record.record_id), ['rec-outside'], 'a subview may one-shot include a target outside its subtype');
focusContracts.focusConnectedRecord('rec-missing');
assert.equal(focusContractsMessage, '연결된 기록을 찾을 수 없음', 'a missing connection reports without rendering or changing state');
assert.match(html, /compact-list button\{min-width:44px;min-height:44px/, 'compact delete controls meet the 44px touch target');
assert.match(source, /const panel = c\.querySelector\('\[data-enrich-editor-panel\]'\)/,
  'an edit button resolves its panel within its own card when main and subview cards coexist');
assert.match(source, /activeList && activeList\.querySelector\(`\[data-record-id="\$\{recordId\}"\]`\)/,
  'connected-record focus resolves only within the active visible list');

/* Pre-cutover E2E fixture. This intentionally joins the actual loader, composition,
   correction queue, and receipt reconciliation functions rather than re-stating their
   behaviour with isolated stubs. */
function makePreCutoverApp(records, initialSidecar) {
  const store = makeMemoryStore();
  let remoteSidecar = structuredClone(initialSidecar);
  const uploads = [];
  const app = new Function('gh', 'b64decode', 'ls', 'putEnrichment', 'cfg', 'DATA', `
    const LS = { d:'capture-data', q:'capture-queue', e:'sidecar', ee:'sidecar-etag', ea:'sidecar-at',
      eq:'enrichment-queue', ex:'enrichment-quarantine', ep:'enrichment-pending' };
    let ENRICH = { schema_version:1, records:{}, targets:{ records:{}, projects:{} } };
    let GRAPH = { schema_version:1, projection_sequence:0, nodes:[], contains:[] };
    let enrichmentLoadState = 'unavailable', ALL = [];
    ${namedFunction('normalizeEnrichmentTag')}
    ${namedFunction('buildEnrichmentEvent')}
    ${namedFunction('canonicalizeQueuedEnrichment')}
    ${namedFunction('resolveEnrichmentReceipt')}
    ${namedFunction('validateEnrichments')}
    ${namedFunction('composeRecords')}
    ${namedFunction('resolveConnection')}
    ${namedFunction('resolveConnections')}
    ${namedFunction('recordDate')}
    ${namedFunction('recordSavedAt')}
    ${namedFunction('prepData')}
    ${namedFunction('currentEnrichmentCatalog')}
    ${namedFunction('quarantineEnrichment')}
    ${namedFunction('markEnrichmentPending')}
    ${namedFunction('flushEnrichments')}
    ${namedFunction('queueEnrichment')}
    ${namedFunction('submitEnrichmentEvent')}
    ${namedFunction('reconcileEnrichmentPending')}
    ${namedFunction('loadEnrichments')}
    ${namedFunction('loadData')}
    return {
      loadData, submitEnrichmentEvent,
      snapshot(){ return { ALL:structuredClone(ALL), ENRICH:structuredClone(ENRICH),
        enrichmentLoadState, pending:ls.get(LS.ep, {}), offline:ls.get(LS.eq, []),
        quarantined:ls.get(LS.ex, []) }; }
    };
  `)(async path => {
    if(path.startsWith('records.json')) return { content:JSON.stringify({ records }) };
    if(path.startsWith('record-enrichments.json')) return { content:JSON.stringify(remoteSidecar) };
    throw new Error(`unexpected fixture request: ${path}`);
  }, value => value, store, async entry => {
    uploads.push(structuredClone(entry));
    return entry;
  }, { branch:'main' }, { records });
  return { app, uploads, setRemote: value => { remoteSidecar = structuredClone(value); } };
}

function preCutoverRecord({ status = 'completed', reason = 'completed', tags = [], connections = [],
  receipts = {}, privacyDecision = undefined } = {}) {
  const record = {
    record_id:'rec-main', source_hash:HASH_A, status, status_reason:reason,
    prompt_version:1, redaction_version:3,
    tags, connections, event_receipts:receipts, applied_event_ids:[], provenance:[],
  };
  if(privacyDecision !== undefined) record.privacy_decision = privacyDecision;
  return record;
}
function preCutoverSidecar(record) {
  return { schema_version:1, records:{ 'rec-main':record }, targets:{
    records:{ 'rec-related':{ title:'관련 기록' } }, projects:{ 'project-life':{ title:'생활 OS' } },
  } };
}

const preCutoverRecords = [
  { record_id:'rec-main', source_hash:HASH_A, tags:['기존 태그'], body:'수정할 기록', date:'2026-08-23' },
  { record_id:'rec-related', source_hash:HASH_B, tags:[], body:'관련 기록 원문', date:'2026-08-22' },
];
const automaticProjection = preCutoverSidecar(preCutoverRecord({
  tags:[{ value:'자동 태그', origin:'auto' }],
  connections:[{ kind:'record', target_id:'rec-related', origin:'auto' }],
}));
const preCutover = makePreCutoverApp(preCutoverRecords, automaticProjection);

await preCutover.app.loadData();
let snapshot = preCutover.app.snapshot();
assert.equal(snapshot.enrichmentLoadState, 'loaded', 'the E2E fixture must load records and the current sidecar');
assert.deepEqual(snapshot.ALL.find(record => record.record_id === 'rec-main').displayTags, ['자동 태그'],
  'the pre-cutover view must render the auto tag rather than merging raw manual tags');
assert.deepEqual(snapshot.ALL.find(record => record.record_id === 'rec-main').connections, [
  { kind:'record', target_id:'rec-related', origin:'auto' },
], 'the pre-cutover view must render the typed connection');

const removeResult = await preCutover.app.submitEnrichmentEvent('remove_tag', {
  event_id:'event-remove-auto', client_created_at:EVENT_TIME,
  record:snapshot.ALL.find(record => record.record_id === 'rec-main'), tag:'자동 태그',
});
assert.equal(removeResult.transport, 'queued', 'a user tag removal remains pending after delivery, not applied');
assert.deepEqual(preCutover.uploads, [{
  schema_version:1, event_id:'event-remove-auto', record_id:'rec-main', source_hash:HASH_A,
  action:'remove_tag', client_created_at:EVENT_TIME, tag:'자동 태그',
}], 'the queued removal must retain the exact dedicated enrichment payload');
assert.equal(preCutover.app.snapshot().pending['event-remove-auto'].transport, 'queued',
  'the view keeps the correction at 반영 대기 until a matching receipt is projected');

preCutover.setRemote(preCutoverSidecar(preCutoverRecord({
  tags:[], connections:[], receipts:{ 'event-remove-auto':{ status:'applied', safe_reason:'applied' } },
})));
await preCutover.app.loadData();
snapshot = preCutover.app.snapshot();
assert.deepEqual(snapshot.pending, {}, 'an applied same-record receipt removes the queued correction');
assert.deepEqual(snapshot.ALL.find(record => record.record_id === 'rec-main').displayTags, [],
  'an applied removal replaces 반영 대기 with the corrected final projection');

const rejected = makePreCutoverApp(preCutoverRecords, automaticProjection);
await rejected.app.loadData();
snapshot = rejected.app.snapshot();
await rejected.app.submitEnrichmentEvent('remove_tag', {
  event_id:'event-reject-auto', client_created_at:EVENT_TIME,
  record:snapshot.ALL.find(record => record.record_id === 'rec-main'), tag:'자동 태그',
});
rejected.setRemote(preCutoverSidecar(preCutoverRecord({
  tags:[{ value:'자동 태그', origin:'auto' }],
  connections:[{ kind:'record', target_id:'rec-related', origin:'auto' }],
  receipts:{ 'event-reject-auto':{ status:'rejected', safe_reason:'stale_scope' } },
})));
await rejected.app.loadData();
snapshot = rejected.app.snapshot();
assert.deepEqual(snapshot.pending, {}, 'a rejected same-record receipt also resolves the local waiting state');
assert.deepEqual(snapshot.ALL.find(record => record.record_id === 'rec-main').displayTags, ['자동 태그'],
  'a rejected removal must leave the authoritative projected tag unchanged');

const privacyStart = preCutoverSidecar(preCutoverRecord({
  status:'privacy_review_required', reason:'privacy_review_required',
  tags:[{ value:'가린 태그', origin:'auto' }],
}));
const privacy = makePreCutoverApp(preCutoverRecords, privacyStart);
await privacy.app.loadData();
snapshot = privacy.app.snapshot();
const flowPrivacyRecord = snapshot.ALL.find(record => record.record_id === 'rec-main');
assert.equal(flowPrivacyRecord.enrichmentStatus, 'privacy_review_required',
  'the E2E fixture starts from the privacy-review state');
const allowRedacted = await privacy.app.submitEnrichmentEvent('allow_redacted', {
  event_id:'event-allow-redacted', client_created_at:EVENT_TIME, record:flowPrivacyRecord,
});
assert.equal(allowRedacted.transport, 'queued', 'redacted analysis permission must remain pending after delivery');
assert.deepEqual(privacy.app.snapshot().pending['event-allow-redacted'], {
  event_id:'event-allow-redacted', record_id:'rec-main', source_hash:HASH_A, transport:'queued',
}, 'the privacy decision uses the separate enrichment pending store');

privacy.setRemote(preCutoverSidecar(preCutoverRecord({
  status:'pending', reason:'pending', tags:[{ value:'가린 태그', origin:'auto' }],
  privacyDecision:{ action:'allow_redacted', source_hash:HASH_A, redaction_version:3 },
})));
await privacy.app.loadData();
snapshot = privacy.app.snapshot();
assert.equal(snapshot.ALL.find(record => record.record_id === 'rec-main').enrichmentStatus, 'pending',
  'redacted permission advances privacy review to the pending analysis projection');
assert.ok(snapshot.pending['event-allow-redacted'], 'pending analysis does not falsely treat permission delivery as completed');

privacy.setRemote(preCutoverSidecar(preCutoverRecord({
  status:'completed', reason:'completed', tags:[{ value:'가린 태그', origin:'auto' }],
  receipts:{ 'event-allow-redacted':{ status:'applied', safe_reason:'applied' } },
  privacyDecision:{ action:'allow_redacted', source_hash:HASH_A, redaction_version:3 },
})));
await privacy.app.loadData();
snapshot = privacy.app.snapshot();
const completedPrivacy = snapshot.ALL.find(record => record.record_id === 'rec-main');
assert.equal(completedPrivacy.enrichmentStatus, 'completed',
  'the privacy flow reaches the completed projection only after an applied receipt');
assert.deepEqual(snapshot.pending, {}, 'the completed privacy receipt clears the separate pending state');
assert.deepEqual(completedPrivacy.privacyDecision, {
  action:'allow_redacted', source_hash:HASH_A, redaction_version:3,
}, 'the completed projection retains the exact redacted-analysis scope');

assert.doesNotMatch(html, /id="q-tags"/, 'quick capture must not expose a manual tag field before automatic enrichment');
assert.match(source, /const p = \{ type:CAPTURE_KINDS\[uiType\] \? 'memo' : uiType,\s*body:raw \};/,
  'quick capture sends no manual tag before automatic enrichment');
assert.match(source, /q:'yz-queue'[\s\S]*eq:'yz-enrich-queue'/,
  'capture and enrichment queues remain distinct throughout pre-cutover shadow mode');

console.log('enrichment view contracts pass');
