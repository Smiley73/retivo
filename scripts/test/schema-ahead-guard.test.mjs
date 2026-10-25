// scripts/check-schema-not-ahead.mjs must fail when it cannot answer: a silent pass lets a branch build write rows the shipped bundle cannot read.
// The subprocess runs, including through a symlinked path, are gated: skipped under `pnpm test:scripts`, run by `pnpm test:contracts`.

import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVE_TYPES_PATH,
  BASE_REF,
  MIGRATIONS_PATH,
  OVERRIDE_ENV,
  PRE_PULUMI_STOP_MARKERS,
  assertEntryGateSupported,
  assertRegistryMatchesInventory,
  checkSchemaNotAhead,
  findAheadAggregates,
  isOverrideEnabled,
  parseActiveAggregateTypes,
  parseRegistryVersions,
  readBaseSource,
  report,
  runCli,
} from '../check-schema-not-ahead.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/check-schema-not-ahead.mjs');
const DEPLOY_SCRIPT = resolve(REPO_ROOT, 'infrastructure/scripts/deploy-stack.sh');

// A miniature registry: comments that mention versions, an inline entry, and a multi-line entry whose nested `migrations` keys are not aggregates.
const HOUSEHOLD_ENTRY = 'household: { current: 1, migrations: {} },';
const FIXTURE = `
const REGISTRY: Record<AggregateType, Registry> = {
  ${HOUSEHOLD_ENTRY}
  // \`account\` intentionally stays at 6 — a comment that says current: 99 and
  // mentions { braces } must never be read as data.
  account: {
    current: 6,
    migrations: { 1: migrateAccountV1ToV2, 5: migrateAccountV5ToV6 },
  },
};
`;

/** FIXTURE with the `household` entry rewritten into some other shape. */
const reshapedHousehold = (replacement) => FIXTURE.replace(HOUSEHOLD_ENTRY, replacement);

function withVersion(source, aggregate, version) {
  const replaced = source.replace(
    new RegExp(`(${aggregate}: \\{\\s*(?:\\n\\s*)?current: )\\d+`),
    `$1${version}`,
  );
  assert.notEqual(replaced, source, `fixture precondition: ${aggregate} version was rewritten`);
  return replaced;
}

// --- Parsing the real registry --------------------------------------------

const TREE_VERSIONS = parseRegistryVersions(
  readFileSync(resolve(REPO_ROOT, MIGRATIONS_PATH), 'utf8'),
);

/** The active inventory read without the guard's own parser, so a shared bug cannot hide. */
function activeTypesByHand() {
  const listSource = readFileSync(resolve(REPO_ROOT, ACTIVE_TYPES_PATH), 'utf8');
  const listBlock = listSource.match(/ACTIVE_AGGREGATE_TYPES_LIST = \[([^\]]+)\]/);
  assert.ok(listBlock, 'precondition: found ACTIVE_AGGREGATE_TYPES_LIST');
  const names = [...listBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'precondition: the active type list is non-empty');
  return names;
}

test('parses a current version for every active aggregate type', () => {
  const expected = activeTypesByHand();
  assert.deepEqual(Object.keys(TREE_VERSIONS).sort(), [...expected].sort());
  for (const [name, version] of Object.entries(TREE_VERSIONS)) {
    assert.ok(Number.isInteger(version) && version >= 1, `${name} parsed to a positive integer, got ${version}`);
  }
});

test("the guard's inventory parser agrees with the real ACTIVE_AGGREGATE_TYPES_LIST", () => {
  const source = readFileSync(resolve(REPO_ROOT, ACTIVE_TYPES_PATH), 'utf8');
  assert.deepEqual(parseActiveAggregateTypes(source), activeTypesByHand());
});

test('line comments inside the registry block are never read as versions', () => {
  assert.deepEqual(parseRegistryVersions(FIXTURE), { household: 1, account: 6 });
});

test('a block comment inside the registry is never read as a version', () => {
  const source = reshapedHousehold(
    `/* Historical note: household used to be at current: 42 and carried
        { migrations } that no longer exist. */
  ${HOUSEHOLD_ENTRY}`,
  );
  assert.deepEqual(parseRegistryVersions(source), { household: 1, account: 6 });
});

// --- Ahead / equal / behind ------------------------------------------------

