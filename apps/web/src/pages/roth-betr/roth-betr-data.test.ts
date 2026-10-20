/**
 * `buildRothBETRPageData` — page-data adapter tests.
 *
 * Covers the null-return guards, the MIXED-vs-PRE_TAX backdoor balance math,
 * the `backdoorRothAvailable` $0 trigger, the pair-valid account-picker
 * partition, and the `parentCap` disable-sentinel coercion.
 */
import { describe, expect, it } from 'vitest';
import { buildRothBETRPageData, type RothBETRDataInput } from './roth-betr-data';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../../db/types';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';

const TODAY_YEAR = 2026;
const TODAY_MONTH = 5;

function member(
  id: string,
  isPrimary: boolean,
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
      firstName: id,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function ssBenefit(memberId: string, pia: number | null): Aggregate<SocialSecurityBenefitPayload> {
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

function account(
  id: string,
  ownerId: string,
  type: AccountPayload['type'],
  taxTreatment: AccountPayload['taxTreatment'],
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
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId,
      institution: 'X',
      notes: '',
      planningReturnPct: 5,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
  endingBalancePostTax: number | null = null,
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
      endingBalancePostTax,
      totalContributions: 0,
      comment: null,
    },
  };
}

function scenario(
  id: string,
  extraOverrides: Partial<ScenarioAggregate['payload']['overrides']> = {},
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
      name: id,
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
        ...extraOverrides,
      },
    },
  };
}

/** A projecting fixture: a 60-year-old primary with a funded pre-tax IRA and
 *  two years of balance history (enough to project a drawdown). */
