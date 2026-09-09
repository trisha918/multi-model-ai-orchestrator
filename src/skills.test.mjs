import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  skillMarkdown,
  classifySkillContent,
  skillContainsClonePath,
  skillUsesGlobalCli,
  installSkills,
  uninstallSkills,
  skillStatus,
  skillsToInstall,
} from './skills.mjs';
import { finalizeRegistry, emptyRegistry } from './model-registry.mjs';
import { parseCodexModelsCache, parseAgyModelsOutput } from './model-discovery.mjs';
import { packageRoot } from './paths.mjs';

test('generated skill contains no clone-specific absolute path and calls global CLI', () => {
  const ai = skillMarkdown({
    name: 'ai',
    mode: 'auto',
    description: 'test',
  });
  const team = skillMarkdown({
    name: 'ai-team',
    mode: 'team',
    description: 'test',
  });
  for (const text of [ai, team]) {
    assert.match(text, /\bai-orchestrator\b/);
    assert.match(text, /--mode/);
    assert.match(text, /--task-file/);
    assert.match(text, /UTF8Encoding/);
    assert.match(text, /WriteAllText/);
    assert.doesNotMatch(text, /run-task\.ps1/);
    assert.doesNotMatch(text, /'--task',\$task/);
    assert.equal(skillContainsClonePath(text), false);
    assert.ok(!text.includes(packageRoot()));
    assert.ok(!text.toLowerCase().includes('f:\\3sha'));
    assert.match(text, /owned-by: multi-model-ai-orchestrator/);
  }
  assert.match(ai, /--mode','auto'/);
  assert.match(team, /--mode','team'/);
});

test('/ai and /ai-team call global CLI with expected modes', () => {
  const ai = skillMarkdown({ name: 'ai', mode: 'auto', description: 'd' });
  const team = skillMarkdown({ name: 'ai-team', mode: 'team', description: 'd' });
  assert.match(ai, /ai-orchestrator @\('run'/);
  assert.match(team, /ai-orchestrator @\('run'/);
  assert.match(ai, /'--mode','auto'/);
  assert.match(team, /'--mode','team'/);
  assert.match(ai, /'--task-file',\$taskFile/);
  assert.match(team, /'--task-file',\$taskFile/);
});

test('install skills is idempotent and skips foreign skills', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai orch home-'));
  const env = { USERPROFILE: home, HOME: home };
  try {
    const first = await installSkills({ env });
    assert.equal(first.every(r => r.status === 'installed'), true);
    const second = await installSkills({ env });
    assert.equal(second.every(r => r.status === 'installed'), true);
    const status = skillStatus(env);
    assert.equal(status.every(s => s.ok), true);

    const foreignDir = path.join(home, '.cursor', 'skills', 'ai');
    await writeFile(path.join(foreignDir, 'SKILL.md'), '# some other skill\nDo something else.\n', 'utf8');
    const skipped = await installSkills({ env });
    const ai = skipped.find(r => r.name === 'ai');
    assert.equal(ai.status, 'skipped-foreign');
    const kept = await readFile(path.join(foreignDir, 'SKILL.md'), 'utf8');
    assert.match(kept, /some other skill/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('uninstall skills removes owned skills only', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai orch un-'));
  const env = { USERPROFILE: home, HOME: home };
  try {
    await installSkills({ env });
    const removed = await uninstallSkills({ env });
    assert.equal(removed.every(r => r.status === 'removed'), true);
    assert.equal(existsSync(path.join(home, '.cursor', 'skills', 'ai', 'SKILL.md')), false);

    await mkdir(path.join(home, '.cursor', 'skills', 'ai'), { recursive: true });
    await writeFile(path.join(home, '.cursor', 'skills', 'ai', 'SKILL.md'), 'foreign skill\n', 'utf8');
    const skip = await uninstallSkills({ env });
    assert.equal(skip.find(r => r.name === 'ai').status, 'skipped-foreign');
    assert.equal(existsSync(path.join(home, '.cursor', 'skills', 'ai', 'SKILL.md')), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('generated alias skills only when registry can resolve them', () => {
  const empty = skillsToInstall(null);
  assert.ok(empty.some(s => s.name === 'ai-codex'));
  assert.ok(empty.some(s => s.name === 'ai-models'));
  assert.ok(!empty.some(s => s.name === 'ai-codex-sol'));
  const r = emptyRegistry();
  r.providers.codex = {
    status: 'ok', source: 'x', lastChecked: 't',
    models: parseCodexModelsCache({ models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] }),
  };
  r.providers.gemini = {
    status: 'ok', source: 'x', lastChecked: 't',
    models: parseAgyModelsOutput('gemini-3.8-flash-high\tH\n'),
  };
  const list = skillsToInstall(finalizeRegistry(r));
  assert.ok(list.some(s => s.name === 'ai-codex-sol'));
  assert.ok(!list.some(s => s.name === 'ai-codex-luna'));
  assert.ok(list.some(s => s.name === 'ai-gemini-flash-high'));
});

test('/ai-codex /ai-gemini /ai-models and profile skills are portable', () => {
  const codex = skillMarkdown({ name: 'ai-codex', mode: 'codex', description: 'd' });
  const gemini = skillMarkdown({ name: 'ai-gemini', mode: 'gemini', description: 'd' });
  const sol = skillMarkdown({ name: 'ai-codex-sol', mode: 'codex', model: 'sol', description: 'd' });
  const models = skillMarkdown({ name: 'ai-models', kind: 'models', description: 'd' });
  for (const text of [codex, gemini, sol]) {
    assert.match(text, /\bai-orchestrator\b/);
    assert.match(text, /--task-file/);
    assert.equal(skillContainsClonePath(text), false);
    assert.ok(!text.includes(packageRoot()));
  }
  assert.match(codex, /'--mode','codex'/);
  assert.match(gemini, /'--mode','gemini'/);
  assert.match(sol, /'--model','sol'/);
  assert.match(models, /ai-orchestrator @\('models'\)/);
  assert.doesNotMatch(models, /--task-file/);
  assert.ok(!models.includes(packageRoot()));
});

test('v0.8 clone-path skills are recognized as ours for upgrade', () => {
  const legacy = `Delegate it to the local multi-model orchestrator.\n& 'C:\\\\clone\\\\scripts\\\\run-task.ps1' -Mode 'auto'\n`;
  assert.equal(classifySkillContent(legacy), 'ours');
  assert.equal(classifySkillContent('totally unrelated'), 'foreign');
});

test('clone folder named ai-orchestrator-mvp-v6 is not treated as the global CLI', () => {
  const v08 = `# ai
Delegate it to the local multi-model orchestrator.
& 'F:\\3sha\\3sha works\\AI\\ai-orchestrator-mvp-v6\\scripts\\run-task.ps1' -Mode 'auto'
`;
  assert.equal(classifySkillContent(v08), 'ours');
  assert.equal(skillUsesGlobalCli(v08), false);
  assert.equal(skillContainsClonePath(v08), true);
  const md = skillMarkdown({ name: 'ai', mode: 'auto', description: 'd' });
  assert.equal(skillUsesGlobalCli(md), true);
  assert.equal(skillContainsClonePath(md), false);
});
