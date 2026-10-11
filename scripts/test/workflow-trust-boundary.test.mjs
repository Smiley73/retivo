// Workflow and deploy-artifact trust-boundary regression guard.
//
// Reads the workflow + infrastructure source as TEXT (no YAML dep, no infra
// harness — the `infrastructure/` package has no unit-test harness) and asserts
// the supply-chain boundaries it locks in:
//
//   1. Every workflow `uses:` reference is pinned to a full 40-hex-character
//      commit SHA. A moving tag in a workflow is a supply-chain hole (a
//      compromised upstream tag alters code that runs in CI).
//   2. No job that acquires AWS credentials (`aws-actions/configure-aws-credentials`)
//      also runs an application build command or a remote shell installer
//      (`curl ... | sh`). Lines are attributed to their owning job by YAML
//      indentation (see `jobLines`, no YAML dependency). No workflow acquires
//      credentials today, so this passes without inspecting a job; it is the
//      guard that fails if one is added that builds in the credentialed job.
//   2b. No job that never acquires AWS credentials carries the `id-token`
//      permission, and no workflow-level `permissions:` block grants one
//      implicitly.
//   2c. Fork-safe CI (every workflow file): no `pull_request_target`,
//      `workflow_run` or `issue_comment` trigger; no `secrets.` reference; no
//      permission granted `write` at workflow or job level; no label-based or
//      fork-based (`labels`, `head.repo`) condition in a job `if:`. Each rule
//      is also run against small inline workflow texts that break it, so the
//      rules themselves are shown to fail.
//   2d. ci.yml specifically: `pull_request` is not restricted to types that
//      leave out `synchronize`; `push` to `main` is present; a job named
//      `All checks` exists, runs under a bare `if: always()`, and needs every
//      job except itself and the `if: false` ones; the variables that relax the
//      audit and the date checks (AUDIT_ADVISORIES_NONBLOCKING,
//      SKIP_REVIEW_BY_DATE_CHECK) are set only from a `pull_request` event
//      expression, so `main` and dispatch runs stay strict.
//   2e. Runners and checkouts (every workflow file): no job runs on a floating
//      `*-latest` image (GitHub moves those to the next OS release on its own
//      schedule), and every `actions/checkout` step sets
//      `persist-credentials: false`, so the token is not left in the clone's
//      git config for later steps to read.
//   3. Both Lambda placeholder-fallback branches (lambda.ts's `lambdaCode()`
//      and signup-cascade.ts's `cascadeCode()`) delegate to the shared
//      `resolveLambdaArtifact()` (lambda-artifact.ts), whose shell fallback is
//      reachable ONLY under `pulumi.runtime.isDryRun()` (a `pulumi preview`); a
//      real `pulumi up` with the artifact incomplete throws, naming the build
//      command, instead of silently deploying a non-functional shell. This is a
//      SEMANTIC assertion (preview-only shell + real-up throw), not source-wide
//      fallback absence.
//   4. That shared resolver enforces FULL coverage: it validates EVERY one of
//      the six deployed handler files (not just one primary handler), so a
//      partial artifact — the primary handler present but a sibling handler
//      file missing — is rejected on a real `pulumi up` (all six ship from
//      one shared build directory; Pulumi picks the per-Lambda entry from it).
//
// Runs under `pnpm test:scripts`. Pattern: scripts/test/csp-contract.test.mjs,
// scripts/test/jwt-key-age.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github', 'workflows');
const LAMBDA_SRC = resolve(REPO_ROOT, 'infrastructure', 'src', 'lambda.ts');
const CASCADE_SRC = resolve(
  REPO_ROOT,
  'infrastructure',
  'src',
  'signup-cascade.ts',
);
const ARTIFACT_SRC = resolve(
  REPO_ROOT,
  'infrastructure',
  'src',
  'lambda-artifact.ts',
);

