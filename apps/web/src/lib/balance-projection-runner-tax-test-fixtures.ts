/**
 * Shared test fixtures for the tax-integration runner suites. Extracted so
 * `balance-projection-runner-tax.test.ts` (annotation post-pass) and
 * `balance-projection-runner-tax-cashflow.test.ts` (the `buildTaxCashflowHook`
 * coverage, split out for the 800-ln file cap) consume one set of
 * builders instead of duplicating ~160 lines of `PipelineContext` scaffolding.
 *
 * Test-only: not imported by production code.
 */
import type { DrawdownYear, DrawdownAccountInput, DrawdownAccountYear } from './drawdown-engine-types';
import type { RothDistributionFacts } from './roth-distribution-tax';
import type { RmdAccountProfileFacts } from './rmd';
import type { PipelineContext } from './balance-projection-runner-types';
import type { MagiCapOverride } from '../db/types';
import type { TaxCalibrationBundle } from './tax-integration';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { IRMAA_TIERS } from './irmaa-tiers';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import { RMD_DIVISORS } from './rmd-divisors';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

export const REAL_BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

/** Minimal DrawdownYear row (no tax fields yet). */
export function makeDrawdownYear(
  year: number,
  withdrawn: number,
  accountBalances?: ReadonlyMap<string, DrawdownAccountYear>,
): DrawdownYear {
  return {
    year,
    balance: 500_000,
    withdrawn,
    netNeed: withdrawn,
    growth: 0,
    deposit: 0,
    depleted: false,
    accountBalances,
  };
}

/** Build a minimal DrawdownAccountYear (for accountBalances maps). */
export function makeAccountBalance(
  balance: number,
  withdrawn: number,
  opts: { preWithdrawnCents?: number; postWithdrawnCents?: number } = {},
): DrawdownAccountYear {
  return {
    balance,
    preEnd: 0,
    postEnd: balance,
    withdrawn,
    deposit: 0,
    ...(opts.preWithdrawnCents !== undefined ? { preWithdrawnCents: opts.preWithdrawnCents } : {}),
    ...(opts.postWithdrawnCents !== undefined ? { postWithdrawnCents: opts.postWithdrawnCents } : {}),
  };
}

/** Minimal DrawdownAccountInput. `accountType` / `taxTreatment` are
 *  overridable so a test can build an HSA or cash-like (SAVINGS/CD/MM) ledger
 *  account; default to a PRE_TAX IRA for the existing callers. */
export function makeLedgerAccount(
  id: string,
  initialPre: number,
  initialPost: number = 0,
  opts: {
    accountType?: DrawdownAccountInput['accountType'];
    taxTreatment?: DrawdownAccountInput['taxTreatment'];
  } = {},
): DrawdownAccountInput {
  return {
    id,
    initialPre,
    initialPost,
    annualRatePct: 5,
    depositsByMonth: [] as unknown as DrawdownAccountInput['depositsByMonth'],
    taxTreatment: opts.taxTreatment ?? 'PRE_TAX',
    accountType: opts.accountType ?? 'RETIREMENT_IRA',
  };
}

/** Lightweight per-account projection overrides accepted by `makeCtx`. */
export type MakeCtxAccountProjections = Array<{
  id: string;
  taxTreatment: 'PRE_TAX' | 'POST_TAX' | 'MIXED' | 'ROTH' | 'HSA';
  accountType: string;
  ownerId?: string;
}>;

