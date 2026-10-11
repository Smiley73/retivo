#!/usr/bin/env node

// Deploy preflight: refuse to ship a web bundle whose aggregate schema
// versions are AHEAD of `origin/main`.
//
// Why this exists (2026-08-04 dev incident): a branch build carrying
// `account.current = 7` was deployed to the shared dev stack. An edit made
// there wrote a row at `schemaVersion: 7`. The branch later shipped with
// `current` back at 6, and no bundle that will ever ship knows v7 — so the
// sync client's `assertNoSchemaAhead` (apps/web/src/sync/pull-apply.ts)
// halts every pull for that workspace, permanently. Reloading cannot fix it.
// The client behaviour is correct; the gap was that nothing stopped the
// schema-ahead build from reaching a shared environment.
//
// Exit 0 with a one-line all-clear when every aggregate's `current` is equal
// to or behind `origin/main`. Exit 1 naming the aggregates otherwise.
// `ALLOW_SCHEMA_AHEAD=1` downgrades the refusal to a loud warning, for the
// legitimate case where the branch really does carry the next schema version;
// it is announced even on a clean tree, because an armed override is a
// standing risk the deploy log should record.
//
// Every outcome prints something on purpose: a silent pass is
// indistinguishable from a guard that never ran, which is precisely how a
// broken CLI entry condition hid here once already.
//
// Parsing note: migrations.ts is TypeScript, so it cannot be imported here.
// The REGISTRY block is extracted textually — and every step of that
// extraction throws rather than returning a partial answer, because a guard
// that quietly finds nothing is worse than no guard at all. Every shape check
// inside that extraction compares the block against ITSELF, so a source that
// hides whole entries from the scanner satisfies all of them and comes back
// silently short. The independent check on that is the aggregate INVENTORY
// (`ACTIVE_AGGREGATE_TYPES_LIST` in packages/contracts) — a second file, with
// its own comments — which each ref's registry must match exactly.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_PATH = 'apps/web/src/db/migrations.ts';
export const ACTIVE_TYPES_PATH = 'packages/contracts/src/aggregate-types.ts';
export const BASE_REF = 'origin/main';
export const OVERRIDE_ENV = 'ALLOW_SCHEMA_AHEAD';

// The two prefixes below are the ONLY marks that say "this stopped before
// Pulumi started, so nothing reached AWS and no stack is half-changed". Every
// message that stops a deploy is built from one of them (see `report`,
// `runCli`, and `assertEntryGateSupported`), so a reworded message cannot leave
// its marker behind — and a reader grepping a deploy log for these two never
// misreads a refusal as a partial deploy.
const REFUSAL_MARKER = 'Refusing to deploy:';
const PREFLIGHT_FAILED_MARKER = 'Schema-ahead preflight failed:';

/** Every marker a pre-Pulumi stop can carry. Exported so the test suite can
 *  pair them against the outcomes the code actually emits, rather than against
 *  a copy of the text. */
export const PRE_PULUMI_STOP_MARKERS = Object.freeze([REFUSAL_MARKER, PREFLIGHT_FAILED_MARKER]);

