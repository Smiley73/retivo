/**
 * Unit tests for the annual tax-cashflow solver.
 */
import { describe, it, expect } from 'vitest';
import {
  solveTaxCashflow,
  type TaxCashflowSolveArgs,
  type WithdrawalClassification,
} from './tax-cashflow-solver';
import { applyTaxYear } from './tax-integration';
import type { TaxCalibrationBundle, TaxYearInput, TaxMemberInput } from './tax-integration';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { IRMAA_TIERS } from './irmaa-tiers';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import { RMD_DIVISORS } from './rmd-divisors';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

const REAL_BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

/** Single-member 2024 tax input, no SS / no Medicare / no ACA. */
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

/** Classifier: route the whole target to pre-tax, always fully funded. */
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

/**
 * 2026 tax input for a Medicare beneficiary collecting a large own SS benefit
 * with a prior-year MAGI that lands in a non-trivial IRMAA surcharge tier — the
 * fixture the withheld-surcharge tests are built on. `preTaxWithdrawal`
 * is the pre-tax draw the year is taxed against (0 for the args base, the
 * cash-only target for the direct federal-tax recomputation).
 */
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
    // Pre-tax draw of ~$60k+ owes federal tax → positive cashflow need.
    expect(result.federalTaxCashNeedCents).toBeGreaterThan(0);
    expect(result.totalTaxCashflowNeedCents).toBeGreaterThan(0);
  });

  it('produces a fixpoint: the converged tax need is self-consistent', () => {
    const result = solveTaxCashflow(baseArgs());
    // The final need should match the federal tax on the grossed-up draw to
    // within the convergence threshold ($1 = 100 cents) — IRMAA/ACA are zero.
    expect(
      Math.abs(result.totalTaxCashflowNeedCents - result.federalTaxCashNeedCents),
    ).toBeLessThanOrEqual(100);
  });

  it('stops after 8 passes and marks non-convergence when the loop never settles', () => {
    // Pathological classifier: tax never settles because each pass reports a
    // wildly different funded classification (alternating huge / tiny pre-tax).
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
    // Portfolio caps funding at $40k — well below the $60k ordinary need.
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
    // Never throws — returns last computed values + diagnostic.
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
    // The IRMAA cash portion raises the total cashflow need.
    expect(result.totalTaxCashflowNeedCents).toBeGreaterThanOrEqual(result.irmaaCashNeedCents);
  });

  it('mixed household: the Medicare spouse who delays SS pays IRMAA as cash, '
    + 'never withheld from the spouse who is collecting SS', () => {
    // Primary is on Medicare but has NOT claimed SS (own SS $0); secondary is
    // NOT on Medicare but IS collecting a large SS benefit. The primary's
    // surcharge must be a CASH need — a member's surcharge is withheld only from
    // that member's own SS, never the secondary's. (A household-pool split would
    // wrongly withhold it from the secondary's $40k benefit.)
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
      // Only the secondary collects SS; the Medicare member (primary) has none.
      irmaaPayment: { ownSsDollarsByMemberId: { s: 40_000 } },
    });
    const result = solveTaxCashflow(args);
    // The Medicare member's surcharge is a cash need, NOT withheld from the
    // collecting spouse's SS.
    expect(result.irmaaCashNeedCents).toBeGreaterThan(0);
    expect(result.irmaaWithheldFromSsCents).toBe(0);
  });

  it('mixed household: each Medicare member is withheld from their OWN SS only', () => {
    // Both members on Medicare and both collecting their own SS. Each
    // member's surcharge is withheld from their own benefit → no cash need,
    // and the total withheld equals the full household surcharge.
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
    // Both spouses are on Medicare, but only the SECONDARY collects Social
    // Security — and only the PRIMARY's look-back return is in a surcharge
    // tier. Re-splitting the merged household surcharge equally would withhold
    // half of the primary's surcharge from the secondary's SS check, which is
    // not how CMS collects it. Each return's own surcharge must follow its own
    // beneficiaries.
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
      // Only the SECONDARY collects SS — and their own return owes nothing.
      irmaaPayment: { ownSsDollarsByMemberId: { s: 40_000 } },
    });
    const result = solveTaxCashflow(args);
    const byUnit = result.taxYearResult.irmaaSurchargeCentsByUnit ?? [];
    expect(byUnit).toHaveLength(2);
    expect(byUnit[0].surchargeCents).toBeGreaterThan(0);
    expect(byUnit[1].surchargeCents).toBe(0);
    // The whole surcharge belongs to the primary, who collects no SS, so NOTHING
    // is withheld from the secondary's check.
    expect(result.irmaaWithheldFromSsCents).toBe(0);
    expect(result.irmaaCashNeedCents).toBe(result.taxYearResult.irmaaSurchargeCents);
  });

  it('returns the zero result and never throws for a year below the calibration floor', () => {
    // A projection year before the earliest published calibration table has no
    // modelable tax — `applyTaxYear` throws `UnsupportedTaxYearError`
    // ({ code: 'UNSUPPORTED_TAX_YEAR' }). The solver must catch it and degrade
    // gracefully (zero need, converged, never throw).
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
    // A member on Medicare AND collecting a large own SS benefit: the full
    // per-beneficiary IRMAA surcharge is withheld from their own SS (no cash
    // need). The runner funds that withheld surcharge with an extra portfolio
    // draw, which is itself taxable pre-tax income — the solver now folds the
    // withheld cents into its trial target so federal tax reflects it.
    const ordinaryNeed = 40_000;
    // Record every target the classifier is asked to fund; the final entry is
    // the committing target the solver converged on.
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

    // The full surcharge is withheld (own SS covers it) — a full per-beneficiary
    // surcharge (>$1,000), not a token cent.
    expect(withheld.irmaaWithheldFromSsCents).toBeGreaterThan(100_000);
    expect(withheld.irmaaCashNeedCents).toBe(0);

    // The committing target grosses up by the cash tax need AND the withheld
    // surcharge — so the pre-tax draw the year is taxed against exceeds the
    // ordinary + cash-need draw by ~the withheld dollars (the feedback). The
    // recorded final target uses the prior pass's need, so it matches the
    // converged figure only to within the $1 convergence threshold.
    const finalTarget = targets[targets.length - 1];
    const cashOnlyTarget = ordinaryNeed + withheld.totalTaxCashflowNeedCents / 100;
    const withheldDollars = withheld.irmaaWithheldFromSsCents / 100;
    expect(finalTarget).toBeGreaterThan(cashOnlyTarget + withheldDollars - 2);
    expect(finalTarget).toBeLessThan(cashOnlyTarget + withheldDollars + 2);

    // Federal tax need equals federal tax on the withheld-grossed pre-tax draw
    // — strictly higher than the federal tax on the cash-only draw (proves the
    // withheld-funded draw is actually taxed, not just funded).
    const cashOnlyFed = applyTaxYear(
      withheldMedicareInput(cashOnlyTarget),
      REAL_BUNDLE,
    ).federalTaxCents;
    expect(withheld.federalTaxCashNeedCents).toBeGreaterThan(cashOnlyFed);

    // The constant withheld offset did not break the contraction.
    expect(withheld.taxCashflowConverged).toBe(true);
    expect(withheld.taxCashflowIterations).toBeLessThanOrEqual(8);
  });

  it('zero-withheld year is identical with and without the withheld feedback '
    + '(regression guard)', () => {
    // No Medicare member → no IRMAA surcharge → withheld cents always zero, so
    // the trial-target withheld addend is a no-op. The result must match the
    // plain all-pre-tax baseline exactly.
    const args = baseArgs({ ordinaryNetNeedDollars: 60_000 });
    const result = solveTaxCashflow(args);
    expect(result.irmaaWithheldFromSsCents).toBe(0);
    // The federal tax need equals the fixpoint on the ordinary draw alone
    // (within the $1 convergence threshold) — no withheld draw inflates it.
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

/**
 * One retired single filer, 2026, with $31,300 of Social Security and a
 * $7,200 benchmark: ACA MAGI is 200.0% of the $15,650 poverty guideline, so the
 * expected contribution is 6.60% = $2,065.80 and the credit is $5,134.20 with no
 * federal tax to offset. A Roth draw adds no income, so the credit does not move
 * with the draw.
 */
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
    // The need stays at its zero floor and the offset is unchanged.
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
    // Pass 1 funds the ordinary need alone; pass 2 funds it less the line.
    expect(targets[0]).toBe(39_900);
    expect(targets[1]).toBeCloseTo(34_765.8, 6);
    // The net cost (need minus line) did not move between the passes: converged.
    expect(result.taxCashflowIterations).toBe(2);
    expect(result.taxCashflowConverged).toBe(true);
  });

  it('with a pre-tax draw, converges and reports the final pass\'s line, not the first\'s', () => {
    // $30,000 of Social Security plus pre-tax draws: the credit moves with the
    // draw, and the line lowers the draw, which raises the credit again.
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
    // Recompute the line from the final pass's own figures.
    const finalExcess = Math.max(
      0,
      result.taxYearResult.acaPtcSubsidyCents - result.acaPtcCashflowOffsetCents,
    );
    const remaining =
      1_500_000 + result.totalTaxCashflowNeedCents + result.irmaaWithheldFromSsCents;
    expect(result.acaCreditAppliedToPremiumsCents).toBe(Math.min(finalExcess, remaining));
    // The first pass classified the ordinary need alone, a different MAGI and credit.
    const firstPass = applyTaxYear(
      { ...input, preTaxWithdrawalDollars: 15_000 },
      REAL_BUNDLE,
    );
    expect(firstPass.acaPtcSubsidyCents).not.toBe(result.taxYearResult.acaPtcSubsidyCents);
    expect(result.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
  });

  describe('near the poverty line', () => {
    // No Social Security, all-pre-tax draws, a $7,200 benchmark: a $22,000 draw is
    // 140.6% of the $15,650 poverty guideline and earns a $6,405.80 credit, but
    // that line would lower the draw to $15,594.20, which is 99.6% and earns none.
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
      // The limit is measured on the line-free first pass: $22,000 of ACA MAGI
      // less the $15,650 poverty guideline.
      const headroomCents = (22_000 - 15_650) * 100;
      expect(result.acaCreditAppliedToPremiumsCents).toBe(headroomCents);
      // No trial draw ever falls under the line, so none of them cycles.
      for (const target of targets) expect(target).toBeGreaterThanOrEqual(15_650);
      // The committed draw is still on the line, and earns a credit there.
      expect(result.taxYearResult.fplPercentage).toBeGreaterThanOrEqual(100);
      expect(result.taxYearResult.acaPtcSubsidyCents).toBeGreaterThan(0);
      // The line is a reduction of the line-free draw, and earned at the lowered draw.
      expect(result.acaCreditAppliedToPremiumsCents).toBeLessThanOrEqual(
        result.taxYearResult.acaPtcSubsidyCents - result.acaPtcCashflowOffsetCents,
      );
      expect(lineFree.acaCreditAppliedToPremiumsCents).toBe(0);
    });

    it('applies the whole line when the draw is qualified Roth, which sheds no MAGI', () => {
      // A $15,650 pension sits exactly on the line; the Roth draw funds the rest.
      // Lowering the Roth draw leaves MAGI where it is, so nothing limits the line.
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
      // A nonqualified Roth draw: its earnings are already in the ordinary income
      // and are ACA MAGI, so the line stops at the poverty guideline as with a
      // pre-tax draw. Without the earnings the Roth draw looks MAGI-free.
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
