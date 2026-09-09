import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInsideDir, pathsEqual } from './workspace.mjs';

export const MAX_TASK_BYTES = 1024 * 1024;
export const TASK_INBOX_LEAF = 'task-inbox';
export const TASK_FILE_RE = /^task-[0-9a-f]{32}\.txt$/;

export class TaskInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskInputError';
    this.exitCode = 2;
  }
}

export function taskInboxDir(tmpRoot = os.tmpdir()) {
  return path.join(tmpRoot, 'MultiModelAIOrchestrator', TASK_INBOX_LEAF);
}

export function isOwnedTaskFile(filePath, tmpRoot = os.tmpdir()) {
  const inbox = taskInboxDir(tmpRoot);
  const resolved = path.resolve(filePath);
  if (!TASK_FILE_RE.test(path.basename(resolved))) return false;
  if (!isInsideDir(inbox, resolved)) return false;
  return pathsEqual(resolved, path.join(inbox, path.basename(resolved)));
}

export function createOwnedTaskFile(taskText, { tmpRoot = os.tmpdir() } = {}) {
  const inbox = taskInboxDir(tmpRoot);
  mkdirSync(inbox, { recursive: true });
  const name = `task-${randomBytes(16).toString('hex')}.txt`;
  const filePath = path.join(inbox, name);
  if (!isOwnedTaskFile(filePath, tmpRoot)) {
    throw new TaskInputError(`Refusing to create task file outside inbox: ${filePath}`);
  }
  writeFileSync(filePath, String(taskText), { encoding: 'utf8', flag: 'wx' });
  return filePath;
}

export function deleteOwnedTaskFile(filePath, { createdPath, tmpRoot = os.tmpdir() } = {}) {
  if (!filePath) return { deleted: false, reason: 'no path' };
  const resolved = path.resolve(filePath);
  if (!createdPath || !pathsEqual(resolved, createdPath)) {
    return { deleted: false, reason: 'path is not the file created by this invocation' };
  }
  if (!isOwnedTaskFile(resolved, tmpRoot)) {
    return { deleted: false, reason: 'path is not an orchestrator-owned task inbox file' };
  }
  if (!existsSync(resolved)) return { deleted: false, reason: 'missing' };
  unlinkSync(resolved);
  return { deleted: true, reason: '' };
}

function countTaskSources(args) {
  let n = 0;
  if (args.provided?.task) n += 1;
  if (args.provided?.taskFile) n += 1;
  if (args.provided?.taskStdin) n += 1;
  return n;
}

export function assertTaskSourceExclusive(args) {
  const n = countTaskSources(args);
  if (n > 1) {
    throw new TaskInputError('Ambiguous task input. Use only one of --task, --task-file, or --task-stdin.');
  }
  if (n === 0) {
    throw new TaskInputError('Missing task. Provide --task, --task-file, or --task-stdin.');
  }
}

export function readTaskFileSync(filePath) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new TaskInputError(`Task file not found:\n${resolved}`);
  }
  const buf = readFileSync(resolved);
  if (buf.length > MAX_TASK_BYTES) {
    throw new TaskInputError(`Task file exceeds ${MAX_TASK_BYTES} bytes.`);
  }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

export async function readStdinTask(stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_TASK_BYTES) {
      throw new TaskInputError(`stdin task exceeds ${MAX_TASK_BYTES} bytes.`);
    }
    chunks.push(buf);
  }
  let text = Buffer.concat(chunks).toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

export async function resolveTaskInput(args, { stdin = process.stdin } = {}) {
  assertTaskSourceExclusive(args);
  if (args.provided.task) {
    if (args.task == null) throw new TaskInputError('--task requires task text.');
    return String(args.task);
  }
  if (args.provided.taskFile) {
    if (!args.taskFile || !String(args.taskFile).trim()) {
      throw new TaskInputError('--task-file requires a path.');
    }
    return readTaskFileSync(args.taskFile);
  }
  return readStdinTask(stdin);
}
