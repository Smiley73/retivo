import { describe, it, expect } from 'vitest';
import {
  buildGuidanceYearRows,
  indexForYear,
  type GuidanceAccountMeta,
} from './withdrawal-guidance-data';
import type { DrawdownYear, DrawdownAccountYear } from '../lib/drawdown-engine-types';

function accBal(balance: number, withdrawn: number): DrawdownAccountYear {
  return { balance, preEnd: 0, postEnd: balance, withdrawn, deposit: 0 };
}

function mixedBal(
  balance: number,
  withdrawn: number,
  preWithdrawnCents?: number,
): DrawdownAccountYear {
  return {
    balance,
    preEnd: 0,
    postEnd: balance,
    withdrawn,
    deposit: 0,
    ...(preWithdrawnCents !== undefined ? { preWithdrawnCents } : {}),
  };
}

function baseYear(year: number, overrides: Partial<DrawdownYear> = {}): DrawdownYear {
  return {
    year,
    balance: 500_000,
    withdrawn: 0,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    ...overrides,
  };
}

const ACCOUNTS = new Map<string, GuidanceAccountMeta>([
  ['ira1', { id: 'ira1', name: 'IRA One', type: 'RETIREMENT_IRA', ownerId: 'owner-a', taxTreatment: 'PRE_TAX' }],
  ['ira2', { id: 'ira2', name: 'IRA Two', type: 'RETIREMENT_IRA', ownerId: 'owner-a', taxTreatment: 'PRE_TAX' }],
  ['roth', { id: 'roth', name: 'Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownerId: 'owner-a', taxTreatment: 'ROTH' }],
]);

describe('buildGuidanceYearRows — row mapping', () => {
  it('maps gross withdrawal + ending balance per account from accountBalances', () => {
    const years: DrawdownYear[] = [
      baseYear(2030, {
        withdrawn: 30_000,
        accountBalances: new Map([
          ['ira1', accBal(200_000, 18_000)],
          ['ira2', accBal(100_000, 12_000)],
        ]),
      }),
    ];
    const rows = buildGuidanceYearRows(years, ACCOUNTS);
    expect(rows[0].accounts).toHaveLength(2);
    const ira1 = rows[0].accounts.find((a) => a.accountId === 'ira1')!;
    expect(ira1.accountName).toBe('IRA One');
    expect(ira1.withdrawnDollars).toBe(18_000);
    expect(ira1.endingBalanceDollars).toBe(200_000);
    expect(rows[0].totalWithdrawnDollars).toBe(30_000);
    expect(rows[0].hasWithdrawal).toBe(true);
  });

  it('flags a no-withdrawal year', () => {
    const rows = buildGuidanceYearRows([baseYear(2030)], ACCOUNTS);
    expect(rows[0].hasWithdrawal).toBe(false);
    expect(rows[0].accounts).toHaveLength(0);
  });

  it('surfaces RMD by legal aggregation group (multiple IRAs → one group)', () => {
    const years: DrawdownYear[] = [
      baseYear(2030, {
        withdrawn: 30_000,
        accountBalances: new Map([
          ['ira1', accBal(200_000, 18_000)],
          ['ira2', accBal(100_000, 12_000)],
        ]),
        perAccountRmdCents: { ira1: 1_000_000, ira2: 500_000 },
      }),
    ];
    const rows = buildGuidanceYearRows(years, ACCOUNTS);
    expect(rows[0].rmdGroups).toHaveLength(1);
    expect(rows[0].rmdGroups[0].kind).toBe('aggregatable');
    expect(rows[0].rmdGroups[0].requiredCents).toBe(1_500_000);
  });

  it('renders no RMD groups when the field is absent (pre-trigger year)', () => {
    const rows = buildGuidanceYearRows(
      [baseYear(2030, { withdrawn: 10_000, accountBalances: new Map([['ira1', accBal(100_000, 10_000)]]) })],
      ACCOUNTS,
    );
    expect(rows[0].rmdGroups).toHaveLength(0);
  });

  it('flags an RMD shortfall year', () => {
    const rows = buildGuidanceYearRows(
      [
        baseYear(2030, {
          withdrawn: 5_000,
          accountBalances: new Map([['ira1', accBal(100_000, 5_000)]]),
          perAccountRmdCents: { ira1: 1_800_000 },
          rmdShortfallCents: 1_300_000,
        }),
      ],
      ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(true);
  });

  it('does not flag a shortfall when a zero-RMD sibling IRA covers the group requirement', () => {
    // ira1 has RMD $10k (in group.accounts); ira2 has zero RMD (omitted from
    // perAccountRmdCents so absent from group.accounts). Engine routes $12k to
    // ira2 — the aggregate group requirement is satisfied.
    const years: DrawdownYear[] = [
      baseYear(2030, {
        withdrawn: 12_000,
        accountBalances: new Map([
          ['ira1', accBal(50_000, 0)],
          ['ira2', accBal(100_000, 12_000)],
        ]),
        perAccountRmdCents: { ira1: 1_000_000 }, // only ira1 has an RMD share
      }),
    ];
    const rows = buildGuidanceYearRows(years, ACCOUNTS);
    expect(rows[0].hasRmdShortfall).toBe(false);
  });

  it('still flags a shortfall when combined IRA draws fall short of the group RMD', () => {
    const years: DrawdownYear[] = [
      baseYear(2030, {
        withdrawn: 5_000,
        accountBalances: new Map([
          ['ira1', accBal(100_000, 3_000)],
          ['ira2', accBal(80_000, 2_000)],
        ]),
        perAccountRmdCents: { ira1: 800_000, ira2: 400_000 }, // $12k required
      }),
    ];
    const rows = buildGuidanceYearRows(years, ACCOUNTS);
    expect(rows[0].hasRmdShortfall).toBe(true);
  });
});

describe('buildGuidanceYearRows — tax + spendable', () => {
  it('income tax + Medicare = federalTaxCents + irmaaSurchargeCents', () => {
    const rows = buildGuidanceYearRows(
      [
        baseYear(2030, {
          withdrawn: 50_000,
          accountBalances: new Map([['ira1', accBal(100_000, 50_000)]]),
          federalTaxCents: 600_000, // $6,000
          irmaaSurchargeCents: 200_000, // $2,000 — full surcharge (withheld + cash)
        }),
      ],
      ACCOUNTS,
    );
    expect(rows[0].taxAndMedicareDollars).toBe(8_000);
  });

  it('Roth-funded year: Roth withdrawals count as spendable', () => {
    // $40k pulled, all from Roth (no tax). Spendable = full gross.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2030, {
          withdrawn: 40_000,
          accountBalances: new Map([['roth', accBal(200_000, 40_000)]]),
          federalTaxCashNeedCents: 0,
          irmaaCashNeedCents: 0,
        }),
      ],
      ACCOUNTS,
    );
    expect(rows[0].spendableDollars).toBe(40_000);
  });

  it('IRMAA-withheld year: spendable EXCLUDES the cash tax need but not the withheld surcharge', () => {
    // $50k gross; $5k federal cash need + $1k IRMAA cash need funded FROM the
    // portfolio. The withheld IRMAA comes out of SS, NOT the portfolio, so it is
    // NOT subtracted from spendable.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2030, {
          withdrawn: 50_000,
          accountBalances: new Map([['ira1', accBal(100_000, 50_000)]]),
          federalTaxCashNeedCents: 500_000,
          irmaaCashNeedCents: 100_000,
          irmaaWithheldFromSsCents: 300_000, // withheld from SS — must NOT reduce spendable
        }),
      ],
      ACCOUNTS,
    );
    // 50_000 − 5_000 − 1_000 = 44_000 (withheld 3_000 ignored).
    expect(rows[0].spendableDollars).toBe(44_000);
  });

  it('forced-RMD-surplus year: reinvested/held surplus excluded from spendable', () => {
    const rows = buildGuidanceYearRows(
      [
        baseYear(2030, {
          withdrawn: 60_000,
          accountBalances: new Map([['ira1', accBal(100_000, 60_000)]]),
          federalTaxCashNeedCents: 400_000, // $4,000
          rmdReinvestedCents: 1_000_000, // $10,000 reinvested — NOT spent this year
        }),
      ],
      ACCOUNTS,
    );
    // 60_000 − 4_000 − 10_000 = 46_000.
    expect(rows[0].spendableDollars).toBe(46_000);
  });

  it('adds the ACA PTC offset back into spendable', () => {
    const rows = buildGuidanceYearRows(
      [
        baseYear(2030, {
          withdrawn: 30_000,
          accountBalances: new Map([['ira1', accBal(100_000, 30_000)]]),
          acaPtcCashflowOffsetCents: 200_000, // $2,000 credit
        }),
      ],
      ACCOUNTS,
    );
    expect(rows[0].spendableDollars).toBe(32_000);
  });
});