// The six handler files that ship from the one shared artifact — the
// resolver must validate ALL of them. Mirrors DEPLOYED_HANDLERS in
// scripts/test/lambda-artifact-contract.test.mjs and DEPLOYED_HANDLER_FILES in
// infrastructure/src/lambda-artifact.ts.
const DEPLOYED_HANDLERS = [
  'lambda.js',
  'compactor-lambda.js',
  'janitor-lambda.js',
  'signup-cascade-lambda.js',
  'account-snapshot-purge-lambda.js',
  'health-check-probe-lambda.js',
];

function workflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(WORKFLOWS_DIR, f));
}

/**
 * Attribute every line under a workflow file's `jobs:` key to its owning
 * top-level job name, by indentation alone (2-space job keys under `jobs:`,
 * matching this repository's YAML style everywhere it's used) — no YAML
 * dependency, same house rule as the rest of this file. Returns a
 * `Map<jobName, { text, num }[]>`; a file with no `jobs:` key returns an
 * empty map.
 */
function jobLines(fileText) {
  const lines = fileText.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map();
  if (jobsIdx === -1) return jobs;
  let current = null;
  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^ */)[0].length;
    if (indent === 0) break; // dedented back out of the jobs: block
    const nameMatch = indent === 2 && line.match(/^ {2}([\w-]+):\s*$/);
    if (nameMatch) {
      current = nameMatch[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current).push({ text: line, num: i + 1 });
  }
  return jobs;
}

const isComment = (line) => /^\s*#/.test(line);

/**
 * The top-level `on:` block of a workflow (its own line plus every indented
 * line under it, comments and blanks dropped). Empty array when absent.
 */
function onBlock(fileText) {
  const lines = fileText.split('\n');
  const idx = lines.findIndex((l) => /^["']?on["']?:/.test(l));
  if (idx === -1) return [];
  const block = [lines[idx]];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || isComment(line)) continue;
    if (line.match(/^ */)[0].length === 0) break;
    block.push(line);
  }
  return block;
}

/** The indented lines under one trigger key (`  push:`) of the `on:` block. */
function triggerBlock(fileText, trigger) {
  const block = onBlock(fileText);
  const idx = block.findIndex((l) => new RegExp(`^ {2}${trigger}:`).test(l));
  if (idx === -1) return null;
  const out = [block[idx]];
  for (let i = idx + 1; i < block.length; i += 1) {
    if (block[i].match(/^ */)[0].length <= 2) break;
    out.push(block[i]);
  }
  return out;
}

/**
 * The `types:` list of the `pull_request` trigger, or null when it has none
 * (GitHub's default types — opened, synchronize, reopened — apply).
 */
function pullRequestTypes(fileText) {
  const block = triggerBlock(fileText, 'pull_request');
  if (!block) return null;
  const idx = block.findIndex((l) => /^\s+types:/.test(l));
  if (idx === -1) return null;
  const types = (block[idx].split('types:')[1] ?? '').match(/[a-z_]+/g) ?? [];
  const keyIndent = block[idx].match(/^ */)[0].length;
  for (let i = idx + 1; i < block.length; i += 1) {
    if (block[i].match(/^ */)[0].length <= keyIndent) break;
    types.push(...(block[i].match(/[a-z_]+/g) ?? []));
  }
  return types;
}

/**
 * A job-level (4-space) key's value, with folded/continued lines joined and
 * comments dropped; null when the job has no such key.
 */
