import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, readModelsCache, writeModelsCache, cacheIsFresh, sanitizeCache } from './model-cache.mjs';
import { emptyRegistry, finalizeRegistry } from './model-registry.mjs';
import { parseAgyModelsOutput } from './model-discovery.mjs';

test('models cache write/read/refresh and TTL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai orch models-'));
  const env = { ...process.env, AI_ORCHESTRATOR_CONFIG_DIR: dir };
  try {
    const registry = emptyRegistry('2026-01-01T00:00:00.000Z');
    registry.providers.gemini = {
      status: 'ok',
      source: 'agy models',
      lastChecked: '2026-01-01T00:00:00.000Z',
      models: parseAgyModelsOutput('gemini-3.8-flash-high\tFlash High\n'),
    };
    const file = await writeModelsCache(finalizeRegistry(registry), env);
    assert.match(file, /models-cache\.json/);
    const cached = await readModelsCache(env);
    assert.equal(cached.providers.gemini.models[0].id, 'gemini-3.8-flash-high');
    assert.equal(cacheIsFresh(cached, { now: Date.parse('2026-01-01T01:00:00.000Z') }), true);
    assert.equal(cacheIsFresh(cached, { now: Date.parse('2026-01-02T00:00:00.000Z'), ttlMs: 1000 }), false);

    const refreshed = await loadRegistry({
      env,
      refresh: true,
      runners: {
        gemini: async () => ({ exitCode: 0, stdout: 'gemini-3.1-pro-high\tPro High\n', stderr: '' }),
        cursor: async () => ({ exitCode: 0, stdout: 'auto - Auto\n', stderr: '' }),
      },
      now: '2026-02-01T00:00:00.000Z',
    });
    assert.equal(refreshed.fromCache, false);
    assert.ok(refreshed.registry.providers.gemini.models.some(m => m.id === 'gemini-3.1-pro-high'));
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(!JSON.stringify(raw).includes('sk-'));
    assert.ok(!JSON.stringify(raw).includes('token'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sanitizeCache drops unknown fields', () => {
  const clean = sanitizeCache({
    lastChecked: 't',
    secret: 'nope',
    providers: { gemini: { status: 'ok', models: [{ id: 'gemini-x', extra: 'drop' }] } },
  });
  assert.equal(clean.secret, undefined);
  assert.equal(clean.providers.gemini.models[0].extra, undefined);
});