interface MakeCtxOverrides {
  withdrawalStrategy?: { kind: 'taxEfficient' | 'proportional' | 'rothFirst' | 'customOrder' };
  magiBootstrapLookbackMinus2?: number;
  magiBootstrapLookbackMinus1?: number;
  costBasisFraction?: number;
  primaryBirthdate?: string;
  secondaryBirthdate?: string;
  primaryRetirementYear?: number;
  /** The secondary's OWN separation-from-service year (seeds
   *  `retirementByMember`), so a test can build a STAGGERED-retirement
   *  household. Default: absent → the secondary inherits the primary's year,
   *  which is what the same-date anchor produces. */
  secondaryRetirementYear?: number;
  accountProjections?: MakeCtxAccountProjections;
  /** Per-owner derived Roth-IRA contribution basis in CENTS, keyed by
   *  ownerId. Seeds the deterministic §408A cumulative basis tracker. */
  rothBasisCentsByOwner?: ReadonlyMap<string, number>;
  /** Per-owner pure designated-Roth employer-plan at-retirement
   *  balance in CENTS (ROTH_401K / ROTH_403B / ROTH_457B / ROTH_TSP). */
  pureRothBasisCentsByOwner?: ReadonlyMap<string, number>;
  /** Per-owner MIXED Roth-designated post sub-bucket
   *  at-retirement balance in CENTS (MIXED 401K/403B/457B/TSP). */
  mixedRothDesignatedBasisCentsByOwner?: ReadonlyMap<string, number>;
  /** OQ-conversion — per-owner working-years Roth-conversion principal in CENTS.
   *  Deterministic-only; not seeded into the MC §408A carrier. */
  preRetirementConversionBasisCentsByOwner?: ReadonlyMap<string, number>;
  earlyWithdrawalPenaltyExemptAccountIds?: readonly string[];
  /** ACA opt-out — household member ids treated as NOT on the ACA Marketplace.
   *  Seeds both the resolved-scenario override and the `PipelineContext` Set the
   *  member-flag derivation reads. Default: no opt-outs. */
  acaMarketplaceOptOutMemberIds?: readonly string[];
  /** The scenario's medical inflation rate (percent) that grows the rough ACA
   *  benchmark. Default: absent → no growth. */
  medicalInflationRatePct?: number;
  /** The stored per-member/per-year health-coverage MONTHS the engines
   *  overlay on the automatic birthday-based derivation. Default: none stated. */
  healthCoverageMonths?: PipelineContext['healthCoverageMonths'];
  /** Share of EMERGENCY HSA withdrawals treated as qualified (percent).
   *  Drives the nonqualified HSA-income / 20% additional-tax share on the
   *  emergency-reserve HSA pass only; modeled medical-qualified withdrawals are
   *  always 100% qualified, unaffected by this setting. Default 100. */
  hsaQualifiedMedicalExpensePct?: number;
  /** The Fill-mode target Roth account id, so the conversion basis-carrier
   *  credit (`creditRothConversionToBasisCarrier`) can resolve its owner. */
  magiCapTargetRothAccountId?: string;
  /** A FULL multi-window `magiCap` override. When
   *  present it takes precedence over the single-window `magiCapTargetRothAccountId`
   *  default, so a test can credit conversions across distinct windows / years. */
  magiCap?: MagiCapOverride;
  /** The fact-based Roth tax profile (per-owner Roth-IRA facts + per-ACCOUNT
   *  designated-Roth facts). Defaults to empty (no recorded facts → conservative
   *  $0 basis and unsatisfied five-year clocks everywhere). */
  rothDistributionFacts?: RothDistributionFacts;
  /** Per-account normalized RMD profile facts. Default: none recorded, so
   *  the RMD engine keeps its legacy Uniform-Lifetime path. */
  rmdProfileFactsByAccountId?: ReadonlyMap<string, RmdAccountProfileFacts>;
}

/** Build the primary + optional secondary household members. */
function makeMembers(
  primaryBirthdate: string,
  secondaryBirthdate: string | undefined,
): { primary: unknown; secondary: unknown } {
  const primary = {
    id: 'member-primary',
    householdId: 'hh1',
    payload: {
      isPrimary: true,
      birthdate: primaryBirthdate,
      firstName: 'Test',
      lastName: 'User',
    },
    schemaVersion: 1,
    updatedAt: '',
  };

  const secondary = secondaryBirthdate
    ? {
        id: 'member-secondary',
        householdId: 'hh1',
        payload: {
          isPrimary: false,
          birthdate: secondaryBirthdate,
          firstName: 'Test2',
          lastName: 'User2',
        },
        schemaVersion: 1,
        updatedAt: '',
      }
    : undefined;

  return { primary, secondary };
}

