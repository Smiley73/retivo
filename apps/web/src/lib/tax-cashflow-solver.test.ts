import { describe, it, expect } from 'vitest';
import { solveTaxCashflow, type TaxCashflowSolveArgs } from './tax-cashflow-solver';
import { applyTaxYear } from './tax-integration';
import type { TaxCalibrationBundle, TaxYearInput, TaxMemberInput } from './tax-integration';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { IRMAA_TIERS } from './irmaa-tiers';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import { RMD_DIVISORS } from './rmd-divisors';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

type WithdrawalClassification = ReturnType<TaxCashflowSolveArgs['classifyForTarget']>;

const REAL_BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

function baseTaxInput(overrides: Partial<TaxYearInput> = {}): TaxYearInput {
  const member: TaxMemberInput = {
    memberId: 'p',
    isoBirthdate: '1960-01-01',
    onMedicare: false,
    hasAcaCoverage: false,
  };
  return {
    taxYear: 2024,
    filingStatus: 'Single',
    grossSsDollars: 0,
    preTaxWithdrawalDollars: 0,
    postTaxNonRothWithdrawalDollars: 0,
    rothWithdrawalDollars: 0,
    otherOrdinaryIncomeDollars: 0,
    taxExemptInterestDollars: 0,
    householdSize: 1,
    members: [member],
    accounts: [],
    taxpayersAge65Plus: 0,
    ...overrides,
  };
}

function allPreTaxClassifier(target: number): WithdrawalClassification {
  return {
    preTaxDollars: target,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: 0,
    rothDollars: 0,
    fundedDollars: target,
  };
}

function baseArgs(overrides: Partial<TaxCashflowSolveArgs> = {}): TaxCashflowSolveArgs {
  return {
    ordinaryNetNeedDollars: 60_000,
    taxInputBase: baseTaxInput(),
    bundle: REAL_BUNDLE,
    irmaaPayment: { ownSsDollarsByMemberId: {} },
    classifyForTarget: allPreTaxClassifier,
    ...overrides,
  };
}

// 2026 Medicare beneficiary with a large own SS benefit and a prior-year MAGI in a non-trivial IRMAA surcharge tier: the fixture for the withheld-surcharge tests.
function withheldMedicareInput(preTaxWithdrawal = 0): TaxYearInput {
  return baseTaxInput({
    taxYear: 2026,
    grossSsDollars: 30_000,
    magiTwoYearsPriorDollars: 130_000, // pushes IRMAA into a non-trivial surcharge tier
    preTaxWithdrawalDollars: preTaxWithdrawal,
    members: [{ memberId: 'p', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false }],
  });
}