test('an aggregate ahead of the base ref fails, naming it and both versions', () => {
  const ahead = findAheadAggregates(
    parseRegistryVersions(withVersion(FIXTURE, 'account', 7)),
    parseRegistryVersions(FIXTURE),
  );
  assert.deepEqual(ahead, [{ aggregate: 'account', tree: 7, base: 6 }]);

  const result = report(ahead, false);
  assert.equal(result.exitCode, 1);
  const text = result.lines.join('\n');
  assert.match(text, /Refusing to deploy/);
  assert.match(text, /account: this tree is at version 7, origin\/main is at 6/);
  assert.match(text, /ALLOW_SCHEMA_AHEAD=1/);
});

test('every ahead aggregate is reported, in a stable alphabetical order', () => {
  const ahead = findAheadAggregates(
    { scenario: 4, account: 7, household: 2, expense: 1 },
    { scenario: 3, account: 6, household: 1, expense: 1 },
  );
  assert.deepEqual(ahead.map((a) => a.aggregate), ['account', 'household', 'scenario']);
  const lines = report(ahead, false).lines.join('\n');
  for (const name of ['account', 'household', 'scenario']) {
    assert.match(lines, new RegExp(`- ${name}: this tree is at version`), `${name} is named`);
  }
  assert.doesNotMatch(lines, /- expense:/, 'an aggregate that is level is not reported');
});

test('identical versions pass with an explicit all-clear', () => {
  const ahead = findAheadAggregates(parseRegistryVersions(FIXTURE), parseRegistryVersions(FIXTURE));
  assert.deepEqual(ahead, []);
  const result = report(ahead, false);
  assert.equal(result.exitCode, 0);
  // A run that prints nothing cannot be told apart from one that never happened.
  assert.match(result.lines.join('\n'), /OK: no aggregate schema version is ahead of origin\/main/);
});

test('a tree BEHIND the base ref passes', () => {
  const ahead = findAheadAggregates(
    parseRegistryVersions(FIXTURE),
    parseRegistryVersions(withVersion(FIXTURE, 'account', 9)),
  );
  assert.deepEqual(ahead, [], 'behind is safe: the shipped bundle understands older rows');
  assert.equal(report(ahead, false).exitCode, 0);
});

// --- The escape hatch ------------------------------------------------------

test('ALLOW_SCHEMA_AHEAD=1 warns loudly and passes', () => {
  const ahead = [{ aggregate: 'account', tree: 7, base: 6 }];
  const result = report(ahead, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join('\n'), /^WARNING: ALLOW_SCHEMA_AHEAD=1/);
  assert.match(result.lines.join('\n'), /account 7 \(origin\/main has 6\)/);
  assert.equal(report(ahead, false).exitCode, 1);
});

test('an armed override is announced even when nothing is ahead', () => {
  const result = report([], true);
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join('\n'), /ALLOW_SCHEMA_AHEAD=1 is armed/);
  assert.match(result.lines.join('\n'), /OK: no aggregate schema version is ahead/);
  assert.doesNotMatch(report([], false).lines.join('\n'), /armed/);
});

test('the override is only enabled by an explicit ALLOW_SCHEMA_AHEAD=1', () => {
  assert.equal(isOverrideEnabled({ ALLOW_SCHEMA_AHEAD: '1' }), true);
  assert.equal(isOverrideEnabled({}), false);
  assert.equal(isOverrideEnabled({ ALLOW_SCHEMA_AHEAD: '0' }), false);
  assert.equal(isOverrideEnabled({ ALLOW_SCHEMA_AHEAD: '' }), false);
});

// --- Fail-loud parsing: each row is a registry shape the parser must refuse, never answer partially ---

