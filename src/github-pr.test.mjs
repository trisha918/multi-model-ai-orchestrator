import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeBranchName, prTitleForIssue, prBodyForIssue, formatGithubStatus, assertSafePushBranch } from './github-pr.mjs';

test('branch naming is deterministic and avoids collisions', () => {
  const issue = { number: 42, title: 'Fix checkout validation' };
  assert.equal(proposeBranchName(issue), 'ai/issue-42-fix-checkout-validation');
  const second = proposeBranchName(issue, { existingBranches: ['ai/issue-42-fix-checkout-validation'] });
  assert.equal(second, 'ai/issue-42-fix-checkout-validation-2');
});

test('PR title and body reference the issue and do not claim CI PASS early', () => {
  const issue = { number: 42, title: 'checkout validation error', html_url: 'https://github.com/o/a/issues/42' };
  assert.equal(prTitleForIssue(issue), 'Fix #42: checkout validation error');
  const body = prBodyForIssue({
    issue,
    route: 'TEAM',
    models: 'plan=auto, implement=gpt-5.6-terra',
    localTests: 'PASS',
    githubCi: 'PENDING',
    attempt: 1,
    maxAttempts: 5,
    branch: 'ai/issue-42-fix-checkout-validation',
    review: 'PASS',
  });
  assert.match(body, /Closes #42/);
  assert.match(body, /Route: TEAM/);
  assert.match(body, /Local Tests: PASS/);
  assert.match(body, /GitHub CI: PENDING/);
  assert.doesNotMatch(body, /GitHub CI: PASS/);
  assert.match(body, /does \*\*not\*\* auto-merge/);
});

test('status output matches the CLI contract', () => {
  const text = formatGithubStatus({
    issue: { number: 42, title: 'Fix checkout validation' },
    automationMode: 'assisted',
    state: {
      stage: 'WAITING_FOR_CI',
      ciAttempts: 2,
      maxAttempts: 5,
      route: 'CODEX',
      model: 'gpt-5.6-terra',
      branch: 'ai/issue-42-checkout-validation',
      prNumber: 51,
      localTests: 'PASS',
      githubCi: 'PENDING',
    },
  });
  assert.match(text, /#42 Fix checkout validation/);
  assert.match(text, /ASSISTED/);
  assert.match(text, /WAITING_FOR_CI/);
  assert.match(text, /2 \/ 5/);
  assert.match(text, /CODEX/);
  assert.match(text, /gpt-5.6-terra/);
  assert.match(text, /#51/);
});

test('refuses to push main', () => {
  assert.throws(() => assertSafePushBranch('main'), /protected/);
  assert.throws(() => assertSafePushBranch('feature/x'), /non-ai/);
  assert.equal(assertSafePushBranch('ai/issue-1-x'), 'ai/issue-1-x');
});
