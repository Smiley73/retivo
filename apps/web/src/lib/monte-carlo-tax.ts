/**
 * Per-year tax estimation helpers for the Monte Carlo engine.
 *
 * The MC path routes each year's portfolio withdrawal per account
 * (pre-tax / Roth / taxable-non-Roth / cash-like) using the per-account tax
 * metadata carried on `MonteCarloAccountLedger` and the kernel's per-account
 * year-end buckets — replacing an all-pre-tax approximation. The
 * resulting tax cashflow (federal tax + IRMAA cash − ACA PTC offset + IRMAA
 * withheld from Social Security) is returned so the caller can subtract it
 * from path balances, making taxes affect MC depletion / success probability /
 * percentiles (not annotation-only). When a ledger carries no tax metadata
 * (e.g. test fixtures) the classifier falls back to the all-pre-tax
 * routing — the same conservative (higher-tax) direction.
 *
 * The year's taxable pre-tax income is grossed up to the synthetic
 * account's RMD floor (`max(actual pre-tax draw, floor)`) via the shared
 * `computeRmdFloorCents`, so an RMD-age household under-spending its required
 * minimum withdrawal still owes tax on the forced income — matching the
 * deterministic side. Only the tax reflects the grossed figure; the path's
 * drawdown / net-after-tax stay on the actual (un-grossed) draw.
 *
 * The tax rules themselves are explained in docs/math-taxes.md.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is the
 * Monte Carlo tax-coordination layer — the Roth-basis carrier
 * (`seedMcAggregateRothBasisCarrier` / ordering), the per-year tax apply, the
 * survivor / RMD-floor tracking, the per-tax-unit filing-status pass-through
 * (including MFS/QSS), the taxable-income inputs and the member health flags
 * all consume the one shared `McTaxContext` / `PerYearTaxArgs` (which
 * deliberately live here, not in monte-carlo.ts, to avoid a circular import).
 * Peeling any one concern out would re-export that context plus the
 * basis-carrier and per-account snapshot types across a hot per-path boundary
 * for no boundary gain. Design facts that sit inside this seam:
 * `buildSurvivorStatesByYear` is a thin loop over the exported
 * `deriveMcSurvivors`, which stays the per-call fallback; the taxable-income
 * accumulator (`advanceMcTaxableIncomeState`) runs ONLY in the representative
 * display post-pass (`monte-carlo-tax-burden.ts`) — never the funded per-path
 * loop — and its math is imported from the shared deterministic helpers (no
 * duplication); `buildYearMemberFlags` delegates every Medicare / Marketplace /
 * overlap decision to the ONE shared `resolveMemberHealthCoverage` in
 * `tax-integration-helpers.ts` (the same function the deterministic twin
 * calls). Output is pinned by the same MC parity-baseline gate as the kernel
 * (monte-carlo-tax.test.ts), so refactors here are checked against a frozen
 * numeric baseline.
 * Trigger: a change adding 5 or more lines here must either refactor the file
 * back under 800 lines or re-justify this exception in this note.
 */

import {
  applyTaxYearForFilingPlan,
  bootstrapLookbackRing,
  centsToDollars,
  computeRmdFloorCents,
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
// The ONE shared health-coverage resolver both engines call.
import {
  readStoredCoverageMonths,
  resolveMemberHealthCoverage,
} from './tax-integration-helpers';
import {
  seedFactBasedRothBasisCarrier,
  applyFactBasedRothIraOrdering,
  // The MC pooled designated-Roth slice runs the SAME stateful engine the
  // deterministic per-account path runs (pro rata against REMAINING basis + the
  // in-plan-rollover recapture lots), so the two regimes cannot drift.
  applyFactBasedDesignatedRothDistribution,
  seedDesignatedRothCarrier,
  type MutableDesignatedRothAccountEntry,
  type RothBasisCarrier,
} from './balance-projection-runner-roth-basis';
import { isPureRothEmployerType, isRothDesignatedPostBucket } from './balance-calc';
// The shared still-working-exception predicate (facts-only, year-independent)
// so the pooled MC floor and the deterministic engine agree on which accounts owe
// no living-owner minimum at all.
import type { RmdAccountProfileFacts } from './rmd';
// The fact-based Roth ordering primitives shared with the deterministic
// engine: the exact 59½ half-birthday resolver and the §408A/§402A five-year clock.
import { penaltyFractionForYear } from './early-withdrawal-penalty';

/**
 * Single aggregate carrier key for the MC per-path Roth basis.
 *
 * The MC kernel collapses the household to one synthetic withdrawal pool with no
 * per-account owner detail at withdrawal time, so the per-path Roth basis carrier
 * is seeded and consumed under ONE aggregate key holding the SUMMED household
 * §408A basis (sum over the owners in `McTaxContext.rothBasisCentsByOwner`).
 * Seeding and consumption both key off this constant. The seed is the
 * DRAWABLE-only per-owner total (`mcDrawableRothBasisCentsByOwner`): an
 * all-closed pool's derived basis is excluded there because no deterministic
 * pass can ever consume it, so the household total this pool shields across the
 * path matches the total the deterministic engine can actually credit — not the
 * larger resolved-display total. (The deterministic engine keeps the
 * per-owner carrier because it sees the real owning member on each account.)
 */
export const MC_AGGREGATE_ROTH_OWNER_KEY = 'mc-aggregate-roth-owner';

/** Canonicalize a per-owner Roth-basis map into the plain, cache-key-visible
 *  array `McTaxContext` carries: ascending by `ownerId` (so two semantically equal
 *  maps hash to one `mcCacheKey`) and omitting non-positive entries. */
export function canonicalMcRothBasisByOwner(
  basisCentsByOwner: ReadonlyMap<string, number>,
): readonly { readonly ownerId: string; readonly cents: number }[] {
  return [...basisCentsByOwner.entries()]
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([ownerId, cents]) => ({ ownerId, cents }));
}

/**
 * Plain, structured-clone- AND JSON-safe fact-based Roth state for the MC
 * synthetic pool. Every field is a primitive or an array of primitives so the
 * whole profile participates in `mcCacheKey` (no `Map` / `Set`).
 */
export interface McRothOrderedProfile {
  /** Share (0..1) of the §408A-ordered Roth draw attributable to ROTH IRAs, from
   *  the ledger's initial Roth balances. Computed over NON-INHERITED Roth IRA
   *  balance only: an inherited Roth IRA's dollars never enter the ordered
   *  pool, so counting its balance here would split the pool against dollars that
   *  are not in it. 1 → all-IRA (the shape with no designated-Roth accounts). */
  readonly iraShareOfOrderedPool: number;
  /** The pooled §408A five-year clock: the LATEST of the owners' own (already
   *  per-owner-earliest, per Pub. 590-B) first-contribution years, and ABSENT when
   *  any contributing owner records none. IRC §408A's five-year period is PER
   *  INDIVIDUAL and the MC kernel's Roth bucket has no owner attribution at
   *  withdrawal time, so the pooled clock must be the one no owner can beat —
   *  a cross-owner EARLIEST would let an older spouse's seasoned IRA qualify a
   *  younger spouse's unseasoned one. Absent → NOT satisfied (conservative). */
  readonly iraFirstContributionTaxYear?: number;
  /** Every recorded Roth-IRA conversion lot in the household, AGGREGATED BY TAX
   *  YEAR (the statutory §408A(d)(4)(B) grouping, which also bounds the per-path
   *  FIFO scan to one entry per distinct year) and ascending by year. Each year
   *  keeps its own five-tax-year recapture clock. */
  readonly iraConversionLots: readonly {
    readonly taxYear: number;
    readonly taxableCents: number;
    readonly nontaxableCents: number;
  }[];
  /** Recorded designated-Roth basis summed across every designated account. */
  readonly designatedBasisCents: number;
  /** The designated pool's balance at context-build time — the SEED for the pooled
   *  carrier's running balance, used as the §402A(d)(4) pro-rata denominator only
   *  when the caller cannot supply the year's real designated-Roth pocket balance
   *  (the no-ledger kernel fallback). A $0 balance with $0 recorded basis means no
   *  pool is seeded at all, so the designated slice keeps the all-IRA shape. */
  readonly designatedBalanceCents: number;
  /** LATEST first-participation tax year across the designated accounts, ABSENT
   *  when ANY of them records none (order-independently). The latest (not
   *  earliest) is deliberate: designated-Roth accounts never pool, so a pooled
   *  clock must be the one LEAST likely to be satisfied (conservative).
   *  Absent → not satisfied. */
  readonly designatedFirstParticipationTaxYear?: number;
  /** True only when EVERY designated source is a governmental 457(b), so the
   *  §72(t)(9) earnings carve-out can be applied to the pooled slice without
   *  waiving a penalty a non-457(b) sibling genuinely owes (conservative). */
  readonly designatedAllGovernmental457b: boolean;
  /** Pooled designated-Roth IN-PLAN rollover lots, aggregated by tax year and
   *  ascending. Each carries its own five-tax-year §402A(c)(4)(D) recapture clock,
   *  so taxable rollover principal withdrawn inside its window before 59½ enters
   *  the additional-tax base — previously absent from the MC profile entirely, so
   *  that recapture could never fire on a Monte Carlo path. */
  readonly designatedInPlanRolloverLots?: readonly {
    readonly taxYear: number;
    readonly taxableCents: number;
    readonly nontaxableCents: number;
  }[];
  /** Member ids of every owner whose Roth accounts feed the pooled bucket, sorted.
   *  The age-59½ qualifying-event test is PER INDIVIDUAL, so the pooled test
   *  requires EVERY one of these owners to have reached 59½ for the whole year —
   *  the primary member's age alone could otherwise qualify (and un-penalize) a
   *  younger spouse's Roth earnings. Absent → the legacy primary-only test. */
  readonly rothOwnerIds?: readonly string[];
}

/**
 * Seed an MC per-path Roth basis carrier under the single aggregate key.
 *
 * Sums every owner's derived §408A basis in `basisCentsByOwner` into ONE carrier
 * entry keyed by `MC_AGGREGATE_ROTH_OWNER_KEY`, so the household's full Roth
 * basis is consumed against the synthetic aggregate pool `applyMcRothBasisOrdering`
 * draws from. Returns a fresh mutable carrier (each path owns an independent copy).
 */
