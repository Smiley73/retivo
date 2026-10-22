/** Shared `PipelineContext` and ledger builders for the tax-integration runner suites. */
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

/** Builds a minimal DrawdownAccountYear for accountBalances maps. */
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

/** Minimal ledger account; defaults to a PRE_TAX IRA, overridable to an HSA or cash-like type. */
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
  /** Default: absent → the secondary inherits the primary's year (the same-date anchor). */
  secondaryRetirementYear?: number;
  accountProjections?: MakeCtxAccountProjections;
  rothBasisCentsByOwner?: ReadonlyMap<string, number>;
  pureRothBasisCentsByOwner?: ReadonlyMap<string, number>;
  mixedRothDesignatedBasisCentsByOwner?: ReadonlyMap<string, number>;
  /** Deterministic-only; not seeded into the MC §408A carrier. */
  preRetirementConversionBasisCentsByOwner?: ReadonlyMap<string, number>;
  earlyWithdrawalPenaltyExemptAccountIds?: readonly string[];
  acaMarketplaceOptOutMemberIds?: readonly string[];
  /** Default: absent → no growth. */
  medicalInflationRatePct?: number;
  healthCoverageMonths?: PipelineContext['healthCoverageMonths'];
  /** Applies to the emergency-reserve HSA pass only; modeled medical-qualified withdrawals are always 100% qualified. Default 100. */
  hsaQualifiedMedicalExpensePct?: number;
  magiCapTargetRothAccountId?: string;
  /** Takes precedence over the single-window `magiCapTargetRothAccountId` default. */
  magiCap?: MagiCapOverride;
  /** Default: empty (no recorded facts → $0 basis and unmet five-year clocks everywhere). */
  rothDistributionFacts?: RothDistributionFacts;
  /** Default: none recorded, so the RMD engine keeps its legacy Uniform-Lifetime path. */
  rmdProfileFactsByAccountId?: ReadonlyMap<string, RmdAccountProfileFacts>;
}

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
    // A full multi-window override wins; otherwise one always-active window carries the conversion target.
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

/** Builds a minimal PipelineContext with the fields read by the tax post-pass and the cashflow hook. */
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
  // An explicit `rothDistributionFacts` wins; otherwise the per-owner map lifts into the fact shape the §408A carrier seeds
  // from. Designated-Roth facts are per account and must be passed explicitly.
  const rothDistributionFacts: RothDistributionFacts =
    overrides.rothDistributionFacts ?? {
      // Keyed by §408A pool; a per-owner roll-up lifts into the owner's own pool (key = bare owner id).
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
