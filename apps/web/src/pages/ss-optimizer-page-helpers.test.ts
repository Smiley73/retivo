// `optimizerAggregatesSignature`, the content/stability contract the SsOptimizerPage `reload` bail-early guard depends on: idempotent for identical input, changes on any version bump or row add/remove across any aggregate set, order-independent for the `medicalCategoryIds` set.
import { describe, expect, it } from 'vitest';
import { optimizerAggregatesSignature } from './ss-optimizer-page-helpers';
import type { OptimizerAggregates } from './ss-optimizer-page-chrome';

// The signature reads only `id` + `version` per row (plus the medical-category id set), so a minimal cast row is a faithful fixture.
function row(id: string, version: number): { id: string; version: number } {
  return { id, version };
}

function aggregates(
  overrides: Partial<{
    scenarios: Array<{ id: string; version: number }>;
    members: Array<{ id: string; version: number }>;
    accounts: Array<{ id: string; version: number }>;
    balances: Array<{ id: string; version: number }>;
    ssBenefits: Array<{ id: string; version: number }>;
    expenses: Array<{ id: string; version: number }>;
    incomeStreams: Array<{ id: string; version: number }>;
    medicalCategoryIds: ReadonlyArray<string>;
  }> = {},
): OptimizerAggregates {
  return {
    scenarios: overrides.scenarios ?? [row('s1', 1)],
    members: overrides.members ?? [row('m1', 1)],
    accounts: overrides.accounts ?? [row('a1', 1)],
    balances: overrides.balances ?? [row('b1', 1)],
    ssBenefits: overrides.ssBenefits ?? [row('ss1', 1)],
    expenses: overrides.expenses ?? [row('e1', 1)],
    incomeStreams: overrides.incomeStreams ?? [row('i1', 1)],
    medicalCategoryIds: overrides.medicalCategoryIds ?? ['cat-1', 'cat-2'],
  } as unknown as OptimizerAggregates;
}

describe('optimizerAggregatesSignature', () => {
  it('returns the same signature for identical input (idempotent)', () => {
    expect(optimizerAggregatesSignature(aggregates())).toBe(
      optimizerAggregatesSignature(aggregates()),
    );
  });

  it('changes when any aggregate row version bumps', () => {
    const base = optimizerAggregatesSignature(aggregates());
    const sets: Array<keyof OptimizerAggregates> = [
      'scenarios',
      'members',
      'accounts',
      'balances',
      'ssBenefits',
      'expenses',
      'incomeStreams',
    ];
    for (const set of sets) {
      const bumped = optimizerAggregatesSignature(
        aggregates({
          [set]: [
            row(`${String(set)[0]}1`, 2),
          ],
        }),
      );
      expect(bumped, `version bump in ${String(set)} must change signature`).not.toBe(
        base,
      );
    }
  });

  it('changes when a row is added to any aggregate list', () => {
    const base = optimizerAggregatesSignature(aggregates());
    expect(
      optimizerAggregatesSignature(
        aggregates({ scenarios: [row('s1', 1), row('s2', 1)] }),
      ),
    ).not.toBe(base);
  });

  it('changes when a row is removed from any aggregate list', () => {
    const base = optimizerAggregatesSignature(
      aggregates({ accounts: [row('a1', 1), row('a2', 1)] }),
    );
    expect(
      optimizerAggregatesSignature(aggregates({ accounts: [row('a1', 1)] })),
    ).not.toBe(base);
  });

  it('is order-independent for medicalCategoryIds (sorted before joining)', () => {
    expect(
      optimizerAggregatesSignature(
        aggregates({ medicalCategoryIds: ['cat-2', 'cat-1'] }),
      ),
    ).toBe(
      optimizerAggregatesSignature(
        aggregates({ medicalCategoryIds: ['cat-1', 'cat-2'] }),
      ),
    );
  });

  it('changes when a medical-category id is added or removed', () => {
    const base = optimizerAggregatesSignature(
      aggregates({ medicalCategoryIds: ['cat-1'] }),
    );
    expect(
      optimizerAggregatesSignature(
        aggregates({ medicalCategoryIds: ['cat-1', 'cat-2'] }),
      ),
    ).not.toBe(base);
  });
});
