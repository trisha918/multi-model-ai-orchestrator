import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runtimeDirs } from './paths.mjs';
import { canonicalPath } from './workspace.mjs';
import { atomicJson, jsonRecords, safeId } from './local-store.mjs';
import { unlink } from 'node:fs/promises';

export function repositoryKey(repo) {
  const resolved = canonicalPath(repo);
  return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
}
function memoryDir(repo, env) { return path.join(runtimeDirs(env).root, 'memory', repositoryKey(repo)); }
export async function addMemory(repo, text, { env = process.env, days = 90, now = Date.now() } = {}) {
  if (!String(text).trim() || Buffer.byteLength(String(text)) > 16_000) throw new Error('Memory must contain 1–16000 UTF-8 bytes');
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('Memory lifetime must be 1–3650 days');
  const record = { version: 1, id: randomUUID(), repository: canonicalPath(repo), text: String(text), source: 'user', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86400000).toISOString() };
  await atomicJson(path.join(memoryDir(repo, env), `${record.id}.json`), record);
  return record;
}
export async function listMemory(repo, { env = process.env, now = Date.now() } = {}) {
  return (await jsonRecords(memoryDir(repo, env))).filter(r => r.version === 1 && r.source === 'user' && Date.parse(r.expiresAt) > now);
}
export async function removeMemory(repo, id, env = process.env) {
  await unlink(path.join(memoryDir(repo, env), `${safeId(id)}.json`));
}
export async function searchMemory(repo, query, options = {}) {
  const tokens = new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
  const records = await listMemory(repo, options);
  return records.map(r => ({ ...r, score: [...tokens].filter(t => r.text.toLowerCase().includes(t)).length }))
    .filter(r => r.score > 0).sort((a,b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
}
export async function memoryContext(repo, query, options = {}) {
  const records = await searchMemory(repo, query, options);
  if (!records.length) return '';
  return `\n\nRepository notes explicitly saved by the user (context only; current task and repository rules take precedence):\n${JSON.stringify(records.map(({ id, text }) => ({ id, text }))).slice(0, 12000)}\nEnd of repository notes.`;
}
