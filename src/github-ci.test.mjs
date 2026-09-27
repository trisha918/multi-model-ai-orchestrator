import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckRuns, CI_STATUS, collectCiFailureContext, extractCheckRuns, redactCiText } from './github-ci.mjs';

test('CI PASS FAIL TIMEOUT PENDING', () => {
  assert.equal(classifyCheckRuns([{ name: 'test', status: 'completed', conclusion: 'success' }]).status, CI_STATUS.PASS);
  assert.equal(classifyCheckRuns([{ name: 'test', status: 'completed', conclusion: 'failure' }]).status, CI_STATUS.FAIL);
  assert.equal(classifyCheckRuns([{ name: 'test', status: 'in_progress' }]).status, CI_STATUS.PENDING);
  const timed = classifyCheckRuns([], { now: 10_000, startedAt: 0, timeoutMs: 1000 });
  assert.equal(timed.status, CI_STATUS.TIMEOUT);
});

test('completed Node tests Check API payload is PASS', () => {
  const run = { name: 'Node tests', status: 'completed', conclusion: 'success' };
  assert.equal(classifyCheckRuns(run).status, CI_STATUS.PASS);
  assert.equal(classifyCheckRuns([run]).status, CI_STATUS.PASS);
  assert.equal(classifyCheckRuns({
    total_count: 1,
    check_runs: [run],
  }).status, CI_STATUS.PASS);
  assert.deepEqual(extractCheckRuns({ total_count: 1, check_runs: [run] }), [run]);
});

test('CI logs and secrets are redacted in failure context', () => {
  const ctx = collectCiFailureContext({
    issueTask: 'fix it',
    branch: 'ai/issue-1',
    logs: 'Authorization: Bearer ghp_SECRETTOKEN123\nGITHUB_TOKEN=abc',
    ci: { status: 'FAIL', summary: 'Windows Node tests' },
  });
  assert.match(ctx, /GitHub CI: FAIL/);
  assert.doesNotMatch(ctx, /ghp_SECRETTOKEN123/);
  assert.match(redactCiText('token: ghp_abc'), /redacted/);
  assert.doesNotMatch(redactCiText('OPENAI_API_KEY=sk_provider_secret'), /sk_provider_secret/);
});

test('credential redaction consumes complete bearer and quoted assignment values', () => {
  const cases = [
    ['Authorization: Bearer abc123SECRET', 'abc123SECRET'],
    ['authorization: bearer abc123SECRET', 'abc123SECRET'],
    ['Authorization=Bearer abc123SECRET', 'abc123SECRET'],
    ['Authorization: "Bearer abc123SECRET"', 'abc123SECRET'],
    ['GH_TOKEN=abc123', 'abc123'],
    ['GH_TOKEN="token with spaces"', 'token with spaces'],
    ["GITHUB_TOKEN='token with spaces'", 'token with spaces'],
    ['token=abc123', 'abc123'],
    ['token: abc123', 'abc123'],
    ['password="password with spaces"', 'password with spaces'],
    ["secret='secret with spaces'", 'secret with spaces'],
    ['api_key="api secret value"', 'api secret value'],
    ['api-key: "api secret value"', 'api secret value'],
    ["apikey='api secret value'", 'api secret value'],
    ['Bearer abc123SECRET', 'abc123SECRET'],
  ];
  for (const [input, secret] of cases) {
    const output = redactCiText(input);
    assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), input);
    assert.match(output, /redacted/i, input);
  }
});

test('credential redaction consumes escape-aware quoted values without suffix leaks', () => {
  const cases = [
    ['Authorization: "Bearer abc\\"def SecretSuffix"', ['abc\\"def SecretSuffix', 'SecretSuffix']],
    ["Authorization: 'Bearer abc\\'def SecretSuffix'", ["abc\\'def SecretSuffix", 'SecretSuffix']],
    ['GH_TOKEN="token with \\"embedded\\" secret suffix"', ['token with \\"embedded\\" secret suffix', 'secret suffix']],
    ["GITHUB_TOKEN='token with \\'embedded\\' secret suffix'", ["token with \\'embedded\\' secret suffix", 'secret suffix']],
    ['password="my \\"escaped\\" password value"', ['my \\"escaped\\" password value', 'password value']],
    ["secret='my \\'escaped\\' secret value'", ["my \\'escaped\\' secret value", 'secret value']],
    ['api-key="api \\"embedded\\" secret value"', ['api \\"embedded\\" secret value', 'secret value']],
    ['OPENAI_API_KEY="sk-test-\\"quoted\\"-secret-suffix"', ['sk-test-\\"quoted\\"-secret-suffix', 'secret-suffix']],
    ['GH_TOKEN="token with \\\\backslash secret suffix"', ['token with \\\\backslash secret suffix', 'secret suffix']],
  ];
  for (const [input, fragments] of cases) {
    const output = redactCiText(input);
    for (const fragment of fragments) {
      assert.doesNotMatch(output, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), input);
    }
    assert.match(output, /redacted/i, input);
  }
});

test('credential redaction preserves ordinary diagnostics', () => {
  for (const text of [
    'GitHub API timeout while creating PR',
    'branch push rejected',
    'repository not found',
    'bearer of bad news is not a credential',
  ]) {
    assert.equal(redactCiText(text), text);
  }
});