for (const [name, source, expected] of [
  ['a missing REGISTRY declaration raises instead of passing',
    'const SOMETHING_ELSE = { account: { current: 6 } };\n', /could not find the `const REGISTRY/],
  ['an empty registry raises instead of passing',
    'const REGISTRY: Record<AggregateType, Registry> = {};\n', /parsed zero aggregates/],
  ['an unterminated registry block raises',
    'const REGISTRY: Record<AggregateType, Registry> = {\n  account: { current: 6 },\n', /unbalanced braces/],
  ['an aggregate that is no longer a plain object raises',
    reshapedHousehold('household: makeRegistry(1),'), /top-level key\(s\)/],
  ['an aggregate with no numeric current raises',
    FIXTURE.replace('household: { current: 1,', 'household: { current: ACCOUNT_V1,'), /has 0 `current: <number>` entries/],
  ['a stray extra current inside an aggregate raises',
    reshapedHousehold('household: { current: 1, migrations: {}, legacy: { current: 4 } },'), /has 2 `current: <number>` entries/],
  // One numeric `current:` per entry passes the per-entry check; only the block-wide tally catches it.
  ['a non-numeric extra current trips the block-wide count backstop',
    reshapedHousehold('household: { current: 1, migrations: {}, legacy: { current: LEGACY_VERSION } },'), /`current:` key\(s\) for 2 aggregate\(s\)/],
  // A spread carries no `name:` key, so no count-based check sees the aggregates it hides.
  ['a top-level spread in the registry raises instead of dropping aggregates',
    reshapedHousehold(`...BASE_REGISTRY,\n  ${HOUSEHOLD_ENTRY}`), /spreads another object at top level/],
]) {
  test(name, () => assert.throws(() => parseRegistryVersions(source), expected));
}

// --- Fail-loud inventory parsing: the inventory is the independent opinion on which aggregates exist, so it must raise rather than come back short ---

const INVENTORY_FIXTURE = `
// The list below is \`as const\` so the union derives from it.
export const ACTIVE_AGGREGATE_TYPES_LIST = [
  'household',
  // 'retired' was removed
  'account',
] as const;
`;

test('the inventory parser reads names and ignores comments', () => {
  assert.deepEqual(parseActiveAggregateTypes(INVENTORY_FIXTURE), ['household', 'account']);
});

for (const [name, source, expected] of [
  ['a missing ACTIVE_AGGREGATE_TYPES_LIST declaration raises instead of passing',
    "export const SOMETHING_ELSE = ['account'] as const;\n", /could not find the `const ACTIVE_AGGREGATE_TYPES_LIST/],
  ['an empty inventory raises instead of passing',
    'export const ACTIVE_AGGREGATE_TYPES_LIST = [] as const;\n', /parsed zero aggregate names/],
  ['an unterminated inventory array raises',
    "export const ACTIVE_AGGREGATE_TYPES_LIST = [\n  'account',\n", /unbalanced brackets/],
  // A spread contributes names the parser cannot see.
  ['anything in the inventory that is not a quoted name raises',
    INVENTORY_FIXTURE.replace("'household',", '...LEGACY_TYPES,'), /contains something other than quoted aggregate names/],
  ['a repeated inventory name raises instead of being counted twice',
    INVENTORY_FIXTURE.replace("'account',", "'account',\n  'account',"), /repeats account/],
]) {
  test(name, () => assert.throws(() => parseActiveAggregateTypes(source), expected));
}

// --- The base ref must be readable -----------------------------------------

/** A `git` double that fails at `step`, carrying git's own words on `stderr`. */
const gitFailingAt = (step, stderr) => (args) => {
  if (args[0] === 'rev-parse' && step !== 'rev-parse') return '';
  const error = new Error(`Command failed: git ${step}`);
  error.stderr = stderr;
  throw error;
};

test('an unresolvable base ref raises instead of passing', () => {
  const run = () => readBaseSource(gitFailingAt('rev-parse', "fatal: not a git repository: '/nowhere'\n"));
  assert.throws(run, /cannot resolve origin\/main/);
  assert.throws(run, /git fetch origin main/);
  // git's own words survive, so another failure is not reported as "the ref was never fetched".
  assert.throws(run, /not a git repository/);
});

test('an unreadable migrations file on the base ref raises instead of passing', () => {
  // execFileSync hands back a Buffer.
  const stderr = Buffer.from('fatal: path does not exist in origin/main\n');
  const run = () => readBaseSource(gitFailingAt('show', stderr));
  assert.throws(run, /cannot read apps\/web\/src\/db\/migrations\.ts/);
  assert.throws(run, /If the file moved/);
  assert.throws(run, /path does not exist in origin\/main/);
});

// --- The composition root: reads the real working tree and takes the base ref through its `git` seam ---

const AHEAD_AGGREGATE = 'account';

test('composition-root precondition: the real tree carries the aggregate under test', () => {
  const version = TREE_VERSIONS[AHEAD_AGGREGATE];
  assert.ok(Number.isInteger(version), `${AHEAD_AGGREGATE} exists in the real REGISTRY`);
});

/** Registry entry lines / a whole migrations.ts source, for these versions. */
const registryEntries = (versions) =>
  Object.entries(versions)
    .map(([name, current]) => `  ${name}: { current: ${current}, migrations: {} },`)
    .join('\n');
const registrySourceWith = (versions) =>
  `const REGISTRY: Record<AggregateType, Registry> = {\n${registryEntries(versions)}\n};\n`;