export function seedMcAggregateRothBasisCarrier(
  /** The plain per-owner array carried on `McTaxContext`. A `ReadonlyMap` is
   *  also accepted for direct unit-test callers; production always passes the
   *  cache-key-visible array. */
  basisCentsByOwner:
    | readonly { readonly ownerId: string; readonly cents: number }[]
    | ReadonlyMap<string, number>
    | undefined,
  /** The fact-based profile. When present the aggregate entry also carries
   *  the household's recorded CONVERSION LOTS (each with its own five-tax-year
   *  recapture clock), so the MC pool runs the real §408A order rather than a
   *  single contribution-first bucket. */
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

// ---------------------------------------------------------------------------
// McTaxContext (lives here to avoid circular import with monte-carlo.ts)
// ---------------------------------------------------------------------------

/**
 * Lightweight household context for per-path tax estimation inside the
 * MC engine. Carries household-level tax inputs (filing status, members,
 * inflation, projected death years); per-account withdrawal routing is
 * supplied separately each year from the kernel's per-account buckets +
 * the ledger tax metadata.
 *
 * Per-account routing: the engine classifies each year's withdrawal
 * by account tax treatment (pre-tax → ordinary income, Roth → tax-free,
 * brokerage/OTHER → LTCG/QDI proxy, cash-like → return of principal). When
 * the ledger carries no tax metadata the engine falls back to the
 * all-pre-tax classification — conservative (higher-tax) for stress testing.
 */
export interface McTaxContext {
  /** Five-engine calibration bundle. */
  readonly taxBundle: TaxCalibrationBundle;
  /**
   * IRS filing status (initial — recomputed each year from
   * `primaryDeathYear` / `secondaryDeathYear` + the override below).
   * Kept for backward compatibility; callers should also pass the
   * override / death years so the per-year recompute reflects survivor
   * filing-status transitions.
   */
  readonly filingStatus: FilingStatus;
  /**
   * Per-member info for Medicare / ACA engagement gates.
   * Length 1 (single / HoH) or 2 (MFJ).
   */
  readonly members: readonly TaxMemberInput[];
  /** Number of household members (for ACA household-size calc). */
  readonly householdSize: number;
  /**
   * Fraction of POST_TAX non-Roth withdrawal assumed to be LTCG/QDI.
   * Forwarded to `applyTaxYear` as `assumedCostBasisFraction`.
   * Defaults to 0.5 inside `applyTaxYear` when absent.
   */
  readonly assumedCostBasisFraction?: number;
  /**
   * Annual inflation rate as a percentage (e.g. 2.5 for 2.5%).
   * Forwarded to `applyTaxYear` for inflation-scaling of dollar-denominated
   * thresholds when the tax year exceeds the latest calibration snapshot.
   */
  readonly inflationRatePct?: number;
  /** Calendar year the primary is projected to die. `undefined`
   *  → alive for every projection year. Drives the per-year
   *  filing-status + household-size + Medicare-count recompute. */
  readonly primaryDeathYear?: number;
  /** Calendar year the secondary is projected to die. Same
   *  semantics as `primaryDeathYear`. `undefined` when no secondary
   *  member exists or when the secondary's birthdate is missing. */
  readonly secondaryDeathYear?: number;
  /** Scenario filing-status override (mirrors the deterministic
   *  post-pass). `undefined` → derive from per-year alive-state. */
  readonly filingStatusOverride?: FilingStatusOverride;
  /**
   * Serializable scenario filing plan carried across the worker
   * boundary. When present it supersedes `filingStatusOverride` everywhere the
   * plan is resolved — `deriveMcSurvivors` (the per-path tax) and the federal
   * seam `buildMcTaxUnitFederalInputs` alike. A plain data union →
   * structured-clone-safe, and part of the serialized input's cache key.
   */
  readonly taxFilingPlan?: TaxFilingPlan;
  /**
   * Per-owner Roth-IRA REGULAR-contribution basis (integer cents) as a
   * PLAIN sorted array — never a `Map`. `mcCacheKey` hashes
   * `JSON.stringify(input)`, and `JSON.stringify(new Map())` is `{}`, so a Map here
   * would be invisible to the cache key and two households with different resolved
   * Roth basis would share one cached summary.
   *
   * The MC kernel has no per-account owner detail at withdrawal time, so each path
   * SUMS these into one aggregate carrier entry (`MC_AGGREGATE_ROTH_OWNER_KEY`).
   * The values are what each owner's §408A pools have LEFT after their
   * recorded contribution/withdrawal history is walked — the same figures the
   * deterministic engine seeds, from the same adapter. Absent/empty → no Roth
   * basis (every Roth dollar is earnings — the conservative direction).
   */
  readonly rothBasisCentsByOwner?: readonly { readonly ownerId: string; readonly cents: number }[];
  /**
   * The fact-based §408A/§402A state the MC synthetic Roth pool needs, as
   * plain serializable data (part of the cache key by construction).
   *
   * MC pools every Roth source into ONE withdrawal bucket, so the per-account
   * fidelity the deterministic engine has is not reachable here. What IS reachable
   * is the correct SHAPE of both regimes:
   *   - the Roth-IRA slice runs the real §408A order (remaining regular basis →
   *     remaining conversion lots FIFO with their own five-year recapture clocks →
   *     earnings), both derived from the pools' recorded balance history;
   *   - the designated-Roth slice is PRO RATA basis/earnings (§402A(d)(4)), not
   *     contribution-first, using the in-plan-rollover-principal basis fraction of
   *     the designated pool.
   * The two slices are split by `iraShareOfOrderedPool`. Absent → the pool keeps
   * the conservative all-earnings behaviour.
   */
  readonly rothOrderedProfile?: McRothOrderedProfile;
  /** Scenario-marked early-withdrawal-penalty exempt account ids. A Roth
   *  IRA / pre-tax / HSA account in this set has its 10%/20% penalty leg waived
   *  per path (the income tax on the earnings tranche still applies). The MC
   *  kernel pools accounts into synthetic buckets, so the per-leg waiver is
   *  pre-resolved from these ids into the two booleans below at context-build
   *  time (`buildMcTaxContext`); this raw set is carried for parity/diagnostics. */
  readonly earlyWithdrawalPenaltyExemptAccountIds?: readonly string[];
  /** True when EVERY pre-tax-contributing account (PRE_TAX / MIXED) that
   *  drives the MC synthetic pre-tax bucket is penalty-exempt (scenario-marked
   *  or statutorily penalty-free) — pre-resolved in `buildMcTaxContext` from
   *  `earlyWithdrawalPenaltyExemptAccountIds` + the account types. Waives the
   *  whole §72(t) leg. The PRIMARY exemption channel is the
   *  classifier's per-source split (`preTaxPenaltyExemptDollars` — a partly-
   *  exempt pool penalizes only its non-exempt-source portion); this flag is
   *  retained as the whole-leg fallback for classifications built without
   *  per-source exemption info. Absent → false (no waiver). */
  readonly mcPreTaxPenaltyAllExempt?: boolean;
  /** True when EVERY account driving the MC synthetic §408A-ordered Roth
   *  bucket is penalty-exempt (scenario-marked or a governmental 457(b)
   *  variant) — pre-resolved in `buildMcTaxContext`. Waives only the 10%
   *  Roth-earnings penalty leg (the ordinary-income tax on the earnings
   *  tranche still applies). The per-source
   *  `rothOrderedPenaltyExemptDollars` prorates a partly-exempt pool; this flag
   *  is the whole-leg fallback. Absent → false (no waiver). */
  readonly mcRothPenaltyAllExempt?: boolean;
  /**
   * MAGI bootstrap for projection YEAR 0 (= MAGI(ret−2)), whole
   * dollars. Seeds the MC IRMAA 2-year look-back ring's `minus2` slot so the
   * MC engine charges projection-year-0 IRMAA in agreement with the
   * deterministic engine. `undefined` → the ring's `minus2` stays undefined and
   * MC charges $0 IRMAA for year 0 (the no-bootstrap case; the deterministic
   * engine's projected-MAGI estimate is a known difference, not threaded into
   * the MC kernel here).
   */
  readonly magiBootstrapLookbackMinus2?: number;
  /**
   * MAGI bootstrap for projection YEAR 1 (= MAGI(ret−1)), whole
   * dollars. Seeds the ring's `minus1` slot so MC charges projection-year-1
   * IRMAA in agreement with the deterministic engine. `undefined` → MC charges
   * $0 IRMAA for year 1 (no-bootstrap case, see above).
   */
  readonly magiBootstrapLookbackMinus1?: number;
  /**
   * ACA opt-out: household member ids treated as NOT on the ACA Marketplace
   * (retiree / COBRA / spousal-employer coverage). `buildYearMemberFlags` forces
   * `hasAcaCoverage` false for any member in this set, matching the deterministic
   * `buildMemberInputs` derivation. Threaded as the RAW member-id
   * array (NOT pre-collapsed to a boolean — member identity survives into
   * `buildYearMemberFlags`, unlike the pooled penalty template). Sorted + deduped
   * + omitted when empty at build time. Absent → no opt-outs.
   */
  readonly acaMarketplaceOptOutMemberIds?: readonly string[];
  /**
   * Per-member, per-tax-year Medicare Part B / Part D and ACA Marketplace
   * coverage MONTHS, the MC twin of the deterministic runner's
   * `PipelineContext.healthCoverageMonths`. A PLAIN nested object of numbers
   * (never a `Map` — `JSON.stringify(new Map)` is `{}`, invisible to the
   * `mcCacheKey`), so two scenarios with different coverage months can never
   * collide on one cached summary. Omitted when the scenario stores none, so a
   * scenario without monthly facts keeps an unchanged serialized input.
   */
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
  /**
   * Federal-poverty-level region for the ACA FPL denominator. Omitted when
   * the scenario stores none (→ `'contiguous'`, unchanged output + cache key).
   */
  readonly acaFplRegion?: AcaFplRegion;
  /**
   * The scenario's per-year annual SLCSP benchmark overrides
   * (`ScenarioOverrides.acaPtcBenchmark`), so a stated benchmark reaches the MC
   * ACA-PTC calculation exactly as it reaches the deterministic one. Sorted by
   * tax year and omitted when empty (stable cache key for a scenario that sets
   * none).
   */
  readonly acaPtcBenchmark?: ReadonlyArray<{
    readonly taxYear: number;
    readonly annualSlcspDollars: number;
  }>;
  /**
   * Each spouse's OWN share of the household's gross Social Security,
   * per calendar year. Social Security is ATTRIBUTED to the member who receives
   * it (§86 / IRS Pub 555), never blanket-split, so a `separate` couple's two
   * returns each carry only their own benefit — exactly as the deterministic
   * runner does via `ownSsByMemberForYear`. Without this, §86 (a non-linear,
   * per-return computation) would produce a DIFFERENT taxable-SS figure in the
   * two engines for the same household, and that feeds federal tax → MAGI →
   * IRMAA → path balances → success probability.
   *
   * Sparse: emitted only for two-member households (a one-member household's
   * single return already carries all of it) and omitted when the household has
   * no Social Security at all, so a scenario that cannot be affected keeps an
   * unchanged serialized input + `mcCacheKey`. Entries are ordered by year
   * so the cache key is stable.
   */
  readonly ssSharesByYear?: ReadonlyArray<{
    readonly year: number;
    /** Primary member's fraction of that year's household SS, in `[0, 1]`. */
    readonly primaryShare: number;
  }>;
  /**
   * Each member's OWN separation-from-service calendar
   * year, for a household whose members retire in DIFFERENT years.
   *
   * Passing ONE household `retirementYear` scalar (the primary's) to both
   * members would diverge from the deterministic twin, which resolves each
   * member's own year (`resolveRetirementYearByMember`). With
   * staggered retirements and no explicit Marketplace-month override, MC
   * would switch the still-working secondary onto ACA Marketplace
   * coverage YEARS EARLY — a different PTC, a different tax bill and different
   * path balances than the deterministic engine reports for the same plan.
   *
   * A PLAIN array sorted by member id (never a `Map` — `JSON.stringify(new Map)`
   * is `{}`, invisible to `mcCacheKey`; never an id-keyed object — an
   * imported member id may be `"__proto__"`). SPARSE: emitted only when the
   * household actually staggers, so a same-date household keeps an
   * unchanged serialized input and cache key. Absent → every member falls
   * back to the household scalar, which is exactly the primary's year.
   */
  readonly retirementYearByMember?: readonly {
    readonly memberId: string;
    readonly retirementYear: number;
  }[];
}

// ---------------------------------------------------------------------------
// Age helpers
// ---------------------------------------------------------------------------

/**
 * Count household members aged 65+ in a given tax year.
 * Uses `TaxMemberInput.isoBirthdate` for the birth-year calculation.
 * Used for the federal-tax standard-deduction add-on.
 */
export function countTaxpayersAge65Plus(
  members: readonly TaxMemberInput[],
  taxYear: number,
): number {
  let count = 0;
  for (const m of members) {
    // Born-Jan-1 rule applied via hasAttainedAgeByYearEnd (same as the
    // deterministic twin in balance-projection-runner-tax-helpers).
    if (hasAttainedAgeByYearEnd(m.isoBirthdate, taxYear, 65)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-year tax result
// ---------------------------------------------------------------------------

/** Result of one year's tax estimation on a Monte Carlo path. */
export interface McTaxYearResult {
  readonly fedTax: number;
  readonly irmaa: number;
  readonly ptc: number;
  readonly effectiveTaxRate: number;
  readonly netAfterTax: number;
  /** MAGI in dollars — caller stores in ring buffer for IRMAA look-back. */
  readonly magiDollars: number;
  /** This year's returns (members + status + own MAGI), buffered by the
   *  caller into the IRMAA two-year look-back ring. */
  readonly filingUnitMagi: readonly FilingUnitMagi[];
  /**
   * Same-year tax cashflow the portfolio must fund: federal tax +
   * IRMAA surcharge − ACA PTC offset, floored at zero, in dollars. The
   * caller subtracts this from the path's balance trajectory so taxes affect
   * MC depletion / success / percentiles. The FULL IRMAA surcharge is funded
   * (cash + the portion withheld from Social Security) because the spendable
   * income series spends gross SS — mirrors the deterministic `addedNeedDollars`,
   * the conservative single-household direction for stress testing.
   */
  readonly taxCashflowDollars: number;
}

/**
 * Per-bucket withdrawal classification for one MC path-year. Dollar
 * amounts; sums to the year's net portfolio withdrawal. Mirrors the
 * deterministic `splitWithdrawalsByTaxTreatment` output (sans the Roth fields,
 * which are tax-free and never directly feed the tax engines — their earnings
 * excess above §408A basis is threaded via `applyMcRothBasisOrdering`).
 *
 * Two Roth sub-buckets for §408A basis ordering:
 *   `rothBasisOrderedDollars` — `RETIREMENT_ROTH_IRA` + the four pure
 *     designated-Roth employer types (ROTH_401K/403B/457B/TSP). These go
 *     through per-path cumulative basis ordering in `applyMcRothBasisOrdering`.
 *   `rothWholesaleTaxFreeDollars` — any other `taxTreatment: 'ROTH'` account
 *     type that is genuinely wholesale tax-free (no §408A ordering; currently
 *     no account types route here, reserved for future extensibility).
 */
export interface McWithdrawalClassification {
  readonly preTaxDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  /** §408A basis-ordered Roth draw (ROTH_IRA + pure employer Roth types). */
  readonly rothBasisOrderedDollars: number;
  /** Wholesale tax-free Roth draw (no basis ordering; future-reserved). */
  readonly rothWholesaleTaxFreeDollars: number;
  /**
   * Per-source penalty split: the portion of `preTaxDollars` that came
   * from penalty-EXEMPT sources — scenario-marked exempt accounts
   * (`scenarioPenaltyExempt`) or types statutorily outside §72(t)
   * (`!carriesTenPercentPenalty`, e.g. the governmental 457(b)). The penalty
   * pass charges the 10% leg only on `preTaxDollars − preTaxPenaltyExemptDollars`,
   * so a mixed 457(b)+IRA pool penalizes only the IRA-sourced portion (matching
   * the deterministic per-account engine). Optional for backward compatibility:
   * absent → 0 (nothing exempt — the conservative pooled behavior).
   */
  readonly preTaxPenaltyExemptDollars?: number;
  /**
   * Per-source penalty split: the portion of `rothBasisOrderedDollars`
   * from penalty-exempt sources — scenario-marked exempt accounts or the
   * governmental 457(b) variants (`RETIREMENT_ROTH_457B`; the MIXED
   * `RETIREMENT_457B` Roth-designated post sub-bucket). The pooled §408A basis
   * carrier cannot attribute the earnings excess per account, so the penalty
   * pass prorates the excess by the year's non-exempt share of the ordered draw.
   * Absent → 0 (nothing exempt).
   */
  readonly rothOrderedPenaltyExemptDollars?: number;
}

/** Per-account inputs to `classifyMcWithdrawal` for one path-year. All arrays
 *  are parallel + iterated in fixed ledger order (seed-independent). */
export interface McAccountYearWithdrawal {
  /** Account tax treatment; `undefined` → all-pre-tax fallback. */
  readonly taxTreatment: AccountTaxTreatment | undefined;
  /** Account type for the Roth / cash-like split; `undefined` → fallback. */
  readonly accountType: AccountType | undefined;
  /** Dollars withdrawn from this account across the year. */
  readonly withdrawalDollars: number;
  /** Pre-tax bucket balance at year start (for the MIXED pre/post split). */
  readonly preBalanceStartDollars: number;
  /** Post-tax bucket balance at year start (for the MIXED pre/post split). */
  readonly postBalanceStartDollars: number;
  /** True when this account id is in the scenario's
   *  `earlyWithdrawalPenaltyExemptAccountIds` set. The classifier combines it
   *  with the statutory type predicates to accumulate the per-source
   *  penalty-exempt dollars. Absent → not scenario-exempt. */
  readonly scenarioPenaltyExempt?: boolean;
  /** §72(t)(2)(A)(ii): this source is an INHERITED account, so its
   *  distribution is made on account of the original owner's death and carries no
   *  10% additional tax at any beneficiary age. Absent → an owner account. */
  readonly deathExemptInherited?: boolean;
}

/**
 * Classify one MC path-year's per-account withdrawals into the five tax
 * buckets. Iterates accounts in fixed ledger order so same-seed runs
 * stay bit-identical. An account missing tax metadata routes its
 * whole withdrawal to pre-tax (the conservative fallback). MIXED
 * accounts split the withdrawal by the account's pre/post balance ratio at
 * year start (the MC kernel withdraws proportional-to-balance; an exact
 * per-bucket split is not surfaced, so the start-of-year ratio is the
 * deterministic proxy — documented approximation).
 *
 * `taxTreatment === 'ROTH'` accounts are sub-classified by account type:
 * `RETIREMENT_ROTH_IRA` and the four pure employer types go to
 * `rothBasisOrderedDollars` (feed `applyMcRothBasisOrdering`); any other ROTH
 * type goes to `rothWholesaleTaxFreeDollars` (wholesale tax-free, no ordering).
 * An INHERITED `RETIREMENT_ROTH_IRA` (`deathExemptInherited`) overrides that:
 * it is wholesale tax-free too — it carries no basis
 * state anywhere and must never reach the ordered carrier. An inherited
 * designated-Roth plan is unaffected.
 *
 * MIXED Roth-designated accounts (401k/403b/457b/TSP) split by
 * the pre/post balance ratio at year start; the post share routes to
 * `rothBasisOrderedDollars` (tax-free Roth, feeds §408A ordering). When the
 * total balance is 0, the whole withdrawal falls back to pre-tax.
 *
 * Per-source penalty split: alongside the tax buckets the classifier
 * accumulates the penalty-EXEMPT sub-portions of the pre-tax and §408A-ordered
 * Roth buckets (`preTaxPenaltyExemptDollars` / `rothOrderedPenaltyExemptDollars`),
 * preserving withdrawal provenance so `computeMcPenaltyDollars` penalizes only
 * the actually-non-exempt-source portion of a mixed pool. A source is exempt
 * when scenario-marked (`scenarioPenaltyExempt`) or statutorily penalty-free:
 * `!carriesTenPercentPenalty(type)` for the §72(t) pre-tax leg (the
 * governmental 457(b) et al — the same predicate the deterministic
 * `computeEarlyWithdrawalPenalty` skips on), and the governmental 457(b)
 * variants (`RETIREMENT_ROTH_457B`; MIXED `RETIREMENT_457B` post bucket) for
 * the Roth-earnings leg. An INHERITED source (`deathExemptInherited`) is
 * exempt on BOTH legs — §72(t)(2)(A)(ii) waives the 10% on a post-death
 * distribution at any beneficiary age, exactly as the deterministic twin does
 * for an inherited designated-Roth plan (`computeDesignatedRothDistribution`).
 * The no-metadata fallback rows stay non-exempt (conservative).
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
    // Per-source penalty exemption for the two penalized legs.
    const preTaxLegExempt =
      acc.scenarioPenaltyExempt === true ||
      // §72(t)(2)(A)(ii) — a post-death inherited distribution carries no 10%.
      acc.deathExemptInherited === true ||
      !carriesTenPercentPenalty(acc.accountType);
    const rothLegExempt =
      acc.scenarioPenaltyExempt === true ||
      // §72(t)(2)(A)(ii) applies to the Roth leg too — an INHERITED
      // designated-Roth plan's nonqualified earnings carry no 10% at any
      // beneficiary age, which is what the deterministic twin does
      // (`computeDesignatedRothDistribution`'s `inheritedFromDeceasedOwner`
      // short-circuit). Without this the two engines would disagree on the tax of
      // a pre-59½ draw from an inherited RETIREMENT_ROTH_401K/403B/TSP.
      acc.deathExemptInherited === true ||
      acc.accountType === 'RETIREMENT_ROTH_457B' ||
      acc.accountType === 'RETIREMENT_457B';
    if (acc.taxTreatment === 'PRE_TAX') {
      preTaxDollars += w;
      if (preTaxLegExempt) preTaxPenaltyExemptDollars += w;
      continue;
    }
    if (acc.taxTreatment === 'HSA') {
      // Qualified HSA withdrawals carry no ordinary-income tax + no MAGI.
      // Route the principal to the cash-like post-tax bucket — the same
      // bucket the HSA account TYPE maps to — preserving the existing HSA tax
      // model (nonqualified income + pre-65 20% penalty layered on separately
      // by account TYPE, independent of treatment).
      postTaxCashLikeDollars += w;
      continue;
    }
    if (acc.taxTreatment === 'ROTH') {
      // An INHERITED Roth IRA is wholesale tax-free — it holds no basis state
      // anywhere, so its dollars must leave the ordered pool BEFORE the carrier is
      // touched rather than be netted off the earnings tranche afterwards (which
      // would still exhaust the owner's own basis). Scoped to the Roth-IRA type
      // alone: an inherited DESIGNATED-Roth plan keeps its §402A ordering below.
      const inheritedRothIra =
        acc.accountType === 'RETIREMENT_ROTH_IRA' && acc.deathExemptInherited === true;
      // Sub-classify by account type. ROTH_IRA + pure employer Roth types
      // go through §408A basis ordering; any other ROTH type is wholesale.
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
      // Zero-balance fallback — cannot split by ratio, route all to pre-tax.
      const preShare = total > 0 ? w * (acc.preBalanceStartDollars / total) : w;
      const postShare = total > 0 ? w - preShare : 0;
      preTaxDollars += preShare;
      if (preTaxLegExempt) preTaxPenaltyExemptDollars += preShare;
      // MIXED Roth-designated (401k/403b/457b/TSP) — post sub-bucket is
      // Roth-designated; routes to `rothBasisOrderedDollars` for §408A ordering.
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
    // POST_TAX non-Roth: brokerage/OTHER → LTCG proxy; cash-like → principal.
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

// ---------------------------------------------------------------------------
// Per-year tax estimation
// ---------------------------------------------------------------------------

/** Args for `applyPerYearTaxForPath`. */
export interface PerYearTaxArgs {
  readonly taxCtx: McTaxContext;
  readonly taxYear: number;
  readonly retirementYear: number;
  readonly grossSsDollars: number;
  /**
   * Windowed nominal expense at this year-END step. Already CPI-scaled by the
   * path's own cumulative inflation —
   * `sum(monthlyExpenseBase[months∈year]) × cumCpi[endStep]` (scalar) or the
   * per-bucket year-sum × year-END mean-shifted factor (bucketed). A time-limited
   * expense is therefore charged only in its active years' fallback drawdown +
   * `netAfterTax` display. MAGI already flows via the windowed draw →
   * `classification`; this governs the fallback drawdown + display.
   */
  readonly nominalExpense: number;
  /** Non-SS non-portfolio ordinary income for this year. Offsets the year's
   *  spendable expense (reduces the computed drawdown) AND adds to taxable
   *  ordinary income. */
  readonly otherIncome: number;
  /**
   * Additional ordinary income that adds to taxable income / MAGI but does
   * NOT offset the year's spendable expense — a committed Fill-mode Roth
   * conversion (the converted principal is taxable ordinary income the year it is
   * converted, but is not spendable household income). Threaded straight into
   * `otherOrdinaryIncomeDollars` so the per-path federal/IRMAA tax + the MagiRing
   * see it, mirroring the deterministic `magiBuffer` replacement. Default 0.
   */
  readonly additionalOrdinaryIncomeDollars?: number;
  /** Prior-year portfolio nominal balance (retained for non-RMD callers /
   *  diagnostics; the RMD floor no longer reads it — see `priorPreTaxByOwner`). */
  readonly priorBalance: number;
  /**
   * Per-owner prior-year-end PRE-TAX (RMD-eligible) sub-bucket
   * total, in INTEGER CENTS, keyed by member id. REQUIRED: feeds
   * `computeMcRmdFloorCents` (the per-owner RMD floor) rather than a
   * whole-portfolio synthetic floor. MIXED accounts contribute only their
   * pre-tax sub-bucket (SECURE 2.0 §325); Roth / brokerage / HSA contribute 0.
   * An empty map yields a $0 floor (no pre-tax balance → no RMD). Required (not
   * optional) so a forgetful call site is a TypeScript compile error rather than
   * a silent reintroduction of a phantom RMD.
   */
  readonly priorPreTaxByOwner: ReadonlyMap<string, number>;
  /**
   * Per-owner IRA-pool RMD offset for the year, in
   * INTEGER CENTS, keyed by member id (`min(Q_owner, gross IRA RMD_owner)`).
   * Threaded from the strategy run's stamped `DrawdownYear.qcdRmdOffsetCentsBy-
   * Owner`. Subtracted from each owner's `computeMcRmdFloorCents` floor so a QCD
   * that satisfied the IRA RMD does NOT re-gross-up as phantom taxable income.
   * Absent → no QCD (the floor is the plain per-owner sum).
   */
  readonly qcdRmdOffsetCentsByOwner?: ReadonlyMap<string, number>;
  /**
   * The MC QCD income-exclusion seam, in DOLLARS, forwarded to
   * `applyTaxYear` as `qcdIncomeExclusionDollars`. NOT threaded by production
   * callers: the per-path fill + the representative tax-burden post-pass exclude
   * the gift EXACTLY ONCE — structurally (the strategy replay debits it from the
   * IRA balance without recording it as a taxable pre-tax withdrawal, so
   * `classification.preTaxDollars` already excludes it) plus the offset-reduced RMD
   * floor (`qcdRmdOffsetCentsByOwner`), mirroring the deterministic engine, which
   * never sets it. Setting it again would double-exclude. Retained as
   * an explicit arg only so focused unit tests can exercise `applyTaxYear`'s clamp
   * seam directly. Default 0 (no QCD).
   */
  readonly qcdIncomeExclusionDollars?: number;
  /** MAGI from two years prior for IRMAA look-back. Undefined → skip IRMAA. */
  readonly magiMinus2: number | undefined;
  /** The returns filed two years ago, one entry per tax unit. Each of
   *  this year's returns reads its OWN look-back out of this list rather than
   *  sharing one household MAGI + one tier schedule. Absent → the scalar
   *  `magiMinus2` household look-back (bootstrap years / single-return runs). */
  readonly irmaaLookbackUnitsMinus2?: readonly FilingUnitMagi[];
  /**
   * Per-account withdrawal classification for the year. Buckets sum to
   * the year's net portfolio withdrawal. When omitted, the whole drawdown is
   * treated as pre-tax (conservative fallback).
   */
  readonly classification?: McWithdrawalClassification;
  /**
   * This path's cumulative §408A Roth-IRA basis carrier, seeded
   * at year 0 under the SINGLE aggregate key (`MC_AGGREGATE_ROTH_OWNER_KEY`) with
   * the SUMMED household basis from `taxCtx.rothBasisCentsByOwner` and
   * mutated each simulated year. The household total basis shielded across the
   * path matches the deterministic engine's per-owner total. When omitted (no
   * taxContext basis) the path assesses no Roth ordering.
   */
  readonly rothBasisCarrier?: RothBasisCarrier;
  /**
   * This path's pooled designated-Roth state (§402A(d)(4) pro rata against
   * REMAINING basis, plus the pooled in-plan-rollover recapture lots), seeded once
   * per path by `seedMcDesignatedRothPool` and mutated across its years. Absent →
   * the household records no designated-Roth facts and the designated slice keeps
   * the all-IRA shape.
   */
  readonly designatedRothPool?: McDesignatedRothPool;
  /**
   * The designated-Roth pocket balance at the START of this year, in
   * dollars: the §402A(d)(4) pro-rata DENOMINATOR. Supplied by callers that can
   * join the ledger to per-account balances (the strategy tax fill, the
   * representative display post-pass); absent → the pool's own running balance,
   * which the no-ledger kernel fallback has to use.
   */
  readonly designatedRothPoolBalanceDollars?: number;
  /**
   * Precomputed survivor state for this year, tri-state:
   * absent (`undefined`) = derive in-function via `deriveMcSurvivors`
   * (keeps every direct-call unit test bit-identical);
   * present-`null` = precomputed "nobody alive" → short-circuit to `null`
   * exactly like a derived null; present-object = use as-is (read-only,
   * shared across paths by `buildSurvivorStatesByYear`).
   */
  readonly survivorState?: McSurvivorState | null;
  /**
   * Brokerage-like (POST_TAX `BROKERAGE`/`OTHER`) balance at
   * the START of the tax year, in dollars: the annual assumed-yield tax-drag
   * base. Produced by `advanceMcTaxableIncomeState` (the shared
   * `advanceBrokerageLikeBasis` accumulator) and threaded ONLY by the
   * representative DISPLAY tax post-pass (`applyMcTaxToRepresentativeYears`) —
   * the FUNDED per-path tax deliberately omits it, mirroring the deterministic
   * funding solver's documented pre-commit approximation so the two engines'
   * funded balances stay in parity. Absent → 0 (no yield drag).
   */
  readonly brokerageLikeStartBalanceDollars?: number;
  /**
   * The withdrawal-weighted PRE-withdrawal cost-basis
   * fraction evolved by the shared `advanceBrokerageLikeBasis` accumulator.
   * When present it REPLACES the static `taxCtx.assumedCostBasisFraction`;
   * absent → the static fraction (the funded per-path tax + callers without
   * per-account year data — the shared documented approximation).
   */
  readonly costBasisFraction?: number;
  /**
   * Annual ordinary taxable interest from cash-like POST_TAX balances
   * (savings/money-market/CD realized growth; HSA excluded — tax-free), in
   * dollars. Derived by the SAME `computeCashLikeInterestDollars` helper the
   * deterministic post-pass uses; threaded only by the representative display
   * post-pass (see `brokerageLikeStartBalanceDollars`). Absent → 0.
   */
  readonly cashInterestDollars?: number;
}

// ---------------------------------------------------------------------------
// Representative-display taxable-income state (yield base, evolving cost
// basis, cash interest), shared verbatim with the deterministic engine's
// helpers. Consumed ONLY by the representative display post-pass
// (`monte-carlo-tax-burden.ts`); the funded per-path loop deliberately omits
// these inputs (cross-engine funded parity).
// ---------------------------------------------------------------------------

/** One MC account's year row for the taxable-income advance: the ledger tax
 *  metadata joined to the year's start/end/withdrawn/deposit dollars. */
export interface McTaxableIncomeYearAccount extends TaxableAccountYearRow {
  readonly taxTreatment: AccountTaxTreatment | undefined;
  readonly accountType: AccountType | undefined;
}

/** The three per-year taxable-income inputs for `buildMcTaxYearInput`. */
export interface McTaxableIncomeYearInputs {
  readonly brokerageLikeStartBalanceDollars: number;
  readonly costBasisFraction: number;
  readonly cashInterestDollars: number;
}

/** Fresh brokerage basis state for one representative display post-pass
 *  (`applyMcTaxToRepresentativeYears` — the accumulator's only MC consumer;
 *  the funded per-path fill never runs it). The post-pass walks years from 0,
 *  so the accumulator lives exactly one pass (mirrors the deterministic
 *  post-pass, which seeds one accumulator per run). */
export function newMcBrokerageBasisState(taxCtx: McTaxContext): BrokerageLikeBasisState {
  return {
    basisByAccountId: new Map<string, number>(),
    seedBasisFraction: taxCtx.assumedCostBasisFraction ?? 0.5,
  };
}

/**
 * Advance one representative-display year's taxable-income state: split
 * the per-account rows into the brokerage-like yield/basis set and the
 * cash-like interest set with the SAME predicates the deterministic engine
 * uses, run the SHARED `advanceBrokerageLikeBasis` accumulator (yield base
 * + evolving pre-withdrawal basis fraction; mutates `basisState`), and
 * derive the year's cash-like ordinary interest via the SHARED
 * `computeCashLikeInterestDollars`. One code path for both engines — the
 * sale/basis approximation cannot fork. Called ONLY from the representative
 * display post-pass (`applyMcTaxToRepresentativeYears`); the funded per-path
 * loop never runs it.
 *
 * Accounts with missing tax metadata are skipped (they classify all-pre-tax
 * upstream — the same conservative fallback).
 */
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

/**
 * Apply all five tax engines for one year on a Monte Carlo path.
 * Returns null when the year is before retirement (no tax estimation)
 * OR when no household members are alive in the year.
 *
 * Filters members by per-year alive-state derived from
 * `primaryDeathYear` / `secondaryDeathYear`; recomputes filing status,
 * household size, and the age-65 taxpayer count against only the
 * survivors. Skips the year entirely when zero members are alive
 * (mirrors the deterministic post-pass guard).
 *
 * Routes the year's withdrawal per account via `classification`
 * (pre-tax / Roth / taxable-non-Roth / cash-like). Roth + cash-like dollars
 * carry no taxable income. When `classification` is omitted the whole net
 * drawdown is treated as pre-tax (conservative fallback). Returns
 * `taxCashflowDollars` (the same-year tax the portfolio must fund) so the
 * caller can subtract it from path balances.
 */
export function applyPerYearTaxForPath(args: PerYearTaxArgs): McTaxYearResult | null {
  return applyPerYearTaxForPathWithConversion(args)?.result ?? null;
}

/**
 * Split the per-year tax compute so a Fill-mode Roth conversion's same-year
 * tax is not funded twice. The strategy MC path funds the conversion's same-year
 * incremental ordinary-income tax via the ENGINE (`fundConversionTaxForYear`
 * drawing from MAGI-neutral post balances), so the expense-fold funded tax MUST
 * be computed WITHOUT the current year's conversion in the current year's ordinary
 * income — but the per-path MAGI ring sample MUST stay conversion-INCLUSIVE so the
 * conversion's Y+2 IRMAA look-back is funded (mirrors the deterministic
 * `magiBuffer` replacement). Returns:
 *   - `result`: the WITHDRAWALS-ONLY funded tax result (the IRMAA look-back via
 *     `args.magiMinus2` is intact, so a PRIOR year's conversion that landed in the
 *     Y-2 ring still drives — and funds — this year's surcharge); and
 *   - `magiInclusiveDollars`: the conversion-INCLUSIVE MAGI for advancing the ring.
 * When `additionalOrdinaryIncomeDollars` is 0 (the kernel path) the inclusive MAGI
 * equals the funded result's MAGI, so callers can advance the ring identically.
 */
export function applyPerYearTaxForPathWithConversion(
  args: PerYearTaxArgs,
): { result: McTaxYearResult; magiInclusiveDollars: number } | null {
  const { taxCtx, taxYear, retirementYear, grossSsDollars } = args;
  const { otherIncome, classification } = args;

  if (taxYear < retirementYear) return null;

  // Survivor-state tri-state: absent → derive; present
  // (object or null) → use as-is, never re-derived.
  const survivorState =
    args.survivorState !== undefined
      ? args.survivorState
      : deriveMcSurvivors(taxCtx, taxYear, retirementYear);
  if (survivorState === null) return null;

  // The windowed nominal expense for this year (path-CPI applied upstream).
  const nominalExpense = args.nominalExpense;
  // Net portfolio drawdown: expense net of SS and other income.
  const drawdown = Math.max(0, nominalExpense - grossSsDollars - otherIncome);
  // Per-account routing. Fallback (no classification) → all-pre-tax.
  const preTaxWithdrawalDollars = classification?.preTaxDollars ?? drawdown;

  // Mirror of the deterministic engine: the pre-59½ Roth earnings excess
  // (owner-aggregated cumulative basis, carrier) is ordinary income this year;
  // fold it into the year's other ordinary income before the tax engines run.
  // Mutates the carrier EXACTLY ONCE — the conversion-inclusive MAGI re-uses
  // this same excess (it is conversion-independent), so neither tax build
  // re-consumes Roth basis.
  const rothEarnings = applyMcRothBasisOrdering(args);

  // The FUNDED same-year tax excludes the current year's conversion from
  // current-year ordinary income (the engine funds it separately). Build the
  // tax input WITHOUT `additionalOrdinaryIncomeDollars`.
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

  // Mirror of the deterministic engine: assess the early-withdrawal / HSA /
  // Roth-earnings penalty per path against the same-year committed buckets,
  // reducing this path's balance by the funded penalty (added to
  // `taxCashflowDollars`).
  const penaltyDollars = computeMcPenaltyDollars(
    args,
    survivorState,
    rothEarnings.additionalTaxBaseDollars,
  );

  const result = assembleMcTaxResult(taxResult, drawdown, penaltyDollars);

  // The ring sample is conversion-INCLUSIVE so Y+2 IRMAA is funded. With no
  // conversion this is the funded MAGI; with a conversion, recompute MAGI on the
  // conversion-inclusive input (re-using the carrier-mutated Roth excess, so the
  // carrier is not touched again).
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
 * Apply the per-path FACT-BASED §408A / §402A Roth ordering (mirrors the
 * deterministic engine).
 *
 * The MC kernel collapses the household into one synthetic Roth pool, so the
 * per-account fidelity the deterministic engine has is out of reach here. What
 * this makes right is the SHAPE of both regimes (rather than one
 * contribution-first bucket seeded from at-retirement BALANCES):
 *
 *  1. The ROTH-IRA slice (`profile.iraShareOfOrderedPool` of the ordered draw)
 *     runs the genuine §408A order against the aggregate carrier — recorded
 *     regular-contribution basis, then conversion lots FIFO aggregated by tax year
 *     with their own five-tax-year recapture clocks, then earnings. This is the
 *     SAME `applyFactBasedRothIraOrdering` the deterministic engine calls, so the
 *     two cannot drift.
 *  2. The DESIGNATED-ROTH slice runs the SAME stateful
 *     `applyFactBasedDesignatedRothDistribution` the deterministic engine calls,
 *     against ONE pooled synthetic account (`McDesignatedRothPool`): pro rata
 *     basis/earnings per §402A(d)(4) against the pool's REMAINING basis and its
 *     running balance, with the pooled in-plan-rollover lots' own
 *     §402A(c)(4)(D) recapture windows. Because the state is carried, the pool's
 *     LIFETIME basis shelter is capped at the household's recorded designated basis
 *     — a stateless frozen-fraction split would re-apply the same fraction
 *     to every future withdrawal and could shelter multiples of it.
 *
 * The 59½ qualifying-event test is PER INDIVIDUAL, so when the profile names the
 * contributing owners (`rothOwnerIds`) the pooled test requires EVERY one of them
 * to have reached 59½ for the whole year; otherwise it falls back to the primary
 * member (the household-aggregate stance for a fact-free household).
 *
 * With no profile the whole ordered draw runs the Roth-IRA path against whatever
 * aggregate basis was seeded, so a household with no recorded facts is
 * unaffected in shape.
 *
 * Only `rothBasisOrderedDollars` flows through ordering; the
 * wholesale-tax-free bucket (`rothWholesaleTaxFreeDollars`) never hits the carrier
 * (it carries no recoverable basis in this model). Mutates the carrier + pool.
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
    // The pro-rata DENOMINATOR is the pool's balance at the time of THIS draw:
    // the year's actual designated-Roth pocket when the caller can supply it (the
    // strategy path joins the ledger to its per-account start buckets), else the
    // running pooled balance the pool itself carries. Never below the draw, so the
    // basis fraction can never exceed 1.
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

/**
 * The whole-year 59½ test for the MC pooled Roth bucket.
 *
 * §72(t)/§408A(d)(2) age-59½ is a PER-INDIVIDUAL qualifying event, and the pooled
 * bucket mixes every contributing owner's dollars with no attribution at
 * withdrawal time, so the pooled test requires EVERY contributing owner
 * (`profile.rothOwnerIds`) to have reached 59½ for the whole year. Without that
 * list (a fact-free household) it keeps the primary-member test, matching
 * `computeMcPenaltyDollars`. Conservative whole-year boundary — see
 * `ownerReached59HalfForWholeYear` in the deterministic carrier.
 */
function mcRothOwnersReached59Half(taxCtx: McTaxContext, taxYear: number): boolean {
  const reached = (birthdate: string | undefined): boolean =>
    penaltyFractionForYear(birthdate, taxYear, { ageYears: 59, ageMonths: 6 }) === 0;
  const ownerIds = taxCtx.rothOrderedProfile?.rothOwnerIds;
  if (ownerIds === undefined || ownerIds.length === 0) {
    return reached(taxCtx.members[0]?.isoBirthdate);
  }
  return ownerIds.every((ownerId) => {
    const member = taxCtx.members.find((m) => m.memberId === ownerId);
    // An owner with no member metadata cannot be shown to have reached 59½ →
    // conservative NOT reached (the distribution stays nonqualified/penalized).
    return member !== undefined && reached(member.isoBirthdate);
  });
}

/**
 * The MC per-path pooled designated-Roth state: the SHARED mutable carrier
 * entry the deterministic engine uses (one synthetic pooled "account") plus the
 * running pooled balance that serves as the §402A(d)(4) pro-rata denominator when
 * the caller cannot supply the year's real pocket balance.
 *
 * Seeded per path, mutated in place across the path's years, so the pool's basis
 * (and each in-plan-rollover lot's remaining principal) is consumed exactly once
 * over the whole projection.
 */
export interface McDesignatedRothPool {
  readonly entry: MutableDesignatedRothAccountEntry;
  balanceRemainingCents: number;
}

/**
 * The household's designated-Roth pocket balance in DOLLARS from per-account
 * start balances: the §402A(d)(4) pro-rata denominator for the pooled MC slice.
 *
 * Mirrors `buildMcRothOrderedProfile`'s pool composition exactly: a PURE Roth
 * employer account contributes its whole balance; a MIXED Roth-designated account
 * contributes only its POST (Roth-designated) sub-bucket. Every other account
 * contributes nothing. Supplying the year's real balance is what makes the
 * pro-rata fraction shrink as the pocket grows, instead of freezing at a
 * point-in-time snapshot.
 */
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

/**
 * Seed one MC path's pooled designated-Roth state from the fact-based profile.
 * Returns `undefined` when the household records no designated-Roth facts at all
 * (no pool → the designated slice is left to the Roth-IRA path, so a fact-free
 * household is unaffected).
 */
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

/**
 * Credit a year's Fill-mode Roth-conversion principal to the MC aggregate §408A
 * basis carrier (MC mirror of `creditRothConversionToBasisCarrier`). A
 * converted dollar was already taxed as ordinary income in the conversion year,
 * so it becomes tax/penalty-free contribution-style basis the household can
 * later withdraw ahead of earnings. The MC kernel has no per-owner detail at
 * withdrawal time, so the credit lands on the SINGLE aggregate entry
 * (`MC_AGGREGATE_ROTH_OWNER_KEY`) the path seeds and consumes against.
 * MUST run AFTER `applyMcRothBasisOrdering` for the same year: the converted
 * dollars land at year-END, so they are basis only for LATER years' Roth
 * withdrawals, never the same year's (crediting first would wrongly shield the
 * same year's withdrawal). No-op when no conversion occurred. */
/** Append/merge a DATED conversion lot on the MC aggregate carrier entry,
 *  mirroring the deterministic `creditConversionLot`: same-year credits merge, the
 *  list stays ascending by tax year (the FIFO order the ordering engine expects),
 *  and the count is bounded — at the cap the credit merges into the NEWEST lot,
 *  which keeps the longest remaining recapture window (never waives recapture). */
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

/** The MC mirror of the deterministic carrier's conversion-lot cap. */
const MC_MAX_CARRIER_CONVERSION_LOTS = 200;

/** Structural shape of one mutable conversion lot on the carrier entry (the
 *  carrier's own interface is module-private in the deterministic engine). */
interface MutableMcConversionLot {
  readonly taxYear: number;
  taxableRemainingCents: number;
  nontaxableRemainingCents: number;
}

export function creditMcConversionToBasisCarrier(
  carrier: RothBasisCarrier,
  convertedCents: number,
  /** The conversion tax year. Supplied → the principal is credited as a
   *  DATED conversion lot carrying its own five-taxable-year §408A(d)(3)(F)
   *  recapture window (matching the deterministic engine). Omitted → an
   *  undated regular-basis credit, kept for direct unit-test callers. */
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

/** Compute the per-path early-withdrawal / HSA / Roth-earnings penalty for the
 *  year (mirrors the deterministic engine). Uses the aggregate classification
 *  buckets attributed to
 *  the primary survivor's birthdate (the MC household-aggregate stance — the MC
 *  kernel has no per-account owner/birthdate detail). The Roth penalty basis is
 *  the earnings excess from `applyMcRothBasisOrdering`.
 *
 *  A real exempt account id can never match the
 *  synthetic `mc-pretax` / `mc-roth` ids, so the exemption is resolved upstream
 *  and arrives here on two channels:
 *
 *  1. **Per-source dollars (primary channel).** `classifyMcWithdrawal`
 *     preserves withdrawal provenance into
 *     `classification.preTaxPenaltyExemptDollars` /
 *     `rothOrderedPenaltyExemptDollars` (scenario-marked OR statutorily
 *     penalty-free at the source — the governmental 457(b)). The §72(t) leg
 *     penalizes only `preTaxDollars − preTaxPenaltyExemptDollars`; the Roth
 *     leg prorates the aggregate earnings excess by the year's non-exempt share
 *     of the ordered draw (the pooled §408A carrier cannot attribute earnings
 *     per account, so proration is the documented apportionment). A mixed
 *     457(b)+IRA pool therefore penalizes only the IRA-sourced portion,
 *     matching the deterministic per-account engine.
 *  2. **Whole-leg waiver flags (retained fallback).**
 *     `taxCtx.mcPreTaxPenaltyAllExempt` / `mcRothPenaltyAllExempt` (pre-resolved
 *     in `buildMcTaxContext`) waive an entire leg via the engine's exempt set —
 *     load-bearing for classifications built WITHOUT per-source exemption info
 *     (hand-rolled fixtures, the all-pre-tax fallback), where the per-source
 *     dollars default to 0 (fully penalized).
 *
 *  The ordinary-income tax on the Roth earnings tranche (routed upstream) is
 *  unaffected by either channel. Returns dollars (0 when no penalizable
 *  basis). */
export function computeMcPenaltyDollars(
  args: PerYearTaxArgs,
  survivorState: McSurvivorState,
  /** The §408A/§402A ADDITIONAL-TAX BASE for the year (earnings plus
   *  in-window conversion / in-plan-rollover recapture, with the source-level
   *  governmental-457(b) carve-out already applied by the ordering engine), NOT the
   *  raw earnings figure. `applyMcRothBasisOrdering` returns it as
   *  `additionalTaxBaseDollars`. */
  rothAdditionalTaxBaseDollars: number,
): number {
  const { taxCtx, taxYear, classification } = args;
  const primary = survivorState.survivors[0];
  if (primary === undefined) return 0;
  // The synthetic-bucket ids; waive a leg by marking its synthetic id
  // exempt when ALL of that bucket's real accounts are exempt (resolved upstream).
  const exemptAccountIds: string[] = [];
  if (taxCtx.mcPreTaxPenaltyAllExempt) exemptAccountIds.push('mc-pretax');
  if (taxCtx.mcRothPenaltyAllExempt) exemptAccountIds.push('mc-roth');
  const accounts: PenaltyAccountInput[] = [];
  // Penalize only the non-exempt-source portion of the pooled pre-tax draw.
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
  // The §408A/§402A additional-tax base arrives SOURCE-RESOLVED, so it is
  // never PRORATED again. Scaling it by the pool's non-exempt WITHDRAWAL share
  // would prorate it a SECOND time: in a mixed IRA + governmental-457(b) pool that
  // would discount genuine IRA conversion recapture merely because some unrelated
  // 457(b) dollars were also drawn that year. The exemption is ALL-OR-NOTHING,
  // mirroring how the ordering engine itself treats the pooled designated slice
  // (`designatedAllGovernmental457b`): the pooled base cannot attribute a dollar to
  // a source, so it is waived only when EVERY source of the year's ordered draw is
  // exempt (a purely governmental-457(b) / scenario-exempt draw genuinely owes no
  // 10%), and charged IN FULL otherwise — the conservative direction, and the only
  // one that cannot silently drop a legitimate recapture.
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
      // The base already resolved every source-level exemption, so the
      // penalty engine must not re-test the synthetic account type.
      rothOrderedAdditionalTaxBase: true,
    });
  }
  // HSA additional tax: the cash-like bucket carries HSA principal; the 20%
  // pre-65 tax applies to the nonqualified fraction. The MC synthetic pool has
  // no emergency-HSA-qualified% input (defaults to 100% qualified → $0), so the
  // HSA leg is a documented MC no-op unless a future emergency-HSA-qualified%
  // is threaded. NOTE: that setting governs only the EMERGENCY-reserve HSA draw
  // — modeled medical-qualified withdrawals are always 100% qualified — so any
  // future MC implementation must preserve that medical-first / emergency split
  // rather than applying the percentage to all HSA withdrawals.
  if (accounts.length === 0) return 0;
  const penalty = computeEarlyWithdrawalPenalty(accounts, taxYear, exemptAccountIds);
  return penalty.penaltyDollars;
}

/** Per-year survivor set + resolved filing facts, derived from projected death
 *  years and the scenario's filing plan. `null` when zero members
 *  are alive in the year. */
export interface McSurvivorState {
  readonly survivors: TaxMemberInput[];
  /** The status the year's return is filed under: the resolved single tax
   *  unit's status, the first unit's status in a `separate` year, or the
   *  scalar derivation when the plan could not be resolved. */
  readonly filingStatus: FilingStatus;
  /** The year's resolved tax units, or `undefined` when the legacy scalar
   *  could not be converted (the year then keeps the single-status
   *  path and the scenario editor prompts for a resolution). */
  readonly taxUnits?: readonly ResolvedTaxUnit[];
  /** Household role → member id, so a unit's roles map onto `survivors`. */
  readonly memberIdByRole?: { readonly primary?: string; readonly secondary?: string };
  /** §86(c)(1)(C)(ii) — MFS spouses lived together during the year. */
  readonly mfsLivedWithSpouse?: boolean;
  /** The filing status of the return IRMAA's two-year look-back reads. */
  readonly irmaaLookbackFilingStatus?: FilingStatus;
  readonly irmaaLookbackMfsLivedWithSpouse?: boolean;
  /** The returns the household filed two years ago when that year had
   *  MORE THAN ONE (a separate-filing couple). Used only in the BOOTSTRAP years,
   *  where the per-return MAGI ring has no entry yet: pairing these with the
   *  household bootstrap MAGI keeps each spouse on their own IRMAA schedule
   *  instead of collapsing both onto the first spouse's, matching every later
   *  year and the deterministic engine. */
  readonly bootstrapLookbackUnits?: readonly BootstrapLookbackUnit[];
  /** Survivor ids that attain age 65 by year end (IRS born-Jan-1 rule). */
  readonly age65PlusMemberIds?: readonly string[];
}

/** Resolve the filing plan for one calendar year from the MC tax context. Pure
 *  and engine-free (no calibration lookups), so it is safe to call for both the
 *  projection year and its IRMAA look-back year. */
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

/** The look-back year's returns, keyed by REAL member id, when that year
 *  had more than one. `undefined` for a single-return look-back: the scalar
 *  `irmaaLookbackFilingStatus` already says the same thing for that case. */
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

/**
 * THIS member's own separation-from-service year.
 *
 * Falls back to the household scalar (`MonteCarloInput.retirementYear`, which
 * IS the primary's retirement year) whenever the context carries no per-member
 * table — a same-date household, or a legacy serialized input. A staggered
 * household carries one entry per member, so MC gates each member's automatic
 * Marketplace months on the year THEY stop working, exactly as the
 * deterministic `buildMemberInputs` does.
 *
 * The table is at most two entries (one household), so the linear scan costs
 * nothing; `deriveMcSurvivors` is itself precomputed once per year per run.
 */
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

/** Derive the year's survivors (with Medicare/ACA flags) + resolved filing
 *  facts from per-year alive-state. Returns `null` when no member is alive (the
 *  caller skips the year). Extracted from `applyPerYearTaxForPath` to keep each
 *  function short.
 *
 *  Also resolves the year's tax units and the IRMAA two-year look-back
 *  status. Both resolutions are pure, and this function is precomputed ONCE per
 *  year per run (`buildSurvivorStatesByYear`), so the per-path hot
 *  loop pays nothing for them. */
export function deriveMcSurvivors(
  taxCtx: McTaxContext,
  taxYear: number,
  /** The HOUSEHOLD retirement year (the primary's). Each member's own year is
   *  resolved from `taxCtx.retirementYearByMember` when the household staggers;
   *  this stays the fallback for every member without an entry. */
  retirementYear: number,
): McSurvivorState | null {
  // Per-year alive-state.
  const primaryAlive =
    taxCtx.primaryDeathYear === undefined || taxYear <= taxCtx.primaryDeathYear;
  const secondaryAlive =
    taxCtx.members.length > 1 &&
    (taxCtx.secondaryDeathYear === undefined || taxYear <= taxCtx.secondaryDeathYear);

  // Build per-year member flags from survivors only. The ACA opt-out set gates
  // `hasAcaCoverage` per member — built once here from the raw id array so
  // the per-member identity (which the pooled penalty template loses) is honored.
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
  // IRMAA is tiered on the return filed TWO YEARS AGO, so resolve that
  // year's plan too rather than reusing the current year's status.
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
    // Keep the look-back year's returns individually addressable for the
    // bootstrap years (see `bootstrapLookbackRing`).
    bootstrapLookbackUnits: mcBootstrapLookbackUnits(taxCtx, lookback),
    age65PlusMemberIds: survivors
      .filter((m) => hasAttainedAgeByYearEnd(m.isoBirthdate, taxYear, 65))
      .map((m) => m.memberId),
  };
}

/**
 * Split the year's household gross Social Security across the two
 * spouses by the caller-supplied per-year share, so each `separate` return runs
 * §86 on its OWN benefit (§86 is non-linear per return, so an even split gives
 * a materially different taxable-SS figure than the deterministic engine's
 * per-recipient attribution).
 *
 * @returns `memberId → own gross SS dollars`, or `undefined` when the context
 *          carries no share table (one-member households, no SS, or a legacy
 *          serialized input) — the caller then falls back to the even split,
 *          which is inert for every single-return year.
 */
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

/** Birth year from an ISO birthdate, or `undefined` when unparseable. */
function mcBirthYearOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const y = parseInt(iso.slice(0, 4), 10);
  return Number.isNaN(y) ? undefined : y;
}

/** Precompute per-run survivor states for every year offset
 *  `[0, horizonYears)` from `firstYear`. Pure function of
 *  `(taxCtx, retirementYear)`, so seed-independent and safe to compute ONCE
 *  per run and share (read-only) across every path — a loop over
 *  `deriveMcSurvivors`, which stays exported as the per-call fallback. Index
 *  `i` corresponds to calendar year `firstYear + i`; `null` = nobody alive
 *  that year. */
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

/** Per-owner RMD floor (in CENTS) for a Monte Carlo path-year.
 *
 *  Unlike a whole-portfolio synthetic floor, which treated the
 *  ENTIRE prior-year portfolio as one pre-tax IRA, so Roth / brokerage / HSA
 *  balances inflated the RMD income on Roth-heavy or all-taxable households. This
 *  floor reads the per-owner PRE-TAX (RMD-eligible) sub-bucket total only — built
 *  by the strategy runner from real per-account balances (MIXED accounts
 *  contribute only their pre-tax sub-bucket per SECURE 2.0 §325; Roth, brokerage,
 *  HSA contribute 0).
 *
 *  Per owner: when the owner has reached their SECURE 2.0 §107 trigger age in the
 *  tax year, floor = preTaxCents / uniformLifetimeDivisor(age). The household
 *  floor is the SUM over owners (NOT a MAX over a shared pool) — each owner's RMD
 *  applies independently to their own pre-tax accounts. A below-trigger or
 *  already-deceased owner (absent from `survivors`) contributes 0.
 *
 *  Mechanism: a per-owner synthetic PRE_TAX account carrying that owner's pre-tax
 *  dollars is fed through the shared `computeRmdFloorCents`, which scopes accounts
 *  by `ownerId` and SUMS each member's `ownerRmdCents` — so this stays the SAME
 *  divisor + trigger-age + Uniform-Lifetime seam the deterministic engine uses
 *  (no duplicated math).
 *
 *  @param priorPreTaxByOwner owner memberId → prior-year-end pre-tax cents.
 *  @param survivors surviving members for the year (ages drive the per-owner floor).
 *  @param taxYear the tax year the floor applies to.
 *  @param rmdSnapshot the RMD calibration the floor engine reads divisors from.
 *  @returns the per-owner SUM of RMD floors in CENTS (0 if none RMD-age / no pre-tax).
 *  @throws surfaces whatever the underlying `computeRmdFloorCents` throws. */
export function computeMcRmdFloorCents(
  priorPreTaxByOwner: ReadonlyMap<string, number>,
  survivors: readonly TaxMemberInput[],
  taxYear: number,
  rmdSnapshot: TaxCalibrationBundle['rmd'],
  rmdOffsetCentsByOwner?: ReadonlyMap<string, number>,
): number {
  // QCD: a Qualified Charitable Distribution counts toward the owner's
  // IRA-pool RMD, so it reduces the TAXABLE RMD floor by `min(Q, gross IRA RMD)`.
  // To keep the per-owner SUM honest (each owner's floor reduced by ONLY their
  // own offset, never crossing owners) the floor is computed per owner — one
  // synthetic account at a time — and clamped ≥ 0 after subtracting that owner's
  // offset. With no offset map this is exactly the plain per-owner sum.
  let totalCents = 0;
  for (const survivor of survivors) {
    const preTaxCents = priorPreTaxByOwner.get(survivor.memberId) ?? 0;
    // This owner's ALREADY-RESOLVED fact-based required withdrawal (the
    // accounts whose recorded facts took them out of the pooled Uniform-Lifetime
    // basis: inherited beneficiary schedules, Table II, deferrals, withheld
    // results). It is a required amount, not a balance, so it is added to the
    // owner's floor rather than divided again, and the owner's QCD offset still
    // reduces the combined figure exactly once.
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
        // `withdrawalDollars` is a placeholder (computeRmdFloorCents ignores it —
        // the floor reads only the prior-year balance, owner, and tax treatment).
        withdrawalDollars: 0,
      },
    ];
    // computeRmdFloorCents gates the owner by their own SECURE 2.0 trigger age —
    // a below-trigger owner yields 0 (their QCD offset then has nothing to
    // reduce, leaving 0, the 70½–72 pre-RMD case).
    const ownerFloor =
      computeRmdFloorCents([survivor], accounts, taxYear, rmdSnapshot) + factRequiredCents;
    const offset = rmdOffsetCentsByOwner?.get(survivor.memberId) ?? 0;
    totalCents += Math.max(0, ownerFloor - Math.max(0, offset));
  }
  return totalCents;
}

