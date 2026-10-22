/** Per-year tax estimation for the Monte Carlo engine: routes each path-year's withdrawals by per-account tax treatment and returns the tax cashflow the caller subtracts from path balances.
 * The tax rules are explained in docs/math-taxes.md. */

import {
  applyTaxYearForFilingPlan,
  bootstrapLookbackRing,
  centsToDollars,
  computeRmdFloorCents,
  DEFAULT_ASSUMED_COST_BASIS_FRACTION,
  dollarsToCents,
} from './tax-integration';
import type {
  ApplyFilingPlanYearInput,
  BootstrapLookbackUnit,
  FilingUnitMagi,
  TaxAccountSnapshot,
  TaxCalibrationBundle,
  TaxMemberInput,
  TaxYearResult,
} from './tax-integration';
import {
  carriesTenPercentPenalty,
  computeEarlyWithdrawalPenalty,
  type PenaltyAccountInput,
} from './early-withdrawal-penalty';
import type { AccountType, AccountTaxTreatment } from '../db/types';
import {
  creditAppliedToPremiumsCents,
  drawIncomeCents,
  povertyLineLimitCents,
} from './credit-applied-to-premiums';
import type { AcaFplRegion } from './aca-ptc';
import { isQualifyingAccount } from './rmd';
import type { DrawdownAccountYear } from './drawdown-engine-types';
import type { FilingStatus } from './federal-tax';
import {
  deriveFilingStatus,
  resolveFilingPlanForYear,
  type FilingStatusOverride,
  type ResolvedTaxUnit,
  type TaxFilingPlan,
} from './filing-status';
import {
  advanceBrokerageLikeBasis,
  computeCashLikeInterestDollars,
  hasAttainedAgeByYearEnd,
  isBrokerageLikeAccount,
  isCashLikeAccountType,
  isTaxableCashInterestAccount,
  type BrokerageLikeBasisState,
  type TaxableAccountYearRow,
} from './balance-projection-runner-tax-helpers';
import {
  readStoredCoverageMonths,
  resolveMemberHealthCoverage,
} from './tax-integration-helpers';
import {
  seedFactBasedRothBasisCarrier,
  applyFactBasedRothIraOrdering,
  applyFactBasedDesignatedRothDistribution,
  seedDesignatedRothCarrier,
  type MutableDesignatedRothAccountEntry,
  type RothBasisCarrier,
} from './balance-projection-runner-roth-basis';
import { isPureRothEmployerType, isRothDesignatedPostBucket } from './balance-calc';
import type { RmdAccountProfileFacts } from './rmd';
import { penaltyFractionForYear } from './early-withdrawal-penalty';

/** Single carrier key for the MC per-path Roth basis: the kernel has one synthetic withdrawal pool, so the carrier holds the summed household §408A basis of the drawable-only per-owner totals (`mcDrawableRothBasisCentsByOwner`); an all-closed pool's derived basis is excluded because no deterministic pass can consume it. */
export const MC_AGGREGATE_ROTH_OWNER_KEY = 'mc-aggregate-roth-owner';

/** Canonicalizes a per-owner Roth-basis map into the plain array `McTaxContext` carries: ascending by `ownerId` (so equal maps hash to one `mcCacheKey`), non-positive entries omitted. */
export function canonicalMcRothBasisByOwner(
  basisCentsByOwner: ReadonlyMap<string, number>,
): readonly { readonly ownerId: string; readonly cents: number }[] {
  return [...basisCentsByOwner.entries()]
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([ownerId, cents]) => ({ ownerId, cents }));
}

/** Plain Roth state for the MC synthetic pool: only primitives and arrays, because `JSON.stringify(new Map())` is `{}` and a Map or Set would hide the profile from `mcCacheKey` (every cache-key input in this file is plain for the same reason). */
export interface McRothOrderedProfile {
  /** Share (0..1) of the §408A-ordered Roth draw from Roth IRAs, over non-inherited balances only (an inherited Roth IRA's dollars never enter the ordered pool); 1 means all-IRA. */
  readonly iraShareOfOrderedPool: number;
  /** Pooled §408A five-year clock: the latest of the owners' first-contribution years (the period is per individual and the Roth bucket has no owner attribution, so an earliest-year clock would let an older spouse's seasoned IRA qualify a younger spouse's); absent when any contributing owner records none, which means not satisfied. */
  readonly iraFirstContributionTaxYear?: number;
  /** Roth-IRA conversion lots aggregated by tax year (§408A(d)(4)(B)) and ascending, each with its own five-tax-year recapture clock. */
  readonly iraConversionLots: readonly {
    readonly taxYear: number;
    readonly taxableCents: number;
    readonly nontaxableCents: number;
  }[];
  readonly designatedBasisCents: number;
  /** Designated pool balance at context-build time, seeding the pro-rata denominator when the caller cannot supply the year's real pocket balance (no-ledger fallback); $0 balance with $0 basis seeds no pool. */
  readonly designatedBalanceCents: number;
  /** Latest first-participation tax year across designated accounts, absent when any records none: designated accounts never pool, so the clock least likely to be satisfied is the conservative one. */
  readonly designatedFirstParticipationTaxYear?: number;
  /** True only when every designated source is a governmental 457(b), so the §72(t)(9) earnings carve-out cannot waive a penalty a non-457(b) sibling owes. */
  readonly designatedAllGovernmental457b: boolean;
  /** Designated-Roth in-plan rollover lots by tax year, each with its own five-year §402A(c)(4)(D) recapture clock: taxable rollover principal withdrawn inside it before 59½ enters the additional-tax base. */
  readonly designatedInPlanRolloverLots?: readonly {
    readonly taxYear: number;
    readonly taxableCents: number;
    readonly nontaxableCents: number;
  }[];
  /** Sorted member ids of every owner feeding the pooled Roth bucket; absent means the primary-only 59½ test. */
  readonly rothOwnerIds?: readonly string[];
}

/** Seeds a fresh per-path Roth basis carrier under `MC_AGGREGATE_ROTH_OWNER_KEY`, summing every owner's derived §408A basis; each path owns an independent copy. */
export function seedMcAggregateRothBasisCarrier(
  basisCentsByOwner:
    | readonly { readonly ownerId: string; readonly cents: number }[]
    | ReadonlyMap<string, number>
    | undefined,
  /** With a profile the entry also carries the household's conversion lots, so the pool runs the real §408A order and not one contribution-first bucket. */
  profile?: McRothOrderedProfile,
): RothBasisCarrier {
  let totalBasisCents = 0;
  if (basisCentsByOwner instanceof Map) {
    for (const cents of (basisCentsByOwner as ReadonlyMap<string, number>).values()) {
      totalBasisCents += cents;
    }
  } else {
    const entries =
      (basisCentsByOwner as readonly { ownerId: string; cents: number }[] | undefined) ?? [];
    for (const entry of entries) totalBasisCents += entry.cents;
  }

  return seedFactBasedRothBasisCarrier(
    new Map([
      [
        MC_AGGREGATE_ROTH_OWNER_KEY,
        {
          rothIra: {
            regularContributionBasisCents: totalBasisCents,
            firstContributionTaxYear: profile?.iraFirstContributionTaxYear,
            conversionLots: (profile?.iraConversionLots ?? []).map((lot) => ({
              taxYear: lot.taxYear,
              taxableConvertedPrincipalCents: lot.taxableCents,
              nontaxableConvertedPrincipalCents: lot.nontaxableCents,
            })),
          },
        },
      ],
    ]),
  );
}

// McTaxContext lives here to avoid a circular import with monte-carlo.ts.

