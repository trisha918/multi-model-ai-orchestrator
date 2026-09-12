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
});
