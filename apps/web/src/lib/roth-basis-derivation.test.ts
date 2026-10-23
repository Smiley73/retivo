// Worked examples of the §408A basis pooling, ordering and imputation rules; figures are dollars as stored, assertions are integer cents.

import { describe, expect, it } from 'vitest';

import { gainLoss } from './balance-calc';
import { applyFactBasedRothIraOrdering } from './balance-projection-runner-roth-basis';
import { deriveRothPoolBasisCents } from './roth-basis-derivation';
import type { AccountBalancePayload } from '../db/types';

function payload(overrides: Partial<AccountBalancePayload> = {}): AccountBalancePayload {
  return {
    accountId: 'acc-1',
    year: 2024,
    lastUpdated: '2024-12-31T23:59:59Z',
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
    ...overrides,
  };
}

function row(overrides: Partial<AccountBalancePayload> = {}): { payload: AccountBalancePayload } {
  return { payload: payload(overrides) };
}

function pool(...ids: string[]): ReadonlyArray<{ id: string }> {
  return ids.map((id) => ({ id }));
}

function c(dollars: number): number {
  return Math.round(dollars * 100);
}

// A sibling account seeds a large personal-contribution basis before every test year, so a charged outflow shows as a drop in remaining basis.
const PROBE_ACCOUNT_ID = 'probe';
const PROBE_YEAR = 1999;
const PROBE_DOLLARS = 100_000_000;
const probeRow = row({
  accountId: PROBE_ACCOUNT_ID,
  year: PROBE_YEAR,
  totalContributions: PROBE_DOLLARS,
  endingBalance: PROBE_DOLLARS,
});

// Total outflow (recorded plus imputed) the derivation charged the pool, in cents: seeded basis plus what rows credit, minus what remains. The probe row starts at $0, so it is skipped at every boundary.
function totalChargedCents(
  rows: ReadonlyArray<{ payload: AccountBalancePayload }>,
  accountIds: readonly string[],
  creditedByRowsCents = 0,
): number {
  const derived = deriveRothPoolBasisCents(pool(...accountIds, PROBE_ACCOUNT_ID), [
    probeRow,
    ...rows,
  ]);
  return c(PROBE_DOLLARS) + creditedByRowsCents - derived.regularContributionBasisCents;
}

