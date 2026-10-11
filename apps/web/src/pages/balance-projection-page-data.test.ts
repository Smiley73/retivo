/**
 * `loadPageData` — runner-adapter data-flow tests.
 *
 * Post-migration `loadPageData` is a thin adapter over
 * `runBalanceProjectionForPage`: it runs the shared projection once, maps
 * the runner's `sharedCtx.accountProjections` into the page's
 * `BreakdownAccountRow` set, and surfaces the per-method drawdown slices on
 * `pageResult`. The old page-local re-projection + `buildDrawdownByMethod`
 * are gone — the deterministic-drawdown correctness (incl. the
 * post-primary CBP lump-sum transfer + RMD-context behavior) now lives in
 * the runner's own test suite (`balance-projection-runner*.test.ts`).
 *
 * These tests pin the page-adapter contract:
 *   (a) rows come from the runner's `accountProjections` (account set,
 *       owner display, insufficient-history flag);
 *   (b) `pageResult` carries the both-methods drawdown slices and
 *       `drawdownByMethodFromPageResult` projects them into the page shape;
 *   (c) hidden-account footer counts (inactive + zero-history) are
 *       computed page-side;
 *   (d) the page-side tax fields still flow through the runner for a
 *       named strategy (the tax post-pass populates them).
 */
import { describe, expect, it } from 'vitest';
import {
  loadPageData,
  drawdownByMethodFromPageResult,
} from './balance-projection-page-pipeline';
import {
  computeMethodTotal,
  type BreakdownAccountRow,
} from './balance-projection-page-yearly';
import type { ProjectionMethod } from '../components/ProjectionChart';
import { runBalanceProjection } from '../lib/balance-projection-runner';
import type { RunBalanceProjectionArgs } from '../lib/balance-projection-runner-types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');
const TODAY_YEAR = TODAY.getUTCFullYear();
const TODAY_MONTH = TODAY.getUTCMonth();

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
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}

function brokerage(
  id: string,
  ownerId: string,
  planningReturnPct = 5,
  active = true,
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
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId,
      institution: 'X',
      notes: '',
      planningReturnPct,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function ira(id: string, ownerId: string, planningReturnPct = 5): Aggregate<AccountPayload> {
  return {
    ...brokerage(id, ownerId, planningReturnPct),
    payload: {
      ...brokerage(id, ownerId, planningReturnPct).payload,
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
    },
  };
}

function cbp(id: string, ownerId: string, planningReturnPct = 5): Aggregate<AccountPayload> {
  return {
    ...brokerage(id, ownerId, planningReturnPct),
    payload: {
      ...brokerage(id, ownerId, planningReturnPct).payload,
      type: 'RETIREMENT_CASH_BALANCE',
      taxTreatment: 'PRE_TAX',
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
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
    },
  };
}

/** The auto-$0 seed an account picks up at creation: all numeric fields 0,
 *  splits null for non-MIXED. Mirrors AccountFormModal's seed payload shape. */
function seedRow(
  accountId: string,
  year: number,
): Aggregate<AccountBalancePayload> {
  return {
    id: `bal-${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-01-01T00:00:00Z`,
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
    },
  };
}

/** A MIXED-treatment account whose money lives ONLY in the split fields (the
 *  top-level startingBalance/endingBalance stay 0) — exercises the split
 *  source-of-truth for `hasAnyRealBalance`. */
function mixedSplitOnlyRow(
  accountId: string,
  year: number,
  endingPostTax: number,
): Aggregate<AccountBalancePayload> {
  return {
    ...seedRow(accountId, year),
    payload: {
      ...seedRow(accountId, year).payload,
      startingBalancePreTax: 0,
      startingBalancePostTax: 0,
      contributionsPreTax: 0,
      contributionsPostTax: 0,
      companyContributionsPreTax: 0,
      companyContributionsPostTax: 0,
      endingBalancePreTax: 0,
      endingBalancePostTax: endingPostTax,
    },
  };
}

function mixed401k(id: string, ownerId: string): Aggregate<AccountPayload> {
  return {
    ...brokerage(id, ownerId, 5),
    payload: {
      ...brokerage(id, ownerId, 5).payload,
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
    },
  };
}

