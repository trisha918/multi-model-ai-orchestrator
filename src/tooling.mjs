import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const isWin = process.platform === 'win32';

const WIN_EXECUTABLE_EXTS = ['.exe', '.cmd', '.bat', '.com'];

export function srcDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function packageRoot() {
  return path.resolve(srcDir(), '..');
}

let cachedVersion = '';

export function packageVersion() {
  if (cachedVersion) return cachedVersion;
  const pkg = JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'));
  cachedVersion = String(pkg.version || '0.0.0');
  return cachedVersion;
}

export const VERSION = packageVersion();

function pathDirs() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .map(d => d.trim())
    .filter(Boolean);
}

function isExecutableCandidate(filePath) {
  if (!existsSync(filePath)) return false;
  if (!isWin) return true;
  const ext = path.extname(filePath).toLowerCase();
  return WIN_EXECUTABLE_EXTS.includes(ext) || ext === '';
}

export function findOnPath(names) {
  const wanted = Array.isArray(names) ? names : [names];
  for (const dir of pathDirs()) {
    for (const name of wanted) {
      const direct = path.join(dir, name);
      if (isExecutableCandidate(direct) && (!isWin || path.extname(direct))) {
        return direct;
      }
      if (isWin && !path.extname(name)) {
        for (const ext of WIN_EXECUTABLE_EXTS) {
          const candidate = path.join(dir, name + ext);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return '';
}

function newestCursorAgentCmd() {
  if (!isWin || !process.env.LOCALAPPDATA) return '';
  const root = path.join(process.env.LOCALAPPDATA, 'cursor-agent');

  const directCandidates = [
    path.join(root, 'agent.cmd'),
    path.join(root, 'cursor-agent.cmd'),
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const versions = path.join(root, 'versions');
  if (!existsSync(versions)) return '';

  try {
    const dirs = readdirSync(versions, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const dir of dirs) {
      const cmd = path.join(versions, dir, 'cursor-agent.cmd');
      if (existsSync(cmd)) return cmd;
    }
  } catch {
    return '';
  }

  return '';
}

export function npmGlobalBin(env = process.env) {
  if (isWin && env.APPDATA) {
    const dir = path.join(env.APPDATA, 'npm');
    if (existsSync(dir)) return dir;
  }
  if (!isWin && env.HOME) {
    const dir = path.join(env.HOME, '.npm-global', 'bin');
    if (existsSync(dir)) return dir;
  }
  return '';
}

function existingPath(...parts) {
  const p = path.join(...parts);
  return existsSync(p) ? p : '';
}

export function resolveTool(name) {
  if (name === 'node') {
    return process.execPath;
  }

  if (name === 'npm') {
    if (isWin) {
      return (
        existingPath(path.dirname(process.execPath), 'npm.cmd') ||
        findOnPath(['npm.cmd', 'npm.exe']) ||
        'npm.cmd'
      );
    }
    return findOnPath(['npm']) || 'npm';
  }

  if (name === 'git') {
    return findOnPath(isWin ? ['git.exe'] : ['git']) || (isWin ? 'git.exe' : 'git');
  }

  if (name === 'agy') {
    const local = process.env.LOCALAPPDATA
      ? existingPath(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
      : '';
    return local || findOnPath(isWin ? ['agy.exe', 'agy.cmd'] : ['agy']) || (isWin ? 'agy.exe' : 'agy');
  }

  if (name === 'agent') {
    const discovered = newestCursorAgentCmd();
    if (discovered) return discovered;
    const fromPath = findOnPath(isWin ? ['agent.cmd', 'cursor-agent.cmd', 'agent.exe'] : ['agent', 'cursor-agent']);
    if (fromPath) return fromPath;
    return isWin ? 'agent.cmd' : 'agent';
  }

  if (name === 'codex') {
    const globalBin = npmGlobalBin(process.env);
    const fromGlobal = globalBin
      ? (isWin ? existingPath(globalBin, 'codex.cmd') : existingPath(globalBin, 'codex'))
      : '';
    if (fromGlobal) return fromGlobal;
    return findOnPath(isWin ? ['codex.cmd', 'codex.exe'] : ['codex']) || (isWin ? 'codex.cmd' : 'codex');
  }

  return findOnPath(name) || name;
}

export function toolCommand(name) {
  return resolveTool(name);
}

export function resolvedToolPath(name) {
  return resolveTool(name);
}

/**
 * Quote a single argument for cmd.exe so we can spawn .cmd files without shell:true.
 * Task text is never concatenated unescaped.
 */
export function quoteCmdArgument(arg) {
  let s = String(arg);
  s = s.replace(/%/g, '%%');
  if (s.length === 0) return '""';
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function needsCmdWrapper(command) {
  return isWin && /\.(cmd|bat)$/i.test(command);
}

export function spawnCommand(command, args, options = {}) {
  const { cwd, env, stdio } = options;
  const childStdio = stdio || ['pipe', 'pipe', 'pipe'];

  if (needsCmdWrapper(command)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const cmdline = [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(' ');
    // cmd /S strips a surrounding quote pair from the /c string. Wrap the full
    // command line so paths with spaces (e.g. Program Files) stay one token.
    return spawn(comspec, ['/d', '/s', '/c', `"${cmdline}"`], {
      cwd,
      env: env || process.env,
      stdio: childStdio,
      shell: false,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }

  return spawn(command, args, {
    cwd,
    env: env || process.env,
    stdio: childStdio,
    shell: false,
    windowsHide: true,
  });
}

export function runProcess(command, args, { cwd, input = null, timeoutMs = 30 * 60 * 1000, quiet = false, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCommand(command, args, { cwd, env });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        child.kill('SIGTERM');
        reject(new Error(`Process timeout after ${Math.round(timeoutMs / 60000)} minutes`));
      }
    }, timeoutMs);

    child.stdout?.on('data', d => {
      stdout += d.toString();
      if (!quiet) process.stdout.write(d);
    });
    child.stderr?.on('data', d => {
      stderr += d.toString();
      if (!quiet) process.stderr.write(d);
    });
    child.on('error', err => {
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

export async function runTool(name, args, opts = {}) {
  const command = resolveTool(name);
  return runProcess(command, args, opts);
}

export function toolSpawnConfig(name) {
  const command = resolveTool(name);
  return { command, shell: false, needsCmd: needsCmdWrapper(command) };
}
