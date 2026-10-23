// Oracle: IRS Pub 590-B Appendix B Table III, 2022 revision (effective 2022-01-01).

import { describe, it, expect } from 'vitest';
import {
  computeRmd,
  poolKeyForRmdAccount,
  rmdTwoYearsPriorBaseCents,
  rmdFirstYearDeferralPlan,
  resolveRmdFirstYearPlan,
  resolveRmdRule,
  type RmdAccountProfileFacts,
  type RmdAccountType,
  type RmdRuleResolution,
} from './rmd';
import { RMD_LIFE_EXPECTANCY_TABLES } from './rmd-life-expectancy-tables';
import { validateRmdProfileFacts } from './rmd-validation';
import { SNAPSHOT } from './rmd.test-helpers';
import mcParityBaselines from './__fixtures__/mc-parity-baselines.json';

describe('computeRmd — primary AC', () => {
  it('should_return_1886792_cents_for_born_1952_taxYear_2025_balance_50M_cents', () => {
    // Table III age 73 divisor 26.5: round(50_000_000 / 100 / 26.5 * 100) = 1_886_792.
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
    expect(k1).not.toBe(poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'tsa-1'));
  });

  it('gives every INHERITED account its own singleton key (no aggregation at all)', () => {
    const own = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'ira-1');
    const inherited = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'inh-1', true);
    const otherInherited = poolKeyForRmdAccount('owner-A', 'RETIREMENT_IRA', 'inh-2', true);
    expect(inherited).not.toBe(own);
    expect(inherited).not.toBe(otherInherited);
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

describe('resolveRmdRule — still-working exception', () => {
  const stillWorking: RmdAccountProfileFacts = {
    currentEmployerPlan: true,
    fivePercentOwner: false,
    planRequiresDistributionAtStatutoryAge: false,
  };
  const deferredFor = (
    facts: RmdAccountProfileFacts,
    accountType: RmdAccountType = 'RETIREMENT_401K',
    retirementYear: number | null = 2030,
  ): boolean =>
    resolveRmdRule({
      facts,
      accountType,
      taxTreatment: 'PRE_TAX',
      ages: { ownerAge: 74 },
      taxYear: 2025,
      tables: RMD_LIFE_EXPECTANCY_TABLES,
      ...(retirementYear === null ? {} : { retirementYear }),
    }).kind === 'stillWorkingDeferred';

  it.each([
    'RETIREMENT_401K',
    'RETIREMENT_403B',
    'RETIREMENT_457B',
    'RETIREMENT_TSP',
    'RETIREMENT_CASH_BALANCE',
  ] as const)('defers a non-5%-owner still working at the current employer (%s)', (accountType) => {
    expect(deferredFor(stillWorking, accountType)).toBe(true);
  });

  it.each([
    ['a >5% owner', { ...stillWorking, fivePercentOwner: true }],
    ['a plan that forces distributions at the statutory age', { ...stillWorking, planRequiresDistributionAtStatutoryAge: true }],
    ['an unknown 5%-owner status', { currentEmployerPlan: true, planRequiresDistributionAtStatutoryAge: false }],
    ['a plan that is not the current employer', { fivePercentOwner: false, planRequiresDistributionAtStatutoryAge: false }],
    ['absent plan terms', { currentEmployerPlan: true, fivePercentOwner: false }],
  ] as const)('denies %s', (_label, facts) => {
    expect(deferredFor(facts)).toBe(false);
  });

  it('never defers an IRA, and denies when the retirement year is unknown', () => {
    expect(deferredFor(stillWorking, 'RETIREMENT_IRA')).toBe(false);
    expect(deferredFor(stillWorking, 'RETIREMENT_401K', null)).toBe(false);
  });
});

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

  // Owner age 0 would clamp to the age-73 divisor and understate the RMD.
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
        // Owner born 1948 reached 70½ in 2018, so the spouse's recalculated stretch has begun.
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

  it('spouse recalculation re-looks-up Table I by current age each year', () => {
    const divisorAt = (taxYear: number): number => {
      const r = resolveRmdRule({
        facts: {
          inheritedAccount: true,
          beneficiaryType: 'SPOUSE',
          beneficiaryElection: 'LIFE_EXPECTANCY',
          inheritedOwnerDeathDate: '2023-06-01',
          inheritedOwnerDiedOnOrAfterRbd: false,
          // Owner born 1948: RBD year 2018, past the spousal delay window.
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

  it('non-spouse beneficiary decrements the anchored Table I divisor by exactly 1.0/yr', () => {
    // Death 2023 → base year 2024; born 1969 → age 55, Table I[55] = 31.6.
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

  describe('MINOR_CHILD_OF_OWNER majority transition', () => {
    // Child born 2010 reaches 21 in 2031; the owner died in 2023 before RBD with the child aged 13.
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

    // Year-only subtraction ties all three children below (death 2024, born 2003); the full date decides.
    it('treats a child whose 21st birthday is the day AFTER death as a MINOR', () => {
      const r = resolveRmdRule({
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

describe('resolveRmdRule — 10-year-rule year offsets', () => {
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

describe('resolveRmdRule — deceased owner’s historical applicable age', () => {
  const delayedStart = (ownerBirthYear: number, taxYear: number): RmdRuleResolution =>
    resolveRmdRule({
      facts: {
        inheritedAccount: true,
        beneficiaryType: 'SPOUSE',
        beneficiaryElection: 'LIFE_EXPECTANCY',
        inheritedOwnerDeathDate: '2020-05-01',
        inheritedOwnerDiedOnOrAfterRbd: false,
        originalOwnerBirthdate: `${ownerBirthYear}-05-01`,
        beneficiaryBirthdate: '1958-01-01',
      },
      accountType: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ages: {},
      taxYear,
      tables: TABLES,
    });

  it.each([
    [1950, 72],
    [1951, 73],
    [1959, 73],
    [1960, 75],
    [1970, 75],
  ] as const)('owner born %i delays the spouse until age %i, not the living-owner trigger age', (birthYear, age) => {
    const firstYear = birthYear + age;
    const before = delayedStart(birthYear, firstYear - 1);
    expect(before.kind).toBe('inheritedSpousalDelayed');
    expect(before.kind === 'inheritedSpousalDelayed' && before.firstDistributionYear).toBe(firstYear);
    expect(delayedStart(birthYear, firstYear).kind).toBe('inheritedLifeExpectancy');
  });

  it('owner born before 1950 (70½ era) has already reached the delay year, so no spousal delay', () => {
    expect(delayedStart(1949, 2020).kind).toBe('inheritedLifeExpectancy');
  });
});

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

describe('computeRmd — fact-based rule activation', () => {
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
    const factPath = run([account('a', {})]);
    expect(factPath.ownerRmdCents).toBe(legacy.ownerRmdCents);
    expect(factPath.divisor).toBe(legacy.divisor);
    expect(legacy.withheldAccounts).toBeUndefined();
    expect(legacy.stillWorkingDeferredAccountIds).toBeUndefined();
    expect(mcParityBaselines.p12_noRothRmdFacts_reproducesLegacyEngine).toBe('byte-identical');
    expect(mcParityBaselines.p12_rmdRuleSelection_preFix).toBe('uniform-lifetime-only');
    expect(mcParityBaselines.p12_inheritedIncompleteFacts_preFix).toBe('owner-uniform-lifetime-applied');
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
    const forced = account(
      'forced-401k',
      {
        currentEmployerPlan: true,
        fivePercentOwner: false,
        planRequiresDistributionAtStatutoryAge: true,
      },
      { accountType: 'RETIREMENT_401K' },
    );
    const result = run([deferred, forced], TAX_YEAR + 3);
    expect(result.stillWorkingDeferredAccountIds).toEqual(['current-401k']);
    expect(result.perAccountRmdCents['current-401k']).toBeUndefined();
    expect(result.perAccountRmdCents['forced-401k']).toBeGreaterThan(0);
    expect(result.ownerRmdCents).toBe(result.perAccountRmdCents['forced-401k']);
  });

  // SECURE 2.0 §325: the catch-up base nets the Roth-designated portion like every other base.
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
    expect(
      rmdTwoYearsPriorBaseCents({ ...mixed, rothPortionTwoYearsPriorCents: undefined }),
    ).toBe(1_000_000);
    expect(
      rmdTwoYearsPriorBaseCents({ ...mixed, balanceDec31TwoYearsPriorCents: undefined }),
    ).toBeUndefined();
  });

  it('a verified sole-spouse >10-years-younger designation selects the LARGER Table II divisor', () => {
    const tableIii = run([account('a', {})]);
    const tableIi = run([
      account('a', {
        soleSpouseBeneficiaryMoreThan10YrsYounger: true,
        spouseBeneficiaryBirthdate: '1975-06-15',
      }),
    ]);
    expect(tableIi.divisor).toBeGreaterThan(tableIii.divisor!);
    expect(tableIi.ownerRmdCents).toBeLessThan(tableIii.ownerRmdCents);
  });

  it('an inherited account with incomplete beneficiary facts is WITHHELD and lists them', () => {
    const result = run([account('inh', { inheritedAccount: true })]);
    expect(result.applicable).toBe(true);
    expect(result.ownerRmdCents).toBe(0);
    const missing = result.withheldAccounts?.[0]?.missingFacts ?? [];
    expect(missing).toContain('beneficiaryType');
    expect(missing).toContain('inheritedOwnerDeathDate');
    expect(missing).toContain('inheritedOwnerDiedOnOrAfterRbd');
  });

  it('an elected first-year deferral moves the trigger-year amount into the following year', () => {
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
    expect(triggerYear.ownerRmdCents).toBe(0);
    expect(triggerYear.firstYearDeferrals).toHaveLength(1);
    expect(triggerYear.firstYearDeferrals?.[0]?.dueInYear).toBe(2026);
    expect(triggerYear.firstYearDeferrals?.[0]?.deferredCents).toBeGreaterThan(0);

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
    const perAccountSum = Object.values(catchUpYear.perAccountRmdCents).reduce(
      (a, b) => a + b,
      0,
    );
    expect(perAccountSum).toBe(catchUpYear.ownerRmdCents);
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