function baseScenario(
  id: string,
  name: string,
  withdrawalStrategy?: { kind: string },
): ScenarioAggregate {
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
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90, secondary: 90 },
        ...(withdrawalStrategy
          ? { withdrawalStrategy: withdrawalStrategy as never }
          : {}),
      },
    },
  };
}

function callLoad(opts: {
  scenarios: ScenarioAggregate[];
  members: Aggregate<HouseholdMemberPayload>[];
  accounts: Aggregate<AccountPayload>[];
  balances: Aggregate<AccountBalancePayload>[];
  ssBenefits?: Aggregate<SocialSecurityBenefitPayload>[];
}): ReturnType<typeof loadPageData> {
  return loadPageData({
    scenarios: opts.scenarios,
    selectedScenarioId: opts.scenarios[0].id,
    members: opts.members,
    accounts: opts.accounts,
    balances: opts.balances,
    expenses: [],
    incomeStreams: [],
    ssBenefits: opts.ssBenefits ?? [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH,
  });
}

describe('loadPageData — runner-adapter data flow', () => {
  it('maps runner accountProjections into rows (account set + owner display)', () => {
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = brokerage('a1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [balanceRow('a1', TODAY_YEAR - 2, 100_000), balanceRow('a1', TODAY_YEAR - 1, 110_000)],
    });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].account.id).toBe('a1');
    expect(data.rows[0].ownerDisplay).toBe('Alex');
    // Two years of history → TWR available → no insufficient-history flag.
    expect(data.rows[0].hasInsufficientHistory).toBe(false);
    expect(data.rows[0].outputs.planned).not.toBeNull();
    // The page result carries the both-methods drawdown slices.
    expect(data.pageResult).not.toBeNull();
  });

  it('flags insufficient history for a single-year non-CBP account', () => {
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = brokerage('a1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 100_000)],
    });
    expect(data.rows[0].hasInsufficientHistory).toBe(true);
  });

  it('includes an insufficient-history non-CBP row at its planned rate under Historical', () => {
    // A single year of balance history → no empirical TWR. The runner fills
    // `outputs.twr` with the PLANNED projection; the page adapter now KEEPS
    // that planned-rate fallback (no longer nulls it) so the account is
    // INCLUDED across all Historical surfaces — reversing the prior
    // exclusion that blanked the whole Historical view when even one account
    // was empty / new. `hasInsufficientHistory` still flags it for
    // disclosure (the ⚠ marker + the inline note + the footnote count).
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = brokerage('a1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 100_000)],
    });
    expect(data.rows[0].hasInsufficientHistory).toBe(true);
    // `outputs.twr` is retained (the planned-rate fallback), NOT nulled.
    expect(data.rows[0].outputs.twr).not.toBeNull();
    expect(data.rows[0].outputs.planned).not.toBeNull();
    // The Historical fallback equals the planned projection for this account
    // (same rate — no empirical rate exists).
    expect(data.rows[0].outputs.twr!.total).toBe(data.rows[0].outputs.planned!.total);

    // `computeMethodTotal(rows, 'twr')` INCLUDES the row at the planned rate
    // and counts it as a planned-rate (mixed-basis) account for disclosure.
    const twrTotal = computeMethodTotal(
      data.rows as ReadonlyArray<BreakdownAccountRow>,
      'twr' as ProjectionMethod,
    );
    expect(twrTotal.total).toBe(data.rows[0].outputs.twr!.total);
    expect(twrTotal.plannedRateCount).toBe(1);
  });

  it('keeps outputs.twr non-null for a single-year CBP row (TWR tab + totals include it)', () => {
    // Complement to the non-CBP insufficient-history case above. A CBP
    // (RETIREMENT_CASH_BALANCE) account accrues from the cash-balance
    // formula, not market returns, so the runner deliberately reuses the
    // PLANNED projection as the CBP TWR output and leaves
    // `ratePctByMethod.twr` non-null. The page adapter's
    // `hasInsufficientHistory = !isCbp && …` gate must therefore leave a
    // CBP row's `outputs.twr` intact — the TWR tab/total legitimately
    // reflects the planned projection. Removing the `!isCbp` half of the
    // gate would wrongly null/exclude this valid CBP TWR row.
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = cbp('cbp1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      // Single year of history — would flag insufficient history for a
      // non-CBP account, but CBP rows accrue from a formula and are exempt.
      balances: [balanceRow('cbp1', TODAY_YEAR - 1, 100_000)],
    });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].account.id).toBe('cbp1');

    // (a) CBP rows are never flagged insufficient-history.
    expect(data.rows[0].hasInsufficientHistory).toBe(false);
    // (b) `outputs.twr` is retained (NOT nulled) — the CBP TWR surface
    //     reflects the planned projection by design.
    expect(data.rows[0].outputs.twr).not.toBeNull();
    expect(data.rows[0].outputs.planned).not.toBeNull();

    // (c) `computeMethodTotal(rows, 'twr')` INCLUDES the CBP row — it
    //     contributes to the total and is not counted as excluded.
    const twrTotal = computeMethodTotal(
      data.rows as ReadonlyArray<BreakdownAccountRow>,
      'twr' as ProjectionMethod,
    );
    expect(twrTotal.total).toBeGreaterThan(0);
    expect(twrTotal.total).toBe(data.rows[0].outputs.twr!.total);
    expect(twrTotal.plannedRateCount).toBe(0);
  });

  it('counts hidden inactive + zero-history accounts page-side', () => {
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const active = brokerage('a1', 'm1', 5, true);
    const inactive = brokerage('a2', 'm1', 5, false);
    const activeNoHistory = brokerage('a3', 'm1', 5, true);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [active, inactive, activeNoHistory],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 100_000)],
    });
    expect(data.hiddenInactiveCount).toBe(1);
    expect(data.hiddenZeroHistoryCount).toBe(1);
    // Only the active-with-history account makes it into rows.
    expect(data.rows.map((r) => r.account.id)).toEqual(['a1']);
  });

  it('drawdownByMethodFromPageResult projects the runner slices into page shape', () => {
    const birthYear = TODAY_YEAR - 67; // retires this year → drawdown runs
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = brokerage('a1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 500_000)],
      ssBenefits: [ssBenefit('m1', 0)],
    });
    const dd = drawdownByMethodFromPageResult(data.pageResult);
    expect(dd).not.toBeNull();
    expect(dd!.planned).not.toBeNull();
    expect(dd!.planned!.years.length).toBeGreaterThan(0);
    // The runner's net at-retirement figure
    // carries through onto the page-level slice, additively.
    expect(dd!.planned!.netPortfolioAtRetirement).toBe(500_000);
  });

  it('returns null pageResult/empty rows when no primary retirement is resolvable', () => {
    const members = [member('m1', true, 'Alex', TODAY_YEAR - 60)];
    const acct = brokerage('a1', 'm1', 5);
    // Scenario with no retirementAge override → page renders its own
    // empty-state guard; the adapter never reaches the runner.
    const scenario = baseScenario('s', 'NoRetAge');
    const stripped: ScenarioAggregate = {
      ...scenario,
      payload: { ...scenario.payload, overrides: {} },
    };
    const data = callLoad({
      scenarios: [stripped],
      members,
      accounts: [acct],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 100_000)],
    });
    expect(data.pageResult).toBeNull();
    expect(data.rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Deterministic-side migration parity. The page now sources its
  // drawdown from `runBalanceProjectionForPage`; these prove the page
  // surface is value-identical to the canonical single-method runner
  // (`runBalanceProjection`) that the Plan Stress Test card + optimizer
  // use — closing the prior page-vs-runner RMD divergence.
  // ---------------------------------------------------------------------

  function runArgsFor(opts: {
    scenarios: ScenarioAggregate[];
    members: Aggregate<HouseholdMemberPayload>[];
    accounts: Aggregate<AccountPayload>[];
    balances: Aggregate<AccountBalancePayload>[];
    ssBenefits?: Aggregate<SocialSecurityBenefitPayload>[];
  }): RunBalanceProjectionArgs {
    return {
      scenarioId: opts.scenarios[0].id,
      scenarios: opts.scenarios,
      accounts: opts.accounts,
      balances: opts.balances,
      members: opts.members,
      ssBenefits: opts.ssBenefits ?? [],
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH,
      method: 'planned',
    };
  }

  it('page drawdown years equal the canonical runner for a no-tax default-strategy scenario', () => {
    const birthYear = TODAY_YEAR - 67; // retires this year, non-RMD-age
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = brokerage('a1', 'm1', 5);
    const scenarios = [baseScenario('s', 'DefaultStrategy')]; // no strategy → taxEfficient default
    const balances = [balanceRow('a1', TODAY_YEAR - 1, 500_000)];
    const ss = [ssBenefit('m1', 0)];

    const data = callLoad({ scenarios, members, accounts: [acct], balances, ssBenefits: ss });
    const pageYears = drawdownByMethodFromPageResult(data.pageResult)?.planned?.years ?? [];

    const canonical = runBalanceProjection(
      runArgsFor({ scenarios, members, accounts: [acct], balances, ssBenefits: ss }),
    );
    // Value-identical: same year set + same end-of-year balances + withdrawals.
    expect(pageYears.map((y) => y.year)).toEqual(
      canonical.drawdownYears.map((y) => y.year),
    );
    pageYears.forEach((y, i) => {
      expect(y.balance).toBeCloseTo(canonical.drawdownYears[i].nominalBalance, 2);
      expect(y.withdrawn).toBeCloseTo(canonical.drawdownYears[i].withdrawal, 2);
    });
  });

  it('page TWR drawdown years equal the canonical TWR runner (two-year history)', () => {
    // Two balance-history years → empirical TWR is available, so the page's
    // TWR slice is populated and must be value-identical to the canonical
    // single-method `runBalanceProjection({ method: 'twr' })`. The runner migration reroutes
    // BOTH methods, so the TWR surface needs a parity guard equal to Planned.
    const birthYear = TODAY_YEAR - 67; // retires this year → drawdown runs
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = brokerage('a1', 'm1', 5);
    const scenarios = [baseScenario('s', 'DefaultStrategyTwr')]; // no strategy → taxEfficient default
    const balances = [
      balanceRow('a1', TODAY_YEAR - 2, 450_000),
      balanceRow('a1', TODAY_YEAR - 1, 500_000),
    ];
    const ss = [ssBenefit('m1', 0)];

    const data = callLoad({ scenarios, members, accounts: [acct], balances, ssBenefits: ss });
    const pageTwrYears = drawdownByMethodFromPageResult(data.pageResult)?.twr?.years ?? [];
    expect(pageTwrYears.length).toBeGreaterThan(0);

    const canonical = runBalanceProjection({
      ...runArgsFor({ scenarios, members, accounts: [acct], balances, ssBenefits: ss }),
      method: 'twr',
    });
    expect(canonical.methodAvailable).toBe(true);
    // Value-identical: same year set + same end-of-year balances + withdrawals.
    expect(pageTwrYears.map((y) => y.year)).toEqual(
      canonical.drawdownYears.map((y) => y.year),
    );
    pageTwrYears.forEach((y, i) => {
      expect(y.balance).toBeCloseTo(canonical.drawdownYears[i].nominalBalance, 2);
      expect(y.withdrawn).toBeCloseTo(canonical.drawdownYears[i].withdrawal, 2);
    });
  });

  it('page per-account drawdown matches the runner + enforces RMD context (divergence closed)', () => {
    // Per-account (taxEfficient) scenario, age 67 retiree → reaches RMD
    // age (73) mid-horizon, so the RMD floor engages on later years.
    // Pre-migration the page's own `simulateDrawdown` call site ignored
    // RMD context, diverging from the runner; the migration routes both through the
    // same engine. The page surface must now be value-identical to the
    // canonical runner the stress-test card uses.
    const birthYear = TODAY_YEAR - 67;
    const members = [member('m1', true, 'Alex', birthYear)];
    const iraAcct = ira('ira1', 'm1', 5);
    const scenarios = [baseScenario('s', 'TaxEfficientRmd', { kind: 'taxEfficient' })];
    const balances = [balanceRow('ira1', TODAY_YEAR - 1, 800_000)];
    const ss = [ssBenefit('m1', 0)];

    const data = callLoad({ scenarios, members, accounts: [iraAcct], balances, ssBenefits: ss });
    const pageYears = drawdownByMethodFromPageResult(data.pageResult)?.planned?.years ?? [];

    const canonical = runBalanceProjection(
      runArgsFor({ scenarios, members, accounts: [iraAcct], balances, ssBenefits: ss }),
    );
    expect(pageYears.length).toBeGreaterThan(0);
    expect(pageYears.map((y) => y.year)).toEqual(
      canonical.drawdownYears.map((y) => y.year),
    );
    pageYears.forEach((y, i) => {
      expect(y.balance).toBeCloseTo(canonical.drawdownYears[i].nominalBalance, 2);
      expect(y.withdrawn).toBeCloseTo(canonical.drawdownYears[i].withdrawal, 2);
    });
    // RMD floor is populated on the per-account ledger years (RMD context
    // threaded through the shared runner — the divergence the migration closes).
    expect(pageYears.some((y) => (y.rmdFloorCents ?? 0) > 0)).toBe(true);
  });

  it('a named strategy populates tax fields on the drawdown years (runner post-pass)', () => {
    const birthYear = TODAY_YEAR - 67;
    const members = [member('m1', true, 'Alex', birthYear)];
    const iraAcct = ira('ira1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'TaxEfficient', { kind: 'taxEfficient' })],
      members,
      accounts: [iraAcct],
      balances: [balanceRow('ira1', TODAY_YEAR - 1, 500_000)],
      ssBenefits: [ssBenefit('m1', 0)],
    });
    const dd = drawdownByMethodFromPageResult(data.pageResult);
    expect(dd).not.toBeNull();
    const years = dd!.planned?.years ?? [];
    expect(years.length).toBeGreaterThan(0);
    // The runner's tax post-pass runs for every named strategy, so the tax
    // fields are defined on the year rows the page renders.
    expect(years[0].federalTaxCents).toBeDefined();
    expect(years[0].magiCents).toBeDefined();
  });
});

