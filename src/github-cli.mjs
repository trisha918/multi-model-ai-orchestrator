import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, findOnPath } from './tooling.mjs';
import { createGithubClient } from './github-client.mjs';
import { loadRepoAutomationConfig, DEFAULT_REPO_AUTOMATION } from './github-config.mjs';
import { LABEL_DEFINITIONS } from './github-labels.mjs';
import { parseRepoSlug } from './github-state.mjs';
import { inspectIssueAutomation, runIssueAutomation, simulateGithubAutomation, implementationArgv, resumeIssueAutomation } from './github-automation.mjs';
import { formatGithubStatus } from './github-pr.mjs';
import { classifyCheckRuns, CI_STATUS } from './github-ci.mjs';
import { runTask } from './orchestrator.mjs';
import { git } from './workspace.mjs';
import { collectGithubDoctor, formatGithubDoctor } from './github-doctor.mjs';
import { formatGithubRepoDoctor, probeGithubRepo } from './github-probe.mjs';
import { detectGithubAuth } from './github-client.mjs';

export function parseGithubCli(argv) {
  const args = [...argv];
  const out = {
    command: 'github',
    subcommand: args[0] || '',
    repo: '',
    issue: '',
    dryRun: false,
    fixture: '',
    help: false,
  };
  if (args[0] === 'issue' && (args[1] === 'run' || args[1] === 'inspect')) {
    out.subcommand = `issue ${args[1]}`;
    parseFlags(args.slice(2), out);
  } else if (args[0] === 'labels' && args[1] === 'setup') {
    out.subcommand = 'labels setup';
    parseFlags(args.slice(2), out);
  } else if (args[0] === 'status' || args[0] === 'resume' || args[0] === 'simulate' || args[0] === 'doctor' || args[0] === 'authorize') {
    out.subcommand = args[0];
    parseFlags(args.slice(1), out);
  } else if (args[0] === '--help' || args[0] === '-h' || !args[0]) {
    out.help = true;
  } else {
    out.error = `Unknown github subcommand: ${args.join(' ')}`;
  }
  return out;
}

function parseFlags(args, out) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') out.repo = args[++i] ?? '';
    else if (a === '--issue') out.issue = args[++i] ?? '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--fixture') out.fixture = args[++i] ?? '';
    else if (a === '--help' || a === '-h') out.help = true;
  }
}

export function githubHelpText() {
  return [
    'GitHub automation (optional, default off):',
    '',
    '  ai-orchestrator github issue run --repo owner/name --issue 42 [--dry-run]',
    '  ai-orchestrator github issue inspect --repo owner/name --issue 42',
    '  ai-orchestrator github labels setup --repo owner/name [--dry-run]',
    '  ai-orchestrator github status --repo owner/name --issue 42',
    '  ai-orchestrator github authorize --repo owner/name --issue 42',
    '  ai-orchestrator github doctor [--repo owner/name]',
    '  ai-orchestrator github resume --repo owner/name --issue 42 [--dry-run]',
    '  ai-orchestrator github simulate --fixture path.json',
    '',
    'Automation starts only after a trusted actor adds the ai-auto label.',
    'v1.1 never auto-merges or publishes.',
  ].join('\n');
}

function resolveGhPath() {
  return findOnPath(process.platform === 'win32' ? ['gh.exe', 'gh.cmd'] : ['gh']) || '';
}

export async function buildLiveClient(env = process.env) {
  const ghPath = resolveGhPath();
  return createGithubClient({ env, ghPath, exec: ghPath ? runGh : undefined });
}

async function runGh(command, args, { input } = {}) {
  const r = await runProcess(command, args, { timeoutMs: 60_000, quiet: true, input });
  return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
}

