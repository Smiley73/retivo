import { describe, it, expect } from 'vitest';
import {
  STRESS_CASES,
  STRESS_CASE_COPY,
  STRESS_CASE_IDS,
  STRESS_MAX_AGE,
} from './market-stress';
import { buildReportData, type BuildReportDataInput } from './report-data';
import { buildGlideSummary, buildReportTimestamp } from './report-format';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  DiscretionaryGlideOverride,
  ExpensePayload,
  HouseholdMemberPayload,
  HouseholdPayload,
  IncomeStreamPayload,
  ScenarioPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import { ROUGH_BENCHMARK_ASSUMPTIONS } from './aca-ptc';

const HID = 'h1';

function member(
  id: string,
  isPrimary: boolean,
  firstName: string,
  birthdate = '1965-03-12',
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'householdMember',
    payload: { isPrimary, firstName, lastName: '', email: '', birthdate },
  };
}

function household(name: string): Aggregate<HouseholdPayload> {
  return {
    id: 'hh',
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'household',
    payload: { name, currency: 'USD', createdAt: '2020-01-01' },
  };
}

function account(
  id: string,
  payload: Partial<AccountPayload> & { name: string },
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'account',
    payload: {
      // Spread first so a test can record any other field without this helper listing it; the defaults below still win for unset ones.
      ...payload,
      name: payload.name,
      type: payload.type ?? 'RETIREMENT_401K',
      ownershipType: payload.ownershipType ?? 'INDIVIDUAL',
      taxTreatment: payload.taxTreatment ?? 'PRE_TAX',
      ownerId: payload.ownerId ?? 'm1',
      institution: payload.institution ?? '',
      notes: payload.notes ?? '',
      planningReturnPct: payload.planningReturnPct ?? 5,
      active: payload.active ?? true,
      plannedContributionPreTax: payload.plannedContributionPreTax ?? 0,
      plannedContributionPostTax: payload.plannedContributionPostTax ?? 0,
      assetMix: payload.assetMix ?? { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
}

function expense(
  id: string,
  payload: Partial<ExpensePayload> & { name: string },
): Aggregate<ExpensePayload> {
  return {
    id,
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'expense',
    payload: {
      name: payload.name,
      amount: payload.amount ?? 100,
      frequency: payload.frequency ?? 'monthly',
      classification: payload.classification ?? 'discretionary',
      categoryId: payload.categoryId ?? 'cat-food',
      start: payload.start ?? { kind: 'retirementStart' },
      end: payload.end,
      discretionaryGlide: payload.discretionaryGlide,
    },
  };
}

function incomeStream(
  id: string,
  payload: Partial<IncomeStreamPayload> & { name: string; kind: IncomeStreamPayload['kind'] },
): Aggregate<IncomeStreamPayload> {
  return {
    id,
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'incomeStream',
    payload: { memberId: 'm1', ...payload },
  };
}

function balance(
  accountId: string,
  year: number,
  over: Partial<AccountBalancePayload> = {},
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`,
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
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

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: null, notes: null },
  };
}

function scenario(
  id: string,
  payload: Partial<ScenarioPayload> & { name: string },
): ScenarioAggregate {
  return {
    id,
    householdId: HID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'scenario',
    payload: {
      name: payload.name,
      description: payload.description ?? '',
      parentScenarioId: payload.parentScenarioId ?? null,
      isPrimary: payload.isPrimary ?? false,
      notes: payload.notes ?? '',
      overrides: payload.overrides ?? {},
    },
  };
}

const NOW = new Date('2026-06-06T18:34:00Z');

function baseInput(over: Partial<BuildReportDataInput> = {}): BuildReportDataInput {
  const base = scenario('base', {
    name: 'Base',
    isPrimary: true,
    overrides: {
      retirementAge: { primary: { ageYears: 65, ageMonths: 0 } },
      socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
    },
  });
  return {
    household: household('The Lovelaces'),
    members: [member('m1', true, 'Ada')],
    accounts: [
      account('a1', { name: '401k', plannedContributionPreTax: 20000, planningReturnPct: 6 }),
    ],
    currentBalanceByAccountId: new Map([['a1', 500000]]),
    currentBalancePreTaxById: new Map([['a1', 500000]]),
    currentBalancePostTaxById: new Map([['a1', null]]),
    expenses: [],
    expenseCategoryNameById: new Map([['cat-food', 'Food']]),
    incomeStreams: [],
    socialSecurity: [ssBenefit('m1', 2000)],
    scenarios: [base],
    activeScenarioId: 'base',
    ...over,
  };
}

describe('buildReportData — tax-profile readiness + disclosures', () => {
  // A spouse-beneficiary fact set that does not withhold the RMD estimate; the Roth-IRA first-contribution year is left blank so the account reports `partial`.
  const notWithheldInheritedFacts = {
    rmdInheritedAccount: true,
    rmdBeneficiaryType: 'SPOUSE',
    rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
    rmdInheritedOwnerDeathDate: '2023-01-01',
    rmdInheritedOwnerDiedOnOrAfterRbd: false,
    rmdBeneficiaryBirthdate: '1970-01-01',
    rmdOriginalOwnerBirthdate: '1950-01-01',
  } as const;

  it('marks a not-withheld inherited Roth IRA as modeling $0 required and discloses it', () => {
    const data = buildReportData(
      baseInput({
        accounts: [
          account('a1', {
            name: 'Inherited Roth IRA',
            type: 'RETIREMENT_ROTH_IRA',
            taxTreatment: 'ROTH',
            ...notWithheldInheritedFacts,
          }),
        ],
      }),
      NOW,
    );
    expect(data.accounts[0].taxProfile).toMatchObject({
      completeness: 'partial',
      inheritedRothZeroRequired: true,
    });
    expect(data.taxProfileDisclosures.some((d) => d.includes('entirely Roth'))).toBe(true);
    expect(data.taxProfileDisclosures.some((d) => d.includes('Inherited Roth IRA'))).toBe(true);
  });

  it('does not flag a blocked inherited account as modeling $0 required (its own "on hold" disclosure already covers it)', () => {
    const data = buildReportData(
      baseInput({
        accounts: [
          account('a1', {
            name: 'Inherited Roth IRA',
            type: 'RETIREMENT_ROTH_IRA',
            taxTreatment: 'ROTH',
            rmdInheritedAccount: true,
          }),
        ],
      }),
      NOW,
    );
    expect(data.accounts[0].taxProfile).toMatchObject({
      completeness: 'blocked',
      inheritedRothZeroRequired: false,
    });
    expect(data.taxProfileDisclosures.some((d) => d.includes('entirely Roth'))).toBe(false);
    expect(data.taxProfileDisclosures.some((d) => d.includes('on hold'))).toBe(true);
  });

  it('does not flag a not-withheld inherited MIXED plan (it still owes a real pre-tax minimum, not $0)', () => {
    const data = buildReportData(
      baseInput({
        accounts: [
          account('a1', {
            name: 'Inherited 401k',
            type: 'RETIREMENT_401K',
            taxTreatment: 'MIXED',
            ...notWithheldInheritedFacts,
          }),
        ],
      }),
      NOW,
    );
    expect(data.accounts[0].taxProfile?.inheritedRothZeroRequired).toBe(false);
    expect(data.taxProfileDisclosures.some((d) => d.includes('entirely Roth'))).toBe(false);
  });

  it('does not flag an OWNER (non-inherited) Roth IRA', () => {
    const data = buildReportData(
      baseInput({
        accounts: [
          account('a1', {
            name: 'My Roth IRA',
            type: 'RETIREMENT_ROTH_IRA',
            taxTreatment: 'ROTH',
            rothIraFirstContributionTaxYear: 2010,
          }),
        ],
      }),
      NOW,
    );
    expect(data.accounts[0].taxProfile).toMatchObject({
      completeness: 'complete',
      inheritedRothZeroRequired: false,
    });
    expect(data.taxProfileDisclosures.some((d) => d.includes('entirely Roth'))).toBe(false);
  });

  it('states the standing Roth start-year/clock paragraph with no basis-default wording', () => {
    const data = buildReportData(baseInput(), NOW);
    expect(data.taxProfileDisclosures[1]).toBe(
      "An owner's own Roth IRAs share their earliest supported start year. Within each account, a recorded year takes priority over qualifying balance history, and with no support anywhere in the applicable pool the five-year holding rule is treated as unmet. These cautious defaults can overstate tax and penalty, never understate them.",
    );
  });
});

describe('buildReportData — rothTaxFreeAmounts wiring', () => {
  // Pins the account set handed to `buildRothTaxFreeRows`: every non-deleted account, not an active-only filter; an inactive Roth IRA sibling's basis must still fold into the person row.
  it('resolves person + employer rows from liveAccounts, including an inactive Roth IRA sibling\'s recorded basis', () => {
    const alex = member('m1', true, 'Alex');
    const sam = member('m2', false, 'Sam');
    const activeIra = account('roth-ira-active', {
      name: 'Active Roth IRA',
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      ownerId: 'm1',
    });
    const inactiveIra = account('roth-ira-inactive', {
      name: 'Old Roth IRA',
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      ownerId: 'm1',
      active: false,
    });
    const mixedPlan = account('mixed-401k', {
      name: 'Mixed 401k',
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm2',
      designatedRothFirstParticipationTaxYear: 2015,
    });
    const balances: ReadonlyArray<Aggregate<AccountBalancePayload>> = [
      balance('roth-ira-active', 2025, { totalContributions: 3_000 }),
      balance('roth-ira-inactive', 2025, { totalContributions: 12_000 }),
      balance('mixed-401k', 2025, { rothInPlanRolloverTaxableAmount: 9_000 }),
    ];
    const data = buildReportData(
      baseInput({
        members: [alex, sam],
        accounts: [activeIra, inactiveIra, mixedPlan],
        balances,
        currentBalanceByAccountId: new Map(),
        currentBalancePreTaxById: new Map(),
        currentBalancePostTaxById: new Map(),
        socialSecurity: [ssBenefit('m1', 2000)],
      }),
      NOW,
    );
    const personRow = data.rothTaxFreeAmounts.find((r) => r.kind === 'person');
    expect(personRow).toBeDefined();
    expect(personRow!.label).toBe('Alex');
    expect(personRow!.amount).toBe(15_000);
    const employerRow = data.rothTaxFreeAmounts.find((r) => r.kind === 'employer');
    expect(employerRow).toBeDefined();
    expect(employerRow!.label).toBe('Mixed 401k');
    expect(employerRow!.amount).toBe(9_000);
  });
});

describe('buildReportData — household overview + accounts', () => {
  it('assembles overview, account summary, and contribution run rate', () => {
    const data = buildReportData(baseInput(), NOW);
    expect(data.overview.householdName).toBe('The Lovelaces');
    expect(data.overview.totalCurrentPortfolio).toBe(500000);
    expect(data.overview.annualContributionRunRate).toBe(20000);
    expect(data.overview.members).toHaveLength(1);
    expect(data.overview.members[0]).toMatchObject({
      role: 'primary',
      name: 'Ada',
      retirementAge: { years: 65, months: 0 },
    });
    expect(data.overview.members[0].currentAge).toBe(61);
    expect(data.accounts[0]).toMatchObject({
      name: '401k',
      currentBalance: 500000,
      plannedContributionPreTax: 20000,
      configuredReturnPct: 6,
    });
  });

  it('carries retirement-age months and rolls the retirement month forward', () => {
    const octoberBorn = member('m1', true, 'Ada', '1965-10-12');
    const sc = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: { primary: { ageYears: 59, ageMonths: 6 } },
      },
    });
    const data = buildReportData(
      baseInput({ members: [octoberBorn], scenarios: [sc] }),
      NOW,
    );
    const m = data.overview.members[0];
    expect(m.retirementAge).toEqual({ years: 59, months: 6 });
    expect(m.retirementYear).toBe(2025);
    expect(m.retirementMonth).toBe(4);
  });

  it('lands both members in the same month for a "same-date" scenario despite a birthday-of-month gap', () => {
    // Recomputing each side from its own birthday would drift the two retirement dates about a month apart.
    const primary = member('m1', true, 'Ada', '1960-01-15');
    const secondary = member('m2', false, 'Bee', '1965-03-28');
    const sc = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          secondary: { ageYears: 59, ageMonths: 10 },
          sameDateAnchor: 'primary',
        },
      },
    });
    const data = buildReportData(
      baseInput({ members: [primary, secondary], scenarios: [sc] }),
      NOW,
    );
    const [p, s] = data.overview.members;
    expect(p.retirementYear).toBe(2025);
    expect(p.retirementMonth).toBe(1);
    expect(s.retirementYear).toBe(p.retirementYear);
    expect(s.retirementMonth).toBe(p.retirementMonth);
  });

  it('surfaces pre-tax / post-tax balances from the split maps (null when unrecorded)', () => {
    const data = buildReportData(baseInput(), NOW);
    expect(data.accounts[0].currentBalancePreTax).toBe(500000);
    expect(data.accounts[0].currentBalancePostTax).toBeNull();
  });

  it('falls back to null when an account is absent from the split maps', () => {
    const data = buildReportData(
      baseInput({
        currentBalancePreTaxById: new Map(),
        currentBalancePostTaxById: new Map(),
      }),
      NOW,
    );
    expect(data.accounts[0].currentBalancePreTax).toBeNull();
    expect(data.accounts[0].currentBalancePostTax).toBeNull();
  });

  it('resolves the configured return rate from a scenario account-returns override', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Aggressive',
      parentScenarioId: 'base',
      overrides: { accountReturns: { perAccount: { a1: { planningReturnPct: 9 } } } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt' }),
      NOW,
    );
    expect(data.accounts[0].configuredReturnPct).toBe(9);
  });
});

describe('buildReportData — Social Security summary', () => {
  it('produces a per-member PIA + claim age + benefit estimate', () => {
    const data = buildReportData(baseInput(), NOW);
    expect(data.socialSecurity).toHaveLength(1);
    const m = data.socialSecurity[0];
    expect(m).toMatchObject({ role: 'primary', name: 'Ada', pia: 2000, claimAgeYears: 67 });
    expect(m.monthlyBenefitAtClaim).toBe(2000);
  });

  it('returns a null benefit estimate when no PIA is on file', () => {
    const data = buildReportData(
      baseInput({ socialSecurity: [ssBenefit('m1', null)] }),
      NOW,
    );
    expect(data.socialSecurity[0].pia).toBeNull();
    expect(data.socialSecurity[0].monthlyBenefitAtClaim).toBeNull();
  });

  it('estimates a reduced benefit for an early claim age', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: { socialSecurity: { primary: { ageYears: 62, ageMonths: 0 } } },
    });
    const data = buildReportData(baseInput({ scenarios: [base] }), NOW);
    expect(data.socialSecurity[0].monthlyBenefitAtClaim).toBeLessThan(2000);
    expect(data.socialSecurity[0].monthlyBenefitAtClaim).toBeGreaterThan(0);
  });
});

describe('buildReportData — scenario inventory', () => {
  it('surfaces inherited SS claim ages + withdrawal strategy when not explicitly overridden', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
        withdrawalStrategy: { kind: 'taxEfficient' },
      },
    });
    const child = scenario('child', {
      name: 'Child',
      parentScenarioId: 'base',
      overrides: { inflation: { ratePct: 4 } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, child], activeScenarioId: 'base' }),
      NOW,
    );
    const childScenario = data.scenarios.find((s) => s.id === 'child');
    expect(childScenario?.ssClaimAgeYears.primary).toBe(70);
    expect(childScenario?.withdrawalStrategyKind).toBe('taxEfficient');
  });

  it('surfaces inflation, life-expectancy, and discretionary knobs when set; omits unset ones', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const tuned = scenario('tuned', {
      name: 'Tuned',
      parentScenarioId: 'base',
      overrides: {
        inflation: { ratePct: 4.5 },
        lifeExpectancy: { primary: 100 },
        discretionarySpending: { bumpPct: -20, durationYears: 5 },
      },
    });
    const data = buildReportData(baseInput({ scenarios: [base, tuned] }), NOW);
    const baseScenario = data.scenarios.find((s) => s.id === 'base');
    const tunedScenario = data.scenarios.find((s) => s.id === 'tuned');

    expect(tunedScenario?.knobs).toEqual({
      inflationRatePct: 4.5,
      lifeExpectancyPrimary: 100,
      discretionarySpendingBumpPct: -20,
      discretionarySpendingDurationYears: 5,
    });
    expect(baseScenario?.knobs).toEqual({});
  });

  it('counts and names disabled / added / patched expenses correctly', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Alt',
      parentScenarioId: 'base',
      overrides: {
        expenses: {
          disabledIds: ['aggregate:e1'],
          patches: { 'aggregate:e2': { amount: 500 } },
          added: [
            {
              _localId: 'loc1',
              name: 'New Boat',
              amount: 1000,
              frequency: 'monthly',
              classification: 'discretionary',
              categoryId: 'cat-food',
              start: { kind: 'retirementStart' },
            },
          ],
        },
      },
    });
    const expenses = [
      expense('e1', { name: 'Travel' }),
      expense('e2', { name: 'Dining' }),
    ];
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], expenses }),
      NOW,
    );
    const altScenario = data.scenarios.find((s) => s.id === 'alt');
    expect(altScenario?.expenseOverrides.disabledCount).toBe(1);
    expect(altScenario?.expenseOverrides.addedCount).toBe(1);
    expect(altScenario?.expenseOverrides.patchedCount).toBe(1);
    expect(altScenario?.expenseOverrides.notableNames).toEqual(['New Boat', 'Dining']);
  });
});

describe('buildReportData — scenario settings (Scenario page detail)', () => {
  const allRows = (id: string, data: ReturnType<typeof buildReportData>) =>
    (data.scenarios.find((s) => s.id === id)?.settingGroups ?? []).flatMap((g) => g.rows);

  it('shows effective values for inherited + overwritten knobs, in titled groups', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
        withdrawalStrategy: { kind: 'taxEfficient' },
      },
    });
    const child = scenario('child', {
      name: 'Child',
      parentScenarioId: 'base',
      overrides: { inflation: { ratePct: 4 } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, child], activeScenarioId: 'child' }),
      NOW,
    );
    const groups = data.scenarios.find((s) => s.id === 'child')?.settingGroups ?? [];
    const rows = groups.flatMap((g) => g.rows);
    const val = (label: string) => rows.find((r) => r.label.startsWith(label))?.value;

    expect(groups.map((g) => g.title)).toEqual(
      expect.arrayContaining(['Retirement & longevity', 'Inflation & spending', 'Withdrawal strategy']),
    );
    expect(val('Social Security claim age')).toBe('age 70');
    expect(val('Withdrawal strategy')).toBe('Tax-efficient');
    expect(val('Inflation rate')).toBe('4%');
  });

  it('surfaces effective defaults even when nothing is overridden (comprehensive)', () => {
    const data = buildReportData(baseInput(), NOW);
    const rows = allRows('base', data);
    const val = (label: string) => rows.find((r) => r.label === label)?.value;

    expect(val('Social Security COLA')).toBe('Tracks inflation (CPI-indexed)');
    expect(val('Social Security benefit cut')).toBe('None (full benefits)');
    expect(val('Life expectancy — Ada')).toBe('age 95');
    expect(val('Filing status')).toBe('Single');
    expect(val('Taxable-withdrawal LTCG fraction')).toBe('50%');
    expect(val('Emergency HSA withdrawals treated as qualified')).toBe('100%');
    expect(val('Inflation — Medical')).toBe('5%');
    expect(val('Withdrawal strategy')).toBe('Tax-efficient');
    expect(val('How it works')).toBe(
      'Draws taxable accounts first, then tax-deferred, then Roth last — an order that tends to carry lower lifetime tax drag, though the actual result depends on your brackets and account mix.',
    );
  });

  it('renders a +2pp row for EVERY flag-derived medical category, with no double-print', () => {
    const data = buildReportData(
      baseInput({
        medicalCategoryIds: ['cat-medical', 'cat-dental'],
        expenseCategoryNameById: new Map([
          ['cat-medical', 'Medical'],
          ['cat-dental', 'Dental'],
          ['cat-food', 'Food'],
        ]),
      }),
      NOW,
    );
    const rows = allRows('base', data);
    const inflationRows = rows.filter((r) => r.label.startsWith('Inflation — '));
    expect(inflationRows).toHaveLength(2);
    expect(rows.find((r) => r.label === 'Inflation — Medical')?.value).toBe('5%');
    expect(rows.find((r) => r.label === 'Inflation — Dental')?.value).toBe('5%');
    const labels = inflationRows.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('surfaces opted-out members by display name and label-guards a dangling id', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        // 'm-gone' has no live member and must be skipped, not rendered as a blank name.
        acaMarketplaceOptOutMemberIds: ['m2', 'm-gone'],
      },
    });
    const data = buildReportData(
      baseInput({
        scenarios: [base],
        activeScenarioId: 'base',
        members: [member('m1', true, 'Ada'), member('m2', false, 'Grace')],
      }),
      NOW,
    );
    const row = allRows('base', data).find(
      (r) => r.label === 'ACA Marketplace — other coverage',
    );
    expect(row?.value).toBe('Grace');
    expect(row?.value).not.toContain('m-gone');
  });

  it('shows what actually changed for a patched expense (amount old to new)', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Alt',
      parentScenarioId: 'base',
      overrides: { expenses: { patches: { 'aggregate:e1': { amount: 800 } } } },
    });
    const expenses = [expense('e1', { name: 'Travel', amount: 500 })];
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt', expenses }),
      NOW,
    );
    const row = allRows('alt', data).find((r) => r.label === 'Expense changed — Travel');
    expect(row?.value).toContain('amount $500 to $800');
  });

  it('shows the actual change for a per-account return override (not a count)', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Alt',
      parentScenarioId: 'base',
      overrides: { accountReturns: { perAccount: { a1: { planningReturnPct: 9 } } } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt' }),
      NOW,
    );
    // ASCII " to ": jsPDF's standard font has no → glyph.
    expect(allRows('alt', data).find((r) => r.label === 'Return — 401k')?.value).toBe('6% to 9%');
  });

  it('renders a MAGI cap window with ceiling, fill mode, and MAGI line in its own group', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap: {
          windows: [
            {
              start: { kind: 'retirementStart' },
              end: { kind: 'year', year: 2035 },
              magiCeilingAnnualDollars: 60000,
              capMode: 'fill',
              capMagiLine: 'aca',
            },
          ],
        },
      },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    const groups = data.scenarios.find((s) => s.id === 'base')?.settingGroups ?? [];
    const magiGroup = groups.find((g) => g.title === 'MAGI cap');
    const cap = magiGroup?.rows[0]?.value ?? '';
    expect(cap).toContain('up to $60,000/yr');
    expect(cap).toContain('fill to Roth');
    expect(cap).toContain('ACA-PTC');
  });

  it('renders working-years Roth conversion rows with source → target transfer description', () => {
    const accounts = [
      account('a-pre', { name: 'My 401k', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
      account('a-roth', { name: 'My Roth IRA', type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
    ];
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        preRetirementRothConversions: [
          {
            sourceAccountId: 'a-pre',
            targetRothAccountId: 'a-roth',
            annualAmountDollars: 15000,
            start: { kind: 'year', year: 2030 },
            end: { kind: 'year', year: 2034 },
          },
        ],
        preRetirementRothConversionTaxRatePct: 22,
      },
    });
    const data = buildReportData(
      baseInput({ accounts, scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    const groups = data.scenarios.find((s) => s.id === 'base')?.settingGroups ?? [];
    const rothGroup = groups.find((g) => g.title === 'Working-years Roth conversions');
    expect(rothGroup).toBeDefined();
    const convRow = rothGroup?.rows[0];
    expect(convRow?.value).toContain('My 401k to My Roth IRA');
    expect(convRow?.value).toContain('$15,000/yr');
    const rateRow = rothGroup?.rows[1];
    expect(rateRow?.label).toBe('Assumed tax rate (shown, not deducted)');
    expect(rateRow?.value).toBe('22%');
  });

  it('renders a same-account MIXED in-plan conversion as "within <Name> (in-plan Roth conversion)"', () => {
    const accounts = [
      account('a-mixed', {
        name: 'My MIXED 401k',
        type: 'RETIREMENT_401K',
        taxTreatment: 'MIXED',
      }),
    ];
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        preRetirementRothConversions: [
          {
            sourceAccountId: 'a-mixed',
            targetRothAccountId: 'a-mixed', // same id = in-plan
            annualAmountDollars: 10000,
            start: { kind: 'year', year: 2028 },
            end: { kind: 'year', year: 2030 },
          },
        ],
        preRetirementRothConversionTaxRatePct: 0,
      },
    });
    const data = buildReportData(
      baseInput({ accounts, scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    const groups = data.scenarios.find((s) => s.id === 'base')?.settingGroups ?? [];
    const rothGroup = groups.find((g) => g.title === 'Working-years Roth conversions');
    expect(rothGroup).toBeDefined();
    const convRow = rothGroup?.rows[0];
    expect(convRow?.value).toContain('within My MIXED 401k (in-plan Roth conversion)');
    expect(convRow?.value).not.toContain(' to ');
  });

  it('renders Qualified Charitable Distribution rows with source account name', () => {
    const accounts = [
      account('a-ira', {
        name: 'My Traditional IRA',
        type: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
      }),
    ];
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        qualifiedCharitableDistributions: [
          {
            memberId: 'm1',
            sourceAccountId: 'a-ira',
            annualAmountDollars: 25000,
            start: { kind: 'year', year: 2030 },
            end: { kind: 'year', year: 2040 },
          },
        ],
      },
    });
    const data = buildReportData(
      baseInput({ accounts, scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    const groups = data.scenarios.find((s) => s.id === 'base')?.settingGroups ?? [];
    const qcdGroup = groups.find((g) => g.title === 'Qualified Charitable Distributions');
    expect(qcdGroup).toBeDefined();
    const qcdRow = qcdGroup?.rows[0];
    expect(qcdRow?.value).toContain('$25,000/yr from My Traditional IRA');
  });

  it('omits a QCD whose source account is not an eligible household IRA', () => {
    // The report summarizes the hardened resolveQcdForScenario output, so an orphan source account is dropped rather than shown by raw id.
    const accounts = [
      account('a-ira', {
        name: 'My Traditional IRA',
        type: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
      }),
    ];
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        qualifiedCharitableDistributions: [
          {
            memberId: 'm1',
            sourceAccountId: 'orphan-acct-id',
            annualAmountDollars: 25000,
            start: { kind: 'year', year: 2030 },
            end: { kind: 'year', year: 2040 },
          },
        ],
      },
    });
    const data = buildReportData(
      baseInput({ accounts, scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    const groups = data.scenarios.find((s) => s.id === 'base')?.settingGroups ?? [];
    const qcdGroup = groups.find((g) => g.title === 'Qualified Charitable Distributions');
    expect(qcdGroup).toBeUndefined();
  });
});

describe('buildReportData — expense inventory + end-window labels', () => {
  it('produces annualised amounts and start/end labels (no MC data)', () => {
    const expenses = [
      expense('e1', {
        name: 'Groceries',
        classification: 'essential',
        amount: 600,
        frequency: 'monthly',
        end: { kind: 'lifetime', whose: 'last' },
      }),
      expense('e2', {
        name: 'Property tax',
        classification: 'essential',
        amount: 8000,
        frequency: 'yearly',
        end: { kind: 'age', memberId: 'primary', years: 90, months: 0 },
      }),
    ];
    const data = buildReportData(baseInput({ expenses }), NOW);
    const groceries = data.expenses.find((e) => e.name === 'Groceries');
    const tax = data.expenses.find((e) => e.name === 'Property tax');
    expect(groceries?.annualAmount).toBe(7200);
    expect(groceries?.startLabel).toBe('Start of retirement');
    expect(groceries?.endLabel).toBe('until last surviving');
    expect(tax?.annualAmount).toBe(8000);
    expect(tax?.endLabel).toMatch(/age 90/);
    expect(groceries?.glideSummary).toBeNull();
    expect(tax?.glideSummary).toBeNull();
  });

  it('labels a one-off expense end as "(one-off)"', () => {
    const data = buildReportData(
      baseInput({ expenses: [expense('e1', { name: 'New roof', frequency: 'oneOff', amount: 25000 })] }),
      NOW,
    );
    expect(data.expenses[0].endLabel).toBe('(one-off)');
    expect(data.expenses[0].annualAmount).toBe(25000);
  });
});

describe('buildReportData — expense glide summaries', () => {
  const members = [member('m1', true, 'Ada')];
  const retirementToExpenseEnd = { glideStart: { kind: 'retirementStart' }, glideEnd: { kind: 'expenseEnd' } } as const;
  const age = (years: number) => ({ kind: 'age', memberId: 'primary', years, months: 0 }) as const;
  const summaryFor = (
    classification: ExpensePayload['classification'],
    g: DiscretionaryGlideOverride | undefined,
  ): string | null =>
    buildGlideSummary(
      expense('e1', { name: 'X', classification, discretionaryGlide: g }).payload,
      members,
    );

  it('carries the glide summary onto the report expense row', () => {
    const data = buildReportData(
      baseInput({
        expenses: [
          expense('e1', {
            name: 'Travel',
            classification: 'discretionary',
            discretionaryGlide: { endMultiplierPct: 70, ...retirementToExpenseEnd },
          }),
        ],
      }),
      NOW,
    );
    expect(data.expenses[0].glideSummary).toBe('declines to 70% by the expense end');
  });

  it.each([
    ['declining glide on an essential expense', 'essential', { endMultiplierPct: 50, ...retirementToExpenseEnd }, 'declines to 50% by the expense end'],
    ['rising glide with no ceiling (was silently suppressed)', 'essential', { endMultiplierPct: 150, ...retirementToExpenseEnd }, 'rises to 150% by the expense end'],
    [
      'rising glide with a ceiling',
      'discretionary',
      { endMultiplierPct: 150, glideStart: age(65), glideEnd: age(80), floor: { multiplierPct: 180, anchor: age(85) } },
      'rises from 100% to 150% between Ada age 65 and Ada age 80, then holds at 180% after Ada age 85',
    ],
    [
      'age-anchored window',
      'discretionary',
      { endMultiplierPct: 40, glideStart: age(65), glideEnd: age(80) },
      'declines from 100% to 40% between Ada age 65 and Ada age 80',
    ],
    [
      'floor step',
      'discretionary',
      { endMultiplierPct: 40, glideStart: age(65), glideEnd: age(80), floor: { multiplierPct: 25, anchor: age(85) } },
      'declines from 100% to 40% between Ada age 65 and Ada age 80, then holds at 25% after Ada age 85',
    ],
    [
      'floor only (end 100, effective floor below 100)',
      'discretionary',
      { endMultiplierPct: 100, glideStart: { kind: 'retirementStart' }, glideEnd: age(80), floor: { multiplierPct: 50, anchor: age(85) } },
      'holds at 100% until Ada age 80, then holds at 50% after Ada age 85',
    ],
  ] as const)('describes a %s', (_name, classification, glide, expected) => {
    expect(summaryFor(classification, glide)).toBe(expected);
  });

  it.each([
    ['no glide', undefined],
    ['a no-op glide (end 100, no floor)', { endMultiplierPct: 100, ...retirementToExpenseEnd }],
    ['a no-op glide whose floor is also 100', { endMultiplierPct: 100, ...retirementToExpenseEnd, floor: { multiplierPct: 100, anchor: age(85) } }],
  ] as const)('shows no summary for %s', (_name, glide) => {
    expect(summaryFor('discretionary', glide)).toBeNull();
  });

  it('returns null for a member with a birthdate outside the FRA table (no throw)', () => {
    const data = buildReportData(
      baseInput({
        members: [member('m1', true, 'Ada', '1800-01-01')],
        socialSecurity: [ssBenefit('m1', 2000)],
      }),
      NOW,
    );
    expect(data.socialSecurity[0].monthlyBenefitAtClaim).toBeNull();
  });
});

describe('buildReportData — income streams', () => {
  it('reports COLA % for a fixed-COLA pension and a tracks-inflation flag', () => {
    const streams = [
      incomeStream('i1', {
        name: 'Megacorp Pension',
        kind: 'pension',
        payoutType: 'annuity',
        monthlyBenefit: 3000,
        colaPct: 2,
        start: { kind: 'retirementStart' },
      }),
      incomeStream('i2', {
        name: 'Consulting',
        kind: 'partTime',
        annualAmount: 24000,
        tracksInflation: true,
        start: { kind: 'age', years: 66, months: 0 },
        end: { kind: 'age', years: 70, months: 0 },
      }),
    ];
    const data = buildReportData(baseInput({ incomeStreams: streams }), NOW);
    const pension = data.incomeStreams.find((s) => s.name === 'Megacorp Pension');
    const consulting = data.incomeStreams.find((s) => s.name === 'Consulting');
    expect(pension).toMatchObject({
      memberName: 'Ada',
      annualAmount: 36000,
      colaPct: 2,
      tracksInflation: false,
    });
    expect(consulting).toMatchObject({
      annualAmount: 24000,
      colaPct: null,
      tracksInflation: true,
    });
    expect(data.overview.estimatedAnnualOtherIncome).toBe(2000 * 12 + 36000 + 24000);
  });
});

describe('buildReportData — contribution overrides + stopContributions', () => {
  it('applies scenario contribution overrides to account planned amounts', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Aggressive Saver',
      parentScenarioId: 'base',
      overrides: {
        accountContributions: { perAccount: { a1: { plannedContributionPreTax: 30000 } } },
      },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt' }),
      NOW,
    );
    expect(data.accounts[0].plannedContributionPreTax).toBe(30000);
    expect(data.overview.annualContributionRunRate).toBe(30000);
  });

  it('zeroes all contributions when stopContributionsToday is set', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const coast = scenario('coast', {
      name: 'Coast FI',
      parentScenarioId: 'base',
      overrides: { contributions: { stopContributionsToday: true } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, coast], activeScenarioId: 'coast' }),
      NOW,
    );
    expect(data.accounts[0].plannedContributionPreTax).toBe(0);
    expect(data.accounts[0].plannedContributionPostTax).toBe(0);
    expect(data.overview.annualContributionRunRate).toBe(0);
  });
});

describe('buildReportData — SS benefitReductionPct', () => {
  it('applies benefitReductionPct to monthly benefit estimates', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 }, benefitReductionPct: 25 },
      },
    });
    const data = buildReportData(baseInput({ scenarios: [base] }), NOW);
    expect(data.socialSecurity[0].monthlyBenefitAtClaim).toBeCloseTo(1500);
  });
});

describe('buildReportData — scenario expense/income resolution', () => {
  it('hides a scenario-disabled canonical expense from the report', () => {
    const expenses = [
      expense('e1', { name: 'Travel', amount: 1000, frequency: 'yearly' }),
      expense('e2', { name: 'Dining', amount: 500, frequency: 'yearly' }),
    ];
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Lean',
      parentScenarioId: 'base',
      overrides: { expenses: { disabledIds: ['aggregate:e1'] } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt', expenses }),
      NOW,
    );
    expect(data.expenses.find((e) => e.name === 'Travel')).toBeUndefined();
    expect(data.expenses.find((e) => e.name === 'Dining')).toBeDefined();
  });

  it('includes a scenario-added expense in the report', () => {
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'With Boat',
      parentScenarioId: 'base',
      overrides: {
        expenses: {
          added: [
            {
              _localId: 'loc-boat',
              name: 'Yacht Club',
              amount: 6000,
              frequency: 'yearly',
              classification: 'discretionary',
              categoryId: 'cat-food',
              start: { kind: 'retirementStart' },
            },
          ],
        },
      },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt', expenses: [] }),
      NOW,
    );
    const boat = data.expenses.find((e) => e.name === 'Yacht Club');
    expect(boat).toBeDefined();
    expect(boat?.annualAmount).toBe(6000);
    expect(boat?.id).toBe('local:loc-boat');
  });

  it('reflects a patched expense amount in the report', () => {
    const expenses = [
      expense('e1', { name: 'Groceries', amount: 1000, frequency: 'monthly' }),
    ];
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Frugal',
      parentScenarioId: 'base',
      overrides: { expenses: { patches: { 'aggregate:e1': { amount: 500 } } } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt', expenses }),
      NOW,
    );
    const groceries = data.expenses.find((e) => e.name === 'Groceries');
    expect(groceries?.annualAmount).toBe(6000);
  });

  it('excludes a scenario-disabled income stream from report and estimatedAnnualOtherIncome', () => {
    const streams = [
      incomeStream('i1', {
        name: 'Consulting',
        kind: 'partTime',
        annualAmount: 24000,
        start: { kind: 'age', years: 66, months: 0 },
      }),
    ];
    const base = scenario('base', { name: 'Base', isPrimary: true });
    const alt = scenario('alt', {
      name: 'Retired',
      parentScenarioId: 'base',
      overrides: { income: { disabledIds: ['aggregate:i1'] } },
    });
    const data = buildReportData(
      baseInput({ scenarios: [base, alt], activeScenarioId: 'alt', incomeStreams: streams }),
      NOW,
    );
    expect(data.incomeStreams.find((s) => s.name === 'Consulting')).toBeUndefined();
    expect(data.overview.estimatedAnnualOtherIncome).toBe(2000 * 12);
  });
});

describe('buildReportData — filing assumptions', () => {
  it('describes a one-member plan and always carries the standard-deduction-only disclosure', () => {
    const data = buildReportData(baseInput(), NOW);
    const filing = data.scenarios.find((s) => s.id === 'base')!.filingAssumptions;
    expect(filing.whileBothAlive).toMatch(/One person in this plan/i);
    expect(filing.afterADeath).toMatch(/Not applicable/i);
    expect(filing.unresolvedLegacyDetail).toBeUndefined();
    expect(filing.disclosures.some((d) => /standard deduction is used every year/i.test(d))).toBe(
      true,
    );
    expect(
      filing.disclosures.some((d) => /alternative minimum tax/i.test(d)),
    ).toBe(true);
    expect(filing.disclosures.some((d) => /Federal income tax only/i.test(d))).toBe(true);
  });

  it('describes a separate (MFS) plan with its lived-together fact and per-spouse sizes', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        taxFilingPlan: {
          kind: 'separate',
          livedTogether: true,
          units: [
            { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
            { memberId: 'secondary', filingStatus: 'HoH', householdSize: 2 },
          ],
        },
      },
    });
    const data = buildReportData(
      baseInput({
        members: [member('m1', true, 'Ada'), member('m2', false, 'Grace')],
        scenarios: [base],
      }),
      NOW,
    );
    const filing = data.scenarios[0].filingAssumptions;
    expect(filing.whileBothAlive).toMatch(/Two separate returns/i);
    expect(filing.whileBothAlive).toMatch(/married filing separately, 1 person on the return/i);
    expect(filing.whileBothAlive).toMatch(/head of household, 2 people on the return/i);
    expect(filing.whileBothAlive).toMatch(/lived together during the year/i);
    // §86 caps taxable Social Security at 85% for every filer; living together only removes the MFS base amounts.
    expect(filing.whileBothAlive).toMatch(/up to the usual 85% cap/i);
    expect(filing.whileBothAlive).not.toMatch(/all Social Security benefits are taxable/i);
    expect(filing.afterADeath).toMatch(/still filed on two separate returns/i);
    expect(filing.afterADeath).not.toMatch(/filed jointly/i);
    expect(
      filing.disclosures.some((d) => /divided evenly between the two returns/i.test(d)),
    ).toBe(true);
    const rows = (data.scenarios[0].settingGroups ?? []).flatMap((g) => g.rows);
    expect(rows.find((r) => r.label === 'Filing status')?.value).toMatch(/separate returns/i);
    expect(rows.find((r) => r.label === 'After a spouse dies')?.value).toMatch(/two separate returns/i);
    expect(rows.some((r) => r.label === 'Separate-return estimate')).toBe(true);
  });

  it('the report card and the PDF settings agree for an unresolved legacy scalar', () => {
    // Regression: a two-member `Single` scalar cannot be converted, so the engine files `Single`, while the card claimed "One joint return while both spouses are alive".
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: { filingStatus: 'Single' },
    });
    const data = buildReportData(
      baseInput({
        members: [member('m1', true, 'Ada'), member('m2', false, 'Grace')],
        scenarios: [base],
      }),
      NOW,
    );
    const sc = data.scenarios[0];
    const filingRows = (sc.settingGroups ?? [])
      .flatMap((g) => g.rows)
      .filter((r) => r.label === 'Filing status');
    expect(filingRows).toHaveLength(1);
    expect(filingRows[0].value).toBe('Single');
    expect(sc.filingAssumptions.whileBothAlive).toMatch(/filed as single/i);
    expect(sc.filingAssumptions.whileBothAlive).not.toMatch(/joint return/i);
    expect(sc.filingAssumptions.unresolvedLegacyDetail).toMatch(/does not say how each spouse's tax unit/i);
    expect(sc.filingAssumptions.disclosures.some((d) => /kept using it unchanged/i.test(d))).toBe(true);
    const kept = (sc.settingGroups ?? [])
      .flatMap((g) => g.rows)
      .find((r) => r.label === 'Older filing setting kept');
    expect(kept).toBeTruthy();
  });

  it('lists year-bounded exception windows on the post-death line', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        taxFilingPlan: {
          kind: 'joint',
          statusWindows: [
            {
              status: 'QSS',
              start: { kind: 'year', year: 2041 },
              end: { kind: 'year', year: 2043 },
            },
          ],
        },
      },
    });
    const data = buildReportData(
      baseInput({
        members: [member('m1', true, 'Ada'), member('m2', false, 'Grace')],
        scenarios: [base],
      }),
      NOW,
    );
    const filing = data.scenarios[0].filingAssumptions;
    expect(filing.afterADeath).toMatch(
      /qualifying surviving spouse from 2041 up to \(but not including\) 2043/i,
    );
  });
});

describe('buildReportTimestamp', () => {
  it('returns a deterministic "Generated …" string for a frozen clock', () => {
    const out = buildReportTimestamp(new Date('2026-06-06T14:34:00'));
    expect(out).toMatch(/^Generated /);
    expect(out).toMatch(/2026/); // 4-digit year present
    expect(out).toContain('June 6, 2026');
    expect(out).toMatch(/2:34/);
  });
});

describe('buildReportData — health assumptions', () => {
  it('states the defaults and always carries the rough-benchmark + Medicare-premium disclosures', () => {
    const data = buildReportData(baseInput(), NOW);
    const health = data.scenarios.find((s) => s.id === 'base')!.healthAssumptions;
    expect(health.povertyGuidelines).toMatch(/48 mainland states/i);
    expect(health.benchmarkPrice).toMatch(/rough estimate is used every year/i);
    expect(health.coverageMonths).toMatch(/No coverage months were entered/i);
    expect(
      health.disclosures.some((d) => /\$700 a month for a 60-year-old/i.test(d)),
    ).toBe(true);
    expect(
      health.disclosures.some((d) => /not a quote from an exchange/i.test(d)),
    ).toBe(true);
    expect(
      health.disclosures.some((d) =>
        d.includes(
          `From ${ROUGH_BENCHMARK_ASSUMPTIONS.baseYear}, the estimate grows every year at the scenario\u2019s medical inflation rate.`,
        ),
      ),
    ).toBe(true);
    expect(
      health.disclosures.some((d) => /benchmark plan price you entered is used exactly as entered/i.test(d)),
    ).toBe(true);
    expect(
      health.disclosures.some((d) => /base Medicare premium.*must be entered/i.test(d)),
    ).toBe(true);
  });

  it('reports the stated region, benchmark years, coverage years, and other-coverage members', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        acaFplRegion: 'alaska',
        acaMarketplaceOptOutMemberIds: ['m2'],
        acaPtcBenchmark: [{ taxYear: 2031, annualSlcspDollars: 9_600 }],
        healthCoverageMonths: {
          perMember: { m1: { 2030: { partBMonths: 7, marketplaceMonths: 5 } } },
        },
      },
    });
    const data = buildReportData(
      baseInput({
        members: [member('m1', true, 'Ada'), member('m2', false, 'Grace')],
        scenarios: [base],
      }),
      NOW,
    );
    const health = data.scenarios[0].healthAssumptions;
    expect(health.povertyGuidelines).toMatch(/Alaska/i);
    expect(health.marketplaceCoverage).toMatch(/Modeled on a Marketplace plan before Medicare: Ada/);
    expect(health.marketplaceCoverage).toMatch(/Modeled with other coverage \(no subsidy estimated\): Grace/);
    expect(health.benchmarkPrice).toMatch(/benchmark plan price is used for 2031/i);
    expect(health.coverageMonths).toMatch(/Coverage months were entered for 2030/i);
  });

  it('a null member entry in an IMPORTED coverage map renders as "nothing stated"', () => {
    // Import hardening validates the aggregate envelope, not override shapes; a null member entry used to throw a TypeError that blanked the Report render.
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        healthCoverageMonths: { perMember: { m1: null } },
      } as never,
    });
    const data = buildReportData(
      baseInput({ members: [member('m1', true, 'Ada')], scenarios: [base] }),
      NOW,
    );
    const health = data.scenarios[0].healthAssumptions;
    expect(health.coverageMonths).toMatch(/No coverage months were entered/i);
    const rows = (data.scenarios[0].settingGroups ?? []).flatMap((g) => g.rows);
    expect(rows.filter((r) => r.label === 'Coverage months entered for')).toHaveLength(0);
  });
});

describe('buildReportData — health-coverage settings rows', () => {
  const flatRows = (id: string, data: ReturnType<typeof buildReportData>) =>
    (data.scenarios.find((s) => s.id === id)?.settingGroups ?? []).flatMap((g) => g.rows);

  const buildWith = (overrides: Record<string, unknown>) =>
    buildReportData(
      baseInput({
        scenarios: [
          scenario('base', { name: 'Base', isPrimary: true, overrides: overrides as never }),
        ],
        activeScenarioId: 'base',
      }),
      NOW,
    );

  it('emits exactly ONE row per benchmark override year (never a duplicate listing)', () => {
    const rows = flatRows(
      'base',
      buildWith({
        acaPtcBenchmark: [
          { taxYear: 2030, annualSlcspDollars: 9_000 },
          { taxYear: 2031, annualSlcspDollars: 9_500 },
        ],
      }),
    );
    const benchmarkRows = rows.filter((r) => /benchmark/i.test(r.label));
    expect(benchmarkRows).toHaveLength(2);
    expect(benchmarkRows.map((r) => r.label)).toEqual([
      'ACA benchmark (SLCSP) 2030',
      'ACA benchmark (SLCSP) 2031',
    ]);
    expect(rows.filter((r) => r.label === 'Benchmark plan price')).toHaveLength(0);
  });

  it('lists the poverty-guideline region only when it is NOT the contiguous default', () => {
    const alaska = flatRows('base', buildWith({ acaFplRegion: 'alaska' }));
    expect(alaska.find((r) => r.label === 'Federal poverty guidelines')?.value).toBe('Alaska');
    const hawaii = flatRows('base', buildWith({ acaFplRegion: 'hawaii' }));
    expect(hawaii.find((r) => r.label === 'Federal poverty guidelines')?.value).toBe('Hawaii');
    expect(
      flatRows('base', buildWith({ acaFplRegion: 'contiguous' })).filter(
        (r) => r.label === 'Federal poverty guidelines',
      ),
    ).toHaveLength(0);
    expect(
      flatRows('base', buildWith({})).filter((r) => r.label === 'Federal poverty guidelines'),
    ).toHaveLength(0);
  });

  it('lists the coverage-month years once, sorted, and omits the row when none are set', () => {
    const rows = flatRows(
      'base',
      buildWith({
        healthCoverageMonths: {
          perMember: {
            'member-secondary': { 2031: { partBMonths: 12 } },
            'member-primary': { 2030: { marketplaceMonths: 7 }, 2031: { partBMonths: 5 } },
          },
        },
      }),
    );
    const coverageRows = rows.filter((r) => r.label === 'Coverage months entered for');
    expect(coverageRows).toHaveLength(1);
    expect(coverageRows[0].value).toBe('2030, 2031');
    expect(
      flatRows('base', buildWith({})).filter((r) => r.label === 'Coverage months entered for'),
    ).toHaveLength(0);
  });
});

describe('buildReportData — imported-data hardening', () => {
  const flatRows = (data: ReturnType<typeof buildReportData>) =>
    (data.scenarios.find((s) => s.id === 'base')?.settingGroups ?? []).flatMap((g) => g.rows);

  const buildWith = (overrides: Record<string, unknown>) =>
    buildReportData(
      baseInput({
        scenarios: [
          scenario('base', { name: 'Base', isPrimary: true, overrides: overrides as never }),
        ],
        activeScenarioId: 'base',
      }),
      NOW,
    );

  it('a NON-ARRAY imported benchmark payload does not take down the report or the PDF build', () => {
    // Import validation checks the envelope, never override shapes; iterating a non-array here threw out of both the health panel and the settings table.
    let data!: ReturnType<typeof buildReportData>;
    expect(() => {
      data = buildWith({ acaPtcBenchmark: { taxYear: 2030, annualSlcspDollars: 9_000 } });
    }).not.toThrow();
    expect(data.scenarios[0].healthAssumptions.benchmarkPrice).toMatch(
      /rough estimate is used every year/i,
    );
    expect(flatRows(data).filter((r) => /benchmark/i.test(r.label))).toHaveLength(0);
  });

  it('malformed benchmark ROWS are dropped from both report surfaces', () => {
    const data = buildWith({
      acaPtcBenchmark: [
        { taxYear: '2029', annualSlcspDollars: 9_000 },
        { taxYear: 2030, annualSlcspDollars: -5 },
        null,
        { taxYear: 2031, annualSlcspDollars: 9_600 },
      ],
    });
    expect(data.scenarios[0].healthAssumptions.benchmarkPrice).toMatch(
      /benchmark plan price is used for 2031\./i,
    );
    expect(flatRows(data).filter((r) => /benchmark/i.test(r.label)).map((r) => r.label)).toEqual([
      'ACA benchmark (SLCSP) 2031',
    ]);
  });

  it('an imported prototype-chain region value emits no PDF row and reports the default', () => {
    // Indexing the label map directly returned an inherited function for "constructor", which broke the settings table and the on-screen panel.
    const data = buildWith({ acaFplRegion: 'constructor' });
    expect(flatRows(data).filter((r) => r.label === 'Federal poverty guidelines')).toHaveLength(0);
    expect(data.scenarios[0].healthAssumptions.povertyGuidelines).toMatch(/48 mainland states/i);
    const unknown = buildWith({ acaFplRegion: 'puerto-rico' });
    expect(flatRows(unknown).filter((r) => r.label === 'Federal poverty guidelines')).toHaveLength(
      0,
    );
  });

  it('a malformed stored YEAR key never renders as "NaN"', () => {
    const data = buildWith({
      healthCoverageMonths: {
        perMember: { 'member-primary': { NaN: { partBMonths: 6 }, 2030: { partBMonths: 5 } } },
      },
    });
    const health = data.scenarios[0].healthAssumptions;
    expect(health.coverageMonths).toContain('2030');
    expect(health.coverageMonths).not.toMatch(/NaN/);
    const coverageRows = flatRows(data).filter((r) => r.label === 'Coverage months entered for');
    expect(coverageRows).toHaveLength(1);
    expect(coverageRows[0].value).toBe('2030');
  });

  it('both report surfaces state that an entered annual price is prorated to coverage months', () => {
    const data = buildWith({
      acaPtcBenchmark: [{ taxYear: 2030, annualSlcspDollars: 12_000 }],
      healthCoverageMonths: {
        perMember: { 'member-primary': { 2030: { marketplaceMonths: 7 } } },
      },
    });
    expect(data.scenarios[0].healthAssumptions.benchmarkPrice).toMatch(
      /whole-year price.*part-year Marketplace coverage is charged the matching share/i,
    );
    const benchmarkRow = flatRows(data).find((r) => r.label === 'ACA benchmark (SLCSP) 2030');
    expect(benchmarkRow?.value).toBe('$12,000/yr, prorated to Marketplace coverage months');
  });
});

describe('buildReportData — market stress assumptions', () => {
  const stressFor = (overrides: Record<string, unknown>) =>
    buildReportData(
      baseInput({
        scenarios: [
          scenario('base', { name: 'Base', isPrimary: true, overrides: overrides as never }),
        ],
      }),
      NOW,
    ).scenarios[0].marketStressAssumptions;

  it('restates every approved case with the magnitude the engine actually uses', () => {
    const stress = stressFor({});
    expect(stress.cases.map((c) => c.name)).toEqual(
      STRESS_CASE_IDS.map((id) => STRESS_CASE_COPY[id].name),
    );
    const byName = new Map(stress.cases.map((c) => [c.name, c.changed]));
    expect(byName.get('Higher fees')).toContain(
      `${STRESS_CASES.higherFees.investmentCostPctDelta}%`,
    );
    expect(byName.get('Lower returns')).toContain(
      `Stocks ${STRESS_CASES.lowerReturns.returnShockStocksPct}% a year lower`,
    );
    expect(byName.get('Higher inflation')).toContain(
      `Inflation ${STRESS_CASES.higherInflation.inflationShockPct}% a year higher`,
    );
    expect(byName.get('Longer life')).toContain(
      `${STRESS_CASES.longerLife.longevityShockYears} more years`,
    );
    // The report has no household to anchor an age on, so the age-105 ceiling is stated once in the disclosures, not on the row.
    expect(byName.get('Longer life')).not.toContain('age');
    expect(
      stressFor({}).disclosures.some((d) => d.includes(`age ${STRESS_MAX_AGE}`)),
    ).toBe(true);
  });

  it('discloses the longer-life approximations, not just the same-paths claim', () => {
    const { disclosures } = stressFor({});
    expect(disclosures.some((d) => /only up to the original end of the plan/i.test(d))).toBe(true);
    expect(disclosures.some((d) => /use fresh market draws/i.test(d))).toBe(true);
    expect(
      disclosures.some((d) => /no further cost-of-living increase/i.test(d)),
    ).toBe(true);
    expect(
      disclosures.some((d) => /keeps whichever tax return it was already filing/i.test(d)),
    ).toBe(true);
    expect(disclosures.some((d) => /illustrations, not forecasts/i.test(d))).toBe(true);
  });

  it('does not promise the longer-life approximations lean one way', () => {
    // The padded extra years have no knowable net direction, so any "more cautious, not less" reassurance is a false promise and must not return.
    const text = stressFor({}).disclosures.join(' ');
    expect(text).not.toMatch(/more cautious,? not less/i);
    expect(text).not.toMatch(/leans? are conservative/i);
    expect(text).not.toMatch(/both leans make/i);
    expect(text).toMatch(/an estimate rather than an exact re-run/i);
    expect(text).toMatch(/move the result in either direction/i);
  });
});

describe('buildReportData — Account limits (minimum-balance floors)', () => {
  const floorAccounts = () => [
    account('a-tax', { name: 'Brokerage', type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
    account('a-hsa', { name: 'Health savings', type: 'HSA', taxTreatment: 'HSA' }),
    account('a-pre', { name: '401k', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
  ];
  const groupsFor = (data: ReturnType<typeof buildReportData>, id: string) =>
    data.scenarios.find((s) => s.id === id)?.settingGroups ?? [];

  it('renders one row per floored eligible account plus the fixed-dollar caveat', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountFloors: {
          perAccount: {
            'a-tax': { floorDollars: 25000 },
            'a-hsa': { floorDollars: 10000, hsaMode: 'strict' },
          },
        },
      },
    });
    const data = buildReportData(
      baseInput({ accounts: floorAccounts(), scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    const group = groupsFor(data, 'base').find((g) => g.title === 'Account limits');
    expect(group).toBeDefined();
    expect(group?.rows.map((r) => r.label)).toEqual([
      'Minimum balance — Brokerage',
      'Minimum balance — Health savings',
      'Floor amounts',
    ]);
    expect(group?.rows[0]?.value).toBe('$25,000');
    expect(group?.rows[1]?.value).toBe('$10,000; blocks all draws, including medical');
    expect(group?.rows[2]?.value).toContain('not adjusted for inflation');
    expect(group?.rows[2]?.value).toContain(
      'Protected for everyday spending; drawn only as a last resort',
    );
  });

  it('describes the default HSA mode as blocking emergency draws only', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountFloors: { perAccount: { 'a-hsa': { floorDollars: 5000 } } },
      },
    });
    const data = buildReportData(
      baseInput({ accounts: floorAccounts(), scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    const group = groupsFor(data, 'base').find((g) => g.title === 'Account limits');
    expect(group?.rows[0]?.value).toBe('$5,000; blocks emergency draws only');
  });

  it('reports a floor a child scenario inherits from its parent', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountFloors: { perAccount: { 'a-tax': { floorDollars: 40000 } } },
      },
    });
    const child = scenario('child', {
      name: 'Child',
      parentScenarioId: 'base',
      overrides: {},
    });
    const data = buildReportData(
      baseInput({
        accounts: floorAccounts(),
        scenarios: [base, child],
        activeScenarioId: 'base',
      }),
      NOW,
    );
    const group = groupsFor(data, 'child').find((g) => g.title === 'Account limits');
    expect(group?.rows[0]).toEqual({
      label: 'Minimum balance — Brokerage',
      value: '$40,000',
    });
  });

  it('omits floors the engine ignores (ineligible, inactive, or $0), and the group when none remain', () => {
    const accounts = [
      ...floorAccounts(),
      account('a-off', { name: 'Closed', type: 'BROKERAGE', taxTreatment: 'POST_TAX', active: false }),
    ];
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountFloors: {
          perAccount: {
            // PRE_TAX: the engine's floor-eligibility predicate ignores it.
            'a-pre': { floorDollars: 15000 },
            // Inactive: excluded from the projection entirely.
            'a-off': { floorDollars: 20000 },
            // A strict-HSA $0 row must never print a blocking claim: the engine reads $0 as no floor.
            'a-hsa': { floorDollars: 0, hsaMode: 'strict' },
          },
        },
      },
    });
    const data = buildReportData(
      baseInput({ accounts, scenarios: [base], activeScenarioId: 'base' }),
      NOW,
    );
    expect(
      groupsFor(data, 'base').find((g) => g.title === 'Account limits'),
    ).toBeUndefined();
  });

  it('emits no Account limits group when no scenario in the chain sets a floor', () => {
    const data = buildReportData(
      baseInput({ accounts: floorAccounts() }),
      NOW,
    );
    expect(
      groupsFor(data, 'base').find((g) => g.title === 'Account limits'),
    ).toBeUndefined();
  });
});
