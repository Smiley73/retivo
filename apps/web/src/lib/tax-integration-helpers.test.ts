/**
 * Unit tests for tax-integration pure helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  anyMemberHasAcaCoverage,
  anyMemberOnMedicare,
  automaticMedicareMonthsInYear,
  defaultHouseholdSlcspByAge,
  householdMarketplaceCoverageMonths,
  irmaaBeneficiaryEnrollments,
  overrideBenchmarkCentsForCoverageMonths,
  readStoredCoverageMonths,
  resolveCoverageMonths,
  resolveMemberHealthCoverage,
  storedAcaBenchmarkOverrides,
  storedCoverageMonthEntries,
  type TaxMemberInput,
} from './tax-integration-helpers';
import { roughMonthlyBenchmarkCentsForMember } from './aca-ptc';

function member(overrides: Partial<TaxMemberInput> = {}): TaxMemberInput {
  return {
    memberId: 'm',
    isoBirthdate: '1965-01-01',
    onMedicare: false,
    hasAcaCoverage: true,
    ...overrides,
  };
}

/** The per-member per-month benchmark, in whole dollars — the independent
 *  restatement of what `defaultHouseholdSlcspByAge` must now produce. */
function monthlyDollars(age: number, months: number): number {
  return (roughMonthlyBenchmarkCentsForMember(age) * months) / 100;
}

