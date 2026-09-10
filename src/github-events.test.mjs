import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRepoConfigText } from './github-config.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { runIssueAutomation, CI_STATUS } from './github-automation.mjs';
import { TRIGGER_LABEL } from './github-labels.mjs';
import {
  GITHUB_EVENT_ACTIONS,
  createGithubEvent,
  createGithubEventLog,
  actionsOf,
  issueEventsPath,
} from './github-events.mjs';

const assisted = parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
  max_fix_attempts: 5
review:
  required: false
`);

test('createGithubEvent includes the required observability fields', () => {
  const event = createGithubEvent({
    timestamp: '2026-09-11T00:00:00.000Z',
    repository: 'owner/app',
    issue: 42,
    stage: 'STARTED',
    action: 'issue_received',
    result: 'ok',
  });
  assert.deepEqual(event, {
    timestamp: '2026-09-11T00:00:00.000Z',
    repository: 'owner/app',
    issue: 42,
    stage: 'STARTED',
    action: 'issue_received',
    result: 'ok',
  });
  assert.deepEqual([...GITHUB_EVENT_ACTIONS], [
    'issue_received',
    'authorization_checked',
    'implementation_started',
    'implementation_completed',
    'local_tests_completed',
    'push_started',
    'push_completed',
    'pr_created',
    'ci_started',
    'ci_completed',
    'human_review_required',
  ]);
  assert.throws(() => createGithubEvent({ action: 'merge_pr' }));
});

test('happy-path automation emits the structured lifecycle events', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-events-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const events = createGithubEventLog({ now: () => '2026-09-11T00:00:00.000Z' });
  const client = createMemoryGithubClient({
    issues: {
      42: {
        number: 42,
        title: 'Fix checkout validation',
        body: 'Make checkout validation fail closed.',
        html_url: 'https://github.com/owner/app/issues/42',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      42: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
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
      issueNumber: 42,
      env,
      eventLog: events,
      runImplementation: async ({ branch }) => ({
        ok: true, tests: 'PASS', review: 'PASS', commit: 'abc123', branch, route: 'CODEX', model: 'auto',
      }),
      gitPush: async () => ({ sha: 'abc123' }),
      waitForCi: async () => ({ status: CI_STATUS.PASS, summary: 'ok' }),
    });
    assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
    assert.deepEqual(actionsOf(events.records), [
      'issue_received',
      'authorization_checked',
      'implementation_started',
      'implementation_completed',
      'local_tests_completed',
      'push_started',
      'push_completed',
      'pr_created',
      'ci_started',
      'ci_completed',
    ]);
    for (const event of events.records) {
      assert.equal(event.repository, 'owner/app');
      assert.equal(event.issue, 42);
      assert.equal(event.timestamp, '2026-09-11T00:00:00.000Z');
      assert.equal('stage' in event, true);
      assert.equal('action' in event, true);
      assert.equal('result' in event, true);
      assert.doesNotMatch(JSON.stringify(event), /ghp_|github_pat_|Bearer /i);
    }
    const ci = events.records.find(e => e.action === 'ci_completed');
    assert.equal(ci.result, 'PASS');
    assert.equal(result.events, events.records);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('blocked automation logs authorization and does not implement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-events-block-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const events = createGithubEventLog();
  const client = createMemoryGithubClient({
    issues: {
      42: {
        number: 42,
        title: 't',
        body: '',
        html_url: 'https://github.com/owner/app/issues/42',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      42: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'stranger' }, author_association: 'NONE' }],
    },
    permissions: { stranger: { permission: 'none' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
  });
  try {
    const result = await runIssueAutomation({
      client,
      config: assisted,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      eventLog: events,
      runImplementation: async () => {
        throw new Error('must not implement when blocked');
      },
    });
    assert.equal(result.blocked, true);
    assert.deepEqual(actionsOf(events.records), ['issue_received', 'authorization_checked']);
    assert.equal(events.records[1].result, 'blocked');
    assert.equal(events.records[1].stage, 'BLOCKED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('human_review_required is emitted when the CI attempt limit is reached', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-events-limit-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const events = createGithubEventLog();
  const client = createMemoryGithubClient({
    issues: {
      42: {
        number: 42,
        title: 't',
        body: '',
        html_url: 'https://github.com/owner/app/issues/42',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      42: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
  });
  const limited = parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
  max_fix_attempts: 1
review:
  required: false
`);
  try {
    const result = await runIssueAutomation({
      client,
      config: limited,
      repo: 'owner/app',
      issueNumber: 42,
      env,
      eventLog: events,
      runImplementation: async ({ branch }) => ({
        ok: true, tests: 'PASS', review: 'PASS', commit: 'abc', branch,
      }),
      gitPush: async () => ({ sha: 'abc' }),
      waitForCi: async () => ({ status: CI_STATUS.FAIL, summary: 'boom' }),
    });
    assert.equal(result.state.stage, 'HUMAN_REVIEW_REQUIRED');
    assert.ok(actionsOf(events.records).includes('human_review_required'));
    const review = events.records.find(e => e.action === 'human_review_required');
    assert.equal(review.stage, 'HUMAN_REVIEW_REQUIRED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('event log can persist JSONL beside the issue state file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-events-file-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const file = issueEventsPath('owner/app', 7, env);
  const events = createGithubEventLog({ persistPath: file, now: () => 't0' });
  await events.emit({
    repository: 'owner/app',
    issue: 7,
    stage: 'STARTED',
    action: 'issue_received',
    result: 'ok',
  });
  const raw = await readFile(file, 'utf8');
  assert.match(raw, /"action":"issue_received"/);
  assert.match(raw, /"issue":7/);
  await rm(dir, { recursive: true, force: true });
});
