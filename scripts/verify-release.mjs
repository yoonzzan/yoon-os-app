#!/usr/bin/env node
/**
 * Read-only release verifier. It deliberately invokes no shell and only reads
 * Git metadata, GitHub Pages metadata, and the deployed public URL.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})?$/;
const REPOSITORY_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function commandOutput(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function failure(reason, details = {}) {
  return { ok: false, reason, details };
}

export function repositoryFromOrigin(origin) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(origin);
  if (!match) throw new Error('origin is not a supported GitHub repository URL');
  const repository = { owner: match[1], repo: match[2] };
  if (!OWNER_SLUG.test(repository.owner) || !REPOSITORY_SLUG.test(repository.repo)) {
    throw new Error('origin repository name is not an allowed GitHub slug');
  }
  return repository;
}

export function publicUrlFor({ owner, repo }) {
  if (!OWNER_SLUG.test(owner) || !REPOSITORY_SLUG.test(repo)) {
    throw new Error('repository name is not an allowed GitHub slug');
  }
  const url = new URL(`https://${owner}.github.io/${repo}/`);
  if (url.protocol !== 'https:' || url.hostname !== `${owner}.github.io`) {
    throw new Error('public URL hostname does not match repository owner');
  }
  return url.href;
}

function defaultRemoteMain(repository) {
  const body = commandOutput('gh', [
    'api', `repos/${repository.owner}/${repository.repo}/git/ref/heads/main`,
  ]);
  const sha = JSON.parse(body).object?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('GitHub main ref response is invalid');
  }
  return sha;
}

function defaultPagesBuild(repository) {
  const body = commandOutput('gh', [
    'api', `repos/${repository.owner}/${repository.repo}/pages/builds/latest`,
  ]);
  const build = JSON.parse(body);
  if (typeof build.commit !== 'string' || typeof build.status !== 'string') {
    throw new Error('latest GitHub Pages build response is invalid');
  }
  return { commit: build.commit, status: build.status };
}

function defaultHttpStatus(url) {
  const status = commandOutput('curl', [
    '--fail', '--silent', '--show-error', '--max-time', '15',
    '--output', '/dev/null', '--write-out', '%{http_code}', url,
  ]);
  if (!/^\d{3}$/.test(status)) throw new Error('curl returned no HTTP status');
  return Number(status);
}

function snapshot(run) {
  return {
    dirty: run('git', ['--no-optional-locks', 'status', '--porcelain']),
    head: run('git', ['rev-parse', 'HEAD']),
    remoteHead: run('git', ['rev-parse', 'origin/main']),
    branch: run('git', ['branch', '--show-current']),
    upstream: run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    repository: repositoryFromOrigin(run('git', ['remote', 'get-url', 'origin'])),
  };
}

function sameSnapshot(first, second) {
  return first.dirty === second.dirty
    && first.head === second.head
    && first.remoteHead === second.remoteHead
    && first.branch === second.branch
    && first.upstream === second.upstream
    && first.repository.owner === second.repository.owner
    && first.repository.repo === second.repository.repo;
}

/**
 * Verify without changing local refs, the worktree, or any remote state.
 * Dependencies are injectable so tests never make network calls.
 */
export function verifyRelease({
  run = commandOutput,
  remoteMain = defaultRemoteMain,
  pagesBuild = defaultPagesBuild,
  httpStatus = defaultHttpStatus,
} = {}) {
  let local;
  try {
    local = snapshot(run);
  } catch {
    return failure('local repository check failed (git unavailable or origin/main is missing)');
  }
  if (local.dirty) return failure('worktree is not clean');

  if (local.branch !== 'main' || local.upstream !== 'origin/main') {
    return failure('branch must be main and track origin/main', { branch: local.branch, upstream: local.upstream });
  }
  if (local.head !== local.remoteHead) {
    return failure('commit mismatch: local HEAD does not equal origin/main', { head: local.head, remoteHead: local.remoteHead });
  }

  let actualRemoteMain;
  let latestPagesBuild;
  try {
    actualRemoteMain = remoteMain(local.repository);
    latestPagesBuild = pagesBuild(local.repository);
  } catch {
    return failure('GitHub lookup failed (gh unavailable, network failed, or response invalid)');
  }
  if (typeof actualRemoteMain !== 'string' || !/^[0-9a-f]{40}$/i.test(actualRemoteMain)) {
    return failure('GitHub lookup failed (main ref response is invalid)');
  }
  if (actualRemoteMain !== local.head) {
    return failure('commit mismatch: GitHub main does not equal local HEAD', {
      head: local.head, actualRemoteMain,
    });
  }
  if (!latestPagesBuild || typeof latestPagesBuild.commit !== 'string' || typeof latestPagesBuild.status !== 'string') {
    return failure('GitHub Pages lookup failed (latest build response is invalid)');
  }
  if (latestPagesBuild.status !== 'built') {
    return failure(`GitHub Pages latest build status is ${latestPagesBuild.status}, expected built`, {
      pagesStatus: latestPagesBuild.status,
    });
  }
  if (latestPagesBuild.commit !== local.head) {
    return failure('commit mismatch: GitHub Pages latest built commit does not equal local HEAD', {
      head: local.head, pagesCommit: latestPagesBuild.commit,
    });
  }

  const url = publicUrlFor(local.repository);
  let status;
  try {
    status = httpStatus(url);
  } catch {
    return failure('public URL check failed (curl unavailable or network failed)', { url });
  }
  if (status !== 200) return failure(`public URL returned HTTP ${status}`, { url });

  let finalRemoteMain;
  let finalPagesBuild;
  try {
    finalRemoteMain = remoteMain(local.repository);
    finalPagesBuild = pagesBuild(local.repository);
  } catch {
    return failure('GitHub recheck failed after public URL verification');
  }
  if (typeof finalRemoteMain !== 'string' || !/^[0-9a-f]{40}$/i.test(finalRemoteMain)
    || !finalPagesBuild || typeof finalPagesBuild.commit !== 'string' || typeof finalPagesBuild.status !== 'string') {
    return failure('GitHub recheck failed after public URL verification');
  }
  if (finalRemoteMain !== actualRemoteMain || finalRemoteMain !== local.head
    || finalPagesBuild.commit !== latestPagesBuild.commit || finalPagesBuild.commit !== local.head
    || finalPagesBuild.status !== latestPagesBuild.status || finalPagesBuild.status !== 'built') {
    return failure('GitHub state changed during verification');
  }

  let finalLocal;
  try {
    finalLocal = snapshot(run);
  } catch {
    return failure('repository recheck failed after external verification');
  }
  if (!sameSnapshot(local, finalLocal)) return failure('repository state changed during verification');

  return {
    ok: true,
    reason: 'release verification passed',
    details: { branch: local.branch, head: local.head, pagesCommit: latestPagesBuild.commit, url },
  };
}

function main() {
  const result = verifyRelease();
  const prefix = result.ok ? 'PASS' : 'FAIL';
  console.log(`${prefix}: ${result.reason}`);
  for (const [key, value] of Object.entries(result.details)) console.log(`${key}: ${value}`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
