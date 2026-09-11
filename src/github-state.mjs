import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { acquireFileLock, releaseFileLock, appendEvent } from './local-store.mjs';
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

/*
 * STATE TRANSITION TABLE (canonical — keep in sync with applyStage / runIssueAutomation)
 *
 * from → to | trigger
 * ----------|--------
 * IDLE → STARTED | trusted ai-auto start
 * IDLE → WORKING | simulate / start that skips the STARTED comment hop
 * IDLE → BLOCKED | untrusted trigger actor
 * IDLE → CONFLICT | contradictory route/model labels
 * IDLE → CANCELLED | ai-stop before work begins
 * STARTED → WORKING | status labels + implementation begins
 * STARTED → IMPLEMENTING | worker starts without a separate WORKING persist
 * STARTED → LOCAL_TESTS | resume after implementation already finished
 * STARTED → WAITING_FOR_CI | resume when a PR already exists
 * STARTED → FAILED | local tests fail immediately
 * STARTED → CANCELLED | ai-stop
 * WORKING → STARTED | resume reset when implementation must restart
 * WORKING → IMPLEMENTING | first implementation round
 * WORKING → LOCAL_TESTS | implementation already produced a passing commit
 * WORKING → WAITING_FOR_CI | PR already exists; skip implement/push
 * WORKING → FAILED | local tests FAIL
 * WORKING → CANCELLED | ai-stop
 * WORKING → HUMAN_REVIEW_REQUIRED | crash / unrecoverable before CI
 * IMPLEMENTING → LOCAL_TESTS | implementation + local tests PASS/SKIP
 * IMPLEMENTING → FAILED | local tests FAIL (first round)
 * IMPLEMENTING → CANCELLED | ai-stop
 * IMPLEMENTING → WAITING_FOR_CI | PR already exists after a crash mid-implement
 * IMPLEMENTING → HUMAN_REVIEW_REQUIRED | crash / unrecoverable
 * LOCAL_TESTS → WAITING_FOR_CI | branch pushed (or already on remote) and PR opened/reused
 * LOCAL_TESTS → HUMAN_REVIEW_REQUIRED | push crash cannot be reconciled
 * LOCAL_TESTS → FAILED | local tests later marked FAIL
 * LOCAL_TESTS → CANCELLED | ai-stop
 * LOCAL_TESTS → STARTED | resume reset only when there is no PR and no passing commit
 * LOCAL_TESTS → WORKING | resume restart path
 * WAITING_FOR_CI → READY_FOR_HUMAN_MERGE | GitHub CI PASS (and required local/review ok)
 * WAITING_FOR_CI → FIXING | CI FAIL/TIMEOUT and attempts < max_fix_attempts
 * WAITING_FOR_CI → CI_FAILED | CI FAIL recorded before the fix hop
 * WAITING_FOR_CI → HUMAN_REVIEW_REQUIRED | 5th CI FAIL/TIMEOUT, or CI PASS but required review/tests did not
 * WAITING_FOR_CI → FAILED | resume CI sync sees FAIL (no live waiter / no extra fix start)
 * WAITING_FOR_CI → CANCELLED | ai-stop
 * CI_FAILED → FIXING | bounded AI fix round
 * CI_FAILED → HUMAN_REVIEW_REQUIRED | at attempt limit
 * CI_FAILED → WAITING_FOR_CI | re-poll
 * CI_FAILED → FAILED | unrecoverable
 * FIXING → IMPLEMENTING | fix worker (same worktree/branch)
 * FIXING → LOCAL_TESTS | fix local tests PASS
 * FIXING → WAITING_FOR_CI | fix pushed (never force-push)
 * FIXING → HUMAN_REVIEW_REQUIRED | local tests FAIL during fix, or attempts exhausted
 * FIXING → CANCELLED | ai-stop
 * FIXING → FAILED | unrecoverable
 * READY_FOR_HUMAN_MERGE → DONE | human merged / closed the issue (never auto-merge)
 * READY_FOR_HUMAN_MERGE → HUMAN_REVIEW_REQUIRED | same run: CI PASS but required local tests or review did not
 * HUMAN_REVIEW_REQUIRED → WAITING_FOR_CI | crash-recovery reconcile (unsafePushPending + matching remote SHA)
 * HUMAN_REVIEW_REQUIRED → LOCAL_TESTS | reconciled push, PR not yet opened
 *
 * Terminal (no outbound except same-stage no-op): FAILED, BLOCKED, DONE, CANCELLED, CONFLICT
 * Human-gated (do not auto-advance on resume): READY_FOR_HUMAN_MERGE, HUMAN_REVIEW_REQUIRED
 *   (HUMAN_REVIEW_REQUIRED may resume only when unsafePushPending is set)
 *
 * Same-stage writes are always a no-op. Illegal moves throw IllegalStageTransitionError
 * (or no-op when transitionStage({ onIllegal: 'noop' })).
 *
 * v1.1 never transitions to a merge/publish stage. There is no AUTO_MERGED / PUBLISHED stage.
 */