/** Household tax inputs for per-path tax estimation; per-account withdrawal routing is supplied each year from the kernel buckets and ledger tax metadata. */
export interface McTaxContext {
  readonly taxBundle: TaxCalibrationBundle;
  /** Initial IRS filing status; recomputed each year from the death years and the override, so callers should pass those too. */
  readonly filingStatus: FilingStatus;
  /** Per-member info for Medicare / ACA gates; length 1 (single / HoH) or 2 (MFJ). */
  readonly members: readonly TaxMemberInput[];
  readonly householdSize: number;
  /** Fraction of POST_TAX non-Roth withdrawal assumed LTCG/QDI; `applyTaxYear` defaults to 0.5. */
  readonly assumedCostBasisFraction?: number;
  /** Annual inflation in percent (2.5 = 2.5%), scaling dollar thresholds past the latest calibration snapshot. */
  readonly inflationRatePct?: number;
  /** Scenario medical inflation (percent) growing the rough ACA benchmark; fixed, not the path's sampled inflation. Absent means no growth. */
  readonly medicalInflationRatePct?: number;
  /** Projected death year; `undefined` is alive every year. Drives the per-year filing-status, household-size and Medicare-count recompute. */
  readonly primaryDeathYear?: number;
  /** Same as `primaryDeathYear`; `undefined` when there is no secondary member or birthdate. */
  readonly secondaryDeathYear?: number;
  /** Scenario filing-status override; `undefined` derives from per-year alive state. */
  readonly filingStatusOverride?: FilingStatusOverride;
  /** Serializable scenario filing plan; when present it supersedes `filingStatusOverride` in `deriveMcSurvivors` and `buildMcTaxUnitFederalInputs`. */
  readonly taxFilingPlan?: TaxFilingPlan;
  /** Per-owner Roth-IRA regular-contribution basis in integer cents, sorted: each path sums it into one aggregate carrier entry. Values are what each owner's §408A pools have left after their recorded history, as the deterministic engine seeds; absent or empty means every Roth dollar is earnings. */
  readonly rothBasisCentsByOwner?: readonly { readonly ownerId: string; readonly cents: number }[];
  /** Fact-based §408A/§402A state for the pooled Roth bucket. The Roth-IRA slice runs the real §408A order (remaining regular basis, conversion lots FIFO with their own recapture clocks, earnings); the designated-Roth slice is pro rata basis/earnings. The slices split by `iraShareOfOrderedPool`; absent keeps the all-earnings behaviour. */
  readonly rothOrderedProfile?: McRothOrderedProfile;
  /** Scenario-marked early-withdrawal-penalty exempt account ids: a Roth IRA / pre-tax / HSA account in the set has its penalty leg waived per path (income tax on earnings still applies). Pre-resolved into the two booleans below in `buildMcTaxContext`, since the kernel pools accounts. */
  readonly earlyWithdrawalPenaltyExemptAccountIds?: readonly string[];
  /** True when every pre-tax-contributing account driving the synthetic pre-tax bucket is penalty-exempt (scenario-marked or statutory), waiving the whole §72(t) leg. The per-source split in `preTaxPenaltyExemptDollars` is the primary channel; this is the whole-leg fallback. */
  readonly mcPreTaxPenaltyAllExempt?: boolean;
  /** True when every account driving the synthetic Roth bucket is penalty-exempt, waiving the 10% Roth-earnings leg only; `rothOrderedPenaltyExemptDollars` is the per-source channel. */
  readonly mcRothPenaltyAllExempt?: boolean;
  /** MAGI(ret-2) in whole dollars, seeding the IRMAA look-back ring's `minus2` slot for projection year 0; `undefined` charges $0 IRMAA that year (the deterministic engine's projected-MAGI estimate is not threaded in). */
  readonly magiBootstrapLookbackMinus2?: number;
  /** MAGI(ret-1) in whole dollars, seeding `minus1` for projection year 1; `undefined` charges $0 IRMAA that year. */
  readonly magiBootstrapLookbackMinus1?: number;
  /** Member ids treated as not on the ACA Marketplace (retiree / COBRA / spousal-employer coverage); `buildYearMemberFlags` forces `hasAcaCoverage` false for them. Raw ids, since member identity must survive into `buildYearMemberFlags`. Sorted, deduped, omitted when empty. */
  readonly acaMarketplaceOptOutMemberIds?: readonly string[];
  /** Per-member, per-tax-year Medicare Part B / D and ACA Marketplace coverage months, the MC twin of `PipelineContext.healthCoverageMonths`; omitted when the scenario stores none. */
  readonly healthCoverageMonths?: {
    readonly perMember: Readonly<
      Record<
        string,
        Readonly<
          Record<
            number,
            {
              readonly partBMonths?: number;
              readonly partDMonths?: number;
              readonly marketplaceMonths?: number;
            }
          >
        >
      >
    >;
  };
  /** FPL region for the ACA denominator; omitted means `'contiguous'`. */
  readonly acaFplRegion?: AcaFplRegion;
  /** Scenario per-year annual SLCSP benchmark overrides (`ScenarioOverrides.acaPtcBenchmark`), sorted by tax year, omitted when empty. */
  readonly acaPtcBenchmark?: ReadonlyArray<{
    readonly taxYear: number;
    readonly annualSlcspDollars: number;
  }>;
  /** Each spouse's own share of household gross Social Security per calendar year. SS is attributed to the member who receives it (§86, IRS Pub 555), so a `separate` couple's returns each carry only their own benefit as in the deterministic runner (`ownSsByMemberForYear`); §86 is non-linear, so a blanket split would diverge. Sparse: only two-member households with Social Security, ordered by year. */
  readonly ssSharesByYear?: ReadonlyArray<{
    readonly year: number;
    /** Primary's fraction of that year's household SS, in `[0, 1]`. */
    readonly primaryShare: number;
  }>;
  /** Each member's own separation-from-service year, for households that retire in different years: one household scalar would put a still-working secondary on ACA Marketplace coverage years early, diverging from the deterministic `resolveRetirementYearByMember`. A sorted array, not an id-keyed object, because an imported member id may be `"__proto__"` (CWE-1321). Sparse: only when the household staggers; absent falls back to the primary's year. */
  readonly retirementYearByMember?: readonly {
    readonly memberId: string;
    readonly retirementYear: number;
  }[];
}

/** Counts household members aged 65+ in a tax year, for the standard-deduction add-on. */
export function countTaxpayersAge65Plus(
  members: readonly TaxMemberInput[],
  taxYear: number,
): number {
  let count = 0;
  for (const m of members) {
    // Born-Jan-1 rule via `hasAttainedAgeByYearEnd`, as in the deterministic twin.
    if (hasAttainedAgeByYearEnd(m.isoBirthdate, taxYear, 65)) count += 1;
  }
  return count;
}

export interface McTaxYearResult {
  readonly fedTax: number;
  readonly irmaa: number;
  readonly ptc: number;
  readonly effectiveTaxRate: number;
  readonly netAfterTax: number;
  readonly magiDollars: number;
  readonly filingUnitMagi: readonly FilingUnitMagi[];
  /** Same-year tax cashflow the portfolio funds: federal tax + IRMAA + penalty − ACA PTC offset, floored at zero, less the credit applied to premiums; negative when that credit lowers the draw. The full IRMAA surcharge is funded (cash plus the portion withheld from Social Security) because the spendable income series spends gross SS, as in the deterministic `addedNeedDollars`. */
  readonly taxCashflowDollars: number;
  /** Credit applied to premiums in dollars (≥ 0), already inside `taxCashflowDollars`. */
  readonly acaCreditAppliedToPremiums: number;
}

/** Per-bucket withdrawal classification for one path-year (dollars), mirroring `splitWithdrawalsByTaxTreatment`. Roth earnings above §408A basis are threaded via `applyMcRothBasisOrdering`; `rothBasisOrderedDollars` (ROTH_IRA + pure employer Roth types) goes through per-path basis ordering, `rothWholesaleTaxFreeDollars` is reserved and currently unrouted. */
export interface McWithdrawalClassification {
  readonly preTaxDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  readonly rothBasisOrderedDollars: number;
  readonly rothWholesaleTaxFreeDollars: number;
  /** Portion of `preTaxDollars` from penalty-exempt sources (scenario-marked, or types outside §72(t) such as the governmental 457(b)); the 10% leg is charged only on the rest, so a mixed 457(b)+IRA pool penalizes only the IRA portion. Absent means 0. */
  readonly preTaxPenaltyExemptDollars?: number;
  /** Portion of `rothBasisOrderedDollars` from penalty-exempt sources (scenario-marked or governmental 457(b) variants); the pooled carrier cannot attribute the earnings excess per account, so the penalty pass prorates it by the non-exempt share. Absent means 0. */
  readonly rothOrderedPenaltyExemptDollars?: number;
}

/** Per-account inputs to `classifyMcWithdrawal` for one path-year; arrays are parallel, in fixed ledger order. */
export interface McAccountYearWithdrawal {
  readonly taxTreatment: AccountTaxTreatment | undefined;
  readonly accountType: AccountType | undefined;
  readonly withdrawalDollars: number;
  readonly preBalanceStartDollars: number;
  readonly postBalanceStartDollars: number;
  readonly scenarioPenaltyExempt?: boolean;
  readonly deathExemptInherited?: boolean;
}

/**
 * Classifies one path-year's per-account withdrawals into the tax buckets in fixed ledger order, so same-seed runs stay bit-identical.
 * An account with no tax metadata routes whole to pre-tax (conservative). MIXED accounts split by the start-of-year pre/post balance ratio, the proxy for the proportional kernel's unsurfaced split; a zero total falls back to pre-tax.
 * ROTH accounts go to `rothBasisOrderedDollars` (`RETIREMENT_ROTH_IRA` and the pure employer types, plus the post share of Roth-designated MIXED types) or `rothWholesaleTaxFreeDollars`; an inherited `RETIREMENT_ROTH_IRA` is wholesale tax-free, since it carries no basis state and must never reach the ordered carrier.
 * Penalty-exempt provenance accumulates per source for `computeMcPenaltyDollars`: scenario-marked, or `!carriesTenPercentPenalty(type)` for the pre-tax leg and the governmental 457(b) variants for the Roth leg; an inherited source is exempt on both legs.
 */