describe('pooling and chronology', () => {
  it('pools at the pool level, never per-account-then-sum', () => {
    // A holds $50k of contributions and no withdrawal; rollover-funded sibling B holds $0 and a $50k withdrawal. Per-account-then-sum with a floor wrongly reports $50,000.
    const derived = deriveRothPoolBasisCents(pool('acc-a', 'acc-b'), [
      row({ accountId: 'acc-a', year: 2020, totalContributions: 50_000, endingBalance: 50_000 }),
      row({ accountId: 'acc-b', year: 2020, rollover: 50_000, endingBalance: 50_000 }),
      row({
        accountId: 'acc-b',
        year: 2021,
        startingBalance: 50_000,
        distributions: 50_000,
        endingBalance: 0,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(0);
  });

  it('sums two accounts’ same-year contributions into one year credit', () => {
    // One person funding two Roth IRAs in a year: the credits sum into ONE year credit; overwriting keeps a single account's ($4,000 or $3,000).
    expect(
      deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
        row({ year: 2020, totalContributions: 4_000, endingBalance: 4_000 }),
        row({ accountId: 'acc-2', year: 2020, totalContributions: 3_000, endingBalance: 3_000 }),
      ]).regularContributionBasisCents,
    ).toBe(c(7_000));

    // The summed credit is consumed as one figure: a $6,000 withdrawal leaves $1,000, where either overwritten credit is wiped to $0.
    const drawn = deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
      row({ year: 2020, totalContributions: 4_000, endingBalance: 4_000 }),
      row({
        accountId: 'acc-2',
        year: 2020,
        startingBalance: 10_000,
        totalContributions: 3_000,
        distributions: 6_000,
        endingBalance: 7_000,
      }),
    ]);

    expect(drawn.regularContributionBasisCents).toBe(c(1_000));
  });

  it('credits only the personal share of a row’s contributions', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        totalContributions: 8_000,
        companyContributions: 2_000,
        endingBalance: 8_000,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(c(6_000));
  });

  it('credits $0, never a negative, when a row records more company money than total', () => {
    // A flat row whose companyContributions was recorded without recomputing totalContributions (an import-bundle shape): without the $0 floor it credits MINUS $2,000.
    const staleRow = row({ year: 2020, companyContributions: 2_000, totalContributions: 0 });

    const credited = deriveRothPoolBasisCents(pool('acc-1'), [
      staleRow,
      row({ year: 2021, totalContributions: 6_000, endingBalance: 6_000 }),
    ]);

    // A negative credit carried into 2021 leaves $4,000 of the real $6,000.
    expect(credited.regularContributionBasisCents).toBe(c(6_000));

    const drawn = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2019,
        rollover: 30_000,
        endingBalance: 30_000,
        rothConversionTaxableAmount: 30_000,
      }),
      row({
        year: 2020,
        startingBalance: 30_000,
        companyContributions: 2_000,
        totalContributions: 0,
        distributions: 10_000,
        endingBalance: 20_000,
      }),
    ]);

    // A negative basis is drawn as fromBasis, which GROWS the outflow: the lot would lose $12,000 to a $10,000 withdrawal.
    expect(drawn.regularContributionBasisCents).toBe(0);
    expect(drawn.conversionLots).toEqual([
      {
        taxYear: 2019,
        taxableConvertedPrincipalCents: c(20_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });

  it('credits only the personal share when the row carries MIXED splits', () => {
    // The flat companyContributions disagrees with the split company fields (an import-bundle shape): subtracting the stale flat $0 from the splits' $8,000 credits all $8,000, overstating basis.
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        contributionsPreTax: 0,
        contributionsPostTax: 6_000,
        companyContributionsPreTax: 0,
        companyContributionsPostTax: 2_000,
        companyContributions: 0,
        totalContributions: 8_000,
        endingBalance: 8_000,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(c(6_000));
  });

  it('credits both personal splits of a MIXED row and neither company split', () => {
    // On a MIXED row basis is totalContributions − company contributions, resolved on the splits: personal $23,000 + $7,000 is basis, employer $5,000 is not (a MIXED 401(k) re-typed to a Roth IRA keeps these rows).
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        contributionsPreTax: 23_000,
        contributionsPostTax: 7_000,
        companyContributionsPreTax: 5_000,
        companyContributionsPostTax: 0,
        // In sync with the splits as the entry modal writes them: subtracting the flat field again would charge the same $5,000 twice and credit $25,000.
        companyContributions: 5_000,
        totalContributions: 35_000,
        endingBalance: 35_000,
      }),
    ]);

    // Crediting contributionsPostTax alone drops the $23,000 personal pre-tax split ($7,000); crediting the four-way total keeps the employer money ($35,000).
    expect(derived.regularContributionBasisCents).toBe(c(30_000));
  });

  it('consumes chronologically, not by whole-history subtraction', () => {
    // $10k/yr 2000–2010 against a $100k withdrawal in 2001 leaves $90k; whole-history subtraction would say $10k.
    const contributing = [
      row({ accountId: 'acc-c', year: 2000, totalContributions: 10_000, endingBalance: 10_000 }),
      ...Array.from({ length: 10 }, (_unused, i) => {
        const year = 2001 + i;
        return row({
          accountId: 'acc-c',
          year,
          startingBalance: (year - 2000) * 10_000,
          totalContributions: 10_000,
          endingBalance: (year - 1999) * 10_000,
        });
      }),
    ];
    const derived = deriveRothPoolBasisCents(pool('acc-c', 'acc-r'), [
      ...contributing,
      row({ accountId: 'acc-r', year: 2000, rollover: 500_000, endingBalance: 500_000 }),
      row({
        accountId: 'acc-r',
        year: 2001,
        startingBalance: 500_000,
        distributions: 100_000,
        endingBalance: 400_000,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(c(90_000));
  });

  it('credits a year’s contributions before that same year’s outflow', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({ year: 2020, totalContributions: 5_000, distributions: 5_000, endingBalance: 0 }),
    ]);

    // Outflow-first would leave $5,000.
    expect(derived.regularContributionBasisCents).toBe(0);
  });

  it('returns the same answer when the account and row arrays are shuffled', () => {
    const accountIds = ['acc-1', 'acc-2'];
    const rows = [
      row({ accountId: 'acc-2', year: 2019, totalContributions: 250_000, endingBalance: 250_000 }),
      row({ year: 2020, startingBalance: 500_000, endingBalance: 500_000 }),
      row({ year: 2021, distributions: 200_000, endingBalance: 300_000 }),
      row({ year: 2022, startingBalance: 300_000, endingBalance: 300_000 }),
    ];

    const inOrder = deriveRothPoolBasisCents(pool(...accountIds), rows);
    const shuffled = deriveRothPoolBasisCents(pool(...[...accountIds].reverse()), [
      rows[3],
      rows[1],
      rows[0],
      rows[2],
    ]);

    expect(shuffled).toEqual(inOrder);
  });

  it('walks an account’s rows chronologically whatever order they arrive in', () => {
    // Handed newest-first, as a store may return them: the boundary chain walks the array as given, so rows are sorted per account first.
    const charged = totalChargedCents(
      [
        row({ year: 2021, startingBalance: 90_000, endingBalance: 90_000 }),
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
      ],
      ['acc-1'],
    );

    // Walked in arrival order, 2021 is compared against nothing and 2020's span reads as a $10,000 increase, flooring to $0: no charge for a real drop.
    expect(charged).toBe(c(10_000));
  });

  it('returns $0 and no lots for an empty pool and for a pool with no rows', () => {
    const empty: ReturnType<typeof deriveRothPoolBasisCents> = {
      regularContributionBasisCents: 0,
      conversionLots: [],
    };

    expect(deriveRothPoolBasisCents([], [])).toEqual(empty);
    expect(deriveRothPoolBasisCents(pool('acc-1'), [])).toEqual(empty);
    expect(
      deriveRothPoolBasisCents([], [row({ year: 2020, totalContributions: 5_000 })]),
    ).toEqual(empty);
  });

  it('ignores rows belonging to an account outside the pool', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({ year: 2020, totalContributions: 5_000, endingBalance: 5_000 }),
      row({ accountId: 'acc-outside', year: 2020, totalContributions: 9_000 }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(c(5_000));
  });
});