const STOP_ANYTIME = Object.freeze(['BLOCKED', 'CANCELLED', 'CONFLICT', 'FAILED', 'HUMAN_REVIEW_REQUIRED']);

export const ALLOWED_TRANSITIONS = Object.freeze({
  IDLE: Object.freeze(['STARTED', 'WORKING', 'WAITING_FOR_CI', 'BLOCKED', 'CONFLICT', 'CANCELLED', 'FAILED']),
  STARTED: Object.freeze(['WORKING', 'IMPLEMENTING', 'LOCAL_TESTS', 'WAITING_FOR_CI', ...STOP_ANYTIME]),
  WORKING: Object.freeze(['STARTED', 'IMPLEMENTING', 'LOCAL_TESTS', 'WAITING_FOR_CI', ...STOP_ANYTIME]),
  IMPLEMENTING: Object.freeze(['LOCAL_TESTS', 'WAITING_FOR_CI', 'FIXING', ...STOP_ANYTIME]),
  LOCAL_TESTS: Object.freeze(['WAITING_FOR_CI', 'STARTED', 'WORKING', 'IMPLEMENTING', 'FIXING', ...STOP_ANYTIME]),
  WAITING_FOR_CI: Object.freeze(['READY_FOR_HUMAN_MERGE', 'FIXING', 'CI_FAILED', 'FAILED', 'HUMAN_REVIEW_REQUIRED', 'CANCELLED', 'BLOCKED', 'CONFLICT']),
  CI_FAILED: Object.freeze(['FIXING', 'HUMAN_REVIEW_REQUIRED', 'WAITING_FOR_CI', 'FAILED', 'CANCELLED', 'BLOCKED']),
  FIXING: Object.freeze(['IMPLEMENTING', 'LOCAL_TESTS', 'WAITING_FOR_CI', 'WORKING', ...STOP_ANYTIME]),
  READY_FOR_HUMAN_MERGE: Object.freeze(['DONE', 'HUMAN_REVIEW_REQUIRED']),
  HUMAN_REVIEW_REQUIRED: Object.freeze(['WAITING_FOR_CI', 'LOCAL_TESTS']),
  BLOCKED: Object.freeze([]),
  FAILED: Object.freeze([]),
  DONE: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  CONFLICT: Object.freeze([]),
});

export const TERMINAL_STAGES = Object.freeze(['FAILED', 'BLOCKED', 'DONE', 'CANCELLED', 'CONFLICT']);
export const HUMAN_GATED_STAGES = Object.freeze(['READY_FOR_HUMAN_MERGE', 'HUMAN_REVIEW_REQUIRED']);
export const COMPLETE_STAGES = Object.freeze(['READY_FOR_HUMAN_MERGE', 'DONE']);
export const STOPPED_STAGES = Object.freeze(['HUMAN_REVIEW_REQUIRED', 'CANCELLED', 'FAILED', 'BLOCKED', 'CONFLICT']);

