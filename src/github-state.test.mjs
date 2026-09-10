import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  emptyState,
  saveIssueState,
  loadIssueState,
  acquireIssueLock,
  releaseIssueLock,
  parseRepoSlug,
  isAllowedTransition,
  transitionStage,
  applyStage,
  IllegalStageTransitionError,
  TERMINAL_STAGES,
  COMPLETE_STAGES,
  AUTOMATION_STAGES,
  ALLOWED_TRANSITIONS,
  AUDIT_STAGES,
  AUDIT_STAGE_TRANSITIONS,
  transitionsFrom,
} from './github-state.mjs';

test('state persists without credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-state-'));
  const env = { LOCALAPPDATA: dir, AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  try {
    const state = emptyState({ repo: 'owner/app', issue: { number: 42, html_url: 'https://github.com/owner/app/issues/42', title: 'x' } });
    state.stage = 'WAITING_FOR_CI';
    state.token = undefined;
    await saveIssueState(state, env);
    const loaded = await loadIssueState('owner/app', 42, env);
    assert.equal(loaded.stage, 'WAITING_FOR_CI');
    assert.equal(loaded.issueNumber, 42);
    assert.equal('GITHUB_TOKEN' in loaded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrency lock prevents a second holder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-lock-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  try {
    const a = await acquireIssueLock('owner/app', 7, env, { holder: 'a', staleMs: 60_000 });
    assert.equal(a.ok, true);
    const b = await acquireIssueLock('owner/app', 7, env, { holder: 'b', staleMs: 60_000 });
    assert.equal(b.ok, false);
    await releaseIssueLock('owner/app', 7, env);
    const c = await acquireIssueLock('owner/app', 7, env, { holder: 'c', staleMs: 60_000 });
    assert.equal(c.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseRepoSlug', () => {
  assert.deepEqual(parseRepoSlug('trisha918/multi-model-ai-orchestrator'), {
    owner: 'trisha918',
    name: 'multi-model-ai-orchestrator',
    slug: 'trisha918/multi-model-ai-orchestrator',
  });
  assert.throws(() => parseRepoSlug('../etc/passwd'));
});

const legal = [
  ['IDLE', 'STARTED'],
  ['IDLE', 'WORKING'],
  ['IDLE', 'BLOCKED'],
  ['IDLE', 'WAITING_FOR_CI'],
  ['STARTED', 'WORKING'],
  ['WORKING', 'IMPLEMENTING'],
  ['IMPLEMENTING', 'LOCAL_TESTS'],
  ['IMPLEMENTING', 'FAILED'],
  ['IMPLEMENTING', 'WAITING_FOR_CI'],
  ['LOCAL_TESTS', 'WAITING_FOR_CI'],
  ['WAITING_FOR_CI', 'READY_FOR_HUMAN_MERGE'],
  ['WAITING_FOR_CI', 'FIXING'],
  ['WAITING_FOR_CI', 'HUMAN_REVIEW_REQUIRED'],
  ['WAITING_FOR_CI', 'FAILED'],
  ['FIXING', 'WAITING_FOR_CI'],
  ['FIXING', 'HUMAN_REVIEW_REQUIRED'],
  ['READY_FOR_HUMAN_MERGE', 'DONE'],
  ['READY_FOR_HUMAN_MERGE', 'HUMAN_REVIEW_REQUIRED'],
  ['HUMAN_REVIEW_REQUIRED', 'WAITING_FOR_CI'],
  ['HUMAN_REVIEW_REQUIRED', 'LOCAL_TESTS'],
];

const illegal = [
  ['READY_FOR_HUMAN_MERGE', 'IMPLEMENTING'],
  ['READY_FOR_HUMAN_MERGE', 'WAITING_FOR_CI'],
  ['READY_FOR_HUMAN_MERGE', 'STARTED'],
  ['DONE', 'STARTED'],
  ['DONE', 'WAITING_FOR_CI'],
  ['FAILED', 'FIXING'],
  ['FAILED', 'WAITING_FOR_CI'],
  ['FAILED', 'READY_FOR_HUMAN_MERGE'],
  ['BLOCKED', 'WORKING'],
  ['BLOCKED', 'STARTED'],
  ['CANCELLED', 'IMPLEMENTING'],
  ['CONFLICT', 'WORKING'],
  ['HUMAN_REVIEW_REQUIRED', 'IMPLEMENTING'],
  ['HUMAN_REVIEW_REQUIRED', 'READY_FOR_HUMAN_MERGE'],
  ['WAITING_FOR_CI', 'IMPLEMENTING'],
  ['IMPLEMENTING', 'STARTED'],
  ['IDLE', 'READY_FOR_HUMAN_MERGE'],
  ['LOCAL_TESTS', 'READY_FOR_HUMAN_MERGE'],
];

test('legal stage transitions are allowed', () => {
  for (const [from, to] of legal) {
    assert.equal(isAllowedTransition(from, to), true, `${from} → ${to}`);
    const moved = transitionStage({ stage: from }, to);
    assert.equal(moved.stage, to);
    assert.equal(moved.transitionApplied, true);
  }
});

test('illegal stage transitions are rejected', () => {
  for (const [from, to] of illegal) {
    assert.equal(isAllowedTransition(from, to), false, `${from} → ${to}`);
    assert.throws(
      () => transitionStage({ stage: from }, to),
      (e) => e instanceof IllegalStageTransitionError && e.from === from && e.to === to,
    );
    const noop = transitionStage({ stage: from, keep: 1 }, to, { onIllegal: 'noop' });
    assert.equal(noop.stage, from);
    assert.equal(noop.keep, 1);
    assert.equal(noop.transitionApplied, false);
  }
});

test('same-stage writes are a no-op', () => {
  for (const stage of ['WAITING_FOR_CI', 'READY_FOR_HUMAN_MERGE', 'FAILED']) {
    assert.equal(isAllowedTransition(stage, stage), true);
    const next = transitionStage({ stage, n: 1 }, stage);
    assert.equal(next.stage, stage);
    assert.equal(next.transitionApplied, false);
  }
});

test('terminal and human-gated stages do not auto-advance to work stages', () => {
  for (const stage of [...TERMINAL_STAGES, 'READY_FOR_HUMAN_MERGE']) {
    for (const dest of ['STARTED', 'WORKING', 'IMPLEMENTING', 'WAITING_FOR_CI']) {
      if (stage === dest) continue;
      if (isAllowedTransition(stage, dest)) {
        assert.fail(`${stage} should not advance to ${dest}`);
      }
    }
  }
  assert.deepEqual(COMPLETE_STAGES, ['READY_FOR_HUMAN_MERGE', 'DONE']);
});

test('applyStage mutates on legal moves and throws on illegal', () => {
  const state = emptyState({ repo: 'owner/app', issue: { number: 1 } });
  applyStage(state, 'STARTED');
  assert.equal(state.stage, 'STARTED');
  applyStage(state, 'STARTED');
  assert.equal(state.stage, 'STARTED');
  assert.throws(() => applyStage(state, 'DONE'), IllegalStageTransitionError);
});

test('saveIssueState is atomic and survives a crash-shaped rewrite', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-state-atomic-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  try {
    const first = emptyState({ repo: 'owner/app', issue: { number: 9, title: 't' } });
    first.stage = 'LOCAL_TESTS';
    first.commitSha = 'aaa';
    first.branch = 'ai/issue-9';
    await saveIssueState(first, env);
    const second = { ...first, stage: 'WAITING_FOR_CI', prNumber: 4 };
    await saveIssueState(second, env);
    const loaded = await loadIssueState('owner/app', 9, env);
    assert.equal(loaded.stage, 'WAITING_FOR_CI');
    assert.equal(loaded.prNumber, 4);
    assert.equal(loaded.commitSha, 'aaa');
    assert.equal('transitionApplied' in loaded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('audit stages document every allowed and impossible transition', () => {
  assert.deepEqual([...AUDIT_STAGES], [
    'STARTED',
    'LOCAL_TESTS',
    'WAITING_FOR_CI',
    'READY_FOR_HUMAN_MERGE',
    'HUMAN_REVIEW_REQUIRED',
    'FAILED',
    'BLOCKED',
    'DONE',
  ]);
  for (const from of AUDIT_STAGES) {
    assert.deepEqual(transitionsFrom(from), [...(ALLOWED_TRANSITIONS[from] || [])]);
    assert.equal(AUDIT_STAGE_TRANSITIONS[from], ALLOWED_TRANSITIONS[from]);
    for (const to of AUTOMATION_STAGES) {
      const expected = from === to || (ALLOWED_TRANSITIONS[from] || []).includes(to);
      assert.equal(isAllowedTransition(from, to), expected, `${from} → ${to}`);
    }
  }
  assert.deepEqual(transitionsFrom('FAILED'), []);
  assert.deepEqual(transitionsFrom('BLOCKED'), []);
  assert.deepEqual(transitionsFrom('DONE'), []);
  assert.deepEqual(transitionsFrom('READY_FOR_HUMAN_MERGE'), ['DONE', 'HUMAN_REVIEW_REQUIRED']);
  assert.deepEqual(transitionsFrom('HUMAN_REVIEW_REQUIRED'), ['WAITING_FOR_CI', 'LOCAL_TESTS']);
});
