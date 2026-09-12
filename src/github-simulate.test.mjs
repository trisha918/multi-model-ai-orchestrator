import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGithubCli, cmdGithub } from './github-cli.mjs';
import { runGithubLifecycleSimulator, normalizeCiSequence, resolveSimulateConfig } from './github-simulate.mjs';
import { isAllowedTransition } from './github-state.mjs';
import { packageRoot } from './paths.mjs';

const fixturesDir = path.join(packageRoot(), 'tests', 'fixtures', 'github-simulate');

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(fixturesDir, name), 'utf8'));
}

function assertNoMerge(result) {
  assert.equal(result.state.pullRequestAutoMerged, false);
  assert.equal(result.state.published, false);
  assert.notEqual(result.state.stage, 'DONE');
}

test('fixture schema defaults to assisted config and CI PASS', () => {
  const config = resolveSimulateConfig({
    automation: { enabled: true, mode: 'assisted' },
    review: { required: false },
  });
  assert.equal(config.automation.mode, 'assisted');
  assert.equal(config.pull_request.auto_merge, false);
  assert.deepEqual(normalizeCiSequence({}), ['PASS']);
  assert.deepEqual(normalizeCiSequence({ ciSequence: ['FAIL', 'PASS'] }), ['FAIL', 'PASS']);
});

test('scenario new-issue reaches READY_FOR_HUMAN_MERGE once', async () => {
  const result = await runGithubLifecycleSimulator(await loadFixture('new-issue.json'));
  assert.equal(result.ok, true);
  assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(result.counts.implement, 1);
  assert.equal(result.counts.push, 1);
  assert.equal(result.counts.createPR, 1);
  assert.equal(Boolean(result.state.prNumber), true);
  assert.ok(isAllowedTransition('WAITING_FOR_CI', 'READY_FOR_HUMAN_MERGE'));
  assertNoMerge(result);
});

test('scenario crash-during-push reconciles on resume without a second push or implement', async () => {
  const result = await runGithubLifecycleSimulator(await loadFixture('crash-during-push.json'));
  assert.equal(result.runs[0].crashed, true);
  assert.equal(result.runs[0].state.unsafePushPending, true);
  assert.equal(result.runs[1].crashed, false);
  assert.equal(result.state.unsafePushPending, false);
  assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(result.counts.implement, 1);
  assert.equal(result.counts.push, 1);
  assert.equal(result.counts.createPR, 1);
  assert.ok(isAllowedTransition('HUMAN_REVIEW_REQUIRED', 'WAITING_FOR_CI'));
  assert.ok(isAllowedTransition('LOCAL_TESTS', 'WAITING_FOR_CI'));
  assertNoMerge(result);
});

test('scenario ci-failure runs one AI fix round then reaches READY_FOR_HUMAN_MERGE', async () => {
  const result = await runGithubLifecycleSimulator(await loadFixture('ci-failure.json'));
  assert.equal(result.ok, true);
  assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(result.state.attempt, 2);
  assert.equal(result.counts.implement, 2);
  assert.equal(result.actions.filter(a => a.type === 'implement' && a.fix).length, 1);
  assert.equal(result.counts.push, 2);
  assert.equal(result.counts.createPR, 1);
  assert.ok(isAllowedTransition('WAITING_FOR_CI', 'FIXING'));
  assert.ok(isAllowedTransition('FIXING', 'WAITING_FOR_CI'));
  assertNoMerge(result);
});

test('scenario existing-pr resumes without implementation, push, or a second PR', async () => {
  const result = await runGithubLifecycleSimulator(await loadFixture('existing-pr.json'));
  assert.equal(result.state.stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(result.state.prNumber, 44);
  assert.equal(result.counts.implement, 0);
  assert.equal(result.counts.push, 0);
  assert.equal(result.counts.createPR, 0);
  assertNoMerge(result);
});

test('scenario duplicate-execution is idempotent', async () => {
  const result = await runGithubLifecycleSimulator(await loadFixture('duplicate-execution.json'));
  assert.equal(result.runs[0].stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(result.runs[1].skipped, true);
  assert.equal(result.runs[1].decision.action, 'already-complete');
  assert.equal(result.runs[1].stage, 'READY_FOR_HUMAN_MERGE');
  assert.equal(result.counts.implement, 1);
  assert.equal(result.counts.push, 1);
  assert.equal(result.counts.createPR, 1);
  assert.ok(isAllowedTransition('READY_FOR_HUMAN_MERGE', 'IMPLEMENTING') === false);
  assertNoMerge(result);
});

test('github simulate CLI runs a lifecycle fixture without network', async () => {
  const file = path.join(fixturesDir, 'new-issue.json');
  const logs = [];
  const code = await cmdGithub(parseGithubCli(['simulate', '--fixture', file]), {
    stdout: s => logs.push(s),
    stderr: s => logs.push(s),
  });
  assert.equal(code, 0);
  const blob = logs.join('\n');
  assert.match(blob, /READY_FOR_HUMAN_MERGE/);
  assert.match(blob, /"implement": 1/);
  assert.match(blob, /"createPR": 1/);
  assert.doesNotMatch(blob, /AUTO_MERGED|published": true/);
});

test('this module is loaded from the repo src tree', () => {
  assert.match(fileURLToPath(import.meta.url), /github-simulate\.test\.mjs$/);
});
