#!/usr/bin/env node

// Cross-checks the API's push `schemaVersion` ceiling
// (`SCHEMA_VERSION_CEILING` in apps/api/src/sync/dto/push.dto.ts) against
// the highest `current` version in apps/web/src/db/migrations.ts's REGISTRY.
// The ceiling must equal that maximum PLUS ONE — the `+1` slack is what lets `ALLOW_SCHEMA_AHEAD=1`
// deploy a bundle carrying the next schema version (see
// check-schema-not-ahead.mjs) without every push from that bundle being
// rejected here.
//
// The ceiling is a hand-written constant (the API cannot import the
// web-only migrations.ts at runtime), so nothing enforces it automatically
// when a REGISTRY bump lands without a matching push.dto.ts edit — this is
// that enforcement, run by `pnpm test:scripts`. It reuses
// check-schema-not-ahead.mjs's own REGISTRY parser rather than a second
// copy, so the two guards can never disagree about what the block says.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MIGRATIONS_PATH, parseRegistryVersions } from './check-schema-not-ahead.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUSH_DTO_PATH = 'apps/api/src/sync/dto/push.dto.ts';
const CEILING_RE = /SCHEMA_VERSION_CEILING\s*=\s*(\d+)\s*;/;

/** The highest `current` version across every aggregate in the REGISTRY. */
export function maxRegistryVersion(migrationsSource) {
  const versions = Object.values(parseRegistryVersions(migrationsSource));
  return Math.max(...versions);
}

/**
 * Parse the declared `SCHEMA_VERSION_CEILING` numeric literal out of
 * push.dto.ts source. Throws — never returns a guessed value — when the
 * declaration is missing or reshaped, so a drifted parser fails loudly
 * rather than silently comparing against nothing.
 */
export function readDeclaredCeiling(pushDtoSource, label = PUSH_DTO_PATH) {
  const m = pushDtoSource.match(CEILING_RE);
  if (!m) {
    throw new Error(
      `${label}: could not find \`export const SCHEMA_VERSION_CEILING = <number>;\`. If it was ` +
        'renamed or reshaped, update scripts/check-schema-version-ceiling.mjs to match.',
    );
  }
  return Number(m[1]);
}

/**
 * Compare the declared ceiling to `maxRegistryVersion(migrationsSource) + 1`.
 * Returns `{ ok, message }` rather than throwing, so the CLI can report a
 * clean mismatch instead of a stack trace.
 */
export function checkCeilingMatches(migrationsSource, pushDtoSource) {
  const expected = maxRegistryVersion(migrationsSource) + 1;
  const declared = readDeclaredCeiling(pushDtoSource);
  if (declared === expected) {
    return {
      ok: true,
      message: `OK: SCHEMA_VERSION_CEILING (${declared}) matches the REGISTRY maximum + 1.`,
    };
  }
  return {
    ok: false,
    message:
      `SCHEMA_VERSION_CEILING is ${declared} but the REGISTRY's highest \`current\` version is ` +
      `${expected - 1}, so the ceiling should be ${expected}. Update ${PUSH_DTO_PATH}.`,
  };
}

function readTreeSource(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** The CLI body, exported so its exit code and output are testable directly. */
export function runCli(readTree = readTreeSource, log = console.error) {
  let result;
  try {
    result = checkCeilingMatches(readTree(MIGRATIONS_PATH), readTree(PUSH_DTO_PATH));
  } catch (error) {
    log(error.message);
    return 1;
  }
  log(result.message);
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = runCli();
}
