import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRepoConfigText } from './github-config.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { decideTrigger, recordCiResult, runIssueAutomation, shouldSkipGitPush, CI_STATUS } from './github-automation.mjs';
import { acquireIssueLock, loadIssueState, saveIssueState, emptyState, isAllowedTransition } from './github-state.mjs';
import { TRIGGER_LABEL } from './github-labels.mjs';

const assisted = parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
  max_fix_attempts: 5
review:
  required: false
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

function seedIssueNumber(number, extra = {}) {
  return {
    issues: {
      [number]: {
        number,
        title: extra.title || 'Add divide operation and tests',
        body: extra.body || 'requirements',
        html_url: `https://github.com/owner/app/issues/${number}`,
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      [number]: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
    ...extra.seed,
  };
}

test('recordCiResult no-ops from terminal and human-gated stages', () => {
  for (const stage of ['FAILED', 'BLOCKED', 'DONE', 'READY_FOR_HUMAN_MERGE', 'HUMAN_REVIEW_REQUIRED', 'CANCELLED']) {
    const next = recordCiResult({ stage, ciAttempts: 2, maxAttempts: 5, keep: stage }, CI_STATUS.PASS);
    assert.equal(next.stage, stage, stage);
    assert.equal(next.ciAttempts, 2, stage);
    assert.equal(next.keep, stage);
  }
});

test('recordCiResult maps WAITING_FOR_CI to READY, FIXING, and HUMAN_REVIEW_REQUIRED', () => {
  assert.equal(recordCiResult({ stage: 'WAITING_FOR_CI', ciAttempts: 0, maxAttempts: 5 }, CI_STATUS.PASS).stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(recordCiResult({ stage: 'WAITING_FOR_CI', ciAttempts: 0, maxAttempts: 5 }, CI_STATUS.FAIL).stage, 'FIXING');
  assert.equal(recordCiResult({ stage: 'WAITING_FOR_CI', ciAttempts: 4, maxAttempts: 5 }, CI_STATUS.FAIL).stage, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(isAllowedTransition('WAITING_FOR_CI', 'FAILED'), true);
});

test('decideTrigger does not advance terminal or human-gated stages', () => {
  const authorization = { ok: true };
  assert.equal(decideTrigger({
    config: assisted, labels: [TRIGGER_LABEL], authorization,
    existingState: { stage: 'READY_FOR_HUMAN_MERGE' },
  }).action, 'already-complete');
  assert.equal(decideTrigger({
    config: assisted, labels: [TRIGGER_LABEL], authorization,
    existingState: { stage: 'DONE' },
  }).action, 'already-complete');
  for (const stage of ['FAILED', 'BLOCKED', 'CANCELLED', 'CONFLICT']) {
    assert.equal(decideTrigger({
      config: assisted, labels: [TRIGGER_LABEL], authorization,
      existingState: { stage },
    }).action, 'already-stopped', stage);
  }
  assert.equal(decideTrigger({
    config: assisted, labels: [TRIGGER_LABEL], authorization: { ok: false },
    existingState: { stage: 'READY_FOR_HUMAN_MERGE' },
  }).action, 'already-complete');
});

test('resume when PR already exists does not re-implement or open another PR', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-pr-exists-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-42-fix-checkout-validation';
  const client = createMemoryGithubClient({
    ...seedIssue(),
    pulls: [{ number: 88, head: { ref: branch, sha: commit }, body: 'Closes #42', issueNumber: 42 }],
  });
  let implCalls = 0;
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({ repo: 'owner/app', issue: { number: 42, title: 'Fix checkout validation', html_url: 'https://github.com/owner/app/issues/42' } }),
      stage: 'WORKING',
      localTests: 'PASS',
      commitSha: commit,
      branch,
      prNumber: null,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('must not re-implement when a PR already exists');
      },
      gitPush: async () => {
        pushCalls += 1;
        throw new Error('must not push when a PR already exists');
      },
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 0);
    assert.equal(result.state.prNumber, 88);
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('duplicate branch push is skipped when remote SHA already matches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-dup-push-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const implBranch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: { remoteBranches: { [implBranch]: implCommit } },
  }));
  let implCalls = 0;
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'LOCAL_TESTS',
      localTests: 'PASS',
      commitSha: implCommit,
      branch: implBranch,
      prNumber: null,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const skip = await shouldSkipGitPush({
      client, owner: 'owner', name: 'app',
      state: { branch: implBranch, commitSha: implCommit, prNumber: null },
    });
    assert.equal(skip.skip, true);
    assert.equal(skip.reason, 'remote-sha-matches');
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('must not re-implement');
      },
      gitPush: async () => {
        pushCalls += 1;
        throw new Error('must not duplicate branch push');
      },
      waitForCi: async () => ({ status: CI_STATUS.PENDING, summary: 'pending' }),
    });
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(result.state.branchPushed, true);
    assert.equal(Boolean(result.state.prNumber), true);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 1);
    assert.equal(result.state.stage, 'WAITING_FOR_CI');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crash after LOCAL_TESTS persist resumes without losing commit or re-implementing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-crash-mid-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = 'cccccccccccccccccccccccccccccccccccccccc';
  const implBranch = 'ai/issue-42-fix-checkout-validation';
  const client = createMemoryGithubClient(seedIssue());
  let implCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 42, title: 'Fix checkout validation', html_url: 'https://github.com/owner/app/issues/42' },
      }),
      stage: 'LOCAL_TESTS',
      localTests: 'PASS',
      commitSha: implCommit,
      branch: implBranch,
      prNumber: null,
      mode: 'assisted',
      route: 'CODEX',
    }, env);
    const loaded = await loadIssueState('owner/app', 42, env);
    assert.equal(loaded.stage, 'LOCAL_TESTS');
    assert.equal(loaded.commitSha, implCommit);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        return { ok: true, tests: 'PASS', commit: 'should-not-replace', branch: 'ai/wrong' };
      },
      gitPush: async ({ branch }) => {
        assert.equal(branch, implBranch);
        return { sha: implCommit };
      },
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(implCalls, 0);
    assert.equal(result.state.commitSha, implCommit);
    assert.equal(result.state.branch, implBranch);
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    const saved = await loadIssueState('owner/app', 42, env);
    assert.equal(saved.commitSha, implCommit);
    assert.equal(saved.stage, 'READY_FOR_HUMAN_MERGE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FAILED, BLOCKED, and READY_FOR_HUMAN_MERGE runs do not implement or push', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-settled-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  try {
    for (const stage of ['FAILED', 'BLOCKED', 'READY_FOR_HUMAN_MERGE']) {
      const client = createMemoryGithubClient(seedIssue());
      let impl = 0;
      await saveIssueState({
        ...emptyState({ repo: 'owner/app', issue: { number: 42, title: 'x', html_url: 'https://github.com/owner/app/issues/42' } }),
        stage,
        prNumber: stage === 'READY_FOR_HUMAN_MERGE' ? 3 : null,
        mode: 'assisted',
      }, env);
      const result = await runIssueAutomation({
        client,
        config: assisted,
        repo: 'owner/app',
        issueNumber: 42,
        env,
        runImplementation: async () => {
          impl += 1;
          throw new Error('settled stage must not implement');
        },
        gitPush: async () => {
          throw new Error('settled stage must not push');
        },
      });
      assert.equal(impl, 0, stage);
      assert.equal(result.skipped, true, stage);
      assert.equal(result.state.stage, stage);
      assert.ok(['already-complete', 'already-stopped'].includes(result.decision.action), stage);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shouldSkipGitPush uses branchPushed without a second remote push', async () => {
  const skip = await shouldSkipGitPush({
    state: { branchPushed: true, commitSha: 'abc', unsafePushPending: false, prNumber: null },
  });
  assert.equal(skip.skip, true);
  assert.equal(skip.reason, 'branch-already-pushed');
});

test('concurrency lock still excludes a second holder after exclusive create', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-lock-wx-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  try {
    const a = await acquireIssueLock('owner/app', 7, env, { holder: 'a', staleMs: 60_000 });
    assert.equal(a.ok, true);
    const b = await acquireIssueLock('owner/app', 7, env, { holder: 'b', staleMs: 60_000 });
    assert.equal(b.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