export function classifyMcWithdrawal(
  accounts: readonly McAccountYearWithdrawal[],
): McWithdrawalClassification {
  let preTaxDollars = 0;
  let postTaxNonRothDollars = 0;
  let postTaxCashLikeDollars = 0;
  let rothBasisOrderedDollars = 0;
  let rothWholesaleTaxFreeDollars = 0;
  let preTaxPenaltyExemptDollars = 0;
  let rothOrderedPenaltyExemptDollars = 0;
  for (const acc of accounts) {
    const w = acc.withdrawalDollars;
    if (w <= 0) continue;
    if (acc.taxTreatment === undefined || acc.accountType === undefined) {
      preTaxDollars += w; // legacy all-pre-tax fallback (never penalty-exempt).
      continue;
    }
    const preTaxLegExempt =
      acc.scenarioPenaltyExempt === true ||
      // §72(t)(2)(A)(ii) — a post-death inherited distribution carries no 10%.
      acc.deathExemptInherited === true ||
      !carriesTenPercentPenalty(acc.accountType);
    const rothLegExempt =
      acc.scenarioPenaltyExempt === true ||
      // The Roth leg is exempt too, as in `computeDesignatedRothDistribution`'s `inheritedFromDeceasedOwner` short-circuit.
      acc.deathExemptInherited === true ||
      acc.accountType === 'RETIREMENT_ROTH_457B' ||
      acc.accountType === 'RETIREMENT_457B';
    if (acc.taxTreatment === 'PRE_TAX') {
      preTaxDollars += w;
      if (preTaxLegExempt) preTaxPenaltyExemptDollars += w;
      continue;
    }
    if (acc.taxTreatment === 'HSA') {
      // Qualified HSA withdrawals carry no income tax or MAGI; the principal goes to the cash-like post-tax bucket, as the HSA account type does.
      postTaxCashLikeDollars += w;
      continue;
    }
    if (acc.taxTreatment === 'ROTH') {
      // An inherited Roth IRA holds no basis state, so its dollars leave the ordered pool before the carrier is touched (netting them off the earnings tranche afterwards would still exhaust the owner's own basis); an inherited designated-Roth plan keeps its ordering below.
      const inheritedRothIra =
        acc.accountType === 'RETIREMENT_ROTH_IRA' && acc.deathExemptInherited === true;
      if (
        !inheritedRothIra &&
        (acc.accountType === 'RETIREMENT_ROTH_IRA' ||
          isPureRothEmployerType(acc.accountType))
      ) {
        rothBasisOrderedDollars += w;
        if (rothLegExempt) rothOrderedPenaltyExemptDollars += w;
      } else {
        rothWholesaleTaxFreeDollars += w;
      }
      continue;
    }
    const cashLike = isCashLikeAccountType(acc.accountType);
    if (acc.taxTreatment === 'MIXED') {
      const total = acc.preBalanceStartDollars + acc.postBalanceStartDollars;
      const preShare = total > 0 ? w * (acc.preBalanceStartDollars / total) : w;
      const postShare = total > 0 ? w - preShare : 0;
      preTaxDollars += preShare;
      if (preTaxLegExempt) preTaxPenaltyExemptDollars += preShare;
      if (isRothDesignatedPostBucket(acc.taxTreatment, acc.accountType)) {
        rothBasisOrderedDollars += postShare;
        if (rothLegExempt) rothOrderedPenaltyExemptDollars += postShare;
      } else if (cashLike) {
        postTaxCashLikeDollars += postShare;
      } else {
        postTaxNonRothDollars += postShare;
      }
      continue;
    }
    if (cashLike) postTaxCashLikeDollars += w;
    else postTaxNonRothDollars += w;
  }
  return {
    preTaxDollars,
    postTaxNonRothDollars,
    postTaxCashLikeDollars,
    rothBasisOrderedDollars,
    rothWholesaleTaxFreeDollars,
    preTaxPenaltyExemptDollars,
    rothOrderedPenaltyExemptDollars,
  };
}

export interface PerYearTaxArgs {
  readonly taxCtx: McTaxContext;
  readonly taxYear: number;
  readonly retirementYear: number;
  readonly grossSsDollars: number;
  /** Windowed nominal expense at this year-end step, already CPI-scaled by the path's own inflation; a time-limited expense is charged only in its active years' fallback drawdown and `netAfterTax` display (MAGI flows via `classification`). */
  readonly nominalExpense: number;
  /** The year's modeled Medical expenses (every `isMedical` row), nominal before guardrail scaling or tax fold: caps the credit applied to premiums. Absent means no credit (Fill-conversion solves, display pass). */
  readonly medicalExpenseDollars?: number;
  /** The year's draw need before tax, nominal dollars; absent means the year's net expense stands in. */
  readonly drawNeedDollars?: number;
  /** Non-SS non-portfolio ordinary income; offsets the year's spendable expense and adds to taxable ordinary income. */
  readonly otherIncome: number;
  /** Ordinary income that adds to taxable income / MAGI but does not offset spendable expense: a committed Fill-mode Roth conversion, mirroring the deterministic `magiBuffer` replacement. Default 0. */
  readonly additionalOrdinaryIncomeDollars?: number;
  readonly priorBalance: number;
  /** Per-owner prior-year-end pre-tax (RMD-eligible) total in integer cents, keyed by member id; feeds `computeMcRmdFloorCents`. Required so a forgetful call site is a compile error, not a silent phantom RMD; an empty map yields a $0 floor. */
  readonly priorPreTaxByOwner: ReadonlyMap<string, number>;
  /** Per-owner IRA-pool RMD offset in integer cents (`min(Q_owner, gross IRA RMD_owner)`), from the strategy run's stamped `DrawdownYear.qcdRmdOffsetCentsByOwner`; subtracted from each owner's floor so a QCD-satisfied RMD is not re-grossed as phantom taxable income. Absent means no QCD. */
  readonly qcdRmdOffsetCentsByOwner?: ReadonlyMap<string, number>;
  /** QCD income-exclusion seam, forwarded to `applyTaxYear`. Production callers leave it unset: the gift is already excluded once, structurally (the strategy replay debits it without recording a taxable pre-tax withdrawal) and by the offset-reduced RMD floor, so setting it would double-exclude. Default 0; exists for unit tests of the clamp. */
  readonly qcdIncomeExclusionDollars?: number;
  /** MAGI two years prior for the IRMAA look-back; undefined skips IRMAA. */
  readonly magiMinus2: number | undefined;
  /** Returns filed two years ago, one per tax unit, so each of this year's returns reads its own look-back; absent uses the scalar `magiMinus2` (bootstrap years, single-return runs). */
  readonly irmaaLookbackUnitsMinus2?: readonly FilingUnitMagi[];
  /** Per-account withdrawal classification for the year; omitted treats the whole drawdown as pre-tax (conservative). */
  readonly classification?: McWithdrawalClassification;
  /** This path's cumulative §408A Roth-IRA basis carrier, seeded at year 0 under `MC_AGGREGATE_ROTH_OWNER_KEY` from `taxCtx.rothBasisCentsByOwner` and mutated each year; omitted assesses no Roth ordering. */
  readonly rothBasisCarrier?: RothBasisCarrier;
  /** This path's pooled designated-Roth state, seeded once by `seedMcDesignatedRothPool` and mutated across years; absent means no designated-Roth facts. */
  readonly designatedRothPool?: McDesignatedRothPool;
  /** Designated-Roth pocket balance at the start of the year, the pro-rata denominator; supplied by callers that join the ledger to per-account balances, else the pool's own running balance (the no-ledger kernel fallback). */
  readonly designatedRothPoolBalanceDollars?: number;
  /** Precomputed survivor state: `undefined` derives via `deriveMcSurvivors`, `null` means nobody alive, an object is used as-is (shared read-only across paths). */
  readonly survivorState?: McSurvivorState | null;
  /** Brokerage-like (POST_TAX `BROKERAGE`/`OTHER`) start-of-year balance, the assumed-yield drag base from `advanceMcTaxableIncomeState`. Threaded only by the representative display post-pass; the funded per-path tax omits it, mirroring the deterministic funding solver's pre-commit approximation so funded balances stay in parity. Absent means 0. */
  readonly brokerageLikeStartBalanceDollars?: number;
  /** Withdrawal-weighted pre-withdrawal cost-basis fraction from `advanceBrokerageLikeBasis`; when present it replaces the static `taxCtx.assumedCostBasisFraction`. */
  readonly costBasisFraction?: number;
  /** Annual ordinary interest on cash-like POST_TAX balances (HSA excluded), from `computeCashLikeInterestDollars`; threaded only by the display post-pass. Absent means 0. */
  readonly cashInterestDollars?: number;
}

export interface McTaxableIncomeYearAccount extends TaxableAccountYearRow {
  readonly taxTreatment: AccountTaxTreatment | undefined;
  readonly accountType: AccountType | undefined;
}

export interface McTaxableIncomeYearInputs {
  readonly brokerageLikeStartBalanceDollars: number;
  readonly costBasisFraction: number;
  readonly cashInterestDollars: number;
}

/** Fresh brokerage basis state for one representative display post-pass; the accumulator lives exactly one pass. */
export function newMcBrokerageBasisState(taxCtx: McTaxContext): BrokerageLikeBasisState {
  return {
    basisByAccountId: new Map<string, number>(),
    seedBasisFraction: taxCtx.assumedCostBasisFraction ?? 0.5,
  };
}

/** Advances one display year's taxable-income state with the predicates and accumulators shared with the deterministic engine (`advanceBrokerageLikeBasis`, `computeCashLikeInterestDollars`), so the sale/basis approximation cannot fork; mutates `basisState`. Accounts without tax metadata are skipped. Called only from the display post-pass. */
export function advanceMcTaxableIncomeState(
  accounts: readonly McTaxableIncomeYearAccount[],
  basisState: BrokerageLikeBasisState,
  totalYieldPct: number,
): McTaxableIncomeYearInputs {
  const brokerageRows: TaxableAccountYearRow[] = [];
  const cashRows: TaxableAccountYearRow[] = [];
  for (const acc of accounts) {
    if (acc.taxTreatment === undefined || acc.accountType === undefined) continue;
    if (isBrokerageLikeAccount(acc.accountType, acc.taxTreatment)) {
      brokerageRows.push(acc);
    } else if (isTaxableCashInterestAccount(acc.accountType, acc.taxTreatment)) {
      cashRows.push(acc);
    }
  }
  const { startBalanceDollars, preWithdrawalBasisFraction } = advanceBrokerageLikeBasis(
    brokerageRows,
    basisState,
    totalYieldPct,
  );
  return {
    brokerageLikeStartBalanceDollars: startBalanceDollars,
    costBasisFraction: preWithdrawalBasisFraction,
    cashInterestDollars: computeCashLikeInterestDollars(cashRows),
  };
}

