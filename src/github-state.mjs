import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeDirs } from './paths.mjs';

export const AUTOMATION_STAGES = Object.freeze([
  'IDLE',
  'BLOCKED',
  'STARTED',
  'WORKING',
  'IMPLEMENTING',
  'LOCAL_TESTS',
  'WAITING_FOR_CI',
  'CI_FAILED',
  'FIXING',
  'READY_FOR_HUMAN_MERGE',
  'HUMAN_REVIEW_REQUIRED',
  'CANCELLED',
  'DONE',
  'FAILED',
  'CONFLICT',
]);

export function parseRepoSlug(repo) {
  const s = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m) throw new Error(`Repository must be owner/name, got: ${repo}`);
  return { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
}

export function githubStateDir(env = process.env) {
  return path.join(runtimeDirs(env).root, 'github-automation');
}

export function issueStatePath(repo, issueNumber, env = process.env) {
  const { owner, name } = parseRepoSlug(repo);
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n < 1) throw new Error('Issue number must be a positive integer.');
  return path.join(githubStateDir(env), owner, name, `issue-${n}.json`);
}

export function issueLockPath(repo, issueNumber, env = process.env) {
  return `${issueStatePath(repo, issueNumber, env)}.lock`;
}

export function emptyState({ repo, issue } = {}) {
  const now = new Date().toISOString();
  return {
    version: 1,
    repository: repo || '',
    issueNumber: issue?.number || 0,
    issueUrl: issue?.html_url || '',
    issueTitle: issue?.title || '',
    branch: '',
    prNumber: null,
    commitSha: '',
    attempt: 0,
    implementationAttempt: 0,
    ciAttempts: 0,
    aiFixRound: 0,
    maxAttempts: 5,
    stage: 'IDLE',
    lastCiRun: '',
    lastFailure: '',
    lastDiagnosis: '',
    selectedRoute: '',
    selectedModels: '',
    route: 'AUTO',
    model: 'AUTO',
    mode: 'manual',
    localTests: 'UNKNOWN',
    githubCi: 'UNKNOWN',
    review: 'UNKNOWN',
    statusCommentId: null,
    unsafePushPending: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadIssueState(repo, issueNumber, env = process.env) {
  const file = issueStatePath(repo, issueNumber, env);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed;
}

export async function saveIssueState(state, env = process.env) {
  const file = issueStatePath(state.repository, state.issueNumber, env);
  await mkdir(path.dirname(file), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return next;
}

export async function acquireIssueLock(repo, issueNumber, env = process.env, { holder = process.pid, staleMs = 2 * 60 * 60 * 1000 } = {}) {
  const file = issueLockPath(repo, issueNumber, env);
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      const existing = JSON.parse(await readFile(file, 'utf8'));
      const age = Date.now() - new Date(existing.at || 0).getTime();
      if (Number.isFinite(age) && age < staleMs) {
        return { ok: false, reason: 'concurrency lock held', lock: existing };
      }
    } catch {
      /* replace corrupt lock */
    }
  }
  const payload = { holder: String(holder), at: new Date().toISOString(), repo, issueNumber };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { ok: true, lock: payload, path: file };
}

export async function releaseIssueLock(repo, issueNumber, env = process.env) {
  const file = issueLockPath(repo, issueNumber, env);
  if (!existsSync(file)) return;
  const { unlink } = await import('node:fs/promises');
  await unlink(file);
}
