import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from './paths.mjs';
import { parseRepoConfigText, isIssueAutomationActive } from './github-config.mjs';
import { LABEL_DEFINITIONS, REQUIRED_LIVE_LABELS } from './github-labels.mjs';

const example = path.join(packageRoot(), 'examples', 'github-e2e-test');
const require = createRequire(import.meta.url);
const calc = require(path.join(example, 'calculator.js'));

test('example calculator tests pass', () => {
  assert.equal(calc.add(2, 3), 5);
  assert.equal(calc.add(-1, 1), 0);
  assert.equal(calc.subtract(5, 2), 3);
  assert.equal(calc.subtract(0, 4), -4);
  assert.equal(typeof calc.multiply, 'undefined');
});

test('example automation YAML is assisted and never auto-merges', () => {
  const raw = readFileSync(path.join(example, '.github', 'ai-orchestrator.yml'), 'utf8');
  const c = parseRepoConfigText(raw);
  assert.equal(isIssueAutomationActive(c), true);
  assert.equal(c.automation.mode, 'assisted');
  assert.equal(c.pull_request.auto_merge, false);
  assert.equal(c.publish.enabled, false);
  assert.equal(c.automation.max_fix_attempts, 5);
});

test('label setup catalog includes required live-test labels', () => {
  const names = LABEL_DEFINITIONS.map(d => d.name);
  for (const n of REQUIRED_LIVE_LABELS) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(names.includes('ai-codex-sol'));
  assert.ok(names.includes('ai-team'));
});