/** Applies the five tax engines for one year on a path; null before retirement or when no member is alive. Recomputes filing status, household size and the 65+ count over survivors only; without `classification` the whole drawdown is pre-tax. `taxCashflowDollars` is the same-year tax the portfolio must fund. */
export function applyPerYearTaxForPath(args: PerYearTaxArgs): McTaxYearResult | null {
  return applyPerYearTaxForPathWithConversion(args)?.result ?? null;
}

/**
 * Splits the per-year tax compute so a Fill-mode conversion's same-year tax is not funded twice: the engine funds it via `fundConversionTaxForYear`, so the funded `result` excludes the current year's conversion (its IRMAA look-back via `args.magiMinus2` is intact),
 * while `magiInclusiveDollars` stays conversion-inclusive so the ring funds the conversion's Y+2 IRMAA, as the deterministic `magiBuffer` replacement does. With a zero `additionalOrdinaryIncomeDollars` the two MAGIs are equal.
 */
export function applyPerYearTaxForPathWithConversion(
  args: PerYearTaxArgs,
): { result: McTaxYearResult; magiInclusiveDollars: number } | null {
  const { taxCtx, taxYear, retirementYear, grossSsDollars } = args;
  const { otherIncome, classification } = args;

  if (taxYear < retirementYear) return null;

  const survivorState =
    args.survivorState !== undefined
      ? args.survivorState
      : deriveMcSurvivors(taxCtx, taxYear, retirementYear);
  if (survivorState === null) return null;

  const nominalExpense = args.nominalExpense;
  const drawdown = Math.max(0, nominalExpense - grossSsDollars - otherIncome);
  const preTaxWithdrawalDollars = classification?.preTaxDollars ?? drawdown;

  // Pre-59½ Roth earnings excess is ordinary income (as in the deterministic engine); mutates the carrier exactly once, since the conversion-inclusive MAGI reuses the same excess.
  const rothEarnings = applyMcRothBasisOrdering(args);

  const conversionDollars = args.additionalOrdinaryIncomeDollars ?? 0;
  const fundingArgs: PerYearTaxArgs =
    conversionDollars === 0 ? args : { ...args, additionalOrdinaryIncomeDollars: 0 };
  const fundingInput = buildMcTaxYearInput(
    fundingArgs,
    survivorState,
    preTaxWithdrawalDollars,
    rothEarnings.earningsExcessDollars,
  );
  const taxResult = applyTaxYearForFilingPlan(fundingInput, taxCtx.taxBundle);

  // The early-withdrawal / HSA / Roth-earnings penalty is assessed per path against the same-year buckets and added to `taxCashflowDollars`, as in the deterministic engine.
  const penaltyDollars = computeMcPenaltyDollars(
    args,
    survivorState,
    rothEarnings.additionalTaxBaseDollars,
  );

  const result = assembleMcTaxResult(
    taxResult,
    drawdown,
    penaltyDollars,
    args.medicalExpenseDollars,
    args.drawNeedDollars,
    drawIncomeCents({
      preTaxDollars: preTaxWithdrawalDollars,
      taxableAccountDollars: classification?.postTaxNonRothDollars ?? 0,
      rothEarningsDollars: rothEarnings.earningsExcessDollars,
      costBasisFraction:
        args.costBasisFraction ??
        taxCtx.assumedCostBasisFraction ??
        DEFAULT_ASSUMED_COST_BASIS_FRACTION,
    }),
  );

  const magiInclusiveDollars =
    conversionDollars === 0
      ? result.magiDollars
      : centsToDollars(
          applyTaxYearForFilingPlan(
            buildMcTaxYearInput(args, survivorState, preTaxWithdrawalDollars, rothEarnings.earningsExcessDollars),
            taxCtx.taxBundle,
          ).magiCents,
        );

  return { result, magiInclusiveDollars };
}

/**
 * Applies per-path fact-based §408A / §402A Roth ordering, mirroring the deterministic engine; the MC kernel has one synthetic Roth pool, so this matches the shape of both regimes. The Roth-IRA slice (`iraShareOfOrderedPool`) runs `applyFactBasedRothIraOrdering` (regular basis, then conversion lots FIFO with their own recapture clocks, then earnings).
 * The designated-Roth slice runs the stateful `applyFactBasedDesignatedRothDistribution` against one pooled account (`McDesignatedRothPool`): pro rata per §402A(d)(4) against remaining basis, so lifetime basis shelter is capped at the recorded basis (a frozen-fraction split could shelter multiples of it).
 * With no profile the whole ordered draw takes the Roth-IRA path; only `rothBasisOrderedDollars` flows through ordering. Mutates the carrier and pool.
 */
export function applyMcRothBasisOrdering(
  args: PerYearTaxArgs,
): { earningsExcessDollars: number; additionalTaxBaseDollars: number } {
  const { rothBasisCarrier, classification, taxCtx } = args;
  const rothDollars = classification?.rothBasisOrderedDollars ?? 0;
  if (!rothBasisCarrier || rothDollars <= 0) {
    return { earningsExcessDollars: 0, additionalTaxBaseDollars: 0 };
  }
  const withdrawnCents = Math.round(rothDollars * 100);
  const profile = taxCtx.rothOrderedProfile;
  const ownerReached59Half = mcRothOwnersReached59Half(taxCtx, args.taxYear);

  const iraShare = profile ? Math.min(1, Math.max(0, profile.iraShareOfOrderedPool)) : 1;
  const iraCents = Math.round(withdrawnCents * iraShare);
  const designatedCents = withdrawnCents - iraCents;

  let incomeTaxableCents = 0;
  let additionalTaxBaseCents = 0;

  if (iraCents > 0) {
    const entry = rothBasisCarrier.get(MC_AGGREGATE_ROTH_OWNER_KEY) ?? {
      rothBasisRemainingCents: 0,
      rothCumulativeWithdrawnCents: 0,
    };
    rothBasisCarrier.set(MC_AGGREGATE_ROTH_OWNER_KEY, entry);
    const result = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: iraCents,
      distributionTaxYear: args.taxYear,
      ownerReached59Half,
      firstContributionTaxYear: profile?.iraFirstContributionTaxYear,
    });
    incomeTaxableCents += result.incomeTaxableCents;
    additionalTaxBaseCents += result.additionalTaxBaseCents;
  }

  const pool = args.designatedRothPool;
  if (designatedCents > 0 && pool !== undefined) {
    // Pro-rata denominator: the year's actual designated-Roth pocket when supplied, else the pool's running balance; never below the draw, so the basis fraction cannot exceed 1.
    const suppliedBalanceCents =
      args.designatedRothPoolBalanceDollars !== undefined
        ? Math.round(args.designatedRothPoolBalanceDollars * 100)
        : pool.balanceRemainingCents;
    const result = applyFactBasedDesignatedRothDistribution(pool.entry, {
      accountBalanceCents: Math.max(suppliedBalanceCents, designatedCents),
      withdrawalCents: designatedCents,
      distributionTaxYear: args.taxYear,
      ownerReached59Half,
    });
    pool.balanceRemainingCents = Math.max(
      0,
      Math.max(suppliedBalanceCents, designatedCents) - designatedCents,
    );
    incomeTaxableCents += result.incomeTaxableCents;
    additionalTaxBaseCents += result.additionalTaxBaseCents;
  }

  return {
    earningsExcessDollars: incomeTaxableCents / 100,
    additionalTaxBaseDollars: additionalTaxBaseCents / 100,
  };
}

// §72(t)/§408A(d)(2) 59½ is per individual and the pooled bucket has no per-owner attribution, so every owner in `profile.rothOwnerIds` must have reached 59½ for the whole year; without the list the primary-member test applies, as in `computeMcPenaltyDollars`.
function mcRothOwnersReached59Half(taxCtx: McTaxContext, taxYear: number): boolean {
  const reached = (birthdate: string | undefined): boolean =>
    penaltyFractionForYear(birthdate, taxYear, { ageYears: 59, ageMonths: 6 }) === 0;
  const ownerIds = taxCtx.rothOrderedProfile?.rothOwnerIds;
  if (ownerIds === undefined || ownerIds.length === 0) {
    return reached(taxCtx.members[0]?.isoBirthdate);
  }
  return ownerIds.every((ownerId) => {
    const member = taxCtx.members.find((m) => m.memberId === ownerId);
    // An owner with no member metadata is conservatively not reached (the distribution stays nonqualified).
    return member !== undefined && reached(member.isoBirthdate);
  });
}

/** Per-path pooled designated-Roth state: the shared mutable carrier entry the deterministic engine uses, plus the running balance serving as the pro-rata denominator when the caller cannot supply the real pocket balance. Mutated in place so basis and lot principal are consumed once over the projection. */
export interface McDesignatedRothPool {
  readonly entry: MutableDesignatedRothAccountEntry;
  balanceRemainingCents: number;
}

