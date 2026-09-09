import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyState, saveIssueState, loadIssueState, acquireIssueLock, releaseIssueLock, parseRepoSlug } from './github-state.mjs';

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
