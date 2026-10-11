// pnpm CVE-pin drop-detection contract guard.
//
// pnpm 10 reads dependency overrides / build allow-lists / audit waivers from
// `pnpm-workspace.yaml`, NOT from a root-`package.json` `pnpm` field (which it
// silently ignores). This guard turns four tribal facts into machine-checked
// failures with teaching messages:
//
//   (a) the root package.json must never regrow a `pnpm` key — settings there
//       are silently dead, so a re-added block would be a security foot-gun
//       (CVE pins that look present but do nothing);
//   (b) pnpm-workspace.yaml's `overrides:` block matches the frozen CVE-pin
//       registry (`EXPECTED_OVERRIDES`) key-for-key and value-for-value AND
//       matches the resolved `overrides:` block at the top of pnpm-lock.yaml —
//       a dropped, added, or downgraded pin fails here naming the key (the
//       registry check catches a coordinated downgrade that keeps both files
//       agreeing; the lock check catches an uninstalled workspace edit);
//   (c) every override carries a non-empty reason comment directly above it in
//       pnpm-workspace.yaml, so a pin never loses the advisory it clears;
//   (d) the workspace file keeps its `onlyBuiltDependencies` build allow-list,
//       and carries only the advisory waivers in `ALLOWED_WAIVERS`, so a
//       reintroduced waiver must not slip in silently.
//
// Both YAML/lockfile blocks are parsed by line-scan (no YAML dependency — this
// script suite installs none) — an indentation/format drift that makes the scan
// collect zero overrides fails loud rather than passing an empty-vs-empty
// comparison vacuously.
//
// No infra harness, no new dependency. Runs under `pnpm test:scripts` (already
// invoked by `pnpm test`). Lives in scripts/test/ so Node's test runner does
// not match the built-in `test-*.mjs` discovery glob. Pattern:
// scripts/test/csp-contract.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = resolve(__dirname, '../../package.json');
const WORKSPACE_YAML = resolve(__dirname, '../../pnpm-workspace.yaml');
const LOCKFILE_YAML = resolve(__dirname, '../../pnpm-lock.yaml');

// Shared with the real-file "no audit-waiver block" assertions below AND with
// the synthetic reintroduced-waiver fixture test, so the fixture test actually
// exercises the same patterns the guard runs against pnpm-workspace.yaml
// rather than a re-typed copy of them (a drift in one would otherwise go
// unnoticed by the other).
const AUDIT_CONFIG_RE = /^auditConfig:/m;
const IGNORE_GHSAS_RE = /^\s+ignoreGhsas:/m;

// The only advisory waivers allowed in pnpm-workspace.yaml. GHSA-ch52-4w7c-c8xp
// (http-cache-semantics max-stale) has no patched release and is reachable only
// through the Pulumi deploy tooling, never the app or Lambda bundles.
// GHSA-hp3w-g68c-fv3c (sprintf-js) likewise has no patch and is reachable only
// through jest's test tooling. Remove each here and in the workspace file once a
// fix is published.
const ALLOWED_WAIVERS = Object.freeze(['GHSA-ch52-4w7c-c8xp', 'GHSA-hp3w-g68c-fv3c']);

// The 16 live CVE override-pins, key -> exact CVE-safe floor. Each pin's reason
// lives as a comment above it in pnpm-workspace.yaml. This map is the frozen
// floor list: the contract check asserts pnpm-workspace.yaml matches it
// value-for-value, so a coordinated downgrade (workspace edited + `pnpm install`
// re-run, both files agreeing) still fails rather than passing an equal-vs-equal
// check against the lockfile. Frozen so a test can't mutate it.
const EXPECTED_OVERRIDES = new Map(
  Object.entries(
    Object.freeze({
      'fast-uri': '>=4.1.5',
      'brace-expansion@>=5.0.0 <5.0.6': '>=5.0.6',
      protobufjs: '>=7.5.8 <8',
      qs: '>=6.15.2',
      '@grpc/grpc-js': '>=1.14.5',
      'undici@>=7.0.0 <7.29.1': '>=7.29.1 <8',
      'undici@<6.27.0': '>=6.27.0 <7',
      'form-data@>=4.0.0 <4.0.6': '>=4.0.6',
      'multer@>=1.0.0 <2.4.0': '>=2.4.0',
      'body-parser@>=2.0.0 <2.3.0': '>=2.3.0 <3',
      'dompurify@<3.4.16': '>=3.4.16 <4',
      'nanoid@<3.3.17': '>=3.3.17 <4',
      browserslist: '>=4.28.7 <5',
      'proxy-addr@<2.0.8': '>=2.0.8 <3',
      'source-map-js@<1.2.2': '>=1.2.2 <2',
      'smol-toml@<1.9.0': '>=1.9.0 <2',
    }),
  ),
);