/** Designated-Roth pocket balance in dollars from per-account start balances, mirroring `buildMcRothOrderedProfile`: a pure Roth employer account contributes its whole balance, a MIXED Roth-designated account only its post sub-bucket. The real balance makes the pro-rata fraction shrink as the pocket grows. */
export function mcDesignatedRothPoolBalanceDollars(
  ledger: ReadonlyArray<{
    readonly id: string;
    readonly accountType?: AccountType;
    readonly taxTreatment?: AccountTaxTreatment;
  }>,
  startBucketsByAccountId: ReadonlyMap<string, { readonly pre: number; readonly post: number }>,
): number {
  let dollars = 0;
  for (const entry of ledger) {
    const type = entry.accountType;
    const treatment = entry.taxTreatment;
    if (type === undefined) continue;
    const buckets = startBucketsByAccountId.get(entry.id);
    if (buckets === undefined) continue;
    if (isPureRothEmployerType(type)) {
      dollars += Math.max(0, buckets.pre) + Math.max(0, buckets.post);
    } else if (
      treatment === 'MIXED' &&
      isRothDesignatedPostBucket(treatment, type)
    ) {
      dollars += Math.max(0, buckets.post);
    }
  }
  return dollars;
}

/** Seeds one path's pooled designated-Roth state from the profile; `undefined` when the household records no designated-Roth facts. */
export function seedMcDesignatedRothPool(
  profile: McRothOrderedProfile | undefined,
): McDesignatedRothPool | undefined {
  if (profile === undefined) return undefined;
  if (profile.designatedBasisCents <= 0 && profile.designatedBalanceCents <= 0) {
    return undefined;
  }
  const carrier = seedDesignatedRothCarrier(
    new Map([
      [
        MC_AGGREGATE_ROTH_OWNER_KEY,
        {
          accountId: MC_AGGREGATE_ROTH_OWNER_KEY,
          ownerId: MC_AGGREGATE_ROTH_OWNER_KEY,
          basisCents: Math.max(0, profile.designatedBasisCents),
          firstParticipationTaxYear: profile.designatedFirstParticipationTaxYear,
          inPlanRolloverLots: (profile.designatedInPlanRolloverLots ?? []).map((lot) => ({
            taxYear: lot.taxYear,
            taxableRolloverPrincipalCents: lot.taxableCents,
            nontaxableRolloverPrincipalCents: lot.nontaxableCents,
          })),
          isGovernmental457b: profile.designatedAllGovernmental457b,
        },
      ],
    ]),
  );
  return {
    entry: carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!,
    balanceRemainingCents: Math.max(0, profile.designatedBalanceCents),
  };
}

// Credits conversion principal as a dated lot on the aggregate carrier entry (mirrors `creditConversionLot`): same-year credits merge, the list stays ascending by tax year for FIFO,
// and at the cap the credit merges into the newest lot, which keeps the longest recapture window.
function creditMcConversionLot(
  entry: { rothBasisRemainingCents: number; conversionLots?: MutableMcConversionLot[] },
  taxYear: number,
  cents: number,
): void {
  const lots = entry.conversionLots ?? [];
  entry.conversionLots = lots;
  const sameYear = lots.find((lot) => lot.taxYear === taxYear);
  if (sameYear !== undefined) {
    sameYear.taxableRemainingCents += cents;
    return;
  }
  if (lots.length >= MC_MAX_CARRIER_CONVERSION_LOTS) {
    let newest = lots[0];
    for (const lot of lots) if (lot.taxYear > newest.taxYear) newest = lot;
    newest.taxableRemainingCents += cents;
    return;
  }
  lots.push({ taxYear, taxableRemainingCents: cents, nontaxableRemainingCents: 0 });
  lots.sort((a, b) => a.taxYear - b.taxYear);
}

const MC_MAX_CARRIER_CONVERSION_LOTS = 200;

interface MutableMcConversionLot {
  readonly taxYear: number;
  taxableRemainingCents: number;
  nontaxableRemainingCents: number;
}

/** Must run after `applyMcRothBasisOrdering` for the same year: conversions land at year-end, so they are basis only for later years' Roth withdrawals. */
export function creditMcConversionToBasisCarrier(
  carrier: RothBasisCarrier,
  convertedCents: number,
  /** Supplied: credited as a dated lot with its own five-taxable-year §408A(d)(3)(F) recapture window; omitted: an undated regular-basis credit (unit-test callers). */
  conversionTaxYear?: number,
): void {
  if (convertedCents <= 0) return;
  const entry = carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY) ?? {
    rothBasisRemainingCents: 0,
    rothCumulativeWithdrawnCents: 0,
  };
  if (conversionTaxYear !== undefined) {
    creditMcConversionLot(entry, conversionTaxYear, convertedCents);
  } else {
    entry.rothBasisRemainingCents += convertedCents;
  }
  carrier.set(MC_AGGREGATE_ROTH_OWNER_KEY, entry);
}

/**
 * Per-path early-withdrawal / HSA / Roth-earnings penalty in dollars, attributed to the primary survivor's birthdate (the kernel has no per-account owner detail). The Roth penalty basis is the additional-tax base from `applyMcRothBasisOrdering`.
 * Exemptions arrive on two channels, since a real exempt account id never matches the synthetic `mc-pretax` / `mc-roth` ids: per-source dollars from `classifyMcWithdrawal` (the §72(t) leg penalizes only `preTaxDollars - preTaxPenaltyExemptDollars`),
 * and the whole-leg flags `mcPreTaxPenaltyAllExempt` / `mcRothPenaltyAllExempt`, load-bearing for classifications built without per-source info.
 */
export function computeMcPenaltyDollars(
  args: PerYearTaxArgs,
  survivorState: McSurvivorState,
  /** The §408A/§402A additional-tax base (earnings plus in-window conversion / in-plan-rollover recapture, governmental-457(b) carve-out already applied), as `additionalTaxBaseDollars` from `applyMcRothBasisOrdering`; not raw earnings. */
  rothAdditionalTaxBaseDollars: number,
): number {
  const { taxCtx, taxYear, classification } = args;
  const primary = survivorState.survivors[0];
  if (primary === undefined) return 0;
  const exemptAccountIds: string[] = [];
  if (taxCtx.mcPreTaxPenaltyAllExempt) exemptAccountIds.push('mc-pretax');
  if (taxCtx.mcRothPenaltyAllExempt) exemptAccountIds.push('mc-roth');
  const accounts: PenaltyAccountInput[] = [];
  const preTax = classification?.preTaxDollars ?? 0;
  const preTaxExempt = Math.min(preTax, classification?.preTaxPenaltyExemptDollars ?? 0);
  const preTaxPenaltyBasis = preTax - preTaxExempt;
  if (preTaxPenaltyBasis > 0) {
    accounts.push({
      id: 'mc-pretax',
      type: 'RETIREMENT_IRA',
      penaltyBasisDollars: preTaxPenaltyBasis,
      ownerBirthdate: primary.isoBirthdate,
    });
  }
  // The additional-tax base arrives source-resolved, so it is not prorated again (that would discount genuine IRA conversion recapture because unrelated 457(b) dollars were also drawn).
  // The exemption is all-or-nothing: waived only when every source of the year's ordered draw is exempt, as for `designatedAllGovernmental457b`, and charged in full otherwise.
  const rothOrdered = classification?.rothBasisOrderedDollars ?? 0;
  const rothExempt = Math.min(
    rothOrdered,
    classification?.rothOrderedPenaltyExemptDollars ?? 0,
  );
  const everyRothSourceExempt = rothOrdered > 0 && rothExempt >= rothOrdered;
  const rothPenaltyBasis = everyRothSourceExempt ? 0 : rothAdditionalTaxBaseDollars;
  if (rothPenaltyBasis > 0) {
    accounts.push({
      id: 'mc-roth',
      type: 'RETIREMENT_ROTH_IRA',
      penaltyBasisDollars: rothPenaltyBasis,
      ownerBirthdate: primary.isoBirthdate,
      rothOrderedAdditionalTaxBase: true,
    });
  }
  // HSA additional tax (§223(f)(4)): the synthetic pool has no emergency-HSA-qualified% input (default 100% qualified, so $0), making the HSA leg an MC no-op.
  // That setting governs only the emergency-reserve draw (modeled medical withdrawals are always qualified), so a future implementation must keep the medical-first / emergency split.
  if (accounts.length === 0) return 0;
  const penalty = computeEarlyWithdrawalPenalty(accounts, taxYear, exemptAccountIds);
  return penalty.penaltyDollars;
}

/** Per-year survivor set and resolved filing facts; `null` when nobody is alive. */
export interface McSurvivorState {
  readonly survivors: TaxMemberInput[];
  /** Status the year's return is filed under: the single resolved unit's, the first unit's in a `separate` year, or the scalar derivation when the plan could not be resolved. */
  readonly filingStatus: FilingStatus;
  /** Resolved tax units, or `undefined` when the scalar derivation could not be converted (the year keeps the single-status path). */
  readonly taxUnits?: readonly ResolvedTaxUnit[];
  readonly memberIdByRole?: { readonly primary?: string; readonly secondary?: string };
  /** §86(c)(1)(C)(ii): MFS spouses lived together during the year. */
  readonly mfsLivedWithSpouse?: boolean;
  /** Filing status of the return IRMAA's two-year look-back reads. */
  readonly irmaaLookbackFilingStatus?: FilingStatus;
  readonly irmaaLookbackMfsLivedWithSpouse?: boolean;
  /** Returns filed two years ago when there was more than one (separate filers), paired with the household bootstrap MAGI in the bootstrap years so each spouse stays on their own IRMAA schedule. */
  readonly bootstrapLookbackUnits?: readonly BootstrapLookbackUnit[];
  /** Survivor ids that attain 65 by year end (born-Jan-1 rule). */
  readonly age65PlusMemberIds?: readonly string[];
}