/** Minimal ledger-entry shape the per-owner pre-tax map-builder reads. A
 *  structural subset of `MonteCarloAccountLedger` (avoids a type cycle). */
export interface McPreTaxLedgerEntry {
  readonly id: string;
  readonly taxTreatment?: AccountTaxTreatment;
  readonly accountType?: AccountType;
  readonly ownerId?: string;
}

/** Build the per-owner year-END PRE-TAX (RMD-eligible) sub-bucket totals (cents),
 *  indexed by `ownerIds` position.
 *
 *  For each ledger account joined to its captured year-end `accountBalances` row:
 *  when the account QUALIFIES for RMD (`isQualifyingAccount` — traditional IRA,
 *  401k/403b/457b/TSP PRE_TAX or MIXED, RETIREMENT_CASH_BALANCE PRE_TAX or MIXED),
 *  add its `preEnd` (the pre-tax sub-bucket) to its owner's total. `preEnd` is
 *  ALREADY the pre-tax pocket — `postEnd` holds the MIXED Roth-designated portion
 *  (RMD-exempt, SECURE 2.0 §325) and is never counted. Roth IRA / Roth-designated
 *  / brokerage / HSA / cash accounts are non-qualifying, so they contribute 0.
 *  An account with no `ownerId` buckets under its own id (= its own owner); a row
 *  for an owner not in `ownerIds` is dropped (no slot). Returns an array of length
 *  `ownerIds.length` (all zero when no qualifying balance). */
