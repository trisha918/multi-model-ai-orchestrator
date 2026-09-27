import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRepoConfigText } from './github-config.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import {
  decideTrigger,
  recordCiResult,
  readGithubCiStatus,
  runIssueAutomation,
  simulateGithubAutomation,
  CI_STATUS,
  applyLabels,
  assertRequiredReviewRoute,
  diagnoseImplementationGateFailure,
  isEstablishedExecutionRoute,
  REQUIRED_REVIEW_NEEDS_TEAM,
} from './github-automation.mjs';
import { acquireIssueLock, loadIssueState, saveIssueState, emptyState } from './github-state.mjs';
import { TRIGGER_LABEL, STOP_LABEL, STATUS_LABELS, RoutingConflictError } from './github-labels.mjs';
import { authorizeAiAutoTrigger } from './github-auth.mjs';
import { createGithubEventLog } from './github-events.mjs';
import { formatGithubStatus } from './github-pr.mjs';

const assisted = parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
  max_fix_attempts: 5
review:
  required: false
`);

const reviewRequired = parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
  max_fix_attempts: 5
tests:
  required: true
review:
  required: true
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

test('disabled cwd config still resumes WAITING_FOR_CI', () => {
  const decision = decideTrigger({
    config: manual,
    labels: [TRIGGER_LABEL],
    authorization: { ok: true },
    existingState: {
      stage: 'WAITING_FOR_CI',
      prNumber: 7,
      commitSha: '2d1d7a07bb537b06f07f1afa8aea2b580064a09f',
      githubCi: 'UNKNOWN',
    },
  });
  assert.equal(decision.action, 'resume');
  assert.equal(decision.reason, 'WAITING_FOR_CI');
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
      review: 'PASS',
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
      review: 'PASS',
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
      review: 'PASS',
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
      review: 'PASS',
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
      review: 'PASS',
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
      review: 'PASS',
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

test('WAITING_FOR_CI with failed checks resumes bounded fixing', async () => {
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
      review: 'PASS',
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
        return { ok: true, tests: 'PASS', review: 'PASS', commit, branch };
      },
      gitPush: async () => {
        pushCalls += 1;
        return { sha: commit };
      },
    });
    assert.equal(implCalls, 4);
    assert.equal(pushCalls, 4);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 0);
    assert.equal(result.state.githubCi, 'FAIL');
    assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
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
      review: 'PASS',
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
    assert.equal(result.state.githubCi, 'PENDING');
    assert.equal(result.state.prNumber, 7);
    assert.equal(result.waiting, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const nodeTestsSuccess = { name: 'Node tests', status: 'completed', conclusion: 'success' };

test('readGithubCiStatus maps completed Node tests check to PASS', async () => {
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const envelopeClient = {
    async getPullRequest() {
      return { head: { sha: commit } };
    },
    async getChecks() {
      return { total_count: 1, check_runs: [nodeTestsSuccess] };
    },
  };
  const envelope = await readGithubCiStatus({
    client: envelopeClient,
    owner: 'trisha918',
    name: 'ai-orchestrator-e2e-test',
    state: { prNumber: 7, commitSha: commit },
  });
  assert.equal(envelope.githubCi, 'PASS');
  assert.equal(envelope.stage, 'READY_FOR_HUMAN_MERGE');

  const singleRunClient = {
    async getChecks() {
      return nodeTestsSuccess;
    },
  };
  const single = await readGithubCiStatus({
    client: singleRunClient,
    owner: 'trisha918',
    name: 'ai-orchestrator-e2e-test',
    state: { commitSha: commit },
  });
  assert.equal(single.githubCi, 'PASS');
  assert.equal(single.stage, 'READY_FOR_HUMAN_MERGE');
});

test('readGithubCiStatus uses Actions workflow runs when check-runs are empty', async () => {
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const sync = await readGithubCiStatus({
    client: {
      async getChecks() {
        return { total_count: 0, check_runs: [] };
      },
      async listWorkflowRuns() {
        return {
          total_count: 1,
          workflow_runs: [{ name: 'Node tests', status: 'completed', conclusion: 'success', head_sha: commit }],
        };
      },
    },
    owner: 'trisha918',
    name: 'ai-orchestrator-e2e-test',
    state: { commitSha: commit, prNumber: 7 },
  });
  assert.equal(sync.githubCi, 'PASS');
  assert.equal(sync.stage, 'READY_FOR_HUMAN_MERGE');
});

test('WAITING_FOR_CI resume with Node tests Check API envelope becomes READY_FOR_HUMAN_MERGE', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: {
      pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
    },
  }));
  client.getChecks = async () => ({
    total_count: 1,
    check_runs: [nodeTestsSuccess],
  });
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
      review: 'PASS',
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
    assert.equal(result.state.githubCi, 'PASS');
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.githubCi, 'PASS');
    assert.equal(saved.stage, 'READY_FOR_HUMAN_MERGE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertRequiredReviewRoute rejects AUTO and solo; allows TEAM', () => {
  assert.throws(
    () => assertRequiredReviewRoute(reviewRequired, { worker: 'AUTO' }),
    (e) => e instanceof RoutingConflictError && e.message === REQUIRED_REVIEW_NEEDS_TEAM,
  );
  assert.throws(
    () => assertRequiredReviewRoute(reviewRequired, { worker: 'CODEX' }),
    (e) => e instanceof RoutingConflictError && /TEAM route/.test(e.message),
  );
  assert.doesNotThrow(() => assertRequiredReviewRoute(reviewRequired, { worker: 'TEAM' }));
  assert.doesNotThrow(() => assertRequiredReviewRoute(assisted, { worker: 'AUTO' }));
});

test('diagnoseImplementationGateFailure never blames local tests when they PASS', () => {
  assert.equal(
    diagnoseImplementationGateFailure(
      { ok: true, tests: 'PASS', review: 'SKIP' },
      reviewRequired,
    ),
    'required AI review did not pass',
  );
  assert.equal(
    diagnoseImplementationGateFailure(
      { ok: false, tests: 'PASS', review: 'PASS' },
      reviewRequired,
    ),
    'implementation failed',
  );
  assert.equal(
    diagnoseImplementationGateFailure(
      { ok: false, tests: 'FAIL', review: 'PASS' },
      reviewRequired,
    ),
    'local tests failed',
  );
});

test('review.required=true + AUTO route conflicts before runImplementation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL] }));
  let implCalls = 0;
  try {
    const result = await runIssueAutomation({
      client,
      config: reviewRequired,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        return { ok: true, tests: 'PASS', review: 'PASS', commit: 'x', branch: 'ai/x' };
      },
    });
    assert.equal(result.conflict, true);
    assert.equal(result.code, 2);
    assert.equal(implCalls, 0);
    assert.equal(result.state.stage, 'CONFLICT');
    assert.match(result.state.lastFailure, /review\.required=true requires the TEAM route/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('review.required=true + explicit CODEX route conflicts before runImplementation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL, 'ai-codex'] }));
  let implCalls = 0;
  try {
    const result = await runIssueAutomation({
      client,
      config: reviewRequired,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        return { ok: true, tests: 'PASS', review: 'PASS', commit: 'x', branch: 'ai/x' };
      },
    });
    assert.equal(result.conflict, true);
    assert.equal(implCalls, 0);
    assert.equal(result.state.stage, 'CONFLICT');
    assert.match(String(result.state.lastFailure), /solo runs do not produce/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('review.required=true + TEAM is allowed to proceed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL, 'ai-team'] }));
  let implCalls = 0;
  try {
    const result = await runIssueAutomation({
      client,
      config: reviewRequired,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => {
        implCalls += 1;
        return {
          ok: true,
          tests: 'PASS',
          review: 'PASS',
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          branch,
          route: 'TEAM',
        };
      },
      gitPush: async () => ({ ok: true, sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(result.conflict, undefined);
    assert.equal(implCalls, 1);
    assert.equal(result.state.localTests, 'PASS');
    assert.equal(result.state.review, 'PASS');
    assert.ok(['WAITING_FOR_CI', 'READY_FOR_HUMAN_MERGE', 'LOCAL_TESTS'].includes(result.state.stage)
      || result.state.prNumber);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('review.required=false + ai-auto only keeps smart routing valid', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL] }));
  let implCalls = 0;
  let seenWorker = '';
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch, routing }) => {
        implCalls += 1;
        seenWorker = routing?.worker || '';
        return {
          ok: true,
          tests: 'PASS',
          review: 'SKIP',
          commit: 'cccccccccccccccccccccccccccccccccccccccc',
          branch,
          route: routing?.worker || 'AUTO',
        };
      },
      gitPush: async () => ({ ok: true, sha: 'cccccccccccccccccccccccccccccccccccccccc' }),
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(result.conflict, undefined);
    assert.equal(implCalls, 1);
    assert.equal(seenWorker, 'AUTO');
    assert.equal(result.state.localTests, 'PASS');
    assert.equal(result.state.review, 'SKIP');
    assert.notEqual(result.state.lastFailure, 'local tests failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('localTests PASS + review SKIP never records local tests failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  // TEAM satisfies the fail-fast route gate; SKIP review still fails the review gate.
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL, 'ai-team'] }));
  let implCalls = 0;
  try {
    const result = await runIssueAutomation({
      client,
      config: reviewRequired,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch }) => {
        implCalls += 1;
        return {
          ok: true,
          tests: 'PASS',
          review: 'SKIP',
          commit: 'dddddddddddddddddddddddddddddddddddddddd',
          branch,
        };
      },
      gitPush: async () => {
        throw new Error('must not push when required review did not pass');
      },
    });
    assert.equal(implCalls, 1);
    assert.equal(result.code, 1);
    assert.equal(result.state.stage, 'FAILED');
    assert.equal(result.state.localTests, 'PASS');
    assert.equal(result.state.review, 'SKIP');
    assert.equal(result.state.lastFailure, 'required AI review did not pass');
    assert.notEqual(result.state.lastFailure, 'local tests failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WAITING_FOR_CI resume with disabled cwd config still becomes READY_FOR_HUMAN_MERGE', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: {
      pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
    },
  }));
  client.getChecks = async () => ({
    total_count: 1,
    check_runs: [{ name: 'Node tests', status: 'completed', conclusion: 'success' }],
  });
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
      review: 'PASS',
      commitSha: commit,
      branch,
      mode: 'assisted',
    }, env);
    const result = await runIssueAutomation({
      client,
      config: manual,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async () => {
        throw new Error('must not re-implement while waiting for CI');
      },
      gitPush: async () => {
        throw new Error('must not push while waiting for CI');
      },
      waitForCi: async () => {
        throw new Error('resume CI sync should use GitHub checks, not the live waiter');
      },
    });
    assert.equal(result.skipped, undefined);
    assert.equal(result.state.githubCi, 'PASS');
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.githubCi, 'PASS');
    assert.equal(saved.stage, 'READY_FOR_HUMAN_MERGE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status-label reconciliation uses fresh copies from GitHub and stays idempotent', async () => {
  const server = { labels: new Set([TRIGGER_LABEL, 'bug', 'customer-visible']) };
  const actions = [];
  let reads = 0;
  const client = {
    // Deliberately model the GitHub API: every read is a new object and old
    // snapshots remain stale after mutations.
    async getIssue() {
      return {
        number: 42,
        labels: [...server.labels].map(name => ({ name })),
      };
    },
    async getLabels() {
      reads += 1;
      const issue = await this.getIssue();
      return issue.labels;
    },
    async addLabel(_owner, _name, _number, label) {
      actions.push({ op: 'add', label });
      server.labels.add(label);
    },
    async removeLabel(_owner, _name, _number, label) {
      actions.push({ op: 'remove', label });
      server.labels.delete(label);
    },
  };
  const staleIssue = await client.getIssue();
  const assertStage = (expected) => {
    const statuses = [...server.labels].filter(label => STATUS_LABELS.includes(label));
    assert.deepEqual(statuses, [expected]);
    assert.ok(server.labels.has(TRIGGER_LABEL));
    assert.ok(server.labels.has('bug'));
    assert.ok(server.labels.has('customer-visible'));
  };
  const apply = (stage) => applyLabels(client, {
    owner: 'owner',
    name: 'app',
    issueNumber: 42,
    // This is deliberately the first stale snapshot for every transition.
    issue: staleIssue,
    stage,
    dryRun: false,
    plan: { steps: [] },
  });

  await apply('WORKING');
  assertStage('ai-working');
  await apply('LOCAL_TESTS');
  assertStage('ai-needs-test');
  await apply('READY_FOR_HUMAN_MERGE');
  assertStage('ai-ready-to-merge');
  assert.deepEqual(staleIssue.labels.map(label => label.name), [TRIGGER_LABEL, 'bug', 'customer-visible']);

  const mutationsBeforeIdempotentRun = actions.length;
  const readsBeforeIdempotentRun = reads;
  await apply('READY_FOR_HUMAN_MERGE');
  assert.equal(actions.length, mutationsBeforeIdempotentRun);
  assert.equal(reads, readsBeforeIdempotentRun + 1);
  assertStage('ai-ready-to-merge');

  // Failure transition must remove the prior working status using fresh labels.
  server.labels = new Set([TRIGGER_LABEL, 'bug', 'customer-visible', 'ai-working']);
  await apply('FAILED');
  assertStage('ai-failed');
  assert.ok(!server.labels.has('ai-working'));
});

test('push failure is persisted, redacted, labelled, and logged for human review', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-push-failure-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const events = createGithubEventLog({ now: () => '2026-09-28T00:00:00.000Z' });
  let pushCalls = 0;
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      eventLog: events,
      runImplementation: async ({ branch }) => ({
        ok: true,
        tests: 'PASS',
        review: 'SKIP',
        commit: 'a'.repeat(40),
        branch,
      }),
      gitPush: async ({ force }) => {
        pushCalls += 1;
        assert.equal(force, false);
        throw new Error('remote rejected push: GITHUB_TOKEN=ghp_PUSHSECRET');
      },
    });
    assert.equal(result.code, 1);
    assert.equal(pushCalls, 1);
    assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(result.state.commitSha, 'a'.repeat(40));
    assert.match(result.state.branch, /^ai\/issue-42-/);
    assert.equal(result.state.unsafePushPending, true);
    assert.match(result.state.lastFailure, /GitHub branch push failed/);
    assert.doesNotMatch(result.state.lastFailure, /PUSHSECRET|ghp_PUSHSECRET/);
    assert.match(result.state.lastDiagnosis, /outcome is unknown/i);
    const saved = await loadIssueState('owner/app', 42, env);
    assert.equal(saved.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(saved.commitSha, 'a'.repeat(40));
    const labels = await client.getLabels('owner', 'app', 42);
    assert.deepEqual(
      labels.map(label => label.name || label).filter(label => STATUS_LABELS.includes(label)),
      ['ai-human-review'],
    );
    assert.ok(labels.some(label => (label.name || label) === TRIGGER_LABEL));
    const event = events.records.find(entry => entry.action === 'push_failed');
    assert.equal(event.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.match(event.result, /GitHub branch push failed/);
    assert.doesNotMatch(event.result, /PUSHSECRET|ghp_PUSHSECRET/);
    assert.equal(client.log.filter(entry => entry.op === 'createPullRequest').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PR creation failure is persisted, redacted, labelled, and does not retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-pr-failure-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const events = createGithubEventLog({ now: () => '2026-09-28T00:00:00.000Z' });
  let prCalls = 0;
  client.createPullRequest = async () => {
    prCalls += 1;
    throw new Error('GitHub API timeout: Authorization: Bearer gho_PRSECRET');
  };
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      eventLog: events,
      runImplementation: async ({ branch }) => ({
        ok: true,
        tests: 'PASS',
        review: 'SKIP',
        commit: 'b'.repeat(40),
        branch,
      }),
      gitPush: async ({ force }) => {
        assert.equal(force, false);
        return { sha: 'b'.repeat(40) };
      },
    });
    assert.equal(result.code, 1);
    assert.equal(prCalls, 1);
    assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(result.state.commitSha, 'b'.repeat(40));
    assert.match(result.state.branch, /^ai\/issue-42-/);
    assert.equal(result.state.branchPushed, true);
    assert.equal(result.state.unsafePushPending, false);
    assert.equal(result.state.prNumber, null);
    assert.match(result.state.lastFailure, /GitHub PR creation failed/);
    assert.doesNotMatch(result.state.lastFailure, /PRSECRET|gho_PRSECRET|Bearer/);
    assert.match(result.state.lastDiagnosis, /branch was pushed/i);
    const saved = await loadIssueState('owner/app', 42, env);
    assert.equal(saved.branchPushed, true);
    assert.equal(saved.unsafePushPending, false);
    const labels = await client.getLabels('owner', 'app', 42);
    assert.deepEqual(
      labels.map(label => label.name || label).filter(label => STATUS_LABELS.includes(label)),
      ['ai-human-review'],
    );
    const event = events.records.find(entry => entry.action === 'pr_creation_failed');
    assert.equal(event.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.doesNotMatch(event.result, /PRSECRET|gho_PRSECRET|Bearer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('push failure redaction reaches state, events, and CLI output without secret remnants', async () => {
  const cases = [
    ['Authorization: Bearer abc123SECRET', 'abc123SECRET'],
    ['GH_TOKEN="token with spaces"', 'token with spaces'],
    ['api-key: "api secret value"', 'api secret value'],
    ["password='my long password'", 'my long password'],
    ['Authorization: bEaReR MixedCaseSecret123', 'MixedCaseSecret123'],
  ];
  for (const [message, secret] of cases) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-redaction-'));
    const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
    const client = createMemoryGithubClient(seedIssue());
    const events = createGithubEventLog();
    try {
      const result = await runIssueAutomation({
        client,
        config: assisted,
        repo: 'owner/app',
        issueNumber: 42,
        env,
        eventLog: events,
        runImplementation: async ({ branch }) => ({
          ok: true, tests: 'PASS', review: 'SKIP', commit: 'c'.repeat(40), branch,
        }),
        gitPush: async () => {
          throw new Error(`push rejected: ${message}`);
        },
      });
      const saved = await loadIssueState('owner/app', 42, env);
      const output = formatGithubStatus({
        issue: { number: 42, title: 'Fix checkout validation' },
        automationMode: result.state.mode,
        state: result.state,
      });
      const persisted = JSON.stringify(saved);
      const eventPayload = JSON.stringify(events.records);
      const escaped = new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      assert.equal(result.code, 1, message);
      assert.doesNotMatch(persisted, escaped, `${message} leaked to state`);
      assert.doesNotMatch(eventPayload, escaped, `${message} leaked to event`);
      assert.doesNotMatch(output, escaped, `${message} leaked to CLI output`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('escaped quoted push secrets leave no suffix in state, events, or CLI output', async () => {
  const cases = [
    ['Authorization: "Bearer abc\\"def SecretSuffix"', ['abc\\"def SecretSuffix', 'SecretSuffix']],
    ["Authorization: 'Bearer abc\\'def SecretSuffix'", ["abc\\'def SecretSuffix", 'SecretSuffix']],
    ['GH_TOKEN="token with \\"embedded\\" secret suffix"', ['token with \\"embedded\\" secret suffix', 'secret suffix']],
    ["GITHUB_TOKEN='token with \\'embedded\\' secret suffix'", ["token with \\'embedded\\' secret suffix", 'secret suffix']],
    ['password="my \\"escaped\\" password value"', ['my \\"escaped\\" password value', 'password value']],
    ["secret='my \\'escaped\\' secret value'", ["my \\'escaped\\' secret value", 'secret value']],
    ['api-key="api \\"embedded\\" secret value"', ['api \\"embedded\\" secret value', 'secret value']],
    ['OPENAI_API_KEY="sk-test-\\"quoted\\"-secret-suffix"', ['sk-test-\\"quoted\\"-secret-suffix', 'secret-suffix']],
  ];
  for (const [message, fragments] of cases) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-escaped-redaction-'));
    const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
    const client = createMemoryGithubClient(seedIssue());
    const events = createGithubEventLog();
    try {
      const result = await runIssueAutomation({
        client,
        config: assisted,
        repo: 'owner/app',
        issueNumber: 42,
        env,
        eventLog: events,
        runImplementation: async ({ branch }) => ({
          ok: true, tests: 'PASS', review: 'SKIP', commit: 'd'.repeat(40), branch,
        }),
        gitPush: async () => {
          throw new Error(`push rejected: ${message}`);
        },
      });
      const saved = await loadIssueState('owner/app', 42, env);
      const destinations = [
        JSON.stringify(saved),
        JSON.stringify(events.records),
        formatGithubStatus({
          issue: { number: 42, title: 'Fix checkout validation' },
          automationMode: result.state.mode,
          state: result.state,
        }),
      ];
      assert.equal(result.code, 1, message);
      for (const fragment of fragments) {
        const escaped = new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        for (const destination of destinations) {
          assert.doesNotMatch(destination, escaped, `${message} leaked ${fragment}`);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('isEstablishedExecutionRoute recognizes concrete workers only', () => {
  assert.equal(isEstablishedExecutionRoute('CODEX'), true);
  assert.equal(isEstablishedExecutionRoute('cursor'), true);
  assert.equal(isEstablishedExecutionRoute('GEMINI'), true);
  assert.equal(isEstablishedExecutionRoute('TEAM'), true);
  assert.equal(isEstablishedExecutionRoute('AUTO'), false);
  assert.equal(isEstablishedExecutionRoute(''), false);
  assert.equal(isEstablishedExecutionRoute(null), false);
});

test('resume preserves AUTO-resolved CODEX route instead of rewriting to AUTO', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-route-auto-codex-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient(seedIssue());
  const commit = 'c'.repeat(40);
  let implCalls = 0;
  try {
    const first = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async ({ branch, routing }) => {
        implCalls += 1;
        assert.equal(routing.worker, 'AUTO');
        return {
          ok: true,
          tests: 'PASS',
          review: 'PASS',
          commit,
          branch,
          route: 'CODEX',
          model: 'auto',
        };
      },
      gitPush: async () => ({ sha: commit }),
      waitForCi: async () => ({ status: CI_STATUS.PENDING, summary: 'checks pending' }),
    });
    assert.equal(first.state.route, 'CODEX');
    assert.equal(first.state.stage, 'WAITING_FOR_CI');
    assert.equal(first.state.implementationAttempt, 1);
    assert.equal(implCalls, 1);
    const afterFirst = await loadIssueState('owner/app', 42, env);
    assert.equal(afterFirst.route, 'CODEX');

    const second = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('resume must not re-run implementation solely for route');
      },
      gitPush: async () => {
        throw new Error('resume must not push again');
      },
      waitForCi: async () => ({ status: CI_STATUS.PENDING, summary: 'checks pending' }),
    });
    assert.equal(second.state.route, 'CODEX');
    assert.notEqual(second.state.route, 'AUTO');
    assert.equal(second.state.selectedRoute, 'AUTO');
    assert.equal(second.state.implementationAttempt, 1);
    assert.equal(second.state.commitSha, commit);
    assert.equal(second.state.branch, first.state.branch);
    assert.equal(second.state.stage, 'WAITING_FOR_CI');
    assert.equal(implCalls, 1);
    const saved = await loadIssueState('owner/app', 42, env);
    assert.equal(saved.route, 'CODEX');
    assert.equal(saved.implementationAttempt, 1);
    assert.equal(saved.commitSha, commit);
    assert.equal(saved.branch, first.state.branch);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resume keeps historical CODEX when current routing would select CURSOR', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-route-codex-cursor-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = 'a'.repeat(40);
  const branch = 'ai/issue-42-fix-checkout-validation';
  const client = createMemoryGithubClient(seedIssue({ labels: [TRIGGER_LABEL, 'ai-cursor'] }));
  let implCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 42, title: 'Fix checkout validation', html_url: 'https://github.com/owner/app/issues/42' },
      }),
      stage: 'LOCAL_TESTS',
      localTests: 'PASS',
      review: 'PASS',
      commitSha: commit,
      branch,
      route: 'CODEX',
      selectedRoute: 'AUTO',
      implementationAttempt: 1,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        return { ok: true, tests: 'PASS', review: 'PASS', commit: 'wrong', branch: 'ai/wrong', route: 'CURSOR' };
      },
      gitPush: async () => ({ sha: commit }),
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(implCalls, 0);
    assert.equal(result.state.route, 'CODEX');
    assert.notEqual(result.state.route, 'CURSOR');
    assert.equal(result.state.selectedRoute, 'CURSOR');
    assert.equal(result.state.implementationAttempt, 1);
    assert.equal(result.state.commitSha, commit);
    assert.equal(result.state.branch, branch);
    const saved = await loadIssueState('owner/app', 42, env);
    assert.equal(saved.route, 'CODEX');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual CODEX route survives resume', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-route-manual-codex-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = 'b'.repeat(40);
  const branch = 'ai/issue-42-fix-checkout-validation';
  const client = createMemoryGithubClient(seedIssueNumber(42, {
    seed: {
      checks: {
        [commit]: [{ name: 'test', status: 'in_progress', conclusion: null }],
      },
      pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #42', issueNumber: 42 }],
    },
  }));
  // Override labels to manual CODEX after seedIssueNumber default.
  const issue = await client.getIssue('owner', 'app', 42);
  issue.labels = [{ name: TRIGGER_LABEL }, { name: 'ai-codex' }];
  let implCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 42, title: 'Fix checkout validation', html_url: 'https://github.com/owner/app/issues/42' },
      }),
      stage: 'WAITING_FOR_CI',
      localTests: 'PASS',
      review: 'PASS',
      githubCi: 'PENDING',
      commitSha: commit,
      branch,
      prNumber: 7,
      route: 'CODEX',
      selectedRoute: 'CODEX',
      implementationAttempt: 1,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('must not re-implement');
      },
      gitPush: async () => {
        throw new Error('must not push');
      },
    });
    assert.equal(implCalls, 0);
    assert.equal(result.state.route, 'CODEX');
    assert.equal(result.state.selectedRoute, 'CODEX');
    assert.equal(result.state.implementationAttempt, 1);
    assert.equal(result.state.commitSha, commit);
    assert.equal(result.state.branch, branch);
    assert.equal(result.state.stage, 'WAITING_FOR_CI');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TEAM route survives resume without changing review semantics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-route-team-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = 'e'.repeat(40);
  const branch = 'ai/issue-42-fix-checkout-validation';
  const client = createMemoryGithubClient(seedIssueNumber(42, {
    seed: {
      checks: {
        [commit]: [{ name: 'test', status: 'in_progress', conclusion: null }],
      },
      pulls: [{ number: 9, head: { ref: branch, sha: commit }, body: 'Closes #42', issueNumber: 42 }],
    },
  }));
  const issue = await client.getIssue('owner', 'app', 42);
  issue.labels = [{ name: TRIGGER_LABEL }, { name: 'ai-team' }];
  let implCalls = 0;
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 42, title: 'Fix checkout validation', html_url: 'https://github.com/owner/app/issues/42' },
      }),
      stage: 'WAITING_FOR_CI',
      localTests: 'PASS',
      review: 'PASS',
      githubCi: 'PENDING',
      commitSha: commit,
      branch,
      prNumber: 9,
      route: 'TEAM',
      selectedRoute: 'TEAM',
      implementationAttempt: 1,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      runImplementation: async () => {
        implCalls += 1;
        throw new Error('must not re-implement');
      },
    });
    assert.equal(implCalls, 0);
    assert.equal(result.state.route, 'TEAM');
    assert.equal(result.state.selectedRoute, 'TEAM');
    assert.equal(result.state.review, 'PASS');
    assert.equal(result.state.stage, 'WAITING_FOR_CI');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CI fix loop resume preserves original implementation route', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-route-ci-fix-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = 'f'.repeat(40);
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  const client = createMemoryGithubClient(seedIssueNumber(6, {
    seed: {
      checks: {
        [commit]: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      },
      pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
    },
  }));
  let fixCalls = 0;
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
      review: 'PASS',
      commitSha: commit,
      branch,
      route: 'CODEX',
      selectedRoute: 'AUTO',
      implementationAttempt: 1,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      runImplementation: async ({ routing }) => {
        fixCalls += 1;
        // Label routing remains AUTO; fix adapter is unchanged. Do not report a
        // different route so the original implementation identity stays CODEX.
        assert.equal(routing.worker, 'AUTO');
        return { ok: true, tests: 'PASS', review: 'PASS', commit, branch };
      },
      gitPush: async () => ({ sha: commit }),
    });
    assert.equal(fixCalls, 4);
    assert.equal(result.state.route, 'CODEX');
    assert.notEqual(result.state.route, 'AUTO');
    assert.equal(result.state.selectedRoute, 'AUTO');
    assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.route, 'CODEX');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