const REGISTRY_START_RE =
  /const\s+REGISTRY\s*:\s*Record<\s*AggregateType\s*,\s*Registry\s*>\s*=\s*\{/;
const ACTIVE_TYPES_START_RE = /const\s+ACTIVE_AGGREGATE_TYPES_LIST\s*=\s*\[/;

/** Strip block + line comments so brace matching and key scanning never see
 *  prose. The REGISTRY block carries long explanatory comments (several of
 *  which mention version numbers such as "stays at 6"), so this must run
 *  before anything reads a `current:` value. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Return the text INSIDE the delimiters of the block starting at `openIndex`
 *  (which must be `open`), plus the index just past its closing delimiter.
 *  Throws when the block never closes. */
function matchDelimited(source, openIndex, label, open = '{', close = '}') {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return { inner: source.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  const noun = open === '[' ? 'brackets' : 'braces';
  throw new Error(`${label}: unbalanced ${noun} — the block opened at index ${openIndex} never closes.`);
}

/** Index of the first depth-zero `...` spread in `text`, or -1. */
function findTopLevelSpread(text, depths) {
  for (let i = 0; i + 2 < text.length; i += 1) {
    if (depths[i] === 0 && text.startsWith('...', i)) return i;
  }
  return -1;
}

/** Brace depth immediately BEFORE each character of `text`. */
function depthMap(text) {
  const depths = new Array(text.length);
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    depths[i] = depth;
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
  }
  return depths;
}

/**
 * Parse `{ aggregateName: currentVersion }` out of migrations.ts source.
 *
 * Fails loudly — never returns a partial or empty map — when:
 *  - the `const REGISTRY: Record<AggregateType, Registry> = {` declaration is
 *    absent (renamed, reformatted, or moved to another file),
 *  - the block never closes,
 *  - it spreads another object at top level (`...BASE_REGISTRY,`), whose
 *    aggregates carry no key here and would vanish unnoticed,
 *  - it yields zero aggregates,
 *  - a top-level key is not an object literal (so its version could not be
 *    read): the count of top-level `name:` keys must equal the count of parsed
 *    entries,
 *  - an entry carries no `current: <integer>`, or carries more than one,
 *  - the number of `current:` occurrences in the whole block does not equal
 *    the number of entries (a nested or stray `current` reshaped the block).
 */
export function parseRegistryVersions(source, label = MIGRATIONS_PATH) {
  const clean = stripComments(source);
  const start = clean.match(REGISTRY_START_RE);
  if (!start) {
    throw new Error(
      `${label}: could not find the \`const REGISTRY: Record<AggregateType, Registry> = {\` ` +
        'declaration. If the registry was renamed, reformatted, or moved, update ' +
        'scripts/check-schema-not-ahead.mjs to match — this guard must never pass by default.',
    );
  }
  const openIndex = start.index + start[0].length - 1;
  const { inner } = matchDelimited(clean, openIndex, label);
  const depths = depthMap(inner);

  // A depth-zero spread merges aggregates this parser cannot see: it carries no
  // `name:` key, so NONE of the three count-based shape checks below notices
  // it, and every aggregate it contributes would silently drop out of the
  // comparison — the partial answer the fail-loud contract forbids.
  const spreadIndex = findTopLevelSpread(inner, depths);
  if (spreadIndex !== -1) {
    throw new Error(
      `${label}: the REGISTRY block spreads another object at top level (\`...\` at index ` +
        `${spreadIndex}); the aggregates it contributes cannot be read here. Update ` +
        'scripts/check-schema-not-ahead.mjs — this guard must never pass by default.',
    );
  }

  const keyRe = /([A-Za-z_$][\w$]*)\s*:/g;
  const topLevelKeys = [];
  for (let m = keyRe.exec(inner); m !== null; m = keyRe.exec(inner)) {
    if (depths[m.index] === 0) topLevelKeys.push(m[1]);
  }

  const entryRe = /([A-Za-z_$][\w$]*)\s*:\s*\{/g;
  const versions = {};
  let entryCount = 0;
  for (let m = entryRe.exec(inner); m !== null; m = entryRe.exec(inner)) {
    if (depths[m.index] !== 0) continue;
    const name = m[1];
    const { inner: entryBody, end } = matchDelimited(inner, m.index + m[0].length - 1, label);
    entryRe.lastIndex = end;
    entryCount += 1;
    const currentMatches = [...entryBody.matchAll(/\bcurrent\s*:\s*(-?\d+)\b/g)];
    if (currentMatches.length !== 1) {
      throw new Error(
        `${label}: aggregate "${name}" has ${currentMatches.length} \`current: <number>\` ` +
          'entries in the REGISTRY block; expected exactly one. Update ' +
          'scripts/check-schema-not-ahead.mjs if the registry shape changed.',
      );
    }
    versions[name] = Number(currentMatches[0][1]);
  }

  if (entryCount === 0) {
    throw new Error(
      `${label}: parsed zero aggregates from the REGISTRY block. The block shape changed; ` +
        'update scripts/check-schema-not-ahead.mjs — this guard must never pass by default.',
    );
  }
  if (entryCount !== topLevelKeys.length) {
    throw new Error(
      `${label}: parsed ${entryCount} aggregate object(s) but the REGISTRY block has ` +
        `${topLevelKeys.length} top-level key(s) (${topLevelKeys.join(', ')}). At least one ` +
        'aggregate is no longer a plain object literal, so its schema version cannot be read. ' +
        'Update scripts/check-schema-not-ahead.mjs.',
    );
  }
  const totalCurrents = [...inner.matchAll(/\bcurrent\s*:/g)].length;
  if (totalCurrents !== entryCount) {
    throw new Error(
      `${label}: the REGISTRY block contains ${totalCurrents} \`current:\` key(s) for ` +
        `${entryCount} aggregate(s). The block shape changed; update ` +
        'scripts/check-schema-not-ahead.mjs.',
    );
  }
  return versions;
}

/**
 * Parse the aggregate names out of `ACTIVE_AGGREGATE_TYPES_LIST`
 * (packages/contracts/src/aggregate-types.ts) — the inventory both apps derive
 * from, and the independent second opinion on what the REGISTRY block must
 * contain.
 *
 * Fails loudly — never returns a partial or empty list — when the declaration
 * is absent, the array never closes, it yields zero names, it repeats a name,
 * or it contains anything other than single-quoted string literals (a spread, a
 * constant, or a template literal would contribute names this parser cannot
 * see, which is the same partial answer the fail-loud contract forbids).
 */
export function parseActiveAggregateTypes(source, label = ACTIVE_TYPES_PATH) {
  const clean = stripComments(source);
  const start = clean.match(ACTIVE_TYPES_START_RE);
  if (!start) {
    throw new Error(
      `${label}: could not find the \`const ACTIVE_AGGREGATE_TYPES_LIST = [\` declaration. If ` +
        'the inventory was renamed or moved, update scripts/check-schema-not-ahead.mjs to ' +
        'match — this guard must never pass by default.',
    );
  }
  const openIndex = start.index + start[0].length - 1;
  const { inner } = matchDelimited(clean, openIndex, label, '[', ']');

  const names = [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const residue = inner.replace(/'[^']*'/g, '');
  if (!/^[\s,]*$/.test(residue)) {
    throw new Error(
      `${label}: the ACTIVE_AGGREGATE_TYPES_LIST array contains something other than quoted ` +
        `aggregate names (leftover: ${JSON.stringify(residue.trim().slice(0, 80))}). The names ` +
        'it contributes cannot be read here; update scripts/check-schema-not-ahead.mjs.',
    );
  }
  if (names.length === 0) {
    throw new Error(
      `${label}: parsed zero aggregate names from ACTIVE_AGGREGATE_TYPES_LIST. The declaration ` +
        'shape changed; update scripts/check-schema-not-ahead.mjs — this guard must never pass ' +
        'by default.',
    );
  }
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `${label}: ACTIVE_AGGREGATE_TYPES_LIST repeats ${[...new Set(duplicates)].join(', ')}, so ` +
        'its name count cannot be trusted as a cross-check. Update the inventory.',
    );
  }
  return names;
}

/**
 * Require one ref's REGISTRY parse to match that SAME ref's active-type
 * inventory, exactly.
 *
 * This is the only check in the guard that is not the registry block marking
 * its own homework, and it must run on BOTH refs, because a short parse is
 * dangerous in both directions:
 *  - a short TREE parse hides a bumped aggregate from the comparison entirely
 *    (`findAheadAggregates` iterates the tree's keys), so a real bump reads as
 *    all clear;
 *  - a short BASE parse makes an aggregate the base ref really does declare
 *    look brand new, and brand-new types are deliberately skipped — which is
 *    how a tree at `account: 6` compared against a hidden base `account: 5`
 *    returned all clear.
 * Checking each registry against its own inventory catches both, and leaves
 * genuinely added / retired aggregate types to be handled where they belong:
 * by comparing only the types the two refs share.
 *
 * `REGISTRY: Record<AggregateType, Registry>` is typechecked against the same
 * union the inventory derives, so on a healthy ref the two agree exactly; any
 * disagreement here means one of the two parses came back short.
 */
export function assertRegistryMatchesInventory(versions, activeTypes, label) {
  const parsed = new Set(Object.keys(versions));
  const active = new Set(activeTypes);
  const missing = activeTypes.filter((name) => !parsed.has(name)).sort();
  const extra = Object.keys(versions)
    .filter((name) => !active.has(name))
    .sort();
  if (missing.length === 0 && extra.length === 0) return;
  const parts = [];
  if (missing.length > 0) parts.push(`missing from the registry parse: ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`missing from the inventory parse: ${extra.join(', ')}`);
  throw new Error(
    `${label}: the REGISTRY block and ACTIVE_AGGREGATE_TYPES_LIST disagree about which ` +
      `aggregates exist (${parts.join('; ')}). One of the two parses came back short — check ` +
      'both files for a comment shape that swallows entries — so the schema versions cannot be ' +
      'compared. This guard must never pass by default.',
  );
}

/**
 * Aggregates whose working-tree `current` is greater than the base ref's.
 *
 * Only the aggregate types BOTH refs declare are compared. A type present on
 * just one side is a genuine addition or retirement, not a version bump:
 *  - a brand-new type is safe, because an older bundle skips rows of a type it
 *    does not know at all (see `isKnownAggregateType` in
 *    apps/web/src/sync/pull-apply.ts), so it cannot cause the permanent sync
 *    halt this guard exists to prevent;
 *  - a retired type has no tree-side version to be ahead of anything.
 * Skipping the unshared types is only safe because `assertRegistryMatchesInventory`
 * has already proved, per ref, that "absent" means absent rather than unparsed.
 */
export function findAheadAggregates(treeVersions, baseVersions) {
  const ahead = [];
  for (const name of Object.keys(treeVersions).sort()) {
    const base = baseVersions[name];
    if (base === undefined) continue;
    if (treeVersions[name] > base) {
      ahead.push({ aggregate: name, tree: treeVersions[name], base });
    }
  }
  return ahead;
}

/** True when the deployer has explicitly opted out of the refusal. */
export function isOverrideEnabled(env) {
  return env[OVERRIDE_ENV] === '1';
}

function describe(ahead) {
  return ahead.map((a) => `${a.aggregate} ${a.tree} (${BASE_REF} has ${a.base})`).join(', ');
}

/**
 * Decide the outcome. Returns the process exit code plus the lines to print,
 * so the decision is testable without spawning a deploy.
 *
 * A clean run is never silent: it prints an all-clear line, so a completed
 * check is distinguishable from one that never ran. An armed override is
 * announced even when nothing is ahead, so the deploy log records that the
 * refusal was disabled for this run.
 */
export function report(ahead, overrideEnabled) {
  if (ahead.length === 0) {
    return {
      exitCode: 0,
      lines: [
        ...(overrideEnabled
          ? [`NOTE: ${OVERRIDE_ENV}=1 is armed — a schema-ahead build would be allowed to deploy.`]
          : []),
        `OK: no aggregate schema version is ahead of ${BASE_REF}.`,
      ],
    };
  }
  if (overrideEnabled) {
    return {
      exitCode: 0,
      lines: [
        `WARNING: ${OVERRIDE_ENV}=1 — deploying with aggregate schema versions ahead of ` +
          `${BASE_REF}: ${describe(ahead)}. Data written in this environment will be ` +
          'unreadable by any later build that does not carry these versions.',
      ],
    };
  }
  return {
    exitCode: 1,
    lines: [
      `${REFUSAL_MARKER} aggregate schema versions are ahead of ${BASE_REF}.`,
      ...ahead.map(
        (a) =>
          `- ${a.aggregate}: this tree is at version ${a.tree}, ${BASE_REF} is at ${a.base}`,
      ),
      '',
      'Anything saved in the target environment would be stored at the newer version. If this',
      'branch never merges, no future build will understand those rows, and syncing for that',
      'workspace stops for good — reloading does not repair it.',
      '',
      `Merge the schema change to main first, or set ${OVERRIDE_ENV}=1 to deploy anyway when`,
      'this branch really does carry the next schema version.',
    ],
  };
}

function runGit(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** What git actually said, so a corrupt object, a permission error, or a wrong
 *  working directory is not disguised as the one hypothesis we guessed at. */
function gitFailureDetail(error) {
  const stderr = error?.stderr;
  const text = (typeof stderr === 'string' ? stderr : (stderr?.toString?.() ?? '')).trim();
  return text || error?.message?.trim() || 'no output';
}

/**
 * Read a repo file as it exists on the base ref. Throws a message naming the
 * likely fix — and quoting git's own output, which may point at a different
 * cause entirely — when the ref is missing (no remote, shallow clone, never
 * fetched) or the file cannot be read there. Never falls back to "assume it
 * matches".
 */
export function readBaseSource(git = runGit, relPath = MIGRATIONS_PATH) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`]);
  } catch (error) {
    throw new Error(
      `cannot resolve ${BASE_REF}, so this deploy cannot be checked for schema-ahead data ` +
        'loss. Run `git fetch origin main` and ' +
        `try again. git said: ${gitFailureDetail(error)}`,
    );
  }
  try {
    return git(['show', `${BASE_REF}:${relPath}`]);
  } catch (error) {
    throw new Error(
      `cannot read ${relPath} at ${BASE_REF}. If the file moved, update ` +
        'scripts/check-schema-not-ahead.mjs to point at its new path. ' +
        `git said: ${gitFailureDetail(error)}`,
    );
  }
}