function jobKey(lines, key) {
  const idx = lines.findIndex((l) => new RegExp(`^ {4}${key}:`).test(l.text));
  if (idx === -1) return null;
  const parts = [lines[idx].text.replace(new RegExp(`^ {4}${key}:`), '')];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const t = lines[i].text;
    if (t.trim() === '' || isComment(t)) continue;
    if (t.match(/^ */)[0].length <= 4) break;
    parts.push(t.trim());
  }
  return parts
    .join(' ')
    .replace(/\s+#.*$/, '')
    .replace(/^\s*[>|][-+]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The job ids a job lists under `needs:` (inline list, scalar or block list). */
function jobNeeds(lines) {
  const value = jobKey(lines, 'needs');
  return value === null ? [] : (value.match(/[A-Za-z_][\w-]*/g) ?? []);
}

/** A job disabled with a bare `if: false`. */
function isDisabledJob(lines) {
  return jobKey(lines, 'if') === 'false';
}

const FORBIDDEN_TRIGGER_RE = /\b(pull_request_target|workflow_run|issue_comment)\b/;
const SECRETS_RE = /\bsecrets\.|\bsecrets:\s*inherit\b/;
const WRITE_PERMISSION_RE = /^\s*[\w-]+:\s*write\s*(#.*)?$|\bwrite-all\b/;
const LABEL_OR_FORK_RE = /\blabels\b|\bhead\.repo\b/;

/** Fork-safety violations of one workflow text (every workflow file). */
function forkSafetyViolations(fileText, file) {
  const violations = [];
  const lines = fileText.split('\n');
  for (const line of onBlock(fileText)) {
    const m = line.match(FORBIDDEN_TRIGGER_RE);
    if (m) violations.push(`${file} privileged trigger \`${m[1]}\``);
  }
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (SECRETS_RE.test(line)) violations.push(`${file}:${i + 1} secrets reference: ${line.trim()}`);
    if (WRITE_PERMISSION_RE.test(line)) violations.push(`${file}:${i + 1} write permission: ${line.trim()}`);
  });
  for (const [job, jLines] of jobLines(fileText)) {
    const cond = jobKey(jLines, 'if');
    if (cond !== null && LABEL_OR_FORK_RE.test(cond)) {
      violations.push(`${file} [job:${job}] label-based or fork-based \`if:\`: ${cond}`);
    }
  }
  return violations;
}

const indentOf = (line) => line.match(/^ */)[0].length;

/**
 * Whether the step whose `uses:` key is on line `index` has
 * `persist-credentials: false` among its own keys. A step's keys share one
 * indentation: the `uses:` key itself, or two columns past a `- ` marker when
 * `uses:` is the first key. Lines of the next step or job sit shallower.
 */
function stepDropsToken(lines, index) {
  const startsStep = /^\s*-\s/.test(lines[index]);
  const keyIndent = indentOf(lines[index]) + (startsStep ? 2 : 0);
  let from = index;
  if (!startsStep) {
    while (from > 0 && !(/^\s*-\s/.test(lines[from]) && indentOf(lines[from]) === keyIndent - 2)) from -= 1;
  }
  let to = index;
  for (let j = index + 1; j < lines.length; j += 1) {
    if (lines[j].trim() === '' || isComment(lines[j])) continue;
    if (indentOf(lines[j]) < keyIndent) break;
    to = j;
  }
  return lines.slice(from, to + 1).some((l) => /^\s*persist-credentials:\s*false\s*(#.*)?$/.test(l));
}

/** Runner and checkout violations of one workflow text (every workflow file). */
function runnerAndCheckoutViolations(fileText, file) {
  const violations = [];
  const lines = fileText.split('\n');
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const runner = line.match(/^\s*runs-on:\s*["']?([^\s"'#]+)/);
    if (runner && runner[1].endsWith('-latest')) {
      violations.push(`${file}:${i + 1} runs-on \`${runner[1]}\` floats to the next OS release; pin an image such as \`ubuntu-24.04\``);
    }
    const uses = line.match(USES_RE);
    if (uses && uses[1].startsWith('actions/checkout@') && !stepDropsToken(lines, i)) {
      violations.push(`${file}:${i + 1} actions/checkout must set \`persist-credentials: false\``);
    }
  });
  return violations;
}

// The variables that relax the dependency audit and the date-dependent tests on
// pull requests. Anything that sets them other than a `pull_request` event
// expression would leak the relaxation to `main` and manual runs.
const RELAXATION_VARS = ['AUDIT_ADVISORIES_NONBLOCKING', 'SKIP_REVIEW_BY_DATE_CHECK'];
const PR_EVENT_EXPR_RE = /\$\{\{[^}]*github\.event_name\s*==\s*'pull_request'[^}]*\}\}/;

/** Violations specific to ci.yml. */
function ciViolations(fileText, file) {
  const violations = [];
  const triggers = onBlock(fileText).join('\n');
  if (!/\bpull_request\b/.test(triggers)) {
    violations.push(`${file} has no \`pull_request\` trigger`);
  }
  const types = pullRequestTypes(fileText);
  if (types !== null && !types.includes('synchronize')) {
    violations.push(`${file} \`pull_request\` types [${types.join(', ')}] leave out \`synchronize\``);
  }
  const push = triggerBlock(fileText, 'push');
  if (!push || !/\bmain\b/.test(push.join('\n'))) {
    violations.push(`${file} has no \`push\` trigger restricted to \`main\``);
  }

  const jobs = jobLines(fileText);
  const aggregates = [...jobs].filter(([, jLines]) => jobKey(jLines, 'name') === 'All checks');
  if (aggregates.length !== 1) {
    violations.push(`${file} must have exactly one job named \`All checks\` (found ${aggregates.length})`);
  } else {
    const [id, jLines] = aggregates[0];
    if (jobKey(jLines, 'if') !== 'always()') {
      violations.push(`${file} [job:${id}] \`All checks\` must run under a bare \`if: always()\`, found \`${jobKey(jLines, 'if')}\``);
    }
    const expected = [...jobs]
      .filter(([other, otherLines]) => other !== id && !isDisabledJob(otherLines))
      .map(([other]) => other)
      .sort();
    const actual = [...new Set(jobNeeds(jLines))].sort();
    const missing = expected.filter((j) => !actual.includes(j));
    const extra = actual.filter((j) => !expected.includes(j));
    if (missing.length > 0) violations.push(`${file} [job:${id}] \`All checks\` does not need: ${missing.join(', ')}`);
    if (extra.length > 0) violations.push(`${file} [job:${id}] \`All checks\` needs unknown or disabled jobs: ${extra.join(', ')}`);
  }

  fileText.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    for (const name of RELAXATION_VARS) {
      if (!line.includes(name)) continue;
      const yamlAssign = line.match(new RegExp(`^\\s*${name}:\\s*(.*)$`));
      if (yamlAssign && !PR_EVENT_EXPR_RE.test(yamlAssign[1])) {
        violations.push(`${file}:${i + 1} ${name} must be set from a \`github.event_name == 'pull_request'\` expression: ${line.trim()}`);
      }
      if (new RegExp(`\\b${name}=`).test(line)) {
        violations.push(`${file}:${i + 1} ${name} must not be assigned in a script: ${line.trim()}`);
      }
    }
  });
  return violations;
}

