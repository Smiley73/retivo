/**
 * Tests for the shared CBP resolver + validator. Pins the election, remediation and annuity-match rules.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveLinkedCbpIncomeStreams,
  validateCbpResolution,
} from './cbp-resolution';
import type {
  AccountPayload,
  Aggregate,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const HH = 'hh-1';

const account = (
  id: string,
  overrides: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> => ({
  id,
  householdId: HH,
  aggregateType: 'account',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: {
    name: id,
    type: 'RETIREMENT_CASH_BALANCE',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'PRE_TAX',
    ownerId: 'm-primary',
    institution: '',
    notes: '',
    planningReturnPct: 3,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 0, bondsPct: 0, cashPct: 100 },
    ...overrides,
  },
});

const stream = (
  id: string,
  overrides: Partial<IncomeStreamPayload> = {},
): Aggregate<IncomeStreamPayload> => ({
  id,
  householdId: HH,
  aggregateType: 'incomeStream',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: {
    name: id,
    kind: 'pension',
    payoutType: 'annuity',
    memberId: 'm-primary',
    monthlyBenefit: 1000,
    start: { kind: 'age', years: 65, months: 0 },
    colaPct: 0,
    ...overrides,
  } as IncomeStreamPayload,
});

const scenario = (
  id: string,
  parentScenarioId: string | null,
  overrides: Partial<ScenarioPayload> = {},
): ScenarioAggregate => ({
  id,
  householdId: HH,
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: {
    name: id,
    description: '',
    parentScenarioId,
    isPrimary: parentScenarioId === null,
    notes: '',
    overrides: {},
    ...overrides,
  },
});

const cbp = (id: string, owner = 'm-primary') =>
  account(id, { type: 'RETIREMENT_CASH_BALANCE', ownerId: owner });

const ira = (id: string) =>
  account(id, { type: 'RETIREMENT_IRA' });

describe('resolveLinkedCbpIncomeStreams', () => {
  it('returns an annuity election when exactly one matching stream exists', () => {
    const accounts = [cbp('cbp-1'), ira('ira-1')];
    const streams = [
      stream('s1', { linkedCbpAccountId: 'cbp-1', payoutType: 'annuity' }),
    ];
    const sc = scenario('s', null);
    const out = resolveLinkedCbpIncomeStreams({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(out.size).toBe(1);
    expect(out.get('cbp-1')).toEqual({
      kind: 'annuity',
      streamId: 'aggregate:s1',
    });
  });

  it('returns a lumpSum election with its targetAccountId', () => {
    const accounts = [cbp('cbp-1'), ira('ira-1')];
    const streams = [
      stream('s1', {
        linkedCbpAccountId: 'cbp-1',
        payoutType: 'lumpSum',
        lumpSumAmount: 0,
        targetAccountId: 'ira-1',
      }),
    ];
    const sc = scenario('s', null);
    const out = resolveLinkedCbpIncomeStreams({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(out.get('cbp-1')).toEqual({
      kind: 'lumpSum',
      streamId: 'aggregate:s1',
      targetAccountId: 'ira-1',
    });
  });

  it('child scenario election wins over parent (per-id sparse resolution)', () => {
    const accounts = [cbp('cbp-1'), ira('ira-1')];
    const streams = [
      stream('s1', { linkedCbpAccountId: 'cbp-1', payoutType: 'annuity' }),
    ];
    // Parent disables the canonical annuity; child adds a lump-sum
    // replacement linked to the same CBP account.
    const parent = scenario('parent', null, {
      overrides: { income: { disabledIds: ['aggregate:s1'] } },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        income: {
          added: [
            {
              _localId: 'l-1',
              name: 'Lump',
              kind: 'pension',
              payoutType: 'lumpSum',
              memberId: 'm-primary',
              lumpSumAmount: 50000,
              targetAccountId: 'ira-1',
              start: { kind: 'age', years: 65, months: 0 },
              linkedCbpAccountId: 'cbp-1',
            } as IncomeStreamPayload & { _localId: string },
          ],
        },
      },
    });
    const out = resolveLinkedCbpIncomeStreams({
      scenarioId: 'child',
      scenarios: [parent, child],
      accounts,
      incomeStreams: streams,
    });
    expect(out.get('cbp-1')).toEqual({
      kind: 'lumpSum',
      streamId: 'local:l-1',
      targetAccountId: 'ira-1',
    });
  });

  it('drops the entry when no income stream links to the CBP account', () => {
    const accounts = [cbp('cbp-1')];
    const sc = scenario('s', null);
    const out = resolveLinkedCbpIncomeStreams({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: [],
    });
    expect(out.size).toBe(0);
  });

  it('drops the entry when two streams link the same CBP account (annuity duplicate)', () => {
    const accounts = [cbp('cbp-1')];
    const streams = [
      stream('s1', { linkedCbpAccountId: 'cbp-1', payoutType: 'annuity' }),
      stream('s2', { linkedCbpAccountId: 'cbp-1', payoutType: 'annuity', name: 'Dup' }),
    ];
    const sc = scenario('s', null);
    const out = resolveLinkedCbpIncomeStreams({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(out.size).toBe(0);
  });

  it('rejects a linked stream whose owner differs from the CBP individual owner', () => {
    const accounts = [cbp('cbp-1', 'm-primary')];
    const streams = [
      stream('s1', {
        linkedCbpAccountId: 'cbp-1',
        payoutType: 'annuity',
        memberId: 'm-secondary',
      }),
    ];
    const sc = scenario('s', null);
    const out = resolveLinkedCbpIncomeStreams({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(out.size).toBe(0);
  });
});

describe('validateCbpResolution', () => {
  it('ok=true when every CBP account has exactly one matching linked stream', () => {
    const accounts = [cbp('cbp-1'), cbp('cbp-2', 'm-secondary')];
    const streams = [
      stream('s1', { linkedCbpAccountId: 'cbp-1' }),
      stream('s2', { linkedCbpAccountId: 'cbp-2', memberId: 'm-secondary' }),
    ];
    const sc = scenario('s', null);
    const result = validateCbpResolution({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(result.ok).toBe(true);
    expect(result.unconfigured).toEqual([]);
    expect(result.annuityDuplicateStream).toEqual([]);
  });

  it('reports CBP accounts with zero matching linked streams as unconfigured', () => {
    const accounts = [cbp('cbp-1'), cbp('cbp-2', 'm-secondary')];
    const streams = [stream('s1', { linkedCbpAccountId: 'cbp-1' })];
    const sc = scenario('s', null);
    const result = validateCbpResolution({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(result.ok).toBe(false);
    expect(result.unconfigured).toEqual(['cbp-2']);
  });

  it('reports CBP accounts with multiple matching linked streams as duplicates', () => {
    const accounts = [cbp('cbp-1')];
    const streams = [
      stream('s1', { linkedCbpAccountId: 'cbp-1' }),
      stream('s2', { linkedCbpAccountId: 'cbp-1', name: 'Dup' }),
    ];
    const sc = scenario('s', null);
    const result = validateCbpResolution({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(result.ok).toBe(false);
    expect(result.annuityDuplicateStream).toEqual(['cbp-1']);
  });

  it('ignores non-CBP accounts entirely', () => {
    const accounts = [ira('ira-1')];
    const sc = scenario('s', null);
    const result = validateCbpResolution({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: [],
    });
    expect(result.ok).toBe(true);
  });

  it('treats an owner-mismatched linked stream as zero-match (unconfigured)', () => {
    const accounts = [cbp('cbp-1', 'm-primary')];
    const streams = [
      stream('s1', {
        linkedCbpAccountId: 'cbp-1',
        memberId: 'm-secondary',
      }),
    ];
    const sc = scenario('s', null);
    const result = validateCbpResolution({
      scenarioId: 's',
      scenarios: [sc],
      accounts,
      incomeStreams: streams,
    });
    expect(result.ok).toBe(false);
    expect(result.unconfigured).toEqual(['cbp-1']);
  });
});
