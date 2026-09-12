import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { runtimeDirs } from './paths.mjs';
import { readJson, atomicJson, appendEvent, safeId } from './local-store.mjs';

export function resultPath(id, env = process.env) {
  return path.join(runtimeDirs(env).runs, safeId(id), 'result.json');
}

export function runResult(data = {}) {
  const statuses = new Set(['PASS', 'FAIL', 'SKIP', 'TIMEOUT', 'UNKNOWN', 'NEEDS_FIXES']);
  return {
    version: 1, runId: data.runId, status: data.status || (data.ok ? 'COMPLETED' : 'FAILED'),
    ok: data.ok === true, exitCode: data.exitCode ?? (data.ok ? 0 : 1),
    repository: data.repository || '', sourceHead: data.sourceHead || '',
    route: data.route || '', classification: data.classification || null, models: data.models || null,
    tests: statuses.has(data.tests) ? data.tests : 'UNKNOWN',
    review: statuses.has(data.review) ? data.review : 'UNKNOWN',
    implementation: statuses.has(data.implementation) ? data.implementation : 'UNKNOWN',
    branch: data.branch || '', commit: /^[a-f0-9]{40,64}$/i.test(data.commit || '') ? data.commit : '',
    worktree: data.worktree || '', worktreeState: data.worktreeState || '',
    startedAt: data.startedAt || new Date().toISOString(), finishedAt: data.finishedAt || null,
    durationMs: data.durationMs ?? null, processCalls: data.processCalls ?? 0,
    costUsd: null, costStatus: 'unavailable', failedStage: data.failedStage || '',
    error: data.error || '', runLog: data.runLog || '',
  };
}

export async function saveRunResult(result, env = process.env) {
  const file = resultPath(result.runId, env);
  await atomicJson(file, result);
  await appendEvent(path.join(path.dirname(file), 'events.jsonl'), 'run.result', { result });
}

export async function listRuns(env = process.env) {
  let entries;
  try { entries = await readdir(runtimeDirs(env).runs, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const result = await readJson(resultPath(entry.name, env));
    if (result) results.push(result);
  }
  return results.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