describe('buildGuidanceYearRows — HSA medical/emergency split', () => {
  const HSA_ACCOUNTS = new Map<string, GuidanceAccountMeta>([
    ['hsa', { id: 'hsa', name: 'Health Savings', type: 'HSA', ownerId: 'owner-a', taxTreatment: 'HSA' }],
    ['brok', { id: 'brok', name: 'Brokerage', type: 'BROKERAGE', ownerId: 'owner-a', taxTreatment: 'POST_TAX' }],
  ]);

  function hsaBal(withdrawn: number, medicalCents?: number): DrawdownAccountYear {
    return {
      balance: 50_000, preEnd: 0, postEnd: 50_000, withdrawn, deposit: 0,
      ...(medicalCents !== undefined ? { medicalQualifiedWithdrawnCents: medicalCents } : {}),
    };
  }

  it('splits an HSA row into medical-qualified + emergency residual summing to withdrawn', () => {
    const rows = buildGuidanceYearRows(
      [baseYear(2050, { withdrawn: 5_000, accountBalances: new Map([['hsa', hsaBal(5_000, 300_000)]]) })],
      HSA_ACCOUNTS,
    );
    const hsa = rows[0].accounts.find((a) => a.accountId === 'hsa')!;
    expect(hsa.hsaMedicalQualifiedDollars).toBe(3_000);
    expect(hsa.hsaEmergencyReserveDollars).toBe(2_000);
    expect(hsa.hsaMedicalQualifiedDollars! + hsa.hsaEmergencyReserveDollars!).toBe(hsa.withdrawnDollars);
  });

  it('present-but-absent medical split → emergency-only HSA draw', () => {
    const rows = buildGuidanceYearRows(
      [baseYear(2050, { withdrawn: 4_000, accountBalances: new Map([['hsa', hsaBal(4_000)]]) })],
      HSA_ACCOUNTS,
    );
    const hsa = rows[0].accounts.find((a) => a.accountId === 'hsa')!;
    expect(hsa.hsaMedicalQualifiedDollars).toBe(0);
    expect(hsa.hsaEmergencyReserveDollars).toBe(4_000);
  });

  it('fully medical HSA draw → $0 emergency residual', () => {
    const rows = buildGuidanceYearRows(
      [baseYear(2050, { withdrawn: 4_000, accountBalances: new Map([['hsa', hsaBal(4_000, 400_000)]]) })],
      HSA_ACCOUNTS,
    );
    const hsa = rows[0].accounts.find((a) => a.accountId === 'hsa')!;
    expect(hsa.hsaMedicalQualifiedDollars).toBe(4_000);
    expect(hsa.hsaEmergencyReserveDollars).toBe(0);
  });

  it('leaves both split fields undefined on a non-HSA row', () => {
    const rows = buildGuidanceYearRows(
      [baseYear(2050, { withdrawn: 7_000, accountBalances: new Map([['brok', accBal(80_000, 7_000)]]) })],
      HSA_ACCOUNTS,
    );
    const brok = rows[0].accounts.find((a) => a.accountId === 'brok')!;
    expect(brok.hsaMedicalQualifiedDollars).toBeUndefined();
    expect(brok.hsaEmergencyReserveDollars).toBeUndefined();
  });
});

