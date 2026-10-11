import { describe, expect, it } from 'vitest';
import {
  applyMcRmdToRepresentativeYears,
  buildMcFactRmdRequiredCentsByOwnerIdx,
  buildMcRmdAccountInput,
} from './monte-carlo-rmd.js';
import { computeRmd, type RmdAccountProfileFacts } from './rmd.js';
import { computeRmdFloorCents } from './tax-integration.js';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';
import type { MonteCarloAccountLedger } from './monte-carlo-types.js';
import type { TaxMemberInput, TaxAccountSnapshot } from './tax-integration-helpers.js';

const RMD_SNAPSHOT = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;

/** Member born 1951 → RMD trigger age 73; RMD-age for any year ≥ 2024. */
const PRIMARY: TaxMemberInput = {
  memberId: 'owner-a',
  isoBirthdate: '1951-03-10',
  onMedicare: true,
  hasAcaCoverage: false,
};

/** One pre-tax 401(k) ledger entry owned by `owner`. */
function ledgerEntry(
  id: string,
  owner: string,
  initialPre: number,
): MonteCarloAccountLedger {
  return {
    id,
    initialPre,
    initialPost: 0,
    contribPre: new Float64Array(0),
    contribPost: new Float64Array(0),
    deposit: new Float64Array(0),
    assetMix: null,
    assetMixSeries: null,
    cbpPlanningReturnPct: null,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_401K',
    ownerId: owner,
  };
}

/** Ledger entry with an explicit account type + tax treatment (for the
 *  IRS-pooling cases — `ledgerEntry` is pre-tax-401(k)-only). */
function ledgerEntryTyped(
  id: string,
  owner: string,
  initialPre: number,
  accountType: MonteCarloAccountLedger['accountType'],
  taxTreatment: MonteCarloAccountLedger['taxTreatment'] = 'PRE_TAX',
  initialPost = 0,
): MonteCarloAccountLedger {
  return {
    ...ledgerEntry(id, owner, initialPre),
    initialPost,
    accountType,
    taxTreatment,
  };
}

/** Per-account drawdown row with the given pre-tax end balance + withdrawal. */
function acctYear(
  preEnd: number,
  withdrawnDollars: number,
): DrawdownAccountYear {
  return {
    balance: preEnd,
    preEnd,
    postEnd: 0,
    withdrawn: withdrawnDollars,
    deposit: 0,
  };
}

