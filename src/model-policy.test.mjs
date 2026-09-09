import test from 'node:test';
import assert from 'node:assert/strict';
import { desiredProfile, teamStageProfiles } from './model-policy.mjs';
import { classifyTask } from './router.mjs';

test('simple Codex task maps to fast capability', () => {
  assert.equal(desiredProfile('Rename the helper and add a simple comment'), 'fast');
});

test('normal coding maps to balanced', () => {
  assert.equal(desiredProfile('Fix the login bug and add unit tests'), 'balanced');
});

test('hard debugging maps to strong', () => {
  assert.equal(desiredProfile('Debug this race condition in the worker'), 'strong');
});

test('critical or high-risk maps to max', () => {
  assert.equal(desiredProfile('Critical security review of the authentication architecture'), 'max');
});

test('Gemini simple analysis vs architecture review', () => {
  assert.equal(desiredProfile('Simple analysis of this function'), 'fast');
  const arch = desiredProfile('Analyze the repository architecture');
  assert.ok(arch === 'strong' || arch === 'max');
  assert.equal(desiredProfile('Security review of the auth module without changing files'), 'max');
});

test('TEAM stage profiles scale with task risk instead of always using max', () => {
  const low = teamStageProfiles('Rename a typo in the README');
  assert.equal(low.implementation, 'fast');
  assert.equal(low.review, 'balanced');
  const high = teamStageProfiles('Refactor authentication and authorization across modules');
  assert.ok(['strong', 'max'].includes(high.implementation));
  assert.equal(classifyTask('Rename a typo in the README').route, 'CURSOR');
});
