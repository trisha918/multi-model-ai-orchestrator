import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { listRuns, resultPath } from './run-history.mjs';
import { readJson } from './local-store.mjs';
import { parseTaskArgs, runTask } from './orchestrator.mjs';
import { resolveTaskInput } from './task-input.mjs';
import { resolveTaskRepo, resolveGitRootFromCwd } from './workspace.mjs';
import { listMemory, addMemory, removeMemory, searchMemory } from './memory.mjs';
import { enqueue, listQueue, drainQueue, changeJob } from './local-queue.mjs';
import { routingStats, recommendRoute } from './learned-routing.mjs';

const HELP = `Independent local modules (no GitHub account required):
  ai-orchestrator runs list
  ai-orchestrator runs show <run-id>
  ai-orchestrator runs events <run-id>
  ai-orchestrator memory add --repo <folder> --text "Repository note" [--days 90]
  ai-orchestrator memory list --repo <folder>
  ai-orchestrator memory search --repo <folder> --text "query"
  ai-orchestrator memory remove <note-id> --repo <folder>
  ai-orchestrator queue add <same flags as run; task input is copied now>
  ai-orchestrator queue list
  ai-orchestrator queue run [--limit 1]
  ai-orchestrator queue cancel <job-id>
  ai-orchestrator queue recover <interrupted-job-id>
  ai-orchestrator routing stats [--repo <folder>]
  ai-orchestrator routing recommend --repo <folder> --text "task"
Memory is included in workers only with run --memory.
queue run processes a bounded batch in the foreground; adding a job does not run it.`;

function flags(argv, allowed) {
  const out = { positional: [] };
  for (let i=0; i<argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    if (!allowed.includes(a)) throw new Error(`Unknown option: ${a}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${a} requires a value`);
    out[a.slice(2)] = value;
  }
  return out;
}

export async function localCommand(command, argv, { env = process.env, cwd = process.cwd(), print = console.log, execute = runTask } = {}) {
  const sub = argv[0];
  if (!sub || argv.includes('--help')) { print(HELP); return 0; }
  const output = value => print(JSON.stringify(value, null, 2));
  if (command === 'runs') {
    if (sub === 'list') output(await listRuns(env));
    else if (sub === 'show') {
      const result = await readJson(resultPath(argv[1], env));
      if (!result) throw new Error('Run not found; older releases may only have meta.json');
      output(result);
    } else if (sub === 'events') print(await readFile(path.join(path.dirname(resultPath(argv[1], env)), 'events.jsonl'), 'utf8'));
    else throw new Error('Use runs list, show or events');
    return 0;
  }
  if (command === 'queue') {
    if (sub === 'add') {
      const parsed = parseTaskArgs(argv.slice(1));
      const task = await resolveTaskInput(parsed);
      const repo = await resolveGitRootFromCwd(await resolveTaskRepo(parsed.repo, cwd));
      const copy = [];
      for (let i=1; i<argv.length; i++) {
        if (['--task','--task-file','--repo'].includes(argv[i])) { i++; continue; }
        if (argv[i] === '--task-stdin') continue;
        copy.push(argv[i]);
      }
      output(await enqueue([...copy, '--repo', repo, '--task', task], { env }));
    } else if (sub === 'list') output(await listQueue(env));
    else if (sub === 'run') {
      const opts = flags(argv.slice(1), ['--limit']);
      const done = await drainQueue(execute, { env, limit: Number(opts.limit || 1) });
      output(done);
      return done.some(j => j.status === 'FAILED') ? 1 : 0;
    } else if (['cancel','recover'].includes(sub)) output(await changeJob(argv[1], sub, env));
    else throw new Error('Use queue add, list, run, cancel or recover');
    return 0;
  }
  const opts = flags(argv.slice(1), ['--repo','--text','--days']);
  const repo = await resolveGitRootFromCwd(await resolveTaskRepo(opts.repo, cwd));
  if (command === 'memory') {
    if (sub === 'add') output(await addMemory(repo, opts.text || '', { env, days: Number(opts.days || 90) }));
    else if (sub === 'list') output(await listMemory(repo, { env }));
    else if (sub === 'search') output(await searchMemory(repo, opts.text || '', { env }));
    else if (sub === 'remove') { await removeMemory(repo, opts.positional[0], env); print('Memory removed'); }
    else throw new Error('Use memory add, list, search or remove');
  } else if (command === 'routing') {
    if (sub === 'stats') output(routingStats(await listRuns(env), { repo }));
    else if (sub === 'recommend' && opts.text) output(recommendRoute(await listRuns(env), { repo, task: opts.text }));
    else throw new Error('Use routing stats or routing recommend --text "task"');
  }
  return 0;
}