/** An aggregate-types.ts source declaring exactly these type names. */
const inventorySourceWith = (names) =>
  `export const ACTIVE_AGGREGATE_TYPES_LIST = [\n${names.map((n) => `  '${n}',`).join('\n')}\n] as const;\n`;

/** A `git` double serving the right file per `git show` path; `inventory` defaults to one agreeing with `migrations`. */
function gitServing(migrations, inventory) {
  return (args) => {
    if (args[0] === 'rev-parse') return '';
    const target = args[1];
    if (target.endsWith(MIGRATIONS_PATH)) return migrations;
    if (target.endsWith(ACTIVE_TYPES_PATH)) {
      return inventory ?? inventorySourceWith(Object.keys(parseRegistryVersions(migrations)));
    }
    throw new Error(`test double: unexpected git show target "${target}"`);
  };
}

/** The same, for the `readTree` seam. */
function treeServing(migrations, inventory) {
  return (relPath) => {
    if (relPath === MIGRATIONS_PATH) return migrations;
    if (relPath === ACTIVE_TYPES_PATH) {
      return inventory ?? inventorySourceWith(Object.keys(parseRegistryVersions(migrations)));
    }
    throw new Error(`test double: unexpected tree read "${relPath}"`);
  };
}

/** A base ref identical to the tree except one aggregate a version behind. */
const baseOneBehind = () =>
  gitServing(
    registrySourceWith({ ...TREE_VERSIONS, [AHEAD_AGGREGATE]: TREE_VERSIONS[AHEAD_AGGREGATE] - 1 }),
  );

/** A base ref serving both files from one version map, so only the comparison is under test. */
const baseServing = (versions) =>
  gitServing(registrySourceWith(versions), inventorySourceWith(Object.keys(versions)));

test('checkSchemaNotAhead refuses when the working tree is ahead of the base ref', () => {
  const result = checkSchemaNotAhead({}, baseOneBehind());
  assert.equal(result.exitCode, 1);
  // Swapped arguments would invert this into a pass.
  assert.match(
    result.lines.join('\n'),
    new RegExp(
      `- ${AHEAD_AGGREGATE}: this tree is at version ${TREE_VERSIONS[AHEAD_AGGREGATE]}, ` +
        `origin/main is at ${TREE_VERSIONS[AHEAD_AGGREGATE] - 1}`,
    ),
  );
});

test('checkSchemaNotAhead passes when the base ref matches the working tree', () => {
  const result = checkSchemaNotAhead({}, baseServing(TREE_VERSIONS));
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join('\n'), /OK: no aggregate schema version is ahead/);
});

test('checkSchemaNotAhead honours ALLOW_SCHEMA_AHEAD from the env it is given', () => {
  const result = checkSchemaNotAhead({ [OVERRIDE_ENV]: '1' }, baseOneBehind());
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join('\n'), /^WARNING: ALLOW_SCHEMA_AHEAD=1/);
  // An unconditional override would pass this too.
  assert.equal(checkSchemaNotAhead({}, baseOneBehind()).exitCode, 1);
});

test('a spread in the base ref registry fails the whole check loudly', () => {
  // The refusal must carry the parser's own reason; the downstream inventory check would name the wrong file.
  const spreadBase =
    'const REGISTRY: Record<AggregateType, Registry> = {\n  ...BASE_REGISTRY,\n' +
    `  ${AHEAD_AGGREGATE}: { current: ${TREE_VERSIONS[AHEAD_AGGREGATE] - 1}, migrations: {} },\n};\n`;
  assert.throws(
    () => checkSchemaNotAhead({}, gitServing(spreadBase, inventorySourceWith(Object.keys(TREE_VERSIONS)))),
    /spreads another object at top level/,
  );
});

test('both base-ref files are read from the base ref, not the working tree', () => {
  const targets = [];
  const base = baseServing(TREE_VERSIONS);
  const git = (args) => {
    if (args[0] !== 'rev-parse') targets.push(args[1]);
    return base(args);
  };
  assert.equal(checkSchemaNotAhead({}, git).exitCode, 0);
  assert.deepEqual(targets, [`${BASE_REF}:${MIGRATIONS_PATH}`, `${BASE_REF}:${ACTIVE_TYPES_PATH}`]);
});

// --- Short parses, in both directions: the parser's checks compare the block to itself, so only each ref's own inventory catches a short parse ---