describe('buildGuidanceYearRows — MIXED pre-tax vs Roth/after-tax split', () => {
  const mixed401k: GuidanceAccountMeta = {
    id: 'mix401k', name: 'Mixed 401k', type: 'RETIREMENT_401K', ownerId: 'owner-a', taxTreatment: 'MIXED',
  };
  const mixedOther: GuidanceAccountMeta = {
    id: 'mixother', name: 'Mixed Other', type: 'OTHER', ownerId: 'owner-a', taxTreatment: 'MIXED',
  };
  const preOnly: GuidanceAccountMeta = {
    id: 'pre', name: 'Traditional IRA', type: 'RETIREMENT_IRA', ownerId: 'owner-a', taxTreatment: 'PRE_TAX',
  };
  const rothOnly: GuidanceAccountMeta = {
    id: 'rothA', name: 'Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownerId: 'owner-a', taxTreatment: 'ROTH',
  };
  const hsaAcc: GuidanceAccountMeta = {
    id: 'hsa', name: 'HSA', type: 'HSA', ownerId: 'owner-a', taxTreatment: 'HSA',
  };
  const postAcc: GuidanceAccountMeta = {
    id: 'brok', name: 'Brokerage', type: 'BROKERAGE', ownerId: 'owner-a', taxTreatment: 'POST_TAX',
  };

  it('MIXED 401K named strategy — split fields populated; postLabel is "Roth"', () => {
    // $10,000 total: $6,000 pre-tax (600_000 cents), $4,000 Roth residual
    const accounts = new Map<string, GuidanceAccountMeta>([['mix401k', mixed401k]]);
    const rows = buildGuidanceYearRows(
      [baseYear(2040, { withdrawn: 10_000, accountBalances: new Map([['mix401k', mixedBal(200_000, 10_000, 600_000)]]) })],
      accounts,
    );
    const acc = rows[0].accounts.find((a) => a.accountId === 'mix401k')!;
    expect(acc.isMixed).toBe(true);
    expect(acc.preTaxWithdrawnDollars).toBe(6_000);
    expect(acc.postWithdrawnDollars).toBe(4_000);
    expect(acc.postLabel).toBe('Roth');
  });

  it('MIXED OTHER named strategy — split fields populated; postLabel is "after-tax contributions (gains taxable)"', () => {
    // $8,000 total: $5,000 pre-tax (500_000 cents), $3,000 after-tax residual
    const accounts = new Map<string, GuidanceAccountMeta>([['mixother', mixedOther]]);
    const rows = buildGuidanceYearRows(
      [baseYear(2040, { withdrawn: 8_000, accountBalances: new Map([['mixother', mixedBal(150_000, 8_000, 500_000)]]) })],
      accounts,
    );
    const acc = rows[0].accounts.find((a) => a.accountId === 'mixother')!;
    expect(acc.isMixed).toBe(true);
    expect(acc.preTaxWithdrawnDollars).toBe(5_000);
    expect(acc.postWithdrawnDollars).toBe(3_000);
    expect(acc.postLabel).toBe('after-tax contributions (gains taxable)');
  });

  it('MIXED account without split data — split fields undefined; isMixed is true', () => {
    // preWithdrawnCents absent → no per-sub-account split data
    const accounts = new Map<string, GuidanceAccountMeta>([['mix401k', mixed401k]]);
    const rows = buildGuidanceYearRows(
      [baseYear(2040, { withdrawn: 10_000, accountBalances: new Map([['mix401k', mixedBal(200_000, 10_000)]]) })],
      accounts,
    );
    const acc = rows[0].accounts.find((a) => a.accountId === 'mix401k')!;
    expect(acc.isMixed).toBe(true);
    expect(acc.preTaxWithdrawnDollars).toBeUndefined();
    expect(acc.postWithdrawnDollars).toBeUndefined();
    expect(acc.postLabel).toBeUndefined();
  });

  it('non-MIXED accounts with split cents set — split fields NOT populated in output', () => {
    for (const [id, meta] of [
      ['pre', preOnly],
      ['rothA', rothOnly],
      ['hsa', hsaAcc],
      ['brok', postAcc],
    ] as const) {
      const accounts = new Map<string, GuidanceAccountMeta>([[id, meta]]);
      const rows = buildGuidanceYearRows(
        [baseYear(2040, { withdrawn: 5_000, accountBalances: new Map([[id, { ...mixedBal(100_000, 5_000, 200_000) }]]) })],
        accounts,
      );
      const acc = rows[0].accounts.find((a) => a.accountId === id)!;
      expect(acc.isMixed).toBeUndefined();
      expect(acc.preTaxWithdrawnDollars).toBeUndefined();
      expect(acc.postWithdrawnDollars).toBeUndefined();
    }
  });

  it('edge — MIXED named strategy with preWithdrawnCents: 0 (all-post year) — split note renders ($0 pre / full post), NOT the unavailable note', () => {
    // preWithdrawnCents is 0 (field IS present → named strategy), postWithdrawnCents > 0
    const accounts = new Map<string, GuidanceAccountMeta>([['mix401k', mixed401k]]);
    const rows = buildGuidanceYearRows(
      [baseYear(2040, { withdrawn: 7_000, accountBalances: new Map([['mix401k', mixedBal(200_000, 7_000, 0)]]) })],
      accounts,
    );
    const acc = rows[0].accounts.find((a) => a.accountId === 'mix401k')!;
    // Split IS available (preWithdrawnCents !== undefined)
    expect(acc.isMixed).toBe(true);
    expect(acc.preTaxWithdrawnDollars).toBe(0);
    expect(acc.postWithdrawnDollars).toBe(7_000);
    expect(acc.postLabel).toBe('Roth');
  });

  it('edge — MIXED named strategy with postWithdrawnCents: 0 (all-pre year) — split note renders (full pre / $0 post), NOT the unavailable note', () => {
    // $12,000 total, all from pre-tax (preWithdrawnCents === 1_200_000)
    const accounts = new Map<string, GuidanceAccountMeta>([['mix401k', mixed401k]]);
    const rows = buildGuidanceYearRows(
      [baseYear(2040, { withdrawn: 12_000, accountBalances: new Map([['mix401k', mixedBal(200_000, 12_000, 1_200_000)]]) })],
      accounts,
    );
    const acc = rows[0].accounts.find((a) => a.accountId === 'mix401k')!;
    expect(acc.isMixed).toBe(true);
    expect(acc.preTaxWithdrawnDollars).toBe(12_000);
    expect(acc.postWithdrawnDollars).toBe(0);
    expect(acc.postLabel).toBe('Roth');
  });

  it('residual rule: preTaxWithdrawnDollars + postWithdrawnDollars === withdrawnDollars', () => {
    // Use an amount that would have a 1-cent rounding discrepancy if both were
    // independently rounded.
    // $9,999 total, $6,666.67 pre-tax (666_667 cents) → post is residual
    const accounts = new Map<string, GuidanceAccountMeta>([['mix401k', mixed401k]]);
    const rows = buildGuidanceYearRows(
      [baseYear(2040, { withdrawn: 9_999, accountBalances: new Map([['mix401k', mixedBal(200_000, 9_999, 666_667)]]) })],
      accounts,
    );
    const acc = rows[0].accounts.find((a) => a.accountId === 'mix401k')!;
    expect(acc.preTaxWithdrawnDollars).toBeDefined();
    expect(acc.postWithdrawnDollars).toBeDefined();
    expect(acc.preTaxWithdrawnDollars! + acc.postWithdrawnDollars!).toBe(acc.withdrawnDollars);
  });
});