describe('closure shapes', () => {
  // Every row here takes a $100,000 starting balance to a $0 ending balance.
  const closureCases: ReadonlyArray<{
    readonly name: string;
    readonly recorded: Partial<AccountBalancePayload>;
    readonly imputedDollars: number;
    readonly chargedDollars: number;
    readonly creditedDollars?: number;
  }> = [
    { name: 'nothing recorded', recorded: {}, imputedDollars: 100_000, chargedDollars: 100_000 },
    {
      name: 'an outbound rollover covering the whole drop (consolidation)',
      recorded: { rollover: -100_000 },
      imputedDollars: 0,
      chargedDollars: 0,
    },
    {
      name: 'distributions covering the whole drop (spend-down)',
      recorded: { distributions: 100_000 },
      imputedDollars: 0,
      chargedDollars: 100_000,
    },
    {
      name: 'a partial outbound rollover',
      recorded: { rollover: -60_000 },
      imputedDollars: 40_000,
      chargedDollars: 40_000,
    },
    {
      name: '$1 of distributions',
      recorded: { distributions: 1 },
      imputedDollars: 99_999,
      chargedDollars: 100_000,
    },
    {
      name: 'an inbound rollover',
      recorded: { rollover: 5_000 },
      imputedDollars: 105_000,
      chargedDollars: 105_000,
    },
    {
      name: 'a full liquidation past the starting balance',
      recorded: { distributions: 120_000 },
      imputedDollars: 0,
      chargedDollars: 120_000,
    },
    {
      name: 'contributions of which part is company money',
      recorded: { totalContributions: 8_000, companyContributions: 2_000 },
      imputedDollars: 108_000,
      chargedDollars: 108_000,
      creditedDollars: 6_000,
    },
    {
      // Pins the module's own MIXED split resolution against balance-calc: the balance arithmetic uses the FULL $8,000 the splits sum to, not the stale flat $0, while only the $6,000 personal share is credited.
      name: 'MIXED contribution splits whose flat fields are stale',
      recorded: {
        contributionsPreTax: 0,
        contributionsPostTax: 6_000,
        companyContributionsPreTax: 0,
        companyContributionsPostTax: 2_000,
        companyContributions: 0,
        totalContributions: 0,
      },
      imputedDollars: 108_000,
      chargedDollars: 108_000,
      creditedDollars: 6_000,
    },
    {
      // A MIXED row with all four splits: balance arithmetic counts every split ($10,000, read back by −gainLoss), while basis credits the $8,000 personal splits and excludes $2,000 of company money.
      name: 'MIXED company splits the balance arithmetic counts but basis does not',
      recorded: {
        contributionsPreTax: 2_000,
        contributionsPostTax: 6_000,
        companyContributionsPreTax: 1_000,
        companyContributionsPostTax: 1_000,
        companyContributions: 0,
        totalContributions: 0,
      },
      imputedDollars: 110_000,
      chargedDollars: 110_000,
      creditedDollars: 8_000,
    },
  ];

  for (const testCase of closureCases) {
    const closureRow = row({
      year: 2020,
      startingBalance: 100_000,
      endingBalance: 0,
      ...testCase.recorded,
    });

    it(`imputes the row’s own unexplained residual with ${testCase.name}`, () => {
      const charged = totalChargedCents(
        [closureRow],
        ['acc-1'],
        c(testCase.creditedDollars ?? 0),
      );

      expect(charged).toBe(c(testCase.chargedDollars));
      expect(charged - c(testCase.recorded.distributions ?? 0)).toBe(
        c(testCase.imputedDollars),
      );
    });

    it(`imputes exactly −gainLoss (floored at $0) with ${testCase.name}`, () => {
      const imputed =
        totalChargedCents([closureRow], ['acc-1'], c(testCase.creditedDollars ?? 0)) -
        c(testCase.recorded.distributions ?? 0);

      expect(imputed).toBe(Math.max(0, c(-gainLoss(closureRow.payload))));
    });
  }

  it('still credits the personal contribution share on a zeroed-out row', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
      row({
        year: 2020,
        startingBalance: 100_000,
        totalContributions: 8_000,
        companyContributions: 2_000,
        endingBalance: 0,
      }),
      row({ accountId: 'acc-2', year: 2021, totalContributions: 6_000, endingBalance: 6_000 }),
    ]);

    // 2020 credits $6,000 and charges $108,000, wiping it; 2021 rebuilds $6,000.
    expect(derived.regularContributionBasisCents).toBe(c(6_000));
  });

  it('charges the same residual on an inactive account', () => {
    // The module applies no account-level filter (it reads only id), so an account's active flag cannot change the answer; the wider account shape proves it.
    const rows = [row({ year: 2020, startingBalance: 100_000, endingBalance: 0 })];
    const inactiveAccount: ReadonlyArray<{ id: string; active: boolean }> = [
      { id: 'acc-1', active: false },
    ];

    expect(deriveRothPoolBasisCents(inactiveAccount, rows)).toEqual(
      deriveRothPoolBasisCents(pool('acc-1'), rows),
    );
  });

  it('charges the same residual whether or not a later-year row exists', () => {
    const zeroedOut = row({ year: 2020, startingBalance: 100_000, endingBalance: 0 });
    const alone = totalChargedCents([zeroedOut], ['acc-1']);
    const withSeedRow = totalChargedCents([zeroedOut, row({ year: 2021 })], ['acc-1']);
    const withPositiveRow = totalChargedCents(
      [zeroedOut, row({ year: 2021, startingBalance: 50_000, endingBalance: 50_000 })],
      ['acc-1'],
    );

    expect(alone).toBe(c(100_000));
    expect(withSeedRow).toBe(c(100_000));
    expect(withPositiveRow).toBe(c(100_000));
  });

  it('imputes nothing when a positive ending is lower than the row explains', () => {
    // The residual rule fires only on an exactly-$0 ending and both spans here net to zero, so nothing is charged; a gate broadened to any drop would charge $40,000.
    const charged = totalChargedCents(
      [
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
        row({ year: 2021, startingBalance: 100_000, endingBalance: 60_000 }),
        row({ year: 2022, startingBalance: 60_000, endingBalance: 60_000 }),
      ],
      ['acc-1'],
    );

    expect(charged).toBe(0);
  });

  it('imputes nothing on a $0-start row that ends at $0 recording its own contribution', () => {
    // The starting half of the gate: it stops this row's own $7,000 being imputed straight back out, wiping the basis it credits.
    const rows = [row({ year: 2020, totalContributions: 7_000, endingBalance: 0 })];

    expect(totalChargedCents(rows, ['acc-1'], c(7_000))).toBe(0);
    expect(
      deriveRothPoolBasisCents(pool('acc-1'), rows).regularContributionBasisCents,
    ).toBe(c(7_000));
  });
});

