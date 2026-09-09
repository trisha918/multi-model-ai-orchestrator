import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyModelsOutput, parseCursorModelsOutput, parseCodexModelsCache, discoverAll } from './model-discovery.mjs';

const LOCAL_AGY = `Fetching available models...
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-low	Gemini 3.8 Flash (Low)
gemini-3.1-pro-high	Gemini 3.1 Pro (High)
`;

test('parse Gemini agy models fixture and local-shaped output', () => {
  const models = parseAgyModelsOutput(LOCAL_AGY);
  assert.ok(models.every(m => m.available === true));
  assert.ok(models.some(m => m.id === 'gemini-3.8-flash-high'));
  assert.ok(!models.some(m => m.id.includes('invented')));
  const dup = parseAgyModelsOutput(`${LOCAL_AGY}\ngemini-3.8-flash-high\tagain\n`);
  assert.equal(dup.filter(m => m.id === 'gemini-3.8-flash-high').length, 1);
});

test('cursor and codex discovery parsers ignore junk lines', () => {
  assert.equal(parseCursorModelsOutput('not a model line\n').filter(m => m.id !== 'auto').length, 0);
  const cache = parseCodexModelsCache({ models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] });
  assert.equal(cache[0].id, 'gpt-5.6-sol');
});

test('discoverAll uses injected runners and does not require internet', async () => {
  const registry = await discoverAll({
    env: { CODEX_HOME: 'C:\\missing-codex-home-for-test' },
    runners: {
      gemini: async () => ({ exitCode: 0, stdout: LOCAL_AGY, stderr: '' }),
      cursor: async () => ({ exitCode: 0, stdout: 'auto - Auto\ncomposer-2.5 - Composer 2.5\n', stderr: '' }),
    },
  });
  assert.equal(registry.providers.gemini.status, 'ok');
  assert.ok(registry.providers.gemini.models.some(m => m.id === 'gemini-3.8-flash-high'));
  assert.ok(registry.providers.cursor.models.some(m => m.id === 'auto'));
});