/** Stages called out by the v1.1 state-machine audit. */
export const AUDIT_STAGES = Object.freeze([
  'STARTED',
  'LOCAL_TESTS',
  'WAITING_FOR_CI',
  'READY_FOR_HUMAN_MERGE',
  'HUMAN_REVIEW_REQUIRED',
  'FAILED',
  'BLOCKED',
  'DONE',
]);

/** Canonical outbound edges for AUDIT_STAGES (same arrays as ALLOWED_TRANSITIONS). */
export const AUDIT_STAGE_TRANSITIONS = Object.freeze(
  Object.fromEntries(AUDIT_STAGES.map(stage => [stage, ALLOWED_TRANSITIONS[stage]])),
);

export function transitionsFrom(stage) {
  return [...(ALLOWED_TRANSITIONS[stage] || [])];
}

export class IllegalStageTransitionError extends Error {
  constructor(from, to) {
    super(`Illegal GitHub automation transition: ${from} → ${to}`);
    this.name = 'IllegalStageTransitionError';
    this.from = from;
    this.to = to;
    this.code = 'ILLEGAL_STAGE_TRANSITION';
  }
}

export function isKnownStage(stage) {
  return AUTOMATION_STAGES.includes(stage);
}

export function isTerminalStage(stage) {
  return TERMINAL_STAGES.includes(stage);
}

export function isHumanGatedStage(stage) {
  return HUMAN_GATED_STAGES.includes(stage);
}

export function isSettledStage(stage) {
  return isTerminalStage(stage) || isHumanGatedStage(stage);
}

export function isAllowedTransition(from, to) {
  const src = from || 'IDLE';
  const dest = to || '';
  if (src === dest) return true;
  if (!isKnownStage(src) || !isKnownStage(dest)) return false;
  return (ALLOWED_TRANSITIONS[src] || []).includes(dest);
}

export function transitionStage(state, nextStage, { onIllegal = 'throw' } = {}) {
  const from = state?.stage || 'IDLE';
  const to = nextStage;
  if (from === to) {
    return { ...state, stage: to, transitionApplied: false };
  }
  if (!isAllowedTransition(from, to)) {
    if (onIllegal === 'noop') {
      return { ...state, transitionApplied: false };
    }
    throw new IllegalStageTransitionError(from, to);
  }
  return { ...state, stage: to, transitionApplied: true };
}

export function applyStage(state, nextStage, options) {
  const next = transitionStage(state, nextStage, options);
  if (next.transitionApplied === false && state.stage !== nextStage) {
    return state;
  }
  state.stage = next.stage;
  return state;
}

export function parseRepoSlug(repo) {
  const s = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m || m.slice(1).some(part => part === '.' || part === '..')) throw new Error(`Repository must be owner/name, got: ${repo}`);
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
    branchPushed: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadIssueState(repo, issueNumber, env = process.env) {
  const file = issueStatePath(repo, issueNumber, env);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1 || parsed.repository !== parseRepoSlug(repo).slug || parsed.issueNumber !== Number(issueNumber) || !AUTOMATION_STAGES.includes(parsed.stage)) {
    throw new Error(`Invalid or mismatched Issue state: ${file}. Preserve this file and inspect it before resuming.`);
  }
  return parsed;
}

export async function saveIssueState(state, env = process.env) {
  const file = issueStatePath(state.repository, state.issueNumber, env);
  await mkdir(path.dirname(file), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  delete next.transitionApplied;
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  await appendEvent(`${file}.events.jsonl`, 'state.saved', { stage: next.stage, commitSha: next.commitSha, attempt: next.attempt });
  return next;
}

const leases = new Map();
export async function acquireIssueLock(repo, issueNumber, env = process.env, { holder = process.pid } = {}) {
  const file = issueLockPath(repo, issueNumber, env);
  const lease = await acquireFileLock(file, { holder: String(holder), repo, issueNumber });
  if (lease.ok) leases.set(file, lease);
  return lease;
}

export async function releaseIssueLock(repo, issueNumber, env = process.env) {
  const file = issueLockPath(repo, issueNumber, env);
  const lease = leases.get(file);
  if (!lease) return;
  await releaseFileLock(lease);
  leases.delete(file);
}