function resolveMcFilingForYear(
  taxCtx: McTaxContext,
  taxYear: number,
): { units: readonly ResolvedTaxUnit[] | undefined; status: FilingStatus; mfsLivedWithSpouse: boolean } {
  const primaryAlive =
    taxCtx.primaryDeathYear === undefined || taxYear <= taxCtx.primaryDeathYear;
  const secondaryAlive =
    taxCtx.members.length > 1 &&
    (taxCtx.secondaryDeathYear === undefined || taxYear <= taxCtx.secondaryDeathYear);
  const legacyStatus = deriveFilingStatus({
    primaryAlive,
    secondaryAlive,
    filingStatusOverride: taxCtx.filingStatusOverride,
  });
  const resolution = resolveFilingPlanForYear({
    taxFilingPlan: taxCtx.taxFilingPlan,
    filingStatusOverride: taxCtx.filingStatusOverride,
    hasSecondaryMember: taxCtx.members.length > 1,
    primaryAlive,
    secondaryAlive,
    taxYear,
    primaryBirthYear: mcBirthYearOf(taxCtx.members[0]?.isoBirthdate),
    secondaryBirthYear: mcBirthYearOf(taxCtx.members[1]?.isoBirthdate),
  });
  const units =
    resolution.kind === 'resolved' && resolution.taxUnits.length > 0
      ? resolution.taxUnits
      : undefined;
  const plan = taxCtx.taxFilingPlan;
  return {
    units,
    status: units?.[0]?.filingStatus ?? legacyStatus,
    mfsLivedWithSpouse:
      plan?.kind === 'separate' && (units?.length ?? 0) > 1 && plan.livedTogether === true,
  };
}

function mcBootstrapLookbackUnits(
  taxCtx: McTaxContext,
  lookback: ReturnType<typeof resolveMcFilingForYear>,
): readonly BootstrapLookbackUnit[] | undefined {
  const units = lookback.units;
  if (units === undefined || units.length < 2) return undefined;
  const memberIdByRole = {
    primary: taxCtx.members[0]?.memberId,
    secondary: taxCtx.members[1]?.memberId,
  };
  return units.map((unit) => ({
    memberIds: unit.memberIds
      .map((role) => memberIdByRole[role])
      .filter((id): id is string => id !== undefined),
    filingStatus: unit.filingStatus,
    mfsLivedWithSpouse: unit.filingStatus === 'MFS' && lookback.mfsLivedWithSpouse,
  }));
}

// Falls back to the household scalar (the primary's retirement year) when the context has no per-member table; a staggered household gates each member's automatic Marketplace months on their own year, as `buildMemberInputs` does.
function mcMemberRetirementYear(
  taxCtx: McTaxContext,
  memberId: string,
  householdRetirementYear: number,
): number {
  const entry = taxCtx.retirementYearByMember?.find((e) => e.memberId === memberId);
  return entry !== undefined && Number.isFinite(entry.retirementYear)
    ? entry.retirementYear
    : householdRetirementYear;
}

/** Derives the year's survivors (with Medicare/ACA flags), filing facts and IRMAA look-back status from per-year alive state; `null` when nobody is alive. Precomputed once per year per run by `buildSurvivorStatesByYear`, so the per-path loop pays nothing for it. */
export function deriveMcSurvivors(
  taxCtx: McTaxContext,
  taxYear: number,
  /** The household (primary's) retirement year; the fallback for members without a `taxCtx.retirementYearByMember` entry. */
  retirementYear: number,
): McSurvivorState | null {
  const primaryAlive =
    taxCtx.primaryDeathYear === undefined || taxYear <= taxCtx.primaryDeathYear;
  const secondaryAlive =
    taxCtx.members.length > 1 &&
    (taxCtx.secondaryDeathYear === undefined || taxYear <= taxCtx.secondaryDeathYear);

  // The ACA opt-out set gates `hasAcaCoverage` per member, built from the raw id array so member identity is honored.
  const optedOut = new Set(taxCtx.acaMarketplaceOptOutMemberIds ?? []);
  const survivors: TaxMemberInput[] = [];
  const healthMonths = taxCtx.healthCoverageMonths;
  if (primaryAlive && taxCtx.members[0]) {
    survivors.push(
      buildYearMemberFlags(
        taxCtx.members[0],
        taxYear,
        mcMemberRetirementYear(taxCtx, taxCtx.members[0].memberId, retirementYear),
        optedOut,
        healthMonths,
      ),
    );
  }
  if (secondaryAlive && taxCtx.members[1]) {
    survivors.push(
      buildYearMemberFlags(
        taxCtx.members[1],
        taxYear,
        mcMemberRetirementYear(taxCtx, taxCtx.members[1].memberId, retirementYear),
        optedOut,
        healthMonths,
      ),
    );
  }
  if (survivors.length === 0) return null;

  const filing = resolveMcFilingForYear(taxCtx, taxYear);
  // IRMAA is tiered on the return filed two years ago, so resolve that year's plan too.
  const lookback = resolveMcFilingForYear(taxCtx, taxYear - 2);
  return {
    survivors,
    filingStatus: filing.status,
    taxUnits: filing.units,
    memberIdByRole: {
      primary: taxCtx.members[0]?.memberId,
      secondary: taxCtx.members[1]?.memberId,
    },
    mfsLivedWithSpouse: filing.mfsLivedWithSpouse,
    irmaaLookbackFilingStatus: lookback.status,
    irmaaLookbackMfsLivedWithSpouse: lookback.mfsLivedWithSpouse,
    bootstrapLookbackUnits: mcBootstrapLookbackUnits(taxCtx, lookback),
    age65PlusMemberIds: survivors
      .filter((m) => hasAttainedAgeByYearEnd(m.isoBirthdate, taxYear, 65))
      .map((m) => m.memberId),
  };
}

// Own gross SS per member id from the share table (see `ssSharesByYear`); `undefined` without one, where the caller's even split is inert for single-return years.
function mcGrossSsByMemberId(
  taxCtx: McTaxContext,
  taxYear: number,
  grossSsDollars: number,
): Readonly<Record<string, number>> | undefined {
  const shares = taxCtx.ssSharesByYear;
  if (shares === undefined || taxCtx.members.length < 2) return undefined;
  const primaryId = taxCtx.members[0]?.memberId;
  const secondaryId = taxCtx.members[1]?.memberId;
  if (primaryId === undefined || secondaryId === undefined) return undefined;
  const entry = shares.find((s) => s.year === taxYear);
  if (entry === undefined) return undefined;
  const primaryShare = Math.min(1, Math.max(0, entry.primaryShare));
  return {
    [primaryId]: grossSsDollars * primaryShare,
    [secondaryId]: grossSsDollars * (1 - primaryShare),
  };
}

function mcBirthYearOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const y = parseInt(iso.slice(0, 4), 10);
  return Number.isNaN(y) ? undefined : y;
}

/** Per-run survivor states for year offsets `[0, horizonYears)` from `firstYear`, `null` = nobody alive; seed-independent, so computed once and shared read-only across paths. */
export function buildSurvivorStatesByYear(
  taxCtx: McTaxContext,
  firstYear: number,
  horizonYears: number,
  retirementYear: number,
): (McSurvivorState | null)[] {
  const states: (McSurvivorState | null)[] = new Array(horizonYears);
  for (let i = 0; i < horizonYears; i += 1) {
    states[i] = deriveMcSurvivors(taxCtx, firstYear + i, retirementYear);
  }
  return states;
}

/**
 * Per-owner RMD floor in cents for a path-year, summed over owners (each owner's RMD applies to their own pre-tax accounts): `preTaxCents / uniformLifetimeDivisor(age)` once the owner reaches their SECURE 2.0 §107 trigger age; below-trigger or deceased owners contribute 0.
 * Reads only the per-owner pre-tax sub-bucket built from real per-account balances, so Roth-heavy or all-taxable households get no phantom RMD income. Each owner is fed as a synthetic PRE_TAX account through the shared `computeRmdFloorCents`, the same divisor / trigger-age seam as the deterministic engine.
 * @param priorPreTaxByOwner owner memberId to prior-year-end pre-tax cents.
 */
export function computeMcRmdFloorCents(
  priorPreTaxByOwner: ReadonlyMap<string, number>,
  survivors: readonly TaxMemberInput[],
  taxYear: number,
  rmdSnapshot: TaxCalibrationBundle['rmd'],
  rmdOffsetCentsByOwner?: ReadonlyMap<string, number>,
): number {
  // A QCD counts toward the owner's IRA-pool RMD, reducing the taxable floor by `min(Q, gross IRA RMD)`; computed per owner so each floor is reduced only by that owner's offset, clamped at 0.
  let totalCents = 0;
  for (const survivor of survivors) {
    const preTaxCents = priorPreTaxByOwner.get(survivor.memberId) ?? 0;
    // The owner's already-resolved fact-based required withdrawal (inherited schedules, Table II, deferrals, withheld results) is an amount, not a balance, so it is added to the floor and not divided again; the QCD offset still reduces the combined figure once.
    const factRequiredCents = Math.max(
      0,
      priorPreTaxByOwner.get(mcFactRmdRequiredKey(survivor.memberId)) ?? 0,
    );
    if (preTaxCents <= 0) {
      if (factRequiredCents > 0) {
        const offsetOnly = rmdOffsetCentsByOwner?.get(survivor.memberId) ?? 0;
        totalCents += Math.max(0, factRequiredCents - Math.max(0, offsetOnly));
      }
      continue;
    }
    const accounts: TaxAccountSnapshot[] = [
      {
        id: `mc-pretax-${survivor.memberId}`,
        type: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        balancePriorYearDollars: centsToDollars(preTaxCents),
        ownerId: survivor.memberId,
        withdrawalDollars: 0,
      },
    ];
    // A below-trigger owner yields 0, so their QCD offset has nothing to reduce (the 70½-72 pre-RMD case).
    const ownerFloor =
      computeRmdFloorCents([survivor], accounts, taxYear, rmdSnapshot) + factRequiredCents;
    const offset = rmdOffsetCentsByOwner?.get(survivor.memberId) ?? 0;
    totalCents += Math.max(0, ownerFloor - Math.max(0, offset));
  }
  return totalCents;
}