describe('applyMcRmdToRepresentativeYears', () => {
  it('floor matches computeRmdFloorCents for a hand-crafted single-owner snapshot', () => {
    // Year 2046 floor uses the PRIOR year (2045) preEnd as the divisor base.
    // Build two years: 2045 (the base) + 2046 (the asserted floor year).
    const priorPre = 1_000_000;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: priorPre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(priorPre, 0)]]),
      },
      {
        year: 2046,
        balance: priorPre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(priorPre, 0)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', priorPre)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });

    // The deterministic engine's floor for the same prior-year pre-tax balance.
    const snapshot: TaxAccountSnapshot = {
      id: 'k401',
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      ownerId: 'owner-a',
      balancePriorYearDollars: priorPre,
      withdrawalDollars: 0,
    };
    const expectedFloor = computeRmdFloorCents([PRIMARY], [snapshot], 2046, RMD_SNAPSHOT);

    expect(years[1].rmdFloorCents).toBe(expectedFloor);
    expect(expectedFloor).toBeGreaterThan(0);
    // No withdrawal → the whole floor is a shortfall.
    expect(years[1].rmdShortfallCents).toBe(expectedFloor);
  });

  it('NO-LEAK GUARD: never stamps perAccountRmdCents on the MC representative run', () => {
    // `perAccountRmdCents` is a DETERMINISTIC-ONLY display field (deterministic
    // tax post-pass). The MC RMD post-pass — the only RMD stamping on the MC
    // representative-run path that feeds captureStrategyRun / the MC cache —
    // must NEVER set it, so it can't serialize into the MC capture shape and no
    // ENGINE_VERSION bump / fixture re-pin is owed.
    const priorPre = 1_000_000;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: priorPre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(priorPre, 0)]]),
      },
      {
        year: 2046,
        balance: priorPre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(priorPre, 0)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', priorPre)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    // RMD applies (floor > 0) yet the per-account display field stays absent.
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
    for (const y of years) {
      expect(y.perAccountRmdCents).toBeUndefined();
    }
  });

  it('derives shortfall per IRS pool so a 401(k) overshoot cannot mask a sibling 401(k) miss', () => {
    // Two 401(k)s, same owner. 401(k)s do NOT aggregate — each is its own
    // singleton IRS pool — so account A overshooting its minimum cannot cover
    // account B's miss. Household netting (total withdrawn ≥ total floor) would
    // report $0; the per-POOL sum must still surface B's full shortfall. (Under
    // the IRS-aggregation pooling this stays a real miss precisely because the
    // two singleton pools never cross-cover — contrast the IRA-pair case below.)
    const pre = 500_000;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['A', acctYear(pre, 0)],
          ['B', acctYear(pre, 0)],
        ]),
      },
      {
        year: 2046,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        // A overshoots hugely; B withdraws nothing.
        accountBalances: new Map([
          ['A', acctYear(pre, 100_000)],
          ['B', acctYear(pre, 0)],
        ]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('A', 'owner-a', pre), ledgerEntry('B', 'owner-a', pre)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });

    // Equal balances → each account's required minimum is half the owner floor
    // (within 1-cent proportional rounding). B withdraws nothing, so the
    // shortfall is B's required minimum ≈ half the floor — NOT $0 (household
    // netting would report $0 because A's $100k overshoot covers the total).
    const floor = years[1].rmdFloorCents!;
    const shortfall = years[1].rmdShortfallCents!;
    expect(shortfall).toBeGreaterThan(0);
    expect(shortfall).toBeCloseTo(floor / 2, -1);
    // A's met portion is positive (the overshoot is NOT credited to B).
    expect(floor - shortfall).toBeGreaterThan(0);
  });

  it('forgives an uneven IRA-pair draw when the owner IRA pool is satisfied', () => {
    // Two traditional IRAs, same owner. The IRS pools all of one owner's IRAs:
    // one IRA satisfying the whole pool minimum forgives the sibling's $0 draw.
    const pre = 500_000;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['A', acctYear(pre, 0)],
          ['B', acctYear(pre, 0)],
        ]),
      },
      {
        year: 2046,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        // A alone draws far past the WHOLE owner IRA-pool minimum (~$112k at
        // this age); B draws $0.
        accountBalances: new Map([
          ['A', acctYear(pre, 150_000)],
          ['B', acctYear(pre, 0)],
        ]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [
        ledgerEntryTyped('A', 'owner-a', pre, 'RETIREMENT_IRA'),
        ledgerEntryTyped('B', 'owner-a', pre, 'RETIREMENT_IRA'),
      ],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });

    // Pool satisfied from A → NO shortfall (the strict per-account rule would
    // have flagged B's full share). Floor unchanged (no money moved).
    expect(years[1].rmdFloorCents!).toBeGreaterThan(0);
    expect(years[1].rmdShortfallCents).toBe(0);
  });

  it('credits the QCD IRA-pool offset so a QCD-satisfied RMD shows no phantom shortfall', () => {
    // A single traditional IRA whose entire RMD is satisfied by a QCD. The QCD is
    // debited STRUCTURALLY (the gift leaves the IRA but is NOT a recorded
    // withdrawal), so without the QCD credit `poolWithdrawn` would be $0 and the
    // whole floor would surface as a PHANTOM shortfall. Mirrors the deterministic
    // engine (the tax runner credits `qcdOffsetCents`).
    const pre = 1_000_000;
    const mkYears = (qcdOffsetCents: number | undefined): DrawdownYear[] => [
      {
        year: 2045,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
      },
      {
        year: 2046,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        // $0 RECORDED withdrawal — the QCD satisfied the RMD structurally.
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
        ...(qcdOffsetCents !== undefined
          ? { qcdRmdOffsetCentsByOwner: { 'owner-a': qcdOffsetCents } }
          : {}),
      },
    ];

    // First derive the gross floor (no offset) to size a full-coverage QCD.
    const grossYears = mkYears(undefined);
    applyMcRmdToRepresentativeYears({
      years: grossYears,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    const floorCents = grossYears[1].rmdFloorCents!;
    expect(floorCents).toBeGreaterThan(0);
    // Without a credit the whole floor is a phantom shortfall.
    expect(grossYears[1].rmdShortfallCents).toBe(floorCents);

    // Now run with a QCD offset that covers the WHOLE floor → no shortfall.
    const years = mkYears(floorCents);
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(years[1].rmdFloorCents).toBe(floorCents); // floor is GROSS (display)
    expect(years[1].rmdShortfallCents).toBe(0); // QCD satisfied it → no phantom

    // A PARTIAL QCD leaves the uncovered remainder as a real shortfall.
    const partial = Math.floor(floorCents / 3);
    const partialYears = mkYears(partial);
    applyMcRmdToRepresentativeYears({
      years: partialYears,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(partialYears[1].rmdShortfallCents).toBe(floorCents - partial);
  });

  it('the QCD offset credits ONLY the owner IRA pool — a cross-pool / cross-owner miss still surfaces', () => {
    // Owner A: traditional IRA (offset target) + a 401(k) singleton pool (NOT an
    // IRA → the IRA offset must NOT cover its miss). The QCD covers A's
    // entire IRA RMD but the 401(k) RMD goes undrawn → a REAL shortfall remains.
    const pre = 1_000_000;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['ira', acctYear(pre, 0)],
          ['k401', acctYear(pre, 0)],
        ]),
      },
      {
        year: 2046,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        // Both RMDs undrawn; only the IRA pool carries a QCD offset.
        accountBalances: new Map([
          ['ira', acctYear(pre, 0)],
          ['k401', acctYear(pre, 0)],
        ]),
      },
    ];

    // Size the IRA-only and 401(k)-only floors via single-account runs.
    const iraOnly = [
      { ...years[0], accountBalances: new Map([['ira', acctYear(pre, 0)]]) },
      { ...years[1], accountBalances: new Map([['ira', acctYear(pre, 0)]]) },
    ];
    applyMcRmdToRepresentativeYears({
      years: iraOnly,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    const iraFloorCents = iraOnly[1].rmdFloorCents!;
    expect(iraFloorCents).toBeGreaterThan(0);

    // QCD exactly covers the IRA pool; the 401(k) pool gets NO credit.
    years[1].qcdRmdOffsetCentsByOwner = { 'owner-a': iraFloorCents };
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [
        ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA'),
        ledgerEntryTyped('k401', 'owner-a', pre, 'RETIREMENT_401K'),
      ],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    // The 401(k) singleton-pool RMD is undrawn + uncovered → a real shortfall
    // equal to total floor − IRA floor (the IRA portion the QCD satisfied).
    const totalFloorCents = years[1].rmdFloorCents!;
    expect(years[1].rmdShortfallCents).toBe(totalFloorCents - iraFloorCents);
    expect(years[1].rmdShortfallCents!).toBeGreaterThan(0);
  });

  it('pools only the MIXED pre-tax tranche (preWithdrawnCents) within its 403(b) pool', () => {
    // Pre-tax 403(b) + MIXED 403(b), same owner → one 403(b) pool. The MIXED
    // account's pre-tax tranche is preWithdrawnCents (its big total withdrawal is
    // mostly post-tax). The MIXED account itself misses its pre-tax share, but
    // the pre-tax 403(b) overshoots enough to cover the whole pool → no shortfall.
    const pre = 500_000;
    const mixRow: DrawdownAccountYear = {
      ...acctYear(pre, 80_000), // $80k total withdrawn...
      preWithdrawnCents: 0, // ...but $0 of it is pre-tax (all Roth-designated).
    };
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['pre403', acctYear(pre, 0)],
          ['mix403', acctYear(pre, 0)],
        ]),
      },
      {
        year: 2046,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['pre403', acctYear(pre, 150_000)], // pre-tax overshoot covers the pool
          ['mix403', mixRow], // $0 pre-tax tranche
        ]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [
        ledgerEntryTyped('pre403', 'owner-a', pre, 'RETIREMENT_403B'),
        // MIXED with a post bucket; only the pre tranche counts toward the pool.
        ledgerEntryTyped('mix403', 'owner-a', pre, 'RETIREMENT_403B', 'MIXED'),
      ],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });

    // The pre-tax 403(b) overshoot satisfies the whole 403(b) pool; the MIXED
    // account's $0 pre-tax tranche does NOT add a shortfall (pooled). And the
    // MIXED post-tax dollars never count toward pool-withdrawn.
    expect(years[1].rmdFloorCents!).toBeGreaterThan(0);
    expect(years[1].rmdShortfallCents).toBe(0);
  });

  it('uses the ledger initialPre for the first simulated year (offset 0)', () => {
    const initialPre = 800_000;
    const years: DrawdownYear[] = [
      {
        year: 2046,
        balance: initialPre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(initialPre, 0)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', initialPre)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    const expectedFloor = computeRmdFloorCents(
      [PRIMARY],
      [
        {
          id: 'k401',
          type: 'RETIREMENT_401K',
          taxTreatment: 'PRE_TAX',
          ownerId: 'owner-a',
          balancePriorYearDollars: initialPre,
          withdrawalDollars: 0,
        },
      ],
      2046,
      RMD_SNAPSHOT,
    );
    expect(years[0].rmdFloorCents).toBe(expectedFloor);
  });

  it('skips a member after their projected death year', () => {
    const pre = 1_000_000;
    const mkYear = (year: number): DrawdownYear => ({
      year,
      balance: pre,
      withdrawn: 0,
      netNeed: 0,
      growth: 0,
      deposit: 0,
      depleted: false,
      accountBalances: new Map([['k401', acctYear(pre, 0)]]),
    });
    const years = [mkYear(2046), mkYear(2047)];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', pre)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      primaryDeathYear: 2046,
    });
    // 2046 is alive (floor > 0); 2047 is after death → floor 0.
    expect(years[0].rmdFloorCents).toBeGreaterThan(0);
    expect(years[1].rmdFloorCents).toBe(0);
  });

  it('uses the current row preEnd for the first drawdown year after accumulation rows', () => {
    // Plan: firstYear 2024, retirementYear 2026 → two pre-retirement
    // accumulation rows (no accountBalances) before the first drawdown row.
    // The first drawdown year's RMD base is its OWN preEnd (the entering
    // drawdown balance = Dec 31 of the last accumulation year), NOT 0.
    const ACCUM_OWNER: TaxMemberInput = {
      memberId: 'owner-a',
      isoBirthdate: '1950-06-15', // age 74+ in 2026 → RMD-eligible
      onMedicare: true,
      hasAcaCoverage: false,
    };
    const initialPre = 300_000;
    const firstDrawdownPre = 310_000;
    const accumRow = (year: number): DrawdownYear => ({
      year,
      balance: initialPre,
      withdrawn: 0,
      netNeed: 0,
      growth: 0,
      deposit: 0,
      depleted: false,
      // No accountBalances — accumulation-phase row.
    });
    const years: DrawdownYear[] = [
      accumRow(2024),
      accumRow(2025),
      {
        year: 2026,
        balance: firstDrawdownPre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(firstDrawdownPre, 0)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', initialPre)],
      members: [ACCUM_OWNER],
      rmdSnapshot: RMD_SNAPSHOT,
    });

    // The deterministic floor for the entering drawdown balance (310k), the
    // base the first drawdown year must use (NOT 0 from the absent prior map).
    const expectedFloor = computeRmdFloorCents(
      [ACCUM_OWNER],
      [
        {
          id: 'k401',
          type: 'RETIREMENT_401K',
          taxTreatment: 'PRE_TAX',
          ownerId: 'owner-a',
          balancePriorYearDollars: firstDrawdownPre,
          withdrawalDollars: 0,
        },
      ],
      2026,
      RMD_SNAPSHOT,
    );
    expect(years[2].rmdFloorCents).toBeGreaterThan(0);
    expect(years[2].rmdFloorCents).toBe(expectedFloor);
  });

  it('populates rmdFloorCents for a no-tax-context representative run', () => {
    // A no-tax-context run threads RMD data via `mcRmdContext` and calls this
    // post-pass directly. A representative-run-
    // style years array (drawdown rows with accountBalances) must still get a
    // positive floor on its drawdown rows.
    const pre = 750_000;
    const years: DrawdownYear[] = [
      {
        year: 2046,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(pre, 0)]]),
      },
      {
        year: 2047,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(pre, 0)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', pre)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(years[0].rmdFloorCents).toBeGreaterThan(0);
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
  });

  it('MIXED 401k representative row: counts only preWithdrawnCents toward rmdShortfallCents', () => {
    // The kernel populates preWithdrawnCents on MIXED accounts.
    // This test verifies that applyMcRmdToRepresentativeYears (via the shared
    // rmdEligibleWithdrawnCents helper) counts only the pre-tax tranche.
    //
    // Setup: MIXED 401k, $500k pre, RMD-age owner. Two years so year[1] uses
    // year[0].preEnd as the divisor base. Withdrawal = $30k total, but only
    // $10k is pre-tax (preWithdrawnCents = 1_000_000). The RMD floor will
    // exceed $10k (floor on $500k at ~3.7% factor ≈ $18.5k). Without the fix
    // the gross $30k satisfies the floor; with the fix only $10k counts →
    // rmdShortfallCents > 0.
    const pre = 500_000;
    const totalWithdrawn = 30_000;
    const preWithdrawnCents = 1_000_000; // $10k

    function mixedYear(withdrawn: number): DrawdownAccountYear {
      return {
        balance: pre,
        preEnd: pre,
        postEnd: 0,
        withdrawn,
        deposit: 0,
        preWithdrawnCents,
      };
    }

    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['mix401k', mixedYear(0)]]),
      },
      {
        year: 2046,
        balance: pre,
        withdrawn: totalWithdrawn,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['mix401k', mixedYear(totalWithdrawn)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntryTyped('mix401k', 'owner-a', pre, 'RETIREMENT_401K', 'MIXED', 0)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    // Floor should be set (pre-tax balance is non-zero, owner is RMD-age).
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
    // Only $10k (1_000_000 cents) counts toward the floor; the floor is ≈$18.5k.
    // Shortfall = floor − 1_000_000 > 0.
    expect(years[1].rmdShortfallCents).toBeDefined();
    expect((years[1].rmdShortfallCents ?? 0)).toBeGreaterThan(0);
  });

  it('skips strictly-post-depletion rows but floors the depletion year itself', () => {
    // The absorbing-depletion clamp zeroes `DrawdownYear.balance` on the
    // depletion year and every later year, but leaves the per-account
    // `accountBalances.preEnd` STALE (non-zero) on those clamped rows. Without
    // the depletionYear gate the post-pass reads those stale `preEnd` values and
    // stamps a PHANTOM RMD floor on strictly-post-depletion years. Build three
    // drawdown rows:
    //   A (2045): real prior-year base ($100k pre-tax preEnd).
    //   B (2046): the DEPLETION year — `balance: 0` but stale `preEnd` $100k.
    //             Its floor uses A's prior preEnd, so it MUST still be > 0.
    //   C (2047): STRICTLY post-depletion (`year > depletionYear`) — stale
    //             `preEnd` $100k. It MUST be skipped (no phantom floor stamped).
    const stalePre = 100_000;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: stalePre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['k401', acctYear(stalePre, 0)]]),
      },
      {
        year: 2046,
        balance: 0, // depletion year — clamp zeroed the row balance...
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: true,
        // ...but the per-account preEnd is left STALE (non-zero) by the clamp.
        accountBalances: new Map([['k401', acctYear(stalePre, 0)]]),
      },
      {
        year: 2047,
        balance: 0, // strictly post-depletion — also clamped to 0...
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: true,
        // ...with the same STALE preEnd that would yield a phantom floor.
        accountBalances: new Map([['k401', acctYear(stalePre, 0)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', stalePre)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      depletionYear: 2046,
    });

    // Depletion year (B) still carries a real floor from year A's prior preEnd.
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
    // Strictly-post-depletion year (C) is skipped — no phantom floor from the
    // stale preEnd. Its RMD fields stay untouched (absent).
    expect(years[2].rmdFloorCents).toBeUndefined();
    expect(years[2].rmdShortfallCents).toBeUndefined();
  });

  it('leaves rmd fields untouched on pre-retirement rows (no accountBalances)', () => {
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: 500_000,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        // No accountBalances — accumulation-phase row.
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntry('k401', 'owner-a', 500_000)],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(years[0].rmdFloorCents).toBeUndefined();
    expect(years[0].rmdShortfallCents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// QCD display — the post-pass re-derives `netTaxableRmdCents`
// from the IRA-POOL-ONLY gross floor (`iraPoolRmdFloorCents`) and the
// strategy-stamped `qcdCents` / `qcdRmdOffsetCentsByOwner`, matching the field's
// doc + the deterministic engine. Employer-plan RMDs are excluded.
// ---------------------------------------------------------------------------
describe('applyMcRmdToRepresentativeYears — QCD display', () => {
  it('re-derives netTaxableRmdCents = floor − offset on a QCD drawdown year', () => {
    const pre = 1_000_000;
    const qcdCents = 20_000_00;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
      },
      {
        year: 2046,
        balance: pre,
        withdrawn: qcdCents / 100,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', acctYear(pre, qcdCents / 100)]]),
        // Stamped by the strategy replay's QCD pre-pass (the per-path math).
        qcdCents,
        qcdRmdOffsetCentsByOwner: { 'owner-a': qcdCents },
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    const floor = years[1].rmdFloorCents!;
    expect(floor).toBeGreaterThan(0);
    // IRA-only scenario → the IRA-pool floor equals `rmdFloorCents`, so the QCD
    // counts toward the floor → net taxable RMD = floor − offset.
    expect(years[1].qcdCents).toBe(qcdCents);
    expect(years[1].netTaxableRmdCents).toBe(floor - qcdCents);
  });

  it('scopes netTaxableRmdCents to the IRA pool only — a 401(k)/TSP RMD is excluded', () => {
    // Owner A: a traditional IRA (the QCD target) PLUS a 401(k) singleton pool.
    // The gross ALL-PLAN floor (`rmdFloorCents`) folds in both, but a QCD offsets
    // only the IRA RMD, so `netTaxableRmdCents` must be `iraPoolFloor − offset`
    // (employer-plan RMD excluded), NOT `rmdFloorCents − offset`.
    // Assert `rmdFloorCents`/`rmdShortfallCents` (the RMD chart's fields) are the
    // all-plan values and unchanged by the QCD scoping.
    const pre = 1_000_000;
    const qcdCents = 20_000_00;
    const mkYears = (): DrawdownYear[] => [
      {
        year: 2045,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['ira', acctYear(pre, 0)],
          ['k401', acctYear(pre, 0)],
        ]),
      },
      {
        year: 2046,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['ira', acctYear(pre, 0)],
          ['k401', acctYear(pre, 0)],
        ]),
      },
    ];
    const ledger = [
      ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA'),
      ledgerEntryTyped('k401', 'owner-a', pre, 'RETIREMENT_401K'),
    ];

    // First derive the IRA-only floor via a single-account run.
    const iraOnly = [
      { ...mkYears()[0], accountBalances: new Map([['ira', acctYear(pre, 0)]]) },
      { ...mkYears()[1], accountBalances: new Map([['ira', acctYear(pre, 0)]]) },
    ];
    applyMcRmdToRepresentativeYears({
      years: iraOnly,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    const iraFloorCents = iraOnly[1].rmdFloorCents!;
    expect(iraFloorCents).toBeGreaterThan(0);

    // Now the combined IRA + 401(k) run with a QCD offset on the IRA pool.
    const years = mkYears();
    years[1].qcdCents = qcdCents;
    years[1].qcdRmdOffsetCentsByOwner = { 'owner-a': qcdCents };
    applyMcRmdToRepresentativeYears({
      years,
      ledger,
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    const allPlanFloor = years[1].rmdFloorCents!;
    // The all-plan floor is strictly larger than the IRA-only floor (it folds in
    // the 401(k) RMD) — proving the two bases genuinely diverge here.
    expect(allPlanFloor).toBeGreaterThan(iraFloorCents);
    // Net taxable is IRA-pool-only: `iraPoolFloor − offset`, NOT `allPlan − offset`.
    expect(years[1].netTaxableRmdCents).toBe(iraFloorCents - qcdCents);
    expect(years[1].netTaxableRmdCents).not.toBe(allPlanFloor - qcdCents);
    // The RMD chart's own fields stay ALL-PLAN and untouched by the QCD scoping:
    // the floor is the gross all-plan floor; the whole all-plan floor is undrawn
    // and only the IRA slice carries the QCD credit → shortfall = allPlan − iraOffset.
    expect(years[1].rmdShortfallCents).toBe(allPlanFloor - qcdCents);
  });

  it('clamps netTaxableRmdCents at 0 when the QCD ≥ the gross floor', () => {
    const pre = 1_000_000;
    const hugeQcd = 99_999_999_00;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
      },
      {
        year: 2046,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
        qcdCents: hugeQcd,
        qcdRmdOffsetCentsByOwner: { 'owner-a': hugeQcd },
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
    expect(years[1].netTaxableRmdCents).toBe(0);
  });

  it('does NOT stamp netTaxableRmdCents on a year with no QCD (qcdCents absent)', () => {
    const pre = 1_000_000;
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
      },
      {
        year: 2046,
        balance: pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
    expect(years[1].netTaxableRmdCents).toBeUndefined();
  });

  it('does NOT stamp QCD fields on accumulation rows (no accountBalances)', () => {
    const years: DrawdownYear[] = [
      {
        year: 2045,
        balance: 500_000,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        // No accountBalances — accumulation-phase row; even a stray qcdCents is
        // never processed (the phase discriminator skips the row).
        qcdCents: 10_000_00,
      },
    ];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntryTyped('ira', 'owner-a', 500_000, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(years[0].rmdFloorCents).toBeUndefined();
    expect(years[0].netTaxableRmdCents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The FUNDED per-path fact-based required-withdrawal pass. It runs the
// SAME shared `computeRmd` engine the representative display floor and the
// deterministic engine run, so the funded numbers cannot silently drop an
// inherited beneficiary schedule / Table II divisor / deferral.
// ---------------------------------------------------------------------------

describe('buildMcFactRmdRequiredCentsByOwnerIdx', () => {
  /** An inherited traditional IRA with complete beneficiary facts: a spouse who
   *  elected lifetime withdrawals, owner died before their start date. */
  const INHERITED_FACTS: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: 'SPOUSE',
    beneficiaryElection: 'LIFE_EXPECTANCY',
    inheritedOwnerDeathDate: '2023-04-02',
    inheritedOwnerDiedOnOrAfterRbd: false,
    beneficiaryBirthdate: '1951-03-10',
    originalOwnerBirthdate: '1949-01-05',
  };

  const balances = (id: string, preCents: number, postCents = 0) =>
    new Map([[id, { preCents, postCents }]]);

  it('runs an inherited account through the shared engine (agreeing with computeRmd exactly)', () => {
    const idx = buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: [ledgerEntryTyped('inh-ira', PRIMARY.memberId, 200_000, 'RETIREMENT_IRA')],
      ownerIds: [PRIMARY.memberId],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      taxYear: 2030,
      priorBalancesCents: balances('inh-ira', 200_000_00),
      rmdFactsByAccountId: { 'inh-ira': INHERITED_FACTS },
    });
    // The SAME shared engine, called directly, must produce the same cents — this
    // is the funded-vs-representative agreement the fix is about.
    const direct = computeRmd(
      {
        isoBirthdate: PRIMARY.isoBirthdate,
        taxYear: 2030,
        accounts: [
          buildMcRmdAccountInput({
            id: 'inh-ira',
            accountType: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
            prior: { preCents: 200_000_00, postCents: 0 },
            facts: INHERITED_FACTS,
          }),
        ],
      },
      RMD_SNAPSHOT,
    );
    expect(idx[0]).toBe(direct.ownerRmdCents);
    // A real beneficiary minimum, not $0 — merely EXCLUDING this account from
    // the pooled owner floor would require nothing at all.
    expect(idx[0]).toBeGreaterThan(0);
  });

  it('withholds ($0) an inherited account whose beneficiary facts are incomplete', () => {
    const idx = buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: [ledgerEntryTyped('inh-ira', PRIMARY.memberId, 200_000, 'RETIREMENT_IRA')],
      ownerIds: [PRIMARY.memberId],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      taxYear: 2030,
      priorBalancesCents: balances('inh-ira', 200_000_00),
      rmdFactsByAccountId: { 'inh-ira': { inheritedAccount: true } },
    });
    expect(idx[0]).toBe(0);
  });

  it('requires $0 from a still-working plan before separation and a real minimum after', () => {
    const facts: RmdAccountProfileFacts = {
      currentEmployerPlan: true,
      fivePercentOwner: false,
      planRequiresDistributionAtStatutoryAge: false,
    };
    const forYear = (taxYear: number): number =>
      buildMcFactRmdRequiredCentsByOwnerIdx({
        ledger: [ledgerEntry('plan', PRIMARY.memberId, 200_000)],
        ownerIds: [PRIMARY.memberId],
        members: [PRIMARY],
        rmdSnapshot: RMD_SNAPSHOT,
        taxYear,
        priorBalancesCents: balances('plan', 200_000_00),
        rmdFactsByAccountId: { plan: facts },
        retirementYearByOwner: { [PRIMARY.memberId]: 2031 },
      })[0];
    expect(forYear(2030)).toBe(0); // still employed → deferred
    expect(forYear(2031)).toBeGreaterThan(0); // separation year → due
    expect(forYear(2032)).toBeGreaterThan(0); // and every later year
  });

  it('skips accounts with no recorded facts (they stay in the pooled owner basis)', () => {
    const idx = buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: [ledgerEntry('plain', PRIMARY.memberId, 200_000)],
      ownerIds: [PRIMARY.memberId],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      taxYear: 2030,
      priorBalancesCents: balances('plain', 200_000_00),
      rmdFactsByAccountId: {},
    });
    expect(idx[0]).toBe(0);
  });

  it('nets the §325 Roth-designated portion out of a MIXED account’s base', () => {
    const input = buildMcRmdAccountInput({
      id: 'mixed',
      accountType: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      prior: { preCents: 60_000_00, postCents: 40_000_00 },
      twoYearsPrior: { preCents: 50_000_00, postCents: 30_000_00 },
    });
    // The FULL balance goes in, with the Roth-designated portion alongside it, so
    // the engine's shared resolvers net it out (§325) identically on both bases.
    expect(input.balanceDec31PriorYearCents).toBe(100_000_00);
    expect(input.rothPortionCents).toBe(40_000_00);
    expect(input.balanceDec31TwoYearsPriorCents).toBe(80_000_00);
    expect(input.rothPortionTwoYearsPriorCents).toBe(30_000_00);
  });
});

// ---------------------------------------------------------------------------
// ONE RMD-base convention for every producer.
//
// Two independent producers build the funded path's `McRmdBalanceCents` and a
// third builds the representative path's. They must all pass the account's
// real sub-buckets through unchanged: if the representative producer zeroed
// `postCents` for every non-MIXED account while the funded ones passed it
// through, a fact-carrying INHERITED account whose balance is entirely Roth (an
// inherited Roth IRA, or a pure designated-Roth employer plan: `preEnd === 0`)
// would have its whole Roth balance summed into the funded RMD base and grossed
// up as ORDINARY INCOME through `preTaxForTax = max(withdrawal, floor)`.
//
// NOTE the deliberate NON-ZERO `postCents` in every case below: the
// `balances()` helper defaults it to 0, which would hide that disagreement.
// ---------------------------------------------------------------------------

describe('RMD base — the §325 Roth pocket nets out for every treatment', () => {
  /** An inherited account with complete beneficiary facts (spouse, lifetime
   *  withdrawals, owner died before their required beginning date). */
  const INHERITED: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: 'SPOUSE',
    beneficiaryElection: 'LIFE_EXPECTANCY',
    inheritedOwnerDeathDate: '2023-04-02',
    inheritedOwnerDiedOnOrAfterRbd: false,
    beneficiaryBirthdate: '1951-03-10',
    originalOwnerBirthdate: '1949-01-05',
  };

  it.each([
    ['RETIREMENT_ROTH_IRA' as const, 'ROTH' as const],
    ['RETIREMENT_ROTH_401K' as const, 'ROTH' as const],
    ['RETIREMENT_401K' as const, 'POST_TAX' as const],
  ])(
    'an inherited %s (%s) contributes a zero base, never its Roth balance as ordinary income',
    (accountType, taxTreatment) => {
      const input = buildMcRmdAccountInput({
        id: 'inh-roth',
        accountType,
        taxTreatment,
        // The whole balance lives in `post` — the real shape for a pure Roth
        // account (`splitInitialByTaxTreatment` seeds it entirely post).
        prior: { preCents: 0, postCents: 300_000_00 },
        twoYearsPrior: { preCents: 0, postCents: 250_000_00 },
        facts: INHERITED,
      });
      expect(input.balanceDec31PriorYearCents).toBe(300_000_00);
      expect(input.rothPortionCents).toBe(300_000_00);
      expect(input.rothPortionTwoYearsPriorCents).toBe(250_000_00);
      // Through the shared engine the base nets to zero, so the owner's required
      // amount — the figure that grosses up taxable ordinary income on the funded
      // path — carries nothing from this Roth balance.
      const result = computeRmd(
        { isoBirthdate: PRIMARY.isoBirthdate, taxYear: 2030, accounts: [input] },
        RMD_SNAPSHOT,
      );
      expect(result.perAccountRmdCents['inh-roth'] ?? 0).toBe(0);
      expect(result.ownerRmdCents).toBe(0);
    },
  );

  it('the funded per-owner total for an inherited all-Roth account is $0, not its balance', () => {
    const idx = buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: [
        ledgerEntryTyped(
          'inh-roth',
          PRIMARY.memberId,
          0,
          'RETIREMENT_ROTH_IRA',
          'ROTH',
          300_000,
        ),
      ],
      ownerIds: [PRIMARY.memberId],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      taxYear: 2030,
      // Non-zero POST balance — the whole point of the case.
      priorBalancesCents: new Map([['inh-roth', { preCents: 0, postCents: 300_000_00 }]]),
      rmdFactsByAccountId: { 'inh-roth': INHERITED },
    });
    expect(idx[0]).toBe(0);
  });

  it('a pure-Roth base is $0 even when the producer omits the Roth portion', () => {
    // Caller-independence: a producer that passes the balance WITHOUT spelling the
    // Roth pocket out still lands on the same base, because a POST_TAX / ROTH
    // account holds no pre-tax dollars by definition.
    const result = computeRmd(
      {
        isoBirthdate: PRIMARY.isoBirthdate,
        taxYear: 2030,
        accounts: [
          {
            id: 'inh-roth',
            balanceDec31PriorYearCents: 300_000_00,
            accountType: 'RETIREMENT_ROTH_IRA',
            taxTreatment: 'ROTH',
            facts: INHERITED,
          },
        ],
      },
      RMD_SNAPSHOT,
    );
    expect(result.ownerRmdCents).toBe(0);
  });

  it('a PRE_TAX account with a post artifact still uses its whole pre-tax balance', () => {
    // Guard the other direction: the uniform convention must not start netting a
    // pre-tax account's (artifact) post bucket out of a real RMD base.
    const input = buildMcRmdAccountInput({
      id: 'pretax',
      accountType: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      prior: { preCents: 400_000_00, postCents: 0 },
    });
    expect(input.rothPortionCents).toBeUndefined();
    const result = computeRmd(
      { isoBirthdate: PRIMARY.isoBirthdate, taxYear: 2030, accounts: [input] },
      RMD_SNAPSHOT,
    );
    expect(result.perAccountRmdCents['pretax']).toBeGreaterThan(0);
  });

  it('the representative post-pass and the funded pass agree on an inherited MIXED base', () => {
    // Both surfaces are fed the SAME `{pre, post}` semantics now, so the same
    // account resolves to the same base whichever producer assembled it.
    const prior = { preCents: 150_000_00, postCents: 50_000_00 };
    const funded = buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: [
        ledgerEntryTyped('mixed', PRIMARY.memberId, 150_000, 'RETIREMENT_401K', 'MIXED', 50_000),
      ],
      ownerIds: [PRIMARY.memberId],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      taxYear: 2030,
      priorBalancesCents: new Map([['mixed', prior]]),
      rmdFactsByAccountId: { mixed: INHERITED },
    })[0];
    const representative = computeRmd(
      {
        isoBirthdate: PRIMARY.isoBirthdate,
        taxYear: 2030,
        accounts: [
          buildMcRmdAccountInput({
            id: 'mixed',
            accountType: 'RETIREMENT_401K',
            taxTreatment: 'MIXED',
            prior,
            facts: INHERITED,
          }),
        ],
      },
      RMD_SNAPSHOT,
    ).ownerRmdCents;
    expect(funded).toBe(representative);
    // …and it is the PRE-TAX slice that drives it, not the whole balance.
    expect(funded).toBeGreaterThan(0);
    expect(funded).toBeLessThan(200_000_00);
  });
});