describe('buildGuidanceYearRows — hasRmdShortfall with MIXED accounts (bug fix)', () => {
  // SECURE 2.0 §325: Roth-designated money in an employer plan is RMD-exempt.
  // When a withdrawal carries no per-sub-account split (preWithdrawnCents
  // absent), rmdEligibleWithdrawnCents fell back to 0 for MIXED accounts — the
  // bug. When the kernel populates preWithdrawnCents the display layer correctly
  // counts only the pre-tax tranche toward the RMD floor.

  const MIXED_ACCOUNTS = new Map<string, GuidanceAccountMeta>([
    ['mix401k', { id: 'mix401k', name: 'Mixed 401k', type: 'RETIREMENT_401K', ownerId: 'owner-a', taxTreatment: 'MIXED' }],
  ]);

  it('MIXED per-plan — does NOT flag shortfall when pre-tax tranche meets the floor', () => {
    // $10k withdrawn, $6k is pre-tax (600_000 cents), RMD floor = $5k (500_000 cents).
    // Pre-tax tranche 600_000 >= required 500_000 → no shortfall.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 10_000,
          accountBalances: new Map([['mix401k', mixedBal(200_000, 10_000, 600_000)]]),
          perAccountRmdCents: { mix401k: 500_000 },
        }),
      ],
      MIXED_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(false);
  });

  it('MIXED per-plan — flags shortfall when pre-tax tranche is below the floor (the bug case)', () => {
    // $10k withdrawn, $3k is pre-tax (300_000 cents), RMD floor = $5k (500_000 cents).
    // Before v48: gross 1_000_000 cents >= 500_000 → incorrectly no shortfall.
    // After v48: pre-tax 300_000 cents < 500_000 → correctly flags shortfall.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 10_000,
          accountBalances: new Map([['mix401k', mixedBal(200_000, 10_000, 300_000)]]),
          perAccountRmdCents: { mix401k: 500_000 },
        }),
      ],
      MIXED_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(true);
  });

  it('MIXED per-plan — no false positive when preWithdrawnCents is undefined (conservative fallback)', () => {
    // preWithdrawnCents absent (legacy / stale cache row). Treat as 0.
    // With RMD floor of 0 (perAccountRmdCents absent), no shortfall.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 8_000,
          accountBalances: new Map([['mix401k', mixedBal(200_000, 8_000)]]),
          // No perAccountRmdCents → no RMD groups → hasRmdShortfall is false.
        }),
      ],
      MIXED_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(false);
  });

  it('MIXED per-plan — zero-pre-tax tranche (all Roth) → shortfall when floor > 0', () => {
    // $10k withdrawn, $0 is pre-tax (0 cents from pre), RMD floor = $3k (300_000 cents).
    // Roth portion is RMD-exempt, so withdrawnCents = 0 < 300_000 → shortfall.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 10_000,
          accountBalances: new Map([['mix401k', mixedBal(200_000, 10_000, 0)]]),
          perAccountRmdCents: { mix401k: 300_000 },
        }),
      ],
      MIXED_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(true);
  });

  it('MIXED per-plan — pre-tax tranche exactly meets floor (boundary equality)', () => {
    // $8k withdrawn, all pre-tax (800_000 cents), floor = $8k (800_000 cents).
    // 800_000 === 800_000 is NOT a shortfall (shortfall only when strictly less than).
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 8_000,
          accountBalances: new Map([['mix401k', mixedBal(200_000, 8_000, 800_000)]]),
          perAccountRmdCents: { mix401k: 800_000 },
        }),
      ],
      MIXED_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(false);
  });
});

