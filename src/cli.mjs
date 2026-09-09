import process from 'node:process';
import { VERSION } from './tooling.mjs';
import { runTask, parseTaskArgs } from './orchestrator.mjs';
import { runDoctor } from './doctor.mjs';
import { runCleanupCli } from './cleanup.mjs';
import {
  CONFIG_PRECEDENCE,
  loadResolvedConfig,
  readUserConfigFile,
  writeUserConfigFile,
  USER_CONFIG_KEYS,
  validateConfigValue,
} from './config.mjs';
import { userConfigPath, installationInfo } from './paths.mjs';
import { installSkills, uninstallSkills } from './skills.mjs';
import { loadRegistry } from './model-cache.mjs';
import { formatModelsReport } from './model-registry.mjs';
import { parseGithubCli, githubHelpText, cmdGithub } from './github-cli.mjs';

export const COMMANDS = ['doctor', 'version', 'run', 'cleanup', 'config', 'install-skills', 'uninstall-skills', 'models', 'github'];

export function printVersion() {
  return `Multi-Model AI Orchestrator v${VERSION}`;
}

export function parseCli(argv) {
  const args = [...argv];
  if (args.length === 1 && /^run\s+--/.test(args[0])) {
    return {
      command: 'unknown',
      argv: args,
      error: 'CLI arguments were collapsed into a single string. Re-run .\\install.ps1 so the PowerShell shim uses @args, then pass separate arguments such as run, --repo, and --task. Do not interpolate the task into one command line.',
    };
  }
  if (args.length === 0) {
    return { command: 'help', argv: [], flags: {} };
  }

  if (args[0] === '--version' || args[0] === '-v') {
    return { command: 'version', argv: [], flags: { version: true } };
  }
  if (args[0] === '--help' || args[0] === '-h') {
    return { command: 'help', argv: [], flags: {} };
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === 'version') return { command: 'version', argv: rest, flags: {} };
  if (command === 'doctor') return { command: 'doctor', argv: rest, flags: {} };
  if (command === 'run') return { command: 'run', argv: rest, flags: {}, taskArgs: parseTaskArgs(rest) };
  if (command === 'cleanup') return { command: 'cleanup', argv: rest, flags: {} };
  if (command === 'install-skills') return { command: 'install-skills', argv: rest, flags: {} };
  if (command === 'uninstall-skills') return { command: 'uninstall-skills', argv: rest, flags: {} };
  if (command === 'models') {
    return { command: 'models', argv: rest, refresh: rest[0] === 'refresh' };
  }
  if (command === 'github') {
    return { command: 'github', argv: rest, github: parseGithubCli(rest) };
  }
  if (command === 'config') {
    const sub = rest[0] || 'show';
    return {
      command: 'config',
      argv: rest,
      subcommand: sub,
      key: rest[1],
      value: rest.slice(2).join(' '),
    };
  }

  if (command.startsWith('--')) {
    return { command: 'unknown', argv: args, error: `Unknown option: ${command}` };
  }

  return { command: 'unknown', argv: args, error: `Unknown command: ${command}` };
}

export function helpText() {
  return [
    printVersion(),
    '',
    'Usage:',
    '  ai-orchestrator <command>',
    '',
    'Commands:',
    '  doctor              Check tools, auth, skills, config, runtime paths, and model discovery',
    '  version             Print the package version',
    '  run                 Run a task (same flags as npm run task)',
    '  models              Show discovered models (use `models refresh` to re-query CLIs)',
    '  github              Optional GitHub issue automation (see `github --help`)',
    '  cleanup             List or delete old runs/worktrees (dry-run unless --apply)',
    '  config show         Show effective configuration',
    '  config path         Print the user config.json path',
    '  config set <k> <v>  Write a validated user setting',
    '  install-skills      Install global Cursor skills (/ai, /ai-team, worker, profile, alias)',
    '  uninstall-skills    Remove project-owned Cursor skills',
    '',
    'Run flags:',
    '  --repo <git-root>   Target repository (defaults to Git root of the current directory)',
    '  --task <text>       Task text (verbatim; optional if --task-file or --task-stdin)',
    '  --task-file <path>  Read task as UTF-8 from a file (Cursor skills use this)',
    '  --task-stdin        Read task as UTF-8 from stdin',
    '  --mode auto|cursor|codex|gemini|agy|team',
    '  --model <alias|profile>   Friendly alias or profile (auto, fast, sol, pro-high, ...)',
    '  --model-id <id>     Exact provider model id (do not combine with --model)',
    '  --cursor-model --codex-model --gemini-model   Per-worker aliases',
    '  --commit-on-pass --max-fix-rounds --branch --in-place --windows-unelevated',
    '',
    `Config precedence: ${CONFIG_PRECEDENCE.join(' → ')}`,
    'Model env overrides: AI_CURSOR_MODEL, AI_CODEX_MODEL, AI_GEMINI_MODEL',
    '',
    githubHelpText(),
    '',
    'There is no ai-orchestrator update in v1.1. To update a Git clone:',
    '  git pull',
    '  npm install',
    '  .\\install.ps1',
  ].join('\n');
}