describe('solveTaxCashflow', () => {
  it('converges within $1 for an all-pre-tax fundable year', () => {
    const result = solveTaxCashflow(baseArgs());
    expect(result.taxCashflowConverged).toBe(true);
    expect(result.taxCashflowIterations).toBeLessThanOrEqual(8);
    expect(result.taxCashflowShortfallCents).toBe(0);
    expect(result.federalTaxCashNeedCents).toBeGreaterThan(0);
    expect(result.totalTaxCashflowNeedCents).toBeGreaterThan(0);
  });

  it('produces a fixpoint: the converged tax need is self-consistent', () => {
    const result = solveTaxCashflow(baseArgs());
    expect(
      Math.abs(result.totalTaxCashflowNeedCents - result.federalTaxCashNeedCents),
    ).toBeLessThanOrEqual(100);
  });

  it('stops after 8 passes and marks non-convergence when the loop never settles', () => {
    let flip = false;
    const oscillating = (target: number): WithdrawalClassification => {
      flip = !flip;
      const pre = flip ? target + 500_000 : target;
      return {
        preTaxDollars: pre,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 0,
        fundedDollars: pre,
      };
    };
    const result = solveTaxCashflow(baseArgs({ classifyForTarget: oscillating }));
    expect(result.taxCashflowIterations).toBe(8);
    expect(result.taxCashflowConverged).toBe(false);
  });

  it('marks a shortfall when the portfolio cannot fund the grossed-up draw', () => {
    const capped = (target: number): WithdrawalClassification => {
      const funded = Math.min(target, 40_000);
      return {
        preTaxDollars: funded,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 0,
        fundedDollars: funded,
      };
    };
    const result = solveTaxCashflow(baseArgs({ classifyForTarget: capped }));
    expect(result.taxCashflowShortfallCents).toBeGreaterThan(0);
    expect(result.taxYearResult).toBeDefined();
  });

  it('withholds IRMAA from the member own SS when receiving their own benefit (no cash need)', () => {
    const args = baseArgs({
      ordinaryNetNeedDollars: 20_000,
      taxInputBase: baseTaxInput({
        taxYear: 2026,
        grossSsDollars: 40_000,
        magiTwoYearsPriorDollars: 250_000, // pushes IRMAA into a surcharge tier
        members: [{ memberId: 'p', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false }],
      }),
      irmaaPayment: { ownSsDollarsByMemberId: { p: 40_000 } },
    });
    const result = solveTaxCashflow(args);
    expect(result.irmaaWithheldFromSsCents).toBeGreaterThan(0);
    expect(result.irmaaCashNeedCents).toBe(0);
  });

  it('treats IRMAA as a cash need when on Medicare but not receiving their own SS', () => {
    const args = baseArgs({
      ordinaryNetNeedDollars: 20_000,
      taxInputBase: baseTaxInput({
        taxYear: 2026,
        grossSsDollars: 0,
        magiTwoYearsPriorDollars: 250_000,
        members: [{ memberId: 'p', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false }],
      }),
      irmaaPayment: { ownSsDollarsByMemberId: {} },
    });
    const result = solveTaxCashflow(args);
    expect(result.irmaaCashNeedCents).toBeGreaterThan(0);
    expect(result.irmaaWithheldFromSsCents).toBe(0);
    expect(result.totalTaxCashflowNeedCents).toBeGreaterThanOrEqual(result.irmaaCashNeedCents);
  });

  it('mixed household: the Medicare spouse who delays SS pays IRMAA as cash, '
    + 'never withheld from the spouse who is collecting SS', () => {
    // The primary is on Medicare without own SS; the secondary collects $40k SS. A member's surcharge is withheld only from that member's own SS, so the primary's is a cash need (a household-pool split would wrongly withhold it from the secondary).
    const args = baseArgs({
      ordinaryNetNeedDollars: 20_000,
      taxInputBase: baseTaxInput({
        taxYear: 2026,
        filingStatus: 'MFJ',
        householdSize: 2,
        grossSsDollars: 40_000, // entirely the secondary's benefit
        magiTwoYearsPriorDollars: 250_000, // surcharge tier
        members: [
          { memberId: 'p', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
          { memberId: 's', isoBirthdate: '1962-01-01', onMedicare: false, hasAcaCoverage: false },
        ],
      }),
      irmaaPayment: { ownSsDollarsByMemberId: { s: 40_000 } },
    });
    const result = solveTaxCashflow(args);
    expect(result.irmaaCashNeedCents).toBeGreaterThan(0);
    expect(result.irmaaWithheldFromSsCents).toBe(0);
  });

  it('mixed household: each Medicare member is withheld from their OWN SS only', () => {
    const args = baseArgs({
      ordinaryNetNeedDollars: 20_000,
      taxInputBase: baseTaxInput({
        taxYear: 2026,
        filingStatus: 'MFJ',
        householdSize: 2,
        grossSsDollars: 80_000,
        magiTwoYearsPriorDollars: 280_000,
        members: [
          { memberId: 'p', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
          { memberId: 's', isoBirthdate: '1956-01-01', onMedicare: true, hasAcaCoverage: false },
        ],
      }),
      irmaaPayment: { ownSsDollarsByMemberId: { p: 40_000, s: 40_000 } },
    });
    const result = solveTaxCashflow(args);
    expect(result.irmaaWithheldFromSsCents).toBeGreaterThan(0);
    expect(result.irmaaCashNeedCents).toBe(0);
  });

  it('two returns on DIFFERENT IRMAA tiers keep their own surcharge per beneficiary', () => {
    // Both spouses on Medicare, only the secondary collects SS, only the primary's look-back return owes a surcharge: each return's surcharge follows its own beneficiaries, so nothing is withheld from the secondary's check.
    const args = baseArgs({
      ordinaryNetNeedDollars: 20_000,
      taxInputBase: {
        ...baseTaxInput({
          taxYear: 2026,
          filingStatus: 'MFJ',
          householdSize: 2,
          grossSsDollars: 40_000,
          members: [
            { memberId: 'p', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
            { memberId: 's', isoBirthdate: '1956-01-01', onMedicare: true, hasAcaCoverage: false },
          ],
        }),
        memberIdByRole: { primary: 'p', secondary: 's' },
        taxUnits: [
          { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
          { memberIds: ['secondary'], filingStatus: 'MFS', householdSize: 1 },
        ],
        irmaaLookbackUnits: [
          { memberIds: ['p'], filingStatus: 'MFS', mfsLivedWithSpouse: false, magiCents: 30_000_000 },
          { memberIds: ['s'], filingStatus: 'MFS', mfsLivedWithSpouse: false, magiCents: 0 },
        ],
      },
      irmaaPayment: { ownSsDollarsByMemberId: { s: 40_000 } },
    });
    const result = solveTaxCashflow(args);
    const byUnit = result.taxYearResult.irmaaSurchargeCentsByUnit ?? [];
    expect(byUnit).toHaveLength(2);
    expect(byUnit[0].surchargeCents).toBeGreaterThan(0);
    expect(byUnit[1].surchargeCents).toBe(0);
    expect(result.irmaaWithheldFromSsCents).toBe(0);
    expect(result.irmaaCashNeedCents).toBe(result.taxYearResult.irmaaSurchargeCents);
  });

  it('returns the zero result and never throws for a year below the calibration floor', () => {
    // A year before the earliest published table makes `applyTaxYear` throw UnsupportedTaxYearError; the solver must catch it and return zero need, converged.
    const args = baseArgs({
      ordinaryNetNeedDollars: 60_000,
      taxInputBase: baseTaxInput({ taxYear: 1990 }),
    });
    let result!: ReturnType<typeof solveTaxCashflow>;
    expect(() => {
      result = solveTaxCashflow(args);
    }).not.toThrow();
    expect(result.taxCashflowConverged).toBe(true);
    expect(result.totalTaxCashflowNeedCents).toBe(0);
    expect(result.taxCashflowShortfallCents).toBe(0);
    expect(result.federalTaxCashNeedCents).toBe(0);
    expect(result.acaCreditAppliedToPremiumsCents).toBe(0);
  });

  it('taxes the SS-withheld IRMAA draw: trial target grosses up by the withheld '
    + 'surcharge, federal tax reflects it, withheld amount unchanged, still '
    + 'converges', () => {
    // A Medicare member with a large own SS has the full IRMAA surcharge withheld from SS; the runner funds that with an extra pre-tax draw, which is itself taxable, so the solver folds the withheld cents into its trial target.
    const ordinaryNeed = 40_000;
    const targets: number[] = [];
    const recordingClassifier = (target: number): WithdrawalClassification => {
      targets.push(target);
      return allPreTaxClassifier(target);
    };
    const withheldArgs = baseArgs({
      ordinaryNetNeedDollars: ordinaryNeed,
      taxInputBase: withheldMedicareInput(),
      irmaaPayment: { ownSsDollarsByMemberId: { p: 30_000 } },
      classifyForTarget: recordingClassifier,
    });
    const withheld = solveTaxCashflow(withheldArgs);

    expect(withheld.irmaaWithheldFromSsCents).toBeGreaterThan(100_000);
    expect(withheld.irmaaCashNeedCents).toBe(0);

    // The committing target grosses up by the cash tax need and the withheld surcharge; it matches the converged figure only within the $1 threshold since it uses the prior pass's need.
    const finalTarget = targets[targets.length - 1];
    const cashOnlyTarget = ordinaryNeed + withheld.totalTaxCashflowNeedCents / 100;
    const withheldDollars = withheld.irmaaWithheldFromSsCents / 100;
    expect(finalTarget).toBeGreaterThan(cashOnlyTarget + withheldDollars - 2);
    expect(finalTarget).toBeLessThan(cashOnlyTarget + withheldDollars + 2);

    const cashOnlyFed = applyTaxYear(
      withheldMedicareInput(cashOnlyTarget),
      REAL_BUNDLE,
    ).federalTaxCents;
    expect(withheld.federalTaxCashNeedCents).toBeGreaterThan(cashOnlyFed);

    expect(withheld.taxCashflowConverged).toBe(true);
    expect(withheld.taxCashflowIterations).toBeLessThanOrEqual(8);
  });

  it('zero-withheld year is identical with and without the withheld feedback '
    + '(regression guard)', () => {
    const args = baseArgs({ ordinaryNetNeedDollars: 60_000 });
    const result = solveTaxCashflow(args);
    expect(result.irmaaWithheldFromSsCents).toBe(0);
    expect(
      Math.abs(result.totalTaxCashflowNeedCents - result.federalTaxCashNeedCents),
    ).toBeLessThanOrEqual(100);
    expect(result.taxCashflowConverged).toBe(true);
  });

  it('never produces a negative tax cashflow need (ACA PTC offset floored at zero)', () => {
    const args = baseArgs({
      ordinaryNetNeedDollars: 5_000,
      taxInputBase: baseTaxInput({
        taxYear: 2024,
        members: [{ memberId: 'p', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: true }],
      }),
    });
    const result = solveTaxCashflow(args);
    expect(result.totalTaxCashflowNeedCents).toBeGreaterThanOrEqual(0);
  });
});

// One retired single filer, 2026: $31,300 Social Security and a $7,200 benchmark put ACA MAGI at 200.0% of the $15,650 guideline, so the expected contribution is 6.60% = $2,065.80 and the credit $5,134.20 with no federal tax to offset; a Roth draw adds no income.
function aca2026Input(overrides: Partial<TaxYearInput> = {}): TaxYearInput {
  return baseTaxInput({
    taxYear: 2026,
    grossSsDollars: 31_300,
    acaBenchmarkSlcspDollars: 7_200,
    members: [{ memberId: 'p', isoBirthdate: '1963-01-01', onMedicare: false, hasAcaCoverage: true }],
    ...overrides,
  });
}

function allRothClassifier(target: number): WithdrawalClassification {
  return {
    preTaxDollars: 0,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: 0,
    rothDollars: target,
    fundedDollars: target,
  };
}

describe('solveTaxCashflow — credit applied to premiums', () => {
  const rothArgs = (overrides: Partial<TaxCashflowSolveArgs> = {}): TaxCashflowSolveArgs =>
    baseArgs({
      ordinaryNetNeedDollars: 39_900,
      taxInputBase: aca2026Input(),
      classifyForTarget: allRothClassifier,
      ...overrides,
    });

  it('applies the whole excess when the draw and the Medical expenses are larger', () => {
    const result = solveTaxCashflow(rothArgs({ medicalExpenseCents: 720_000 }));
    expect(result.taxYearResult.acaPtcSubsidyCents).toBe(513_420);
    expect(result.totalTaxCashflowNeedCents).toBe(0);
    expect(result.acaPtcCashflowOffsetCents).toBe(0);
    expect(result.acaCreditAppliedToPremiumsCents).toBe(513_420);
  });

  it('is zero without a medical cap, and MAGI, taxable SS and fplPercentage do not move with it', () => {
    const without = solveTaxCashflow(rothArgs());
    const withCap = solveTaxCashflow(rothArgs({ medicalExpenseCents: 720_000 }));
    expect(without.acaCreditAppliedToPremiumsCents).toBe(0);
    for (const key of ['magiCents', 'taxableSsCents', 'fplPercentage', 'federalTaxCents', 'acaPtcSubsidyCents'] as const) {
      expect(withCap.taxYearResult[key]).toBe(without.taxYearResult[key]);
    }
    expect(withCap.totalTaxCashflowNeedCents).toBe(without.totalTaxCashflowNeedCents);
    expect(withCap.acaPtcCashflowOffsetCents).toBe(without.acaPtcCashflowOffsetCents);
  });

  it('feeds the line into the next trial target and the convergence test', () => {
    const targets: number[] = [];
    const result = solveTaxCashflow(
      rothArgs({
        medicalExpenseCents: 720_000,
        classifyForTarget: (target) => {
          targets.push(target);
          return allRothClassifier(target);
        },
      }),
    );
    expect(targets[0]).toBe(39_900);
    expect(targets[1]).toBeCloseTo(34_765.8, 6);
    expect(result.taxCashflowIterations).toBe(2);
    expect(result.taxCashflowConverged).toBe(true);
  });

  it('with a pre-tax draw, converges and reports the final pass\'s line, not the first\'s', () => {
    const input = aca2026Input({ grossSsDollars: 30_000 });
    const args = baseArgs({
      ordinaryNetNeedDollars: 15_000,
      taxInputBase: input,
      classifyForTarget: allPreTaxClassifier,
      medicalExpenseCents: 2_000_000,
    });
    const result = solveTaxCashflow(args);
    expect(result.taxCashflowConverged).toBe(true);
    expect(result.taxCashflowIterations).toBeGreaterThan(1);
    const finalExcess = Math.max(
      0,
      result.taxYearResult.acaPtcSubsidyCents - result.acaPtcCashflowOffsetCents,
    );
    const remaining =
      1_500_000 + result.totalTaxCashflowNeedCents + result.irmaaWithheldFromSsCents;
    expect(result.acaCreditAppliedToPremiumsCents).toBe(Math.min(finalExcess, remaining));
    const firstPass = applyTaxYear(
      { ...input, preTaxWithdrawalDollars: 15_000 },
      REAL_BUNDLE,
    );
    expect(firstPass.acaPtcSubsidyCents).not.toBe(result.taxYearResult.acaPtcSubsidyCents);
    expect(result.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
  });

  describe('near the poverty line', () => {
    // No SS, all pre-tax: a $22,000 draw (140.6% of the guideline) earns a $6,405.80 credit that would lower it to 99.6%, where it earns none.
    const cliffArgs = (overrides: Partial<TaxCashflowSolveArgs> = {}): TaxCashflowSolveArgs =>
      baseArgs({
        ordinaryNetNeedDollars: 22_000,
        taxInputBase: aca2026Input({ grossSsDollars: 0 }),
        classifyForTarget: allPreTaxClassifier,
        medicalExpenseCents: 720_000,
        ...overrides,
      });

    it('holds the line to the MAGI above the poverty line, so the lowered draw still earns the credit', () => {
      const targets: number[] = [];
      const result = solveTaxCashflow(
        cliffArgs({
          classifyForTarget: (target) => {
            targets.push(target);
            return allPreTaxClassifier(target);
          },
        }),
      );
      const lineFree = solveTaxCashflow(cliffArgs({ medicalExpenseCents: undefined }));
      expect(result.taxCashflowConverged).toBe(true);
      const headroomCents = (22_000 - 15_650) * 100;
      expect(result.acaCreditAppliedToPremiumsCents).toBe(headroomCents);
      for (const target of targets) expect(target).toBeGreaterThanOrEqual(15_650);
      expect(result.taxYearResult.fplPercentage).toBeGreaterThanOrEqual(100);
      expect(result.taxYearResult.acaPtcSubsidyCents).toBeGreaterThan(0);
      expect(result.acaCreditAppliedToPremiumsCents).toBeLessThanOrEqual(
        result.taxYearResult.acaPtcSubsidyCents - result.acaPtcCashflowOffsetCents,
      );
      expect(lineFree.acaCreditAppliedToPremiumsCents).toBe(0);
    });

    it('applies the whole line when the draw is qualified Roth, which sheds no MAGI', () => {
      const result = solveTaxCashflow(
        baseArgs({
          ordinaryNetNeedDollars: 20_000,
          taxInputBase: aca2026Input({ grossSsDollars: 0, otherOrdinaryIncomeDollars: 15_650 }),
          classifyForTarget: allRothClassifier,
          medicalExpenseCents: 720_000,
        }),
      );
      expect(result.taxYearResult.fplPercentage).toBeGreaterThanOrEqual(100);
      expect(result.taxYearResult.acaMagiAboveFplCents).toBe(0);
      expect(result.acaCreditAppliedToPremiumsCents).toBe(
        result.taxYearResult.acaPtcSubsidyCents - result.acaPtcCashflowOffsetCents,
      );
      expect(result.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
    });

    it('counts the taxable Roth earnings as MAGI the lowered draw sheds', () => {
      // A nonqualified Roth draw's earnings are ACA MAGI, so the line stops at the guideline as with a pre-tax draw.
      const earningsArgs = (overrides: Partial<TaxCashflowSolveArgs> = {}): TaxCashflowSolveArgs =>
        baseArgs({
          ordinaryNetNeedDollars: 18_000,
          taxInputBase: aca2026Input({ grossSsDollars: 0, otherOrdinaryIncomeDollars: 18_000 }),
          classifyForTarget: allRothClassifier,
          medicalExpenseCents: 720_000,
          ...overrides,
        });
      const result = solveTaxCashflow(earningsArgs({ rothEarningsIncomeDollars: 18_000 }));
      expect(result.acaCreditAppliedToPremiumsCents).toBe((18_000 - 15_650) * 100);
      expect(result.taxYearResult.fplPercentage).toBeGreaterThanOrEqual(100);
      const unmodeled = solveTaxCashflow(earningsArgs());
      expect(unmodeled.acaCreditAppliedToPremiumsCents).toBeGreaterThan(
        result.acaCreditAppliedToPremiumsCents,
      );
    });
  });
});
