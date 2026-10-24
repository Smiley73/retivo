// Working-years Roth-conversions Save fragments: sparse omit when the list resolves empty, orphan prune, amount sanitised to finite ≥ 0 whole dollars, and the rate clamped to [0, 100] and omitted at 0.
import { describe, expect, it } from 'vitest';
import {
  buildNextRothConversions,
  buildNextRothConversionTaxRate,
} from './scenario-roth-conversions-save-helpers';
import type {
  AccountPayload,
  AccountType,
  AccountTaxTreatment,
  Aggregate,
} from '../db/types';
import type { DraftRothConversion } from './scenario-roth-conversions-draft-hook';

function acct(
  id: string,
  type: AccountType = 'RETIREMENT_401K',
  taxTreatment: AccountTaxTreatment = 'PRE_TAX',
  active = true,
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'hh',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId: 'hm-1',
      institution: '',
      notes: '',
      planningReturnPct: 7,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
}

const src = (id = 'src'): Aggregate<AccountPayload> =>
  acct(id, 'RETIREMENT_401K', 'PRE_TAX');
const tgt = (id = 'tgt'): Aggregate<AccountPayload> =>
  acct(id, 'RETIREMENT_ROTH_IRA', 'ROTH');

const entry = (
  source: string,
  target: string,
  amount = 10000,
): DraftRothConversion => ({
  draftId: `draft-${source}-${target}`,
  sourceAccountId: source,
  targetRothAccountId: target,
  annualAmountDollars: amount,
  start: { kind: 'year', year: 2030 },
  end: { kind: 'year', year: 2030 },
});

describe('buildNextRothConversions', () => {
  const accounts = [src(), tgt()];

  it('omits the key when no drafts survive (sparse)', () => {
    expect(buildNextRothConversions({ drafts: [], accounts })).toEqual({});
  });

  it('persists a surviving entry with the amount sanitised to whole dollars', () => {
    const out = buildNextRothConversions({
      drafts: [entry('src', 'tgt', 9999.7)],
      accounts,
    });
    expect(out.preRetirementRothConversions).toHaveLength(1);
    expect(out.preRetirementRothConversions?.[0].annualAmountDollars).toBe(10000);
  });

  it('strips the transient draftId from the persisted entry', () => {
    const out = buildNextRothConversions({
      drafts: [entry('src', 'tgt')],
      accounts,
    });
    expect(out.preRetirementRothConversions?.[0]).not.toHaveProperty('draftId');
  });

  it('prunes an entry whose source or target id is not a live account', () => {
    const out = buildNextRothConversions({
      drafts: [entry('src', 'tgt'), entry('src', 'gone'), entry('gone', 'tgt')],
      accounts,
    });
    expect(out.preRetirementRothConversions).toHaveLength(1);
    expect(out.preRetirementRothConversions?.[0].targetRothAccountId).toBe('tgt');
  });

  it('prunes an entry whose source is a live but wrong-type account (not PRE_TAX)', () => {
    // The source id points to a live Roth account, not a pre-tax one: drop it (mirrors resolvePreRetirementRothConversions; an existing id is not enough).
    const accts = [acct('roth-src', 'RETIREMENT_ROTH_IRA', 'ROTH'), tgt()];
    const out = buildNextRothConversions({
      drafts: [entry('roth-src', 'tgt')],
      accounts: accts,
    });
    expect(out).toEqual({});
  });

  it('prunes an entry whose target is a live but wrong-type account (not a Roth IRA)', () => {
    // The target id points to a live pre-tax 401k: the §408A double-tax guard drops it even though the id resolves to a live account.
    const accts = [src(), acct('pretax-tgt', 'RETIREMENT_401K', 'PRE_TAX')];
    const out = buildNextRothConversions({
      drafts: [entry('src', 'pretax-tgt')],
      accounts: accts,
    });
    expect(out).toEqual({});
  });

  it('prunes an entry whose source/target is an inactive account', () => {
    const accts = [
      acct('src', 'RETIREMENT_401K', 'PRE_TAX', false),
      acct('tgt', 'RETIREMENT_ROTH_IRA', 'ROTH', false),
    ];
    const out = buildNextRothConversions({
      drafts: [entry('src', 'tgt')],
      accounts: accts,
    });
    expect(out).toEqual({});
  });

  it('clamps a non-finite / negative amount to 0', () => {
    const out = buildNextRothConversions({
      drafts: [entry('src', 'tgt', Number.NaN), entry('src', 'tgt', -5)],
      accounts,
    });
    expect(out.preRetirementRothConversions?.[0].annualAmountDollars).toBe(0);
    expect(out.preRetirementRothConversions?.[1].annualAmountDollars).toBe(0);
  });

  it('keeps a MIXED 401k source → Roth IRA target pair (Plan C widening)', () => {
    const accts = [
      acct('mixed-src', 'RETIREMENT_401K', 'MIXED'),
      tgt(),
    ];
    const out = buildNextRothConversions({
      drafts: [entry('mixed-src', 'tgt')],
      accounts: accts,
    });
    expect(out.preRetirementRothConversions).toHaveLength(1);
    expect(out.preRetirementRothConversions?.[0].sourceAccountId).toBe('mixed-src');
  });

  it('keeps a same-account MIXED 401k in-plan conversion pair', () => {
    const mixed = acct('mixed-401k', 'RETIREMENT_401K', 'MIXED');
    const out = buildNextRothConversions({
      drafts: [entry('mixed-401k', 'mixed-401k')],
      accounts: [mixed],
    });
    expect(out.preRetirementRothConversions).toHaveLength(1);
    expect(out.preRetirementRothConversions?.[0].sourceAccountId).toBe('mixed-401k');
    expect(out.preRetirementRothConversions?.[0].targetRothAccountId).toBe('mixed-401k');
  });

  it('prunes a MIXED source + separate dedicated-Roth 401k cross-account pair (deferral)', () => {
    const accts = [
      acct('mixed-src', 'RETIREMENT_401K', 'MIXED'),
      acct('roth-401k', 'RETIREMENT_ROTH_401K', 'ROTH'),
    ];
    const out = buildNextRothConversions({
      drafts: [entry('mixed-src', 'roth-401k')],
      accounts: accts,
    });
    expect(out).toEqual({});
  });
});

describe('buildNextRothConversionTaxRate', () => {
  it('omits the key at 0 (sparse default)', () => {
    expect(buildNextRothConversionTaxRate({ taxRatePct: 0 })).toEqual({});
  });
  it('persists a positive rate', () => {
    expect(buildNextRothConversionTaxRate({ taxRatePct: 24 })).toEqual({
      preRetirementRothConversionTaxRatePct: 24,
    });
  });
  it('clamps above 100', () => {
    expect(buildNextRothConversionTaxRate({ taxRatePct: 150 })).toEqual({
      preRetirementRothConversionTaxRatePct: 100,
    });
  });
  it('treats a non-finite rate as 0 (omitted)', () => {
    expect(buildNextRothConversionTaxRate({ taxRatePct: Number.NaN })).toEqual({});
  });
});
