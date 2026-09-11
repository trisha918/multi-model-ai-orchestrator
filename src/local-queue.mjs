import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDirs } from './paths.mjs';
import { atomicJson, jsonRecords, readJson, safeId, withFileLock, appendEvent } from './local-store.mjs';

function queueDir(env) { return path.join(runtimeDirs(env).root, 'queue'); }
function jobPath(id, env) { return path.join(queueDir(env), 'jobs', `${safeId(id)}.json`); }
export async function enqueue(argv, { env = process.env } = {}) {
  if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new Error('Queue requires an argument array');
  const job = { version: 1, id: randomUUID(), status: 'PENDING', argv, createdAt: new Date().toISOString(), runId: null, result: null };
  await atomicJson(jobPath(job.id, env), job);
  return job;
}
export async function listQueue(env = process.env) {
  return (await jsonRecords(path.join(queueDir(env), 'jobs'))).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
async function transition(job, status, env) {
  job = { ...job, status, updatedAt: new Date().toISOString() };
  await atomicJson(jobPath(job.id, env), job);
  await appendEvent(path.join(queueDir(env), 'events.jsonl'), 'job.updated', { id: job.id, status, runId: job.runId });
  return job;
}
export async function drainQueue(execute, { env = process.env, limit = 1 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Queue limit must be an integer from 1 to 100');
  return withFileLock(path.join(queueDir(env), 'worker.lock'), async () => {
    const done = [];
    const pending = (await listQueue(env)).filter(j => j.status === 'PENDING').slice(0, limit);
    for (let job of pending) {
      job = await transition({ ...job, pid: process.pid }, 'RUNNING', env);
      try {
        const code = await execute(job.argv, { env, onResult: result => { job.result = result; job.runId = result.runId; } });
        job = await transition(job, code === 0 && job.result?.ok === true ? 'COMPLETED' : 'FAILED', env);
      } catch (error) {
        job = await transition({ ...job, error: error.message }, 'FAILED', env);
      }
      done.push(job);
    }
    return done;
  });
}
export async function changeJob(id, action, env = process.env) {
  return withFileLock(path.join(queueDir(env), 'worker.lock'), async () => {
    const job = await readJson(jobPath(id, env));
    if (!job) throw new Error('Queue job not found');
    if (action === 'cancel' && job.status === 'PENDING') return transition(job, 'CANCELLED', env);
    // Never replay an interrupted task automatically: it may already have edited files.
    if (action === 'recover' && job.status === 'RUNNING') return transition(job, 'INTERRUPTED', env);
    throw new Error('Use cancel for a pending job or recover for an interrupted RUNNING job. Inspect results before adding a new job.');
  });
}
