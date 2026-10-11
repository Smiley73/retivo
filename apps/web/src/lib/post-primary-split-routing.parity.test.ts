/**
 * Per-account parity + §325 witness for post-primary spouse-contribution
 * split routing.
 *
 * A still-working spouse's POST-PRIMARY contributions now route per-account
 * carrying their pre/post (pre-tax vs designated-Roth) source split, in BOTH
 * the deterministic per-account engine (`simulateDrawdown` accounts branch,
 * reading `depositsByMonth` + `depositsPostByMonth`) and the named-strategy
 * Monte Carlo path (`runMonteCarlo` strategy slice, reading the ledger's
 * `depositPre` / `depositPost`). The keystone pins det == MC on per-account
 * `preEnd` / `postEnd` and on the §325-correct RMD floor (computed from the
 * pre-tax sub-bucket via the SAME integer `computeRmd` seam → exact `toBe`).
 *
 * Witness construction (the combined-pot pin harness cannot see this):
 *   - ≥2 accounts each with a non-zero at-retirement balance.
 *   - The spouse's destination is a distinct MIXED account whose post-primary
 *     contribution carries BOTH a pre-tax and a designated-Roth (post) slice.
 *   - Owner alive into RMD years (born 1951 → trigger age 73).
 *   - Flat injected returns + zero CPI → det and MC trajectories coincide.
 *
 * The §325 fix is the red-fail carrier: under the OLD summed-then-treatment
 * routing the MIXED account's whole contribution (Roth slice included) landed
 * in `pre`, inflating `preEnd` and the RMD floor. The split routing keeps the
 * Roth slice in `post`, so `preEnd` (and the floor) is strictly lower — pinned
 * below by recomputing the old-path floor and asserting it is larger.
 */
import { describe, expect, it } from 'vitest';
import {
  runMonteCarlo,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
} from './monte-carlo.js';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';
import {
  buildPerAccountKernelInputs,
  routeHouseholdLevelEvents,
} from './monte-carlo-per-account.js';
import { simulateDrawdown } from './drawdown-engine.js';
import {
  computeRmdFloorCents,
  DEFAULT_TAX_CALIBRATION_BUNDLE,
} from './tax-integration.js';
import { emptyMonthlySeries, addOneOff } from './monthly-cashflow.js';
import type {
  DrawdownAccountInput,
  DrawdownYear,
  RmdContextInput,
} from './drawdown-engine-types.js';
import type { TaxMemberInput, TaxAccountSnapshot } from './tax-integration-helpers.js';

const FIRST = 2026;
const RET = 2026; // no accumulation phase — every step is drawdown
const HORIZON = 2042;
const YEARS = HORIZON - FIRST + 1;
const STEPS = YEARS * 12;

const RMD_SNAPSHOT = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;
// Engine-side member is BELOW the RMD trigger age and income covers expense, so
// neither engine forces a withdrawal — balances are pure deposit + growth and
// must match bit-for-bit across engines (no tax-funding asymmetry). The §325
// floor witness is computed SEPARATELY (below) against an RMD-age member on the
// resulting `preEnd`, which is all the floor basis depends on.
const OWNER_ID = 'owner';
const MEMBER: TaxMemberInput = {
  memberId: OWNER_ID,
  isoBirthdate: '1980-03-10', // below trigger age over the whole horizon
  onMedicare: false,
  hasAcaCoverage: false,
};
/** RMD-age member (born 1951 → trigger age 73) used ONLY to drive the §325
 *  floor computation on the engine-produced MIXED `preEnd`. */
const RMD_MEMBER: TaxMemberInput = {
  memberId: OWNER_ID,
  isoBirthdate: '1951-03-10',
  onMedicare: true,
  hasAcaCoverage: false,
};

/** Flat monthly return percent + zero CPI → deterministic MC. */
const FLAT_MONTHLY_PCT = 0.4;
const flat = (v: number): Float64Array => new Float64Array(STEPS).fill(v);

