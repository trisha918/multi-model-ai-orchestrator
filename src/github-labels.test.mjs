import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIssueRouting, RoutingConflictError, reconcileStatusLabels, TRIGGER_LABEL } from './github-labels.mjs';

test('ai-auto alone is AUTO worker and AUTO model', () => {
  const r = resolveIssueRouting(['ai-auto']);
  assert.equal(r.worker, 'AUTO');
  assert.equal(r.model, 'AUTO');
  assert.equal(r.trigger, true);
});

test('route labels map onto existing workers', () => {
  assert.equal(resolveIssueRouting(['ai-auto', 'ai-team']).worker, 'TEAM');
  assert.equal(resolveIssueRouting(['ai-auto', 'ai-codex']).worker, 'CODEX');
  assert.equal(resolveIssueRouting(['ai-auto', 'ai-codex']).selection, 'AUTO');
  assert.equal(resolveIssueRouting(['ai-auto', 'ai-gemini']).worker, 'GEMINI');
  assert.equal(resolveIssueRouting(['ai-auto', 'ai-cursor']).worker, 'CURSOR');
});

test('model labels select manual aliases', () => {
  const sol = resolveIssueRouting(['ai-auto', 'ai-codex-sol']);
  assert.equal(sol.worker, 'CODEX');
  assert.equal(sol.model, 'sol');
  assert.equal(sol.selection, 'MANUAL');
  const gem = resolveIssueRouting(['ai-auto', 'ai-gemini-pro-high']);
  assert.equal(gem.worker, 'GEMINI');
  assert.equal(gem.model, 'pro-high');
});

test('conflicting routing or model labels error', () => {
  assert.throws(() => resolveIssueRouting(['ai-team', 'ai-codex']), RoutingConflictError);
  assert.throws(() => resolveIssueRouting(['ai-codex-sol', 'ai-codex-luna']), RoutingConflictError);
  assert.throws(() => resolveIssueRouting(['ai-team', 'ai-codex-sol']), RoutingConflictError);
});

test('status labels do not leave contradictory status names', () => {
  const next = reconcileStatusLabels(['ai-auto', 'ai-working', 'ai-test-failed'], 'ai-fixing');
  assert.ok(next.includes(TRIGGER_LABEL));
  assert.ok(next.includes('ai-fixing'));
  assert.ok(!next.includes('ai-working'));
  assert.ok(!next.includes('ai-test-failed'));
});
