import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAiRunners, summarizeRepoPermissions, formatGithubRepoDoctor } from './github-probe.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { probeGithubRepo } from './github-probe.mjs';

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
  assert.doesNotMatch(text, /ghp_/);
  assert.match(text, /never printed/i);
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
});
