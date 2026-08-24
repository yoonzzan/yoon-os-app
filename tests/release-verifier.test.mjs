import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { verifyRelease, publicUrlFor, repositoryFromOrigin } from '../scripts/verify-release.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function cleanGit({ branch = 'main', head = SHA, remoteHead = SHA, upstream = 'origin/main', dirty = '' } = {}) {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const responses = {
      'git --no-optional-locks status --porcelain': dirty,
      'git rev-parse HEAD': head,
      'git rev-parse origin/main': remoteHead,
      'git branch --show-current': branch,
      'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': upstream,
      'git remote get-url origin': 'https://github.com/yoonzzan/yoon-os-app.git',
    };
    if (!(key in responses)) throw new Error(`unexpected command: ${key}`);
    return responses[key];
  };
}

function dependencies(overrides = {}) {
  return {
    run: cleanGit(),
    remoteMain: () => SHA,
    pagesBuild: () => ({ commit: SHA, status: 'built' }),
    httpStatus: () => 200,
    ...overrides,
  };
}

test('derives a public GitHub Pages project URL from the origin remote', () => {
  assert.deepEqual(repositoryFromOrigin('git@github.com:yoonzzan/yoon-os-app.git'), {
    owner: 'yoonzzan', repo: 'yoon-os-app',
  });
  assert.equal(publicUrlFor({ owner: 'yoonzzan', repo: 'yoon-os-app' }),
    'https://yoonzzan.github.io/yoon-os-app/');
  assert.throws(() => repositoryFromOrigin('git@github.com:bad_owner/yoon-os-app.git'));
  assert.throws(() => publicUrlFor({ owner: 'yoonzzan.evil', repo: 'yoon-os-app' }));
});

test('reports success only when all release identities and the public URL agree', () => {
  let remoteMainCalls = 0;
  let pagesBuildCalls = 0;
  const result = verifyRelease(dependencies({
    remoteMain: () => { remoteMainCalls += 1; return SHA; },
    pagesBuild: () => { pagesBuildCalls += 1; return { commit: SHA, status: 'built' }; },
  }));
  assert.deepEqual(result, {
    ok: true,
    reason: 'release verification passed',
    details: {
      branch: 'main', head: SHA, pagesCommit: SHA,
      url: 'https://yoonzzan.github.io/yoon-os-app/',
    },
  });
  assert.equal(remoteMainCalls, 2, 'GitHub main must be read before and after the URL check');
  assert.equal(pagesBuildCalls, 2, 'GitHub Pages build must be read before and after the URL check');
});

test('rejects a dirty worktree before querying external services', () => {
  let remoteMainCalled = false;
  const result = verifyRelease(dependencies({
    run: cleanGit({ dirty: ' M index.html' }),
    remoteMain: () => { remoteMainCalled = true; return SHA; },
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /worktree is not clean/);
  assert.equal(remoteMainCalled, false);
});

test('rejects a branch that is not main or does not track origin/main', () => {
  for (const git of [
    cleanGit({ branch: 'chore/release-verifier', upstream: 'origin/main' }),
    cleanGit({ branch: 'main', upstream: 'origin/chore/release-verifier' }),
  ]) {
    const result = verifyRelease(dependencies({ run: git }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /branch must be main and track origin\/main/);
  }
});

test('rejects local, cached remote, actual remote, and Pages commit disagreement', () => {
  for (const overrides of [
    { run: cleanGit({ remoteHead: OTHER_SHA }) },
    { remoteMain: () => OTHER_SHA },
    { pagesBuild: () => ({ commit: OTHER_SHA, status: 'built' }) },
  ]) {
    const result = verifyRelease(dependencies(overrides));
    assert.equal(result.ok, false);
    assert.match(result.reason, /commit mismatch/);
  }
});

test('rejects a legacy Pages build that is not built', () => {
  const result = verifyRelease(dependencies({ pagesBuild: () => ({ commit: SHA, status: 'building' }) }));
  assert.deepEqual(result, {
    ok: false,
    reason: 'GitHub Pages latest build status is building, expected built',
    details: { pagesStatus: 'building' },
  });
});

test('reports unavailable remote, Pages, and curl boundaries without leaking command output', () => {
  for (const overrides of [
    { remoteMain: () => { throw new Error('gh: command not found: secret-value'); } },
    { pagesBuild: () => { throw new Error('gh: command not found: secret-value'); } },
    { httpStatus: () => { throw new Error('curl: command not found: secret-value'); } },
  ]) {
    const result = verifyRelease(dependencies(overrides));
    assert.equal(result.ok, false);
    assert.match(result.reason, /GitHub lookup failed|public URL check failed/);
    assert.doesNotMatch(result.reason, /secret-value/);
  }
});

test('rejects a repository state that changes while external checks run', () => {
  let headReads = 0;
  const git = cleanGit();
  const result = verifyRelease(dependencies({
    run(command, args) {
      if (`${command} ${args.join(' ')}` === 'git rev-parse HEAD') {
        headReads += 1;
        return headReads === 1 ? SHA : OTHER_SHA;
      }
      return git(command, args);
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    reason: 'repository state changed during verification',
    details: {},
  });
});

test('rejects GitHub ref or Pages build changes observed after the URL check', () => {
  for (const overrides of [
    { remoteMain: (() => { let calls = 0; return () => (++calls === 1 ? SHA : OTHER_SHA); })() },
    { pagesBuild: (() => { let calls = 0; return () => (++calls === 1
      ? { commit: SHA, status: 'built' }
      : { commit: OTHER_SHA, status: 'built' }); })() },
  ]) {
    const result = verifyRelease(dependencies(overrides));
    assert.deepEqual(result, {
      ok: false,
      reason: 'GitHub state changed during verification',
      details: {},
    });
  }
});

test('CLI uses an explicit non-repository cwd and returns a deterministic nonzero result', () => {
  const script = resolve(import.meta.dirname, '..', 'scripts', 'verify-release.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'release-verifier-test-'));
  try {
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'FAIL: local repository check failed (git unavailable or origin/main is missing)\n');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects non-200 public URLs', () => {
  const result = verifyRelease(dependencies({ httpStatus: () => 503 }));
  assert.deepEqual(result, {
    ok: false,
    reason: 'public URL returned HTTP 503',
    details: { url: 'https://yoonzzan.github.io/yoon-os-app/' },
  });
});
