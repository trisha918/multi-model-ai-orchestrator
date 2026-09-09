import test from 'node:test';
import assert from 'node:assert/strict';
import { teamLoopShouldStartFix } from './team-loop.mjs';

test('TEAM fix loop continues on NEEDS_FIXES or test FAIL until max rounds', () => {
  assert.equal(teamLoopShouldStartFix({
    testsStatus: 'PASS', decision: 'NEEDS_FIXES', round: 0, maxFixRounds: 2,
  }), true);
  assert.equal(teamLoopShouldStartFix({
    testsStatus: 'FAIL', decision: 'TESTS_FAIL', round: 0, maxFixRounds: 2,
  }), true);
  assert.equal(teamLoopShouldStartFix({
    testsStatus: 'TIMEOUT', decision: 'TESTS_FAIL', round: 1, maxFixRounds: 2,
  }), true);
  assert.equal(teamLoopShouldStartFix({
    testsStatus: 'PASS', decision: 'PASS', round: 0, maxFixRounds: 2,
  }), false);
  assert.equal(teamLoopShouldStartFix({
    testsStatus: 'PASS', decision: 'NEEDS_FIXES', round: 2, maxFixRounds: 2,
  }), false);
});

test('TEAM fix then re-review contract: first NEEDS_FIXES then PASS stops', () => {
  const maxFixRounds = 2;
  let round = 0;
  let decision = 'NEEDS_FIXES';
  let testsStatus = 'PASS';
  const steps = [];
  while (teamLoopShouldStartFix({ testsStatus, decision, round, maxFixRounds })) {
    round += 1;
    steps.push(`codex-fix-${round}`);
    testsStatus = 'PASS';
    steps.push(`tests-${round}`);
    decision = round === 1 ? 'PASS' : decision;
    steps.push(`gemini-review-${round}`);
  }
  assert.deepEqual(steps, ['codex-fix-1', 'tests-1', 'gemini-review-1']);
  assert.equal(decision, 'PASS');
  assert.equal(round, 1);
});
