import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';

const APP_DIR_NAME = 'MultiModelAIOrchestrator';

export function srcDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function packageRoot() {
  return path.resolve(srcDir(), '..');
}

let cachedVersion = '';

export function packageVersion() {
  if (cachedVersion) return cachedVersion;
  const pkgPath = path.join(packageRoot(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  cachedVersion = String(pkg.version || '0.0.0');
  return cachedVersion;
}

export function requiredNodeEngine() {
  const pkgPath = path.join(packageRoot(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return String(pkg.engines?.node || '>=20');
}

export function userConfigDir(env = process.env) {
  const override = env.AI_ORCHESTRATOR_CONFIG_DIR;
  if (override) return path.resolve(override);
  if (isWin && env.APPDATA) return path.join(env.APPDATA, APP_DIR_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_DIR_NAME);
}

export function userConfigPath(env = process.env) {
  return path.join(userConfigDir(env), 'config.json');
}

export function modelsCachePath(env = process.env) {
  return path.join(userConfigDir(env), 'models-cache.json');
}

export function runtimeRoot(env = process.env) {
  const override = env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  if (override) return path.resolve(override);
  if (isWin && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, APP_DIR_NAME);
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), APP_DIR_NAME);
}

export function cursorSkillsRoot(env = process.env) {
  const override = env.AI_ORCHESTRATOR_SKILLS_DIR;
  if (override) return path.resolve(override);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, '.cursor', 'skills');
}

export function runtimeDirs(env = process.env) {
  const root = runtimeRoot(env);
  const pkg = packageRoot();
  return {
    root,
    runs: path.join(root, 'runs'),
    worktrees: path.join(root, 'worktrees'),
    legacyRoot: pkg,
    legacyRuns: path.join(pkg, 'runs'),
    legacyWorktrees: path.join(pkg, 'worktrees'),
  };
}

export function installationInfo(env = process.env) {
  const dirs = runtimeDirs(env);
  const skills = cursorSkillsRoot(env);
  return {
    version: packageVersion(),
    packageRoot: packageRoot(),
    configDir: userConfigDir(env),
    configPath: userConfigPath(env),
    modelsCachePath: modelsCachePath(env),
    runtimeRoot: dirs.root,
    runs: dirs.runs,
    worktrees: dirs.worktrees,
    skillsRoot: skills,
    aiSkill: path.join(skills, 'ai'),
    aiTeamSkill: path.join(skills, 'ai-team'),
    legacyRuns: dirs.legacyRuns,
    legacyWorktrees: dirs.legacyWorktrees,
  };
}

export function legacyRuntimeExists(env = process.env) {
  const dirs = runtimeDirs(env);
  return existsSync(dirs.legacyRuns) || existsSync(dirs.legacyWorktrees);
}