export function buildPreTaxCentsByOwnerIdx(
  accountBalances: ReadonlyMap<string, DrawdownAccountYear> | undefined,
  ledger: ReadonlyArray<McPreTaxLedgerEntry>,
  ownerIds: ReadonlyArray<string>,
  /**
   * Per-account RMD profile facts. Any account that carries facts leaves
   * this pooled per-owner Uniform-Lifetime basis entirely: a pooled owner divisor
   * cannot express an inherited beneficiary schedule (Table I stretch / 10-year /
   * 5-year), a Table II sole-spouse divisor, a year-scoped §401(a)(9)(C)
   * still-working deferral, a first-year April-1 deferral, or a WITHHELD result.
   * Those accounts are instead resolved per account through the shared
   * `computeRmd` engine (`buildMcFactRmdRequiredCentsByOwnerIdx`) and arrive at the
   * floor as already-required cents, so nothing is dropped and nothing is
   * double-counted. Absent → every qualifying account counts.
   */
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
    // Fact-carrying accounts are handled by the shared per-account engine (see
    // the parameter doc) — never pooled here, so no year context is needed.
    if (rmdFactsByAccountId?.[entry.id] !== undefined) continue;
    const row = accountBalances.get(entry.id);
    if (row === undefined) continue;
    // `preEnd` is the pre-tax sub-bucket (post = Roth-designated, §325-exempt).
    const preTaxCents = Math.round(row.preEnd * 100);
    if (preTaxCents <= 0) continue;
    const ownerId = entry.ownerId ?? entry.id;
    const slot = slotByOwner.get(ownerId);
    if (slot === undefined) continue;
    idx[slot] += preTaxCents;
  }
  return idx;
}