describe('boundary and skip shapes', () => {
  it('imputes an adjacent shortfall', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
        row({ year: 2021, startingBalance: 90_000, endingBalance: 90_000 }),
      ],
      ['acc-1'],
    );

    expect(charged).toBe(c(10_000));
  });

  it('imputes a shortfall across a gap year exactly like an adjacency', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
        row({ year: 2023, startingBalance: 90_000, endingBalance: 90_000 }),
      ],
      ['acc-1'],
    );

    expect(charged).toBe(c(10_000));
  });

  it('imputes nothing on a net increase, adjacent or across a gap', () => {
    const priorRow = row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 });
    const increased = (year: number) =>
      row({ year, startingBalance: 110_000, endingBalance: 110_000 });

    expect(totalChargedCents([priorRow, increased(2021)], ['acc-1'])).toBe(0);
    expect(totalChargedCents([priorRow, increased(2024)], ['acc-1'])).toBe(0);
  });

  it('dates a boundary shortfall in the far side’s own year', () => {
    // Prior ending $50,000, next row starting $40,000 and recording its own $10,000: dated in 2021 the shortfall consumes that contribution and resolves to $0; dated a year earlier it would leave $10,000.
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({ year: 2020, startingBalance: 50_000, endingBalance: 50_000 }),
      row({
        year: 2021,
        startingBalance: 40_000,
        totalContributions: 10_000,
        endingBalance: 50_000,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(0);
  });

  it('nets a skipped row’s own recorded flows into the span', () => {
    const rows = [
      row({ accountId: 'acc-2', year: 2019, totalContributions: 250_000, endingBalance: 250_000 }),
      row({ year: 2020, startingBalance: 500_000, endingBalance: 500_000 }),
      row({ year: 2021, distributions: 200_000, endingBalance: 300_000 }),
      row({ year: 2022, startingBalance: 300_000, endingBalance: 300_000 }),
    ];

    // A raw balance-to-balance comparison charges $400,000 and resolves to $0.
    expect(totalChargedCents(rows, ['acc-1', 'acc-2'], c(250_000))).toBe(c(200_000));
    expect(
      deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), rows).regularContributionBasisCents,
    ).toBe(c(50_000));
  });

  it('nets a skipped row’s FULL recorded contributions, not the share it credits', () => {
    const rows = [
      row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
      row({
        year: 2021,
        totalContributions: 8_000,
        companyContributions: 2_000,
        endingBalance: 108_000,
      }),
      row({ year: 2022, startingBalance: 100_000, endingBalance: 100_000 }),
    ];

    // The span is balance arithmetic (100,000 + 8,000 − 100,000), so it nets the FULL $8,000; netting the $6,000 personal share charges a phantom $2,000 outflow against basis.
    expect(totalChargedCents(rows, ['acc-1'], c(6_000))).toBe(c(8_000));
  });

  it('nets TWO consecutive skipped rows, one carrying a signed rollover', () => {
    const rows = [
      row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
      row({ year: 2021, rollover: -30_000, endingBalance: 70_000 }),
      row({ year: 2022, totalContributions: 5_000, endingBalance: 75_000 }),
      row({ year: 2023, startingBalance: 60_000, endingBalance: 60_000 }),
    ];

    // max(0, 100,000 − 30,000 + 5,000 − 60,000); dropping the skipped rollover, or accumulating only the last skipped row, charges $45,000 instead.
    expect(totalChargedCents(rows, ['acc-1'], c(5_000))).toBe(c(15_000));
  });

  it('consumes a skipped row’s flows in ONE span and never carries them past it', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
        // Honestly recorded on a pre-filled $0 starting balance: the 2022 span nets to $0 because this $40,000 belongs to it.
        row({ year: 2021, distributions: 40_000, endingBalance: 60_000 }),
        row({ year: 2022, startingBalance: 60_000, endingBalance: 60_000 }),
        row({ year: 2023, startingBalance: 50_000, endingBalance: 50_000 }),
      ],
      ['acc-1'],
    );

    // $40,000 recorded plus a $10,000 shortfall imputed in 2023; left un-reset, the stale −$40,000 nets the 2023 span to $0 too, suppressing every later shortfall on the account.
    expect(charged).toBe(c(50_000));
  });

  it('charges an unexplained drop exactly once where two of the rules overlap', () => {
    const laterRows = [
      row({ year: 2021, totalContributions: 7_000, endingBalance: 7_300 }),
      row({ year: 2022, startingBalance: 7_300, endingBalance: 7_300 }),
    ];
    const imputedRun = [
      row({ year: 2020, startingBalance: 20_000, endingBalance: 0 }),
      ...laterRows,
    ];
    const recordedRun = [
      row({ year: 2020, startingBalance: 20_000, distributions: 20_000, endingBalance: 0 }),
      ...laterRows,
    ];

    // The last boundary imputes nothing: its near side is the $0 ending, and the skipped 2021 row's own $7,000 nets in.
    expect(totalChargedCents(imputedRun, ['acc-1'], c(7_000))).toBe(c(20_000));
    expect(totalChargedCents(recordedRun, ['acc-1'], c(7_000))).toBe(c(20_000));
    expect(
      deriveRothPoolBasisCents(pool('acc-1'), imputedRun).regularContributionBasisCents,
    ).toBe(c(7_000));
    expect(
      deriveRothPoolBasisCents(pool('acc-1'), recordedRun).regularContributionBasisCents,
    ).toBe(c(7_000));
  });

  it('imputes nothing for an account-creation all-zero seed row', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2022, startingBalance: 100_000, endingBalance: 100_000 }),
        row({ year: 2023, startingBalance: 100_000, endingBalance: 100_000 }),
        row({ year: 2024 }),
      ],
      ['acc-1'],
    );

    expect(charged).toBe(0);
  });

  it('catches a withdrawal hiding behind a pre-filled $0 starting balance', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2022, startingBalance: 100_000, endingBalance: 100_000 }),
        row({ year: 2023, endingBalance: 60_000 }),
        row({ year: 2024, startingBalance: 60_000, endingBalance: 60_000 }),
      ],
      ['acc-1'],
    );

    // The $0-start 2023 row is skipped, but the span from 2022's ending to 2024's starting balance still imputes the $40,000 drop.
    expect(charged).toBe(c(40_000));
  });

  it('credits a genuine $0-start year’s own contribution with no later row', () => {
    const rows = [
      row({ year: 2022, startingBalance: 50_000, endingBalance: 50_000 }),
      row({ year: 2023, totalContributions: 7_000, endingBalance: 7_000 }),
    ];

    // A genuine $0-start year's own contribution is credited as basis, not dropped.
    expect(
      deriveRothPoolBasisCents(pool('acc-1'), rows).regularContributionBasisCents,
    ).toBe(c(7_000));
    expect(totalChargedCents(rows, ['acc-1'], c(7_000))).toBe(0);
  });

  it('compares across that $0-start year once a positive-starting row follows', () => {
    const rows = [
      row({ year: 2022, startingBalance: 50_000, endingBalance: 50_000 }),
      row({ year: 2023, totalContributions: 7_000, endingBalance: 7_000 }),
      row({ year: 2024, startingBalance: 7_000, endingBalance: 7_000 }),
    ];

    expect(totalChargedCents(rows, ['acc-1'], c(7_000))).toBe(c(50_000));
    expect(
      deriveRothPoolBasisCents(pool('acc-1'), rows).regularContributionBasisCents,
    ).toBe(0);
  });

  it('sums an imputed shortfall and the far row’s own recorded distributions', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
        row({
          year: 2021,
          startingBalance: 90_000,
          distributions: 5_000,
          endingBalance: 85_000,
        }),
      ],
      ['acc-1'],
    );

    // The boundary never reads the far row's own distributions.
    expect(charged).toBe(c(15_000));
  });

  it('compares an account’s first row against nothing', () => {
    const charged = totalChargedCents(
      [
        row({
          year: 2020,
          startingBalance: 100_000,
          distributions: 10_000,
          endingBalance: 90_000,
        }),
      ],
      ['acc-1'],
    );

    expect(charged).toBe(c(10_000));
  });

  it('never carries one account’s near side into another account’s first row', () => {
    // Two Roth IRAs: acc-2's first row has nothing before it on its own account, so it is compared against nothing even though acc-1, walked first, leaves a $100,000 ending; the boundary chain is per account, the year walk pool-level.
    const rows = [
      row({
        year: 2020,
        startingBalance: 100_000,
        totalContributions: 5_000,
        endingBalance: 100_000,
      }),
      row({ accountId: 'acc-2', year: 2021, startingBalance: 10_000, endingBalance: 10_000 }),
    ];

    // A leaked near side charges a fabricated $90,000 in 2021, wiping real basis.
    expect(totalChargedCents(rows, ['acc-1', 'acc-2'], c(5_000))).toBe(0);
    expect(
      deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), rows).regularContributionBasisCents,
    ).toBe(c(5_000));
  });

  it('never compares an account with no positive-starting row anywhere', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2020, endingBalance: 100_000 }),
        row({ year: 2021, endingBalance: 60_000 }),
        row({ year: 2022, endingBalance: 60_000 }),
      ],
      ['acc-1'],
    );

    // Accepted, disclosed gap — the shape newest-year-first data entry produces.
    expect(charged).toBe(0);
  });

  it('imputes nothing for a withdrawal fully offset by untracked growth', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
        // A real $10,000 withdrawal plus $15,000 of growth reads as an increase.
        row({ year: 2021, startingBalance: 105_000, endingBalance: 105_000 }),
      ],
      ['acc-1'],
    );

    // A disclosed residual of the derivation, pinned as accepted rather than as a bug.
    expect(charged).toBe(0);
  });
});