// Strip a single layer of surrounding single/double quotes (pnpm-workspace.yaml
// double-quotes its keys/values; pnpm-lock.yaml single-quotes values and leaves
// most keys bare — so the two files must compare equal after this).
function stripQuotes(s) {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

// Collect the `  <key>: <value>` lines of the block introduced by a
// `^<blockName>:` line and terminated by the next column-0 (`^\S`) line.
// Returns a Map<key, value> with quotes stripped from both sides.
function parseOverridesBlock(source, blockName, label) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l === `${blockName}:`);
  assert.notEqual(
    start,
    -1,
    `${label}: expected a top-level \`${blockName}:\` block — the line-scan format changed`,
  );
  const map = new Map();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next column-0 line ends the block
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // key up to the first `: ` separator (override keys contain no colon);
    // value is the remainder.
    const m = line.match(/^\s+(.+?):\s+(.+)$/);
    assert.notEqual(
      m,
      null,
      `${label}: could not parse override line ${JSON.stringify(line)} — the line-scan format changed`,
    );
    map.set(stripQuotes(m[1]), stripQuotes(m[2]));
  }
  return map;
}

// Collect each override key's reason: the text of the indented `#` comment
// lines directly above it, with no blank line between. A key consumes the
// comment lines above it, so a comment never counts for the next key, and a
// blank line detaches whatever precedes it. Returns Map<key, reason>; an
// uncommented key maps to ''. Keys are quote-stripped like parseOverridesBlock.
// A column-0 comment ends the block (as in parseOverridesBlock), so reasons
// must be indented.
function parseOverrideReasons(source, blockName, label) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l === `${blockName}:`);
  assert.notEqual(
    start,
    -1,
    `${label}: expected a top-level \`${blockName}:\` block — the line-scan format changed`,
  );
  const reasons = new Map();
  let pending = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === '') {
      pending = [];
      continue;
    }
    if (trimmed.startsWith('#')) {
      pending.push(trimmed.replace(/^#+/, '').trim());
      continue;
    }
    const m = line.match(/^\s+(.+?):\s+(.+)$/);
    assert.notEqual(
      m,
      null,
      `${label}: could not parse override line ${JSON.stringify(line)} — the line-scan format changed`,
    );
    reasons.set(stripQuotes(m[1]), pending.filter(Boolean).join(' '));
    pending = [];
  }
  return reasons;
}

// Keys whose attached reason is empty.
function overridesWithoutReason(reasons) {
  return [...reasons].filter(([, reason]) => reason === '').map(([key]) => key);
}

// Pure key-level comparison of two override maps. Returns one entry per
// difference: `missing` (key in `a`, absent from `b`), `extra` (key in `b`,
// absent from `a`), or `value` (present in both, values differ). Shared by the
// registry-drift check, the stale-lockfile check, and their synthetic-drift
// tests so every mismatch branch is directly exercisable.
function diffOverrides(a, b) {
  const diffs = [];
  for (const [key, expected] of a) {
    if (!b.has(key)) {
      diffs.push({ key, kind: 'missing', expected });
    } else if (b.get(key) !== expected) {
      diffs.push({ key, kind: 'value', expected, actual: b.get(key) });
    }
  }
  for (const [key, actual] of b) {
    if (!a.has(key)) {
      diffs.push({ key, kind: 'extra', actual });
    }
  }
  return diffs;
}

// Render one `diffOverrides` entry as a human message. `aLabel`/`bLabel` name
// the two compared sources; `remedy` is the trailing fix hint (empty for an
// `extra` key, which has no natural remedy).
function formatDiff(diff, aLabel, bLabel, remedy) {
  if (diff.kind === 'missing') {
    return `\`${diff.key}\` present in ${aLabel} but missing from ${bLabel}${remedy}`;
  }
  if (diff.kind === 'extra') {
    return `\`${diff.key}\` present in ${bLabel} but missing from ${aLabel}`;
  }
  return `\`${diff.key}\` version differs: ${aLabel}=${JSON.stringify(diff.expected)} vs ${bLabel}=${JSON.stringify(diff.actual)}${remedy}`;
}

