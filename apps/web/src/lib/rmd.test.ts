/**
 * Primary acceptance-criterion test + divisor boundary spot checks for the RMD engine.
 * Subject-specific tests split into sibling files:
 *   rmd.trigger-age.test.ts   — trigger-age cutover + applicable shape
 *   rmd.qualification.test.ts — account-type qualification + MIXED Roth-portion
 *   rmd.allocation.test.ts    — per-account proportional allocation + zero balance
 *   rmd.errors.test.ts        — all RmdInvalidInputError + UnsupportedTaxYearError paths
 * Oracle: IRS Pub 590-B Appendix B Table III, 2022 revision (effective 2022-01-01).
 */

import { describe, it, expect } from 'vitest';
import {
  computeRmd,
  deceasedOwnerApplicableRmdAge,
  poolKeyForRmdAccount,
  stillWorkingExceptionApplies,
  stillWorkingExceptionEligible,
  rmdTwoYearsPriorBaseCents,
  rmdFirstYearDeferralPlan,
  resolveRmdFirstYearPlan,
  resolveRmdRule,
  type RmdAccountProfileFacts,
  type RmdRuleResolution,
} from './rmd';
import { RMD_LIFE_EXPECTANCY_TABLES } from './rmd-life-expectancy-tables';
import { validateRmdProfileFacts } from './rmd-validation';
import { SNAPSHOT } from './rmd.test-helpers';
import mcParityBaselines from './__fixtures__/mc-parity-baselines.json';

// ---------------------------------------------------------------------------
// computeRmd — primary acceptance criterion
// ---------------------------------------------------------------------------

