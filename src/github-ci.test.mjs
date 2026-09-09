import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckRuns, CI_STATUS, collectCiFailureContext, redactCiText } from './github-ci.mjs';

test('CI PASS FAIL TIMEOUT PENDING', () => {
  assert.equal(classifyCheckRuns([{ name: 'test', status: 'completed', conclusion: 'success' }]).status, CI_STATUS.PASS);
  assert.equal(classifyCheckRuns([{ name: 'test', status: 'completed', conclusion: 'failure' }]).status, CI_STATUS.FAIL);
  assert.equal(classifyCheckRuns([{ name: 'test', status: 'in_progress' }]).status, CI_STATUS.PENDING);
  const timed = classifyCheckRuns([], { now: 10_000, startedAt: 0, timeoutMs: 1000 });
  assert.equal(timed.status, CI_STATUS.TIMEOUT);
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