test('root package.json has no `pnpm` key (pnpm 10 silently ignores it)', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(pkg, 'pnpm'),
    'root package.json must NOT contain a `pnpm` key — pnpm 10 reads overrides/' +
      'onlyBuiltDependencies/auditConfig from pnpm-workspace.yaml, so a `pnpm` ' +
      'block here would be silently dead (CVE pins that look present but do nothing)',
  );
});

test('pnpm-workspace.yaml overrides match the CVE-pin registry exactly', () => {
  const workspaceSrc = readFileSync(WORKSPACE_YAML, 'utf8');
  const workspaceOverrides = parseOverridesBlock(
    workspaceSrc,
    'overrides',
    'pnpm-workspace.yaml',
  );

  // Fail loud on a vacuous empty comparison from a format drift.
  assert.ok(
    workspaceOverrides.size > 0,
    'parsed 0 overrides from pnpm-workspace.yaml — line-scan format changed',
  );

  // Exact-pin identity: every key present with its CVE-safe floor, no key
  // added or dropped. This catches a *coordinated* downgrade — a pin edited to
  // an old vulnerable range with `pnpm install` re-run so the lockfile agrees —
  // which the stale-lockfile check below cannot see.
  const drift = diffOverrides(EXPECTED_OVERRIDES, workspaceOverrides);
  assert.equal(
    drift.length,
    0,
    'pnpm-workspace.yaml `overrides:` drifted from the CVE-pin registry ' +
      '(EXPECTED_OVERRIDES):\n  - ' +
      drift
        .map((d) =>
          formatDiff(
            d,
            'the CVE-pin registry',
            'pnpm-workspace.yaml',
            ' — restore the CVE-safe floor, or update EXPECTED_OVERRIDES only with a documented reason',
          ),
        )
        .join('\n  - '),
  );
});

test('pnpm-workspace.yaml overrides equal pnpm-lock.yaml overrides key-for-key', () => {
  const workspaceSrc = readFileSync(WORKSPACE_YAML, 'utf8');
  const lockSrc = readFileSync(LOCKFILE_YAML, 'utf8');

  const workspaceOverrides = parseOverridesBlock(
    workspaceSrc,
    'overrides',
    'pnpm-workspace.yaml',
  );
  const lockOverrides = parseOverridesBlock(lockSrc, 'overrides', 'pnpm-lock.yaml');

  // Fail loud on a vacuous empty-vs-empty comparison from a format drift.
  assert.ok(
    workspaceOverrides.size > 0,
    'parsed 0 overrides from pnpm-workspace.yaml — line-scan format changed',
  );
  assert.ok(
    lockOverrides.size > 0,
    'parsed 0 overrides from pnpm-lock.yaml — line-scan format changed',
  );

  // Stale-lockfile check: an uninstalled workspace edit leaves the two files
  // disagreeing. Compare key-for-key and value-for-value, naming any mismatch.
  const mismatches = diffOverrides(workspaceOverrides, lockOverrides);
  assert.equal(
    mismatches.length,
    0,
    `pnpm-workspace.yaml overrides drifted from pnpm-lock.yaml:\n  - ${mismatches
      .map((d) =>
        formatDiff(d, 'pnpm-workspace.yaml', 'pnpm-lock.yaml', ' (run `pnpm install`)'),
      )
      .join('\n  - ')}`,
  );
});

test('every pnpm-workspace.yaml override has a reason comment directly above it', () => {
  const reasons = parseOverrideReasons(
    readFileSync(WORKSPACE_YAML, 'utf8'),
    'overrides',
    'pnpm-workspace.yaml',
  );
  assert.equal(
    reasons.size,
    EXPECTED_OVERRIDES.size,
    'parsed an unexpected number of overrides from pnpm-workspace.yaml — line-scan format changed',
  );
  const bare = overridesWithoutReason(reasons);
  assert.deepEqual(
    bare,
    [],
    'every override in pnpm-workspace.yaml needs a reason comment on the lines directly ' +
      'above it (the advisory it clears and the path that pulls the package in); missing for: ' +
      bare.map((k) => `\`${k}\``).join(', '),
  );
});