/** Evades every count check: `stripComments` removes block comments before line comments, so the unpaired `/*` in the `//` line swallows entries up to the next close-comment. */
const SWALLOWED_HOUSEHOLD = `
const REGISTRY: Record<AggregateType, Registry> = {
  // note: the /* old registry shape is gone
  ${HOUSEHOLD_ENTRY}
  /* account is the one that matters */
  account: { current: 6, migrations: {} },
};
`;

test('premise: a swallowing comment silently shortens the registry parse', () => {
  assert.deepEqual(
    parseRegistryVersions(SWALLOWED_HOUSEHOLD),
    { account: 6 },
    '`household` vanished from the parse and no shape check noticed',
  );
});

test("a short parse is caught in BOTH directions, against that ref's own inventory", () => {
  const full = { household: 1, account: 6 };
  const short = { account: 6 };
  const names = Object.keys(full);

  // Registry short of its inventory: what SWALLOWED_HOUSEHOLD produces.
  assert.throws(
    () => assertRegistryMatchesInventory(short, names, 'some ref'),
    /missing from the registry parse: household/,
  );
  // Inventory short of its registry: the mirror image.
  assert.throws(
    () => assertRegistryMatchesInventory(full, ['account'], 'some ref'),
    /missing from the inventory parse: household/,
  );
  assert.doesNotThrow(() => assertRegistryMatchesInventory(full, names, 'some ref'));
  assert.doesNotThrow(() => assertRegistryMatchesInventory(short, ['account'], 'some ref'));
});

test('a BASE ref whose registry parse comes back short is refused, not read as all clear', () => {
  // A comment hides `account` from the base parse, and `findAheadAggregates` skips aggregates the base does not declare,
  // so the bump would read as all clear. The base ref's own inventory still lists it.
  const survivors = Object.fromEntries(
    Object.entries(TREE_VERSIONS).filter(([name]) => name !== AHEAD_AGGREGATE),
  );
  const hiddenAccountBase = `
const REGISTRY: Record<AggregateType, Registry> = {
  // note: the /* comment shape that swallows what follows
  account: { current: ${TREE_VERSIONS[AHEAD_AGGREGATE] - 1}, migrations: {} },
  /* the survivors are self-consistent */
${registryEntries(survivors)}
};
`;
  assert.equal(
    parseRegistryVersions(hiddenAccountBase)[AHEAD_AGGREGATE],
    undefined,
    `premise: ${AHEAD_AGGREGATE} vanished from the base parse`,
  );
  const run = () =>
    checkSchemaNotAhead(
      {},
      gitServing(hiddenAccountBase, inventorySourceWith(Object.keys(TREE_VERSIONS))),
    );
  assert.throws(run, /origin\/main: the REGISTRY block and ACTIVE_AGGREGATE_TYPES_LIST disagree/);
  assert.throws(run, new RegExp(`missing from the registry parse: ${AHEAD_AGGREGATE}`));
});

test('a TREE whose registry parse comes back short is refused, not read as all clear', () => {
  // `findAheadAggregates` iterates the tree's keys, so an aggregate the tree parse never produced is not compared.
  // The working tree's own inventory contradicts it.
  const base = baseServing({ household: 1, account: 5 });
  assert.throws(
    () =>
      checkSchemaNotAhead(
        {},
        base,
        treeServing(SWALLOWED_HOUSEHOLD, inventorySourceWith(['household', 'account'])),
      ),
    /this working tree: the REGISTRY block and ACTIVE_AGGREGATE_TYPES_LIST disagree/,
  );
  // With the tree's two files agreeing, the refusal is on the merits (account 6 > 5).
  const honest = treeServing(SWALLOWED_HOUSEHOLD.replace('// note: the /*', '//'));
  assert.equal(checkSchemaNotAhead({}, base, honest).exitCode, 1);
  assert.doesNotThrow(() =>
    assertRegistryMatchesInventory(TREE_VERSIONS, activeTypesByHand(), 'this working tree'),
  );
});

test('a genuinely RETIRED aggregate type is not refused', () => {
  // Declared in both of the base ref's files and neither of the tree's, so there is no tree-side version to be ahead.
  const RETIRED = 'legacyProfile';
  assert.equal(TREE_VERSIONS[RETIRED], undefined, `precondition: ${RETIRED} is not a real aggregate`);
  const withRetired = { ...TREE_VERSIONS, [RETIRED]: 3 };
  const result = checkSchemaNotAhead({}, baseServing(withRetired));
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join('\n'), /OK: no aggregate schema version is ahead/);

  // Retiring a type must not blind the guard to a real bump on the others.
  const alsoBehind = { ...withRetired, [AHEAD_AGGREGATE]: TREE_VERSIONS[AHEAD_AGGREGATE] - 1 };
  assert.equal(checkSchemaNotAhead({}, baseServing(alsoBehind)).exitCode, 1);
});