export interface McPreTaxLedgerEntry {
  readonly id: string;
  readonly taxTreatment?: AccountTaxTreatment;
  readonly accountType?: AccountType;
  readonly ownerId?: string;
}

/** Per-owner year-end pre-tax (RMD-eligible) totals in cents, indexed by `ownerIds` position, from each ledger account's `preEnd` when it qualifies for RMD (`isQualifyingAccount`). `postEnd` holds the MIXED Roth-designated portion, RMD-exempt under SECURE 2.0 §325, and is never counted. An account with no `ownerId` is its own owner; rows for owners not in `ownerIds` are dropped. */
export function buildPreTaxCentsByOwnerIdx(
  accountBalances: ReadonlyMap<string, DrawdownAccountYear> | undefined,
  ledger: ReadonlyArray<McPreTaxLedgerEntry>,
  ownerIds: ReadonlyArray<string>,
  /** Accounts carrying RMD facts leave this pooled Uniform-Lifetime basis: a pooled divisor cannot express an inherited beneficiary schedule, a Table II divisor, a year-scoped §401(a)(9)(C) still-working deferral, a first-year April-1 deferral or a withheld result. They resolve per account in `buildMcFactRmdRequiredCentsByOwnerIdx` and arrive at the floor as already-required cents. */
  rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>,
): number[] {
  const idx = ownerIds.map(() => 0);
  if (accountBalances === undefined) return idx;
  const slotByOwner = new Map<string, number>();
  ownerIds.forEach((id, i) => slotByOwner.set(id, i));
  for (const entry of ledger) {
    const treatment = entry.taxTreatment;
    const type = entry.accountType;
    if (treatment === undefined || type === undefined) continue;
    if (!isQualifyingAccount(type, treatment)) continue;
    if (rmdFactsByAccountId?.[entry.id] !== undefined) continue;
    const row = accountBalances.get(entry.id);
    if (row === undefined) continue;
    const preTaxCents = Math.round(row.preEnd * 100);
    if (preTaxCents <= 0) continue;
    const ownerId = entry.ownerId ?? entry.id;
    const slot = slotByOwner.get(ownerId);
    if (slot === undefined) continue;
    idx[slot] += preTaxCents;
  }
  return idx;
}

/** Converts a `preTaxCentsByOwnerIdx` array back into the `priorPreTaxByOwner` map (member id to cents); a missing or short array yields an empty map ($0 floor). */
export function buildPriorPreTaxByOwnerFromIdx(
  preTaxCentsByOwnerIdx: readonly number[] | undefined,
  ownerIds: ReadonlyArray<string>,
  /** Per-owner fact-based required-withdrawal cents (`DrawdownYear.factRmdRequiredCentsByOwnerIdx`) for the accounts the pooled basis excludes; carried in the same map under `mcFactRmdRequiredKey` so every per-year plumbing hop forwards it unchanged. Absent means no fact-based component. */
  factRmdRequiredCentsByOwnerIdx?: readonly number[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < ownerIds.length; i += 1) {
    const cents = preTaxCentsByOwnerIdx?.[i] ?? 0;
    if (cents > 0) map.set(ownerIds[i], cents);
    const factCents = factRmdRequiredCentsByOwnerIdx?.[i] ?? 0;
    if (factCents > 0) map.set(mcFactRmdRequiredKey(ownerIds[i]), factCents);
  }
  return map;
}

// The `::` segment cannot appear in a member id, mirroring `poolKeyForRmdAccount`'s `pool:` / `acct:` discriminants.
function mcFactRmdRequiredKey(ownerId: string): string {
  return `${ownerId}::rmdRequiredCents`;
}

/** `priorPreTaxByOwner` for the no-ledger kernel fallback (`runOnePathKernel`), which cannot split Roth / brokerage from pre-tax and so keeps a whole-portfolio approximation: the whole prior balance goes to the single survivor whose age yields the largest floor, so the per-owner sum equals the max (no double count for couples). Production runs carry a ledger and never reach this. */
export function buildKernelWholePortfolioPreTaxByOwner(
  survivors: readonly TaxMemberInput[],
  priorBalanceDollars: number,
  taxYear: number,
  rmdSnapshot: TaxCalibrationBundle['rmd'],
): ReadonlyMap<string, number> {
  const wholeCents = dollarsToCents(priorBalanceDollars);
  if (wholeCents <= 0 || survivors.length === 0) return new Map();
  let bestOwnerId = survivors[0].memberId;
  let bestFloor = Number.NEGATIVE_INFINITY;
  for (const survivor of survivors) {
    const single = new Map<string, number>([[survivor.memberId, wholeCents]]);
    const floor = computeMcRmdFloorCents(single, [survivor], taxYear, rmdSnapshot);
    if (floor > bestFloor) {
      bestFloor = floor;
      bestOwnerId = survivor.memberId;
    }
  }
  return new Map<string, number>([[bestOwnerId, wholeCents]]);
}

/**
 * Assembles the `applyTaxYear` input for one path-year. The taxable pre-tax income is grossed up to `max(actual pre-tax draw, floor)`, as the deterministic `tax-cashflow-solver` forces an RMD-age household up to the floor, on both `preTaxWithdrawalDollars` (so MAGI / IRMAA reflect it) and the synthetic account's `withdrawalDollars` (so the re-checked floor is inert); only the tax reflects it, and the caller keeps `drawdown` / `netAfterTax` on the actual draw.
 * The floor is the per-owner `computeMcRmdFloorCents` over `args.priorPreTaxByOwner`, so a Roth-heavy or all-taxable household sees $0 (no phantom RMD income); `floorCentsOverride` lets the representative post-pass substitute its stamped per-owner `rmdFloorCents`.
 */
export function buildMcTaxYearInput(
  args: PerYearTaxArgs,
  survivorState: McSurvivorState,
  preTaxWithdrawalDollars: number,
  rothEarningsExcessDollars = 0,
  floorCentsOverride?: number,
): ApplyFilingPlanYearInput {
  const { taxCtx, taxYear, grossSsDollars, otherIncome, priorBalance, magiMinus2 } = args;
  const grossSsDollarsByMemberId = mcGrossSsByMemberId(taxCtx, taxYear, grossSsDollars);
  const additionalOrdinaryIncomeDollars = args.additionalOrdinaryIncomeDollars ?? 0;
  const { survivors, filingStatus } = survivorState;
  const floorCents =
    floorCentsOverride ??
    computeMcRmdFloorCents(
      args.priorPreTaxByOwner,
      survivors,
      taxYear,
      taxCtx.taxBundle.rmd,
      // A QCD reduces each owner's IRA-pool floor so the gross-up never re-adds it as phantom income; inert under `floorCentsOverride`.
      args.qcdRmdOffsetCentsByOwner,
    );
  const floorDollars = centsToDollars(floorCents);
  const preTaxForTax = Math.max(preTaxWithdrawalDollars, floorDollars);
  const acaBenchmarkSlcspDollars = taxCtx.acaPtcBenchmark?.find(
    (o) => o.taxYear === taxYear,
  )?.annualSlcspDollars;
  return {
    taxYear,
    filingStatus,
    taxUnits: survivorState.taxUnits,
    memberIdByRole: survivorState.memberIdByRole,
    ...(grossSsDollarsByMemberId !== undefined ? { grossSsDollarsByMemberId } : {}),
    age65PlusMemberIds: survivorState.age65PlusMemberIds,
    mfsLivedWithSpouse: survivorState.mfsLivedWithSpouse,
    irmaaLookbackFilingStatus: survivorState.irmaaLookbackFilingStatus,
    irmaaLookbackMfsLivedWithSpouse: survivorState.irmaaLookbackMfsLivedWithSpouse,
    grossSsDollars,
    preTaxWithdrawalDollars: preTaxForTax,
    qcdIncomeExclusionDollars: args.qcdIncomeExclusionDollars ?? 0,
    postTaxNonRothWithdrawalDollars: args.classification?.postTaxNonRothDollars ?? 0,
    postTaxCashLikeWithdrawalDollars: args.classification?.postTaxCashLikeDollars ?? 0,
    rothWithdrawalDollars:
      (args.classification?.rothBasisOrderedDollars ?? 0) +
      (args.classification?.rothWholesaleTaxFreeDollars ?? 0),
    // The pre-59½ Roth earnings excess and a committed Fill-mode conversion are ordinary income that raise MAGI / tax / IRMAA but never offset spendable expense, so they are added here, not via `otherIncome`.
    otherOrdinaryIncomeDollars:
      otherIncome + rothEarningsExcessDollars + additionalOrdinaryIncomeDollars,
    taxExemptInterestDollars: 0,
    assumedCostBasisFraction: args.costBasisFraction ?? taxCtx.assumedCostBasisFraction,
    brokerageLikeStartBalanceDollars: args.brokerageLikeStartBalanceDollars ?? 0,
    cashInterestDollars: args.cashInterestDollars ?? 0,
    householdSize: survivors.length,
    members: survivors,
    // The synthetic account only populates `applyTaxYear`'s RMD output field (unused by MC); the floor was computed externally, so it is tagged to the first survivor for per-owner scoping.
    accounts: [
      {
        id: 'mc-synthetic',
        type: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        balancePriorYearDollars: priorBalance,
        ownerId: survivors[0]?.memberId ?? 'mc-primary',
        withdrawalDollars: preTaxForTax,
      },
    ],
    magiTwoYearsPriorDollars: magiMinus2,
    // In the bootstrap years the ring is empty, so rebuild it from the look-back year's own returns plus the household bootstrap MAGI instead of tiering both spouses on the first spouse's schedule.
    irmaaLookbackUnits:
      args.irmaaLookbackUnitsMinus2 !== undefined && args.irmaaLookbackUnitsMinus2.length > 0
        ? args.irmaaLookbackUnitsMinus2
        : (bootstrapLookbackRing(survivorState.bootstrapLookbackUnits, magiMinus2) ??
          args.irmaaLookbackUnitsMinus2),
    taxpayersAge65Plus: countTaxpayersAge65Plus(survivors, taxYear),
    inflationRatePct: taxCtx.inflationRatePct,
    medicalInflationRatePct: taxCtx.medicalInflationRatePct,
    ...(taxCtx.acaFplRegion !== undefined ? { acaFplRegion: taxCtx.acaFplRegion } : {}),
    ...(acaBenchmarkSlcspDollars !== undefined ? { acaBenchmarkSlcspDollars } : {}),
    // `applyTaxYear`'s `penaltyAccounts` stays empty: `computeMcPenaltyDollars` assesses the §72(t) and Roth-earnings legs separately and `assembleMcTaxResult` folds them into `taxCashflowDollars`, so routing them here too would double-count.
    // The taxable-account yield drag, evolving cost basis and cash interest apply on the display surface only (see `brokerageLikeStartBalanceDollars`); the funded tax and Fill-conversion solve omit them.
    penaltyAccounts: [],
  };
}

