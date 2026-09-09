import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRepoConfigText } from './github-config.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { decideTrigger, recordCiResult, runIssueAutomation, simulateGithubAutomation, CI_STATUS } from './github-automation.mjs';
import { acquireIssueLock, loadIssueState, saveIssueState, emptyState } from './github-state.mjs';
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

test('HUMAN_REVIEW_REQUIRED with unsafePushPending is resumable', () => {
  const authorization = { ok: true };
  assert.equal(decideTrigger({
    config: assisted,
    labels: [TRIGGER_LABEL],
    authorization,
    existingState: { stage: 'HUMAN_REVIEW_REQUIRED', unsafePushPending: true },
  }).action, 'resume');
  assert.equal(decideTrigger({
    config: assisted,
    labels: [TRIGGER_LABEL],
    authorization,
    existingState: { stage: 'HUMAN_REVIEW_REQUIRED', unsafePushPending: false },
  }).action, 'already-stopped');
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
      gitPush: async () => {
        throw new Error('must not retry push without remote proof');
      },
    });
    assert.equal(second.needsConfirmation || second.state?.stage === 'HUMAN_REVIEW_REQUIRED' || second.skipped, true);
    assert.equal(second.state?.unsafePushPending, true);
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

test('successful runImplementation commit and branch are persisted and PR continues', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '79ebe894fde20fb9e77c15a0b1e1108ae739a7d8';
  const implBranch = 'ai/issue-5-test';
  const sourceHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const client = createMemoryGithubClient({
    issues: {
      5: {
        number: 5,
        title: 'test',
        body: 'requirements',
        html_url: 'https://github.com/owner/app/issues/5',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      5: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
  });
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 5,
      env,
      runImplementation: async () => ({
        ok: true,
        tests: 'PASS',
        commit: implCommit,
        branch: implBranch,
      }),
      gitPush: async ({ branch }) => {
        assert.equal(branch, implBranch);
        return { sha: sourceHead };
      },
      waitForCi: async ({ ref }) => {
        assert.equal(ref, implCommit);
        return { status: CI_STATUS.PASS, summary: 'ok' };
      },
    });
    assert.equal(result.state.commitSha, implCommit);
    assert.equal(result.state.branch, implBranch);
    assert.notEqual(result.state.stage, 'IMPLEMENTING');
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    assert.equal(result.state.localTests, 'PASS');
    assert.equal(Boolean(result.state.prNumber), true);
    const saved = await loadIssueState('owner/app', 5, env);
    assert.equal(saved.commitSha, implCommit);
    assert.equal(saved.branch, implBranch);
    assert.notEqual(saved.stage, 'IMPLEMENTING');
    assert.notEqual(saved.stage, 'LOCAL_TESTS');
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful implementation continues through push and PR creation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const order = [];
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => {
        order.push('implement');
        return {
          ok: true,
          tests: 'PASS',
          commit: '2d1d7a07bb537b06f07f1afa8aea2b580064a09f',
          branch,
        };
      },
      gitPush: async ({ branch }) => {
        order.push('push');
        assert.match(branch, /^ai\/issue-42-/);
        return { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
      },
      waitForCi: async () => {
        order.push('ci');
        return { status: CI_STATUS.PASS, summary: 'ok' };
      },
    });
    assert.deepEqual(order, ['implement', 'push', 'ci']);
    assert.equal(result.state.commitSha, '2d1d7a07bb537b06f07f1afa8aea2b580064a09f');
    assert.notEqual(result.state.stage, 'LOCAL_TESTS');
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    assert.equal(Boolean(result.state.prNumber), true);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resume from LOCAL_TESTS pushes and opens PR without re-implementing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const implBranch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient({
    issues: {
      6: {
        number: 6,
        title: 'Add divide operation and tests',
        body: 'requirements',
        html_url: 'https://github.com/owner/app/issues/6',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      6: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
  });
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
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async () => {
        implCalls += 1;
        return { ok: true, tests: 'PASS', commit: 'should-not-replace', branch: 'ai/wrong' };
      },
      gitPush: async ({ branch }) => {
        pushCalls += 1;
        assert.equal(branch, implBranch);
        return { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      },
      waitForCi: async ({ ref }) => {
        assert.equal(ref, implCommit);
        return { status: CI_STATUS.PASS, summary: 'ok' };
      },
    });
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 1);
    assert.equal(result.state.commitSha, implCommit);
    assert.equal(result.state.branch, implBranch);
    assert.notEqual(result.state.stage, 'LOCAL_TESTS');
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    assert.equal(Boolean(result.state.prNumber), true);
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.prNumber, result.state.prNumber);
    assert.equal(saved.stage, 'READY_FOR_HUMAN_MERGE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test('unsafePushPending with matching remote SHA continues without pushing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const implBranch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: { remoteBranches: { [implBranch]: implCommit } },
  }));
  let pushCalls = 0;
  let implCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'HUMAN_REVIEW_REQUIRED',
      unsafePushPending: true,
      localTests: 'PASS',
      commitSha: implCommit,
      branch: implBranch,
      prNumber: null,
      mode: 'assisted',
      maxAttempts: 5,
      lastFailure: 'src refspec ai/issue-6-add-divide-operation-and-tests does not match any',
      lastDiagnosis: 'Crash recovery: a push may have been interrupted. Human confirmation required before pushing again.',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async () => {
        implCalls += 1;
        return { ok: true, tests: 'PASS', commit: implCommit, branch: implBranch };
      },
      gitPush: async ({ force }) => {
        pushCalls += 1;
        assert.equal(force, false);
        throw new Error('must not push after remote SHA match');
      },
      waitForCi: async () => ({ status: CI_STATUS.PENDING, summary: 'checks not yet reported' }),
    });
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(result.state.unsafePushPending, false);
    assert.equal(result.state.lastFailure, '');
    assert.equal(result.state.lastDiagnosis, '');
    assert.notEqual(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(result.state.stage, 'WAITING_FOR_CI');
    assert.equal(Boolean(result.state.prNumber), true);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 1);
    assert.equal(client.log.filter(x => x.op === 'getBranch').length > 0, true);
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.unsafePushPending, false);
    assert.equal(saved.lastFailure, '');
    assert.equal(saved.lastDiagnosis, '');
    assert.equal(saved.stage, 'WAITING_FOR_CI');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unsafePushPending with missing remote branch stays HUMAN_REVIEW_REQUIRED', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const implBranch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6));
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'HUMAN_REVIEW_REQUIRED',
      unsafePushPending: true,
      localTests: 'PASS',
      commitSha: implCommit,
      branch: implBranch,
      prNumber: null,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      gitPush: async () => {
        pushCalls += 1;
        throw new Error('must not retry push');
      },
    });
    assert.equal(pushCalls, 0);
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(result.state.unsafePushPending, true);
    assert.equal(result.state.prNumber, null);
    assert.match(result.state.lastDiagnosis, /not found/i);
    assert.doesNotMatch(result.state.lastDiagnosis || '', /force-push/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unsafePushPending with remote SHA mismatch stays HUMAN_REVIEW_REQUIRED', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const implBranch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: { remoteBranches: { [implBranch]: other } },
  }));
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'HUMAN_REVIEW_REQUIRED',
      unsafePushPending: true,
      localTests: 'PASS',
      commitSha: implCommit,
      branch: implBranch,
      prNumber: null,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      gitPush: async ({ force }) => {
        pushCalls += 1;
        assert.equal(force, false);
        throw new Error('must not force-push on mismatch');
      },
    });
    assert.equal(pushCalls, 0);
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(result.state.unsafePushPending, true);
    assert.match(result.state.lastDiagnosis, /expected/);
    assert.match(result.state.lastDiagnosis, /force-push/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unsafePushPending matching remote reuses existing PR and does not duplicate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const implBranch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: {
      remoteBranches: { [implBranch]: implCommit },
      pulls: [{ number: 77, head: { ref: implBranch, sha: implCommit }, body: 'Closes #6', issueNumber: 6 }],
    },
  }));
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'HUMAN_REVIEW_REQUIRED',
      unsafePushPending: true,
      localTests: 'PASS',
      commitSha: implCommit,
      branch: implBranch,
      prNumber: null,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      gitPush: async ({ force }) => {
        pushCalls += 1;
        assert.equal(force, false);
        throw new Error('must not push when PR already exists');
      },
      waitForCi: async () => ({ status: CI_STATUS.PENDING, summary: 'pending' }),
    });
    assert.equal(pushCalls, 0);
    assert.equal(result.state.prNumber, 77);
    assert.equal(result.state.unsafePushPending, false);
    assert.equal(result.state.stage, 'WAITING_FOR_CI');
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assisted run never requests a force push', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const forces = [];
  try {
    await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => ({ ok: true, tests: 'PASS', commit: 'abc', branch }),
      gitPush: async ({ force }) => {
        forces.push(force);
        return { sha: 'abc' };
      },
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(forces.length > 0, true);
    assert.equal(forces.every(f => f === false), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WAITING_FOR_CI with successful checks becomes READY_FOR_HUMAN_MERGE', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: {
      checks: {
        [commit]: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      },
      pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
    },
  }));
  let implCalls = 0;
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'WAITING_FOR_CI',
      prNumber: 7,
      githubCi: 'UNKNOWN',
      localTests: 'PASS',
      commitSha: commit,
      branch,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('must not re-implement while waiting for CI');
      },
      gitPush: async () => {
        pushCalls += 1;
        throw new Error('must not push while waiting for CI');
      },
      waitForCi: async () => {
        throw new Error('resume CI sync should use GitHub checks, not the live waiter');
      },
    });
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 0);
    assert.equal(result.state.githubCi, 'PASS');
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    assert.equal(result.state.prNumber, 7);
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.stage, 'READY_FOR_HUMAN_MERGE');
    assert.equal(saved.githubCi, 'PASS');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WAITING_FOR_CI with failed checks becomes FAILED', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: {
      checks: {
        [commit]: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      },
      pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
    },
  }));
  let implCalls = 0;
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'WAITING_FOR_CI',
      prNumber: 7,
      githubCi: 'UNKNOWN',
      localTests: 'PASS',
      commitSha: commit,
      branch,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('must not re-implement on CI fail sync');
      },
      gitPush: async () => {
        pushCalls += 1;
        throw new Error('must not push on CI fail sync');
      },
    });
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 0);
    assert.equal(result.state.githubCi, 'FAIL');
    assert.equal(result.state.stage, 'FAILED');
    assert.equal(result.code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WAITING_FOR_CI with pending checks stays WAITING_FOR_CI', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: {
      checks: {
        [commit]: [{ name: 'test', status: 'in_progress', conclusion: null }],
      },
      pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
    },
  }));
  let implCalls = 0;
  let pushCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'WAITING_FOR_CI',
      prNumber: 7,
      githubCi: 'UNKNOWN',
      localTests: 'PASS',
      commitSha: commit,
      branch,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('must not re-implement while CI pending');
      },
      gitPush: async () => {
        pushCalls += 1;
        throw new Error('must not push while CI pending');
      },
    });
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 0);
    assert.equal(result.state.stage, 'WAITING_FOR_CI');
    assert.equal(result.state.githubCi, 'UNKNOWN');
    assert.equal(result.state.prNumber, 7);
    assert.equal(result.waiting, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
