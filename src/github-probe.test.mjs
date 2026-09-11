import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeAiRunners,
  summarizeRepoPermissions,
  formatGithubRepoDoctor,
  summarizeAiIssueWorkflowPermissions,
  probeGithubRepo,
} from './github-probe.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from './paths.mjs';

test('runner summary detects labeled online AI runner', () => {
  const none = summarizeAiRunners({ runners: [] });
  assert.equal(none.online, false);
  const miss = summarizeAiRunners({
    runners: [{ name: 'x', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'Windows' }] }],
  });
  assert.equal(miss.found, false);
  const ok = summarizeAiRunners({
    runners: [{
      name: 'desk-win',
      status: 'online',
      labels: [{ name: 'self-hosted' }, { name: 'Windows' }, { name: 'ai-orchestrator' }],
    }],
  });
  assert.equal(ok.online, true);
  assert.match(ok.detail, /desk-win/);
});

test('repo doctor output never includes token values', () => {
  const text = formatGithubRepoDoctor({
    repoSlug: 'me/ai-orchestrator-e2e-test',
    auth: { ok: true, detail: 'GITHUB_TOKEN or GH_TOKEN present (value not logged)' },
    permissions: summarizeRepoPermissions({ private: true, permissions: { admin: true, push: true, pull: true } }),
    runners: { detail: 'NONE matching [self-hosted, Windows, ai-orchestrator] (0 runner(s) in repo)' },
  });
  assert.match(text, /private/);
  assert.match(text, /Issues: write/);
  assert.match(text, /Pull requests: write/);
  assert.match(text, /statuses: read/);
  assert.match(text, /checks: read/);
  assert.match(text, /actions: read/);
  assert.doesNotMatch(text, /Actions\/checks:/);
  assert.doesNotMatch(text, /ghp_/);
  assert.match(text, /never printed/i);
});

test('example ai-issue.yml reports complete CI observation permissions', () => {
  const y = readFileSync(
    path.join(packageRoot(), 'examples', 'github-e2e-test', '.github', 'workflows', 'ai-issue.yml'),
    'utf8',
  );
  const summary = summarizeAiIssueWorkflowPermissions(y);
  assert.equal(summary.ciOk, true);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.ciMissing, []);
  assert.match(summary.detail, /OK actions: read, checks: read, statuses: read/);
});

test('workflow missing statuses: read is not CI-ready', () => {
  const incomplete = `
permissions:
  contents: write
  issues: write
  pull-requests: write
  checks: read
  actions: read
jobs:
  automate:
    permissions:
      contents: write
      issues: write
      pull-requests: write
      checks: read
      actions: read
`;
  const summary = summarizeAiIssueWorkflowPermissions(incomplete);
  assert.equal(summary.ciOk, false);
  assert.ok(summary.ciMissing.includes('statuses: read'));
  assert.match(summary.detail, /statuses/);
  const text = formatGithubRepoDoctor({
    repoSlug: 'o/r',
    auth: { ok: true },
    permissions: summarizeRepoPermissions({ private: true, permissions: { push: true } }),
    runners: { detail: 'ONLINE: x' },
    workflowPermissions: summary,
  });
  assert.match(text, /MISSING \(have missing\)/);
  assert.match(text, /statuses:/);
  assert.doesNotMatch(text, /Actions\/checks: read/);
});

test('probeGithubRepo uses mock client not the network', async () => {
  const client = createMemoryGithubClient({
    repo: { private: true, default_branch: 'main', permissions: { push: true, pull: true, admin: false } },
    runners: [{
      name: 'box',
      status: 'offline',
      labels: [{ name: 'self-hosted' }, { name: 'Windows' }, { name: 'ai-orchestrator' }],
    }],
  });
  const probed = await probeGithubRepo(client, 'o', 'r');
  assert.equal(probed.permissions.private, true);
  assert.equal(probed.runners.found, true);
  assert.equal(probed.runners.online, false);
  assert.match(probed.permissions.ciObservation, /statuses: read/);
});
