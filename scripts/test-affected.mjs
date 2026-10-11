// Affected-test selector — inner-loop convenience, NOT the merge gate.
// Thin I/O shell around the pure logic in scripts/affected-core.mjs: resolves
// the change basis from git, probes the emulator, drives Jest/Vitest, and
// escalates to the full `pnpm test` whenever the blast radius can't be bounded
// honestly. Deliberately untested — all decision branches live in the
// unit-tested core.
//
// Usage:
//   pnpm test:affected            # uncommitted vs HEAD (incl. untracked)
//   pnpm test:affected main       # widen basis to a ref / commit range
//   pnpm test:affected HEAD~3

import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyChange, decideFromProbe } from './affected-core.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_REMINDER =
  'Reminder: `pnpm test:affected` is the inner loop, NOT the merge gate. ' +
  'Run `pnpm test` before committing.';

function git(args) {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (res.status !== 0) {
    const detail = (res.stderr || res.error?.message || '').trim();
    console.error(`git ${args.join(' ')} failed: ${detail}`);
    process.exit(1);
  }
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Local working-tree state is an unconditional safety floor: tracked edits
// vs HEAD + untracked files are ALWAYS in the basis. A ref arg only ever
// *widens* on top of that floor. This union is deliberate — a
// commit-only range (`a..b` / `a...b`) resolves commit-to-commit and would
// otherwise drop uncommitted tracked edits, reporting green while a local
// source change went untested. That false green is the exact failure this
// tool exists to prevent, so the floor is never conditional on `ref`.
function changedPaths(ref) {
  const local = [
    ...git(['diff', '--name-only', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ];
  const widened = ref ? git(['diff', '--name-only', ref]) : [];
  return [...new Set([...local, ...widened])];
}

function emulatorReachable() {
  const port = Number(process.env.EMU_DYNAMODB_HOST_PORT) || 8000;
  return new Promise((res) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(400);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function runFullSuite(reason) {
  console.log(`\n${reason} — running the full suite (\`pnpm test\`).\n`);
  const res = spawnSync('pnpm', ['test'], { cwd: repoRoot, stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

function readResult(file) {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const matchedCount = Number.isInteger(json.numTotalTestSuites)
      ? json.numTotalTestSuites
      : 0;
    return { matchedCount, success: json.success === true };
  } catch {
    // No machine-readable output (runner found nothing / crashed before
    // writing). Conservative: zero matches, not green — a source-bearing
    // bucket with zero matches escalates; never a false pass.
    return { matchedCount: 0, success: false };
  }
}

// One instrumented invocation per bucket: human reporter streams to the
// terminal, machine reporter is captured to a temp file for the verdict.
// `--passWithNoTests` is never passed — a zero-match must reach decideFromProbe.
function runBucket(kind, files) {
  const dir = mkdtempSync(join(tmpdir(), 'affected-'));
  const out = join(dir, 'result.json');
  try {
    const spawn = (args, env) =>
      spawnSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit', env });

    if (kind === 'web') {
      spawn([
        '--filter', '@retirement/web', 'exec',
        'vitest', 'related', ...files,
        '--run', '--reporter=default', '--reporter=json',
        `--outputFile.json=${out}`,
      ], process.env);
    } else {
      // Mirror the api package's own test script, which needs VM modules for
      // its ESM suites; `pnpm --filter exec jest` bypasses that NODE_OPTIONS.
      const nodeOpts = `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim();
      spawn([
        '--filter', '@retirement/api', 'exec',
        'jest', '--json', `--outputFile=${out}`,
        '--findRelatedTests', ...files,
      ], { ...process.env, NODE_OPTIONS: nodeOpts });
    }
    return readResult(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- main ------------------------------------------------------------------

const ref = process.argv[2];
const { mode, webFiles, apiFiles } = classifyChange(changedPaths(ref));

if (mode === 'escalate') {
  runFullSuite('Broad-impact or unmapped change detected');
}

if (mode === 'noop') {
  console.log(
    'No code changed (docs / assets only) — nothing to run.',
  );
  console.log(GATE_REMINDER);
  process.exit(0);
}

// mode === 'select'
const buckets = [];
let apiSkipped = false;

if (webFiles.length > 0) buckets.push({ kind: 'web', files: webFiles });

if (apiFiles.length > 0) {
  if (await emulatorReachable()) {
    buckets.push({ kind: 'api', files: apiFiles });
  } else {
    apiSkipped = true;
    console.log(
      'API affected tests skipped: emulator not running — run `pnpm emu:up`. ' +
        'Full `pnpm test` is the gate.',
    );
  }
}

const ran = [];
for (const { kind, files } of buckets) {
  const { matchedCount, success } = runBucket(kind, files);
  // Every bucketed file is a source file by construction (classifyChange
  // escalates non-source paths), so a non-empty bucket always has source.
  if (decideFromProbe({ hasSource: true, matchedCount }) === 'escalate') {
    runFullSuite(`${kind} change has no covering spec (0 matched suites)`);
  }
  ran.push({ kind, matchedCount, success });
}

console.log('\n— affected-test summary —');
for (const r of ran) {
  console.log(
    `  ${r.kind}: ${r.matchedCount} suite(s) — ${r.success ? 'passed' : 'FAILED'}`,
  );
}
if (apiSkipped) console.log('  api: skipped (emulator down)');
console.log(GATE_REMINDER);

// API-skipped is a skip, never a failure. Exit non-zero only if a bucket
// that actually ran failed.
process.exit(ran.some((r) => !r.success) ? 1 : 0);
