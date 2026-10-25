// `SCHEMA_VERSION_CEILING` in apps/api/src/sync/dto/push.dto.ts must equal the REGISTRY maximum + 1 in apps/web/src/db/migrations.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS_PATH } from '../check-schema-not-ahead.mjs';
import {
  checkCeilingMatches,
  maxRegistryVersion,
  PUSH_DTO_PATH,
  readDeclaredCeiling,
} from '../check-schema-version-ceiling.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

const FIXTURE_REGISTRY = `
const REGISTRY: Record<AggregateType, Registry> = {
  household: { current: 1, migrations: {} },
  account: { current: 7, migrations: {} },
  scenario: { current: 9, migrations: {} },
};
`;

test('maxRegistryVersion returns the highest current across a fixture registry', () => {
  assert.equal(maxRegistryVersion(FIXTURE_REGISTRY), 9);
});

test('readDeclaredCeiling parses the exported numeric literal', () => {
  const src = "export const SCHEMA_VERSION_CEILING = 10;\n";
  assert.equal(readDeclaredCeiling(src), 10);
});

test('readDeclaredCeiling throws when the declaration is missing (fail loud, never guess)', () => {
  assert.throws(() => readDeclaredCeiling('export const SOMETHING_ELSE = 10;\n'), /could not find/);
});

test('checkCeilingMatches: ok when the declared ceiling is exactly max + 1', () => {
  const result = checkCeilingMatches(FIXTURE_REGISTRY, 'export const SCHEMA_VERSION_CEILING = 10;\n');
  assert.equal(result.ok, true);
});

test('checkCeilingMatches: reports a mismatch when the declared ceiling drifts behind a REGISTRY bump', () => {
  const bumped = FIXTURE_REGISTRY.replace('current: 9', 'current: 10');
  const result = checkCeilingMatches(bumped, 'export const SCHEMA_VERSION_CEILING = 10;\n');
  assert.equal(result.ok, false);
  assert.match(result.message, /should be 11/);
});

test('checkCeilingMatches: reports a mismatch when the declared ceiling is ahead of the REGISTRY', () => {
  const result = checkCeilingMatches(FIXTURE_REGISTRY, 'export const SCHEMA_VERSION_CEILING = 999;\n');
  assert.equal(result.ok, false);
});

// The real-file check: this is what actually survives the next schema bump.
test('the working tree: SCHEMA_VERSION_CEILING matches migrations.ts REGISTRY maximum + 1', () => {
  const migrationsSource = readFileSync(resolve(REPO_ROOT, MIGRATIONS_PATH), 'utf8');
  const pushDtoSource = readFileSync(resolve(REPO_ROOT, PUSH_DTO_PATH), 'utf8');
  const result = checkCeilingMatches(migrationsSource, pushDtoSource);
  assert.equal(result.ok, true, result.message);
});