function assembleMcTaxResult(
  taxResult: TaxYearResult,
  drawdown: number,
  penaltyDollars = 0,
  medicalExpenseDollars?: number,
  drawNeedDollars?: number,
  drawIncome: ReturnType<typeof drawIncomeCents> = { incomeDrawCents: 0, magiOfDrawCents: 0 },
): McTaxYearResult {
  const fedTax = centsToDollars(taxResult.federalTaxCents);
  const irmaa = centsToDollars(taxResult.irmaaSurchargeCents);
  const ptc = centsToDollars(taxResult.acaPtcSubsidyCents);

  // The full IRMAA surcharge is funded (the path has no per-member SS series to split cash from SS-withheld), mirroring the deterministic `addedNeedDollars`; the ACA PTC offsets the bill but never makes the need negative.
  // The credit is refundable against the whole bill, penalty included, so the penalty is offset before any of it lowers the draw.
  const taxNeedDollars = Math.max(0, fedTax + irmaa + penaltyDollars - ptc);

  // The offset here is the whole surcharge, where the deterministic engine's is the IRMAA cash part only.
  const creditCents =
    medicalExpenseDollars === undefined
      ? 0
      : creditAppliedToPremiumsCents({
          creditCents: taxResult.acaPtcSubsidyCents,
          offsetCents: Math.min(
            taxResult.acaPtcSubsidyCents,
            taxResult.federalTaxCents + taxResult.irmaaSurchargeCents + dollarsToCents(penaltyDollars),
          ),
          medicalCents: dollarsToCents(medicalExpenseDollars),
          remainingNeedCents: dollarsToCents((drawNeedDollars ?? drawdown) + taxNeedDollars),
          povertyLineLimitCents: povertyLineLimitCents({
            headroomCents: taxResult.acaMagiAboveFplCents,
            ...drawIncome,
          }),
        });
  const acaCreditAppliedToPremiums = centsToDollars(creditCents);
  const taxCashflowDollars = taxNeedDollars - acaCreditAppliedToPremiums;

  return {
    fedTax,
    irmaa,
    ptc,
    effectiveTaxRate: taxResult.effectiveTaxRate,
    netAfterTax: drawdown - fedTax - irmaa + ptc,
    magiDollars: centsToDollars(taxResult.magiCents),
    filingUnitMagi: taxResult.filingUnitMagi ?? [],
    taxCashflowDollars,
    acaCreditAppliedToPremiums,
  };
}

// Resolves coverage through the one `resolveMemberHealthCoverage` the deterministic `buildMemberInputs` also calls, so the engines cannot differ; `healthCoverageMonths` goes through the shape-validating reader, so an imported `{ perMember: null }` reads as nothing stated instead of throwing in the per-path loop.
function buildYearMemberFlags(
  m: TaxMemberInput,
  taxYear: number,
  // This member's own separation-from-service year (via `mcMemberRetirementYear`), not a household scalar; the resolver gates automatic Marketplace months on it.
  retirementYear: number,
  optedOut: ReadonlySet<string> = new Set(),
  healthCoverageMonths?: McTaxContext['healthCoverageMonths'],
): TaxMemberInput {
  const coverage = resolveMemberHealthCoverage({
    isoBirthdate: m.isoBirthdate,
    taxYear,
    retired: taxYear >= retirementYear,
    optedOut: optedOut.has(m.memberId),
    stored: readStoredCoverageMonths(healthCoverageMonths, m.memberId, taxYear),
  });
  return {
    memberId: m.memberId,
    isoBirthdate: m.isoBirthdate,
    ...coverage,
  };
}

export interface McLedgerTaxMeta {
  readonly taxTreatment?: AccountTaxTreatment;
  readonly accountType?: AccountType;
  readonly scenarioPenaltyExempt?: boolean;
  readonly deathExemptInherited?: boolean;
}

export interface McAccountYearState {
  readonly withdrawalDollars: number;
  readonly preBalanceStartDollars: number;
  readonly postBalanceStartDollars: number;
}

/** Builds the year's per-account withdrawal classification from the ledger tax metadata and the kernel's per-account year state; `undefined` (all-pre-tax fallback) when the kernel exposed no per-account arrays or the ledger has no tax metadata. */
export function buildYearClassification(
  ledger: readonly McLedgerTaxMeta[],
  yearStates: readonly McAccountYearState[] | undefined,
): McWithdrawalClassification | undefined {
  if (yearStates === undefined || yearStates.length === 0) return undefined;
  const accounts: McAccountYearWithdrawal[] = ledger.map((meta, a) => {
    const state = yearStates[a];
    return {
      taxTreatment: meta.taxTreatment,
      accountType: meta.accountType,
      withdrawalDollars: state?.withdrawalDollars ?? 0,
      preBalanceStartDollars: state?.preBalanceStartDollars ?? 0,
      postBalanceStartDollars: state?.postBalanceStartDollars ?? 0,
      ...(meta.scenarioPenaltyExempt !== undefined
        ? { scenarioPenaltyExempt: meta.scenarioPenaltyExempt }
        : {}),
      ...(meta.deathExemptInherited !== undefined
        ? { deathExemptInherited: meta.deathExemptInherited }
        : {}),
    };
  });
  return classifyMcWithdrawal(accounts);
}

/** Per-year tax arrays accumulated across paths: each inner array has length `pathCount`, the outer `horizon`. */
export interface McTaxAccumulators {
  readonly fedTaxByYear: number[][];
  readonly irmaaSurchargeByYear: number[][];
  readonly acaPtcSubsidyByYear: number[][];
  readonly acaCreditAppliedToPremiumsByYear: number[][];
  readonly effectiveTaxRateByYear: number[][];
  readonly netAfterTaxByYear: number[][];
}

export function createTaxAccumulators(
  horizon: number,
  pathCount: number,
  hasTaxCtx: boolean,
): McTaxAccumulators | null {
  if (!hasTaxCtx) return null;
  return {
    fedTaxByYear: Array.from({ length: horizon }, () => new Array<number>(pathCount)),
    irmaaSurchargeByYear: Array.from({ length: horizon }, () => new Array<number>(pathCount)),
    acaPtcSubsidyByYear: Array.from({ length: horizon }, () => new Array<number>(pathCount)),
    acaCreditAppliedToPremiumsByYear: Array.from(
      { length: horizon },
      () => new Array<number>(pathCount),
    ),
    effectiveTaxRateByYear: Array.from({ length: horizon }, () => new Array<number>(pathCount)),
    netAfterTaxByYear: Array.from({ length: horizon }, () => new Array<number>(pathCount)),
  };
}

export interface AfterTaxBaseState {
  base: number;
  depleted: boolean;
}

/** One absorbing step: the after-tax balance through year y, which is the base year y+1 reads. Depletion latches only once real tax has been drawn and the year had a positive raw balance wiped to <= 0; once latched the base stays 0 despite a raw recovery, while a no-tax or zero-balance year does not latch. */
export function advanceAfterTaxBase(
  prev: AfterTaxBaseState,
  rawNominalThisYear: number,
  cumTaxThroughThisYear: number,
): AfterTaxBaseState {
  if (prev.depleted) return { base: 0, depleted: true };
  // A cumulative draw below zero adds nothing back.
  const afterTax = Math.max(0, rawNominalThisYear - Math.max(0, cumTaxThroughThisYear));
  const depleted = cumTaxThroughThisYear > 0 && rawNominalThisYear > 0 && afterTax <= 0;
  return { base: afterTax, depleted };
}
