import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseSimpleYaml,
  parseRepoConfigText,
  validateRepoConfig,
  isIssueAutomationActive,
  loadRepoConfigFile,
  DEFAULT_REPO_AUTOMATION,
  RepoConfigError,
} from './github-config.mjs';

const VALID = `
automation:
  enabled: true
  mode: assisted
  trigger_label: ai-auto
  max_fix_attempts: 5
  allowed_actors:
    - maintainer
pull_request:
  create: true
  auto_merge: false
tests:
  required: true
review:
  required: true
publish:
  enabled: false
`;

test('YAML config validation accepts assisted config', () => {
  const c = parseRepoConfigText(VALID);
  assert.equal(c.automation.enabled, true);
  assert.equal(c.automation.mode, 'assisted');
  assert.equal(c.automation.max_fix_attempts, 5);
  assert.deepEqual(c.automation.allowed_actors, ['maintainer']);
  assert.equal(isIssueAutomationActive(c), true);
});

test('missing config defaults to disabled manual and does not enable automation', () => {
  const c = validateRepoConfig({});
  assert.equal(c.automation.enabled, false);
  assert.equal(c.automation.mode, 'manual');
  assert.equal(isIssueAutomationActive(c), false);
  assert.equal(isIssueAutomationActive(DEFAULT_REPO_AUTOMATION), false);
});

test('manual mode is not issue-automation even if someone expects it', () => {
  const c = parseRepoConfigText(`
automation:
  enabled: false
  mode: manual
`);
  assert.equal(isIssueAutomationActive(c), false);
});

test('automation enabled with manual mode fails safely', () => {
  assert.throws(() => parseRepoConfigText(`
automation:
  enabled: true
  mode: manual
`), RepoConfigError);
});

test('auto_merge true is rejected and does not silently enable merge', () => {
  assert.throws(() => parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
pull_request:
  auto_merge: true
`), /auto_merge is not supported/);
});

test('publish enabled is rejected', () => {
  assert.throws(() => parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
publish:
  enabled: true
`), /publish.enabled is not supported/);
});

test('unknown section and bad YAML fail closed', () => {
  assert.throws(() => parseRepoConfigText('deploy:\n  hack: true\n'), /Unknown config section/);
  assert.throws(() => parseSimpleYaml('foo: &alias\n'), /Unsupported/);
  assert.throws(() => parseRepoConfigText('automation: true\n'), /automation must be a mapping/);
});

test('autonomous is recognized but merge stays false', () => {
  const c = parseRepoConfigText(`
automation:
  enabled: true
  mode: autonomous
`);
  assert.equal(c.automation.mode, 'autonomous');
  assert.equal(c.pull_request.auto_merge, false);
  assert.equal(c.publish.enabled, false);
  assert.equal(isIssueAutomationActive(c), true);
});

test('missing file load stays disabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-yml-'));
  try {
    const loaded = await loadRepoConfigFile(async () => {
      const err = new Error('missing');
      err.code = 'ENOENT';
      throw err;
    }, path.join(dir, '.github', 'ai-orchestrator.yml'));
    assert.equal(loaded.ok, true);
    assert.equal(loaded.missing, true);
    assert.equal(loaded.config.automation.enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid file load does not enable automation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-yml-'));
  const file = path.join(dir, 'ai-orchestrator.yml');
  await writeFile(file, 'automation: { enabled: true, mode: nope }\n', 'utf8');
  const loaded = await loadRepoConfigFile(async (p) => (await import('node:fs/promises')).readFile(p, 'utf8'), file);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.config.automation.enabled, false);
  await rm(dir, { recursive: true, force: true });
});

test('max_fix_attempts out of range fails', () => {
  assert.throws(() => parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
  max_fix_attempts: 6
`), /between 1 and 5/);
});