describe('conversion lots', () => {
  it('consumes a lot only after contribution basis is exhausted', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2015,
        rollover: 200_000,
        endingBalance: 200_000,
        rothConversionTaxableAmount: 200_000,
      }),
      row({
        year: 2020,
        startingBalance: 200_000,
        distributions: 100_000,
        endingBalance: 100_000,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(0);
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2015,
        taxableConvertedPrincipalCents: c(100_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });

  it('falls through from an imputed shortfall into the lots', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
      row({
        year: 2015,
        rollover: 200_000,
        endingBalance: 200_000,
        rothConversionTaxableAmount: 200_000,
      }),
      row({ accountId: 'acc-2', year: 2016, totalContributions: 20_000, endingBalance: 20_000 }),
      row({ year: 2019, startingBalance: 200_000, endingBalance: 200_000 }),
      row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
    ]);

    // The $100,000 shortfall takes $20,000 of basis then $80,000 of the lot.
    expect(derived.regularContributionBasisCents).toBe(0);
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2015,
        taxableConvertedPrincipalCents: c(120_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });

  it('builds a lot from a conversion row whose only recorded amount is nontaxable', () => {
    // A nondeductible-IRA (backdoor) conversion: the whole principal is nontaxable basis, nothing taxable. A lot gate reading only the taxable amount builds no lot and the principal falls through as untracked earnings.
    const conversionRow = row({
      year: 2015,
      rollover: 30_000,
      endingBalance: 30_000,
      rothConversionNontaxableAmount: 30_000,
    });
    const wholeLot = {
      taxYear: 2015,
      taxableConvertedPrincipalCents: 0,
      nontaxableConvertedPrincipalCents: c(30_000),
    };

    expect(deriveRothPoolBasisCents(pool('acc-1'), [conversionRow]).conversionLots).toEqual([
      wholeLot,
    ]);

    const drawn = deriveRothPoolBasisCents(pool('acc-1'), [
      conversionRow,
      row({ year: 2020, startingBalance: 30_000, distributions: 10_000, endingBalance: 20_000 }),
    ]);

    // No contribution basis anywhere, so the $10,000 comes straight off the lot.
    expect(drawn.regularContributionBasisCents).toBe(0);
    expect(drawn.conversionLots).toEqual([
      { ...wholeLot, nontaxableConvertedPrincipalCents: c(20_000) },
    ]);
  });

  it('reads a conversion-lot-only row between two real years', () => {
    const rows = [
      row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
      row({ year: 2021, rothConversionTaxableAmount: 50_000 }),
      row({ year: 2022, startingBalance: 100_000, endingBalance: 100_000 }),
    ];
    const derived = deriveRothPoolBasisCents(pool('acc-1'), rows);

    expect(totalChargedCents(rows, ['acc-1'])).toBe(0);
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2021,
        taxableConvertedPrincipalCents: c(50_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });

  // Two accounts converting in 2015 merge into one $90,000-taxable / $60,000-nontaxable lot; a third lot of $25,000 / $5,000 lands in 2018.
  const mergedLotRows = [
    row({
      year: 2015,
      rollover: 100_000,
      endingBalance: 100_000,
      rothConversionTaxableAmount: 60_000,
      rothConversionNontaxableAmount: 40_000,
    }),
    row({
      accountId: 'acc-2',
      year: 2015,
      rollover: 50_000,
      endingBalance: 50_000,
      rothConversionTaxableAmount: 30_000,
      rothConversionNontaxableAmount: 20_000,
    }),
    row({
      year: 2018,
      startingBalance: 100_000,
      endingBalance: 200_000,
      rothConversionTaxableAmount: 25_000,
      rothConversionNontaxableAmount: 5_000,
    }),
  ];

  // The same two lots as the engine's mutable carrier holds them, fresh per call because applyFactBasedRothIraOrdering mutates the entry.
  const mergedLotEntry = () => ({
    rothBasisRemainingCents: 0,
    rothCumulativeWithdrawnCents: 0,
    conversionLots: [
      { taxYear: 2015, taxableRemainingCents: c(90_000), nontaxableRemainingCents: c(60_000) },
      { taxYear: 2018, taxableRemainingCents: c(25_000), nontaxableRemainingCents: c(5_000) },
    ],
  });

  const asDerivedLots = (entry: ReturnType<typeof mergedLotEntry>) =>
    entry.conversionLots.map((lot) => ({
      taxYear: lot.taxYear,
      taxableConvertedPrincipalCents: lot.taxableRemainingCents,
      nontaxableConvertedPrincipalCents: lot.nontaxableRemainingCents,
    }));

  it('allocates taxable before nontaxable and years FIFO, like the engine', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
      ...mergedLotRows,
      row({
        year: 2020,
        startingBalance: 200_000,
        distributions: 120_000,
        endingBalance: 80_000,
      }),
    ]);

    // The same lots through the engine's own ordered allocator must leave the same remainders (a lot consumed to nothing is omitted from the derivation's output).
    const entry = mergedLotEntry();
    applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: c(120_000),
      distributionTaxYear: 2020,
      ownerReached59Half: true,
    });

    expect(derived.conversionLots).toEqual(asDerivedLots(entry));
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2015,
        taxableConvertedPrincipalCents: 0,
        nontaxableConvertedPrincipalCents: c(30_000),
      },
      {
        taxYear: 2018,
        taxableConvertedPrincipalCents: c(25_000),
        nontaxableConvertedPrincipalCents: c(5_000),
      },
    ]);
  });

  it('omits a lot consumed to nothing, exactly as the engine prunes it', () => {
    // $150,000 takes the whole 2015 lot — $90,000 taxable then $60,000 nontaxable.
    const derived = deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
      ...mergedLotRows,
      row({
        year: 2020,
        startingBalance: 200_000,
        distributions: 150_000,
        endingBalance: 50_000,
      }),
    ]);

    const entry = mergedLotEntry();
    applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: c(150_000),
      distributionTaxYear: 2020,
      ownerReached59Half: true,
    });

    expect(derived.conversionLots).toEqual(asDerivedLots(entry));
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2018,
        taxableConvertedPrincipalCents: c(25_000),
        nontaxableConvertedPrincipalCents: c(5_000),
      },
    ]);
  });

  it('draws a lot converted in the very year of the outflow', () => {
    // A lot is available in its own year, before that year's outflow is consumed; available only from the following year, the whole $200,000 would stand untouched.
    const derived = deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
      row({
        year: 2020,
        rollover: 200_000,
        endingBalance: 200_000,
        rothConversionTaxableAmount: 200_000,
      }),
      row({ accountId: 'acc-2', year: 2019, rollover: 50_000, endingBalance: 50_000 }),
      row({
        accountId: 'acc-2',
        year: 2020,
        startingBalance: 50_000,
        distributions: 50_000,
        endingBalance: 0,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(0);
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2020,
        taxableConvertedPrincipalCents: c(150_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });

  it('leaves a lot dated after the outflow’s year untouched', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        startingBalance: 100_000,
        distributions: 100_000,
        endingBalance: 0,
      }),
      row({
        year: 2021,
        rollover: 50_000,
        endingBalance: 50_000,
        rothConversionTaxableAmount: 50_000,
      }),
    ]);

    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2021,
        taxableConvertedPrincipalCents: c(50_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });
});

