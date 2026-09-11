import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TRIGGER_LABEL } from './github-labels.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { emptyState, saveIssueState } from './github-state.mjs';
import { parseGithubCli, cmdGithub } from './github-cli.mjs';
import { collectIssueDoctor, formatIssueDoctor } from './github-doctor.mjs';

test('issue doctor report includes the required diagnostic fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-doctor-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir, GITHUB_TOKEN: 'ghp_TESTTOKEN' };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'ai-orchestrator.yml'), `automation:
  enabled: true
  mode: assisted
review:
  required: false
`, 'utf8');
  await writeFile(path.join(dir, '.github', 'workflows', 'ai-issue.yml'), 'name: ai-issue\n', 'utf8');
  const client = createMemoryGithubClient({
    issues: {
      6: {
        number: 6,
        title: 'Add divide',
        body: '',
        html_url: 'https://github.com/owner/app/issues/6',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main', branch],
    repo: { default_branch: 'main', private: true, permissions: { admin: true, push: true, pull: true } },
    remoteBranches: { [branch]: commit },
    pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
    checks: { [commit]: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
    runners: [{
      name: 'desk-win',
      status: 'online',
      labels: [{ name: 'self-hosted' }, { name: 'Windows' }, { name: 'ai-orchestrator' }],
    }],
  });
  try {
    await saveIssueState({
      ...emptyState({ repo: 'owner/app', issue: { number: 6, title: 'Add divide' } }),
      stage: 'WAITING_FOR_CI',
      branch,
      commitSha: commit,
      prNumber: 7,
      localTests: 'PASS',
      githubCi: 'UNKNOWN',
      mode: 'assisted',
    }, env);
    const report = await collectIssueDoctor({
      client,
      repo: 'owner/app',
      issueNumber: 6,
      env,
      cwd: dir,
    });
    const text = formatIssueDoctor(report);
    assert.match(text, /^Repository: owner\/app/m);
    assert.match(text, /^Issue: 6$/m);
    assert.match(text, /^Stage: WAITING_FOR_CI$/m);
    assert.match(text, /^Branch: /m);
    assert.match(text, /^PR: #7$/m);
    assert.match(text, /^Local tests: PASS$/m);
    assert.match(text, /^GitHub CI: PASS$/m);
    assert.match(text, /^Config: /m);
    assert.match(text, /^Authentication: /m);
    assert.match(text, /^Problems:/m);
    assert.doesNotMatch(text, /ghp_TESTTOKEN/);
    assert.equal(report.stage, 'WAITING_FOR_CI');
    assert.equal(report.pr, '#7');
    assert.equal(report.githubCi, 'PASS');
    assert.equal(report.problems.some(p => /Runner/.test(p)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('github doctor CLI with --issue prints the issue diagnostic contract', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-doctor-cli-'));
  const env = { ...process.env, AI_ORCHESTRATOR_RUNTIME_ROOT: dir, GITHUB_TOKEN: 'ghp_TESTTOKEN' };
  await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'ai-orchestrator.yml'), `automation:
  enabled: true
  mode: assisted
`, 'utf8');
  await writeFile(path.join(dir, '.github', 'workflows', 'ai-issue.yml'), 'name: ai-issue\n', 'utf8');
  const client = createMemoryGithubClient({
    issues: {
      3: {
        number: 3, title: 't', body: '', html_url: '', user: { login: 'r' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    repo: { private: true, default_branch: 'main', permissions: { admin: true, push: true } },
    runners: [{
      name: 'desk-win',
      status: 'online',
      labels: [{ name: 'self-hosted' }, { name: 'Windows' }, { name: 'ai-orchestrator' }],
    }],
  });
  const logs = [];
  try {
    await saveIssueState({
      ...emptyState({ repo: 'owner/app', issue: { number: 3, title: 't' } }),
      stage: 'FAILED',
      localTests: 'FAIL',
      githubCi: 'UNKNOWN',
    }, env);
    const code = await cmdGithub(parseGithubCli(['doctor', '--repo', 'owner/app', '--issue', '3']), {
      cwd: dir,
      env,
      clientFactory: async () => client,
      stdout: s => logs.push(s),
      stderr: s => logs.push(s),
    });
    const blob = logs.join('\n');
    assert.match(blob, /Repository: owner\/app/);
    assert.match(blob, /Issue: 3/);
    assert.match(blob, /Stage: FAILED/);
    assert.match(blob, /Local tests: FAIL/);
    assert.match(blob, /Authentication:/);
    assert.match(blob, /Problems:/);
    assert.doesNotMatch(blob, /ghp_TESTTOKEN/);
    assert.equal(typeof code, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('issue doctor reports missing state and missing runner as problems', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-doctor-miss-'));
  const env = { AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const client = createMemoryGithubClient({
    repo: { private: true, default_branch: 'main', permissions: { pull: true } },
    runners: [],
  });
  try {
    const report = await collectIssueDoctor({
      client,
      repo: 'owner/app',
      issueNumber: 9,
      env,
      cwd: dir,
    });
    assert.equal(report.stage, 'IDLE');
    assert.ok(report.problems.some(p => /state file/i.test(p)));
    assert.ok(report.problems.some(p => /Runner/i.test(p)));
    const text = formatIssueDoctor(report);
    assert.match(text, /Problems:\n-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
