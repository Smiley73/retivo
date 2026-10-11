/**
 * Unit tests for `report-roth-tax-free.ts` — the "Roth tax-free amounts" PDF
 * table builder.
 *
 * The cross-check test drives the real `buildPipelineContext` from `Aggregate`
 * fixtures (same fixture style as `balance-projection-runner-mc.test.ts`) so
 * the built rows are compared against what the production pipeline actually
 * resolved — a report-local re-derivation over hand-built inputs could not
 * catch an account-selection mismatch between the report and the engines,
 * which is exactly the failure mode this table exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { buildRothTaxFreeRows } from './report-roth-tax-free';
import { buildPipelineContext } from './balance-projection-runner-context';
import { buildMcTaxContext } from './balance-projection-runner-mc';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import type { RunBalanceProjectionArgs } from './balance-projection-runner-types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY_YEAR = 2026;
const TODAY_MONTH_INDEX = 5; // June (0-indexed).

function member(
  id: string,
  isPrimary: boolean,
  firstName: string,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName,
      lastName: '',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function account(
  id: string,
  ownerId: string,
  type: AccountPayload['type'],
  taxTreatment: AccountPayload['taxTreatment'],
  over: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      ...over,
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
  over: Partial<AccountBalancePayload> = {},
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
      startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
      ...over,
    },
  };
}

/** Recorded regular contributions — the §408A history a Roth IRA pool's
 *  contribution basis is derived from. */
function withContributions(
  row: Aggregate<AccountBalancePayload>,
  totalContributions: number,
): Aggregate<AccountBalancePayload> {
  return { ...row, payload: { ...row.payload, totalContributions } };
}

/** Recorded conversion amounts on a balance row — the source of a Roth IRA
 *  pool's remaining conversion-lot principal. */
function withConversion(
  row: Aggregate<AccountBalancePayload>,
  taxable: number,
  nontaxable = 0,
): Aggregate<AccountBalancePayload> {
  return {
    ...row,
    payload: {
      ...row.payload,
      rothConversionTaxableAmount: taxable,
      rothConversionNontaxableAmount: nontaxable,
    },
  };
}

/** Recorded in-plan-rollover principal — an employer plan's whole
 *  designated-Roth basis. */
function withInPlanRollover(
  row: Aggregate<AccountBalancePayload>,
  taxableDollars: number,
): Aggregate<AccountBalancePayload> {
  return {
    ...row,
    payload: { ...row.payload, rothInPlanRolloverTaxableAmount: taxableDollars },
  };
}

function baseScenario(id: string, name: string): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
        retirementAge: { primary: { ageYears: 67, ageMonths: 0 } },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90, secondary: 90 },
      },
    },
  };
}

interface Fixture {
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
}