// ---------------------------------------------------------------------------
// Default SLCSP = SUM over covered members of their own
// age-priced monthly premium × their covered months
// ---------------------------------------------------------------------------
describe('defaultHouseholdSlcspByAge (per-member sum)', () => {
  it('prices only the ACA-covered member (spouse-only-on-ACA household)', () => {
    // Primary not on ACA; only the older spouse has ACA coverage. The benchmark
    // must follow the covered (spouse) age, not the primary's.
    const members: TaxMemberInput[] = [
      member({ memberId: 'primary', isoBirthdate: '1970-01-01', hasAcaCoverage: false }),
      member({ memberId: 'spouse', isoBirthdate: '1958-01-01', hasAcaCoverage: true }),
    ];
    const taxYear = 2026;
    // Only the spouse (age 68) is covered → a full year of the age-68 premium.
    expect(defaultHouseholdSlcspByAge(members, taxYear)).toBeCloseTo(
      monthlyDollars(2026 - 1958, 12),
      6,
    );
  });

  it('sums EACH covered member at their OWN age, not the oldest × the covered count', () => {
    const members: TaxMemberInput[] = [
      member({ memberId: 'primary', isoBirthdate: '1962-01-01', hasAcaCoverage: true }),
      member({ memberId: 'spouse', isoBirthdate: '1965-01-01', hasAcaCoverage: true }),
    ];
    const taxYear = 2026;
    const expected = monthlyDollars(2026 - 1962, 12) + monthlyDollars(2026 - 1965, 12);
    expect(defaultHouseholdSlcspByAge(members, taxYear)).toBeCloseTo(expected, 6);
    // A single-premium approximation would over-price the younger spouse by
    // anchoring the whole household to the oldest member's premium.
    expect(defaultHouseholdSlcspByAge(members, taxYear)).toBeLessThan(
      monthlyDollars(2026 - 1962, 12) * 2,
    );
  });

  it('prorates a part-year Marketplace member by their covered months', () => {
    const members: TaxMemberInput[] = [
      member({
        memberId: 'primary',
        isoBirthdate: '1961-01-01',
        hasAcaCoverage: true,
        marketplaceCoverageMonths: 5,
      }),
    ];
    expect(defaultHouseholdSlcspByAge(members, 2026)).toBeCloseTo(
      monthlyDollars(2026 - 1961, 5),
      6,
    );
  });

  it('excludes Medicare members from the covered set', () => {
    const members: TaxMemberInput[] = [
      member({ memberId: 'primary', isoBirthdate: '1955-01-01', hasAcaCoverage: true, onMedicare: true }),
      member({ memberId: 'spouse', isoBirthdate: '1963-01-01', hasAcaCoverage: true }),
    ];
    const taxYear = 2026;
    // Primary is on Medicare → not ACA-covered; only spouse (age 63) counts.
    expect(defaultHouseholdSlcspByAge(members, taxYear)).toBeCloseTo(
      monthlyDollars(2026 - 1963, 12),
      6,
    );
  });

  it('returns 0 when no member has ACA coverage', () => {
    const members: TaxMemberInput[] = [
      member({ memberId: 'primary', hasAcaCoverage: false }),
    ];
    expect(defaultHouseholdSlcspByAge(members, 2026)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Month resolution + engagement gates
// ---------------------------------------------------------------------------
describe('resolveCoverageMonths', () => {
  it('falls back to the whole-year flags when no months are stored', () => {
    expect(resolveCoverageMonths(member({ onMedicare: true, hasAcaCoverage: false }))).toEqual({
      partBMonths: 12,
      partDMonths: 12,
      marketplaceMonths: 0,
    });
    expect(resolveCoverageMonths(member({ onMedicare: false, hasAcaCoverage: true }))).toEqual({
      partBMonths: 0,
      partDMonths: 0,
      marketplaceMonths: 12,
    });
  });

  it('resolves Part B and Part D INDEPENDENTLY from the stored months', () => {
    const m = member({ onMedicare: true, partBEnrollmentMonths: 7, partDEnrollmentMonths: 0 });
    expect(resolveCoverageMonths(m)).toEqual({
      partBMonths: 7,
      partDMonths: 0,
      marketplaceMonths: 0,
    });
  });

  it('lets an explicit Marketplace month count win over the whole-year flag', () => {
    // The opt-out precedence is applied upstream (the runner leaves the field
    // off for an opted-out member with no stated months); a STATED count wins.
    const m = member({ hasAcaCoverage: false, marketplaceCoverageMonths: 4 });
    expect(resolveCoverageMonths(m).marketplaceMonths).toBe(4);
  });

  it('clamps a corrupt stored month count into the statutory 0..12 range', () => {
    expect(
      resolveCoverageMonths(
        member({ partBEnrollmentMonths: 12, partDEnrollmentMonths: -3, marketplaceCoverageMonths: 6.7 }),
      ),
    ).toEqual({ partBMonths: 12, partDMonths: 0, marketplaceMonths: 0 });
    expect(
      resolveCoverageMonths(
        member({ partBEnrollmentMonths: 99, partDEnrollmentMonths: -3, marketplaceCoverageMonths: 6.7 }),
      ).partBMonths,
    ).toBe(12);
  });

  // §36B(c)(2)(B): a Medicare month is never a PTC coverage
  // month. Without the clamp, independently-resolved counts could charge more
  // than 12 covered months in one year and inflate the subsidy.
  it('caps Marketplace months at the months NOT enrolled in Part B or Part D', () => {
    const m = member({
      hasAcaCoverage: true,
      partBEnrollmentMonths: 7,
      partDEnrollmentMonths: 5,
      marketplaceCoverageMonths: 12,
    });
    const resolved = resolveCoverageMonths(m);
    expect(resolved.marketplaceMonths).toBe(5);
    expect(resolved.partBMonths + resolved.marketplaceMonths).toBeLessThanOrEqual(12);
  });

  it('leaves a non-overlapping ACA-to-Medicare transition year untouched', () => {
    expect(
      resolveCoverageMonths(
        member({
          hasAcaCoverage: true,
          partBEnrollmentMonths: 7,
          partDEnrollmentMonths: 7,
          marketplaceCoverageMonths: 5,
        }),
      ),
    ).toEqual({ partBMonths: 7, partDMonths: 7, marketplaceMonths: 5 });
  });
});

// ---------------------------------------------------------------------------
// Automatic (birthday-based) Medicare timing
// ---------------------------------------------------------------------------
describe('automaticMedicareMonthsInYear', () => {
  // Medicare.gov: Part A/B entitlement begins in the birthday MONTH, or the
  // PRECEDING month for a first-of-month birthday. A year-only rule would give 12
  // months to every January-June birthday and 0 to every July-December one.
  it.each([
    [1, 12],
    [2, 11],
    [3, 10],
    [4, 9],
    [5, 8],
    [6, 7],
    [7, 6],
    [8, 5],
    [9, 4],
    [10, 3],
    [11, 2],
    [12, 1],
  ])('turning 65 in month %i yields %i Medicare months', (month, expected) => {
    const iso = `1961-${String(month).padStart(2, '0')}-15`;
    expect(automaticMedicareMonthsInYear(iso, 2026)).toBe(expected);
  });

  it('starts a first-of-month birthday in the PRECEDING month', () => {
    // Born June 1 → entitlement starts in May → 8 months of the year.
    expect(automaticMedicareMonthsInYear('1961-06-01', 2026)).toBe(8);
  });

  it('starts a January-1 birthday in December of the PREVIOUS year', () => {
    expect(automaticMedicareMonthsInYear('1961-01-01', 2025)).toBe(1);
    expect(automaticMedicareMonthsInYear('1961-01-01', 2026)).toBe(12);
  });

  it('is 0 before the entitlement year and 12 after it', () => {
    expect(automaticMedicareMonthsInYear('1961-10-15', 2025)).toBe(0);
    expect(automaticMedicareMonthsInYear('1961-10-15', 2027)).toBe(12);
  });

  it('returns 0 for an empty or unparseable birthdate', () => {
    expect(automaticMedicareMonthsInYear('', 2030)).toBe(0);
    expect(automaticMedicareMonthsInYear(undefined, 2030)).toBe(0);
    expect(automaticMedicareMonthsInYear('not-a-date', 2030)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The ONE shared resolver both engines call
// ---------------------------------------------------------------------------
describe('resolveMemberHealthCoverage', () => {
  const facts = (over: Partial<Parameters<typeof resolveMemberHealthCoverage>[0]> = {}) => ({
    isoBirthdate: '1961-06-15',
    taxYear: 2026,
    retired: true,
    optedOut: false,
    ...over,
  });

  it('splits a turn-65 year between Marketplace and Medicare months', () => {
    // June 15 birthday → Medicare June-December (7 months), Marketplace
    // January-May (5 months). Never more than 12 covered months in total.
    expect(resolveMemberHealthCoverage(facts())).toEqual({
      onMedicare: true,
      hasAcaCoverage: true,
      partBEnrollmentMonths: 7,
      partDEnrollmentMonths: 7,
      marketplaceCoverageMonths: 5,
    });
  });

  it('gives a pre-65 retiree a full Marketplace year and no Medicare', () => {
    expect(resolveMemberHealthCoverage(facts({ taxYear: 2024 }))).toEqual({
      onMedicare: false,
      hasAcaCoverage: true,
      partBEnrollmentMonths: 0,
      partDEnrollmentMonths: 0,
      marketplaceCoverageMonths: 12,
    });
  });

  it('gives a member past 65 a full Medicare year and no Marketplace', () => {
    expect(resolveMemberHealthCoverage(facts({ taxYear: 2030 }))).toEqual({
      onMedicare: true,
      hasAcaCoverage: false,
      partBEnrollmentMonths: 12,
      partDEnrollmentMonths: 12,
      marketplaceCoverageMonths: 12 - 12,
    });
  });

  it('drops Marketplace coverage for a member still working', () => {
    const r = resolveMemberHealthCoverage(facts({ taxYear: 2024, retired: false }));
    expect(r.hasAcaCoverage).toBe(false);
    expect(r.marketplaceCoverageMonths).toBe(0);
  });

  it('drops Marketplace coverage for an opted-out member with no stated months', () => {
    const r = resolveMemberHealthCoverage(facts({ taxYear: 2024, optedOut: true }));
    expect(r.hasAcaCoverage).toBe(false);
    expect(r.marketplaceCoverageMonths).toBe(0);
  });

  it('lets a stated Marketplace count win over the opt-out', () => {
    const r = resolveMemberHealthCoverage(
      facts({ taxYear: 2024, optedOut: true, stored: { marketplaceMonths: 4 } }),
    );
    expect(r.marketplaceCoverageMonths).toBe(4);
  });

  it('lets a stated Part D count win while Part B stays automatic', () => {
    const r = resolveMemberHealthCoverage(facts({ stored: { partDMonths: 0 } }));
    expect(r.partBEnrollmentMonths).toBe(7);
    expect(r.partDEnrollmentMonths).toBe(0);
  });

  it('withholds PTC for the Medicare-ENTITLED months even when Part B is declined', () => {
    // §36B(c)(2)(B) — eligibility for Medicare Part A is itself minimum
    // essential coverage, so declining Part B does not restore PTC at 65+.
    const r = resolveMemberHealthCoverage(
      facts({ stored: { partBMonths: 0, partDMonths: 0, marketplaceMonths: 12 } }),
    );
    expect(r.marketplaceCoverageMonths).toBe(5);
  });

  it('drops Marketplace months for an unparseable birthdate', () => {
    // The rough benchmark prices a covered member off their age; with no
    // parseable age the member must not reach the age curve at all.
    const r = resolveMemberHealthCoverage(
      facts({ isoBirthdate: '', stored: { marketplaceMonths: 12 } }),
    );
    expect(r.hasAcaCoverage).toBe(false);
    expect(r.marketplaceCoverageMonths).toBe(0);
  });

  // A MALFORMED calendar date with a numeric year would pass a year-only guard,
  // get defaulted month/day handling, and bill a full
  // 12 Medicare months (with real IRMAA surcharges) for a date that cannot
  // exist. Imported aggregates are validated at the envelope only, so these are
  // reachable payloads, not hypotheticals.
  it.each([
    ['month 99 / day 99', '1961-99-99'],
    ['month 13', '1961-13-15'],
    ['month 00', '1961-00-15'],
    ['day 32', '1961-01-32'],
    ['day 00', '1961-01-00'],
    ['February 30', '1961-02-30'],
    ['April 31', '1961-04-31'],
    ['a non-leap February 29', '1961-02-29'],
    ['a year-only string', '1961'],
    ['an unpadded date', '1961-6-1'],
    ['a timestamp', '1961-06-15T00:00:00Z'],
  ])('charges NO Medicare months for %s', (_label, isoBirthdate) => {
    // 2030 — five years past this member's nominal 65th birthday, so the buggy
    // path returned a full 12 months for every one of these.
    const r = resolveMemberHealthCoverage(facts({ isoBirthdate, taxYear: 2030 }));
    expect(r.onMedicare).toBe(false);
    expect(r.partBEnrollmentMonths).toBe(0);
    expect(r.partDEnrollmentMonths).toBe(0);
    // …and no Marketplace coverage either: the age curve cannot price a member
    // whose birthdate the app cannot read.
    expect(r.hasAcaCoverage).toBe(false);
    expect(r.marketplaceCoverageMonths).toBe(0);
    expect(automaticMedicareMonthsInYear(isoBirthdate, 2030)).toBe(0);
  });

  it('keeps STATED enrolment months for a malformed birthdate (they need no birthday)', () => {
    const r = resolveMemberHealthCoverage(
      facts({
        isoBirthdate: '1961-99-99',
        taxYear: 2030,
        stored: { partBMonths: 5, partDMonths: 5, marketplaceMonths: 7 },
      }),
    );
    expect(r.partBEnrollmentMonths).toBe(5);
    expect(r.partDEnrollmentMonths).toBe(5);
    expect(r.onMedicare).toBe(true);
    // The Marketplace side still needs a real age.
    expect(r.marketplaceCoverageMonths).toBe(0);
  });

  it('a REAL leap day and the boundary years stay fully supported', () => {
    // Feb 29 1960 is a real date → entitlement starts February 2025.
    expect(automaticMedicareMonthsInYear('1960-02-29', 2025)).toBe(11);
    // Dec 31 and Jan 1 boundaries are unchanged by the stricter validation.
    expect(automaticMedicareMonthsInYear('1960-12-31', 2025)).toBe(1);
    expect(automaticMedicareMonthsInYear('1960-01-01', 2024)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Imported override shapes are never dereferenced blind
// ---------------------------------------------------------------------------
describe('readStoredCoverageMonths', () => {
  it('reads a present member/year entry', () => {
    expect(
      readStoredCoverageMonths({ perMember: { m: { 2030: { partBMonths: 4 } } } }, 'm', 2030),
    ).toEqual({ partBMonths: 4 });
  });

  it.each([
    ['absent map', undefined],
    ['null map', null],
    ['null perMember', { perMember: null }],
    ['non-object perMember', { perMember: 7 as unknown as Record<string, never> }],
    ['null member entry', { perMember: { m: null as unknown as Record<number, never> } }],
    ['null year entry', { perMember: { m: { 2030: null as unknown as never } } }],
  ])('reads %s as nothing stated instead of throwing', (_label, stored) => {
    expect(
      readStoredCoverageMonths(stored as Parameters<typeof readStoredCoverageMonths>[0], 'm', 2030),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The ONE map-walking reader the UI / report surfaces share
// ---------------------------------------------------------------------------
describe('storedCoverageMonthEntries', () => {
  it('enumerates every stated (member, year) entry, ordered by year then member', () => {
    expect(
      storedCoverageMonthEntries({
        perMember: {
          b: { 2031: { partBMonths: 3 } },
          a: { 2031: { partDMonths: 4 }, 2030: { marketplaceMonths: 5 } },
        },
      }),
    ).toEqual([
      { memberId: 'a', taxYear: 2030, months: { marketplaceMonths: 5 } },
      { memberId: 'a', taxYear: 2031, months: { partDMonths: 4 } },
      { memberId: 'b', taxYear: 2031, months: { partBMonths: 3 } },
    ]);
  });

  it.each([
    ['absent map', undefined],
    ['null map', null],
    ['null perMember', { perMember: null }],
    ['non-object perMember', { perMember: 7 }],
    ['null member entry', { perMember: { m: null } }],
    ['null year entry', { perMember: { m: { 2030: null } } }],
  ])('reads %s as nothing stated instead of throwing', (_label, stored) => {
    expect(
      storedCoverageMonthEntries(
        stored as Parameters<typeof storedCoverageMonthEntries>[0],
      ),
    ).toEqual([]);
  });

  it('keeps the sound entries of a partly-corrupt imported map', () => {
    expect(
      storedCoverageMonthEntries({
        perMember: {
          bad: null,
          good: { 2030: { partBMonths: 6 } },
        },
      } as never),
    ).toEqual([{ memberId: 'good', taxYear: 2030, months: { partBMonths: 6 } }]);
  });

  it.each([
    ['a non-numeric year key', 'NaN'],
    ['an empty year key', ''],
    ['a fractional year key', '2030.5'],
    ['a year below the supported domain', '1999'],
    ['a year above the supported domain', '2101'],
  ])('DROPS %s rather than emitting an unusable entry', (_label, year) => {
    expect(
      storedCoverageMonthEntries({
        perMember: { m: { [year]: { partBMonths: 6 } } },
      } as never),
    ).toEqual([]);
  });

  it('keeps the sound years of a map that also carries a malformed one', () => {
    expect(
      storedCoverageMonthEntries({
        perMember: { m: { NaN: { partBMonths: 6 }, 2030: { partDMonths: 4 } } },
      } as never),
    ).toEqual([{ memberId: 'm', taxYear: 2030, months: { partDMonths: 4 } }]);
  });

  it('an inherited `Object.prototype` member is never read as stated coverage', () => {
    // An imported member can carry the id `"__proto__"` (import validation
    // rejects it as a KEY, not as an id VALUE). Indexing the stored map with it
    // resolves to `Object.prototype`, which passes a bare `typeof === 'object'`
    // check.
    expect(readStoredCoverageMonths({ perMember: {} }, '__proto__', 2030)).toBeUndefined();
    expect(readStoredCoverageMonths({ perMember: {} }, 'constructor', 2030)).toBeUndefined();
    // An OWN entry for the same member id still reads normally.
    const own = { perMember: Object.create(null) as Record<string, unknown> };
    own.perMember['__proto__'] = { 2030: { partBMonths: 6 } };
    expect(readStoredCoverageMonths(own as never, '__proto__', 2030)).toEqual({
      partBMonths: 6,
    });
  });
});

// ---------------------------------------------------------------------------
// The ONE shape-checked benchmark-override enumerator
// ---------------------------------------------------------------------------
describe('storedAcaBenchmarkOverrides', () => {
  it('returns the valid rows ascending by tax year', () => {
    expect(
      storedAcaBenchmarkOverrides([
        { taxYear: 2032, annualSlcspDollars: 9_600 },
        { taxYear: 2030, annualSlcspDollars: 9_000 },
      ]),
    ).toEqual([
      { taxYear: 2030, annualSlcspDollars: 9_000 },
      { taxYear: 2032, annualSlcspDollars: 9_600 },
    ]);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a non-array object', { taxYear: 2030, annualSlcspDollars: 9_000 }],
    ['a string', '2030'],
    ['a number', 9_000],
  ])('reads %s as "no override" instead of throwing', (_label, stored) => {
    expect(storedAcaBenchmarkOverrides(stored)).toEqual([]);
  });

  it.each([
    ['a null row', null],
    ['a non-object row', 9_000],
    ['a string year', { taxYear: '2030', annualSlcspDollars: 9_000 }],
    ['a NaN year', { taxYear: Number.NaN, annualSlcspDollars: 9_000 }],
    ['a fractional year', { taxYear: 2030.5, annualSlcspDollars: 9_000 }],
    ['a year below the supported domain', { taxYear: 1999, annualSlcspDollars: 9_000 }],
    ['a year above the supported domain', { taxYear: 2101, annualSlcspDollars: 9_000 }],
    ['a missing price', { taxYear: 2030 }],
    ['a string price', { taxYear: 2030, annualSlcspDollars: '9000' }],
    ['a zero price', { taxYear: 2030, annualSlcspDollars: 0 }],
    ['a negative price', { taxYear: 2030, annualSlcspDollars: -1 }],
    ['an infinite price', { taxYear: 2030, annualSlcspDollars: Number.POSITIVE_INFINITY }],
  ])('drops %s', (_label, row) => {
    expect(storedAcaBenchmarkOverrides([row])).toEqual([]);
  });

  it('keeps the sound rows of a partly-corrupt imported array', () => {
    expect(
      storedAcaBenchmarkOverrides([
        { taxYear: 2031, annualSlcspDollars: -1 },
        { taxYear: 2030, annualSlcspDollars: 9_000 },
        null,
      ]),
    ).toEqual([{ taxYear: 2030, annualSlcspDollars: 9_000 }]);
  });
});

// ---------------------------------------------------------------------------
// A whole-year benchmark override must arrive month-summed
// ---------------------------------------------------------------------------
describe('overrideBenchmarkCentsForCoverageMonths', () => {
  it('is the identity for a full covered year', () => {
    expect(overrideBenchmarkCentsForCoverageMonths(12_000, 12)).toBe(1_200_000);
  });

  it('prorates a part-year household by its covered months', () => {
    expect(overrideBenchmarkCentsForCoverageMonths(12_000, 7)).toBe(700_000);
    expect(overrideBenchmarkCentsForCoverageMonths(12_000, 5)).toBe(500_000);
    expect(overrideBenchmarkCentsForCoverageMonths(12_000, 0)).toBe(0);
  });

  it('rounds to whole cents and never returns a negative benchmark', () => {
    // $9,999.99/yr over 7 months → 999999 × 7 / 12 = 583332.75 → 583333.
    expect(overrideBenchmarkCentsForCoverageMonths(9_999.99, 7)).toBe(583_333);
    expect(overrideBenchmarkCentsForCoverageMonths(12_000, -3)).toBe(0);
  });
});

describe('householdMarketplaceCoverageMonths', () => {
  it('is the largest covered member count (nested coverage periods)', () => {
    expect(
      householdMarketplaceCoverageMonths([
        member({ memberId: 'a', marketplaceCoverageMonths: 5 }),
        member({ memberId: 'b', marketplaceCoverageMonths: 12 }),
      ]),
    ).toBe(12);
  });

  it('is 0 when no member is covered', () => {
    expect(
      householdMarketplaceCoverageMonths([member({ hasAcaCoverage: false })]),
    ).toBe(0);
  });
});

describe('coverage engagement gates', () => {
  it('treats a member with any enrolled Medicare month as on Medicare', () => {
    expect(anyMemberOnMedicare([member({ onMedicare: false, partDEnrollmentMonths: 3 })])).toBe(true);
    expect(anyMemberOnMedicare([member({ onMedicare: true, partBEnrollmentMonths: 0, partDEnrollmentMonths: 0 })])).toBe(false);
  });

  it('treats a member with zero Marketplace months as uncovered', () => {
    expect(anyMemberHasAcaCoverage([member({ hasAcaCoverage: true, marketplaceCoverageMonths: 0 })])).toBe(false);
    expect(anyMemberHasAcaCoverage([member({ hasAcaCoverage: true })])).toBe(true);
  });

  it('emits one IRMAA beneficiary entry per member with any enrolled month', () => {
    expect(
      irmaaBeneficiaryEnrollments([
        member({ memberId: 'a', onMedicare: true, partBEnrollmentMonths: 7, partDEnrollmentMonths: 7 }),
        member({ memberId: 'b', onMedicare: false }),
      ]),
    ).toEqual([{ memberId: 'a', partBMonths: 7, partDMonths: 7 }]);
  });
});