/** Convert a `preTaxCentsByOwnerIdx` array back into the `priorPreTaxByOwner`
 *  map (owner memberId → cents) `computeMcRmdFloorCents` consumes.
 *  `ownerIds[i]` is the member id for index `i`. A missing / short array yields
 *  an empty map (→ $0 floor). */
export function buildPriorPreTaxByOwnerFromIdx(
  preTaxCentsByOwnerIdx: readonly number[] | undefined,
  ownerIds: ReadonlyArray<string>,
  /**
   * The companion per-owner FACT-BASED required-withdrawal cents
   * (`DrawdownYear.factRmdRequiredCentsByOwnerIdx`), already resolved through the
   * shared `computeRmd` engine for the accounts that carry recorded RMD facts
   * (which the pooled basis above deliberately excludes). Carried in the SAME map
   * under a namespaced key (`mcFactRmdRequiredKey`) so every existing per-year
   * plumbing hop — the strategy tax fill, the Fill conversion hook, both
   * expense-fold passes — forwards it unchanged. Absent → no fact-based component.
   */
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

/** The namespaced `priorPreTaxByOwner` key carrying an owner's already-
 *  resolved FACT-BASED required-withdrawal cents. Namespaced with a `::` segment
 *  that a member id cannot contain a collision for, mirroring
 *  `poolKeyForRmdAccount`'s `pool:` / `acct:` discriminants. */
export function mcFactRmdRequiredKey(ownerId: string): string {
  return `${ownerId}::rmdRequiredCents`;
}

/** Build the `priorPreTaxByOwner` map for the NO-LEDGER kernel fallback
 *  (`runOnePathKernel`).
 *
 *  The kernel fallback collapses the whole household to one synthetic pool with
 *  no per-account / per-owner split, so it CANNOT disaggregate Roth / brokerage
 *  from pre-tax — it keeps the documented whole-portfolio approximation. To
 *  fire the floor as soon as ANY survivor is RMD-age,
 *  using the OLDEST RMD-age member's smallest divisor = largest floor, through
 *  the per-owner `computeMcRmdFloorCents` (which SUMS over owners), assign the
 *  WHOLE prior balance to the SINGLE survivor whose age yields the largest floor.
 *  That single-owner map makes the SUM equal the MAX — no double-count for
 *  couples. Production runs always carry a ledger and never reach this path; this
 *  exists only for the no-ledger fallback's RMD floor. */
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

/** Assemble the `applyTaxYear` input for one MC path-year (per-account
 *  routing + a single synthetic pre-tax RMD account). Extracted from
 *  `applyPerYearTaxForPath` to keep each function short.
 *
 *  RMD-floor grossing: the year's *taxable* pre-tax income is
 *  grossed up to `max(actual pre-tax draw, floor)` — mirroring the deterministic
 *  `tax-cashflow-solver`, which forces an RMD-age household's withdrawal up to
 *  the floor. The grossed figure is set on BOTH the top-level
 *  `preTaxWithdrawalDollars` (so MAGI / IRMAA reflect the forced income) AND the
 *  synthetic account's `withdrawalDollars` (so the re-checked floor is inert).
 *  Only the *tax* reflects the grossed figure — the caller keeps `drawdown` /
 *  `netAfterTax` on the actual (un-grossed) draw.
 *
 *  The floor is the PER-OWNER `computeMcRmdFloorCents` over
 *  `args.priorPreTaxByOwner` — the pre-tax (RMD-eligible) sub-bucket per owner,
 *  NOT a whole-prior-portfolio synthetic floor. So a Roth-heavy or
 *  all-taxable household at RMD age sees a $0 floor (no phantom RMD income), and
 *  a couple's floor is the SUM of each owner's individual floor. This aligns the
 *  per-path tax floor with the per-owner representative-display floor.
 *
 *  `floorCentsOverride` still lets the representative-run tax post-pass
 *  (`monte-carlo-tax-burden.ts`) substitute the already-stamped per-owner
 *  `rmdFloorCents` directly. Callers that omit it (the per-path funding solve +
 *  Fill conversion) get the same per-owner floor from `priorPreTaxByOwner`. */
export function buildMcTaxYearInput(
  args: PerYearTaxArgs,
  survivorState: McSurvivorState,
  preTaxWithdrawalDollars: number,
  rothEarningsExcessDollars = 0,
  floorCentsOverride?: number,
): ApplyFilingPlanYearInput {
  const { taxCtx, taxYear, grossSsDollars, otherIncome, priorBalance, magiMinus2 } = args;
  // Attribute gross SS to its recipient so a `separate` couple's two
  // returns each run §86 on their OWN benefit (the deterministic engine does
  // the same; otherwise the two engines would disagree on FUNDED balances).
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
      // QCD: reduce each owner's IRA-pool RMD floor by their QCD offset
      // so the gross-up never re-adds the QCD as phantom taxable income. Inert
      // when a `floorCentsOverride` is supplied (the representative tax post-pass
      // supplies its own offset-aware exclusion alongside the override).
      args.qcdRmdOffsetCentsByOwner,
    );
  const floorDollars = centsToDollars(floorCents);
  const preTaxForTax = Math.max(preTaxWithdrawalDollars, floorDollars);
  // The year's user-stated annual SLCSP benchmark, if any.
  const acaBenchmarkSlcspDollars = taxCtx.acaPtcBenchmark?.find(
    (o) => o.taxYear === taxYear,
  )?.annualSlcspDollars;
  return {
    taxYear,
    // The resolved units drive the per-unit filing; `filingStatus` is the
    // single-unit / unresolved-plan fallback the units short-circuit to.
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
    // QCD: the MC income-exclusion seam. Production callers (the per-path
    // fill + the representative tax-burden post-pass) DO NOT thread this — they
    // exclude the gift EXACTLY ONCE, structurally (the strategy replay debits it
    // from the IRA balance without recording it as a taxable pre-tax withdrawal, so
    // the supplied `classification.preTaxDollars` / grossed `preTaxForTax` already
    // exclude it) plus the offset-reduced RMD floor — mirroring the deterministic
    // engine, which likewise never sets it. Defaulting to 0 here keeps
    // the single exclusion; threading it again would double-exclude. Retained as an
    // explicit arg only so focused unit tests can exercise `applyTaxYear`'s clamp
    // seam directly.
    qcdIncomeExclusionDollars: args.qcdIncomeExclusionDollars ?? 0,
    postTaxNonRothWithdrawalDollars: args.classification?.postTaxNonRothDollars ?? 0,
    postTaxCashLikeWithdrawalDollars: args.classification?.postTaxCashLikeDollars ?? 0,
    // Both Roth sub-buckets are tax-free at the engine level; their
    // earnings excess is threaded separately via `rothEarningsExcessDollars`.
    rothWithdrawalDollars:
      (args.classification?.rothBasisOrderedDollars ?? 0) +
      (args.classification?.rothWholesaleTaxFreeDollars ?? 0),
    // Mirror of the deterministic engine: the pre-59½ Roth earnings excess is
    // ordinary income. A committed Fill-mode Roth conversion
    // (`additionalOrdinaryIncomeDollars`) is ALSO ordinary income — it raises MAGI /
    // federal tax / IRMAA but never offsets the year's spendable expense (so it
    // is added HERE, not via `otherIncome`/the drawdown computation).
    otherOrdinaryIncomeDollars:
      otherIncome + rothEarningsExcessDollars + additionalOrdinaryIncomeDollars,
    taxExemptInterestDollars: 0,
    // The evolved pre-withdrawal basis fraction when the caller
    // ran the shared accumulator; else the static context fraction (the
    // documented approximation for callers without per-account year data).
    assumedCostBasisFraction: args.costBasisFraction ?? taxCtx.assumedCostBasisFraction,
    // The annual assumed-yield tax drag base — the path-year's
    // start-of-year brokerage-like balance. 0 when no per-account data.
    brokerageLikeStartBalanceDollars: args.brokerageLikeStartBalanceDollars ?? 0,
    // Annual cash-like ordinary interest (savings/MM/CD; HSA excluded),
    // shared derivation with the deterministic engine.
    cashInterestDollars: args.cashInterestDollars ?? 0,
    householdSize: survivors.length,
    members: survivors,
    // The grossed pre-tax figure already drives federal tax / MAGI above; the
    // synthetic account is passed only so applyTaxYear's RMD output field is
    // populated (unused by the MC path). Owner is immaterial — the floor was
    // computed externally as the max over survivors; tag it to the first
    // survivor so applyTaxYear's internal per-owner scoping has a valid match.
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
    // Per-return IRMAA look-back (each unit reads its own entry). In
    // the BOOTSTRAP years the ring is still empty, so rebuild it from the
    // look-back year's own returns + the household bootstrap MAGI rather than
    // tiering both spouses on the first spouse's schedule.
    irmaaLookbackUnits:
      args.irmaaLookbackUnitsMinus2 !== undefined && args.irmaaLookbackUnitsMinus2.length > 0
        ? args.irmaaLookbackUnitsMinus2
        : (bootstrapLookbackRing(survivorState.bootstrapLookbackUnits, magiMinus2) ??
          args.irmaaLookbackUnitsMinus2),
    taxpayersAge65Plus: countTaxpayersAge65Plus(survivors, taxYear),
    inflationRatePct: taxCtx.inflationRatePct,
    // The scenario's FPL region + the year's annual SLCSP override
    // reach the MC ACA-PTC block exactly as they reach the deterministic one, so
    // the two engines price the same benchmark against the same poverty line.
    ...(taxCtx.acaFplRegion !== undefined ? { acaFplRegion: taxCtx.acaFplRegion } : {}),
    ...(acaBenchmarkSlcspDollars !== undefined ? { acaBenchmarkSlcspDollars } : {}),
    // ACA-MAGI separation flows through automatically — `applyTaxYear`
    // derives the ACA-specific MAGI (nontaxable SS included) from `grossSsDollars`
    // above, so the MC ACA-PTC path already uses the correct §36B MAGI without
    // any MC-side change.
    //
    // `applyTaxYear`'s own `penaltyAccounts` list stays EMPTY here because the
    // early-withdrawal §72(t) 10% leg and the Roth-earnings 10% leg are
    // assessed SEPARATELY by `computeMcPenaltyDollars` (against the aggregate
    // classification buckets + the per-leg exemption flags) and folded into
    // `taxCashflowDollars` by `assembleMcTaxResult` — so routing them through
    // `applyTaxYear` too would double-count.
    //
    // The HSA 20% pre-65 additional tax (§223(f)(4)) remains a DOCUMENTED MC
    // no-op: the MC kernel collapses the household to a single synthetic PRE_TAX
    // bucket (`mc-synthetic`) with no emergency-HSA-qualified% input (defaults to
    // 100% qualified → $0) and no per-account type / owner-birthdate detail for
    // the account-type-specific HSA rule; the deterministic per-account post-pass
    // owns the displayed HSA penalty. A future MC implementation that threads the
    // emergency-HSA-qualified% must preserve the medical-first / emergency split
    // (the percentage governs only the emergency-reserve draw — modeled
    // medical-qualified withdrawals are always 100% qualified).
    //
    // The annual taxable-account yield drag, the evolving cost-basis
    // fraction, and the cash-like interest are applied on the DISPLAY
    // surface: the representative tax post-pass threads
    // `brokerageLikeStartBalanceDollars` / `costBasisFraction` /
    // `cashInterestDollars` from the shared `advanceMcTaxableIncomeState`
    // accumulator (the same helpers the deterministic annotation runs), so the
    // MC representative chart matches the deterministic displayed tax. The
    // FUNDED per-path tax (bands/balances/success) and the Fill-conversion
    // solve omit them — mirroring the deterministic FUNDING solver's
    // documented pre-commit approximation, which keeps the two engines'
    // funded balances in parity.
    penaltyAccounts: [],
  };
}

