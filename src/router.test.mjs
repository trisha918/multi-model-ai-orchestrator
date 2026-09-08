import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, resolveRoute } from './router.mjs';

test('explicit modes map to route labels including agy -> GEMINI', () => {
  assert.equal(resolveRoute('anything', 'cursor').route, 'CURSOR');
  assert.equal(resolveRoute('anything', 'codex').route, 'CODEX');
  assert.equal(resolveRoute('anything', 'gemini').route, 'GEMINI');
  assert.equal(resolveRoute('anything', 'agy').route, 'GEMINI');
  assert.equal(resolveRoute('anything', 'team').route, 'TEAM');
  assert.equal(resolveRoute('anything', 'auto').route, classifyTask('anything').route);
});

test('CURSOR for UI / CSS / frontend', () => {
  assert.equal(classifyTask('Tweak the CSS layout of the settings page').route, 'CURSOR');
  assert.equal(classifyTask('Make this React form responsive').route, 'CURSOR');
});

test('CODEX for focused coding and tests', () => {
  assert.equal(classifyTask('Fix the login bug and add unit tests').route, 'CODEX');
  assert.equal(classifyTask('Implement backend validation for registration').route, 'CODEX');
});

test('GEMINI for analysis and review', () => {
  assert.equal(classifyTask('Analyze the repository architecture').route, 'GEMINI');
  assert.equal(classifyTask('Security review of the auth module without changing files').route, 'GEMINI');
});

test('TEAM for architecture / auth / high-risk', () => {
  assert.equal(classifyTask('Refactor authentication and authorization across modules').route, 'TEAM');
  assert.equal(classifyTask('Redesign the architecture and implement the migration').route, 'TEAM');
});

test('auto examples for each public route', () => {
  assert.equal(classifyTask('Tweak CSS on the dashboard page').route, 'CURSOR');
  assert.equal(classifyTask('Add modulo support and tests').route, 'CODEX');
  assert.equal(classifyTask('Investigate how the routing layer works').route, 'GEMINI');
  assert.equal(classifyTask('Refactor authentication and add comprehensive tests').route, 'TEAM');
});

test('returns structured fields including deterministic confidence', () => {
  const r = classifyTask('Refactor authentication and add comprehensive tests');
  assert.equal(r.route, 'TEAM');
  assert.ok(r.reason.length > 0);
  assert.ok(['low', 'medium', 'high'].includes(r.risk));
  assert.ok(r.complexity >= 1 && r.complexity <= 10);
  assert.equal(typeof r.confidence, 'number');
  assert.ok(r.confidence >= 0.4 && r.confidence <= 1);
  assert.equal(classifyTask('Refactor authentication and add comprehensive tests').confidence, r.confidence);
});

test('explicit route override bypasses auto classification with confidence 1', () => {
  assert.equal(resolveRoute('Tweak CSS on the dashboard page', 'codex').route, 'CODEX');
  assert.equal(resolveRoute('Tweak CSS on the dashboard page', 'codex').confidence, 1);
  assert.equal(resolveRoute('anything', 'team').route, 'TEAM');
});
