import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubClient, createMemoryGithubClient, detectGithubAuth, redactGithubText } from './github-client.mjs';
import { LABEL_DEFINITIONS } from './github-labels.mjs';

test('GitHub client mocks do not use the network', async () => {
  const client = createMemoryGithubClient({
    issues: {
      1: { number: 1, title: 't', labels: [{ name: 'ai-auto' }], html_url: '', user: { login: 'a' } },
    },
  });
  const issue = await client.getIssue('o', 'r', 1);
  assert.equal(issue.title, 't');
  await client.addLabel('o', 'r', 1, 'ai-working');
  const labels = await client.getLabels('o', 'r', 1);
  assert.ok(labels.some(l => (l.name || l) === 'ai-working'));
  const pr = await client.createPullRequest('o', 'r', { title: 'Fix #1: t', body: 'Closes #1', head: 'ai/x', base: 'main' });
  assert.equal(typeof pr.number, 'number');
});

test('HTTP client uses injected fetch and redacts secrets', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    return {
      ok: true,
      text: async () => JSON.stringify({ number: 9, title: 'from-api', labels: [] }),
    };
  };
  const client = createGithubClient({ env: { GITHUB_TOKEN: 'ghp_LIVESECRET' }, fetchImpl });
  const issue = await client.getIssue('o', 'r', 9);
  assert.equal(issue.number, 9);
  const fetch404 = async () => ({
    ok: false,
    status: 404,
    text: async () => 'Not Found',
  });
  const missing = createGithubClient({ env: { GITHUB_TOKEN: 'ghp_LIVESECRET' }, fetchImpl: fetch404 });
  assert.equal(await missing.getBranch('o', 'r', 'ai/missing'), null);
  assert.equal(calls[0].auth, 'Bearer ghp_LIVESECRET');
  assert.match(redactGithubText('token: ghp_LIVESECRET'), /redacted/);
  assert.doesNotMatch(redactGithubText('token: ghp_LIVESECRET'), /LIVESECRET/);
});

test('detectGithubAuth never includes credential values', () => {
  const a = detectGithubAuth({ GITHUB_TOKEN: 'ghp_SECRET' });
  assert.equal(a.ok, true);
  assert.equal(a.tokenPresent, true);
  assert.doesNotMatch(a.detail, /ghp_SECRET/);
  const b = detectGithubAuth({});
  assert.equal(b.ok, false);
});

test('label definitions cover required names', () => {
  const names = LABEL_DEFINITIONS.map(d => d.name);
  for (const n of ['ai-auto', 'ai-stop', 'ai-ready-to-merge', 'ai-human-review']) {
    assert.ok(names.includes(n), n);
  }
});