/** Read a repo file from the working tree. Injectable as `readTree`, like
 *  `git`, so the tree side of the comparison can be exercised without
 *  rewriting the real sources. */
function readTreeSource(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

export function checkSchemaNotAhead(env = process.env, git = runGit, readTree = readTreeSource) {
  // Each ref's registry is checked against that ref's OWN inventory before the
  // two refs are compared, so "this aggregate is absent" is a fact rather than
  // a parse artefact on either side. See `assertRegistryMatchesInventory` for
  // why both directions matter.
  const treeVersions = parseRegistryVersions(readTree(MIGRATIONS_PATH));
  assertRegistryMatchesInventory(
    treeVersions,
    parseActiveAggregateTypes(readTree(ACTIVE_TYPES_PATH)),
    'this working tree',
  );

  const baseVersions = parseRegistryVersions(
    readBaseSource(git, MIGRATIONS_PATH),
    `${MIGRATIONS_PATH} at ${BASE_REF}`,
  );
  assertRegistryMatchesInventory(
    baseVersions,
    parseActiveAggregateTypes(
      readBaseSource(git, ACTIVE_TYPES_PATH),
      `${ACTIVE_TYPES_PATH} at ${BASE_REF}`,
    ),
    BASE_REF,
  );

  return report(findAheadAggregates(treeVersions, baseVersions), isOverrideEnabled(env));
}

/**
 * The CLI body, exported so its exit code and output are testable without a
 * deploy. Every path returns a code; nothing calls `process.exit` here.
 */
export function runCli({ env = process.env, git = runGit, readTree = readTreeSource, log = console.error } = {}) {
  let result;
  try {
    result = checkSchemaNotAhead(env, git, readTree);
  } catch (error) {
    log(`${PREFLIGHT_FAILED_MARKER} ${error.message}`);
    return 1;
  }
  for (const line of result.lines) log(line);
  return result.exitCode;
}

/**
 * Fail loudly on a runtime that cannot answer "am I the entry point?".
 *
 * `import.meta.main` is Node >= 24.2. On anything older it is `undefined`, the
 * gate below is falsy, and the guard skips itself in silence — no output,
 * exit 0 — which is the exact defect the symlink incident already produced
 * once. `engines.node` states the floor, but nothing enforces an engines field
 * by default, so state it here where it actually matters.
 *
 * This throw escapes `runCli`'s catch (it happens at module load), so it wears
 * the same `PREFLIGHT_FAILED_MARKER` prefix explicitly: every way this script
 * can stop a deploy before Pulumi starts is then recognisable by that one
 * marker, and none of them can be misread as a half-finished deploy. The
 * "cannot run" distinction stays in the sentence that follows it.
 */
export function assertEntryGateSupported(meta) {
  if (typeof meta.main === 'boolean') return;
  throw new Error(
    `${PREFLIGHT_FAILED_MARKER} the preflight cannot run, because this Node runtime ` +
      `(${process.version}) does not support \`import.meta.main\` and the check would silently ` +
      'skip itself. Node >= 24.2 is required (see `engines.node` in package.json).',
  );
}

// `import.meta.main`, NOT a `process.argv[1]` comparison: Node resolves the
// main module to its REAL path, so invoking this script through a symlinked
// checkout path made that comparison false and the whole guard no-opped
// silently while the deploy log still printed the preflight banner.
assertEntryGateSupported(import.meta);
if (import.meta.main) {
  // `process.exitCode`, not `process.exit()`: stdout/stderr are asynchronous
  // when they are pipes — which is how deploy-stack.sh and the subprocess tests
  // run this — so exiting immediately can truncate the refusal text that names
  // the offending aggregate.
  process.exitCode = runCli();
}
