import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeRegistry, emptyRegistry, ModelSelectionError } from './model-registry.mjs';
import { parseAgyModelsOutput, parseCodexModelsCache, parseCursorModelsOutput } from './model-discovery.mjs';
import { resolveRunModels, pickRequestedModel } from './model-select.mjs';
import { parseTaskArgs } from './orchestrator.mjs';

function registry() {
  const r = emptyRegistry();
  r.providers.gemini = {
    status: 'ok', source: 'agy models', lastChecked: 't',
    models: parseAgyModelsOutput(`gemini-3.8-flash-high\tH
gemini-3.8-flash-medium\tM
gemini-3.8-flash-low\tL
gemini-3.1-pro-high\tP
`),
  };
  r.providers.codex = {
    status: 'ok', source: 'cache', lastChecked: 't',
    models: parseCodexModelsCache({
      models: [
        { slug: 'gpt-6-astra', visibility: 'list' },
        { slug: 'gpt-5.6-sol', visibility: 'list' },
        { slug: 'gpt-5.6-terra', visibility: 'list' },
        { slug: 'gpt-5.6-luna', visibility: 'list' },
      ],
    }),
  };
  r.providers.cursor = {
    status: 'ok', source: 'list', lastChecked: 't',
    models: parseCursorModelsOutput('auto - Auto\ncomposer-2.5 - Composer 2.5\n'),
  };
  return finalizeRegistry(r);
}

test('explicit alias always overrides auto', () => {
  const r = registry();
  const args = parseTaskArgs(['--mode', 'codex', '--model', 'sol', '--task', 'Fix a simple typo']);
  args.provided.model = true;
  const resolved = resolveRunModels({ task: 'Rename a simple comment', route: 'CODEX', args, config: {}, registry: r });
  assert.equal(resolved.worker.manual, true);
  assert.equal(resolved.worker.model, 'gpt-5.6-sol');
  assert.equal(resolved.worker.requestedAlias, 'sol');
});

test('explicit unavailable alias fails without silent fallback', () => {
  const r = registry();
  const args = parseTaskArgs(['--mode', 'codex', '--model', 'not-real', '--task', 'x']);
  assert.throws(
    () => resolveRunModels({ task: 'x', route: 'CODEX', args, config: {}, registry: r }),
    (e) => e instanceof ModelSelectionError && /REQUESTED MODEL UNAVAILABLE/.test(e.message),
  );
});

test('auto unavailable preferred tier falls back deterministically', () => {
  const r = emptyRegistry();
  r.providers.codex = {
    status: 'ok', source: 'x', lastChecked: 't',
    models: parseCodexModelsCache({
      models: [
        { slug: 'gpt-5.6-terra', visibility: 'list' },
        { slug: 'gpt-5.6-luna', visibility: 'list' },
      ],
    }),
  };
  r.providers.gemini = { status: 'ok', source: 'x', lastChecked: 't', models: parseAgyModelsOutput('gemini-3.8-flash-low\tL\n') };
  r.providers.cursor = { status: 'ok', source: 'x', lastChecked: 't', models: parseCursorModelsOutput('auto - Auto\n') };
  const fin = finalizeRegistry(r);
  const args = parseTaskArgs(['--mode', 'codex', '--task', 'Critical security review of the architecture']);
  const resolved = resolveRunModels({
    task: 'Critical security review of the architecture',
    route: 'CODEX',
    args,
    config: {},
    registry: fin,
  });
  assert.equal(resolved.worker.manual, false);
  assert.equal(resolved.worker.fallback, true);
  assert.equal(resolved.worker.preferred, 'max');
  assert.ok(['strong', 'balanced', 'fast'].includes(resolved.worker.profile));
});

test('CLI --model and --model-id ambiguity', () => {
  const args = parseTaskArgs(['--model', 'sol', '--model-id', 'gpt-5.6-sol', '--mode', 'codex', '--task', 'x']);
  const r = registry();
  assert.throws(
    () => resolveRunModels({ task: 'x', route: 'CODEX', args, config: {}, registry: r }),
    /Ambiguous model selection/,
  );
});

test('CLI --model-id selects exact verified id', () => {
  const r = registry();
  const args = parseTaskArgs(['--mode', 'gemini', '--model-id', 'gemini-3.8-flash-low', '--task', 'Analyze this']);
  const resolved = resolveRunModels({ task: 'Analyze this', route: 'GEMINI', args, config: {}, registry: r });
  assert.equal(resolved.worker.model, 'gemini-3.8-flash-low');
  assert.equal(resolved.worker.manual, true);
});

test('TEAM per-stage models and overrides', () => {
  const r = registry();
  const auto = resolveRunModels({
    task: 'Fix a simple typo in docs',
    route: 'TEAM',
    args: parseTaskArgs(['--mode', 'team', '--task', 'Fix a simple typo in docs']),
    config: {},
    registry: r,
  });
  assert.equal(auto.stages.plan.provider, 'cursor');
  assert.equal(auto.stages.implementation.provider, 'codex');
  assert.equal(auto.stages.review.provider, 'gemini');
  assert.ok(auto.stages.implementation.model);

  const args = parseTaskArgs([
    '--mode', 'team',
    '--codex-model', 'sol',
    '--gemini-model', 'pro-high',
    '--task', 'x',
  ]);
  const overridden = resolveRunModels({ task: 'x', route: 'TEAM', args, config: {}, registry: r });
  assert.equal(overridden.stages.implementation.manual, true);
  assert.equal(overridden.stages.implementation.model, 'gpt-5.6-sol');
  assert.equal(overridden.stages.review.model, 'gemini-3.1-pro-high');
});

test('parseTaskArgs captures model flags without interpolating into a shell string', () => {
  const args = parseTaskArgs(['--model', 'sol', '--codex-model', 'luna', '--gemini-model', 'flash-high']);
  assert.equal(args.model, 'sol');
  assert.equal(args.codexModel, 'luna');
  assert.equal(args.geminiModel, 'flash-high');
});