// A `uses:` value, ignoring a trailing `# comment`. Local (`./...`) and Docker
// (`docker://...`) references are not tag-pinnable and are exempt.
const USES_RE = /^\s*(?:-\s*)?uses:\s*(\S+)/;
const SHA_PIN_RE = /^[^@\s]+@[0-9a-f]{40}$/;
const AWS_CREDS_RE = /aws-actions\/configure-aws-credentials/;
const SHELL_INSTALLER_RE = /\|\s*sh\b/;
// The three build helpers (lib/deploy-common.sh), the `build:lambda` script
// name, and a literal `pnpm --filter @retirement/web ... build` / `vite
// build` invocation — anything that would re-introduce an application build
// into a credentialed job, inline in the workflow YAML.
const APPLICATION_BUILD_RE =
  /\bbuild_lambda\b|\bcompute_build_id\b|\bbuild_spa\b|\bbuild:lambda\b|pnpm[^\n]*--filter\s+@retirement\/web[^\n]*\bbuild\b|\bvite build\b/;
const ID_TOKEN_GRANT_RE = /id-token:\s*write/;

test('every workflow `uses:` is pinned to a full 40-hex commit SHA', () => {
  const offenders = [];
  for (const file of workflowFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(USES_RE);
      if (!m) return;
      const ref = m[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) return;
      if (!SHA_PIN_RE.test(ref)) {
        offenders.push(`${file}:${i + 1}  ${ref}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `every workflow action must be pinned to a 40-char SHA; unpinned:\n${offenders.join('\n')}`,
  );
});

test('no job that acquires AWS credentials runs an application build command or a remote shell installer', () => {
  // Scope every check to the credentialed job's own lines: which JOB a line
  // belongs to matters, not its line number in the file.
  const violations = [];
  for (const file of workflowFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const [job, lines] of jobLines(text)) {
      const hasCreds = lines.some((l) => AWS_CREDS_RE.test(l.text));
      if (!hasCreds) continue; // this job never acquires AWS credentials
      for (const { text: lineText, num } of lines) {
        if (/^\s*#/.test(lineText)) continue; // a comment EXPLAINING the rule is not a violation of it
        if (SHELL_INSTALLER_RE.test(lineText)) {
          violations.push(`${file}:${num} [job:${job}] shell installer: ${lineText.trim()}`);
        }
        if (APPLICATION_BUILD_RE.test(lineText)) {
          violations.push(`${file}:${num} [job:${job}] application build command: ${lineText.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `a credentialed job must run no application build command and no shell installer:\n${violations.join('\n')}`,
  );
});

test('no job without AWS credentials carries `id-token`, and no workflow-level `permissions:` block grants one', () => {
  const violations = [];
  for (const file of workflowFiles()) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    const preambleEnd = jobsIdx === -1 ? lines.length : jobsIdx;
    // A workflow-level `id-token: write` (BEFORE `jobs:`, at any indent under
    // a top-level `permissions:` key) grants it to every job that doesn't
    // override it — a job without credentials must not inherit `id-token`
    // this way. A workflow-level `permissions:` block that grants
    // something else (e.g. `contents: read`, as ci.yml's least-privilege
    // default does) is fine; only an id-token grant here is the violation.
    for (let i = 0; i < preambleEnd; i += 1) {
      if (ID_TOKEN_GRANT_RE.test(lines[i])) {
        violations.push(
          `${file}:${i + 1} workflow-level \`permissions:\` block grants \`id-token\` to every job implicitly`,
        );
      }
    }
    for (const [job, jLines] of jobLines(text)) {
      const hasCreds = jLines.some((l) => AWS_CREDS_RE.test(l.text));
      if (hasCreds) continue;
      for (const { text: lineText, num } of jLines) {
        if (ID_TOKEN_GRANT_RE.test(lineText)) {
          violations.push(`${file}:${num} [job:${job}] carries \`id-token\` but never acquires AWS credentials`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

// Semantic fail-closed guard: the shell fallback is preview-only, and a real
// `pulumi up` with the artifact incomplete throws, naming the build command.
// The invariant now lives in the shared resolver (lambda-artifact.ts); both
// entry-point resolvers delegate to it. Regex-locks: a `!pulumi.runtime
// .isDryRun()` branch that throws an Error mentioning `build:lambda`.
const FAIL_CLOSED_RE =
  /!pulumi\.runtime\.isDryRun\(\)\s*\)\s*{[\s\S]*?throw new Error\([\s\S]*?build:lambda/;

test('the shared resolver deploys the shell only under a dry run, throwing on a real `pulumi up`', () => {
  const source = readFileSync(ARTIFACT_SRC, 'utf8');
  assert.match(
    source,
    /pulumi\.runtime\.isDryRun\(\)/,
    'lambda-artifact.ts must gate its shell fallback on pulumi.runtime.isDryRun()',
  );
  assert.match(
    source,
    FAIL_CLOSED_RE,
    'lambda-artifact.ts must throw (naming `build:lambda`) on a real `pulumi up` with the artifact incomplete',
  );
});

test('lambda.ts and signup-cascade.ts route their artifact through the shared fail-closed resolver', () => {
  for (const src of [LAMBDA_SRC, CASCADE_SRC]) {
    const source = readFileSync(src, 'utf8');
    assert.match(
      source,
      /import\s*{\s*resolveLambdaArtifact\s*}\s*from\s*["']\.\/lambda-artifact["']/,
      `${src} must import resolveLambdaArtifact from ./lambda-artifact`,
    );
    assert.match(
      source,
      /resolveLambdaArtifact\s*\(/,
      `${src} must resolve its Lambda artifact via the shared resolver (no bespoke single-file existence check)`,
    );
    // The old single-file check (`existsSync(... "lambda.js")` /
    // `signup-cascade-lambda.js`) that accepted a partial artifact must be gone.
    assert.doesNotMatch(
      source,
      /fs\.existsSync/,
      `${src} must not re-implement its own existence check — the full-coverage invariant lives only in the shared resolver`,
    );
  }
});

test('the shared resolver validates ALL six deployed handler files (full-coverage fail-closed)', () => {
  const source = readFileSync(ARTIFACT_SRC, 'utf8');
  // Reject the pre-fix behavior: a check keyed off only ONE primary handler
  // would let a partial artifact (that handler present, a sibling missing)
  // deploy. Every deployed handler must be named in the resolver's required
  // set so the resolver rejects any missing one.
  for (const handler of DEPLOYED_HANDLERS) {
    assert.ok(
      source.includes(`"${handler}"`),
      `lambda-artifact.ts must validate the presence of ${handler} (all six ship from the one shared artifact)`,
    );
  }
  // And the missing-file computation must drive the resolver's decision.
  assert.match(
    source,
    /missingHandlerFiles/,
    'the resolver must key its fail-closed decision off the full missing-handler set, not a single-file existence check',
  );
});

test('every workflow is fork-safe: no privileged trigger, no secrets, no write permission, no label/fork `if:`', () => {
  const violations = workflowFiles().flatMap((file) =>
    forkSafetyViolations(readFileSync(file, 'utf8'), file),
  );
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('ci.yml triggers on every PR push and on main, aggregates under `All checks`, and keeps the relaxations PR-only', () => {
  const file = join(WORKFLOWS_DIR, 'ci.yml');
  const violations = ciViolations(readFileSync(file, 'utf8'), file);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('every workflow pins its runner image and every checkout drops the token', () => {
  const violations = workflowFiles().flatMap((file) =>
    runnerAndCheckoutViolations(readFileSync(file, 'utf8'), file),
  );
  assert.deepEqual(violations, [], violations.join('\n'));
});

// The rules above passing on the real workflows proves nothing about the rules
// themselves: each is run here against a small workflow that breaks it.
const MINI_CI = `name: CI
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  suite-a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  suite-b:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: echo b
  all-checks:
    name: All checks
    runs-on: ubuntu-latest
    needs: [suite-a]
    if: always()
    steps:
      - run: echo done
`;

function mutate(from, to) {
  assert.ok(MINI_CI.includes(from), `fixture lacks ${from}`);
  return MINI_CI.replace(from, to);
}

const allViolations = (text) => [
  ...forkSafetyViolations(text, 'mini.yml'),
  ...ciViolations(text, 'mini.yml'),
];

test('the guard rules accept a well-formed workflow', () => {
  assert.deepEqual(allViolations(MINI_CI), []);
});

test('the guard rules accept the PR-only relaxation variables set from a pull_request expression', () => {
  const text = mutate(
    '    runs-on: ubuntu-latest\n    steps:\n      - run: echo a',
    `    runs-on: ubuntu-latest
    env:
      SKIP_REVIEW_BY_DATE_CHECK: \${{ github.event_name == 'pull_request' && '1' || '' }}
      AUDIT_ADVISORIES_NONBLOCKING: \${{ github.event_name == 'pull_request' && steps.deps.outputs.changed != 'true' }}
    steps:
      - run: echo a`,
  );
  assert.deepEqual(allViolations(text), []);
});

const BROKEN_WORKFLOWS = [
  ['a pull_request_target trigger', mutate('  pull_request:\n', '  pull_request_target:\n'), /privileged trigger `pull_request_target`/],
  ['a workflow_run trigger', mutate('  workflow_dispatch:\n', '  workflow_dispatch:\n  workflow_run:\n    workflows: [CI]\n'), /privileged trigger `workflow_run`/],
  ['an issue_comment trigger', mutate('  workflow_dispatch:\n', '  workflow_dispatch:\n  issue_comment:\n'), /privileged trigger `issue_comment`/],
  ['a secrets reference', mutate('      - run: echo a', '      - run: echo ${{ secrets.TOKEN }}'), /secrets reference/],
  ['a job with pull-requests: write', mutate('  suite-a:\n    runs-on: ubuntu-latest\n', '  suite-a:\n    runs-on: ubuntu-latest\n    permissions:\n      pull-requests: write\n'), /write permission: pull-requests: write/],
  ['a workflow-level write permission', mutate('  contents: read\n', '  contents: write\n'), /write permission: contents: write/],
  ['a label-based job condition', mutate('  suite-a:\n    runs-on: ubuntu-latest\n', "  suite-a:\n    runs-on: ubuntu-latest\n    if: contains(github.event.pull_request.labels.*.name, 'some-label')\n"), /label-based or fork-based/],
  ['a fork-based job condition (folded)', mutate('  suite-a:\n    runs-on: ubuntu-latest\n', '  suite-a:\n    runs-on: ubuntu-latest\n    if: >-\n      github.event.pull_request.head.repo.full_name == github.repository\n'), /label-based or fork-based/],
  ['a pull_request trigger limited to labeled', mutate('  pull_request:\n', '  pull_request:\n    types: [labeled]\n'), /leave out `synchronize`/],
  ['a pull_request block-list of types without synchronize', mutate('  pull_request:\n', '  pull_request:\n    types:\n      - opened\n      - reopened\n'), /leave out `synchronize`/],
  ['a missing push trigger', mutate('  push:\n    branches: [main]\n', ''), /no `push` trigger restricted to `main`/],
  ['a push trigger not restricted to main', mutate('branches: [main]', 'branches: [release]'), /no `push` trigger restricted to `main`/],
  ['an aggregate under !cancelled()', mutate('    if: always()\n', '    if: ${{ !cancelled() }}\n'), /bare `if: always\(\)`/],
  ['an aggregate with an extra condition', mutate('    if: always()\n', "    if: always() && github.event_name == 'push'\n"), /bare `if: always\(\)`/],
  ['an aggregate with no if', mutate('    if: always()\n', ''), /bare `if: always\(\)`/],
  ['an aggregate missing a suite in needs', mutate('  all-checks:\n', '  suite-c:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo c\n  all-checks:\n'), /does not need: suite-c/],
  ['an aggregate needing a disabled job', mutate('needs: [suite-a]', 'needs: [suite-a, suite-b]'), /needs unknown or disabled jobs: suite-b/],
  ['no All checks job', mutate('    name: All checks\n', '    name: Aggregate\n'), /exactly one job named `All checks`/],
  ['the date-check variable set unconditionally', mutate('    runs-on: ubuntu-latest\n    steps:\n      - run: echo a', '    runs-on: ubuntu-latest\n    env:\n      SKIP_REVIEW_BY_DATE_CHECK: "1"\n    steps:\n      - run: echo a'), /SKIP_REVIEW_BY_DATE_CHECK must be set from a `github.event_name == 'pull_request'`/],
  ['the audit variable set from a push expression', mutate('    runs-on: ubuntu-latest\n    steps:\n      - run: echo a', "    runs-on: ubuntu-latest\n    env:\n      AUDIT_ADVISORIES_NONBLOCKING: ${{ github.event_name == 'push' }}\n    steps:\n      - run: echo a"), /AUDIT_ADVISORIES_NONBLOCKING must be set from/],
  ['a relaxation variable assigned in a script', mutate('      - run: echo a', '      - run: echo "SKIP_REVIEW_BY_DATE_CHECK=1" >> "$GITHUB_ENV"'), /must not be assigned in a script/],
];

for (const [name, text, expected] of BROKEN_WORKFLOWS) {
  test(`the guard reports ${name}`, () => {
    const violations = allViolations(text);
    assert.ok(
      violations.some((v) => expected.test(v)),
      `expected a violation matching ${expected}, got:\n${violations.join('\n') || '(none)'}`,
    );
  });
}

// The runner and checkout rule, run against small jobs that break it. This
// rule does not look at pinning, so any 40-hex value stands in for the SHA.
const CHECKOUT_USES = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7';

const PINNED_JOB = `jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${CHECKOUT_USES}
        with:
          fetch-depth: 2
          persist-credentials: false
      - run: echo a
`;

const nameFirstJob = (withFlag) => `jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - name: Get the code
        uses: ${CHECKOUT_USES}
        with:
          fetch-depth: 2${withFlag ? '\n          persist-credentials: false' : ''}
      - run: echo a
`;

const FLAG_IN_NEXT_STEP = `jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${CHECKOUT_USES}
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6
        with:
          persist-credentials: false
`;

function swap(text, from, to) {
  assert.ok(text.includes(from), `fixture lacks ${from}`);
  return text.replace(from, to);
}

test('the runner and checkout rule accepts a pinned runner and checkouts that drop the token', () => {
  for (const text of [PINNED_JOB, nameFirstJob(true), `${PINNED_JOB}# runs-on: ubuntu-latest\n`]) {
    assert.deepEqual(runnerAndCheckoutViolations(text, 'mini.yml'), []);
  }
});

const BROKEN_RUNNERS_AND_CHECKOUTS = [
  ['a floating Ubuntu runner', swap(PINNED_JOB, 'ubuntu-24.04', 'ubuntu-latest'), /runs-on `ubuntu-latest` floats/],
  ['a floating runner of another OS', swap(PINNED_JOB, 'ubuntu-24.04', 'macos-latest'), /runs-on `macos-latest` floats/],
  ['a checkout with no with: block', swap(PINNED_JOB, '        with:\n          fetch-depth: 2\n          persist-credentials: false\n', ''), /must set `persist-credentials: false`/],
  ['a checkout whose with: block lacks the flag', swap(PINNED_JOB, '          persist-credentials: false\n', ''), /must set `persist-credentials: false`/],
  ['a checkout that keeps the token', swap(PINNED_JOB, 'persist-credentials: false', 'persist-credentials: true'), /must set `persist-credentials: false`/],
  ['a checkout written with its name first and no flag', nameFirstJob(false), /must set `persist-credentials: false`/],
  ['a checkout whose flag sits in the next step', FLAG_IN_NEXT_STEP, /must set `persist-credentials: false`/],
];

for (const [name, text, expected] of BROKEN_RUNNERS_AND_CHECKOUTS) {
  test(`the runner and checkout rule reports ${name}`, () => {
    const violations = runnerAndCheckoutViolations(text, 'mini.yml');
    assert.ok(
      violations.some((v) => expected.test(v)),
      `expected a violation matching ${expected}, got:\n${violations.join('\n') || '(none)'}`,
    );
  });
}
