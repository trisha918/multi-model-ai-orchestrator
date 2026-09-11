import { mkdir, readFile, writeFile, rename, unlink, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function safeId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/.test(String(value))) throw new Error('Invalid record id');
  return String(value);
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${file}: ${e.message}`); }
}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
  } finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

export async function appendEvent(file, type, data = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ version: 1, at: new Date().toISOString(), type, ...data })}\n`, { mode: 0o600 });
}

export async function jsonRecords(dir) {
  let names;
  try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return Promise.all(names.filter(n => n.endsWith('.json')).sort().map(n => readJson(path.join(dir, n))));
}

// Exclusive creation is atomic across processes. Never steal locks based on age:
// a worker can legitimately run for hours. Recovery is an explicit human action.
export async function acquireFileLock(file, metadata = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const lock = { ...metadata, pid: process.pid, token: randomUUID(), at: new Date().toISOString() };
  try { await writeFile(file, JSON.stringify(lock), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') return { ok: false, reason: `Lock held: ${file}. If the owner crashed, verify it has stopped before removing this lock.` }; throw e; }
  return { ok: true, lock, path: file };
}

export async function releaseFileLock(lease) {
  if (!lease?.ok) return;
  const current = await readJson(lease.path);
  if (current?.token !== lease.lock.token) throw new Error('Lock ownership changed; refusing to release');
  await unlink(lease.path);
}

export async function withFileLock(file, action) {
  const lease = await acquireFileLock(file);
  if (!lease.ok) throw new Error(lease.reason);
  try { return await action(); } finally { await releaseFileLock(lease); }
}