/** Convert the engine's per-year tax result (cents) into the MC path-year
 *  result (dollars + same-year tax cashflow). Extracted from
 *  `applyPerYearTaxForPath` to keep each function short. */
function assembleMcTaxResult(
  taxResult: TaxYearResult,
  drawdown: number,
  penaltyDollars = 0,
): McTaxYearResult {
  const fedTax = centsToDollars(taxResult.federalTaxCents);
  const irmaa = centsToDollars(taxResult.irmaaSurchargeCents);
  const ptc = centsToDollars(taxResult.acaPtcSubsidyCents);

  // Same-year tax the portfolio must fund. The FULL IRMAA surcharge is
  // funded (cash + the portion withheld from gross SS) because the spendable
  // income series spends gross SS — mirrors the deterministic `addedNeedDollars`.
  // ACA PTC offsets the bill but never makes the need negative. The MC
  // path does not split IRMAA into cash vs SS-withheld (no per-member SS series
  // on the path), so it funds the whole surcharge — the conservative direction.
  //
  // Mirror of the deterministic engine: the early-withdrawal / HSA /
  // Roth-earnings penalty is funded per path (added to the cashflow) so it
  // reduces the path's balance via the absorbing after-tax adjustment. The
  // ACA PTC offsets only the federal tax + IRMAA, never the penalty (a penalty
  // is a Form 5329 additional tax, not PTC-offsettable).
  const taxCashflowDollars = Math.max(0, fedTax + irmaa - ptc) + penaltyDollars;

  return {
    fedTax,
    irmaa,
    ptc,
    effectiveTaxRate: taxResult.effectiveTaxRate,
    netAfterTax: drawdown - fedTax - irmaa + ptc,
    magiDollars: centsToDollars(taxResult.magiCents),
    filingUnitMagi: taxResult.filingUnitMagi ?? [],
    taxCashflowDollars,
  };
}