test('a genuinely NEW aggregate type is not refused', () => {
  // An older bundle skips rows of a type it does not know, so a new type cannot halt sync.
  const baseMissingOne = Object.fromEntries(
    Object.entries(TREE_VERSIONS).filter(([name]) => name !== AHEAD_AGGREGATE),
  );
  const result = checkSchemaNotAhead({}, baseServing(baseMissingOne));
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join('\n'), /OK: no aggregate schema version is ahead/);
});

// --- The CLI body ----------------------------------------------------------

function captureCli(options) {
  const lines = [];
  const exitCode = runCli({ env: {}, log: (line) => lines.push(line), ...options });
  return { exitCode, text: lines.join('\n') };
}

test('runCli returns 1 and prints the refusal when the tree is ahead', () => {
  const { exitCode, text } = captureCli({ git: baseOneBehind() });
  assert.equal(exitCode, 1);
  assert.match(text, /Refusing to deploy/);
});

test('runCli returns 0 and prints the all-clear when nothing is ahead', () => {
  const { exitCode, text } = captureCli({ git: baseServing(TREE_VERSIONS) });
  assert.equal(exitCode, 0);
  assert.match(text, /OK: no aggregate schema version is ahead/);
});

test('runCli turns a thrown failure into exit 1, never a silent pass', () => {
  const { exitCode, text } = captureCli({
    git: () => {
      throw new Error('git exploded');
    },
  });
  assert.equal(exitCode, 1);
  assert.match(text, /Schema-ahead preflight failed: cannot resolve origin\/main/);
});

// --- The CLI entry gate ----------------------------------------------------

test('the entry gate refuses to run on a runtime without `import.meta.main`', () => {
  assert.doesNotThrow(() => assertEntryGateSupported({ main: true }));
  assert.doesNotThrow(() => assertEntryGateSupported({ main: false }));
  // Node < 24.2 has no `import.meta.main`: the gate would be falsy and the guard would skip itself silently.
  assert.throws(() => assertEntryGateSupported({}), /does not support `import\.meta\.main`/);
  assert.throws(() => assertEntryGateSupported({}), /Node >= 24\.2 is required/);
});

/** Named in the failure messages so a red run points at the constant to fix. */
const MARKER_SOURCE = 'PRE_PULUMI_STOP_MARKERS (scripts/check-schema-not-ahead.mjs)';

test('exactly the outcomes that stop the deploy announce a stop marker', () => {
  // The markers tell a deploy log "the preflight stopped this" from "the deploy failed, the stack may be half-changed".
  // Each terminal form is produced by the code path that emits it, so a reworded one cannot drift out of this check.
  const markers = PRE_PULUMI_STOP_MARKERS;
  assert.ok(markers.length > 0, `${MARKER_SOURCE} must name at least one log marker`);
  const ahead = [{ aggregate: AHEAD_AGGREGATE, tree: 7, base: 6 }];
  let entryGateFailure = '(the entry gate did not throw)';
  try {
    assertEntryGateSupported({});
  } catch (error) {
    entryGateFailure = `Error: ${error.message}`; // as Node prints it: uncaught, at module load
  }

  const emitted = (name, { exitCode, lines }) => ({ name, exitCode, text: lines.join('\n') });
  const cliFailure = captureCli({ git: gitFailingAt('rev-parse', 'no such ref') });

  for (const { name, exitCode, text } of [
    emitted('all-clear', report([], false)),
    emitted('armed-override note', report([], true)),
    emitted('override warning', report(ahead, true)),
    emitted('refusal', report(ahead, false)),
    { name: 'preflight failure', exitCode: cliFailure.exitCode, text: cliFailure.text },
    // Uncaught at module load, so Node prints it and exits 1 on its own.
    { name: 'entry gate', exitCode: 1, text: entryGateFailure },
  ]) {
    assert.equal(
      markers.some((marker) => text.includes(marker)),
      exitCode === 1,
      exitCode === 1
        ? `the "${name}" outcome stops the deploy before Pulumi starts, but no marker in ` +
          `${MARKER_SOURCE} matches it, so it would be read as a partial deploy:\n${text}`
        : `the "${name}" outcome exits 0 and the deploy proceeds, but it announces a marker ` +
          `from ${MARKER_SOURCE}, so it would be read as a preflight stop:\n${text}`,
    );
  }
});

