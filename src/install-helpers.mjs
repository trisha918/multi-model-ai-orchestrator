import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot, requiredNodeEngine } from './paths.mjs';
import { npmGlobalBin } from './tooling.mjs';

export function parseNodeEngineMinimum(spec = requiredNodeEngine()) {
  const m = String(spec).match(/>=\s*(\d+)/);
  return m ? Number(m[1]) : 20;
}

export function nodeMajor(version = process.versions.node) {
  return Number(String(version).replace(/^v/, '').split('.')[0]);
}

export function nodeSatisfiesEngine(version = process.versions.node, spec = requiredNodeEngine()) {
  return nodeMajor(version) >= parseNodeEngineMinimum(spec);
}

export function npmGlobalPrefixHint(env = process.env) {
  return npmGlobalBin(env) || '';
}

export function pathHasDirectory(pathEnv, directory) {
  if (!pathEnv || !directory) return false;
  const needle = path.resolve(directory).replace(/[\\/]+$/, '');
  const parts = String(pathEnv).split(path.delimiter).map(p => path.resolve(p.replace(/[\\/]+$/, '')));
  const norm = p => process.platform === 'win32' ? p.toLowerCase() : p;
  const nNeedle = norm(needle);
  return parts.some(p => norm(p) === nNeedle);
}

export function readPackageManifest() {
  return JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'));
}
