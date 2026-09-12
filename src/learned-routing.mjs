import { classifyTask } from './router.mjs';
import { repositoryKey } from './memory.mjs';

export function routingStats(records, { repo, task } = {}) {
  const classification = task ? classifyTask(task) : null;
  const groups = new Map();
  for (const run of records) {
    if (!['COMPLETED','FAILED'].includes(run.status) || !run.repository || !run.classification || !run.models) continue;
    if (!['PASS','FAIL','TIMEOUT'].includes(run.tests)) continue;
    if (repo && repositoryKey(run.repository) !== repositoryKey(repo)) continue;
    if (classification && (run.classification.risk !== classification.risk || run.classification.route !== classification.route)) continue;
    const key = `${run.route}:${run.models.worker?.model || (run.route === 'TEAM' ? 'team' : 'default')}`;
    const g = groups.get(key) || { route: run.route, model: run.models.worker?.model || '', samples: 0, passed: 0, durationMs: 0 };
    g.samples++;
    g.passed += run.ok && run.tests === 'PASS' ? 1 : 0;
    g.durationMs += run.durationMs || 0;
    groups.set(key, g);
  }
  return [...groups.values()].map(g => ({ ...g, successRate: g.passed/g.samples, meanDurationMs: Math.round(g.durationMs/g.samples) }))
    .sort((a,b) => b.successRate - a.successRate || a.meanDurationMs - b.meanDurationMs);
}

export function recommendRoute(records, { repo, task, minimumSamples = 5 } = {}) {
  const baseline = classifyTask(task);
  // Never turn read-only analysis into writes or downgrade high-risk TEAM work.
  const candidates = routingStats(records, { repo, task }).filter(g => ['CURSOR','CODEX'].includes(g.route) && g.samples >= minimumSamples && g.successRate >= 0.8);
  if (['TEAM','GEMINI'].includes(baseline.route) || !candidates.length) return { route: baseline.route, learned: false, reason: 'Keep heuristic route: protected task class or insufficient verified history', candidates };
  return { route: candidates[0].route, learned: true, reason: `Measured history: ${candidates[0].passed}/${candidates[0].samples} verified successes in this repository/task class`, candidates };
}
