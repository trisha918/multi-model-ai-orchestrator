import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isWin, resolveTool } from './tooling.mjs';
import { executeProcess } from './process.mjs';

function newestCursorNodeEntry() {
  if (!isWin || !process.env.LOCALAPPDATA) return null;
  const root = path.join(process.env.LOCALAPPDATA, 'cursor-agent');
  const versions = path.join(root, 'versions');
  if (!existsSync(versions)) return null;
  try {
    const dirs = readdirSync(versions, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of dirs) {
      const node = path.join(versions, dir, 'node.exe');
      const indexJs = path.join(versions, dir, 'index.js');
      if (existsSync(node) && existsSync(indexJs)) {
        return { node, indexJs };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function buildCursorAgentArgs({ prompt, model = 'auto', readOnly = false, trust = false }) {
  const args = [];
  if (trust) args.push('--trust');
  args.push('--model', model, '--output-format', 'text');
  if (readOnly) args.push('--mode=ask');
  args.push('-p', prompt);
  return args;
}

export function cursorAgentLaunchSpec() {
  const nodeEntry = newestCursorNodeEntry();
  if (nodeEntry) {
    return { command: nodeEntry.node, prefix: [nodeEntry.indexJs] };
  }

  const cmd = resolveTool('agent');
  if (isWin && /\.cmd$/i.test(cmd)) {
    const siblingPs1 = cmd.replace(/\.cmd$/i, '.ps1');
    const sameDirPs1 = path.join(path.dirname(cmd), 'cursor-agent.ps1');
    const script = [path.join(path.dirname(cmd), 'cursor-agent.ps1'), siblingPs1, sameDirPs1].find(p => existsSync(p)) || '';
    if (script) {
      const powershell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      return {
        command: powershell,
        prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      };
    }
  }
  return { command: cmd, prefix: [] };
}

export async function runCursorAgentCli(args, opts) {
  const spec = cursorAgentLaunchSpec();
  return executeProcess(spec.command, [...spec.prefix, ...args], {
    cwd: opts?.cwd,
    timeoutMs: opts?.timeoutMs,
    quiet: opts?.quiet,
    env: opts?.env,
    maxRetries: opts?.maxRetries ?? 0,
    input: opts?.input ?? null,
  });
}