describe('buildGuidanceYearRows — hasRmdShortfall for an INHERITED Roth account', () => {
  // The engine admits an INHERITED Roth account into `perAccountRmdCents` (a beneficiary
  // owes post-death distributions under §401(a)(9)(B) even though a living Roth
  // owner owes none). What satisfies that requirement is the distribution AMOUNT,
  // not its tax treatment — so the beneficiary's untaxed Roth draw counts. If the
  // "counts toward the requirement" helper returned 0 for every Roth
  // treatment, a fully-recorded inherited Roth IRA would show a shortfall in EVERY
  // year forever, and none of the three disclosure branches could explain it.
  const ROTH_ACCOUNTS = new Map<string, GuidanceAccountMeta>([
    [
      'inh-roth',
      {
        id: 'inh-roth',
        name: 'Inherited Roth IRA',
        type: 'RETIREMENT_ROTH_IRA',
        ownerId: 'owner-a',
        taxTreatment: 'ROTH',
        // An inherited account never aggregates — it is its own per-plan group,
        // which is also what lets an inherited Roth IRA appear as a group at all.
        inherited: true,
      },
    ],
  ]);

  it('does NOT flag a shortfall when the Roth-sourced withdrawal meets the requirement', () => {
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 12_000,
          accountBalances: new Map([['inh-roth', accBal(200_000, 12_000)]]),
          perAccountRmdCents: { 'inh-roth': 1_000_000 }, // $10k required
        }),
      ],
      ROTH_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(false);
    // No disclosure branch fires either — there is nothing to explain.
    expect(rows[0].rmdDisclosures).toEqual([]);
  });

  it('still flags a genuine shortfall when the Roth distribution falls short', () => {
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 4_000,
          accountBalances: new Map([['inh-roth', accBal(200_000, 4_000)]]),
          perAccountRmdCents: { 'inh-roth': 1_000_000 }, // $10k required, $4k taken
        }),
      ],
      ROTH_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(true);
  });
});

