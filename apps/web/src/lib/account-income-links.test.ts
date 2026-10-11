/**
 * Unit tests for the account ↔ income structural reference scan.
 * Pure function — no IO, no a11y surface. The "deleted-income
 * excluded" guarantee is a caller contract (tombstone-filtered
 * `listAggregates` input), asserted at the page boundary, not here.
 */
import { describe, expect, it } from 'vitest';
import { accountIncomeReferenceLabels } from './account-income-links';
import type {
  Aggregate,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';

const ACC = 'acc-cbp-1';

function stream(
  id: string,
  payload: Partial<IncomeStreamPayload> & { name: string },
): Aggregate<IncomeStreamPayload> {
  return {
    id,
    householdId: 'hh',
    aggregateType: 'incomeStream',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      memberId: 'hm-1',
      kind: 'pension',
      ...payload,
    } as IncomeStreamPayload,
  };
}

function scenario(
  id: string,
  name: string,
  income: ScenarioPayload['overrides']['income'],
): Aggregate<ScenarioPayload> {
  return {
    id,
    householdId: 'hh',
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: false,
      notes: '',
      overrides: { income },
    },
  };
}

describe('accountIncomeReferenceLabels', () => {
  it('matches a canonical stream linked via linkedCbpAccountId', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [stream('s1', { name: 'ACME Pension', linkedCbpAccountId: ACC })],
      [],
    );
    expect(labels).toEqual(['"ACME Pension" (Base)']);
  });

  it('matches a canonical stream pointing via targetAccountId', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [
        stream('s1', {
          name: 'Inheritance',
          kind: 'oneOff',
          targetAccountId: ACC,
        }),
      ],
      [],
    );
    expect(labels).toEqual(['"Inheritance" (Base)']);
  });

  it('excludes streams whose target/source is unset or a different account', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [
        stream('s1', { name: 'No target', kind: 'oneOff' }),
        stream('s2', {
          name: 'Other account',
          kind: 'oneOff',
          targetAccountId: 'acc-other',
        }),
        stream('s3', { name: 'Empty link', linkedCbpAccountId: '' }),
      ],
      [],
    );
    expect(labels).toEqual([]);
  });

  it('matches a scenario added[] embed and labels it with the scenario name', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [],
      [
        scenario('sc1', 'Early retirement', {
          added: [
            {
              _localId: 'lid-1',
              name: 'Scenario pension',
              memberId: 'hm-1',
              kind: 'pension',
              linkedCbpAccountId: ACC,
            },
          ],
        }),
      ],
    );
    expect(labels).toEqual([
      '"Scenario pension" (in scenario "Early retirement")',
    ]);
  });

  it('matches a scenario patches[*] embed that flips a reference field', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [],
      [
        scenario('sc1', 'What if', {
          patches: { 'base-stream-id': { targetAccountId: ACC } },
        }),
      ],
    );
    expect(labels).toEqual(['(patched in scenario "What if")']);
  });

  it('counts a structural reference even when the scenario disables it', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [stream('s1', { name: 'ACME Pension', linkedCbpAccountId: ACC })],
      [scenario('sc1', 'Disabled there', { disabledIds: ['s1'] })],
    );
    // Canonical reference still counts — structural, not resolved-state.
    expect(labels).toEqual(['"ACME Pension" (Base)']);
  });

  it('orders canonical references before scenario references', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [
        stream('s1', { name: 'Canonical A', linkedCbpAccountId: ACC }),
        stream('s2', { name: 'Canonical B', kind: 'oneOff', targetAccountId: ACC }),
      ],
      [
        scenario('sc1', 'S1', {
          added: [
            {
              _localId: 'l1',
              name: 'Added one',
              memberId: 'hm-1',
              kind: 'pension',
              linkedCbpAccountId: ACC,
            },
          ],
        }),
      ],
    );
    expect(labels).toEqual([
      '"Canonical A" (Base)',
      '"Canonical B" (Base)',
      '"Added one" (in scenario "S1")',
    ]);
  });

  it('returns all labels uncapped (the dialog owns the 20-cap)', () => {
    const streams = Array.from({ length: 25 }, (_, i) =>
      stream(`s${i}`, { name: `Stream ${i}`, linkedCbpAccountId: ACC }),
    );
    const labels = accountIncomeReferenceLabels(ACC, streams, []);
    expect(labels).toHaveLength(25);
    expect(labels[24]).toBe('"Stream 24" (Base)');
  });

  it('returns an empty array when nothing references the account', () => {
    const labels = accountIncomeReferenceLabels(
      ACC,
      [stream('s1', { name: 'Unrelated', kind: 'oneOff', targetAccountId: 'x' })],
      [scenario('sc1', 'S', { added: [] })],
    );
    expect(labels).toEqual([]);
  });
});