/** Build a per-year member flag set with Medicare timing, Marketplace months,
 *  the ACA opt-out and the §36B(c)(2)(B) overlap rule resolved by the ONE
 *  shared resolver (`resolveMemberHealthCoverage`) the deterministic twin
 *  (`buildMemberInputs`) also calls — so the two engines cannot resolve
 *  different coverage for the same member.
 *
 *  `healthCoverageMonths` is the same stored map the deterministic runner
 *  reads, looked up through the same shape-validating reader, so an imported
 *  `{ perMember: null }` reads as "nothing stated" on both paths instead of
 *  throwing out of the per-path loop. */
export function buildYearMemberFlags(
  m: TaxMemberInput,
  taxYear: number,
  /** THIS member's own separation-from-service year (resolved by the caller
   *  through `mcMemberRetirementYear`), NOT a household scalar — a staggered
   *  household's members become "retired" in different years, and the resolver
   *  gates automatic Marketplace months on it. */
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

// ---------------------------------------------------------------------------
// Per-year per-account classification from kernel output
// ---------------------------------------------------------------------------

/** Minimal per-account ledger tax metadata the year classifier needs.
 *  Subset of `MonteCarloAccountLedger` — declared here to avoid a type import
 *  cycle with `monte-carlo-types`. */
export interface McLedgerTaxMeta {
  readonly taxTreatment?: AccountTaxTreatment;
  readonly accountType?: AccountType;
  /** Pre-resolved scenario penalty exemption for this ledger account
   *  (id ∈ `earlyWithdrawalPenaltyExemptAccountIds`). Threaded into the
   *  classifier's per-source penalty-exempt accumulation. */
  readonly scenarioPenaltyExempt?: boolean;
  /** §72(t)(2)(A)(ii): the account is INHERITED, so a distribution from it
   *  is made on account of the original owner's death and carries no 10%
   *  additional tax at any beneficiary age. Pre-resolved per source so the pooled
   *  penalty leg excludes those dollars. */
  readonly deathExemptInherited?: boolean;
}

/** Per-account kernel year-state the classifier reads. All arrays are
 *  parallel to the ledger, iterated in fixed order (seed-independent). */
export interface McAccountYearState {
  /** Dollars withdrawn from this account across the year's 12 steps. */
  readonly withdrawalDollars: number;
  /** Pre-tax bucket balance at year start (for the MIXED pre/post split). */
  readonly preBalanceStartDollars: number;
  /** Post-tax bucket balance at year start. */
  readonly postBalanceStartDollars: number;
}

/**
 * Build the year's per-account withdrawal classification by zipping the
 * ledger tax metadata with the kernel's per-account year state. Returns
 * `undefined` (→ all-pre-tax fallback) when the kernel exposed no per-account
 * arrays (single-pool branch) or the ledger carries no tax metadata.
 */
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
      // Per-source scenario exemption (pre-resolved in `ledgerTaxMeta`).
      ...(meta.scenarioPenaltyExempt !== undefined
        ? { scenarioPenaltyExempt: meta.scenarioPenaltyExempt }
        : {}),
      // Per-source §72(t)(2)(A)(ii) death exemption for inherited accounts.
      ...(meta.deathExemptInherited !== undefined
        ? { deathExemptInherited: meta.deathExemptInherited }
        : {}),
    };
  });
  return classifyMcWithdrawal(accounts);
}

