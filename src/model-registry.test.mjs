import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeminiId,
  compareVersionParts,
  resolveAlias,
  resolveProfile,
  finalizeRegistry,
  emptyRegistry,
  formatModelsReport,
  formatUnavailableManual,
  assertSafeModelValue,
  ModelSelectionError,
} from './model-registry.mjs';
import { parseAgyModelsOutput, parseCursorModelsOutput, parseCodexModelsCache, parseCodexConfigToml } from './model-discovery.mjs';

function geminiRegistry() {
  const models = parseAgyModelsOutput(`gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude
`);
  const registry = emptyRegistry();
  registry.providers.gemini = { status: 'ok', source: 'agy models', lastChecked: 't', models };
  return finalizeRegistry(registry);
}

function codexRegistry() {
  const models = parseCodexModelsCache({
    models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list' },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
    ],
  });
  const registry = emptyRegistry();
  registry.providers.codex = { status: 'ok', source: 'cache', lastChecked: 't', models };
  return finalizeRegistry(registry);
}

test('gemini alias maps to newest available family without hard-coding version', () => {
  const r = geminiRegistry();
  assert.equal(resolveAlias(r, 'gemini', 'flash-high').id, 'gemini-3.8-flash-high');
  assert.equal(resolveAlias(r, 'gemini', 'pro-high').id, 'gemini-3.1-pro-high');
  assert.equal(parseGeminiId('gemini-3.8-flash-high').variantAlias, 'flash-high');
  assert.ok(compareVersionParts('3.8', '3.7') > 0);
});

test('duplicate aliases keep a deterministic newest winner', () => {
  const r = geminiRegistry();
  const high = r.providers.gemini.models.filter(m => m.aliases.includes('flash-high'));
  assert.ok(high.length >= 2);
  assert.equal(resolveAlias(r, 'gemini', 'flash-high').id, 'gemini-3.8-flash-high');
});

test('unknown model and unsafe tokens are rejected', () => {
  const r = geminiRegistry();
  assert.equal(resolveAlias(r, 'gemini', 'not-a-model'), null);
  assert.throws(() => assertSafeModelValue('foo & bar'), ModelSelectionError);
  assert.throws(() => assertSafeModelValue('a|b'));
});

test('codex family aliases resolve to verified slugs', () => {
  const r = codexRegistry();
  assert.equal(resolveAlias(r, 'codex', 'sol').id, 'gpt-5.6-sol');
  assert.equal(resolveAlias(r, 'codex', 'terra').id, 'gpt-5.6-terra');
  assert.equal(resolveAlias(r, 'codex', 'luna').id, 'gpt-5.6-luna');
  assert.equal(resolveAlias(r, 'codex', 'astra').id, 'gpt-6-astra');
  assert.equal(resolveProfile(r, 'codex', 'fast').model.id, 'gpt-5.6-luna');
  assert.equal(resolveProfile(r, 'codex', 'balanced').model.id, 'gpt-5.6-terra');
  assert.equal(resolveProfile(r, 'codex', 'strong').model.id, 'gpt-5.6-sol');
  assert.equal(resolveProfile(r, 'codex', 'max').model.id, 'gpt-6-astra');
});

test('hidden codex models are not available yes', () => {
  const r = codexRegistry();
  const reserve = r.providers.codex.models.find(m => m.id === 'gpt-reserve');
  assert.notEqual(reserve.available, true);
});

test('auto profile fallback is deterministic', () => {
  const registry = emptyRegistry();
  registry.providers.codex = {
    status: 'ok',
    source: 'x',
    lastChecked: 't',
    models: parseCodexModelsCache({
      models: [
        { slug: 'gpt-5.6-terra', display_name: 'Terra', visibility: 'list' },
        { slug: 'gpt-5.6-luna', display_name: 'Luna', visibility: 'list' },
      ],
    }),
  };
  const r = finalizeRegistry(registry);
  const max = resolveProfile(r, 'codex', 'max');
  assert.equal(max.fallback, true);
  assert.equal(max.preferred, 'max');
  assert.equal(max.model.id, 'gpt-5.6-terra');
});

test('models report does not fabricate availability', () => {
  const r = geminiRegistry();
  const text = formatModelsReport(r);
  assert.match(text, /MULTI-MODEL AI ORCHESTRATOR — MODELS/);
  assert.match(text, /flash-high/);
  assert.match(text, /gemini-3.8-flash-high/);
  assert.match(text, /YES/);
  assert.doesNotMatch(text, /flash-high\s+gemini-9/);
  const fail = formatUnavailableManual({ provider: 'codex', requested: 'sol', registry: geminiRegistry() });
  assert.match(fail, /REQUESTED MODEL UNAVAILABLE/);
});

test('cursor parser includes auto and listed ids', () => {
  const models = parseCursorModelsOutput(`Available models\nauto - Auto (current, default)\ncomposer-2.5 - Composer 2.5\nTip: use --model\n`);
  assert.equal(models[0].id, 'auto');
  assert.equal(models[0].available, true);
  assert.ok(models.some(m => m.id === 'composer-2.5'));
});

test('codex config.toml model is parsed', () => {
  assert.equal(parseCodexConfigToml('model = "gpt-5.6-terra"\n'), 'gpt-5.6-terra');
});
