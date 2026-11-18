import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, describe, hasPatch } from '../audit-fixable-core.mjs';

const adv = (over) => ({
  id: 1,
  module_name: 'pkg',
  severity: 'high',
  vulnerable_versions: '<1.0.0',
  patched_versions: '>=1.0.0',
  github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
  findings: [{ paths: ['.>a>pkg'] }],
  ...over,
});
const report = (...advisories) => ({ advisories: Object.fromEntries(advisories.map((a, i) => [String(i), a])) });

test('an advisory with a patched release fails the gate', () => {
  const { failing, unfixable } = classify(report(adv({})));
  assert.equal(failing.length, 1);
  assert.equal(unfixable.length, 0);
});

test('an advisory nobody has patched is reported, not failed', () => {
  for (const patched of ['<0.0.0', ' <0.0.0 ', '', undefined, null]) {
    const { failing, unfixable } = classify(report(adv({ patched_versions: patched })));
    assert.equal(failing.length, 0, String(patched));
    assert.equal(unfixable.length, 1, String(patched));
  }
});

test('hasPatch is false for no advisory at all', () => {
  assert.equal(hasPatch(undefined), false);
  assert.equal(hasPatch(adv({ patched_versions: '>=2.0.0 <3.0.0 || >=3.1.0' })), true);
});

test('advisories below the audit level are ignored', () => {
  const low = adv({ severity: 'low' });
  const moderate = adv({ severity: 'moderate' });
  assert.equal(classify(report(low, moderate), 'moderate').failing.length, 1);
  assert.equal(classify(report(low, moderate), 'high').failing.length, 0);
  assert.equal(classify(report(low, moderate), 'low').failing.length, 2);
});

test('an unknown severity counts as critical and is never dropped', () => {
  assert.equal(classify(report(adv({ severity: 'weird' })), 'critical').failing.length, 1);
});

test('a mix is split: the fixable one fails, the unfixable one is only reported', () => {
  const { failing, unfixable } = classify(report(adv({ module_name: 'fixable' }), adv({ module_name: 'stuck', patched_versions: '<0.0.0' })));
  assert.deepEqual(failing.map((a) => a.module_name), ['fixable']);
  assert.deepEqual(unfixable.map((a) => a.module_name), ['stuck']);
});

test('a clean report passes and a malformed one throws instead of passing', () => {
  assert.deepEqual(classify({ advisories: {} }), { failing: [], unfixable: [] });
  for (const bad of [null, undefined, {}, { advisories: null }, 'x']) assert.throws(() => classify(bad), /not a pnpm audit report/);
  assert.throws(() => classify({ advisories: {} }, 'severe'), /unknown audit level/);
});

test('describe names the package, advisory and path, and caps the path list', () => {
  const text = describe(adv({ findings: [{ paths: ['p1', 'p2', 'p3', 'p4', 'p5'] }] }));
  assert.match(text, /^high pkg <1\.0\.0 \(GHSA-aaaa-bbbb-cccc, patched: >=1\.0\.0\) via p1, p2, p3, \+2 more$/);
  assert.match(describe(adv({ patched_versions: '' })), /patched: none/);
});