// ---------------------------------------------------------------------------
// Tax accumulators for runMonteCarlo
// ---------------------------------------------------------------------------

/**
 * Per-year tax arrays accumulated across all MC paths.
 * Each inner array has length `pathCount`; outer array has length `horizon`.
 */
export interface McTaxAccumulators {
  readonly fedTaxByYear: number[][];
  readonly irmaaSurchargeByYear: number[][];
  readonly acaPtcSubsidyByYear: number[][];
  readonly effectiveTaxRateByYear: number[][];
  readonly netAfterTaxByYear: number[][];
}

/** Allocate tax accumulator arrays. Returns null when `hasTaxCtx` is false. */
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
    effectiveTaxRateByYear: Array.from({ length: horizon }, () => new Array<number>(pathCount)),
    netAfterTaxByYear: Array.from({ length: horizon }, () => new Array<number>(pathCount)),
  };
}

// ---------------------------------------------------------------------------
// Synthetic-RMD-account prior-year base
// ---------------------------------------------------------------------------

/** Running after-tax-base state for the absorbing forward thread. */
export interface AfterTaxBaseState {
  /** After-tax balance through the just-finished year (the next year's base). */
  base: number;
  /** Set once the running after-tax base hits zero — never un-set. */
  depleted: boolean;
}

/** One absorbing step: the after-tax balance through year y (= the base year
 *  y+1 reads). Depletion latches only once REAL tax has been drawn
 *  (`cumTaxThroughThisYear > 0`) AND the year had a positive raw balance
 *  (`rawNominalThisYear > 0`) that the cumulative tax wiped to <= 0 — matching
 *  `applyAfterTaxAdjustment` (which skips absorption while `cumTax <= 0` and only
 *  records depletion on a positive raw balance). A no-tax / zero-balance year
 *  therefore does NOT latch, so a later raw recovery revives the base.
 *  Once latched, stays 0 regardless of a raw recovery. */
export function advanceAfterTaxBase(
  prev: AfterTaxBaseState,
  rawNominalThisYear: number,
  cumTaxThroughThisYear: number,
): AfterTaxBaseState {
  if (prev.depleted) return { base: 0, depleted: true };
  const afterTax = Math.max(0, rawNominalThisYear - cumTaxThroughThisYear);
  const depleted = cumTaxThroughThisYear > 0 && rawNominalThisYear > 0 && afterTax <= 0;
  return { base: afterTax, depleted };
}

/** Absorbing forward pass over the synthetic-RMD-account prior-year bases. y=0 →
 *  the year's own nominal (no prior year, no tax). y>0 → the prior year's
 *  AFTER-TAX balance (its nominal minus cumulative tax drawn through it, floored
 *  at zero), so a prior tax-funded withdrawal shrinks the next year's RMD floor —
 *  matching the deterministic side. ABSORBING: once the running
 *  after-tax base hits <= 0, every later base stays 0 — a raw pre-tax kernel
 *  recovery cannot revive it, mirroring `applyAfterTaxAdjustment`. Single
 *  deterministic forward pass (no Map/Set); year y's base reads only years
 *  `0..y-1`. Exported for unit testing. */
export function priorYearTaxBases(
  rawNominalByYear: number[],
  taxDrawByYear: number[],
): number[] {
  const bases = new Array<number>(rawNominalByYear.length);
  let cumTax = 0;
  let state: AfterTaxBaseState = { base: 0, depleted: false };
  for (let y = 0; y < rawNominalByYear.length; y += 1) {
    bases[y] = y === 0 ? rawNominalByYear[0] : state.base;
    cumTax += taxDrawByYear[y];
    state = advanceAfterTaxBase(state, rawNominalByYear[y], cumTax);
  }
  return bases;
}

// Re-export dollarsToCents for callers that only import from here.
export { dollarsToCents };