describe('import-bundle validation boundary', () => {
  // A magnitude just past isValidRothMoney's bound whose ×100 is still a safe integer: what the cents conversion alone would let through, reachable because an import-bundle row never meets the migrations.
  const OUT_OF_RANGE_DOLLARS = 90_071_992_547_409.02;

  it('reads an out-of-range imported amount as $0 in every nonnegative field', () => {
    const contributed = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        totalContributions: OUT_OF_RANGE_DOLLARS,
        endingBalance: OUT_OF_RANGE_DOLLARS,
      }),
    ]);
    const converted = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        rollover: OUT_OF_RANGE_DOLLARS,
        endingBalance: OUT_OF_RANGE_DOLLARS,
        rothConversionTaxableAmount: OUT_OF_RANGE_DOLLARS,
        rothConversionNontaxableAmount: OUT_OF_RANGE_DOLLARS,
      }),
    ]);

    expect(contributed.regularContributionBasisCents).toBe(0);
    expect(converted.conversionLots).toEqual([]);
    // An out-of-range starting balance imputes no residual, and out-of-range distributions charge nothing, leaving the row's own $100,000 imputed.
    expect(
      totalChargedCents(
        [row({ year: 2020, startingBalance: OUT_OF_RANGE_DOLLARS, endingBalance: 0 })],
        ['acc-1'],
      ),
    ).toBe(0);
    expect(
      totalChargedCents(
        [
          row({
            year: 2020,
            startingBalance: 100_000,
            distributions: OUT_OF_RANGE_DOLLARS,
            endingBalance: 0,
          }),
        ],
        ['acc-1'],
      ),
    ).toBe(c(100_000));
  });

  it('reads an out-of-range company figure as $0 rather than wiping the personal credit', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        totalContributions: 8_000,
        companyContributions: OUT_OF_RANGE_DOLLARS,
        endingBalance: 8_000,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(c(8_000));
  });

  // $50T is valid for a single field against isValidRothMoney's ~$90.07T bound but two sum past it: the shape only a MIXED row's split fields carry.
  const IN_RANGE_SPLIT_DOLLARS = 50_000_000_000_000;

  it('converts MIXED contribution splits per field, not as one out-of-range total', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2015,
        rollover: 20_000_000_000_000,
        endingBalance: 20_000_000_000_000,
        rothConversionTaxableAmount: 20_000_000_000_000,
      }),
      row({
        year: 2020,
        startingBalance: 20_000_000_000_000,
        contributionsPostTax: IN_RANGE_SPLIT_DOLLARS,
        companyContributionsPostTax: IN_RANGE_SPLIT_DOLLARS,
        endingBalance: 20_000_000_000_000,
      }),
      row({
        year: 2021,
        startingBalance: 20_000_000_000_000,
        distributions: 20_000_000_000_000,
        endingBalance: 0,
      }),
    ]);

    // Resolved through the shared dollar total, the $100T aggregate reads as $0 and takes the valid $50T post-tax split with it; the 2021 withdrawal then eats the 2015 conversion lot.
    expect(derived.regularContributionBasisCents).toBe(c(30_000_000_000_000));
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2015,
        taxableConvertedPrincipalCents: c(20_000_000_000_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });

  it('credits neither MIXED company split, whatever their sum reads as', () => {
    // Employer money is never §408A basis and on a MIXED row the splits separate it out; crediting the four-way total reads $110T, past MAX_SAFE_INTEGER cents, collapsing to $0 and losing the real $10T.
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({
        year: 2020,
        contributionsPostTax: 10_000_000_000_000,
        companyContributionsPreTax: IN_RANGE_SPLIT_DOLLARS,
        companyContributionsPostTax: IN_RANGE_SPLIT_DOLLARS,
      }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(c(10_000_000_000_000));
  });

  it('drops a merged lot whole when either half outgrows a safe integer', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1', 'acc-2'), [
      row({
        year: 2015,
        rollover: IN_RANGE_SPLIT_DOLLARS,
        endingBalance: IN_RANGE_SPLIT_DOLLARS,
        rothConversionTaxableAmount: IN_RANGE_SPLIT_DOLLARS,
        rothConversionNontaxableAmount: 1,
      }),
      row({
        accountId: 'acc-2',
        year: 2015,
        rollover: IN_RANGE_SPLIT_DOLLARS,
        endingBalance: IN_RANGE_SPLIT_DOLLARS,
        rothConversionTaxableAmount: IN_RANGE_SPLIT_DOLLARS,
        rothConversionNontaxableAmount: 1,
      }),
      row({
        year: 2018,
        rollover: 30_000,
        endingBalance: 30_000,
        rothConversionTaxableAmount: 30_000,
      }),
    ]);

    // Every field is valid alone, but the two accounts merge into one 2015 lot whose $100T taxable principal exceeds MAX_SAFE_INTEGER cents; collapsing that half alone leaves a $0/$2 lot and a pre-59½ draw would take the $2 with no §72(t) recapture base, so the whole lot goes and the outflow falls through to untracked earnings.
    expect(derived.conversionLots).toEqual([
      {
        taxYear: 2018,
        taxableConvertedPrincipalCents: c(30_000),
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
  });

  it('reads a negative distributions as $0', () => {
    const charged = totalChargedCents(
      [
        row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
        row({
          year: 2021,
          startingBalance: 90_000,
          distributions: -5_000,
          endingBalance: 85_000,
        }),
      ],
      ['acc-1'],
    );

    // Only the $10,000 shortfall; a negative let through would credit $5,000 of outflow back and charge $5,000.
    expect(charged).toBe(c(10_000));
  });

  it('reads an unusable rollover as $0 in a span that would otherwise net it', () => {
    const span = (rollover: number) => [
      row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
      row({ year: 2021, rollover, endingBalance: 70_000 }),
      row({ year: 2022, startingBalance: 60_000, endingBalance: 60_000 }),
    ];

    expect(totalChargedCents(span(-30_000), ['acc-1'])).toBe(c(10_000));
    expect(totalChargedCents(span(Number.NaN), ['acc-1'])).toBe(c(40_000));
    expect(totalChargedCents(span(1e308), ['acc-1'])).toBe(c(40_000));
    expect(totalChargedCents(span(-OUT_OF_RANGE_DOLLARS), ['acc-1'])).toBe(c(40_000));
  });

  const spanRows = [
    row({ year: 2020, startingBalance: 100_000, endingBalance: 100_000 }),
    row({ year: 2022, startingBalance: 60_000, endingBalance: 60_000 }),
  ];

  for (const year of [1997, 2201, 2020.5]) {
    it(`drops a row dated ${year} whole — no lot, no basis, no boundary side`, () => {
      const invalidRow = row({
        year,
        totalContributions: 5_000,
        endingBalance: 5_000,
        rothConversionTaxableAmount: 50_000,
      });

      // Kept, the row would credit $5,000 of basis, carry a lot, and net its contributions into the $40,000 shortfall.
      expect(deriveRothPoolBasisCents(pool('acc-1'), [...spanRows, invalidRow])).toEqual(
        deriveRothPoolBasisCents(pool('acc-1'), spanRows),
      );
      expect(totalChargedCents([...spanRows, invalidRow], ['acc-1'])).toBe(c(40_000));
    });
  }
});

describe('duplicate (accountId, year) rows', () => {
  it('keeps the first row in input order, never the sum', () => {
    const derived = deriveRothPoolBasisCents(pool('acc-1'), [
      row({ year: 2020, totalContributions: 6_000, endingBalance: 6_000 }),
      row({ year: 2020, totalContributions: 9_000, endingBalance: 9_000 }),
    ]);

    expect(derived.regularContributionBasisCents).toBe(c(6_000));
  });
});