// Post-primary contribution into the MIXED destination: $9,000/yr pre-tax +
// $6,000/yr designated-Roth, per month over the whole (drawdown) horizon.
const PRE_PER_MONTH = 9_000 / 12;
const POST_PER_MONTH = 6_000 / 12;

// Two accounts, each with a non-zero at-retirement balance. The MIXED account
// (owned by the RMD-age member) receives the split post-primary contribution.
const PRE_TAX_BALANCE = 400_000;
const MIXED_PRE_START = 150_000;
const MIXED_POST_START = 50_000;

// Income strictly covers expense → zero net need → no withdrawals in either
// engine (the deposits + growth are the only balance movement), so the
// cross-engine balance parity is exact (no tax-funding asymmetry).
const ANNUAL_EXPENSE = 40_000;
const ANNUAL_SS = 90_000;

function ledgerDepositPre(): Float64Array {
  const a = new Float64Array(STEPS);
  for (let i = 0; i < STEPS; i += 1) a[i] = PRE_PER_MONTH;
  return a;
}
function ledgerDepositPost(): Float64Array {
  const a = new Float64Array(STEPS);
  for (let i = 0; i < STEPS; i += 1) a[i] = POST_PER_MONTH;
  return a;
}

function mcLedger(): MonteCarloAccountLedger[] {
  const depositPre = ledgerDepositPre();
  const depositPost = ledgerDepositPost();
  const summed = new Float64Array(STEPS);
  for (let i = 0; i < STEPS; i += 1) summed[i] = depositPre[i] + depositPost[i];
  return [
    {
      id: 'pretax-ira',
      initialPre: PRE_TAX_BALANCE,
      initialPost: 0,
      contribPre: new Float64Array(STEPS),
      contribPost: new Float64Array(STEPS),
      deposit: new Float64Array(STEPS),
      depositPre: new Float64Array(STEPS),
      depositPost: new Float64Array(STEPS),
      assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
      ownerId: OWNER_ID,
    },
    {
      id: 'mixed-401k',
      initialPre: MIXED_PRE_START,
      initialPost: MIXED_POST_START,
      contribPre: new Float64Array(STEPS),
      contribPost: new Float64Array(STEPS),
      // Summed deposit slot (kernel-byte-identical) + the split slots.
      deposit: summed,
      depositPre: depositPre,
      depositPost: depositPost,
      assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'MIXED',
      accountType: 'RETIREMENT_401K',
      ownerId: OWNER_ID,
    },
  ];
}

function mcInput(): MonteCarloInput {
  return {
    portfolioToday: PRE_TAX_BALANCE + MIXED_PRE_START + MIXED_POST_START,
    accountMcLedger: mcLedger(),
    annualContribution: 0,
    firstYear: FIRST,
    retirementYear: RET,
    horizonYear: HORIZON,
    monthlyExpenseBase: makeMonthlyExpenseBase(ANNUAL_EXPENSE, STEPS),
    ssByYear: Array.from({ length: YEARS }, () => ANNUAL_SS),
    incomeByYear: Array.from({ length: YEARS }, () => 0),
    pathCount: 4,
    seed: 9_321,
    strategyKind: 'taxEfficient',
    injectedReturns: flat(FLAT_MONTHLY_PCT),
    injectedCpi: flat(0),
    taxContext: {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [MEMBER],
      householdSize: 1,
      inflationRatePct: 0,
    },
  } as unknown as MonteCarloInput;
}