test('package.json pins Node to 24.x, at 24.2 or later', () => {
  const declared = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).engines.node;
  const floor = declared.match(/^>=\s*(\d+)\.(\d+)\./);
  assert.ok(floor, `engines.node must state a \`>=\` floor, got "${declared}"`);
  const [, major, minor] = floor.map(Number);
  // Major 24 exactly: the repo runs the current Lambda LTS, and a `>=` with no ceiling would permit 25+.
  assert.equal(major, 24, `engines.node is "${declared}", but this repo is pinned to Node 24.x`);
  assert.ok(
    minor >= 2,
    `engines.node is "${declared}", but the entry gate needs Node >= 24.2 — on a permitted ` +
      '24.0.x/24.1.x runtime the preflight cannot check anything',
  );
  const ceiling = declared.match(/<\s*(\d+)\.0\.0\s*$/);
  assert.ok(ceiling, `engines.node must state a \`<\` ceiling too, got "${declared}"`);
  assert.equal(Number(ceiling[1]), 25, `engines.node is "${declared}", which permits a Node major past 24`);
});

test('the CLI sets an exit code instead of exiting mid-write', () => {
  // Executable lines only: the script's comments name `process.exit()` to explain why it is not used.
  const source = readFileSync(SCRIPT_PATH, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
  assert.match(source, /process\.exitCode = runCli\(\)/);
  assert.doesNotMatch(
    source,
    /process\.exit\(/,
    'stdout/stderr are asynchronous when they are pipes — which is how deploy-stack.sh and the ' +
      'subprocess runs below invoke this — so exiting before the writes drain can truncate the ' +
      'refusal text that names the offending aggregate',
  );
  // No in-process test reaches this call site, and after the entry gate an unsupported runtime would skip both.
  const callIndex = source.search(/^assertEntryGateSupported\(import\.meta\);$/m);
  const gateIndex = source.search(/^if \(import\.meta\.main\) \{$/m);
  assert.ok(callIndex >= 0, 'the module must call `assertEntryGateSupported(import.meta)` at top level');
  assert.ok(gateIndex >= 0, 'the module must gate the CLI body on `import.meta.main`');
  assert.ok(callIndex < gateIndex, 'the entry-gate assertion must run before the `import.meta.main` gate');
});

// --- Real subprocess runs, canonical and symlinked: no in-process test reaches the CLI entry condition, which a symlinked checkout path would disarm ---

const RUN = process.env.RUN_CONTRACT_TESTS === '1';

describe(
  RUN
    ? 'schema-ahead guard CLI runs'
    : 'schema-ahead guard CLI runs (skipped: set RUN_CONTRACT_TESTS=1)',
  { skip: !RUN },
  () => {
  let linkDir;
  let linkedScript;

  before(() => {
    linkDir = mkdtempSync(join(tmpdir(), 'schema-ahead-symlink-'));
    symlinkSync(REPO_ROOT, join(linkDir, 'repo'), 'dir');
    linkedScript = join(linkDir, 'repo', 'scripts/check-schema-not-ahead.mjs');
  });

  after(() => {
    if (!linkDir) return;
    const linkedRepo = join(linkDir, 'repo');
    if (lstatSync(linkedRepo, { throwIfNoEntry: false })) unlinkSync(linkedRepo);
    rmSync(linkDir, { recursive: true, force: true });
  });

  function runScript(scriptPath, extraEnv = {}) {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: tmpdir(), // cwd-independent by design: the script resolves its own root
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  // Asserting the outcome and its exit code together holds on any branch state; a skipped entry block prints nothing and matches none.
  const OUTCOMES = [
    { name: 'clean', pattern: /^OK: no aggregate schema version is ahead of origin\/main\.$/m, status: 0 },
    { name: 'override-warning', pattern: /^WARNING: ALLOW_SCHEMA_AHEAD=1 —/m, status: 0 },
    { name: 'refusal', pattern: /^Refusing to deploy: aggregate schema versions are ahead of origin\/main\.$/m, status: 1 },
    { name: 'preflight-failed', pattern: /^Schema-ahead preflight failed: /m, status: 1 },
  ];

  /** Assert the run announced exactly one outcome with its exit code; returns the outcome's name. */
  function assertAnnouncedOutcome({ status, output }, context) {
    const matched = OUTCOMES.filter((outcome) => outcome.pattern.test(output));
    assert.equal(
      matched.length,
      1,
      `${context}: expected exactly one announced outcome, matched [${matched
        .map((o) => o.name)
        .join(', ')}] in:\n${output || '(no output at all — the guard never ran)'}`,
    );
    assert.equal(
      status,
      matched[0].status,
      `${context}: the "${matched[0].name}" outcome must exit ${matched[0].status}, got ${status}:\n${output}`,
    );
    return matched[0].name;
  }

  test('running the script directly executes the check and announces an outcome', () => {
    assertAnnouncedOutcome(runScript(SCRIPT_PATH), 'canonical invocation');
  });

  test('running the script through a SYMLINKED path still executes the check', () => {
    assert.notEqual(
      realpathSync(linkedScript),
      linkedScript,
      'precondition: the invocation path is genuinely non-canonical',
    );
    const canonical = assertAnnouncedOutcome(runScript(SCRIPT_PATH), 'canonical invocation');
    const linked = assertAnnouncedOutcome(runScript(linkedScript), 'symlinked invocation');
    assert.equal(
      linked,
      canonical,
      'the guard must reach the same outcome through a symlinked checkout path, not silently no-op',
    );
  });

  test('a failing check exits non-zero through BOTH invocation paths', () => {
    for (const [label, script] of [['canonical', SCRIPT_PATH], ['symlinked', linkedScript]]) {
      const run = runScript(script, { GIT_DIR: join(tmpdir(), 'no-such-git-dir') });
      assert.equal(assertAnnouncedOutcome(run, `${label} path with an unusable git dir`), 'preflight-failed');
    }
  });
  },
);


// --- The deploy-script wiring ----------------------------------------------

/** deploy-stack.sh without comment lines, whose prose describes the preflight. */
const DEPLOY_CODE = readFileSync(DEPLOY_SCRIPT, 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

test('deploy-stack.sh runs the preflight before the backend login, build, and pulumi up', () => {
  const preflight = DEPLOY_CODE.indexOf('scripts/check-schema-not-ahead.mjs');
  assert.notEqual(preflight, -1, 'deploy-stack.sh must invoke the schema-ahead preflight');
  assert.match(
    DEPLOY_CODE.slice(Math.max(0, preflight - 200), preflight + 100),
    /node "\$REPO_ROOT\/scripts\/check-schema-not-ahead\.mjs"/,
    'the preflight must be run with node',
  );

  for (const [label, marker] of [
    ['the backend login (which sources .deploy.env)', 'setup_pulumi_backend "$STACK"'],
    ['the Lambda build', 'build_lambda'],
    ['the SPA build', 'build_spa'],
    ['pulumi up', 'pulumi up --stack'],
  ]) {
    const at = DEPLOY_CODE.indexOf(marker);
    assert.notEqual(at, -1, `precondition: deploy-stack.sh still calls ${label}`);
    assert.ok(
      preflight < at,
      `the schema-ahead preflight must run before ${label} — a refusal must cost nothing`,
    );
  }
});

test('deploy-stack.sh reads the override from the invoking environment only', () => {
  const capture = DEPLOY_CODE.indexOf('SCHEMA_AHEAD_OVERRIDE="${ALLOW_SCHEMA_AHEAD:-}"');
  assert.notEqual(capture, -1, 'the override must be captured into SCHEMA_AHEAD_OVERRIDE');
  const sourceCommon = DEPLOY_CODE.indexOf('source "$SCRIPT_DIR/lib/deploy-common.sh"');
  assert.notEqual(sourceCommon, -1, 'precondition: deploy-stack.sh still sources deploy-common.sh');
  assert.ok(
    capture < sourceCommon,
    'the capture must happen before anything can source infrastructure/.deploy.env (set -a), ' +
      'or a stale ALLOW_SCHEMA_AHEAD=1 line in that gitignored file would disarm the guard forever',
  );
  assert.match(
    DEPLOY_CODE,
    /ALLOW_SCHEMA_AHEAD="\$SCHEMA_AHEAD_OVERRIDE" node "\$REPO_ROOT\/scripts\/check-schema-not-ahead\.mjs"/,
    'the preflight must be invoked with the captured value, not the ambient variable',
  );
});

test("deploy-stack.sh's header documents the aborting preflight", () => {
  const header = readFileSync(DEPLOY_SCRIPT, 'utf8').split('set -euo pipefail')[0];
  assert.match(header, /Schema-ahead preflight/);
  assert.match(header, /ABORTS/);
});
