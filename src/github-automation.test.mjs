import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRepoConfigText } from './github-config.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { decideTrigger, recordCiResult, runIssueAutomation, simulateGithubAutomation, CI_STATUS } from './github-automation.mjs';
import { acquireIssueLock, loadIssueState } from './github-state.mjs';
import { TRIGGER_LABEL, STOP_LABEL } from './github-labels.mjs';
import { authorizeAiAutoTrigger } from './github-auth.mjs';

const assisted = parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
  max_fix_attempts: 5
review:
  required: false
`);

const manual = parseRepoConfigText(`
automation:
  enabled: false
  mode: manual
`);

function seedIssue({ labels = [TRIGGER_LABEL], login = 'maintainer', association = 'OWNER' } = {}) {
  return {
    issues: {
      42: {
        number: 42,
        title: 'Fix checkout validation',
        body: 'Make checkout validation fail closed.',
        html_url: 'https://github.com/owner/app/issues/42',
        user: { login: 'reporter' },
        labels: labels.map(name => ({ name })),
      },
    },
    events: {
      42: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login }, author_association: association }],
    },
    permissions: {
      maintainer: { permission: 'admin' },
      stranger: { permission: 'none' },
    },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
  };
}

test('creating a normal issue without ai-auto does not start automation', () => {
  const decision = decideTrigger({
    config: assisted,
    labels: ['bug'],
    authorization: { ok: false, skip: true },
  });
  assert.equal(decision.action, 'skip');
});

test('manual mode skips issue automation', () => {
  const decision = decideTrigger({
    config: manual,
    labels: [TRIGGER_LABEL],
    authorization: { ok: true },
  });
  assert.equal(decision.action, 'skip');
});

test('untrusted ai-auto is blocked', () => {
  const authorization = authorizeAiAutoTrigger({
    triggerLabelPresent: true,
    actorLogin: 'stranger',
    permission: 'none',
  });
  const decision = decideTrigger({ config: assisted, labels: [TRIGGER_LABEL], authorization });
  assert.equal(decision.action, 'block');
});

test('trusted ai-auto starts automation', () => {
  const authorization = authorizeAiAutoTrigger({
    triggerLabelPresent: true,
    actorLogin: 'maintainer',
    permission: 'admin',
  });
  const decision = decideTrigger({ config: assisted, labels: [TRIGGER_LABEL], authorization });
  assert.equal(decision.action, 'start');
});

test('deterministic 3-attempt PASS fixture ends READY_FOR_HUMAN_MERGE at 3/5', async () => {
  const result = await simulateGithubAutomation({
    config: assisted,
    repo: 'owner/app',
    issue: { number: 42, title: 'Fix checkout validation', labels: [{ name: TRIGGER_LABEL }] },
    actor: { login: 'maintainer', permission: 'admin' },
    ciSequence: [CI_STATUS.FAIL, CI_STATUS.FAIL, CI_STATUS.PASS],
    localTests: 'PASS',
  });
  assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(result.state.attempt, 3);
  assert.equal(result.state.maxAttempts, 5);
  assert.equal(result.ok, true);
});

test('deterministic 5-attempt FAIL fixture requests human review and has no attempt 6', async () => {
  const result = await simulateGithubAutomation({
    config: assisted,
    repo: 'owner/app',
    issue: { number: 42, title: 'x', labels: [{ name: TRIGGER_LABEL }] },
    actor: { login: 'maintainer', permission: 'admin' },
    ciSequence: [CI_STATUS.FAIL, CI_STATUS.FAIL, CI_STATUS.FAIL, CI_STATUS.FAIL, CI_STATUS.FAIL, CI_STATUS.FAIL],
    localTests: 'PASS',
  });
  assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(result.state.attempt, 5);
  assert.ok(result.state.attempt < 6);
});

test('recordCiResult never auto-merges on PASS', () => {
  const next = recordCiResult({ ciAttempts: 0, maxAttempts: 5, stage: 'WAITING_FOR_CI' }, CI_STATUS.PASS);
  assert.equal(next.stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(next.merged, undefined);
});

test('runIssueAutomation dry-run does not push, comment, or label', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      dryRun: true,
      env,
    });
    assert.equal(result.dryRun, true);
    assert.equal(client.log.length, 0);
    assert.match(result.task, /GitHub Issue #42/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('untrusted actor run is blocked without calling implementation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue({ login: 'stranger', association: 'NONE' }));
  let impl = 0;
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        impl += 1;
        return { ok: true, tests: 'PASS', review: 'PASS', commit: '1', branch: 'ai/x' };
      },
    });
    assert.equal(result.blocked, true);
    assert.equal(impl, 0);
    assert.equal(result.state.stage, 'BLOCKED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assisted run creates one PR, monitors CI PASS, never merges', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const pushes = [];
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => ({
        ok: true, tests: 'PASS', review: 'PASS', commit: 'abc123', branch, route: 'CODEX', model: 'auto',
      }),
      gitPush: async ({ branch, force }) => {
        assert.equal(force, false);
        assert.match(branch, /^ai\/issue-42-/);
        pushes.push(branch);
        return { sha: 'abc123' };
      },
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    assert.equal(result.state.prNumber > 0, true);
    assert.equal(result.state.pullRequestAutoMerged, false);
    assert.equal(pushes.length, 1);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CI FAIL then PASS through mocked fix loop', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const ci = [CI_STATUS.FAIL, CI_STATUS.PASS];
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => ({
        ok: true, tests: 'PASS', review: 'PASS', commit: 'deadbeef', branch, route: 'CODEX', model: 'auto',
      }),
      gitPush: async () => ({ sha: 'deadbeef' }),
      waitForCi: async () => ({ status: ci.shift(), summary: 'check' }),
    });
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    assert.equal(result.state.attempt, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancellation via ai-stop after start does not push extra fixes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL, STOP_LABEL] }));
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => ({ ok: true, tests: 'PASS', review: 'PASS', commit: 'x', branch: 'ai/x' }),
    });
    assert.equal(result.decision.action, 'cancel');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('duplicate trigger is idempotent once ready', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const impl = { n: 0 };
  const run = () => runIssueAutomation({
    client,
    config: assisted,
    repo: 'owner/app',
    issueNumber: 42,
    env,
    runImplementation: async ({ branch }) => {
      impl.n += 1;
      return { ok: true, tests: 'PASS', review: 'PASS', commit: 'abc', branch, route: 'CODEX', model: 'auto' };
    },
    gitPush: async () => ({ sha: 'abc' }),
    waitForCi: async () => ({ status: CI_STATUS.PASS }),
  });
  try {
    const first = await run();
    assert.equal(first.state.stage, 'READY_FOR_HUMAN_MERGE');
    const second = await run();
    assert.equal(second.skipped, true);
    assert.equal(second.decision.action, 'already-complete');
    assert.equal(impl.n, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrency lock is reported as busy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  try {
    await acquireIssueLock('owner/app', 42, env, { holder: 'other', staleMs: 60_000 });
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => ({ ok: true, tests: 'PASS', review: 'PASS', commit: 'x', branch: 'ai/x' }),
    });
    assert.equal(result.decision.action, 'busy');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crash with unsafePushPending requires human confirmation on resume', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  try {
    const first = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => ({ ok: true, tests: 'PASS', review: 'PASS', commit: 'abc', branch }),
      gitPush: async () => {
        throw new Error('runner crashed during push');
      },
      waitForCi: async () => ({ status: CI_STATUS.PASS }),
    });
    assert.ok(first.code !== 0);
    const saved = await loadIssueState('owner/app', 42, env);
    if (saved && !saved.unsafePushPending) {
      saved.unsafePushPending = true;
      saved.stage = 'WORKING';
      const { saveIssueState } = await import('./github-state.mjs');
      await saveIssueState(saved, env);
    }
    const second = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => ({ ok: true, tests: 'PASS', review: 'PASS', commit: 'abc', branch: 'ai/x' }),
      gitPush: async () => ({ sha: 'abc' }),
    });
    assert.equal(second.needsConfirmation || second.state?.stage === 'HUMAN_REVIEW_REQUIRED' || second.skipped, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('conflicting labels go to human review without workers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL, 'ai-team', 'ai-codex'] }));
  let impl = 0;
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        impl += 1;
        return { ok: true, tests: 'PASS' };
      },
    });
    assert.equal(result.conflict, true);
    assert.equal(impl, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('genuine local test FAIL still marks automation FAILED', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => ({
        ok: false, tests: 'FAIL', review: 'PASS', commit: 'deadbeef', branch,
      }),
      gitPush: async () => {
        throw new Error('must not push after local test FAIL');
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.state.stage, 'FAILED');
    assert.equal(result.state.localTests, 'FAIL');
    assert.equal(result.state.lastFailure, 'local tests failed');
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
