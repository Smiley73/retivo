// JWT key-age warning regression guard.
//
// bootstrap-stack.sh prints a non-blocking deploy-time warning when the
// newest JWT signing key (kid format `key-YYYYMM`) is more than 3 months
// old. The kid-age arithmetic is factored into a pure-shell helper,
// `jwt_key_age_months`, so it can be exercised in isolation here without a
// real AWS/Pulumi environment.
//
// We extract the function definition from the script as text, source it in a
// `bash` subshell, and assert the computed age for fixed sample kids:
//
//   - `key-202601`        → 5 months old at today's date (2026-06) → warns (>3)
//   - `key-<current YYYYMM>` → 0 months old → no warning
//   - an unparseable kid   → -1 (age undetermined sentinel)
//
// No infra harness, no new dependency, infrastructure/ code untouched. Runs
// under `pnpm test:scripts` (already invoked by `pnpm test`). Lives in
// scripts/test/ so Node's test runner does not match the built-in
// `test-*.mjs` discovery glob. Pattern: scripts/test/csp-contract.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SRC = resolve(
  __dirname,
  '../../infrastructure/scripts/bootstrap-stack.sh',
);
const SOURCE = readFileSync(BOOTSTRAP_SRC, 'utf8');

// Pull the `jwt_key_age_months` function definition out of the script as text
// (from the `name() {` line through the first column-0 closing brace).
function extractFunction(name) {
  const lines = SOURCE.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `${name} must exist in bootstrap-stack.sh`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  assert.notEqual(end, -1, `${name} must have a column-0 closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

const FN = extractFunction('jwt_key_age_months');

// Source the extracted function in a bash subshell and print its result for
// the given kid. Returns the integer age (or -1 sentinel).
function ageMonths(kid) {
  const script = `${FN}\njwt_key_age_months ${JSON.stringify(kid)}\n`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return Number(out.trim());
}

function currentYyyymm() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

test('jwt_key_age_months: an old kid (key-202601) reports > 3 months → warns', () => {
  const age = ageMonths('key-202601');
  // 2026-01 vs today (2026-06 at authoring) is 5 months; always > 3 once the
  // calendar is past 2026-04, which is the only window this warning matters in.
  assert.ok(
    age > 3,
    `expected key-202601 to be > 3 months old (got ${age}); the >3 warning must fire`,
  );
});

test('jwt_key_age_months: a kid minted this month reports 0 → no warning', () => {
  const age = ageMonths(`key-${currentYyyymm()}`);
  assert.equal(
    age,
    0,
    'a key minted in the current month must be 0 months old (no warning)',
  );
});

test('jwt_key_age_months: an unparseable kid reports the -1 sentinel', () => {
  assert.equal(
    ageMonths('not-a-key'),
    -1,
    'a kid without a trailing YYYYMM must report -1 (age undetermined)',
  );
});

test('jwt_key_age_months: a leading-zero month is parsed as base-10', () => {
  // key-202509 → Sep 2025. Guards against octal-parse / leading-zero bugs.
  const age = ageMonths('key-202509');
  assert.ok(
    Number.isInteger(age) && age > 0,
    `key-202509 must parse to a positive integer age (got ${age})`,
  );
});

test('jwt_key_age_months: a kid with wrong prefix reports -1 sentinel', () => {
  assert.equal(
    ageMonths('foo-202601'),
    -1,
    'a kid that does not start with "key-" must report -1 (age undetermined)',
  );
});

test('jwt_key_age_months: a kid with an invalid month (13) reports -1 sentinel', () => {
  assert.equal(
    ageMonths('key-202613'),
    -1,
    'a kid with month > 12 must report -1 (invalid format)',
  );
});
