/**
 * Unit tests for the RMD floor + QCD forced-outflow pass in
 * drawdown-engine-per-account-qcd-hsa.ts.
 *
 * Focus: the per-owner RMD floor basis tracks only the drawable pre-tax pocket,
 * the FORCED withdrawal resolves recorded RMD facts through the shared
 * fact-aware engine (still-working deferral, inherited beneficiary schedule,
 * first-year deferral + catch-up, withheld results), and the 70½-gated QCD forced
 * outflow debits the source IRA and offsets only the owner's IRA-pool RMD floor
 * (IRC §408(d)(8), SECURE 2.0 §325).
 */
import { describe, it, expect } from 'vitest';
import {
  applyQcdPrePass,
  buildPerOwnerRmdFloor,
} from './drawdown-engine-per-account-qcd-hsa';
import type { AccountRunState } from './drawdown-engine-per-account-strategy-helpers';
import { RMD_DIVISORS } from './rmd-divisors';
import { computeRmd, type RmdAccountProfileFacts } from './rmd';
import type { QcdContextInput, RmdContextInput } from './drawdown-engine-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  overrides: Partial<AccountRunState> & {
    id: string;
    taxTreatment: AccountRunState['taxTreatment'];
    accountType: string;
  },
): AccountRunState {
  return {
    pre: 0,
    post: 0,
    annualRatePct: 0,
    monthlyRate: 0,
    deposits: new Float64Array(0),
    depositsPost: new Float64Array(0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPerOwnerRmdFloor — RMD basis = drawable pre-tax pocket only
// ---------------------------------------------------------------------------

/** Single-owner RMD context whose owner is past the trigger age in `taxYear`. */
function rmdContextFor(
  accountIds: ReadonlyArray<string>,
  isoBirthdate = '1957-06-15',
): RmdContextInput {
  const ownerByAccountId = new Map<string, string>();
  for (const id of accountIds) ownerByAccountId.set(id, 'owner-1');
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>([
    ['owner-1', { isoBirthdate, deathYear: 9999 }],
  ]);
  return { ownerByAccountId, ownerMeta, rmdSnapshot: RMD_DIVISORS };
}

describe('buildPerOwnerRmdFloor — required-withdrawal floor tracks only what can be withdrawn', () => {
  // Owner born 1957 → age 73 in 2030 → trigger fires; divisor 26.5.
  const taxYear = 2030;
  const divisor = 26.5;

  it('does not raise a required-withdrawal floor on after-tax dollars a retirement account cannot draw', () => {
    // A qualifying PRE_TAX IRA with $0 pre-tax and a large after-tax balance
    // must produce a $0 floor — forced RMD can only draw `pre`.
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 0, post: 500_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const floors = buildPerOwnerRmdFloor({ taxYear, state, rmdContext: rmdContextFor(['ira']) });
    expect(floors[0]).toBe(0);
  });

  it('builds a pre-tax account floor from its pre-tax pocket, not the combined balance', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 100_000, post: 400_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const floors = buildPerOwnerRmdFloor({ taxYear, state, rmdContext: rmdContextFor(['ira']) });
    // Floor = pre / divisor, NOT (pre + post) / divisor.
    expect(floors[0]).toBeCloseTo(100_000 / divisor, 0);
    expect(floors[0]).toBeLessThan(500_000 / divisor);
  });

  it('builds a mixed account floor from its pre-tax pocket only (Roth slice excluded)', () => {
    // Unconditional MIXED basis: a qualifying MIXED account with both
    // pockets yields a floor on `pre` only — the post (designated-Roth) slice
    // is subtracted, independent of how the MIXED branch is implemented.
    const state: AccountRunState[] = [
      makeState({ id: 'mix', pre: 120_000, post: 80_000, taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' }),
    ];
    const floors = buildPerOwnerRmdFloor({ taxYear, state, rmdContext: rmdContextFor(['mix']) });
    expect(floors[0]).toBeCloseTo(120_000 / divisor, 0);
    expect(floors[0]).toBeLessThan(200_000 / divisor);
  });
});

// ---------------------------------------------------------------------------
// buildPerOwnerRmdFloor — fact-based rules reach the FORCED withdrawal, not
// just the tax floor / disclosures
// ---------------------------------------------------------------------------

describe('buildPerOwnerRmdFloor — the forced withdrawal honours recorded RMD facts', () => {
  // Owner born 1957 → age 73 in 2030 → trigger fires; Uniform Lifetime divisor 26.5.
  const taxYear = 2030;
  const divisor = 26.5;

  /** An inherited traditional IRA with complete beneficiary facts: a spouse who
   *  elected lifetime withdrawals, original owner died before their start date. */
  const INHERITED_FACTS: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: 'SPOUSE',
    beneficiaryElection: 'LIFE_EXPECTANCY',
    inheritedOwnerDeathDate: '2023-04-02',
    inheritedOwnerDiedOnOrAfterRbd: false,
    beneficiaryBirthdate: '1951-03-10',
    originalOwnerBirthdate: '1949-01-05',
  };

  /** §401(a)(9)(C) still-working preconditions all affirmatively met. */
  const STILL_WORKING_FACTS: RmdAccountProfileFacts = {
    currentEmployerPlan: true,
    fivePercentOwner: false,
    planRequiresDistributionAtStatutoryAge: false,
  };

  function contextWithFacts(args: {
    readonly accountIds: ReadonlyArray<string>;
    readonly facts: Readonly<Record<string, RmdAccountProfileFacts>>;
    readonly retirementYear?: number;
    readonly isoBirthdate?: string;
  }): RmdContextInput {
    return {
      ...rmdContextFor(args.accountIds, args.isoBirthdate),
      rmdFactsByAccountId: args.facts,
      ...(args.retirementYear !== undefined
        ? { retirementYearByOwner: { 'owner-1': args.retirementYear } }
        : {}),
    };
  }

  it('does not force a withdrawal from a plan the still-working exception postpones', () => {
    // The disclosure surface tells the user "no withdrawal is required yet because
    // you are still working"; the money-moving pass must agree.
    const state: AccountRunState[] = [
      makeState({ id: 'plan', pre: 300_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K' }),
    ];
    const floors = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({
        accountIds: ['plan'],
        facts: { plan: STILL_WORKING_FACTS },
        // Separation is still ahead of the tax year → the exception defers.
        retirementYear: taxYear + 5,
      }),
    });
    expect(floors[0]).toBe(0);
  });

  it('forces the ordinary withdrawal from the same plan once the owner has separated', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'plan', pre: 300_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K' }),
    ];
    const floors = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({
        accountIds: ['plan'],
        facts: { plan: STILL_WORKING_FACTS },
        retirementYear: taxYear - 1,
      }),
    });
    expect(floors[0]).toBeCloseTo(300_000 / divisor, 0);
  });

  it('forces an inherited account BELOW the beneficiary’s own trigger age', () => {
    // A beneficiary obligation is never gated by the beneficiary's own trigger
    // age. Pre-fix this returned $0 forever while the shortfall flag measured
    // against a real Table I requirement the model refused to take.
    const state: AccountRunState[] = [
      makeState({ id: 'inh', pre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const floors = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({
        accountIds: ['inh'],
        facts: { inh: INHERITED_FACTS },
        // Born 1980 → age 50 in 2030, far below any trigger age.
        isoBirthdate: '1980-05-04',
      }),
    });
    expect(floors[0]).toBeGreaterThan(0);
  });

  it('agrees exactly with the shared engine on the inherited beneficiary schedule', () => {
    // Not the Uniform Lifetime divisor: the inherited account must resolve through
    // the SAME `computeRmd` the tax floor and the report disclosures resolve.
    const state: AccountRunState[] = [
      makeState({ id: 'inh', pre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const floors = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({ accountIds: ['inh'], facts: { inh: INHERITED_FACTS } }),
    });
    const direct = computeRmd(
      {
        isoBirthdate: '1957-06-15',
        taxYear,
        accounts: [
          {
            id: 'inh',
            balanceDec31PriorYearCents: 200_000_00,
            accountType: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
            facts: INHERITED_FACTS,
          },
        ],
      },
      RMD_DIVISORS,
    );
    expect(Math.round(floors[0] * 100)).toBe(direct.perAccountRmdCents.inh);
    expect(floors[0]).not.toBeCloseTo(200_000 / divisor, 0);
  });

  it('withholds ($0) an inherited account whose required facts are incomplete', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'inh', pre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const floors = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({
        accountIds: ['inh'],
        // No beneficiary category / death date / on-or-after-RBD flag.
        facts: { inh: { inheritedAccount: true } },
      }),
    });
    expect(floors[0]).toBe(0);
  });

  it('forces $0 from an inherited pure-Roth account whichever pocket holds the balance', () => {
    // `isQualifyingAccount` rejects the pure Roth types (a living Roth owner has no
    // RMD) while `isInheritedRmdSubjectType` admits them, because a BENEFICIARY does
    // owe post-death distributions. The DISCLOSED LIMITATION is that such an account
    // still forces $0: its whole balance IS the SECURE 2.0 §325 Roth-designated
    // pocket, so its §325-net base is $0 — and the forced pass can debit only `pre`
    // anyway. That holds whichever bucket the run happens to hold the
    // balance in, so no surface of one run can read a different base for the same
    // account (a `pre`-side artifact used to produce a real forced floor here while
    // the display surfaces read $0). Pinned so the behaviour is a recorded decision
    // rather than an accident.
    const forPockets = (pre: number, post: number): number =>
      buildPerOwnerRmdFloor({
        taxYear,
        state: [
          makeState({
            id: 'inh-roth',
            pre,
            post,
            taxTreatment: 'ROTH',
            accountType: 'RETIREMENT_ROTH_401K',
          }),
        ],
        rmdContext: contextWithFacts({
          accountIds: ['inh-roth'],
          facts: { 'inh-roth': INHERITED_FACTS },
        }),
      })[0];
    expect(forPockets(0, 90_000)).toBe(0);
    expect(forPockets(90_000, 0)).toBe(0);
  });

  it('cannot force an inherited Roth IRA balance that sits entirely in the after-tax pocket', () => {
    const state: AccountRunState[] = [
      makeState({
        id: 'inh-roth',
        pre: 0,
        post: 90_000,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
      }),
    ];
    const floors = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({
        accountIds: ['inh-roth'],
        facts: { 'inh-roth': INHERITED_FACTS },
      }),
    });
    expect(floors[0]).toBe(0);
  });

  it('sizes a deferred first-year catch-up from the balance two years earlier', () => {
    // Owner born 1957 attains 73 in 2030 (their first RMD year) and elected the
    // April-1 deferral, so 2031 carries TWO required withdrawals: 2031's own plus
    // the 2030 amount, sized on Dec 31 2029 — the caller's two-years-prior base.
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdContext = contextWithFacts({
      accountIds: ['ira'],
      facts: { ira: { firstYearDeferralElected: true } },
    });
    const withoutBase = buildPerOwnerRmdFloor({ taxYear: 2031, state, rmdContext });
    const withBase = buildPerOwnerRmdFloor({
      taxYear: 2031,
      state,
      rmdContext,
      twoYearsPriorDollars: [{ pre: 265_000, post: 0 }],
    });
    // Without the base the catch-up is a blocker, never guessed.
    expect(withBase[0]).toBeGreaterThan(withoutBase[0]);
    // $265,000 / 26.5 = exactly $10,000 of catch-up on top of 2031's own amount.
    expect(withBase[0] - withoutBase[0]).toBeCloseTo(10_000, 0);
  });

  it('defers the first year itself rather than forcing a withdrawal', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const floors = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({
        accountIds: ['ira'],
        facts: { ira: { firstYearDeferralElected: true } },
      }),
    });
    expect(floors[0]).toBe(0);
  });

  it('keeps a fact-free account on the legacy Uniform Lifetime result', () => {
    // The one guarantee the frozen parity fixtures rest on: recording facts on ONE
    // account must not move a sibling that records none.
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({ id: 'inh', pre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const withFacts = buildPerOwnerRmdFloor({
      taxYear,
      state,
      rmdContext: contextWithFacts({
        accountIds: ['ira', 'inh'],
        facts: { inh: INHERITED_FACTS },
      }),
    });
    expect(withFacts[0]).toBeCloseTo(200_000 / divisor, 0);
  });
});