describe('Historical (TWR) no longer vetoed by an empty / short-history account', () => {
  // One funded, historied account (≥2 yr) + one zero-balance no-history
  // account → Historical stays available, renders drawdown years, and the
  // empty account does NOT blank the whole projection (the exact reported
  // bug). The empty (no-rows) account is unprojected + absent from the
  // fallback list.
  it('does not blank Historical when a zero-balance no-history account is present', () => {
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const funded = brokerage('funded', 'm1', 5);
    const emptyRoth = brokerage('roth', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [funded, emptyRoth],
      // funded has 2 yr history; emptyRoth has NO balance rows.
      balances: [
        balanceRow('funded', TODAY_YEAR - 2, 100_000),
        balanceRow('funded', TODAY_YEAR - 1, 110_000),
      ],
    });
    const sharedCtx = data.pageResult!.sharedCtx;
    // Historical is available (≥1 account has empirical history).
    expect(sharedCtx.methodAvailable).toBe(true);
    // The TWR drawdown slice exists and renders drawdown years.
    expect(data.pageResult!.twr).not.toBeNull();
    expect((data.pageResult!.twr?.years.length ?? 0)).toBeGreaterThan(0);
    // The no-rows account is unprojected (absent from rows) and not in the
    // fallback list (nothing renders for it until it has a balance row).
    expect(data.rows.map((r) => r.account.id)).toEqual(['funded']);
    expect(sharedCtx.fallbackAccounts).toEqual([]);
  });

  // A funded but short-history (<2 yr) account → Historical available (not
  // vetoed), the account falls back to its planned rate, and it appears in
  // `sharedCtx.fallbackAccounts`.
  it('falls a funded short-history account back to planned and lists it', () => {
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const funded = brokerage('funded', 'm1', 5);
    const shortHistory = brokerage('short', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [funded, shortHistory],
      balances: [
        balanceRow('funded', TODAY_YEAR - 2, 100_000),
        balanceRow('funded', TODAY_YEAR - 1, 110_000),
        // shortHistory: a single funded year → no empirical rate.
        balanceRow('short', TODAY_YEAR - 1, 50_000),
      ],
    });
    const sharedCtx = data.pageResult!.sharedCtx;
    expect(sharedCtx.methodAvailable).toBe(true);
    expect(sharedCtx.fallbackAccounts).toEqual([{ id: 'short', name: 'short' }]);
    // The short-history row is INCLUDED at its planned rate.
    const shortRow = data.rows.find((r) => r.account.id === 'short')!;
    expect(shortRow.hasInsufficientHistory).toBe(true);
    expect(shortRow.outputs.twr).not.toBeNull();
  });

  // Fallback-list correctness for a mixed portfolio + the `[]` empty case.
  it('surfaces an empty fallback list when every account has empirical history', () => {
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const a = brokerage('a', 'm1', 5);
    const b = brokerage('b', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [a, b],
      balances: [
        balanceRow('a', TODAY_YEAR - 2, 100_000),
        balanceRow('a', TODAY_YEAR - 1, 110_000),
        balanceRow('b', TODAY_YEAR - 2, 200_000),
        balanceRow('b', TODAY_YEAR - 1, 210_000),
      ],
    });
    expect(data.pageResult!.sharedCtx.fallbackAccounts).toEqual([]);
    expect(data.pageResult!.sharedCtx.methodAvailable).toBe(true);
  });

  // Degenerate case: NO non-CBP account has ≥2 yr history → Historical
  // hidden (methodAvailable false, twr slice null); giving one account a
  // second year makes it available.
  it('hides Historical only in the all-fallback degenerate case', () => {
    const birthYear = TODAY_YEAR - 60;
    const members = [member('m1', true, 'Alex', birthYear)];
    const acct = brokerage('a1', 'm1', 5);
    const degenerate = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      // Single funded year → no empirical rate anywhere.
      balances: [balanceRow('a1', TODAY_YEAR - 1, 100_000)],
    });
    expect(degenerate.pageResult!.sharedCtx.methodAvailable).toBe(false);
    expect(degenerate.pageResult!.twr).toBeNull();
    // The single account still falls back + is disclosed.
    expect(degenerate.pageResult!.sharedCtx.fallbackAccounts).toEqual([
      { id: 'a1', name: 'a1' },
    ]);

    // Gaining a second year flips availability on.
    const withHistory = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [
        balanceRow('a1', TODAY_YEAR - 2, 90_000),
        balanceRow('a1', TODAY_YEAR - 1, 100_000),
      ],
    });
    expect(withHistory.pageResult!.sharedCtx.methodAvailable).toBe(true);
    expect(withHistory.pageResult!.sharedCtx.fallbackAccounts).toEqual([]);
  });
});