async function cmdConfig(parsed) {
  const sub = parsed.subcommand || 'show';
  if (sub === 'path') {
    console.log(userConfigPath());
    return 0;
  }
  if (sub === 'show') {
    const effective = await loadResolvedConfig();
    const file = await readUserConfigFile();
    const info = installationInfo();
    console.log(JSON.stringify({
      precedence: CONFIG_PRECEDENCE,
      configPath: info.configPath,
      userFile: file,
      effective: {
        defaultMode: effective.defaultMode,
        cursorModel: effective.cursorModel,
        codexModel: effective.codexModel,
        geminiModel: effective.geminiModel,
        team: effective.team,
        keepSuccessWorktrees: effective.keepSuccessWorktrees,
        keepFailedWorktrees: effective.keepFailedWorktrees,
        workerMaxRetries: effective.workerMaxRetries,
        cursorTimeoutMs: effective.cursorTimeoutMs,
        codexTimeoutMs: effective.codexTimeoutMs,
        geminiTimeoutMs: effective.geminiTimeoutMs,
        testTimeoutMs: effective.testTimeoutMs,
      },
    }, null, 2));
    return 0;
  }
  if (sub === 'set') {
    if (!parsed.key || parsed.value === '') {
      console.error('Usage: ai-orchestrator config set <key> <value>');
      console.error(`Keys: ${USER_CONFIG_KEYS.join(', ')}`);
      return 2;
    }
    try {
      validateConfigValue(parsed.key, parsed.value);
      const written = await writeUserConfigFile({ [parsed.key]: parsed.value });
      console.log(`Wrote ${parsed.key} to ${written.path}`);
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }
  console.error(`Unknown config subcommand: ${sub}`);
  return 2;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.command === 'help') {
    console.log(helpText());
    return 0;
  }
  if (parsed.command === 'unknown') {
    console.error(parsed.error || 'Unknown command');
    console.error(helpText());
    return 2;
  }
  if (parsed.command === 'version') {
    console.log(printVersion());
    return 0;
  }
  if (parsed.command === 'doctor') {
    const report = await runDoctor();
    return report.failed ? 1 : 0;
  }
  if (parsed.command === 'run') {
    const code = await runTask(parsed.argv);
    return typeof code === 'number' ? code : (process.exitCode || 0);
  }
  if (parsed.command === 'cleanup') {
    runCleanupCli(parsed.argv);
    return 0;
  }
  if (parsed.command === 'config') {
    return cmdConfig(parsed);
  }
  if (parsed.command === 'models') {
    try {
      const loaded = await loadRegistry({ refresh: Boolean(parsed.refresh) });
      console.log(formatModelsReport(loaded.registry));
      console.log('');
      console.log(parsed.refresh ? 'Refreshed from installed CLIs.' : (loaded.fromCache ? `Cache: ${loaded.path}${loaded.stale ? ' (stale)' : ''}` : `Wrote cache: ${loaded.path}`));
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }
  if (parsed.command === 'github') {
    try {
      return await cmdGithub(parsed.github || parseGithubCli(parsed.argv));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }
  if (parsed.command === 'install-skills') {
    let registry = null;
    try {
      registry = (await loadRegistry({ refresh: false })).registry;
    } catch {
      registry = null;
    }
    const results = await installSkills({ registry });
    for (const r of results) {
      if (r.status === 'installed') console.log(`Installed /${r.name} -> ${r.path}`);
      else if (r.status === 'removed-stale') console.log(`Removed stale /${r.name}`);
      else console.error(`/${r.name}: ${r.message || r.status}`);
    }
    if (results.some(r => r.status === 'skipped-foreign')) return 2;
    console.log('\nRestart Cursor (or reload the window), then type /ai, /ai-team, /ai-codex, or /ai-models in Agent chat.');
    return 0;
  }
  if (parsed.command === 'uninstall-skills') {
    const results = await uninstallSkills();
    for (const r of results) {
      if (r.status === 'removed') console.log(`Removed /${r.name}`);
      else if (r.status === 'missing') console.log(`/${r.name} was not installed`);
      else console.error(`/${r.name}: ${r.message || r.status}`);
    }
    if (results.some(r => r.status === 'skipped-foreign')) return 2;
    return 0;
  }
  console.error(`Unknown command: ${parsed.command}`);
  return 2;
}

export { parseTaskArgs };
