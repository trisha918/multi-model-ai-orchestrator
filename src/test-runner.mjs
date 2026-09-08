import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveTool } from './tooling.mjs';
import { executeProcess } from './process.mjs';
import { config } from './config.mjs';

function readJson(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hasFlutterSdk(pubspec) {
  return /sdk:\s*flutter/i.test(pubspec);
}

function hasPytest(repo) {
  if (existsSync(path.join(repo, 'pytest.ini'))) return true;
  if (existsSync(path.join(repo, 'conftest.py'))) return true;
  if (existsSync(path.join(repo, 'tests')) && existsSync(path.join(repo, 'tests'))) return true;
  const pyproject = path.join(repo, 'pyproject.toml');
  if (existsSync(pyproject)) {
    const txt = readFileSync(pyproject, 'utf8');
    if (/\[tool\.pytest/.test(txt) || /pytest/.test(txt)) return true;
  }
  return existsSync(path.join(repo, 'tests')) || existsSync(path.join(repo, 'test'));
}

function hasDotnet(repo) {
  try {
    const names = readdirSync(repo);
    return names.some(n => n.endsWith('.sln') || n.endsWith('.csproj'));
  } catch {
    return false;
  }
}

export function detectTestCommand(repo) {
  const root = path.resolve(repo);
  const pkgFile = path.join(root, 'package.json');
  if (existsSync(pkgFile)) {
    const pkg = readJson(pkgFile);
    if (pkg?.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()) {
      return { detected: true, runner: 'npm', command: 'npm test', argv: [resolveTool('npm'), ['test']] };
    }
  }
  if (existsSync(path.join(root, 'artisan'))) {
    return { detected: true, runner: 'php-artisan', command: 'php artisan test', argv: ['php', ['artisan', 'test']] };
  }
  const pubspec = path.join(root, 'pubspec.yaml');
  if (existsSync(pubspec)) {
    const txt = readFileSync(pubspec, 'utf8');
    if (hasFlutterSdk(txt)) {
      return { detected: true, runner: 'flutter', command: 'flutter test', argv: ['flutter', ['test']] };
    }
    return { detected: true, runner: 'dart', command: 'dart test', argv: ['dart', ['test']] };
  }
  if (existsSync(path.join(root, 'Cargo.toml'))) {
    return { detected: true, runner: 'cargo', command: 'cargo test', argv: ['cargo', ['test']] };
  }
  if (existsSync(path.join(root, 'go.mod'))) {
    return { detected: true, runner: 'go', command: 'go test ./...', argv: ['go', ['test', './...']] };
  }
  if (hasDotnet(root)) {
    return { detected: true, runner: 'dotnet', command: 'dotnet test', argv: ['dotnet', ['test']] };
  }
  if (hasPytest(root)) {
    return { detected: true, runner: 'pytest', command: 'pytest', argv: ['pytest', []] };
  }
  return { detected: false, runner: '', command: '', argv: null };
}

export async function runProjectTests(repo, { timeoutMs = config.testTimeoutMs, quiet = false } = {}) {
  const detected = detectTestCommand(repo);
  if (!detected.detected) {
    return {
      detected: false,
      runner: '',
      command: '',
      exitCode: null,
      status: 'SKIP',
      durationMs: 0,
      reason: 'No supported test runner detected',
      stdout: '',
      stderr: '',
    };
  }
  const [command, args] = detected.argv;
  const r = await executeProcess(command, args, {
    cwd: repo,
    timeoutMs,
    quiet,
    maxRetries: 0,
  });
  let status = 'FAIL';
  if (r.timedOut) status = 'TIMEOUT';
  else if (r.exitCode === 0) status = 'PASS';
  return {
    detected: true,
    runner: detected.runner,
    command: detected.command,
    exitCode: r.exitCode,
    status,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
  };
}