function projectingInput(overrides: Partial<RothBETRDataInput> = {}): RothBETRDataInput {
  const birthYear = TODAY_YEAR - 60;
  const members = [member('m1', true, birthYear)];
  const accounts = [account('ira1', 'm1', 'RETIREMENT_IRA', 'PRE_TAX')];
  const balances = [
    balanceRow('ira1', TODAY_YEAR - 2, 900_000),
    balanceRow('ira1', TODAY_YEAR - 1, 1_000_000),
  ];
  return {
    scenarios: [scenario('s1')],
    selectedScenarioId: 's1',
    accounts,
    balances,
    members,
    ssBenefits: [ssBenefit('m1', 2_000)],
    expenses: [],
    incomeStreams: [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH,
    ...overrides,
  };
}

describe('buildRothBETRPageData', () => {
  it('returns null when the selected scenario does not exist', () => {
    const input = projectingInput({ selectedScenarioId: 'missing' });
    expect(buildRothBETRPageData(input)).toBeNull();
  });

  it('throws (no primary) before the page guard when no member is primary', () => {
    // The shared runner raises NoPrimaryRetirementError for a household with no
    // primary; the page memo lets non-domain errors surface to ErrorBoundary.
    const input = projectingInput({ members: [member('m1', false, TODAY_YEAR - 60)] });
    expect(() => buildRothBETRPageData(input)).toThrow();
  });

  it('returns a populated page-data bundle for a projectable scenario', () => {
    const data = buildRothBETRPageData(projectingInput());
    expect(data).not.toBeNull();
    expect(data?.ctx.ownerBirthYear).toBe(TODAY_YEAR - 60);
    // The funded pre-tax IRA → backdoor pathway NOT available.
    expect(data?.backdoorRothAvailable).toBe(false);
  });

  it('flags backdoorRothAvailable when the aggregated pre-tax IRA balance is $0', () => {
    // A funded brokerage keeps the projection non-null; the pre-tax IRA's latest
    // stored balance is $0 → the backdoor trigger fires.
    const accounts = [
      account('ira1', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('brk1', 'm1', 'BROKERAGE', 'POST_TAX'),
    ];
    const data = buildRothBETRPageData(
      projectingInput({
        accounts,
        balances: [
          balanceRow('ira1', TODAY_YEAR - 2, 0),
          balanceRow('ira1', TODAY_YEAR - 1, 0),
          balanceRow('brk1', TODAY_YEAR - 2, 900_000),
          balanceRow('brk1', TODAY_YEAR - 1, 1_000_000),
        ],
      }),
    );
    expect(data).not.toBeNull();
    expect(data?.backdoorRothAvailable).toBe(true);
  });

  it('counts only the pre-tax sub-bucket of a MIXED account toward the backdoor balance', () => {
    // A MIXED IRA with ending 100k of which 100k is post-tax → pre-tax basis 0;
    // a funded brokerage keeps the projection non-null. (endingBalance −
    // endingBalancePostTax = 0 → backdoor available.)
    const accounts = [
      account('mix1', 'm1', 'RETIREMENT_IRA', 'MIXED'),
      account('brk1', 'm1', 'BROKERAGE', 'POST_TAX'),
    ];
    const data = buildRothBETRPageData(
      projectingInput({
        accounts,
        balances: [
          balanceRow('mix1', TODAY_YEAR - 2, 90_000, 90_000),
          balanceRow('mix1', TODAY_YEAR - 1, 100_000, 100_000),
          balanceRow('brk1', TODAY_YEAR - 2, 900_000),
          balanceRow('brk1', TODAY_YEAR - 1, 1_000_000),
        ],
      }),
    );
    expect(data).not.toBeNull();
    expect(data?.backdoorRothAvailable).toBe(true);
  });

  it('restricts source pickers to active convertible accounts and Roth targets to a matching owner', () => {
    const members = [member('m1', true, TODAY_YEAR - 60), member('m2', false, TODAY_YEAR - 58)];
    const accounts = [
      account('ira1', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('ira-inactive', 'm1', 'RETIREMENT_IRA', 'PRE_TAX', false),
      account('roth-self', 'm1', 'RETIREMENT_ROTH_IRA', 'POST_TAX'),
      account('roth-other', 'm2', 'RETIREMENT_ROTH_IRA', 'POST_TAX'),
    ];
    const data = buildRothBETRPageData(
      projectingInput({
        members,
        accounts,
        balances: [
          balanceRow('ira1', TODAY_YEAR - 2, 900_000),
          balanceRow('ira1', TODAY_YEAR - 1, 1_000_000),
        ],
      }),
    );
    expect(data).not.toBeNull();
    const sourceIds = data!.sourceAccounts.map((a) => a.id);
    expect(sourceIds).toContain('ira1');
    expect(sourceIds).not.toContain('ira-inactive'); // inactive excluded
    const rothIds = data!.rothIraAccounts.map((a) => a.id);
    expect(rothIds).toContain('roth-self'); // same owner as a source
    expect(rothIds).not.toContain('roth-other'); // cross-owner pair pruned
    // Each option carries its owner so the Apply dialog can pair a Roth target
    // to the SAME-owner source.
    expect(data!.sourceAccounts.find((a) => a.id === 'ira1')?.ownerId).toBe('m1');
    expect(data!.rothIraAccounts.find((a) => a.id === 'roth-self')?.ownerId).toBe('m1');
  });

  it('coerces a disable-sentinel parent MAGI cap to undefined', () => {
    const data = buildRothBETRPageData(projectingInput());
    expect(data).not.toBeNull();
    // No magiCap override anywhere → resolved cap absent → parentCap undefined.
    expect(data?.parentCap).toBeUndefined();
  });
});

/**
 * `iraConversionOwnerBoundary` derivation. TODAY_YEAR = 2026;
 * every fixture birthdate is `YYYY-01-01`, so the 59½-crossing year is
 * `birthYear + 59` (Jan + 6 months = July of that year). An owner is
 * penalty-exposed "now" when that crossing year is `>= 2026`, i.e. born `>= 1967`.
 */
function memberWithBirthdate(
  id: string,
  isPrimary: boolean,
  birthdate: string,
): Aggregate<HouseholdMemberPayload> {
  const m = member(id, isPrimary, 1970);
  return { ...m, payload: { ...m.payload, birthdate } };
}

describe('buildRothBETRPageData — iraConversionOwnerBoundary', () => {
  it('reports the crossing year + first name for a single under-59½ penalty-carrying source owner', () => {
    // Primary born 1970 → 59½ in 2029 (>= 2026) → exposed.
    const data = buildRothBETRPageData(
      projectingInput({ members: [member('Robin', true, 1970)], accounts: [account('ira1', 'Robin', 'RETIREMENT_IRA', 'PRE_TAX')], balances: [balanceRow('ira1', TODAY_YEAR - 2, 900_000), balanceRow('ira1', TODAY_YEAR - 1, 1_000_000)] }),
    );
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toEqual({ year: 2029, firstName: 'Robin' });
  });

  it('returns undefined when the only owner already cleared 59½ in a prior year', () => {
    // The default fixture primary is born 1966 → 59½ in 2025 (< 2026) → not exposed.
    const data = buildRothBETRPageData(projectingInput());
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toBeUndefined();
  });

  it('treats the crossing year itself as exposed (>= currentCalendarYear)', () => {
    // Born 1967 → 59½ in 2026 == currentCalendarYear → exposed, boundary 2026.
    const data = buildRothBETRPageData(
      projectingInput({ members: [member('Sam', true, 1967)], accounts: [account('ira1', 'Sam', 'RETIREMENT_IRA', 'PRE_TAX')] }),
    );
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toEqual({ year: 2026, firstName: 'Sam' });
  });

  it('picks the LATEST crossing year (youngest owner) when two eligible owners differ', () => {
    const members = [member('Alex', true, 1968), member('Blair', false, 1972)];
    const accounts = [
      account('ira-a', 'Alex', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('ira-b', 'Blair', 'RETIREMENT_IRA', 'PRE_TAX'),
    ];
    const data = buildRothBETRPageData(
      projectingInput({
        members,
        accounts,
        balances: [
          balanceRow('ira-a', TODAY_YEAR - 2, 900_000),
          balanceRow('ira-a', TODAY_YEAR - 1, 1_000_000),
          balanceRow('ira-b', TODAY_YEAR - 2, 500_000),
          balanceRow('ira-b', TODAY_YEAR - 1, 600_000),
        ],
      }),
    );
    expect(data).not.toBeNull();
    // Alex 1968 → 2027; Blair 1972 → 2031. Latest wins.
    expect(data?.iraConversionOwnerBoundary).toEqual({ year: 2031, firstName: 'Blair' });
  });

  it('returns undefined when there are no eligible convertible sources', () => {
    const data = buildRothBETRPageData(
      projectingInput({
        members: [member('Robin', true, 1970)],
        accounts: [account('brk1', 'Robin', 'BROKERAGE', 'POST_TAX')],
        balances: [
          balanceRow('brk1', TODAY_YEAR - 2, 900_000),
          balanceRow('brk1', TODAY_YEAR - 1, 1_000_000),
        ],
      }),
    );
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toBeUndefined();
  });

  it('excludes a §72(t)-type-exempt 457(b) source even for an under-59½ owner (a)', () => {
    // A governmental 457(b) is a valid convertible source but carries no 10%
    // penalty, so its under-59½ owner contributes no boundary.
    const data = buildRothBETRPageData(
      projectingInput({
        members: [member('Robin', true, 1970)],
        accounts: [account('457-1', 'Robin', 'RETIREMENT_457B', 'PRE_TAX')],
        balances: [
          balanceRow('457-1', TODAY_YEAR - 2, 900_000),
          balanceRow('457-1', TODAY_YEAR - 1, 1_000_000),
        ],
      }),
    );
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toBeUndefined();
  });

  it('returns undefined when the under-59½ owner holds only a 457(b) and an older owner holds the IRA', () => {
    // Primary born 1966 (cleared 59½ in 2025) holds the IRA; the under-59½
    // secondary (born 1975) holds only a penalty-exempt 457(b) → no boundary.
    const members = [member('Pat', true, 1966), member('Jamie', false, 1975)];
    const accounts = [
      account('ira-pat', 'Pat', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('457-jamie', 'Jamie', 'RETIREMENT_457B', 'PRE_TAX'),
    ];
    const data = buildRothBETRPageData(
      projectingInput({
        members,
        accounts,
        balances: [
          balanceRow('ira-pat', TODAY_YEAR - 2, 900_000),
          balanceRow('ira-pat', TODAY_YEAR - 1, 1_000_000),
          balanceRow('457-jamie', TODAY_YEAR - 2, 200_000),
          balanceRow('457-jamie', TODAY_YEAR - 1, 220_000),
        ],
      }),
    );
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toBeUndefined();
  });

  it('excludes a user-flagged-exempt IRA even when its type carries the penalty (b)', () => {
    const data = buildRothBETRPageData(
      projectingInput({
        scenarios: [scenario('s1', { earlyWithdrawalPenaltyExemptAccountIds: ['ira1'] })],
        members: [member('Robin', true, 1970)],
        accounts: [account('ira1', 'Robin', 'RETIREMENT_IRA', 'PRE_TAX')],
      }),
    );
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toBeUndefined();
  });

  it('skips a dangling or unparseable-birthdate source owner without throwing', () => {
    // Valid projectable primary (born 1966 → cleared 59½ → no boundary of its
    // own). Two extra penalty-carrying IRAs: one owned by a nonexistent member,
    // one owned by a member with an unparseable birthdate. Both are skipped;
    // derivation never throws and yields no spurious boundary.
    const members = [
      member('Pat', true, 1966),
      memberWithBirthdate('Ghosty', false, '1970'), // unparseable (no -MM-DD)
    ];
    const accounts = [
      account('ira-pat', 'Pat', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('ira-dangling', 'no-such-member', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('ira-badbd', 'Ghosty', 'RETIREMENT_IRA', 'PRE_TAX'),
    ];
    const run = (): ReturnType<typeof buildRothBETRPageData> =>
      buildRothBETRPageData(
        projectingInput({
          members,
          accounts,
          balances: [
            balanceRow('ira-pat', TODAY_YEAR - 2, 900_000),
            balanceRow('ira-pat', TODAY_YEAR - 1, 1_000_000),
          ],
        }),
      );
    expect(run).not.toThrow();
    const data = run();
    expect(data).not.toBeNull();
    expect(data?.iraConversionOwnerBoundary).toBeUndefined();
  });
});

describe('buildRothBETRPageData — ACA benchmark for the retirement year', () => {
  /** A pre-65 retirement so the probe's retirement year has Marketplace months
   *  at all (retiring at 67 puts the member on Medicare for the whole year). */
  const retireAt62 = {
    retirementAge: {
      primary: { ageYears: 62, ageMonths: 0 },
      secondary: { ageYears: 62, ageMonths: 0 },
    },
  };

  it('passes a whole-year benchmark override through unchanged for a full covered year', () => {
    const base = buildRothBETRPageData(
      projectingInput({ scenarios: [scenario('s1', retireAt62)] }),
    );
    expect(base).not.toBeNull();
    const retirementYear = base!.ctx.retirementYear;

    const data = buildRothBETRPageData(
      projectingInput({
        scenarios: [
          scenario('s1', {
            ...retireAt62,
            acaPtcBenchmark: [{ taxYear: retirementYear, annualSlcspDollars: 12_000 }],
          }),
        ],
      }),
    );
    expect(data?.ctx.acaCoverageMonths).toBe(12);
    expect(data?.ctx.benchmarkAnnualSlcspCents).toBe(1_200_000);
  });

  it('prorates the whole-year override to the household coverage months', () => {
    // §36B(b)(2) sums the credit over coverage months, and `computeAcaPtc`
    // prorates the expected contribution by `acaCoverageMonths`. A verbatim
    // 12-month benchmark against a 7-month contribution would make the probe
    // report a "lost credit" ~$5,000/yr larger than the projection can lose.
    const base = buildRothBETRPageData(
      projectingInput({ scenarios: [scenario('s1', retireAt62)] }),
    );
    const retirementYear = base!.ctx.retirementYear;

    const data = buildRothBETRPageData(
      projectingInput({
        scenarios: [
          scenario('s1', {
            ...retireAt62,
            acaPtcBenchmark: [{ taxYear: retirementYear, annualSlcspDollars: 12_000 }],
            healthCoverageMonths: {
              perMember: { m1: { [retirementYear]: { marketplaceMonths: 7 } } },
            },
          }),
        ],
      }),
    );
    expect(data?.ctx.acaCoverageMonths).toBe(7);
    expect(data?.ctx.benchmarkAnnualSlcspCents).toBe(700_000);
  });

  it('grows the rough benchmark to the retirement year at the scenario medical rate', () => {
    // General inflation 4% with no Medical rate → medical 6%. The member is 62
    // in the retirement year (2028): $700 × 1.05² = $771.75 a month, × 12 =
    // 926,100 cents, × 1.06² (two years past the 2026 base year) = 1,040,566.
    const data = buildRothBETRPageData(
      projectingInput({
        scenarios: [scenario('s1', { ...retireAt62, inflation: { ratePct: 4 } })],
      }),
    );
    expect(data?.ctx.retirementYear).toBe(2028);
    expect(data?.ctx.acaCoverageMonths).toBe(12);
    expect(data?.ctx.benchmarkAnnualSlcspCents).toBe(1_040_566);
    // General inflation alone (1.04²) or the age rate (1.05²) would not match.
    expect(data?.ctx.benchmarkAnnualSlcspCents).not.toBe(Math.round(926_100 * 1.04 * 1.04));
  });

  it('uses an explicit Medical category rate, and never scales an entered price', () => {
    const medical7 = { inflation: { ratePct: 4, categoryRates: { 'cat-medical': 7 } } };
    const rough = buildRothBETRPageData(
      projectingInput({ scenarios: [scenario('s1', { ...retireAt62, ...medical7 })] }),
    );
    expect(rough?.ctx.benchmarkAnnualSlcspCents).toBe(Math.round(926_100 * 1.07 * 1.07));
    const entered = buildRothBETRPageData(
      projectingInput({
        scenarios: [
          scenario('s1', {
            ...retireAt62,
            ...medical7,
            acaPtcBenchmark: [{ taxYear: 2028, annualSlcspDollars: 12_000 }],
          }),
        ],
      }),
    );
    expect(entered?.ctx.benchmarkAnnualSlcspCents).toBe(1_200_000);
  });
});