// ---------------------------------------------------------------------------
// applyQcdPrePass — 70½-gated QCD forced outflow + IRA-pool offset
// ---------------------------------------------------------------------------

/** QCD context for one owner with a single source IRA, $50k/yr REAL, window
 *  2028..2034 exclusive, owner 70½-eligible from 2026 (born 1955). */
function qcdContextFor(args: {
  sourceAccountId: string;
  annualAmountDollars?: number;
  firstEligibleYear?: number;
  startYear?: number;
  endYear?: number;
  inflationFactor?: number;
  limitDollars?: number;
}): QcdContextInput {
  return {
    entries: [
      {
        memberId: 'owner-1',
        sourceAccountId: args.sourceAccountId,
        annualAmountDollars: args.annualAmountDollars ?? 50_000,
        startYear: args.startYear ?? 2028,
        endYear: args.endYear ?? 2034,
      },
    ],
    firstEligibleYearByOwner: new Map([['owner-1', args.firstEligibleYear ?? 2026]]),
    inflationFactorForYear: () => args.inflationFactor ?? 1,
    qcdLimitCentsForYear: () => Math.round((args.limitDollars ?? 111_000) * 100),
  };
}

describe('applyQcdPrePass — QCD forced outflow + IRA-pool RMD offset', () => {
  const taxYear = 2030;

  it('debits the gift from the source IRA pre-tax bucket and offsets only the IRA-pool floor', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({ id: 'k401', pre: 300_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K' }),
    ];
    const rmdFloor = [18_000, 12_000]; // dollars
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      qcdContext: qcdContextFor({ sourceAccountId: 'ira' }),
      ownerByAccountId: new Map([['ira', 'owner-1'], ['k401', 'owner-1']]),
      taxYear,
    });
    // Q = min(50k inflated, 111k limit, 500k balance) = $50,000.
    expect(result.totalQcdCents).toBe(5_000_000);
    // Offset = min(Q, gross IRA-pool RMD = $18k) = $18,000.
    expect(result.rmdOffsetCents).toBe(1_800_000);
    expect(result.grossIraPoolRmdCents).toBe(1_800_000);
    // The IRA floor is fully offset to 0; the 401k floor is untouched.
    expect(rmdFloor[0]).toBe(0);
    expect(rmdFloor[1]).toBe(12_000);
    // The gift left the source IRA's pre-tax bucket.
    expect(state[0].pre).toBe(450_000);
    expect(state[1].pre).toBe(300_000);
  });

  it('returns the EXACT inflation factor it used, so qcdCents ÷ factor round-trips to the configured REAL amount (display-anchor fix)', () => {
    // A $10,000 REAL gift inflated by a year-average factor of 1.25 → $12,500
    // nominal. The pass surfaces that exact factor so the today's-dollars display
    // can divide it back out to the configured $10,000 (NOT the year-end deflator,
    // which would under-state the gift).
    const factor = 1.25;
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdFloor = [0];
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      qcdContext: qcdContextFor({
        sourceAccountId: 'ira',
        annualAmountDollars: 10_000,
        inflationFactor: factor,
      }),
      ownerByAccountId: new Map([['ira', 'owner-1']]),
      taxYear,
    });
    // Nominal qcdCents = round(10_000 × 1.25 × 100) = 1_250_000.
    expect(result.totalQcdCents).toBe(1_250_000);
    // The pass exposes the EXACT factor it inflated with.
    expect(result.inflationFactor).toBe(factor);
    // Round-trip: nominal ÷ factor === the configured REAL amount.
    expect(result.totalQcdCents / 100 / result.inflationFactor).toBeCloseTo(10_000, 6);
  });

  it('reports inflationFactor = 1 in a no-QCD (inactive-window) year', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: [0],
      // Window 2028..2034 exclusive; 2027 is inactive → no entries grouped.
      qcdContext: qcdContextFor({ sourceAccountId: 'ira', inflationFactor: 1.4 }),
      ownerByAccountId: new Map([['ira', 'owner-1']]),
      taxYear: 2027,
    });
    expect(result.totalQcdCents).toBe(0);
    expect(result.inflationFactor).toBe(1);
  });

  it('caps Q at the source IRA prior-year-end balance (depleted source → Q=0)', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 0, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdFloor = [0];
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      qcdContext: qcdContextFor({ sourceAccountId: 'ira' }),
      ownerByAccountId: new Map([['ira', 'owner-1']]),
      taxYear,
    });
    expect(result.totalQcdCents).toBe(0);
    expect(state[0].pre).toBe(0);
  });

  it('is a no-op before the 70½ first-eligible year', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdFloor = [18_000];
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      qcdContext: qcdContextFor({ sourceAccountId: 'ira', firstEligibleYear: 2031 }),
      ownerByAccountId: new Map([['ira', 'owner-1']]),
      taxYear, // 2030 < 2031
    });
    expect(result.totalQcdCents).toBe(0);
    expect(state[0].pre).toBe(500_000);
    expect(rmdFloor[0]).toBe(18_000);
  });

  it('is a no-op outside the window', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdFloor = [18_000];
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      // Window 2035..2040 — taxYear 2030 is before it.
      qcdContext: qcdContextFor({ sourceAccountId: 'ira', startYear: 2035, endYear: 2040 }),
      ownerByAccountId: new Map([['ira', 'owner-1']]),
      taxYear,
    });
    expect(result.totalQcdCents).toBe(0);
    expect(state[0].pre).toBe(500_000);
  });

  it('a QCD ≤ gross leaves a partial taxable RMD floor (gross − Q)', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdFloor = [40_000]; // gross > Q
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      qcdContext: qcdContextFor({ sourceAccountId: 'ira', annualAmountDollars: 30_000 }),
      ownerByAccountId: new Map([['ira', 'owner-1']]),
      taxYear,
    });
    expect(result.totalQcdCents).toBe(3_000_000);
    expect(result.rmdOffsetCents).toBe(3_000_000); // min(30k, 40k)
    // Remaining taxable RMD floor = gross − Q = $10,000.
    expect(rmdFloor[0]).toBeCloseTo(10_000, 2);
  });

  it('two same-owner IRAs — the offset distributes largest-floor-first, no floor negative', () => {
    // One owner with two RETIREMENT_IRA accounts pooling into one IRA RMD pool.
    // Combined gross IRA-pool RMD = $15k + $5k = $20k. A $30k QCD (≥ gross) fully
    // offsets the pool; the offset is distributed largest-floor-first so no
    // per-account floor goes negative.
    const state: AccountRunState[] = [
      makeState({ id: 'ira-a', pre: 600_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({ id: 'ira-b', pre: 400_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdFloor = [15_000, 5_000]; // largest first = ira-a
    const qcdContext: QcdContextInput = {
      entries: [
        {
          memberId: 'owner-1',
          sourceAccountId: 'ira-a',
          annualAmountDollars: 30_000,
          startYear: 2028,
          endYear: 2034,
        },
      ],
      firstEligibleYearByOwner: new Map([['owner-1', 2026]]),
      inflationFactorForYear: () => 1,
      qcdLimitCentsForYear: () => 111_000 * 100,
    };
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      qcdContext,
      ownerByAccountId: new Map([['ira-a', 'owner-1'], ['ira-b', 'owner-1']]),
      taxYear,
    });
    // Q = $30k; offset = min(30k, gross pool 20k) = $20k.
    expect(result.totalQcdCents).toBe(3_000_000);
    expect(result.grossIraPoolRmdCents).toBe(2_000_000);
    expect(result.rmdOffsetCents).toBe(2_000_000);
    // Per-owner offset is keyed by owner.
    expect(result.rmdOffsetCentsByOwner['owner-1']).toBe(2_000_000);
    // Largest-floor-first: ira-a ($15k) absorbs first, then ira-b ($5k); both → 0,
    // neither goes negative.
    expect(rmdFloor[0]).toBe(0);
    expect(rmdFloor[1]).toBe(0);
    expect(rmdFloor.every((f) => f >= 0)).toBe(true);
  });

  it('two owners — per-person limit + offset computed independently', () => {
    // Each owner has their own source IRA + IRA-pool RMD floor; the per-person
    // §408(d)(8) limit is consumed per owner-year (not shared) and the offset is
    // scoped to each owner's own IRA pool.
    const state: AccountRunState[] = [
      makeState({ id: 'ira-1', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({ id: 'ira-2', pre: 500_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    ];
    const rmdFloor = [18_000, 25_000];
    const qcdContext: QcdContextInput = {
      entries: [
        {
          memberId: 'owner-1',
          sourceAccountId: 'ira-1',
          annualAmountDollars: 30_000,
          startYear: 2028,
          endYear: 2034,
        },
        {
          memberId: 'owner-2',
          sourceAccountId: 'ira-2',
          annualAmountDollars: 40_000,
          startYear: 2028,
          endYear: 2034,
        },
      ],
      firstEligibleYearByOwner: new Map([
        ['owner-1', 2026],
        ['owner-2', 2026],
      ]),
      inflationFactorForYear: () => 1,
      // A $35k per-person limit binds owner-2's $40k entry but not owner-1's $30k.
      qcdLimitCentsForYear: () => 35_000 * 100,
    };
    const result = applyQcdPrePass({
      state,
      rmdFloorByAccountDollars: rmdFloor,
      qcdContext,
      ownerByAccountId: new Map([['ira-1', 'owner-1'], ['ira-2', 'owner-2']]),
      taxYear,
    });
    // owner-1: Q = min(30k, 35k limit, 500k bal) = $30k.
    // owner-2: Q = min(40k, 35k limit, 500k bal) = $35k (limit binds independently).
    expect(result.totalQcdCents).toBe(6_500_000);
    // Offsets scoped to each owner's own IRA pool: owner-1 min(30k,18k)=18k,
    // owner-2 min(35k,25k)=25k.
    expect(result.rmdOffsetCentsByOwner['owner-1']).toBe(1_800_000);
    expect(result.rmdOffsetCentsByOwner['owner-2']).toBe(2_500_000);
    // owner-1 source IRA debited $30k; owner-2 source IRA debited $35k.
    expect(state[0].pre).toBe(470_000);
    expect(state[1].pre).toBe(465_000);
    // Each owner's IRA floor reduced by its own offset only.
    expect(rmdFloor[0]).toBe(0); // 18k − 18k
    expect(rmdFloor[1]).toBe(0); // 25k − 25k
  });
});