test('pnpm-workspace.yaml keeps the build allow-list and carries only the allowed audit waivers', () => {
  const workspaceSrc = readFileSync(WORKSPACE_YAML, 'utf8');
  assert.match(
    workspaceSrc,
    /^onlyBuiltDependencies:/m,
    'pnpm-workspace.yaml must keep the `onlyBuiltDependencies:` build allow-list',
  );
  // Exactly the dated waivers in ALLOWED_WAIVERS and nothing else. A new waiver
  // needs a fresh reachability argument and a review expiry written as a comment
  // above it in pnpm-workspace.yaml — not a silent re-add.
  const waived = [...workspaceSrc.matchAll(/^\s+-\s+(GHSA-[a-z0-9-]+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(
    waived,
    [...ALLOWED_WAIVERS],
    'pnpm-workspace.yaml audit waivers must equal ALLOWED_WAIVERS in this test; ' +
      'adding one needs a reachability argument and an expiry as a comment in ' +
      'pnpm-workspace.yaml',
  );
  if (ALLOWED_WAIVERS.length > 0) {
    assert.match(workspaceSrc, AUDIT_CONFIG_RE);
    assert.match(workspaceSrc, IGNORE_GHSAS_RE);
  }
});

// --- Detection-branch coverage (synthetic in-memory fixtures) -------------
// The guard exists to DETECT drift; the tests above only exercise the passing
// real files. These drive the parse/compare helpers directly against crafted
// inputs so the negative half of every branch is proven.

test('stripQuotes strips one matching quote layer and trims, leaving bare/unmatched text', () => {
  assert.equal(stripQuotes('">=6.15.2"'), '>=6.15.2');
  assert.equal(stripQuotes("'>=6.27.0 <7'"), '>=6.27.0 <7');
  assert.equal(stripQuotes('  qs  '), 'qs');
  assert.equal(stripQuotes('">=1'), '">=1'); // unmatched opening quote — unchanged
});

test('parseOverridesBlock throws when the named block is absent', () => {
  const src = 'packages:\n  - "apps/*"\n';
  assert.throws(
    () => parseOverridesBlock(src, 'overrides', 'fixture'),
    /fixture: expected a top-level `overrides:` block/,
  );
});

test('parseOverridesBlock throws on an unparseable override line (no `: ` separator)', () => {
  const src = 'overrides:\n  bad-line-without-separator\n';
  assert.throws(
    () => parseOverridesBlock(src, 'overrides', 'fixture'),
    /fixture: could not parse override line/,
  );
});

test('parseOverridesBlock returns an empty map for a block ended immediately by a column-0 line', () => {
  const src = 'overrides:\nauditConfig:\n  ignoreGhsas:\n    - GHSA-x\n';
  const map = parseOverridesBlock(src, 'overrides', 'fixture');
  assert.equal(map.size, 0);
});

test('parseOverridesBlock parses quoted keys and values, skipping blanks and comments', () => {
  const src =
    'overrides:\n' +
    '  # a comment\n' +
    '\n' +
    '  "form-data@>=4.0.0 <4.0.6": ">=4.0.6"\n' +
    '  qs: ">=6.15.2"\n' +
    'nextTopLevel:\n';
  const map = parseOverridesBlock(src, 'overrides', 'fixture');
  assert.equal(map.size, 2);
  assert.equal(map.get('form-data@>=4.0.0 <4.0.6'), '>=4.0.6');
  assert.equal(map.get('qs'), '>=6.15.2');
});

test('parseOverridesBlock ignores comment lines above a key, so a commented block still parses to values only', () => {
  const src =
    'overrides:\n' +
    '  # reason for qs\n' +
    '  # second line\n' +
    '  qs: ">=6.15.2"\n' +
    '  # reason for form-data\n' +
    '  "form-data@>=4.0.0 <4.0.6": ">=4.0.6"\n' +
    'nextTopLevel:\n';
  const map = parseOverridesBlock(src, 'overrides', 'fixture');
  assert.deepEqual([...map], [
    ['qs', '>=6.15.2'],
    ['form-data@>=4.0.0 <4.0.6', '>=4.0.6'],
  ]);
});

test('parseOverrideReasons joins the comment lines directly above each key', () => {
  const src =
    'overrides:\n' +
    '  # advisory one\n' +
    '  # path one\n' +
    '  qs: ">=6.15.2"\n' +
    '  # advisory two\n' +
    '  "form-data@>=4.0.0 <4.0.6": ">=4.0.6"\n' +
    'nextTopLevel:\n';
  const reasons = parseOverrideReasons(src, 'overrides', 'fixture');
  assert.equal(reasons.get('qs'), 'advisory one path one');
  assert.equal(reasons.get('form-data@>=4.0.0 <4.0.6'), 'advisory two');
  assert.deepEqual(overridesWithoutReason(reasons), []);
});

test('parseOverrideReasons throws when the named block is absent', () => {
  assert.throws(
    () => parseOverrideReasons('packages:\n', 'overrides', 'fixture'),
    /fixture: expected a top-level `overrides:` block/,
  );
});

test('an override with no reason comment is reported by key', () => {
  const src =
    'overrides:\n' +
    '  # reason for qs\n' +
    '  qs: ">=6.15.2"\n' +
    '  fast-uri: ">=4.1.5"\n';
  const reasons = parseOverrideReasons(src, 'overrides', 'fixture');
  assert.deepEqual(overridesWithoutReason(reasons), ['fast-uri']);
});

test('a reason above a neighbouring override does not count for the next key', () => {
  // Three keys, three comment lines, but the second comment sits above `qs`
  // and `fast-uri` has none: a comment-line count would pass, attachment fails.
  const src =
    'overrides:\n' +
    '  # first line\n' +
    '  # second line\n' +
    '  qs: ">=6.15.2"\n' +
    '  fast-uri: ">=4.1.5"\n' +
    '  # reason for protobufjs\n' +
    '  protobufjs: ">=7.5.8 <8"\n';
  const reasons = parseOverrideReasons(src, 'overrides', 'fixture');
  assert.deepEqual(overridesWithoutReason(reasons), ['fast-uri']);
});

test('a reason separated from its key by a blank line is not attached', () => {
  const src =
    'overrides:\n' +
    '  # reason for qs\n' +
    '\n' +
    '  qs: ">=6.15.2"\n';
  const reasons = parseOverrideReasons(src, 'overrides', 'fixture');
  assert.deepEqual(overridesWithoutReason(reasons), ['qs']);
});

test('an empty comment (`#` alone) is not a reason', () => {
  const src = 'overrides:\n  #\n  qs: ">=6.15.2"\n';
  const reasons = parseOverrideReasons(src, 'overrides', 'fixture');
  assert.deepEqual(overridesWithoutReason(reasons), ['qs']);
});

test('a fully commented override block has no key without a reason', () => {
  const src =
    'overrides:\n' +
    '  # reason for qs\n' +
    '  qs: ">=6.15.2"\n' +
    '  # reason for form-data\n' +
    '  # path for form-data\n' +
    '  "form-data@>=4.0.0 <4.0.6": ">=4.0.6"\n' +
    'nextTopLevel:\n';
  const reasons = parseOverrideReasons(src, 'overrides', 'fixture');
  assert.equal(reasons.size, 2);
  assert.deepEqual(overridesWithoutReason(reasons), []);
});

test('diffOverrides names a value drift, a dropped key, and an added key', () => {
  const base = new Map([
    ['a', '>=1'],
    ['b', '>=2'],
    ['c', '>=3'],
  ]);
  const drifted = new Map([
    ['a', '>=1'], // unchanged
    ['b', '>=9'], // value drift
    ['d', '>=4'], // added (extra); `c` dropped (missing)
  ]);
  const diffs = diffOverrides(base, drifted).sort((x, y) =>
    x.key.localeCompare(y.key),
  );
  assert.deepEqual(diffs, [
    { key: 'b', kind: 'value', expected: '>=2', actual: '>=9' },
    { key: 'c', kind: 'missing', expected: '>=3' },
    { key: 'd', kind: 'extra', actual: '>=4' },
  ]);
});

test('diffOverrides is empty for identical maps', () => {
  const a = new Map([['x', '>=1']]);
  const b = new Map([['x', '>=1']]);
  assert.deepEqual(diffOverrides(a, b), []);
});

test('a synthetic workspace fixture that reintroduces an audit waiver fails the no-waiver assertions', () => {
  // Proves the "must not contain" checks above are not passing vacuously
  // against the real (already-clean) file — a fixture that DOES carry a
  // reintroduced waiver must be rejected by the same regexes.
  const reintroducedWaiver =
    'onlyBuiltDependencies:\n' +
    '  - esbuild\n' +
    '\n' +
    '# a waiver someone added back without re-running the audit\n' +
    'auditConfig:\n' +
    '  ignoreGhsas:\n' +
    '    - GHSA-8988-4f7v-96qf\n';
  assert.throws(
    () =>
      assert.doesNotMatch(
        reintroducedWaiver,
        AUDIT_CONFIG_RE,
        'must not carry an `auditConfig:` block',
      ),
    /must not carry an `auditConfig:` block/,
  );
  assert.throws(
    () =>
      assert.doesNotMatch(
        reintroducedWaiver,
        IGNORE_GHSAS_RE,
        'must not carry an `ignoreGhsas:` list',
      ),
    /must not carry an `ignoreGhsas:` list/,
  );
});