describe('hasAnyRealBalance empty-state gate', () => {
  const birthYear = TODAY_YEAR - 60;
  const members = [member('m1', true, 'Alex', birthYear)];

  it('a seed-$0-only portfolio has no real balance even though rows project', () => {
    // The $0 seed projects, so the account lands in rows — but
    // hasAnyRealBalance is false, so the page renders the onboarding prompt.
    const acct = brokerage('a1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [seedRow('a1', TODAY_YEAR)],
    });
    expect(data.hasAnyRealBalance).toBe(false);
    // The seed row is NOT counted as history (re-keyed hiddenZeroHistoryCount).
    expect(data.hiddenZeroHistoryCount).toBe(1);
    expect(data.rows.length).toBeGreaterThan(0);
  });

  it('clears once any account has a non-zero balance', () => {
    const acct = brokerage('a1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 100_000)],
    });
    expect(data.hasAnyRealBalance).toBe(true);
    expect(data.hiddenZeroHistoryCount).toBe(0);
  });

  it('a mixed portfolio (real + new $0-seed account) shows the projection', () => {
    const funded = brokerage('a1', 'm1', 5);
    const fresh = brokerage('a2', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [funded, fresh],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 100_000), seedRow('a2', TODAY_YEAR)],
    });
    expect(data.hasAnyRealBalance).toBe(true);
    // Only the fresh seed-only account is counted as zero-history.
    expect(data.hiddenZeroHistoryCount).toBe(1);
  });

  it('a MIXED account with money only in the split fields counts as real', () => {
    const acct = mixed401k('a1', 'm1');
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [mixedSplitOnlyRow('a1', TODAY_YEAR - 1, 50_000)],
    });
    expect(data.hasAnyRealBalance).toBe(true);
    expect(data.hiddenZeroHistoryCount).toBe(0);
  });

  it('a CBP account auto-seeded with a $0 row projects without breaking', () => {
    // The auto-$0 seed applies to all account types incl CBP. A CBP with
    // only the seed row still loads (preProjectCbpAccounts projects from the
    // cash-balance formula) and is treated as having no real balance yet.
    const acct = cbp('cbp1', 'm1', 5);
    const data = callLoad({
      scenarios: [baseScenario('s', 'Base')],
      members,
      accounts: [acct],
      balances: [seedRow('cbp1', TODAY_YEAR)],
    });
    expect(data.hasAnyRealBalance).toBe(false);
    expect(data.hiddenZeroHistoryCount).toBe(1);
    expect(data.pageResult).not.toBeNull();
  });
});