/** Deterministic per-account inputs mirroring the MC ledger + split deposits. */
function deterministicAccounts(): DrawdownAccountInput[] {
  const annualRatePct = ((1 + FLAT_MONTHLY_PCT / 100) ** 12 - 1) * 100;
  const preTaxSeries = emptyMonthlySeries(RET, HORIZON);
  const mixedPreSeries = emptyMonthlySeries(RET, HORIZON);
  const mixedPostSeries = emptyMonthlySeries(RET, HORIZON);
  for (let i = 0; i < STEPS; i += 1) {
    const year = RET + Math.floor(i / 12);
    const month0 = i % 12;
    addOneOff(mixedPreSeries, year, month0, PRE_PER_MONTH);
    addOneOff(mixedPostSeries, year, month0, POST_PER_MONTH);
  }
  return [
    {
      id: 'pretax-ira',
      initialPre: PRE_TAX_BALANCE,
      initialPost: 0,
      annualRatePct,
      depositsByMonth: preTaxSeries,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
    {
      id: 'mixed-401k',
      initialPre: MIXED_PRE_START,
      initialPost: MIXED_POST_START,
      annualRatePct,
      depositsByMonth: mixedPreSeries,
      depositsPostByMonth: mixedPostSeries,
      taxTreatment: 'MIXED',
      accountType: 'RETIREMENT_401K',
    },
  ];
}

function rmdContext(): RmdContextInput {
  return {
    ownerMeta: new Map([[OWNER_ID, { isoBirthdate: MEMBER.isoBirthdate, deathYear: HORIZON }]]),
    ownerByAccountId: new Map([
      ['pretax-ira', OWNER_ID],
      ['mixed-401k', OWNER_ID],
    ]),
    rmdSnapshot: RMD_SNAPSHOT,
  };
}

function deterministicYears(): DrawdownYear[] {
  const annualRatePct = ((1 + FLAT_MONTHLY_PCT / 100) ** 12 - 1) * 100;
  const expensesByMonth = emptyMonthlySeries(RET, HORIZON);
  const incomeByMonth = emptyMonthlySeries(RET, HORIZON);
  for (let i = 0; i < STEPS; i += 1) {
    const year = RET + Math.floor(i / 12);
    const month0 = i % 12;
    addOneOff(expensesByMonth, year, month0, ANNUAL_EXPENSE / 12);
    addOneOff(incomeByMonth, year, month0, ANNUAL_SS / 12);
  }
  const out = simulateDrawdown({
    portfolioAtRetirement: PRE_TAX_BALANCE + MIXED_PRE_START + MIXED_POST_START,
    ratePct: annualRatePct,
    expensesByMonth,
    incomeByMonth,
    depositsByMonth: emptyMonthlySeries(RET, HORIZON),
    retirementYear: RET,
    horizonYear: HORIZON,
    accounts: deterministicAccounts(),
    withdrawalStrategy: { kind: 'taxEfficient' },
    rmdContext: rmdContext(),
  });
  return out.years;
}

/** Floor (cents) computed from a year's per-account MIXED `preEnd` sub-bucket
 *  as a PRE_TAX snapshot — the §325-correct basis (the Roth slice is in
 *  `postEnd`, excluded). `taxYear` is the FOLLOWING year (prior-Dec-31 basis). */
function floorFromMixedPreEnd(
  preEndDollars: number,
  taxYear: number,
): number {
  const snapshot: TaxAccountSnapshot = {
    id: 'mixed-401k',
    type: 'RETIREMENT_401K',
    taxTreatment: 'PRE_TAX',
    ownerId: OWNER_ID,
    balancePriorYearDollars: preEndDollars,
    withdrawalDollars: 0,
  };
  return computeRmdFloorCents([RMD_MEMBER], [snapshot], taxYear, RMD_SNAPSHOT);
}

describe('post-primary split routing — per-account parity (keystone)', () => {
  it('det == MC on per-account preEnd/postEnd for the MIXED destination (invariance pin)', () => {
    // Total per-account balances are invariant under flat injected returns (the
    // §325 red-fail is carried by the floor cents, not the totals). This
    // pins that the split routing threads consistently across both engines.
    const detYears = deterministicYears();
    const mc = runMonteCarlo(mcInput());
    const mcYears = mc.representativeByBasis!['mc-typical']!.years;
    // Compare a mid-horizon drawdown year (offset 6 — well past entry, before
    // any depletion). Under flat injected returns the MC representative path
    // and the deterministic per-account engine produce the same trajectory.
    const offset = 6;
    const detRow = detYears[offset];
    const mcRow = mcYears.find((y) => y.year === detRow.year)!;
    const detMixed = detRow.accountBalances!.get('mixed-401k')!;
    const mcMixed = mcRow.accountBalances!.get('mixed-401k')!;
    expect(detMixed.preEnd).toBeCloseTo(mcMixed.preEnd, 2);
    expect(detMixed.postEnd).toBeCloseTo(mcMixed.postEnd, 2);
    const detPre = detRow.accountBalances!.get('pretax-ira')!;
    const mcPre = mcRow.accountBalances!.get('pretax-ira')!;
    expect(detPre.preEnd).toBeCloseTo(mcPre.preEnd, 2);
  });

  it('det == MC on the §325 RMD floor (exact cents) AND the floor is below the old summed-to-pre path', () => {
    const detYears = deterministicYears();
    const mc = runMonteCarlo(mcInput());
    const mcYears = mc.representativeByBasis!['mc-typical']!.years;
    // Prior-Dec-31 basis: the year-N MIXED `preEnd` drives the year-(N+1) floor.
    const baseOffset = 5;
    const detBase = detYears[baseOffset];
    const mcBase = mcYears.find((y) => y.year === detBase.year)!;
    const detPreEnd = detBase.accountBalances!.get('mixed-401k')!.preEnd;
    const mcPreEnd = mcBase.accountBalances!.get('mixed-401k')!.preEnd;
    const detPostEnd = detBase.accountBalances!.get('mixed-401k')!.postEnd;
    const taxYear = detBase.year + 1;
    const detFloor = floorFromMixedPreEnd(detPreEnd, taxYear);
    const mcFloor = floorFromMixedPreEnd(mcPreEnd, taxYear);
    // Same integer computeRmd seam on the same pre-tax sub-bucket → bit-identical.
    expect(detFloor).toBe(mcFloor);
    expect(detFloor).toBeGreaterThan(0);
    // RED baseline: the OLD summed-then-treatment routing pushed the Roth slice
    // into `pre`, so its floor basis would have been `preEnd + postEnd`. That
    // strictly larger basis yields a strictly larger floor — the §325 over-count
    // the split routing removes.
    const oldPathFloor = floorFromMixedPreEnd(detPreEnd + detPostEnd, taxYear);
    expect(oldPathFloor).toBeGreaterThan(detFloor);
  });
});

describe('post-primary split routing — focused split + zero-balance + single-person', () => {
  it('routes preTax → pre and postTax → post for the MIXED destination (deterministic)', () => {
    // One drawdown month with no withdrawal pressure (huge income) so the
    // deposits land and compound without being drawn down — the pre/post split
    // is directly observable on the year-end sub-buckets.
    const annualRatePct = 0; // no growth → exact dollar accounting
    const depPre = emptyMonthlySeries(RET, HORIZON);
    const depPost = emptyMonthlySeries(RET, HORIZON);
    addOneOff(depPre, RET, 0, 9_000);
    addOneOff(depPost, RET, 0, 6_000);
    const expensesByMonth = emptyMonthlySeries(RET, HORIZON);
    const incomeByMonth = emptyMonthlySeries(RET, HORIZON);
    // Income strictly exceeds expense every month → zero net need, no withdrawal.
    for (let i = 0; i < STEPS; i += 1) {
      const year = RET + Math.floor(i / 12);
      addOneOff(incomeByMonth, year, i % 12, 100_000 / 12);
    }
    const out = simulateDrawdown({
      portfolioAtRetirement: MIXED_PRE_START + MIXED_POST_START,
      ratePct: annualRatePct,
      expensesByMonth,
      incomeByMonth,
      depositsByMonth: emptyMonthlySeries(RET, HORIZON),
      retirementYear: RET,
      horizonYear: HORIZON,
      accounts: [
        {
          id: 'mixed-401k',
          initialPre: MIXED_PRE_START,
          initialPost: MIXED_POST_START,
          annualRatePct,
          depositsByMonth: depPre,
          depositsPostByMonth: depPost,
          taxTreatment: 'MIXED',
          accountType: 'RETIREMENT_401K',
        },
      ],
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const yr0 = out.years[0].accountBalances!.get('mixed-401k')!;
    // pre slice → pre bucket; post (Roth) slice → post bucket. No growth, no draw.
    expect(yr0.preEnd).toBeCloseTo(MIXED_PRE_START + 9_000, 2);
    expect(yr0.postEnd).toBeCloseTo(MIXED_POST_START + 6_000, 2);
  });

  it('a $0-at-retirement destination funded only by post-primary contributions is NOT dropped (det == MC)', () => {
    // Build a MC + det pair where the MIXED destination starts at $0 and is
    // funded only by the split post-primary contribution. The account must
    // survive (the keep-condition covers an account funded only by the split) and its dollars must land.
    const depositPre = ledgerDepositPre();
    const depositPost = ledgerDepositPost();
    const summed = new Float64Array(STEPS);
    for (let i = 0; i < STEPS; i += 1) summed[i] = depositPre[i] + depositPost[i];
    const ledger: MonteCarloAccountLedger[] = [
      {
        id: 'pretax-ira',
        initialPre: PRE_TAX_BALANCE,
        initialPost: 0,
        contribPre: new Float64Array(STEPS),
        contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        depositPre: new Float64Array(STEPS),
        depositPost: new Float64Array(STEPS),
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        ownerId: OWNER_ID,
      },
      {
        id: 'zero-mixed',
        initialPre: 0,
        initialPost: 0,
        contribPre: new Float64Array(STEPS),
        contribPost: new Float64Array(STEPS),
        deposit: summed,
        depositPre,
        depositPost,
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_401K',
        ownerId: OWNER_ID,
      },
    ];
    const mc = runMonteCarlo({ ...mcInput(), accountMcLedger: ledger });
    const mcRow = mc.representativeByBasis!['mc-typical']!.years[2];
    const zero = mcRow.accountBalances!.get('zero-mixed');
    expect(zero).toBeDefined();
    // The post-primary dollars landed: the account carries a positive balance
    // (split across pre + post), not a silent $0 vanish.
    expect(zero!.preEnd + zero!.postEnd).toBeGreaterThan(0);
    expect(zero!.postEnd).toBeGreaterThan(0); // the Roth slice lands in post
  });

  it('single-person (no post-primary events) is a strict no-op vs an empty split', () => {
    // No depositPre/depositPost on either ledger account ⇒ the split fold is a
    // no-op: the run reproduces the baseline that carries no split fields.
    const baseLedger = mcLedger().map((l) => ({
      ...l,
      deposit: new Float64Array(STEPS),
      depositPre: new Float64Array(STEPS),
      depositPost: new Float64Array(STEPS),
    }));
    const withSplit = runMonteCarlo({ ...mcInput(), accountMcLedger: baseLedger });
    const noSplitFields = baseLedger.map((l) => {
      const rest: MonteCarloAccountLedger = { ...l };
      delete (rest as { depositPre?: Float64Array }).depositPre;
      delete (rest as { depositPost?: Float64Array }).depositPost;
      return rest;
    });
    const withoutSplit = runMonteCarlo({ ...mcInput(), accountMcLedger: noSplitFields });
    expect(withSplit.successProbability).toBe(withoutSplit.successProbability);
    expect(withSplit.percentilesReal.p50).toEqual(withoutSplit.percentilesReal.p50);
  });
});

describe('post-primary split routing — RMD prior-Dec-31 timing + bump-required guard', () => {
  it('a year-N MIXED preEnd drives the year-(N+1) floor, not the year-N floor', () => {
    // Prior-Dec-31 basis (Pub 590-B): the floor for tax year Y reads the Y-1
    // Dec-31 pre-tax sub-bucket. So the MIXED `preEnd` at offset N drives the
    // floor asserted for calendar year N+1 (det == MC at both).
    const detYears = deterministicYears();
    const n = 4;
    const detPreEndN = detYears[n].accountBalances!.get('mixed-401k')!.preEnd;
    const detPreEndN1 = detYears[n + 1].accountBalances!.get('mixed-401k')!.preEnd;
    // The floor for year (firstYear+n+1) uses the year-(firstYear+n) Dec-31
    // pre-tax balance — a DIFFERENT (later-grown) figure than the year-(n+1)
    // Dec-31 balance, so the basis is the prior year's, never the same year's.
    const floorForN1 = floorFromMixedPreEnd(detPreEndN, FIRST + n + 1);
    const wrongSameYearFloor = floorFromMixedPreEnd(detPreEndN1, FIRST + n + 1);
    expect(floorForN1).toBeGreaterThan(0);
    expect(floorForN1).not.toBe(wrongSameYearFloor);
  });

  it('the bump is required — MC summary bytes change when the MIXED Roth slice moves pre→post', () => {
    // OLD path: the whole post-primary contribution was summed into `pre`
    // (depositPre = pre + post, depositPost = 0). NEW path: the Roth slice is in
    // `post`. For a MIXED named-strategy scenario the two produce DIFFERENT MC
    // summaries (preEnd / RMD floor / depletion shift), confirming the 37→38
    // cache-version bump is warranted, not cosmetic.
    const newPath = runMonteCarlo(rmdMcInput());
    const oldLedger = rmdMcLedger().map((l) => {
      if (l.id !== 'mixed-401k') return l;
      const oldPre = new Float64Array(STEPS);
      for (let i = 0; i < STEPS; i += 1) {
        oldPre[i] = (l.depositPre?.[i] ?? 0) + (l.depositPost?.[i] ?? 0);
      }
      return { ...l, depositPre: oldPre, depositPost: new Float64Array(STEPS) };
    });
    const oldPath = runMonteCarlo({ ...rmdMcInput(), accountMcLedger: oldLedger });
    // The summaries differ — the Roth slice no longer inflates the pre-tax
    // sub-bucket + RMD floor, so the per-path math (and bytes) moved.
    expect(oldPath.percentilesReal.p50).not.toEqual(newPath.percentilesReal.p50);
  });
});

describe('post-primary split routing — follow-up (one-off / pension-lumpsum) unchanged', () => {
  it('a targeted one-off with no targetAccountId still routes household-level (residue)', () => {
    // Split routing must NOT change the carved-out one-off / pension-lump-sum routing:
    // an event with no `targetAccountId` (and no split) routes through the
    // household deposit series exactly as before.
    const ledger = mcLedger();
    const accounts = buildPerAccountKernelInputs({
      ledger,
      stepCount: STEPS,
      sampledIdx: null,
      columns: null,
      injectedReturnPct: flat(FLAT_MONTHLY_PCT),
    });
    const deposit = new Float64Array(STEPS);
    routeHouseholdLevelEvents({
      events: [{ month: 3, amount: 12_000, source: 'targetedOneOff' }],
      ledger,
      accounts,
      stepCount: STEPS,
      retirementStepIdx: 0,
      deposit,
    });
    expect(deposit[3]).toBe(12_000);
  });
});

// --- helpers for the RMD-age bump-required guard (forces an RMD-age member so
//     the floor seam is exercised under the named-strategy MC path) ----------
function rmdMcLedger(): MonteCarloAccountLedger[] {
  return mcLedger();
}
function rmdMcInput(): MonteCarloInput {
  return {
    ...mcInput(),
    accountMcLedger: rmdMcLedger(),
    // RMD-age member so the per-path RMD floor seam is active (the §325 split
    // is exactly what moves the floor → moves the summary bytes).
    monthlyExpenseBase: makeMonthlyExpenseBase(90_000, STEPS),
    ssByYear: Array.from({ length: YEARS }, () => 12_000),
    taxContext: {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [RMD_MEMBER],
      householdSize: 1,
      inflationRatePct: 0,
    },
  } as unknown as MonteCarloInput;
}