describe('computeRmd — primary AC', () => {
  it('should_return_1886792_cents_for_born_1952_taxYear_2025_balance_50M_cents', () => {
    // AC: computeRmd({ isoBirthdate: '1952-06-15', taxYear: 2025, accounts: [{...}] }, RMD_DIVISORS)
    // Born 1952 → attains age 73 in 2025 → trigger 73 (born 1951–1959)
    // divisor: 26.5 (IRS Pub 590-B Appendix B Table III, age 73)
    // ownerRmdCents = Math.round((50_000_000 / 100) / 26.5 * 100)
    //               = Math.round(1_886_792.45...) = 1_886_792
    const result = computeRmd(
      {
        isoBirthdate: '1952-06-15',
        taxYear: 2025,
        accounts: [
          {
            id: 'a1',
            balanceDec31PriorYearCents: 50_000_000,
            accountType: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
          },
        ],
      },
      SNAPSHOT,
    );
    expect(result.applicable).toBe(true);
    expect(result.divisor).toBe(26.5);
    expect(result.ownerRmdCents).toBe(1_886_792);
    expect(result.perAccountRmdCents['a1']).toBe(1_886_792);
    expect(result.qualifyingBalanceCents).toBe(50_000_000);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — divisor table boundaries (IRS-pinned + age clamp)
// ---------------------------------------------------------------------------

describe('computeRmd — divisor table boundaries', () => {
  it('should_use_divisor_26_5_at_age_73_first_rmd_year', () => {
    // Born 1951, taxYear 2024 → age 73
    const r = computeRmd(
      {
        isoBirthdate: '1951-01-01',
        taxYear: 2024,
        accounts: [{ id: 'a1', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
      },
      SNAPSHOT,
    );
    expect(r.divisor).toBe(26.5);
  });

  it('should_clamp_age_125_to_120_and_use_divisor_2_0', () => {
    // Born 1900, taxYear 2025 → age 125 → clamped to 120 → divisor 2.0
    const r = computeRmd(
      {
        isoBirthdate: '1900-01-01',
        taxYear: 2025,
        accounts: [{ id: 'a1', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
      },
      SNAPSHOT,
    );
    expect(r.divisor).toBe(2.0); // IRS "age 120 and older" convention
    expect(r.applicable).toBe(true);
  });

  it('should_resolve_taxYear_2030_to_2024_entry_via_clamp_to_latest', () => {
    // Clamp-to-latest — RMD_DIVISORS has only key 2024; 2030 clamps to 2024 (no throw).
    // Explicit divergence from federal-tax.ts strict-exact lookup: table is statutory, stable.
    const result = computeRmd(
      {
        isoBirthdate: '1950-01-01',
        taxYear: 2030, // future year, beyond snapshot keys
        accounts: [
          { id: 'a1', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
        ],
      },
      SNAPSHOT,
    );
    expect(result.applicable).toBe(true);
    // born 1950, taxYear 2030 → age 80 → divisor 20.2 (IRS Pub 590-B Table III)
    expect(result.divisor).toBe(20.2);
  });
});

// ---------------------------------------------------------------------------
// poolKeyForRmdAccount — IRS aggregation pool key
// ---------------------------------------------------------------------------

describe('poolKeyForRmdAccount — IRS aggregation pooling', () => {
  it('collapses all of one owner’s traditional IRAs into one IRA pool key', () => {
    const k1 = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'ira-1');
    const k2 = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'ira-2');
    expect(k1).toBe('owner-A::pool:IRA');
    expect(k2).toBe('owner-A::pool:IRA');
    expect(k1).toBe(k2);
  });

  it('collapses all of one owner’s 403(b)s into one 403B pool key (separate from IRA)', () => {
    const k1 = poolKeyForRmdAccount('owner-A', 'RETIREMENT_403B', 'tsa-1');
    const k2 = poolKeyForRmdAccount('owner-A', 'RETIREMENT_403B', 'tsa-2');
    expect(k1).toBe('owner-A::pool:403B');
    expect(k2).toBe('owner-A::pool:403B');
    expect(k1).toBe(k2);
    // 403(b) pool is distinct from the IRA pool for the same owner.
    expect(k1).not.toBe(poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'tsa-1'));
  });

  // An INHERITED account never aggregates: not with the
  // beneficiary's own IRAs, and not with an IRA inherited from another decedent.
  it('gives every INHERITED account its own singleton key (no aggregation at all)', () => {
    const own = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'ira-1');
    const inherited = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'inh-1', true);
    const otherInherited = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'inh-2', true);
    // Never pooled with the beneficiary's own IRA pool…
    expect(inherited).not.toBe(own);
    // …and never with another inherited IRA (a different decedent's).
    expect(inherited).not.toBe(otherInherited);
    // A 403(b) inherited account is likewise its own pool, not the 403B pool.
    expect(poolKeyForRmdAccount('owner-A', 'RETIREMENT_403B', 'inh-3', true)).not.toBe(
      poolKeyForRmdAccount('owner-A', 'RETIREMENT_403B', 'own-3'),
    );
  });

  it('gives each employer plan its own singleton key (no cross-plan aggregation)', () => {
    const singletons: Array<['RETIREMENT_401K' | 'RETIREMENT_457B' | 'RETIREMENT_TSP' | 'RETIREMENT_CASH_BALANCE', string]> = [
      ['RETIREMENT_401K', 'k-1'],
      ['RETIREMENT_457B', 'b-1'],
      ['RETIREMENT_TSP', 't-1'],
      ['RETIREMENT_CASH_BALANCE', 'cb-1'],
    ];
    for (const [type, id] of singletons) {
      expect(poolKeyForRmdAccount('owner-A', type, id)).toBe(`owner-A::acct:${id}`);
    }
    // Two 401(k)s of the same owner are DISTINCT singleton pools.
    const a = poolKeyForRmdAccount('owner-A', 'RETIREMENT_401K', 'k-1');
    const b = poolKeyForRmdAccount('owner-A', 'RETIREMENT_401K', 'k-2');
    expect(a).not.toBe(b);
  });

  it('scopes pools per owner — same type, different owners → different keys', () => {
    expect(poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'ira-1')).not.toBe(
      poolKeyForRmdAccount('owner-B', 'RETIREMENT_IRA', 'ira-2'),
    );
    expect(poolKeyForRmdAccount('owner-A', 'RETIREMENT_401K', 'k-1')).not.toBe(
      poolKeyForRmdAccount('owner-B', 'RETIREMENT_401K', 'k-1'),
    );
  });

  it('falls back to a bare-id singleton for an empty owner (orphan, no throw)', () => {
    const k = poolKeyForRmdAccount('', 'RETIREMENT_401K', 'orphan-1');
    expect(k).toBe('orphan-1::acct:orphan-1');
    // Even an IRA with an empty owner gets keyed by its own id (own pool).
    expect(poolKeyForRmdAccount('', 'RETIREMENT_IRA', 'orphan-2')).toBe(
      'orphan-2::pool:IRA',
    );
  });

  it('namespaces discriminant vs id so an IRA and a 401(k) with the same id never collide', () => {
    const ira = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'IRA');
    const k = poolKeyForRmdAccount('owner-A', 'RETIREMENT_401K', 'IRA');
    expect(ira).toBe('owner-A::pool:IRA');
    expect(k).toBe('owner-A::acct:IRA');
    expect(ira).not.toBe(k);
  });
});

// ---------------------------------------------------------------------------
// Still-working exception (§401(a)(9)(C))
// ---------------------------------------------------------------------------

describe('stillWorkingExceptionEligible / stillWorkingExceptionApplies', () => {
  const stillWorking: RmdAccountProfileFacts = {
    currentEmployerPlan: true,
    fivePercentOwner: false,
    planRequiresDistributionAtStatutoryAge: false,
  };
  /** Still employed in the probe year (separation two years later). */
  const employed = { taxYear: 2025, separationYear: 2027 } as const;

  it('is eligible for a non-5%-owner still working at the current employer (employer plan)', () => {
    expect(stillWorkingExceptionEligible(stillWorking, 'RETIREMENT_401K')).toBe(true);
    expect(stillWorkingExceptionEligible(stillWorking, 'RETIREMENT_403B')).toBe(true);
    expect(stillWorkingExceptionEligible(stillWorking, 'RETIREMENT_457B')).toBe(true);
    expect(stillWorkingExceptionEligible(stillWorking, 'RETIREMENT_TSP')).toBe(true);
    expect(stillWorkingExceptionEligible(stillWorking, 'RETIREMENT_CASH_BALANCE')).toBe(true);
    expect(stillWorkingExceptionApplies(stillWorking, 'RETIREMENT_401K', employed)).toBe(true);
  });

  it('never applies to an IRA (the exception is employer-plan only)', () => {
    expect(stillWorkingExceptionEligible(stillWorking, 'RETIREMENT_IRA')).toBe(false);
    expect(stillWorkingExceptionApplies(stillWorking, 'RETIREMENT_IRA', employed)).toBe(false);
  });

  it('is denied for a >5% owner', () => {
    expect(
      stillWorkingExceptionEligible({ ...stillWorking, fivePercentOwner: true }, 'RETIREMENT_401K'),
    ).toBe(false);
  });

  it('is denied when the plan forces distributions at the statutory age', () => {
    expect(
      stillWorkingExceptionEligible(
        { ...stillWorking, planRequiresDistributionAtStatutoryAge: true },
        'RETIREMENT_401K',
      ),
    ).toBe(false);
  });

  it('is denied conservatively when the 5%-owner status is UNKNOWN (absent → treated as 5% owner)', () => {
    expect(
      stillWorkingExceptionEligible({ currentEmployerPlan: true }, 'RETIREMENT_401K'),
    ).toBe(false);
  });

  it('is denied conservatively when it is not the current employer (absent currentEmployerPlan)', () => {
    expect(
      stillWorkingExceptionEligible({ fivePercentOwner: false }, 'RETIREMENT_401K'),
    ).toBe(false);
  });

  it('is denied when the plan-terms fact is ABSENT/unknown (requires explicit false)', () => {
    // planRequiresDistributionAtStatutoryAge missing → deny, never grant the
    // favorable deferral on missing plan terms.
    expect(
      stillWorkingExceptionEligible(
        { currentEmployerPlan: true, fivePercentOwner: false },
        'RETIREMENT_401K',
      ),
    ).toBe(false);
    // Explicit false → the exception applies (the affirmative fact is present).
    expect(
      stillWorkingExceptionEligible(
        { currentEmployerPlan: true, fivePercentOwner: false, planRequiresDistributionAtStatutoryAge: false },
        'RETIREMENT_401K',
      ),
    ).toBe(true);
  });

  // The exception is a deferral WHILE EMPLOYED, so it must
  // EXPIRE. A grant from static account facts alone would make a
  // qualifying plan RMD-exempt in every projected year forever.
  it('applies only in years BEFORE the separation year, never in it or after', () => {
    const eligible = (taxYear: number): boolean =>
      stillWorkingExceptionApplies(stillWorking, 'RETIREMENT_401K', {
        taxYear,
        separationYear: 2030,
      });
    expect(eligible(2029)).toBe(true); // still employed
    // The separation year itself is the FIRST distribution year (§401(a)(9)(C)
    // makes the RBD April 1 of the following year), never another exempt year.
    expect(eligible(2030)).toBe(false);
    expect(eligible(2031)).toBe(false); // and every later year
  });

  it('is denied when the separation year is UNKNOWN (conservative — never exempt forever)', () => {
    expect(
      stillWorkingExceptionApplies(stillWorking, 'RETIREMENT_401K', {
        taxYear: 2025,
        separationYear: undefined,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// First-year April-1 deferral
// ---------------------------------------------------------------------------

describe('rmdFirstYearDeferralPlan', () => {
  it('defers two RMDs into the following year when elected in the first RMD year', () => {
    const plan = rmdFirstYearDeferralPlan(73, 73, { firstYearDeferralElected: true });
    expect(plan.isFirstRmdYear).toBe(true);
    expect(plan.deferred).toBe(true);
    expect(plan.rmdsDueFollowingYear).toBe(2);
  });

  it('does not defer when the election is absent (calendar-year RMD in the first year)', () => {
    const plan = rmdFirstYearDeferralPlan(73, 73, {});
    expect(plan.isFirstRmdYear).toBe(true);
    expect(plan.deferred).toBe(false);
    expect(plan.rmdsDueFollowingYear).toBe(0);
  });

  it('is not the first RMD year past the trigger age even when elected', () => {
    const plan = rmdFirstYearDeferralPlan(74, 73, { firstYearDeferralElected: true });
    expect(plan.isFirstRmdYear).toBe(false);
    expect(plan.deferred).toBe(false);
    expect(plan.rmdsDueFollowingYear).toBe(0);
  });

  it('honours the age-75 trigger for owners born 1960+', () => {
    expect(rmdFirstYearDeferralPlan(75, 75, { firstYearDeferralElected: true }).deferred).toBe(true);
    expect(rmdFirstYearDeferralPlan(73, 75, { firstYearDeferralElected: true }).isFirstRmdYear).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveRmdRule: owner + inherited rule/table selection
// ---------------------------------------------------------------------------

const TABLES = RMD_LIFE_EXPECTANCY_TABLES;

describe('resolveRmdRule — owner path', () => {
  it('selects the Uniform Lifetime Table (III) with the exact divisor by default', () => {
    const r = resolveRmdRule({
      facts: {},
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: { ownerAge: 73 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('ownerUniformLifetime');
    if (r.kind === 'ownerUniformLifetime' && r.selection.kind === 'divisor') {
      expect(r.selection.table).toBe('uniformLifetime');
      expect(r.selection.divisor).toBe(26.5); // IRS Pub 590-B Table III, age 73
    } else {
      throw new Error('expected a Uniform Lifetime divisor selection');
    }
  });

  it('clamps an owner age above 120 to the Table III floor divisor 2.0', () => {
    const r = resolveRmdRule({
      facts: {},
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: { ownerAge: 125 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind === 'ownerUniformLifetime' && r.selection.kind === 'divisor' && r.selection.divisor).toBe(2.0);
  });

  it('returns stillWorkingDeferred for a non-5%-owner still working at the current employer', () => {
    const r = resolveRmdRule({
      facts: {
        currentEmployerPlan: true,
        fivePercentOwner: false,
        planRequiresDistributionAtStatutoryAge: false,
      },
      accountType: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      ages: { ownerAge: 74 },
      taxYear: 2025,
      tables: TABLES,
      // The exception defers only the years BEFORE separation.
      retirementYear: 2030,
    });
    expect(r.kind).toBe('stillWorkingDeferred');
  });

  it('does NOT defer once the owner has separated (the exception expires)', () => {
    const facts = {
      currentEmployerPlan: true,
      fivePercentOwner: false,
      planRequiresDistributionAtStatutoryAge: false,
    } as const;
    const forYear = (taxYear: number) =>
      resolveRmdRule({
        facts,
        accountType: 'RETIREMENT_401K',
        taxTreatment: 'PRE_TAX',
        ages: { ownerAge: 74 + (taxYear - 2025) },
        taxYear,
        tables: TABLES,
        retirementYear: 2026,
      });
    expect(forYear(2025).kind).toBe('stillWorkingDeferred');
    // Retirement year + every later year: an ordinary owner minimum is due.
    expect(forYear(2026).kind).toBe('ownerUniformLifetime');
    expect(forYear(2027).kind).toBe('ownerUniformLifetime');
  });

  // Non-qualifying living-owner accounts owe NO RMD.
  it.each([
    ['RETIREMENT_ROTH_IRA', 'ROTH'],
    ['RETIREMENT_ROTH_401K', 'ROTH'],
    ['RETIREMENT_ROTH_403B', 'ROTH'],
    ['HSA', 'HSA'],
    ['BROKERAGE', 'POST_TAX'],
    ['SAVINGS', 'POST_TAX'],
    ['MONEY_MARKET', 'POST_TAX'],
    ['CD', 'POST_TAX'],
    ['OTHER', 'POST_TAX'],
  ] as const)('returns notRequired for a living-owner %s account', (accountType, taxTreatment) => {
    const r = resolveRmdRule({
      facts: {},
      accountType,
      taxTreatment,
      ages: { ownerAge: 80 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('notRequired');
  });

  it('does NOT mark a MIXED employer plan notRequired (its pre-tax portion still owes RMD)', () => {
    const r = resolveRmdRule({
      facts: {},
      accountType: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ages: { ownerAge: 80 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('ownerUniformLifetime');
  });

  // The Table II >10-years-younger condition is derived from birthdates,
  // never trusted from the boolean alone.
  it('selects Joint Life (Table II) with a real divisor when birthdates confirm >10 yrs younger', () => {
    const r = resolveRmdRule({
      facts: {
        soleSpouseBeneficiaryMoreThan10YrsYounger: true,
        spouseBeneficiaryBirthdate: '1966-06-16', // 10 yrs + 1 day younger than owner
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ownerBirthdate: '1956-06-15',
      ages: { ownerAge: 75 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('ownerJointLife');
    expect(r.kind === 'ownerJointLife' && r.selection.kind).toBe('divisor');
  });

  it('does NOT qualify when the spouse is EXACTLY 10 years younger (strict "more than")', () => {
    const r = resolveRmdRule({
      facts: {
        soleSpouseBeneficiaryMoreThan10YrsYounger: true,
        spouseBeneficiaryBirthdate: '1966-06-15', // exactly 10 yrs younger, same day
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ownerBirthdate: '1956-06-15',
      ages: { ownerAge: 75 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('ownerUniformLifetime');
  });

  it('lets the birthdate-derived result WIN over a contradictory boolean', () => {
    // Boolean claims >10 younger, but the spouse birthdate proves she is OLDER —
    // the birthdate-derived "not more than 10 years younger" must win → Table III.
    const r = resolveRmdRule({
      facts: {
        soleSpouseBeneficiaryMoreThan10YrsYounger: true,
        spouseBeneficiaryBirthdate: '1953-01-01', // older than the owner
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ownerBirthdate: '1956-06-15',
      ages: { ownerAge: 75 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('ownerUniformLifetime');
  });

  it('WITHHOLDS a claimed Table II designation when the birthdates are missing', () => {
    const r = resolveRmdRule({
      facts: { soleSpouseBeneficiaryMoreThan10YrsYounger: true },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: { ownerAge: 75 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('ownerBirthdate');
      expect(r.missingFacts).toContain('spouseBeneficiaryBirthdate');
    }
  });

  // A missing owner age must WITHHOLD, never silently default to 0 (which
  // would clamp to the age-73 divisor and understate the RMD).
  it('WITHHOLDS a complete owner-path fact set when the owner age is unknown', () => {
    const r = resolveRmdRule({
      facts: {},
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    expect(r.kind === 'withheld' && r.missingFacts).toContain('ownerAge');
  });

  // Once Table II eligibility is established from the validated birthdates,
  // the spouse's attained age is DERIVED from that same birthdate; a separate age
  // fact is no longer consulted and the resolver never silently downgrades to
  // Table III.
  it('derives the spouse age from the birthdate and selects Joint Life (Table II) — no Table III downgrade', () => {
    const r = resolveRmdRule({
      facts: {
        soleSpouseBeneficiaryMoreThan10YrsYounger: true,
        spouseBeneficiaryBirthdate: '1966-06-16',
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ownerBirthdate: '1956-06-15',
      ages: { ownerAge: 75 },
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('ownerJointLife');
    if (r.kind === 'ownerJointLife' && r.selection.kind === 'divisor') {
      // Owner age 75, spouse age 2025 − 1966 = 59 (derived from the birthdate).
      expect(r.selection.table).toBe('jointLastSurvivor');
    } else {
      throw new Error('expected a Joint Life (Table II) divisor selection');
    }
  });
});

describe('resolveRmdFirstYearPlan — later-of statutory-age-or-retirement', () => {
  it('still-working employee who retires exactly at the trigger age → first year = trigger year', () => {
    const r = resolveRmdFirstYearPlan({
      ownerAge: 73,
      triggerAge: 73,
      taxYear: 2025,
      facts: {},
      stillWorkingExceptionApplied: true,
      retirementYear: 2025,
    });
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.firstRmdYear).toBe(2025);
      expect(r.plan.isFirstRmdYear).toBe(true);
    }
  });

  it('still-working employee who retires SEVERAL years after the trigger age → first year = retirement year', () => {
    const r = resolveRmdFirstYearPlan({
      ownerAge: 76,
      triggerAge: 73,
      taxYear: 2028, // triggerYear = 2028 - 76 + 73 = 2025
      facts: {},
      stillWorkingExceptionApplied: true,
      retirementYear: 2028,
    });
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.firstRmdYear).toBe(2028); // retirement year, NOT the 2025 trigger year
      expect(r.plan.isFirstRmdYear).toBe(true);
    }
  });

  it('WITHHOLDS the first year when a still-working employee’s retirement year is unknown', () => {
    const r = resolveRmdFirstYearPlan({
      ownerAge: 76,
      triggerAge: 73,
      taxYear: 2028,
      facts: {},
      stillWorkingExceptionApplied: true,
    });
    expect(r.kind).toBe('withheld');
    expect(r.kind === 'withheld' && r.missingFacts).toContain('retirementYear');
  });

  it('non-still-working owner resolves the first year to the trigger-age year', () => {
    const r = resolveRmdFirstYearPlan({
      ownerAge: 73,
      triggerAge: 73,
      taxYear: 2025,
      facts: { firstYearDeferralElected: true },
      stillWorkingExceptionApplied: false,
    });
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.firstRmdYear).toBe(2025);
      expect(r.plan.deferred).toBe(true);
      expect(r.plan.rmdsDueFollowingYear).toBe(2);
    }
  });
});

describe('resolveRmdRule — inherited path', () => {
  const complete: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: 'OTHER_DESIGNATED',
    inheritedOwnerDeathDate: '2023-05-01',
    inheritedOwnerDiedOnOrAfterRbd: true,
    originalOwnerBirthdate: '1945-01-01', // decedent age for the longer-of ghost
    beneficiaryBirthdate: '1970-01-01', // Beneficiary age is DERIVED from this (55 in 2025)
  };

  it('WITHHOLDS and lists every missing required inherited fact (blocker)', () => {
    const r = resolveRmdRule({
      facts: { inheritedAccount: true },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('beneficiaryType');
      expect(r.missingFacts).toContain('inheritedOwnerDeathDate');
      expect(r.missingFacts).toContain('inheritedOwnerDiedOnOrAfterRbd');
    }
  });

  // An inherited Roth IRA IS still subject to RMD rules (NOT notRequired).
  it('does NOT exempt an inherited Roth IRA — it routes through the inherited path', () => {
    const r = resolveRmdRule({
      facts: { inheritedAccount: true },
      accountType: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).not.toBe('notRequired');
    expect(r.kind).toBe('withheld'); // baseline inherited facts still missing
  });

  // A pre-2020 death falls under the pre-SECURE-Act regime this engine
  // does not model; withhold rather than silently apply post-2019 rules.
  it('WITHHOLDS a pre-2020 death rather than applying post-2019 rules', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'OTHER_DESIGNATED',
        inheritedOwnerDeathDate: '2019-05-01',
        inheritedOwnerDiedOnOrAfterRbd: true,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    expect(r.kind === 'withheld' && r.missingFacts).toContain('preSecureActDeathRulesUnsupported');
  });

  // An EDB must have affirmatively elected; absent election → withhold.
  it('WITHHOLDS an eligible-designated-beneficiary stretch when the election fact is missing', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    expect(r.kind === 'withheld' && r.missingFacts).toContain('beneficiaryElection');
  });

  it('resolves a spouse LIFE_EXPECTANCY stretch to a real Single Life (Table I) divisor', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
        // Owner born 1948 → 70½ era → would have reached RBD in 1948+70 =
        // 2018 ≤ 2025 → past the delay window, so the spouse's recalculated stretch
        // has begun.
        originalOwnerBirthdate: '1948-05-01',
        beneficiaryBirthdate: '1963-01-01', // Derived spouse age 62 in 2025
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedLifeExpectancy');
    if (r.kind === 'inheritedLifeExpectancy' && r.selection.kind === 'divisor') {
      expect(r.selection.divisor).toBe(25.4); // Table I, current age 62 (spouse recalc)
    } else {
      throw new Error('expected a Single Life divisor selection');
    }
  });

  // Spouse recalculates by CURRENT age each year (re-lookup, not −1.0/yr).
  it('spouse recalculation re-looks-up Table I by current age each year', () => {
    // Spouse born 1964 → attained age is DERIVED per tax year: 60 in 2024,
    // 61 in 2025, 62 in 2026.
    const divisorAt = (taxYear: number): number => {
      const r = resolveRmdRule({
        facts: {
          inheritedAccount: true,
          beneficiaryType: 'SPOUSE',
          beneficiaryElection: 'LIFE_EXPECTANCY',
          inheritedOwnerDeathDate: '2023-06-01',
          inheritedOwnerDiedOnOrAfterRbd: false,
          // Owner born 1948 → 70½ era → RBD year 2018 ≤ every probed year →
          // past the spousal delay window, so the recalculated stretch is active.
          originalOwnerBirthdate: '1948-05-01',
          beneficiaryBirthdate: '1964-06-01',
        },
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear,
        tables: TABLES,
      });
      if (r.kind === 'inheritedLifeExpectancy' && r.selection.kind === 'divisor') return r.selection.divisor;
      throw new Error('expected a divisor');
    };
    expect(divisorAt(2024)).toBe(27.1); // Table I[60]
    expect(divisorAt(2025)).toBe(26.2); // Table I[61] — re-lookup, −0.9 not −1.0
    expect(divisorAt(2026)).toBe(25.4); // Table I[62] — re-lookup, −0.8 not −1.0
  });

  // A NON-SPOUSE beneficiary anchors the base-year divisor and subtracts
  // exactly 1.0 per elapsed year (NOT a fresh current-age lookup).
  it('non-spouse beneficiary decrements the anchored Table I divisor by exactly 1.0/yr', () => {
    // Death 2023 → base year 2024; beneficiary born 1969 → base-year age 55,
    // Table I[55] = 31.6. Attained age is DERIVED per tax year.
    const divisorAt = (taxYear: number): number => {
      const r = resolveRmdRule({
        facts: {
          inheritedAccount: true,
          beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
          beneficiaryElection: 'LIFE_EXPECTANCY',
          inheritedOwnerDeathDate: '2023-06-01',
          inheritedOwnerDiedOnOrAfterRbd: false,
          beneficiaryBirthdate: '1969-06-01',
        },
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear,
        tables: TABLES,
      });
      if (r.kind === 'inheritedLifeExpectancy' && r.selection.kind === 'divisor') return r.selection.divisor;
      throw new Error('expected a divisor');
    };
    expect(divisorAt(2024)).toBe(31.6); // base year, elapsed 0
    expect(divisorAt(2025)).toBeCloseTo(30.6, 10); // 31.6 − 1.0
    expect(divisorAt(2026)).toBeCloseTo(29.6, 10); // 31.6 − 2.0
  });

  // A non-minor eligible designated beneficiary routes to the stretch. (The
  // former MINOR_CHILD_OF_OWNER age-40 fixture was removed — a 40-year-old is NOT a
  // minor child; that boundary is covered by the dedicated tests below.)
  it('routes a NOT_MORE_THAN_10_YEARS_YOUNGER beneficiary electing LIFE_EXPECTANCY to inheritedLifeExpectancy', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'NOT_MORE_THAN_10_YEARS_YOUNGER',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
        beneficiaryBirthdate: '1985-01-01', // Derived age 40 in 2025
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedLifeExpectancy');
  });

  // A MINOR_CHILD_OF_OWNER takes the life-expectancy stretch until the age
  // of majority (21), then transitions to the 10-year rule.
  describe('MINOR_CHILD_OF_OWNER majority transition', () => {
    // Child born 2010 → reaches age 21 in 2031. Owner died 2023 (before RBD), the
    // child was age 13 at death (a genuine minor).
    const minorChildFacts = (extra: Partial<RmdAccountProfileFacts> = {}): RmdAccountProfileFacts => ({
      inheritedAccount: true,
      beneficiaryType: 'MINOR_CHILD_OF_OWNER',
      beneficiaryElection: 'LIFE_EXPECTANCY',
      inheritedOwnerDeathDate: '2023-05-01',
      inheritedOwnerDiedOnOrAfterRbd: false,
      beneficiaryBirthdate: '2010-05-01',
      ...extra,
    });

    it('applies the life-expectancy stretch BEFORE age 21', () => {
      const r = resolveRmdRule({
        facts: minorChildFacts(),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {}, // 2030, derived age 20 — still a minor
        taxYear: 2030,
        tables: TABLES,
      });
      expect(r.kind).toBe('inheritedLifeExpectancy');
    });

    it('transitions to the 10-year rule EXACTLY at age 21 (majority year)', () => {
      const r = resolveRmdRule({
        facts: minorChildFacts(),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear: 2031, // majority year (2010 + 21)
        tables: TABLES,
      });
      expect(r.kind).toBe('inheritedTenYearRule');
      if (r.kind === 'inheritedTenYearRule') {
        expect(r.fullLiquidationByYear).toBe(2041); // 2031 + 10
      }
    });

    it('stays on the 10-year rule AFTER age 21', () => {
      const r = resolveRmdRule({
        facts: minorChildFacts(),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear: 2035,
        tables: TABLES,
      });
      expect(r.kind).toBe('inheritedTenYearRule');
      if (r.kind === 'inheritedTenYearRule') {
        expect(r.fullLiquidationByYear).toBe(2041);
      }
    });

    it('WITHHOLDS a MINOR_CHILD_OF_OWNER who was already ≥21 at the owner’s death (invalid category)', () => {
      const r = resolveRmdRule({
        // Beneficiary born 1983 → age 40 at the 2023 death: not a minor child.
        facts: minorChildFacts({ beneficiaryBirthdate: '1983-05-01' }),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear: 2025,
        tables: TABLES,
      });
      expect(r.kind).toBe('withheld');
      if (r.kind === 'withheld') {
        expect(r.missingFacts).toContain('minorChildBeneficiaryNotMinorAtDeath');
      }
    });

    it('WITHHOLDS a minor child when the beneficiary birthdate is missing', () => {
      const r = resolveRmdRule({
        facts: minorChildFacts({ beneficiaryBirthdate: undefined }),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear: 2030,
        tables: TABLES,
      });
      expect(r.kind).toBe('withheld');
      if (r.kind === 'withheld') {
        expect(r.missingFacts).toContain('beneficiaryBirthdate');
      }
    });

    // The minor-vs-majority status is decided by an anniversary-safe compare
    // of the FULL death date against the 21st birthday, NOT year-only subtraction.
    // All three children below would tie at `deathYear − birthYear === 21` under the
    // old year math (death 2024, born 2003) yet differ by exact date.
    it('treats a child whose 21st birthday is the day AFTER death as a MINOR', () => {
      const r = resolveRmdRule({
        // Born 2003-06-16 → turns 21 on 2024-06-16, one day AFTER the 2024-06-15
        // death → still 20 on the death date → genuine minor (not withheld as
        // not-a-minor). taxYear 2030 is past majority year 2024 → 10-year rule.
        facts: minorChildFacts({
          beneficiaryBirthdate: '2003-06-16',
          inheritedOwnerDeathDate: '2024-06-15',
        }),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear: 2030,
        tables: TABLES,
      });
      expect(r.kind).toBe('inheritedTenYearRule');
    });

    it('treats a child whose 21st birthday is the day BEFORE death as already at majority', () => {
      const r = resolveRmdRule({
        // Born 2003-06-14 → turned 21 on 2024-06-14, one day BEFORE the 2024-06-15
        // death → already at majority → NOT a minor child → WITHHOLD.
        facts: minorChildFacts({
          beneficiaryBirthdate: '2003-06-14',
          inheritedOwnerDeathDate: '2024-06-15',
        }),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear: 2030,
        tables: TABLES,
      });
      expect(r.kind).toBe('withheld');
      if (r.kind === 'withheld') {
        expect(r.missingFacts).toContain('minorChildBeneficiaryNotMinorAtDeath');
      }
    });

    it('treats a child whose 21st birthday is EXACTLY the death date as already at majority', () => {
      const r = resolveRmdRule({
        // Born 2003-06-15 → turns 21 ON the 2024-06-15 death date → they ARE 21 that
        // day (at majority) → NOT a minor child → WITHHOLD.
        facts: minorChildFacts({
          beneficiaryBirthdate: '2003-06-15',
          inheritedOwnerDeathDate: '2024-06-15',
        }),
        accountType: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ages: {},
        taxYear: 2030,
        tables: TABLES,
      });
      expect(r.kind).toBe('withheld');
      if (r.kind === 'withheld') {
        expect(r.missingFacts).toContain('minorChildBeneficiaryNotMinorAtDeath');
      }
    });
  });

  it('honours a TEN_YEAR election by an eligible designated beneficiary who died BEFORE RBD', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'TEN_YEAR',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedTenYearRule');
  });

  // The 10-year election is available to an EDB ONLY when the owner died
  // BEFORE their RBD. A stored TEN_YEAR election combined with an on/after-RBD death
  // is an incompatible combination → WITHHOLD (never silently apply the wrong rule).
  it('WITHHOLDS an EDB TEN_YEAR election when the owner died ON/AFTER RBD', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'TEN_YEAR',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: true,
        originalOwnerBirthdate: '1945-01-01',
        beneficiaryBirthdate: '1963-01-01',
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('tenYearElectionInvalidWhenOwnerDiedOnOrAfterRbd');
    }
  });

  it('withholds an eligible-beneficiary stretch when the beneficiary birthdate/age is missing', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    expect(r.kind === 'withheld' && r.missingFacts).toContain('beneficiaryBirthdate');
  });

  it('applies the 10-year rule with REQUIRED annual RMDs when the owner died on/after RBD', () => {
    const r = resolveRmdRule({
      facts: complete,
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedTenYearRule');
    expect(r.kind === 'inheritedTenYearRule' && r.annualDistributionRequired).toBe(true);
  });

  // The non-eligible-designated 10-year branch withholds on missing age
  // (age is derived from the birthdate, so an absent birthdate is the miss).
  it('withholds the annual-RMD 10-year branch when the beneficiary birthdate is missing', () => {
    const r = resolveRmdRule({
      facts: { ...complete, beneficiaryBirthdate: undefined },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    expect(r.kind === 'withheld' && r.missingFacts).toContain('beneficiaryBirthdate');
  });

  it('applies the 10-year rule with NO annual RMD when the owner died before RBD', () => {
    const r = resolveRmdRule({
      facts: { ...complete, inheritedOwnerDiedOnOrAfterRbd: false },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedTenYearRule');
    if (r.kind === 'inheritedTenYearRule') {
      expect(r.annualDistributionRequired).toBe(false);
      expect(r.selection).toBeNull();
    }
  });

  it('applies the 5-year rule for a non-person beneficiary when the owner died before RBD', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'NON_PERSON',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedFiveYearRule');
  });

  it('withholds a non-person beneficiary when the owner died on/after RBD (ghost-life needs decedent birthdate)', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'NON_PERSON',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: true,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
  });
});

// ---------------------------------------------------------------------------
// Inherited-account routing: only RETIREMENT accounts are subject to RMD
// when inherited; a Roth account is always treated as a death-before-RBD.
// ---------------------------------------------------------------------------
describe('resolveRmdRule — inherited routing by account type', () => {
  const inheritedFacts: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: 'OTHER_DESIGNATED',
    inheritedOwnerDeathDate: '2023-05-01',
    inheritedOwnerDiedOnOrAfterRbd: true,
    originalOwnerBirthdate: '1945-01-01',
  };

  it.each([
    ['HSA', 'HSA'],
    ['BROKERAGE', 'POST_TAX'],
  ] as const)('does NOT subject an inherited %s to RMD rules — notRequired', (accountType, taxTreatment) => {
    const r = resolveRmdRule({
      facts: inheritedFacts,
      accountType,
      taxTreatment,
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('notRequired');
  });

  it('treats an inherited Roth IRA as death-BEFORE-RBD, overriding a stored on/after-RBD flag', () => {
    const r = resolveRmdRule({
      // Stored flag CLAIMS the owner died on/after RBD, but a Roth owner has no
      // lifetime RBD — the 10-year rule must therefore carry NO annual RMD.
      facts: inheritedFacts,
      accountType: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedTenYearRule');
    if (r.kind === 'inheritedTenYearRule') {
      expect(r.annualDistributionRequired).toBe(false); // Roth override → pre-RBD
      expect(r.selection).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 10-year rule: annual RMD only in offset years 1–9 (owner died on/after
// RBD); year-10 full-liquidation deadline is its own distinct fact.
// ---------------------------------------------------------------------------
describe('resolveRmdRule — 10-year-rule year offsets', () => {
  // Non-eligible designated beneficiary; owner died on/after RBD; death year 2024.
  const facts: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: 'OTHER_DESIGNATED',
    inheritedOwnerDeathDate: '2024-05-01',
    inheritedOwnerDiedOnOrAfterRbd: true,
    originalOwnerBirthdate: '1945-01-01',
    beneficiaryBirthdate: '1964-05-01', // Derived age ~60 across the probed years
  };
  const annualAt = (taxYear: number): RmdRuleResolution =>
    resolveRmdRule({
      facts,
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear,
      tables: TABLES,
    });

  it.each([
    [2024, false], // year 0 (death year) — no annual RMD
    [2025, true], // year 1
    [2033, true], // year 9
    [2034, false], // year 10 — liquidation deadline, no annual RMD
    [2035, false], // year 11 — past the deadline
  ] as const)('taxYear %i → annualDistributionRequired %s', (taxYear, expected) => {
    const r = annualAt(taxYear);
    expect(r.kind).toBe('inheritedTenYearRule');
    if (r.kind === 'inheritedTenYearRule') {
      expect(r.annualDistributionRequired).toBe(expected);
      expect(r.fullLiquidationByYear).toBe(2034); // deathYear 2024 + 10
    }
  });
});

// ---------------------------------------------------------------------------
// Longer-of (beneficiary vs decedent) life expectancy; surviving-spouse
// delayed start.
// ---------------------------------------------------------------------------
describe('resolveRmdRule — longer-of ghost life + spousal delay', () => {
  const edbStretch = (beneficiaryAge: number, originalOwnerBirthdate: string): RmdRuleResolution =>
    resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2024-05-01', // deathYear 2024
        inheritedOwnerDiedOnOrAfterRbd: true,
        originalOwnerBirthdate,
        // Beneficiary age is DERIVED; encode the intended age via birthdate.
        beneficiaryBirthdate: `${2025 - beneficiaryAge}-01-01`,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025, // first distribution year
      tables: TABLES,
    });

  it('uses the DECEDENT’s remaining life expectancy when it is longer', () => {
    // Beneficiary age 80 → Table I[80] = 11.2; decedent born 1954 → age 70 in the
    // 2024 death year → Table I[70] 18.8 − 1 (elapsed) = 17.8 → longer, so used.
    const r = edbStretch(80, '1954-01-01');
    expect(r.kind).toBe('inheritedLifeExpectancy');
    if (r.kind === 'inheritedLifeExpectancy' && r.selection.kind === 'divisor') {
      expect(r.selection.divisor).toBeCloseTo(17.8, 10);
    } else {
      throw new Error('expected a Single Life divisor selection');
    }
  });

  it('uses the BENEFICIARY’s remaining life expectancy when it is longer', () => {
    // Beneficiary age 55 → Table I[55] = 31.6; decedent born 1944 → age 80 →
    // 11.2 − 1 = 10.2 → shorter, so the beneficiary's 31.6 is used.
    const r = edbStretch(55, '1944-01-01');
    expect(r.kind).toBe('inheritedLifeExpectancy');
    if (r.kind === 'inheritedLifeExpectancy' && r.selection.kind === 'divisor') {
      expect(r.selection.divisor).toBe(31.6);
    } else {
      throw new Error('expected a Single Life divisor selection');
    }
  });

  it('WITHHOLDS an on/after-RBD stretch when the original owner birthdate is missing', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2024-05-01',
        inheritedOwnerDiedOnOrAfterRbd: true,
        beneficiaryBirthdate: '1965-01-01', // Present, so the miss is the OWNER birthdate
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('originalOwnerBirthdate');
    }
  });

  it('DELAYS a surviving spouse (died before RBD) until the owner would have reached RBD', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
        originalOwnerBirthdate: '1960-05-01', // born 1960 → applicable age 75 → RBD year 2035
        beneficiaryBirthdate: '1968-01-01', // Derived spouse age 62 in 2030
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2030, // before 2035 → distributions not yet begun
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedSpousalDelayed');
    if (r.kind === 'inheritedSpousalDelayed') {
      expect(r.firstDistributionYear).toBe(2035);
    }
  });

  it('WITHHOLDS a surviving-spouse delayed start when the owner birthdate is missing', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
        beneficiaryBirthdate: '1968-01-01', // Present, so the miss is the OWNER birthdate
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2030,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('originalOwnerBirthdate');
    }
  });
});

// ---------------------------------------------------------------------------
// A calendar-impossible / out-of-bounds date reaching the resolver directly
// (bypassing the migration sanitiser on a current-version payload) WITHHOLDS.
// ---------------------------------------------------------------------------
describe('resolveRmdRule — malformed date at the runtime boundary', () => {
  it.each([
    ['2023-99-99'], // calendar-impossible
    ['9999-12-31'], // wildly out of the [1900, 2200] bounds
  ] as const)('WITHHOLDS when the inherited-owner death date is %s', (deathDate) => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'OTHER_DESIGNATED',
        inheritedOwnerDeathDate: deathDate,
        inheritedOwnerDiedOnOrAfterRbd: true,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('inheritedOwnerDeathDate');
    }
  });
});

// ---------------------------------------------------------------------------
// Historical applicable (RBD-triggering) age for a DECEASED owner, across
// the 70½ → 72 → 73 → 75 progression. Distinct from the living-owner rmdTriggerAge.
// ---------------------------------------------------------------------------
describe('deceasedOwnerApplicableRmdAge', () => {
  it.each([
    [1945, 70], // pre-SECURE-Act 70½ era
    [1948, 70],
    [1949, 70], // boundary — still 70½ era at year granularity
    [1950, 72], // boundary — SECURE Act (2019) age 72
    [1951, 73], // boundary — SECURE 2.0 age 73
    [1959, 73], // boundary — top of the age-73 band
    [1960, 75], // boundary — SECURE 2.0 age 75
    [1970, 75],
  ] as const)('birth year %i → applicable age %i', (birthYear, expected) => {
    expect(deceasedOwnerApplicableRmdAge(birthYear)).toBe(expected);
  });

  it('drives the surviving-spouse delayed-start year off the HISTORICAL age, not rmdTriggerAge', () => {
    // Owner born 1950 died before RBD → historical age 72 (NOT rmdTriggerAge's 73),
    // so the spouse may delay until 1950 + 72 = 2022. (A 2020 death is post-SECURE,
    // pre the owner's 2022 RBD.)
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2020-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
        originalOwnerBirthdate: '1950-05-01',
        beneficiaryBirthdate: '1958-01-01',
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2021, // before the 2022 delayed-start year
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedSpousalDelayed');
    if (r.kind === 'inheritedSpousalDelayed') {
      expect(r.firstDistributionYear).toBe(2022); // 1950 + 72 (historical), NOT 2023
    }
  });
});

// ---------------------------------------------------------------------------
// The DEATH YEAR itself is still the owner's FINAL lifetime RMD, not a
// beneficiary year: an individual Table I schedule must NOT produce a divisor for
// taxYear === deathYear (nor for taxYear < deathYear). Beneficiary schedules begin
// the year AFTER death.
// ---------------------------------------------------------------------------
describe('resolveRmdRule — death-year boundary', () => {
  const deathYearFacts = (extra: Partial<RmdAccountProfileFacts>): RmdAccountProfileFacts => ({
    inheritedAccount: true,
    beneficiaryElection: 'LIFE_EXPECTANCY',
    inheritedOwnerDeathDate: '2024-05-01', // deathYear 2024
    beneficiaryBirthdate: '1965-01-01',
    ...extra,
  });

  it('does NOT return a Table I divisor for a SPOUSE in the ON/AFTER-RBD death year', () => {
    const r = resolveRmdRule({
      facts: deathYearFacts({
        beneficiaryType: 'SPOUSE',
        inheritedOwnerDiedOnOrAfterRbd: true,
        originalOwnerBirthdate: '1945-01-01',
      }),
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2024, // === deathYear
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('deathYearIsOwnersFinalRmdYear');
    }
  });

  it('does NOT return a Table I divisor for a NON-SPOUSE in the ON/AFTER-RBD death year', () => {
    const r = resolveRmdRule({
      facts: deathYearFacts({
        beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
        inheritedOwnerDiedOnOrAfterRbd: true,
        originalOwnerBirthdate: '1945-01-01',
      }),
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2024,
      tables: TABLES,
    });
    // Previously this returned the DECEDENT ghost-life divisor for the death year.
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('deathYearIsOwnersFinalRmdYear');
    }
  });

  it('does NOT return a Table I divisor for a NON-SPOUSE in the BEFORE-RBD death year', () => {
    const r = resolveRmdRule({
      facts: deathYearFacts({
        beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
        inheritedOwnerDiedOnOrAfterRbd: false,
      }),
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2024,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('deathYearIsOwnersFinalRmdYear');
    }
  });

  it('does NOT return a Table I divisor for a SPOUSE in the BEFORE-RBD death year (delayed, no divisor)', () => {
    const r = resolveRmdRule({
      facts: deathYearFacts({
        beneficiaryType: 'SPOUSE',
        inheritedOwnerDiedOnOrAfterRbd: false,
        originalOwnerBirthdate: '1955-05-01', // applicable age 73 → RBD year 2028 > 2024
      }),
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2024,
      tables: TABLES,
    });
    // A spouse whose owner died before RBD delays — the death year yields no divisor.
    expect(r.kind).toBe('inheritedSpousalDelayed');
    expect(r.kind).not.toBe('inheritedLifeExpectancy');
  });

  it('WITHHOLDS when taxYear is BEFORE the owner death year', () => {
    const r = resolveRmdRule({
      facts: deathYearFacts({
        beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
        inheritedOwnerDiedOnOrAfterRbd: false,
      }),
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2023, // < deathYear 2024
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('taxYearBeforeOwnerDeath');
    }
  });
});

// ---------------------------------------------------------------------------
// The beneficiary's attained tax-year age is DERIVED from the stored
// birthdate; there is no separate age input to trust. Missing/malformed birthdate
// on an individual Table I path WITHHOLDS. (Birthdate-wins: no age input exists, so
// no mismatch is possible.)
// ---------------------------------------------------------------------------
describe('resolveRmdRule — beneficiary age derived from birthdate', () => {
  const stretchFacts = (birthdate: string | undefined): RmdAccountProfileFacts => ({
    inheritedAccount: true,
    beneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
    beneficiaryElection: 'LIFE_EXPECTANCY',
    inheritedOwnerDeathDate: '2023-05-01',
    inheritedOwnerDiedOnOrAfterRbd: false,
    beneficiaryBirthdate: birthdate,
  });

  it('WITHHOLDS a stretch when the beneficiary birthdate is MISSING', () => {
    const r = resolveRmdRule({
      facts: stretchFacts(undefined),
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('beneficiaryBirthdate');
    }
  });

  it('WITHHOLDS a stretch when the beneficiary birthdate is MALFORMED', () => {
    const r = resolveRmdRule({
      facts: stretchFacts('2003-99-99'), // calendar-impossible
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('beneficiaryBirthdate');
    }
  });

  it('derives the attained age from the birthdate (a valid birthdate resolves a Single Life divisor)', () => {
    const r = resolveRmdRule({
      facts: stretchFacts('1969-06-01'), // base-year (2024) age 55 → Table I[55] = 31.6
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2024,
      tables: TABLES,
    });
    expect(r.kind).toBe('inheritedLifeExpectancy');
    if (r.kind === 'inheritedLifeExpectancy' && r.selection.kind === 'divisor') {
      expect(r.selection.divisor).toBe(31.6);
    } else {
      throw new Error('expected a Single Life divisor selection');
    }
  });
});

// ---------------------------------------------------------------------------
// A current-version (v6) payload bypasses the migration sanitiser, so the
// resolver re-validates the persisted beneficiary category + election against the
// shared DB validators. An out-of-vocabulary value WITHHOLDS (never coerced).
// ---------------------------------------------------------------------------
describe('resolveRmdRule — persisted enum validation at the runtime boundary', () => {
  it('WITHHOLDS an out-of-vocabulary beneficiaryType (never coerced to LIFE_EXPECTANCY)', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'BOGUS' as RmdAccountProfileFacts['beneficiaryType'],
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('beneficiaryType');
    }
  });

  it('WITHHOLDS an out-of-vocabulary beneficiaryElection (never coerced to LIFE_EXPECTANCY)', () => {
    const r = resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'BOGUS' as RmdAccountProfileFacts['beneficiaryElection'],
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
        beneficiaryBirthdate: '1963-01-01',
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear: 2025,
      tables: TABLES,
    });
    expect(r.kind).toBe('withheld');
    if (r.kind === 'withheld') {
      expect(r.missingFacts).toContain('beneficiaryElection');
    }
  });
});

describe('validateRmdProfileFacts', () => {
  it('reports no blockers for an owner account (absent facts resolve to owner defaults)', () => {
    expect(validateRmdProfileFacts({})).toEqual({ ok: true, blockers: [] });
    expect(validateRmdProfileFacts({ currentEmployerPlan: true, fivePercentOwner: false }).ok).toBe(true);
  });

  it('reports every missing required inherited fact as a blocker with a reason', () => {
    const result = validateRmdProfileFacts({ inheritedAccount: true });
    expect(result.ok).toBe(false);
    const fields = result.blockers.map((b) => b.field);
    expect(fields).toEqual([
      'beneficiaryType',
      'inheritedOwnerDeathDate',
      'inheritedOwnerDiedOnOrAfterRbd',
    ]);
    for (const b of result.blockers) expect(b.reason.length).toBeGreaterThan(0);
  });

  it('is ok once the baseline inherited facts are present', () => {
    expect(
      validateRmdProfileFacts({
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        inheritedOwnerDeathDate: '2023-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fact-based `computeRmd`: the SHARED entry point both engines use.
// ---------------------------------------------------------------------------

describe('computeRmd — fact-based rule activation', () => {
  /** An RMD-age owner (born 1950 → trigger 73 → age 75 in 2025). */
  const OWNER_BIRTHDATE = '1950-06-15';
  const TAX_YEAR = 2025;
  const BALANCE_CENTS = 1_000_000_00; // $1,000,000

  const account = (
    id: string,
    facts?: RmdAccountProfileFacts,
    overrides: { accountType?: 'RETIREMENT_IRA' | 'RETIREMENT_401K' | 'RETIREMENT_ROTH_IRA' } = {},
  ) => ({
    id,
    balanceDec31PriorYearCents: BALANCE_CENTS,
    accountType: overrides.accountType ?? ('RETIREMENT_IRA' as const),
    taxTreatment: 'PRE_TAX' as const,
    ...(facts !== undefined ? { facts } : {}),
  });

  const run = (accounts: ReturnType<typeof account>[], retirementYear?: number) =>
    computeRmd(
      {
        isoBirthdate: OWNER_BIRTHDATE,
        taxYear: TAX_YEAR,
        accounts,
        lifeExpectancyTables: RMD_LIFE_EXPECTANCY_TABLES,
        ...(retirementYear !== undefined ? { retirementYear } : {}),
      },
      SNAPSHOT,
    );

  it('no account carries facts → byte-identical to the legacy path (the absence contract)', () => {
    const legacy = computeRmd(
      { isoBirthdate: OWNER_BIRTHDATE, taxYear: TAX_YEAR, accounts: [account('a')] },
      SNAPSHOT,
    );
    // Same call with `facts: {}` present on the account routes through the FACT path
    // and must land on the same Uniform Lifetime cents.
    const factPath = run([account('a', {})]);
    expect(factPath.ownerRmdCents).toBe(legacy.ownerRmdCents);
    expect(factPath.divisor).toBe(legacy.divisor);
    // The legacy result shape is unchanged (no new fields leak into it).
    expect(legacy.withheldAccounts).toBeUndefined();
    expect(legacy.stillWorkingDeferredAccountIds).toBeUndefined();
    expect(mcParityBaselines.p12_noRothRmdFacts_reproducesLegacyEngine).toBe('byte-identical');
    // The earlier behaviour this replaces: every qualifying account used the
    // Uniform Lifetime Table, with no exception, table selection, or blocker.
    expect(mcParityBaselines.p12_rmdRuleSelection_preFix).toBe('uniform-lifetime-only');
  });

  it('the still-working exception defers ONLY the plan that affirmatively meets every precondition', () => {
    const deferred = account(
      'current-401k',
      {
        currentEmployerPlan: true,
        fivePercentOwner: false,
        planRequiresDistributionAtStatutoryAge: false,
      },
      { accountType: 'RETIREMENT_401K' },
    );
    // Same plan, but the plan's own terms force distribution → NOT deferred.
    const forced = account(
      'forced-401k',
      {
        currentEmployerPlan: true,
        fivePercentOwner: false,
        planRequiresDistributionAtStatutoryAge: true,
      },
      { accountType: 'RETIREMENT_401K' },
    );
    // The exception is year-scoped — the owner is still employed in the tax
    // year (separation is later), so it defers this year.
    const result = run([deferred, forced], TAX_YEAR + 3);
    expect(result.stillWorkingDeferredAccountIds).toEqual(['current-401k']);
    expect(result.perAccountRmdCents['current-401k']).toBeUndefined();
    expect(result.perAccountRmdCents['forced-401k']).toBeGreaterThan(0);
    // The deferred plan's balance is EXCLUDED from the year's requirement.
    expect(result.ownerRmdCents).toBe(result.perAccountRmdCents['forced-401k']);
  });

  // The exception must EXPIRE at separation, and the first RMD
  // year then resolves as the LATER of the trigger-age year and the separation
  // year (§401(a)(9)(C)).
  it('stops deferring a still-working plan in the retirement year and every year after', () => {
    const facts: RmdAccountProfileFacts = {
      currentEmployerPlan: true,
      fivePercentOwner: false,
      planRequiresDistributionAtStatutoryAge: false,
    };
    const forYear = (taxYear: number, retirementYear: number) =>
      computeRmd(
        {
          isoBirthdate: OWNER_BIRTHDATE,
          taxYear,
          accounts: [
            {
              id: 'current-401k',
              balanceDec31PriorYearCents: BALANCE_CENTS,
              accountType: 'RETIREMENT_401K',
              taxTreatment: 'PRE_TAX',
              facts,
            },
          ],
          lifeExpectancyTables: RMD_LIFE_EXPECTANCY_TABLES,
          retirementYear,
        },
        SNAPSHOT,
      );
    // Year before retirement: deferred, $0 required.
    const stillWorking = forYear(2025, 2026);
    expect(stillWorking.stillWorkingDeferredAccountIds).toEqual(['current-401k']);
    expect(stillWorking.ownerRmdCents).toBe(0);
    // The RETIREMENT-TRANSITION year itself: a real minimum is now due.
    const transition = forYear(2026, 2026);
    expect(transition.stillWorkingDeferredAccountIds).toEqual([]);
    expect(transition.ownerRmdCents).toBeGreaterThan(0);
    // And the year AFTER retirement (the pre-fix bug left this at $0 forever).
    const afterRetirement = forYear(2027, 2026);
    expect(afterRetirement.stillWorkingDeferredAccountIds).toEqual([]);
    expect(afterRetirement.ownerRmdCents).toBeGreaterThan(0);
  });

  it('an unknown retirement year denies the still-working deferral (never exempt forever)', () => {
    const result = run([
      account(
        'current-401k',
        {
          currentEmployerPlan: true,
          fivePercentOwner: false,
          planRequiresDistributionAtStatutoryAge: false,
        },
        { accountType: 'RETIREMENT_401K' },
      ),
    ]);
    expect(result.stillWorkingDeferredAccountIds).toEqual([]);
    expect(result.ownerRmdCents).toBeGreaterThan(0);
  });

  // The deferred first-year catch-up base applies the SAME
  // SECURE 2.0 §325 Roth-designated subtraction every other base in the engine
  // applies, through one shared resolver used by both engines.
  it('nets the §325 Roth-designated portion out of the two-years-prior catch-up base', () => {
    const mixed = {
      id: 'mixed-401k',
      balanceDec31PriorYearCents: 1_000_000,
      accountType: 'RETIREMENT_401K' as const,
      taxTreatment: 'MIXED' as const,
      rothPortionCents: 400_000,
      balanceDec31TwoYearsPriorCents: 1_000_000,
      rothPortionTwoYearsPriorCents: 400_000,
    };
    expect(rmdTwoYearsPriorBaseCents(mixed)).toBe(600_000);
    // Absent portion → the whole balance (the same conservative over-estimate the
    // current-year base makes).
    expect(
      rmdTwoYearsPriorBaseCents({ ...mixed, rothPortionTwoYearsPriorCents: undefined }),
    ).toBe(1_000_000);
    // Absent base → undefined, so the caller reports a blocker instead of guessing.
    expect(
      rmdTwoYearsPriorBaseCents({ ...mixed, balanceDec31TwoYearsPriorCents: undefined }),
    ).toBeUndefined();
  });

  it('an unanswered still-working precondition DENIES the deferral (never granted on a blank)', () => {
    // `fivePercentOwner` absent → treated as a 5% owner → exception denied.
    const result = run([
      account(
        'a',
        { currentEmployerPlan: true, planRequiresDistributionAtStatutoryAge: false },
        { accountType: 'RETIREMENT_401K' },
      ),
    ]);
    expect(result.stillWorkingDeferredAccountIds).toEqual([]);
    expect(result.ownerRmdCents).toBeGreaterThan(0);
  });

  it('a verified sole-spouse >10-years-younger designation selects the LARGER Table II divisor', () => {
    const tableIii = run([account('a', {})]);
    const tableIi = run([
      account('a', {
        soleSpouseBeneficiaryMoreThan10YrsYounger: true,
        spouseBeneficiaryBirthdate: '1975-06-15', // 25 years younger
      }),
    ]);
    // Table II's joint-life divisor is larger → a SMALLER required withdrawal.
    expect(tableIi.divisor).toBeGreaterThan(tableIii.divisor!);
    expect(tableIi.ownerRmdCents).toBeLessThan(tableIii.ownerRmdCents);
  });

  it('a sole-spouse designation with a MISSING spouse birthdate is WITHHELD, not downgraded to Table III', () => {
    const result = run([account('a', { soleSpouseBeneficiaryMoreThan10YrsYounger: true })]);
    expect(result.ownerRmdCents).toBe(0);
    expect(result.withheldAccounts?.[0]?.accountId).toBe('a');
    expect(result.withheldAccounts?.[0]?.missingFacts).toContain('spouseBeneficiaryBirthdate');
  });

  it('an inherited account with incomplete beneficiary facts is WITHHELD and lists them', () => {
    const result = run([account('inh', { inheritedAccount: true })]);
    expect(result.applicable).toBe(true);
    expect(result.ownerRmdCents).toBe(0);
    const missing = result.withheldAccounts?.[0]?.missingFacts ?? [];
    expect(missing).toContain('beneficiaryType');
    expect(missing).toContain('inheritedOwnerDeathDate');
    expect(missing).toContain('inheritedOwnerDiedOnOrAfterRbd');
    // The earlier behaviour this replaces: an inherited account silently took the
    // OWNER's Uniform Lifetime requirement instead of withholding.
    expect(mcParityBaselines.p12_inheritedIncompleteFacts_preFix).toBe(
      'owner-uniform-lifetime-applied',
    );
  });

  it('a complete inherited life-expectancy stretch produces a Single Life (Table I) requirement', () => {
    const result = run([
      account('inh', {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2022-08-14',
        inheritedOwnerDiedOnOrAfterRbd: true,
        originalOwnerBirthdate: '1945-02-03',
        beneficiaryBirthdate: '1952-11-30',
      }),
    ]);
    expect(result.withheldAccounts).toEqual([]);
    expect(result.ownerRmdCents).toBeGreaterThan(0);
  });

  it('an elected first-year deferral moves the trigger-year amount into the following year', () => {
    // Born 1952 → trigger age 73 → trigger year 2025 = the first RMD year.
    const triggerYear = computeRmd(
      {
        isoBirthdate: '1952-06-15',
        taxYear: 2025,
        accounts: [
          {
            id: 'a',
            balanceDec31PriorYearCents: BALANCE_CENTS,
            accountType: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
            facts: { firstYearDeferralElected: true },
          },
        ],
        lifeExpectancyTables: RMD_LIFE_EXPECTANCY_TABLES,
      },
      SNAPSHOT,
    );
    // Nothing required THIS year; the amount is reported as deferred to next year.
    expect(triggerYear.ownerRmdCents).toBe(0);
    expect(triggerYear.firstYearDeferrals).toHaveLength(1);
    expect(triggerYear.firstYearDeferrals?.[0]?.dueInYear).toBe(2026);
    expect(triggerYear.firstYearDeferrals?.[0]?.deferredCents).toBeGreaterThan(0);

    // The FOLLOWING year carries two: its own plus the deferred one, sized from the
    // trigger year's own base (Dec 31 two years before this year).
    const catchUpYear = computeRmd(
      {
        isoBirthdate: '1952-06-15',
        taxYear: 2026,
        accounts: [
          {
            id: 'a',
            balanceDec31PriorYearCents: BALANCE_CENTS,
            balanceDec31TwoYearsPriorCents: BALANCE_CENTS,
            accountType: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
            facts: { firstYearDeferralElected: true },
          },
        ],
        lifeExpectancyTables: RMD_LIFE_EXPECTANCY_TABLES,
      },
      SNAPSHOT,
    );
    expect(catchUpYear.deferredCatchUpCents).toBeGreaterThan(0);
    // The per-account map still sums EXACTLY to the owner total (invariant).
    const perAccountSum = Object.values(catchUpYear.perAccountRmdCents).reduce(
      (a, b) => a + b,
      0,
    );
    expect(perAccountSum).toBe(catchUpYear.ownerRmdCents);
    // Two RMDs in one year: strictly more than a non-deferring owner would owe.
    const noDeferral = run([account('a', {})]);
    expect(catchUpYear.ownerRmdCents).toBeGreaterThan(noDeferral.ownerRmdCents);
  });

  it('the catch-up is a BLOCKER when the trigger-year base is unavailable (never guessed)', () => {
    const result = computeRmd(
      {
        isoBirthdate: '1952-06-15',
        taxYear: 2026,
        accounts: [
          {
            id: 'a',
            balanceDec31PriorYearCents: BALANCE_CENTS,
            // no `balanceDec31TwoYearsPriorCents`
            accountType: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
            facts: { firstYearDeferralElected: true },
          },
        ],
        lifeExpectancyTables: RMD_LIFE_EXPECTANCY_TABLES,
      },
      SNAPSHOT,
    );
    expect(result.deferredCatchUpCents).toBe(0);
    expect(result.withheldAccounts?.[0]?.missingFacts).toContain('deferredFirstYearRmdBase');
    // The year's OWN requirement still applies — only the catch-up is withheld.
    expect(result.ownerRmdCents).toBeGreaterThan(0);
  });

  it('a living owner still owes nothing from a Roth IRA (notRequired, silently $0)', () => {
    const result = run([
      {
        id: 'roth',
        balanceDec31PriorYearCents: BALANCE_CENTS,
        accountType: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'POST_TAX',
        facts: {},
      } as unknown as ReturnType<typeof account>,
    ]);
    expect(result.applicable).toBe(false);
    expect(result.ownerRmdCents).toBe(0);
  });
});
