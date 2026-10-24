import { describe, expect, it } from 'vitest';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import { buildReportTaxProfileAssumptions } from './report-tax-profile-assumptions';

function account(
  id: string,
  name: string,
  over: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h1',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deviceId: 'd1',
    payload: {
      name,
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'MIXED',
      ownerId: 'owner',
      institution: '',
      notes: '',
      planningReturnPct: 6,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...over,
    },
  };
}

function balance(
  accountId: string,
  year: number,
  over: Partial<AccountBalancePayload> = {},
): Aggregate<AccountBalancePayload> {
  return {
    id: `bal-${accountId}-${year}`,
    householdId: 'h1',
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: `${year}-12-31T00:00:00.000Z`,
    deviceId: 'd1',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31T00:00:00.000Z`,
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: 0,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
      ...over,
    },
  };
}

function member(
  id: string,
  birthdate: string,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h1',
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deviceId: 'd1',
    payload: { isPrimary: id === 'owner', firstName: id, lastName: '', email: '', birthdate },
  };
}

describe('buildReportTaxProfileAssumptions', () => {
  it('groups inferred years and unavailable clocks', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('a', 'Mixed 401k'),
        account('b', 'Roth IRA', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
        }),
      ],
      balances: [balance('a', 2018, { endingBalancePostTax: 500 })],
      members: [member('owner', '1960-01-01')],
    });
    expect(disclosures).toContain(
      'Roth start years inferred from balance history: Mixed 401k (2018).',
    );
    expect(disclosures).toContain(
      'No supporting Roth history was found, so the five-year rule is treated as unmet: Roth IRA.',
    );
  });

  it('produces no contribution/designated-Roth-basis disclosure, while start-year and RMD groups still appear', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('a', 'Mixed 401k'),
        account('b', 'Roth IRA', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
        account('c', 'Traditional IRA', { type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }),
      ],
      balances: [
        balance('a', 2018, {
          rothInPlanRolloverTaxableAmount: 7_000,
          rothInPlanRolloverNontaxableAmount: 3_000,
        }),
      ],
      members: [member('owner', '1960-01-01')],
    });
    expect(disclosures.join(' ')).not.toContain('contribution basis');
    expect(disclosures.join(' ')).not.toContain('designated Roth basis');
    expect(disclosures).toContain(
      'Roth start years inferred from balance history: Mixed 401k (2018).',
    );
    expect(disclosures).toContain(
      'No supporting Roth history was found, so the five-year rule is treated as unmet: Roth IRA.',
    );
    expect(disclosures).toContain(
      'Standard owner RMD treatment (not inherited) is used: Mixed 401k, Traditional IRA.',
    );
  });

  it('groups exact owner defaults and honors a proved sole-spouse election', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('a', 'Traditional IRA', {
          type: 'RETIREMENT_IRA',
          taxTreatment: 'PRE_TAX',
          rmdSoleSpouseBeneficiary: true,
        }),
        account('b', 'Work plan', { taxTreatment: 'PRE_TAX' }),
      ],
      balances: [],
      members: [member('owner', '1960-01-01'), member('spouse', '1971-01-02')],
    });
    expect(disclosures).toContain(
      'Standard owner RMD treatment (not inherited) is used: Traditional IRA, Work plan.',
    );
    expect(disclosures).toContain('No current-employer RMD delay is assumed: Work plan.');
    expect(disclosures).toContain(
      'No first-year RMD deferral is assumed: Traditional IRA, Work plan.',
    );
    expect(disclosures).toContain('The Uniform Lifetime Table III is used: Work plan.');
  });

  it("reports an owner's shared Roth IRA clock without marking a newer account unmet", () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('older', 'Older Roth IRA', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
          rothIraFirstContributionTaxYear: 2010,
        }),
        account('newer', 'Newer Roth IRA', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
        }),
      ],
      balances: [],
      members: [member('owner', '1960-01-01')],
    });
    expect(disclosures).toContain(
      "Roth start years supplied by another Roth IRA in the owner's shared pool: Newer Roth IRA (2010).",
    );
    expect(disclosures.join(' ')).not.toContain(
      'five-year rule is treated as unmet: Newer Roth IRA',
    );
  });

  it('does not disclose owner RMD assumptions for a POST_TAX TSP', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [account('tsp', 'Post-tax TSP', { taxTreatment: 'POST_TAX' })],
      balances: [],
      members: [member('owner', '1960-01-01')],
    });
    expect(disclosures.join(' ')).not.toContain('Post-tax TSP');
  });

  it('excludes inactive accounts and orders each assumption group canonically', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('ten', 'Roth IRA 10', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
          ownerId: 'other',
        }),
        account('inactive', 'Inactive Roth IRA', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
          active: false,
        }),
        account('two', 'Roth IRA 2', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
        }),
      ],
      balances: [],
      members: [member('owner', '1960-01-01'), member('other', '1962-01-01')],
    });
    expect(disclosures).toContain(
      'No supporting Roth history was found, so the five-year rule is treated as unmet: Roth IRA 2, Roth IRA 10.',
    );
    expect(disclosures.join(' ')).not.toContain('Inactive Roth IRA');
  });

  // No engine consults an inherited Roth IRA's five-year clock, so no Roth start-year group may name one.
  it('names no inherited Roth IRA in any Roth start-year group', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('own', 'Own Roth IRA', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
        }),
        account('inh-derived', 'Inherited Roth IRA (history)', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
          rmdInheritedAccount: true,
        }),
        account('inh-blank', 'Inherited Roth IRA (no history)', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
          rmdInheritedAccount: true,
        }),
      ],
      balances: [balance('inh-derived', 2015, { endingBalance: 5_000 })],
      members: [member('owner', '1960-01-01')],
    });
    const startYearGroups = disclosures.filter(
      (d) => d.startsWith('Roth start years') || d.startsWith('No supporting Roth history'),
    );
    const joined = startYearGroups.join('\n');
    expect(joined).not.toContain('Inherited Roth IRA (history)');
    expect(joined).not.toContain('Inherited Roth IRA (no history)');
    expect(startYearGroups).toContain(
      'No supporting Roth history was found, so the five-year rule is treated as unmet: Own Roth IRA.',
    );
  });

  it('produces no basis disclosure for an inherited Roth IRA either', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('inh', 'Inherited Roth IRA', {
          type: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
          rmdInheritedAccount: true,
        }),
      ],
      balances: [],
      members: [member('owner', '1960-01-01')],
    });
    expect(disclosures.join(' ')).not.toContain('contribution basis');
  });

  it('keeps an inherited DESIGNATED-Roth plan in its Roth start-year group', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('inh-401k', 'Inherited Roth 401k', {
          type: 'RETIREMENT_ROTH_401K',
          taxTreatment: 'ROTH',
          rmdInheritedAccount: true,
        }),
      ],
      balances: [],
      members: [member('owner', '1960-01-01')],
    });
    expect(disclosures).toContain(
      'No supporting Roth history was found, so the five-year rule is treated as unmet: Inherited Roth 401k.',
    );
  });

  it('groups blocked inherited accounts by the canonical missing reason', () => {
    const disclosures = buildReportTaxProfileAssumptions({
      accounts: [
        account('a', 'Inherited IRA A', {
          type: 'RETIREMENT_IRA',
          taxTreatment: 'PRE_TAX',
          rmdInheritedAccount: true,
        }),
        account('b', 'Inherited IRA B', {
          type: 'RETIREMENT_IRA',
          taxTreatment: 'PRE_TAX',
          rmdInheritedAccount: true,
        }),
      ],
      balances: [],
      members: [],
    });
    expect(disclosures).toContain(
      'Required-withdrawal estimate on hold — Who inherited this account: Inherited IRA A, Inherited IRA B.',
    );
  });
});