function buildArgs(fixture: Fixture): RunBalanceProjectionArgs {
  const scenario = baseScenario('s', 'Base');
  return {
    scenarioId: scenario.id,
    scenarios: [scenario],
    accounts: fixture.accounts,
    balances: fixture.balances,
    members: fixture.members,
    ssBenefits: [],
    expenses: [],
    incomeStreams: [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH_INDEX,
  };
}

describe('buildRothTaxFreeRows — cross-check against buildPipelineContext', () => {
  // Alex (m1) owns two Roth IRAs — one active, one INACTIVE but carrying real
  // §408A history (the pool counts inactive accounts' history) — plus a
  // conversion lot. Sam (m2) owns an active MIXED-401k designated-Roth plan (in-plan rollover) and a CLOSED
  // designated-Roth 403b (recorded rollover, but inactive — must produce no
  // row at all).
  const alex = member('m1', true, 'Alex', 1965);
  const sam = member('m2', false, 'Sam', 1967);
  const activeIra = account('roth-ira-active', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH');
  const inactiveIra = account('roth-ira-inactive', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
    active: false,
  });
  const mixedPlan = account('mixed-401k', 'm2', 'RETIREMENT_401K', 'MIXED', {
    designatedRothFirstParticipationTaxYear: 2015,
  });
  const closedPlan = account('roth403b-closed', 'm2', 'RETIREMENT_ROTH_403B', 'ROTH', {
    active: false,
  });

  const balances: ReadonlyArray<Aggregate<AccountBalancePayload>> = [
    withConversion(
      withContributions(balanceRow('roth-ira-active', 2025, 100_000), 20_000),
      15_000,
    ),
    withContributions(balanceRow('roth-ira-inactive', 2025, 0), 8_000),
    withInPlanRollover(balanceRow('mixed-401k', 2025, 200_000), 12_000),
    withInPlanRollover(balanceRow('roth403b-closed', 2025, 0), 90_000),
  ];

  const args = buildArgs({
    members: [alex, sam],
    accounts: [activeIra, inactiveIra, mixedPlan, closedPlan],
    balances,
  });
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new Error('fixture failed to build a pipeline context');

  const rows = buildRothTaxFreeRows({
    accounts: args.accounts,
    balances: args.balances,
    members: args.members,
  });

  it('resolves the person row to the pool\'s basis + remaining conversion-lot principal', () => {
    const pool = ctx.rothDistributionFacts.rothIraByPool.get('m1')!;
    const lotsCents = pool.rothIra!.conversionLots.reduce(
      (sum, lot) =>
        sum + lot.taxableConvertedPrincipalCents + lot.nontaxableConvertedPrincipalCents,
      0,
    );
    const expectedCents = pool.rothIra!.regularContributionBasisCents + lotsCents;
    const personRow = rows.find((r) => r.kind === 'person' && r.label === 'Alex');
    expect(personRow).toBeDefined();
    expect(personRow!.amount).toBeCloseTo(expectedCents / 100, 6);
    // The basis COMPONENT (not the row total, which also includes the lot)
    // matches the per-owner deterministic/MC seed exactly.
    expect(ctx.rothBasisCentsByOwner.get('m1')).toBe(
      pool.rothIra!.regularContributionBasisCents,
    );
    // The inactive sibling's recorded contribution history is IN the
    // pooled basis.
    expect(pool.rothIra!.regularContributionBasisCents).toBe(28_000_00);
  });

  it('resolves the active employer row to the account\'s recorded basis, and emits no row for the closed plan', () => {
    const fact = ctx.rothDistributionFacts.designatedByAccount.get('mixed-401k')!;
    const employerRow = rows.find((r) => r.kind === 'employer' && r.label === 'mixed-401k');
    expect(employerRow).toBeDefined();
    expect(employerRow!.amount).toBeCloseTo(fact.basisCents / 100, 6);
    expect(ctx.rothDistributionFacts.designatedByAccount.has('roth403b-closed')).toBe(false);
    expect(rows.some((r) => r.label === 'roth403b-closed')).toBe(false);
  });

  it('emits exactly one person row and one employer row', () => {
    expect(rows.filter((r) => r.kind === 'person')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'employer')).toHaveLength(1);
  });
});

describe('buildRothTaxFreeRows — inherited absence', () => {
  it('prints no pooled line for a person whose only Roth IRA is inherited, but does print an own $0 pool and an inherited employer plan', () => {
    const alex = member('m1', true, 'Alex', 1965);
    const sam = member('m2', false, 'Sam', 1967);
    // m1's only Roth IRA is inherited — no pool at all.
    const inheritedIra = account('roth-ira-inherited', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
      rmdInheritedAccount: true,
    });
    // m2's own Roth IRA resolves to $0 (no recorded history) — still a real,
    // computed pool and DOES get a row.
    const ownZeroIra = account('roth-ira-own-zero', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH');
    // An inherited designated-Roth employer plan keeps its §402A treatment —
    // it DOES get a row.
    const inheritedPlan = account(
      'roth-401k-inherited',
      'm2',
      'RETIREMENT_ROTH_401K',
      'ROTH',
      { rmdInheritedAccount: true, designatedRothFirstParticipationTaxYear: 2012 },
    );
    const balances: ReadonlyArray<Aggregate<AccountBalancePayload>> = [
      balanceRow('roth-ira-inherited', 2025, 100_000),
      balanceRow('roth-ira-own-zero', 2025, 0),
      balanceRow('roth-401k-inherited', 2025, 50_000),
    ];
    const rows = buildRothTaxFreeRows({
      accounts: [inheritedIra, ownZeroIra, inheritedPlan],
      balances,
      members: [alex, sam],
    });
    // m1 has no person row at all (absence, not $0).
    expect(rows.some((r) => r.kind === 'person' && r.label === 'Alex')).toBe(false);
    // m2's own $0 pool DOES get a row.
    const zeroRow = rows.find((r) => r.kind === 'person' && r.label === 'Sam');
    expect(zeroRow).toBeDefined();
    expect(zeroRow!.amount).toBe(0);
    // The inherited employer plan DOES get a row.
    expect(rows.some((r) => r.kind === 'employer' && r.label === 'roth-401k-inherited')).toBe(
      true,
    );
  });
});