/** Map the lightweight account-projection overrides to full fixtures. */
function makeAccountProjections(
  accountProjections: NonNullable<MakeCtxOverrides['accountProjections']>,
): unknown[] {
  return accountProjections.map((a) => ({
    account: {
      id: a.id,
      householdId: 'hh1',
      payload: {
        name: `Account ${a.id}`,
        type: a.accountType,
        ownerId: a.ownerId ?? 'member-primary',
        taxTreatment: a.taxTreatment,
        planningReturnPct: 5,
        isActive: true,
      },
      schemaVersion: 1,
      updatedAt: '',
    },
    latestBalance: 100_000,
    ownerRetirementDate: null,
    outputs: { planned: null, twr: null },
    ratePctByMethod: { planned: 5, twr: null },
    perMonthContribution: { preTax: 0, postTax: 0 },
  }));
}

/** Build the resolved-scenario fixture slice read by the tax helpers. */
function makeResolvedScenario(
  withdrawalStrategy: NonNullable<MakeCtxOverrides['withdrawalStrategy']>,
  costBasisFraction: number | undefined,
  magiBootstrapLookbackMinus2: number | undefined,
  magiBootstrapLookbackMinus1: number | undefined,
  earlyWithdrawalPenaltyExemptAccountIds: readonly string[] | undefined,
  hsaQualifiedMedicalExpensePct: number | undefined,
  magiCapTargetRothAccountId: string | undefined,
  magiCapOverride: MagiCapOverride | undefined,
  acaMarketplaceOptOutMemberIds: readonly string[] | undefined,
): PipelineContext['resolvedScenario'] {
  return {
    withdrawalStrategy,
    assumedCostBasisFractionOfTaxableWithdrawal: costBasisFraction,
    magiBootstrapLookbackMinus2,
    magiBootstrapLookbackMinus1,
    acaPtcBenchmark: [],
    filingStatus: undefined,
    earlyWithdrawalPenaltyExemptAccountIds,
    acaMarketplaceOptOutMemberIds,
    hsaQualifiedMedicalExpensePct,
    // A full multi-window override wins; otherwise a
    // single always-active window (retirement → primary's age 200) carrying the
    // conversion target, so `creditRothConversionToBasisCarrier` resolves it for
    // any test year.
    magiCap:
      magiCapOverride ??
      (magiCapTargetRothAccountId
        ? {
            windows: [
              {
                start: { kind: 'retirementStart' },
                end: { kind: 'age', memberId: 'primary', years: 200, months: 0 },
                magiCeilingAnnualDollars: 0,
                capMode: 'fill',
                capMagiLine: 'irmaa',
                targetRothAccountId: magiCapTargetRothAccountId,
              },
            ],
          }
        : undefined),
  } as unknown as PipelineContext['resolvedScenario'];
}

/**
 * Build a minimal PipelineContext for testing.
 * Only fields read by `applyTaxIntegrationToDrawdownYears` /
 * `buildTaxCashflowHook` are set.
 */