describe('buildGuidanceYearRows — hasRmdShortfall QCD offset credit (§408(d)(8))', () => {
  // A QCD satisfies the directing owner's IRA-pool RMD. The shortfall predicate
  // credits the per-owner IRA-pool offset (`qcdRmdOffsetCentsByOwner`) toward the
  // RETIREMENT_IRA aggregation group ONLY — so a QCD-satisfied IRA RMD is not a
  // phantom shortfall, while a genuine cross-pool (per-plan 401k) miss still flags.
  const QCD_ACCOUNTS = new Map<string, GuidanceAccountMeta>([
    ['ira1', { id: 'ira1', name: 'IRA One', type: 'RETIREMENT_IRA', ownerId: 'owner-a', taxTreatment: 'PRE_TAX' }],
    ['k401', { id: 'k401', name: 'Employer 401k', type: 'RETIREMENT_401K', ownerId: 'owner-a', taxTreatment: 'PRE_TAX' }],
  ]);

  it('1. partial IRA draw + QCD offset ≥ remaining IRA RMD → no phantom shortfall; gross required display unchanged', () => {
    // IRA gross RMD = $4,333 (433_300 cents). $1,000 withdrawn for spending,
    // $10,000 QCD offset → 100_000 + 1_000_000 ≥ 433_300 → satisfied.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 1_000,
          accountBalances: new Map([['ira1', accBal(200_000, 1_000)]]),
          perAccountRmdCents: { ira1: 433_300 },
          qcdRmdOffsetCentsByOwner: { 'owner-a': 1_000_000 },
        }),
      ],
      QCD_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(false);
    // Display row keeps the STATUTORY gross figure (the QCD credit is honesty in
    // the shortfall flag, not a rewrite of the required-minimum display).
    expect(rows[0].rmdGroups).toHaveLength(1);
    expect(rows[0].rmdGroups[0].accountType).toBe('RETIREMENT_IRA');
    expect(rows[0].rmdGroups[0].requiredCents).toBe(433_300);
  });

  it('2. same QCD-satisfied IRA but a genuine per-plan 401k shortfall → still flags (IRA credit does not mask a 401k miss)', () => {
    // IRA RMD covered by the QCD offset, but the 401k per-plan RMD ($6k) is unmet
    // ($0 drawn). The per-plan group gets NO QCD credit → shortfall flags.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 1_000,
          accountBalances: new Map([
            ['ira1', accBal(200_000, 1_000)],
            ['k401', accBal(150_000, 0)],
          ]),
          perAccountRmdCents: { ira1: 433_300, k401: 600_000 },
          qcdRmdOffsetCentsByOwner: { 'owner-a': 1_000_000 },
        }),
      ],
      QCD_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(true);
  });

  it('3. no QCD offset field → behavior unchanged (regression guard)', () => {
    // Identical IRA setup as case 1 but without qcdRmdOffsetCentsByOwner: the
    // $1,000 draw falls short of the $4,333 gross RMD → shortfall flags.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 1_000,
          accountBalances: new Map([['ira1', accBal(200_000, 1_000)]]),
          perAccountRmdCents: { ira1: 433_300 },
        }),
      ],
      QCD_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(true);
  });

  it('4. QCD offset smaller than the remaining IRA RMD gap → still short (partial credit, not a free pass)', () => {
    // IRA gross RMD = $4,333. $1,000 withdrawn + $2,000 QCD offset = $3,000 <
    // $4,333 → still short.
    const rows = buildGuidanceYearRows(
      [
        baseYear(2040, {
          withdrawn: 1_000,
          accountBalances: new Map([['ira1', accBal(200_000, 1_000)]]),
          perAccountRmdCents: { ira1: 433_300 },
          qcdRmdOffsetCentsByOwner: { 'owner-a': 200_000 },
        }),
      ],
      QCD_ACCOUNTS,
    );
    expect(rows[0].hasRmdShortfall).toBe(true);
  });
});

describe('indexForYear', () => {
  it('finds the exact year', () => {
    const rows = buildGuidanceYearRows([baseYear(2030), baseYear(2031)], ACCOUNTS);
    expect(indexForYear(rows, 2031)).toBe(1);
  });

  it('returns -1 for a year before the first row; clamps to last for a year after the last', () => {
    const rows = buildGuidanceYearRows([baseYear(2030), baseYear(2031)], ACCOUNTS);
    expect(indexForYear(rows, 2025)).toBe(-1);
    expect(indexForYear(rows, 2099)).toBe(1);
  });

  it('returns -1 for empty rows', () => {
    expect(indexForYear([], 2030)).toBe(-1);
  });
});
