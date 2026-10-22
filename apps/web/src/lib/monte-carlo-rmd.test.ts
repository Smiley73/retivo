import { describe, expect, it } from 'vitest';
import {
  applyMcRmdToRepresentativeYears,
  buildMcFactRmdRequiredCentsByOwnerIdx,
  type McRmdBalanceCents,
} from './monte-carlo-rmd.js';
import { computeRmd, type RmdAccountProfileFacts } from './rmd.js';
import { computeRmdFloorCents } from './tax-integration.js';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';
import type { MonteCarloAccountLedger } from './monte-carlo-types.js';
import type { TaxMemberInput, TaxAccountSnapshot } from './tax-integration-helpers.js';

const RMD_SNAPSHOT = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;

const PRIMARY: TaxMemberInput = {
  memberId: 'owner-a',
  isoBirthdate: '1951-03-10',
  onMedicare: true,
  hasAcaCoverage: false,
};

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
    expect(years[1].rmdShortfallCents).toBe(expectedFloor);
  });

  it('NO-LEAK GUARD: never stamps perAccountRmdCents on the MC representative run', () => {
    // `perAccountRmdCents` is a deterministic-only display field; the MC post-pass must never set it, so it cannot serialize into the MC capture shape (no ENGINE_VERSION bump owed).
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
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
    for (const y of years) {
      expect(y.perAccountRmdCents).toBeUndefined();
    }
  });

  it('derives shortfall per IRS pool so a 401(k) overshoot cannot mask a sibling 401(k) miss', () => {
    // 401(k)s do not aggregate (each is its own IRS pool), so A's overshoot cannot cover B's miss; household netting would report $0.
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

    const floor = years[1].rmdFloorCents!;
    const shortfall = years[1].rmdShortfallCents!;
    expect(shortfall).toBeGreaterThan(0);
    expect(shortfall).toBeCloseTo(floor / 2, -1);
    expect(floor - shortfall).toBeGreaterThan(0);
  });

  it('forgives an uneven IRA-pair draw when the owner IRA pool is satisfied', () => {
    // The IRS pools one owner's IRAs: one IRA satisfying the whole pool minimum forgives the sibling's $0 draw.
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

    expect(years[1].rmdFloorCents!).toBeGreaterThan(0);
    expect(years[1].rmdShortfallCents).toBe(0);
  });

  it('credits the QCD IRA-pool offset so a QCD-satisfied RMD shows no phantom shortfall', () => {
    // The QCD is debited structurally (not a recorded withdrawal), so without the credit the whole floor would surface as a phantom shortfall; mirrors the deterministic engine's `qcdOffsetCents`.
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
        accountBalances: new Map([['ira', acctYear(pre, 0)]]),
        ...(qcdOffsetCents !== undefined
          ? { qcdRmdOffsetCentsByOwner: { 'owner-a': qcdOffsetCents } }
          : {}),
      },
    ];

    const grossYears = mkYears(undefined);
    applyMcRmdToRepresentativeYears({
      years: grossYears,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    const floorCents = grossYears[1].rmdFloorCents!;
    expect(floorCents).toBeGreaterThan(0);
    expect(grossYears[1].rmdShortfallCents).toBe(floorCents);

    const years = mkYears(floorCents);
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [ledgerEntryTyped('ira', 'owner-a', pre, 'RETIREMENT_IRA')],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });
    expect(years[1].rmdFloorCents).toBe(floorCents); // floor is GROSS (display)
    expect(years[1].rmdShortfallCents).toBe(0); // QCD satisfied it → no phantom

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
    // A traditional IRA (the offset target) and a 401(k) singleton pool: the IRA offset must not cover the 401(k)'s miss.
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
        accountBalances: new Map([
          ['ira', acctYear(pre, 0)],
          ['k401', acctYear(pre, 0)],
        ]),
      },
    ];

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
    const totalFloorCents = years[1].rmdFloorCents!;
    expect(years[1].rmdShortfallCents).toBe(totalFloorCents - iraFloorCents);
    expect(years[1].rmdShortfallCents!).toBeGreaterThan(0);
  });

  it('pools only the MIXED pre-tax tranche (preWithdrawnCents) within its 403(b) pool', () => {
    // Pre-tax and MIXED 403(b) of one owner form one pool; only the MIXED account's pre-tax tranche (preWithdrawnCents) counts toward it, and the pre-tax overshoot covers the pool.
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
        ledgerEntryTyped('mix403', 'owner-a', pre, 'RETIREMENT_403B', 'MIXED'),
      ],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
    });

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
    expect(years[0].rmdFloorCents).toBeGreaterThan(0);
    expect(years[1].rmdFloorCents).toBe(0);
  });

  it('uses the current row preEnd for the first drawdown year after accumulation rows', () => {
    // Two accumulation rows precede the first drawdown row, whose RMD base is its own preEnd (the entering balance), not 0.
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
    // A no-tax-context run threads RMD data through `mcRmdContext` and calls the post-pass directly.
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
    // Withdrawal is $30k but only $10k is pre-tax (preWithdrawnCents): without the fix the gross $30k satisfies the ≈$18.5k floor, with it only $10k counts and a shortfall remains.
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
    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
    expect(years[1].rmdShortfallCents).toBeDefined();
    expect((years[1].rmdShortfallCents ?? 0)).toBeGreaterThan(0);
  });

  it('skips strictly-post-depletion rows but floors the depletion year itself', () => {
    // The absorbing-depletion clamp zeroes `balance` from the depletion year on but leaves per-account `preEnd` stale; without the depletionYear gate the post-pass stamps a phantom floor on strictly-post-depletion years, while the depletion year itself still floors from the prior row.
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

    expect(years[1].rmdFloorCents).toBeGreaterThan(0);
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

describe('applyMcRmdToRepresentativeYears — QCD display', () => {
  it('scopes netTaxableRmdCents to the IRA pool only — a 401(k)/TSP RMD is excluded', () => {
    // A QCD offsets only the IRA RMD, so `netTaxableRmdCents` is the IRA-pool floor minus the offset, not the all-plan `rmdFloorCents` minus it (the 401(k) RMD is excluded);
    // the RMD chart's own floor and shortfall stay all-plan.
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
    expect(allPlanFloor).toBeGreaterThan(iraFloorCents);
    expect(years[1].netTaxableRmdCents).toBe(iraFloorCents - qcdCents);
    expect(years[1].netTaxableRmdCents).not.toBe(allPlanFloor - qcdCents);
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

describe('buildMcFactRmdRequiredCentsByOwnerIdx', () => {
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
    const direct = computeRmd(
      {
        isoBirthdate: PRIMARY.isoBirthdate,
        taxYear: 2030,
        accounts: [
          {
            id: 'inh-ira',
            balanceDec31PriorYearCents: 200_000_00,
            accountType: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
            facts: INHERITED_FACTS,
          },
        ],
      },
      RMD_SNAPSHOT,
    );
    expect(idx[0]).toBe(direct.ownerRmdCents);
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
    const required = (entry: MonteCarloAccountLedger, prior: McRmdBalanceCents): number =>
      buildMcFactRmdRequiredCentsByOwnerIdx({
        ledger: [entry],
        ownerIds: [PRIMARY.memberId],
        members: [PRIMARY],
        rmdSnapshot: RMD_SNAPSHOT,
        taxYear: 2030,
        priorBalancesCents: new Map([[entry.id, prior]]),
        rmdFactsByAccountId: { [entry.id]: INHERITED_FACTS },
      })[0];
    const mixed = required(
      ledgerEntryTyped('acct', PRIMARY.memberId, 60_000, 'RETIREMENT_401K', 'MIXED', 40_000),
      { preCents: 60_000_00, postCents: 40_000_00 },
    );
    const preTaxOnly = required(
      ledgerEntryTyped('acct', PRIMARY.memberId, 60_000, 'RETIREMENT_401K'),
      { preCents: 60_000_00, postCents: 0 },
    );
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBe(preTaxOnly);
  });

  it('nets the §325 Roth pocket out of a MIXED account’s first-year-deferral catch-up base', () => {
    // Born 1951 → trigger year 2024, so 2025 is the catch-up year, sized from the Dec-31-two-years-prior balance.
    const facts: RmdAccountProfileFacts = {
      firstYearDeferralElected: true,
      currentEmployerPlan: false,
      fivePercentOwner: false,
      planRequiresDistributionAtStatutoryAge: false,
    };
    const required = (entry: MonteCarloAccountLedger, slice: McRmdBalanceCents): number =>
      buildMcFactRmdRequiredCentsByOwnerIdx({
        ledger: [entry],
        ownerIds: [PRIMARY.memberId],
        members: [PRIMARY],
        rmdSnapshot: RMD_SNAPSHOT,
        taxYear: 2025,
        priorBalancesCents: new Map([[entry.id, slice]]),
        twoYearsPriorBalancesCents: new Map([[entry.id, slice]]),
        rmdFactsByAccountId: { [entry.id]: facts },
      })[0];
    const mixed = required(
      ledgerEntryTyped('acct', PRIMARY.memberId, 60_000, 'RETIREMENT_401K', 'MIXED', 40_000),
      { preCents: 60_000_00, postCents: 40_000_00 },
    );
    const preTaxOnly = required(
      ledgerEntryTyped('acct', PRIMARY.memberId, 60_000, 'RETIREMENT_401K'),
      { preCents: 60_000_00, postCents: 0 },
    );
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBe(preTaxOnly);
  });
});

describe('RMD base — the §325 Roth pocket nets out for every treatment', () => {
  const INHERITED: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: 'SPOUSE',
    beneficiaryElection: 'LIFE_EXPECTANCY',
    inheritedOwnerDeathDate: '2023-04-02',
    inheritedOwnerDiedOnOrAfterRbd: false,
    beneficiaryBirthdate: '1951-03-10',
    originalOwnerBirthdate: '1949-01-05',
  };

  // postCents is deliberately non-zero: the funded pass and the representative post-pass must read the account's real {pre, post} buckets alike,
  // and a producer that zeroed it would hide the disagreement.
  const fundedRequiredCents = (entry: MonteCarloAccountLedger, prior: McRmdBalanceCents): number =>
    buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: [entry],
      ownerIds: [PRIMARY.memberId],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      taxYear: 2030,
      priorBalancesCents: new Map([[entry.id, prior]]),
      rmdFactsByAccountId: { [entry.id]: INHERITED },
    })[0];

  const representativeFloorCents = (
    entry: MonteCarloAccountLedger,
    prior: McRmdBalanceCents,
    facts?: RmdAccountProfileFacts,
  ): number => {
    const preEnd = prior.preCents / 100;
    const postEnd = prior.postCents / 100;
    const row = (year: number): DrawdownYear => ({
      year,
      balance: preEnd + postEnd,
      withdrawn: 0,
      netNeed: 0,
      growth: 0,
      deposit: 0,
      depleted: false,
      accountBalances: new Map([
        [entry.id, { balance: preEnd + postEnd, preEnd, postEnd, withdrawn: 0, deposit: 0 }],
      ]),
    });
    const years = [row(2029), row(2030)];
    applyMcRmdToRepresentativeYears({
      years,
      ledger: [entry],
      members: [PRIMARY],
      rmdSnapshot: RMD_SNAPSHOT,
      ...(facts !== undefined ? { rmdFactsByAccountId: { [entry.id]: facts } } : {}),
    });
    return years[1].rmdFloorCents!;
  };

  it.each([
    ['RETIREMENT_ROTH_IRA' as const, 'ROTH' as const],
    ['RETIREMENT_ROTH_401K' as const, 'ROTH' as const],
    ['RETIREMENT_401K' as const, 'POST_TAX' as const],
  ])(
    'an inherited %s (%s) contributes a zero base on both surfaces, never its Roth balance as ordinary income',
    (accountType, taxTreatment) => {
      const entry = ledgerEntryTyped('inh-roth', PRIMARY.memberId, 0, accountType, taxTreatment, 300_000);
      const prior = { preCents: 0, postCents: 300_000_00 };
      expect(fundedRequiredCents(entry, prior)).toBe(0);
      expect(representativeFloorCents(entry, prior, INHERITED)).toBe(0);
    },
  );

  it('a pure-Roth base is $0 even when the producer omits the Roth portion', () => {
    // A POST_TAX / ROTH account holds no pre-tax dollars by definition, so omitting the Roth portion lands on the same base.
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

  it('the representative post-pass and the funded pass agree on an inherited MIXED base', () => {
    const entry = ledgerEntryTyped('mixed', PRIMARY.memberId, 150_000, 'RETIREMENT_401K', 'MIXED', 50_000);
    const prior = { preCents: 150_000_00, postCents: 50_000_00 };
    const funded = fundedRequiredCents(entry, prior);
    expect(representativeFloorCents(entry, prior, INHERITED)).toBe(funded);
    // It is the PRE-TAX slice that drives it, not the whole balance.
    expect(funded).toBeGreaterThan(0);
    expect(funded).toBeLessThan(200_000_00);
  });
});
