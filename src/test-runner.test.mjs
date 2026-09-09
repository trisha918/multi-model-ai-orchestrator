import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectTestCommand, runProjectTests } from './test-runner.mjs';

test('package.json UTF-8 BOM still detects npm test', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-bom-'));
  try {
    await writeFile(path.join(dir, 'package.json'), '\uFEFF' + JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    assert.equal(detectTestCommand(dir).runner, 'npm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects npm test from package.json scripts.test', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-npm-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    const d = detectTestCommand(dir);
    assert.equal(d.detected, true);
    assert.equal(d.runner, 'npm');
    assert.equal(d.command, 'npm test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('npm test PASS is determined from exit code 0', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-pass-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    const r = await runProjectTests(dir, { timeoutMs: 30_000, quiet: true });
    assert.equal(r.status, 'PASS');
    assert.equal(r.exitCode, 0);
    assert.equal(r.detected, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('npm test FAIL is determined from non-zero exit code', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-fail-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(1)"' } }), 'utf8');
    const r = await runProjectTests(dir, { timeoutMs: 30_000, quiet: true });
    assert.equal(r.status, 'FAIL');
    assert.equal(r.exitCode, 1);
    assert.notEqual(r.status, 'PASS');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runProjectTests uses injected executeProcess cwd', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai orch execcwd '));
  const seen = [];
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    const r = await runProjectTests(dir, {
      timeoutMs: 5_000,
      quiet: true,
      executeProcess: async (command, args, opts) => {
        seen.push({ command, args, cwd: opts.cwd });
        return { exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 };
      },
    });
    assert.equal(r.status, 'PASS');
    assert.equal(path.resolve(seen[0].cwd), path.resolve(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no test runner yields SKIP not PASS', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-skip-'));
  try {
    await writeFile(path.join(dir, 'README.md'), 'no tests\n', 'utf8');
    const r = await runProjectTests(dir, { timeoutMs: 5_000, quiet: true });
    assert.equal(r.detected, false);
    assert.equal(r.status, 'SKIP');
    assert.match(r.reason, /No supported test runner/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detection precedence prefers npm over artisan and cargo', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-prec-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    await writeFile(path.join(dir, 'artisan'), '<?php\n', 'utf8');
    await writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    const d = detectTestCommand(dir);
    assert.equal(d.runner, 'npm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects php artisan, pytest, go, rust, flutter/dart, dotnet', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-eco-'));
  try {
    await writeFile(path.join(dir, 'artisan'), '<?php\n', 'utf8');
    assert.equal(detectTestCommand(dir).runner, 'php-artisan');
    await rm(path.join(dir, 'artisan'));

    await mkdir(path.join(dir, 'tests'));
    await writeFile(path.join(dir, 'pytest.ini'), '[pytest]\n', 'utf8');
    assert.equal(detectTestCommand(dir).runner, 'pytest');
    await rm(path.join(dir, 'pytest.ini'));
    await rm(path.join(dir, 'tests'), { recursive: true });

    await writeFile(path.join(dir, 'go.mod'), 'module x\n', 'utf8');
    assert.equal(detectTestCommand(dir).runner, 'go');
    await rm(path.join(dir, 'go.mod'));

    await writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    assert.equal(detectTestCommand(dir).runner, 'cargo');
    await rm(path.join(dir, 'Cargo.toml'));

    await writeFile(path.join(dir, 'app.csproj'), '<Project></Project>\n', 'utf8');
    assert.equal(detectTestCommand(dir).runner, 'dotnet');
    await rm(path.join(dir, 'app.csproj'));

    await writeFile(path.join(dir, 'pubspec.yaml'), 'name: x\nenvironment:\n  sdk: flutter\n', 'utf8');
    assert.equal(detectTestCommand(dir).runner, 'flutter');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