export async function defaultRunImplementation({
  repo,
  branch,
  task,
  routing,
  env,
  runTaskImpl = runTask,
  gitImpl = git,
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-task-'));
  const taskFile = path.join(dir, 'task.txt');
  await writeFile(taskFile, task, { encoding: 'utf8' });
  const argv = implementationArgv({ repo, branch, taskFile, routing });
  const code = await runTaskImpl(argv, { env });
  const numeric = code === 0 ? 0 : (Number.isInteger(code) ? code : 1);
  let hash = '';
  try {
    hash = await gitImpl(repo, ['rev-parse', branch]);
  } catch {
    hash = '';
  }
  return {
    ok: numeric === 0,
    tests: numeric === 0 ? 'PASS' : 'FAIL',
    review: 'PASS',
    commit: hash,
    branch,
    route: routing.worker,
    model: routing.model,
  };
}

export async function defaultGitPush({ branch, repo }) {
  if (!repo) throw new Error('Missing local repository for git push');
  await git(repo, ['push', '-u', 'origin', branch]);
  const sha = await git(repo, ['rev-parse', branch]);
  return { sha };
}

export async function waitForGithubCi({ client, owner, name, ref, timeoutMs = 60 * 60 * 1000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const checks = await client.getChecks(owner, name, ref);
    const classified = classifyCheckRuns(checks.check_runs || [], { now: Date.now(), timeoutMs, startedAt: new Date(started).toISOString() });
    if (classified.status !== CI_STATUS.PENDING) {
      if (classified.status === CI_STATUS.FAIL) {
        try {
          const logs = await client.getLogs(owner, name, checks.check_runs?.[0]?.id);
          classified.logs = typeof logs === 'string' ? logs : JSON.stringify(logs).slice(0, 8000);
        } catch {
          classified.logs = '(unavailable)';
        }
      }
      return classified;
    }
    await new Promise(r => setTimeout(r, 15_000));
  }
  return { status: CI_STATUS.TIMEOUT, summary: 'GitHub CI timed out', failed: [], pending: [], passed: [] };
}

export async function cmdGithub(parsed, {
  env = process.env,
  cwd = process.cwd(),
  stdout = console.log,
  stderr = console.error,
  clientFactory = buildLiveClient,
  runImplementation = defaultRunImplementation,
  gitPush = defaultGitPush,
  waitForCi,
} = {}) {
  if (parsed.help || parsed.error) {
    if (parsed.error) stderr(parsed.error);
    stdout(githubHelpText());
    return parsed.error ? 2 : 0;
  }

  if (parsed.subcommand === 'simulate') {
    if (!parsed.fixture) {
      stderr('Usage: ai-orchestrator github simulate --fixture <file.json>');
      return 2;
    }
    const raw = JSON.parse(await readFile(parsed.fixture, 'utf8'));
    const result = await simulateGithubAutomation(raw);
    stdout(JSON.stringify({ stage: result.state.stage, attempt: result.state.attempt, max: result.state.maxAttempts, ok: result.ok }, null, 2));
    return result.ok ? 0 : 1;
  }

  const client = await clientFactory(env);

  if (parsed.subcommand === 'doctor') {
    const base = await collectGithubDoctor({ env, cwd });
    stdout(formatGithubDoctor(base));
    if (!parsed.repo) return base.auth.ok ? 0 : 0;
    const { owner, name, slug } = parseRepoSlug(parsed.repo);
    try {
      const probed = await probeGithubRepo(client, owner, name);
      stdout('');
      stdout(formatGithubRepoDoctor({
        repoSlug: slug,
        auth: detectGithubAuth(env, { ghResolved: resolveGhPath() }),
        repo: probed.repo,
        permissions: probed.permissions,
        runners: probed.runners,
      }));
      return 0;
    } catch (e) {
      stdout('');
      stdout(formatGithubRepoDoctor({
        repoSlug: slug,
        auth: detectGithubAuth(env, { ghResolved: resolveGhPath() }),
        error: client.redact ? client.redact(e instanceof Error ? e.message : String(e)) : String(e),
      }));
      return 2;
    }
  }

  if (parsed.subcommand === 'labels setup') {
    if (!parsed.repo) {
      stderr('Usage: ai-orchestrator github labels setup --repo owner/name [--dry-run]');
      return 2;
    }
    const { owner, name } = parseRepoSlug(parsed.repo);
    if (parsed.dryRun) {
      stdout('Dry run: would ensure labels:');
      for (const def of LABEL_DEFINITIONS) stdout(`  ${def.name}`);
      return 0;
    }
    const result = await client.ensureLabels(owner, name);
    stdout(`Created: ${result.created.join(', ') || '(none)'}`);
    stdout(`Already present: ${result.skipped.join(', ') || '(none)'}`);
    return 0;
  }

  const issueNumber = await requireRepoIssue(parsed);
  const { owner, name, slug } = parseRepoSlug(parsed.repo);
  const loaded = await loadRepoAutomationConfig(cwd);
  const config = loaded.ok ? loaded.config : DEFAULT_REPO_AUTOMATION;
  if (!loaded.ok) {
    stderr(`Repository config invalid: ${loaded.error}`);
    stderr('Refusing to enable automation.');
    if (parsed.subcommand !== 'issue inspect' && parsed.subcommand !== 'status' && parsed.subcommand !== 'authorize') return 2;
  }

  if (parsed.subcommand === 'issue inspect' || parsed.subcommand === 'status' || parsed.subcommand === 'authorize') {
    const info = await inspectIssueAutomation({ client, config, repo: slug, issueNumber, env });
    stdout(info.statusText);
    stdout('');
    stdout(`Trigger decision: ${info.decision.action} (${info.decision.reason})`);
    if (info.authorization?.blocked) stdout(`Authorization: BLOCKED (${info.authorization.reason})`);
    if (info.routingError) stdout(`Routing: ${info.routingError}`);
    if (parsed.subcommand === 'authorize') {
      if (info.authorization?.blocked) return 2;
      if (info.decision.action === 'skip' || info.decision.action === 'cancel') {
        stderr(`Refusing AI start: ${info.decision.reason}`);
        return 2;
      }
      stdout('AUTHORIZED');
      return 0;
    }
    return info.authorization?.blocked ? 2 : 0;
  }

  if (parsed.subcommand === 'issue run' || parsed.subcommand === 'resume') {
    const fn = parsed.subcommand === 'resume' ? resumeIssueAutomation : runIssueAutomation;
    const result = await fn({
      client,
      config,
      repo: slug,
      issueNumber,
      dryRun: parsed.dryRun,
      env,
      localRepo: cwd,
      runImplementation: parsed.dryRun ? async () => ({ ok: true, tests: 'PASS', review: 'PASS', commit: '', branch: 'dry' }) : runImplementation,
      gitPush: parsed.dryRun ? async () => ({ sha: '' }) : gitPush,
      waitForCi: parsed.dryRun
        ? async () => ({ status: CI_STATUS.PASS, summary: 'dry-run' })
        : (waitForCi || (async ({ ref }) => waitForGithubCi({ client, owner, name, ref }))),
    });
    if (result.dryRun) {
      stdout('Dry run — no push, PR, comment, or label writes.');
      for (const step of result.plan.steps) stdout(`- ${step.message}`);
      return 0;
    }
    stdout(formatGithubStatus({
      issue: { number: issueNumber, title: result.state?.issueTitle },
      automationMode: config.automation.mode,
      state: result.state,
    }));
    return result.code ?? 0;
  }

  stderr(githubHelpText());
  return 2;
}

async function requireRepoIssue(parsed) {
  if (!parsed.repo || !parsed.issue) {
    throw new Error('Usage requires --repo owner/name and --issue <n>');
  }
  parseRepoSlug(parsed.repo);
  const n = Number(parsed.issue);
  if (!Number.isInteger(n) || n < 1) throw new Error('--issue must be a positive integer');
  return n;
}
