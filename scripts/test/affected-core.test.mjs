// Unit tests for the pure affected-test decision logic. Runs via
// `node --test scripts/test/` (joined to `pnpm test` by the root `test`
// script). Lives in scripts/test/ — NOT flat scripts/ — so Node's test
// runner does not auto-execute scripts/test-affected.mjs (it matches Node's
// built-in `test-*.mjs` discovery glob and would fire git/child_process).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyChange, decideFromProbe } from '../affected-core.mjs';

// --- classifyChange: select ------------------------------------------------

test('select — web-only files, prefix stripped to package-relative', () => {
  const r = classifyChange(['apps/web/src/lib/foo.ts', 'apps/web/src/pages/Bar.tsx']);
  assert.deepEqual(r, {
    mode: 'select',
    webFiles: ['src/lib/foo.ts', 'src/pages/Bar.tsx'],
    apiFiles: [],
  });
});

test('select — api-only files, prefix stripped', () => {
  const r = classifyChange(['apps/api/src/sync/push.service.ts']);
  assert.deepEqual(r, {
    mode: 'select',
    webFiles: [],
    apiFiles: ['src/sync/push.service.ts'],
  });
});

test('select — mixed web + api buckets', () => {
  const r = classifyChange([
    'apps/web/src/lib/a.ts',
    'apps/api/src/auth/b.ts',
  ]);
  assert.deepEqual(r, {
    mode: 'select',
    webFiles: ['src/lib/a.ts'],
    apiFiles: ['src/auth/b.ts'],
  });
});

test('select — docs mixed with source: docs ignored, not noop', () => {
  const r = classifyChange([
    'README.md',
    'docs/guide.md',
    'apps/web/src/lib/a.ts',
  ]);
  assert.deepEqual(r, {
    mode: 'select',
    webFiles: ['src/lib/a.ts'],
    apiFiles: [],
  });
});

test('select — .mjs / .cjs are recognized source extensions', () => {
  const r = classifyChange(['apps/api/src/x.mjs', 'apps/web/src/y.cjs']);
  assert.equal(r.mode, 'select');
  assert.deepEqual(r.apiFiles, ['src/x.mjs']);
  assert.deepEqual(r.webFiles, ['src/y.cjs']);
});

// --- classifyChange: escalate (denylist) -----------------------------------

for (const denied of [
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'apps/web/tsconfig.json',
  'apps/api/tsconfig.json',
  'apps/web/vite.config.ts',
  'apps/web/vitest.config.ts',
  'apps/api/jest.config.cjs',
  'apps/web/src/test/setup.ts',
  'apps/api/src/test/jest.setup.ts',
  'apps/web/src/styles.css',
  'apps/web/src/lib/tokens.ts',
  'apps/web/src/db/migrations.ts',
]) {
  test(`escalate — denylist path: ${denied}`, () => {
    const r = classifyChange([denied, 'apps/web/src/lib/safe.ts']);
    assert.deepEqual(r, { mode: 'escalate', webFiles: [], apiFiles: [] });
  });
}

// --- classifyChange: escalate (unrecognized files) -------------------------

test('escalate — source file outside apps/web and apps/api (no spec maps it)', () => {
  const r = classifyChange(['scripts/test-affected.mjs']);
  assert.equal(r.mode, 'escalate');
});

for (const stray of [
  'apps/web/src/components/Foo.css', // a .css that is NOT styles.css
  'apps/web/data.json', // a .json that is NOT tsconfig
  'index.html', // not a source file or a docs-only path
  'docker-compose.yaml', // not a source file or a docs-only path
]) {
  test(`escalate — unrecognized extension: ${stray}`, () => {
    const r = classifyChange([stray]);
    assert.deepEqual(r, { mode: 'escalate', webFiles: [], apiFiles: [] });
  });
}

test('escalate — denylist wins even when mixed with docs and valid source', () => {
  const r = classifyChange([
    'README.md',
    'apps/api/src/sync/ok.ts',
    'pnpm-lock.yaml',
  ]);
  assert.equal(r.mode, 'escalate');
});

// --- classifyChange: noop (docs-only) --------------------------------------

for (const docs of [
  ['README.md'],
  ['docs/guide.md', 'docs/api/design.md'],
  ['notes.txt'],
  ['apps/web/public/logo.png', 'apps/web/public/icon.svg'],
  ['README.md', 'docs/architecture.md', 'CHANGELOG.txt', 'docs/diagram.webp'],
]) {
  test(`noop — docs/assets only: ${docs.join(', ')}`, () => {
    const r = classifyChange(docs);
    assert.deepEqual(r, { mode: 'noop', webFiles: [], apiFiles: [] });
  });
}

test('noop — empty change set', () => {
  assert.deepEqual(classifyChange([]), {
    mode: 'noop',
    webFiles: [],
    apiFiles: [],
  });
});

// --- classifyChange: basis-agnostic / deterministic ------------------------

test('classification is deterministic for identical input', () => {
  const paths = ['apps/web/src/a.ts', 'README.md', 'apps/api/src/b.ts'];
  assert.deepEqual(classifyChange(paths), classifyChange([...paths]));
});

test('classification depends only on paths, not their origin order of buckets', () => {
  const a = classifyChange(['apps/api/src/b.ts', 'apps/web/src/a.ts']);
  assert.equal(a.mode, 'select');
  assert.deepEqual(a.webFiles, ['src/a.ts']);
  assert.deepEqual(a.apiFiles, ['src/b.ts']);
});

// --- decideFromProbe -------------------------------------------------------

test('decideFromProbe — source bucket, zero matches → escalate', () => {
  assert.equal(decideFromProbe({ hasSource: true, matchedCount: 0 }), 'escalate');
});

test('decideFromProbe — source bucket, matches found → run', () => {
  assert.equal(decideFromProbe({ hasSource: true, matchedCount: 4 }), 'run');
});

test('decideFromProbe — no source in bucket → run (empty bucket is a no-op)', () => {
  assert.equal(decideFromProbe({ hasSource: false, matchedCount: 0 }), 'run');
  assert.equal(decideFromProbe({ hasSource: false, matchedCount: 3 }), 'run');
});