export function makeCtx(overrides: MakeCtxOverrides = {}): PipelineContext {
  const {
    withdrawalStrategy = { kind: 'taxEfficient' as const },
    magiBootstrapLookbackMinus2,
    magiBootstrapLookbackMinus1,
    costBasisFraction,
    primaryBirthdate = '1960-01-01',
    secondaryBirthdate,
    primaryRetirementYear = 2024,
    secondaryRetirementYear,
    accountProjections = [],
    rothBasisCentsByOwner = new Map<string, number>(),
    pureRothBasisCentsByOwner = new Map<string, number>(),
    mixedRothDesignatedBasisCentsByOwner = new Map<string, number>(),
    preRetirementConversionBasisCentsByOwner = new Map<string, number>(),
    earlyWithdrawalPenaltyExemptAccountIds,
    hsaQualifiedMedicalExpensePct,
    magiCapTargetRothAccountId,
    magiCap,
    acaMarketplaceOptOutMemberIds,
    healthCoverageMonths,
    medicalInflationRatePct,
    rmdProfileFactsByAccountId = new Map<string, RmdAccountProfileFacts>(),
  } = overrides;
  // `rothBasisCentsByOwner` IS the per-owner Roth-IRA regular-contribution
  // basis fact, so an explicit `rothDistributionFacts` override wins and
  // otherwise the per-owner map is lifted into the fact shape the deterministic
  // §408A carrier seeds from. Designated-Roth facts are per ACCOUNT and cannot be
  // derived from a per-owner roll-up, so a test that needs them passes them
  // explicitly.
  const rothDistributionFacts: RothDistributionFacts =
    overrides.rothDistributionFacts ?? {
      // Keyed by §408A POOL; a per-owner roll-up lifts into the owner's OWN pool,
      // whose key is the bare owner id (`rothIraPoolKey`).
      rothIraByPool: new Map(
        [...rothBasisCentsByOwner.entries()].map(([ownerId, cents]) => [
          ownerId,
          { rothIra: { regularContributionBasisCents: cents, conversionLots: [] }, ownerId },
        ]),
      ),
      designatedByAccount: new Map(),
    };

  const { primary, secondary } = makeMembers(primaryBirthdate, secondaryBirthdate);
  const mappedAccountProjections = makeAccountProjections(accountProjections);

  return {
    scenarioId: 'scenario-1',
    method: 'planned',
    incomeStreams: [],
    resolvedScenario: makeResolvedScenario(
      withdrawalStrategy,
      costBasisFraction,
      magiBootstrapLookbackMinus2,
      magiBootstrapLookbackMinus1,
      earlyWithdrawalPenaltyExemptAccountIds,
      hsaQualifiedMedicalExpensePct,
      magiCapTargetRothAccountId,
      magiCap,
      acaMarketplaceOptOutMemberIds,
    ),
    effectiveScenarios: [],
    primary,
    secondary,
    primaryRetIso: `${primaryRetirementYear}-01-01`,
    primaryRetirementYear,
    primaryRetirementMonth0: 0,
    primaryRetirementAbsMonth: 0,
    retirementByMember: new Map<string, string>([
      ['member-primary', `${primaryRetirementYear}-01-01`],
      ...(secondaryRetirementYear !== undefined
        ? ([['member-secondary', `${secondaryRetirementYear}-01-01`]] as [string, string][])
        : []),
    ]),
    horizonYear: primaryRetirementYear + 30,
    horizonAbsMonth: 0,
    ssStartYear: primaryRetirementYear + 2,
    projCtx: {} as unknown as PipelineContext['projCtx'],
    accountProjections: mappedAccountProjections as unknown as PipelineContext['accountProjections'],
    cbpLumpSumEventAbsMonth: new Map(),
    preDepositsByAccount: new Map(),
    cbpProjectionByAccount: new Map(),
    cbpValidation: null,
    methodAvailable: true,
    taxBundle: REAL_BUNDLE,
    rothBasisCentsByOwner,
    rothDistributionFacts,
    rmdProfileFactsByAccountId,
    pureRothBasisCentsByOwner,
    mixedRothDesignatedBasisCentsByOwner,
    preRetirementConversionBasisCentsByOwner,
    mixedInPlanConversionBasisCentsByOwner: new Map<string, number>(),
    mixedInPlanConversionBasisCentsByAccount: new Map<string, number>(),
    acaMarketplaceOptOutMemberIds: new Set(acaMarketplaceOptOutMemberIds ?? []),
    healthCoverageMonths,
    medicalInflationRatePct,
  } as unknown as PipelineContext;
}
