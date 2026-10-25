// bootstrap-stack.sh's `jwt_key_age_months` is extracted as text and run under bash: a kid older than 3 months warns,
// the current month does not, and an unparseable kid is -1.

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

// The function definition: from the `name() {` line through the first column-0 closing brace.
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

// Age in months for a kid, or -1.
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
  // Always > 3 once the calendar is past 2026-04.
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
  // Month 09 would fail an octal parse.
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