describe('buildRothTaxFreeRows', () => {
  it('prints the sum of contribution basis and remaining conversion-lot principal, not the basis alone', () => {
    const alex = member('m1', true, 'Alex', 1965);
    const ira = account('roth-ira', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH');
    const balances: ReadonlyArray<Aggregate<AccountBalancePayload>> = [
      withConversion(
        withContributions(balanceRow('roth-ira', 2025, 130_000), 10_000),
        20_000,
        5_000,
      ),
    ];
    const rows = buildRothTaxFreeRows({ accounts: [ira], balances, members: [alex] });
    const personRow = rows.find((r) => r.kind === 'person')!;
    // $10k basis + $20k taxable + $5k nontaxable conversion = $35k, not $10k.
    expect(personRow.amount).toBe(35_000);
  });
});

describe('buildRothTaxFreeRows — all-inactive §408A pool (unreachable by either engine; report omits it)', () => {
  // Sam's only Roth IRA is closed, but its recorded contribution history
  // leaves real basis behind — `rothIraByPool` still emits the pool (flagged
  // `allAccountsInactive`). Both engines agree that basis is unreachable,
  // each by its own mechanism: Monte Carlo's seed
  // (`mcDrawableRothBasisCentsByOwner`) excludes
  // the pool explicitly, while the deterministic engine credits basis only
  // through a DRAWN pool and charges only drawn ledger owners — and its ledger
  // holds active accounts only, so an all-inactive pool is never drawn.
  // `ctx.rothBasisCentsByOwner` still sums the pool's resolved basis, but
  // nothing consumes that entry (present, and inert). The report omits the
  // row for the same reason; this test pins the omission against the real
  // `PipelineContext`/`McTaxContext`, not the report builder against itself.
  const sam = member('m2', true, 'Sam', 1967);
  const closedIra = account('roth-ira-closed', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH', {
    active: false,
  });
  const balances: ReadonlyArray<Aggregate<AccountBalancePayload>> = [
    withContributions(balanceRow('roth-ira-closed', 2025, 0), 15_000),
  ];
  const args = buildArgs({ members: [sam], accounts: [closedIra], balances });
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new Error('fixture failed to build a pipeline context');

  it('flags the pool allAccountsInactive and prints no person row for it', () => {
    const pool = ctx.rothDistributionFacts.rothIraByPool.get('m2');
    expect(pool?.allAccountsInactive).toBe(true);
    const rows = buildRothTaxFreeRows({
      accounts: args.accounts,
      balances: args.balances,
      members: args.members,
    });
    expect(rows.some((r) => r.kind === 'person')).toBe(false);
  });

  it('ctx.rothBasisCentsByOwner still carries the all-inactive pool basis (resolved, but no deterministic pass consumes it)', () => {
    expect(ctx.rothBasisCentsByOwner.get('m2')).toBe(15_000_00);
  });

  it('the MC seed excludes the all-inactive pool basis entirely', () => {
    const mcCtx = buildMcTaxContext(ctx);
    if (!mcCtx) throw new Error('fixture failed to build an MC tax context');
    expect((mcCtx.rothBasisCentsByOwner ?? []).find((row) => row.ownerId === 'm2')).toBeUndefined();
  });
});

describe('buildRothTaxFreeRows — regular POST_TAX TSP correctly produces no employer row', () => {
  // `RETIREMENT_TSP` stored plain `POST_TAX` (not `MIXED`) does not match
  // `buildRothDistributionFacts`'s designated-Roth branch, so this shape
  // produces no `designatedByAccount` fact and, in turn, no employer row
  // here. This is correct, not an engine gap needing wider matching:
  // the balance-evidence matrix excludes a
  // regular POST_TAX TSP's recorded fields from qualifying as designated-Roth
  // §402A basis/clock evidence — crediting it here without the rest of the
  // engines treating it as designated-Roth would understate tax on its own
  // withdrawals while overstating a sibling plan's pro-rata basis.
  // Whether such an account shape should count as designated-Roth is a
  // separate, open question.
  it('prints no section at all for a household whose only Roth account is an active RETIREMENT_TSP stored POST_TAX', () => {
    const alex = member('m1', true, 'Alex', 1965);
    const tsp = account('tsp-roth', 'm1', 'RETIREMENT_TSP', 'POST_TAX', {
      designatedRothFirstParticipationTaxYear: 2015,
    });
    const balances: ReadonlyArray<Aggregate<AccountBalancePayload>> = [
      withInPlanRollover(balanceRow('tsp-roth', 2025, 50_000), 5_000),
    ];
    const rows = buildRothTaxFreeRows({ accounts: [tsp], balances, members: [alex] });
    expect(rows).toEqual([]);
  });
});

describe('buildRothTaxFreeRows — no Roth accounts', () => {
  it('returns no rows for a household with no Roth accounts', () => {
    const alex = member('m1', true, 'Alex', 1965);
    const brokerage = account('brokerage', 'm1', 'BROKERAGE', 'POST_TAX');
    const rows = buildRothTaxFreeRows({
      accounts: [brokerage],
      balances: [balanceRow('brokerage', 2025, 100_000)],
      members: [alex],
    });
    expect(rows).toEqual([]);
  });
});
