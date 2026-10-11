/**
 * Helpers extracted from `balance-projection-runner-tax.ts` for shape-
 * cap compliance. Pure functions — no engine state, no global
 * mutation. The tax post-pass file consumes these directly.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why: it is the shared tax-computation
 * library consumed by BOTH the deterministic balance-projection runner and the
 * Monte Carlo path — cost-basis tracking, early-withdrawal-penalty
 * classification, and survivor / filing-status transitions are kept in one
 * module because they operate over the same per-account tax-treatment +
 * member-death state types. Splitting them by concern (basis / penalty /
 * survivor) would create import cycles among helpers that already call across
 * those boundaries (penalty classification reads the basis split; survivor
 * transitions re-key both), trading one over-cap file for three
 * mutually-importing ones. The opposite split already happened: the Roth §408A
 * basis carrier lives in the sibling `balance-projection-runner-roth-basis.ts`,
 * and this file is itself the extraction target that pulled the pure helpers
 * out of the `-tax.ts` post-pass. Both engines import these helpers, so
 * anything that must stay one shared derivation belongs here: the
 * effective-birth-year memo (it memoizes `hasAttainedAgeByYearEnd`'s existing
 * parse in place), the per-tax-unit filing-status handling (including the
 * separate-return and surviving-spouse statuses), the cash-like interest row
 * builder and `computeCashLikeInterestDollars` (on the same per-account
 * tax-character seam as the brokerage-basis helpers), the canonical twin-engine
 * resolvers `resolveRetirementYearByMember` and `resolveHouseholdDeathYears`
 * (a separate file would reintroduce the split derivations they exist to
 * delete), and `buildRothAccountFactInputs` (so the report's Roth tax-free
 * amounts table and `buildPipelineContext` resolve the same facts over the
 * same account set). Trigger: a change adding 5 or more lines here must either
 * refactor the file back under the limit or re-justify this exception in this
 * note.
 */

import type {
  Aggregate,
  AccountType,
  AccountTaxTreatment,
  AccountPayload,
  AccountBalancePayload,
} from '../db/types';
import { DEFAULT_LIFE_EXPECTANCY_AGE } from '../db/types';
import type { DrawdownAccountInput, DrawdownYear } from './drawdown-engine-types';
import { rmdEligibleWithdrawnCents } from './drawdown-engine-types';
import type { PipelineContext, SsRunRateRow } from './balance-projection-runner-types';
import type { MonthlyIncomeRow } from './balance-projection-bundle';
import {
  isRothAccount,
  type PenaltyAccountSnapshot,
  type TaxAccountSnapshot,
  type TaxMemberInput,
} from './tax-integration';
// The ONE shared health-coverage resolver both engines call.
import {
  readStoredCoverageMonths,
  resolveMemberHealthCoverage,
} from './tax-integration-helpers';
import type { FilingPlanContext, FilingStatusOverride } from './filing-status';
import {
  hasRothDesignatedPocket,
  isQualifyingAccount,
  isInheritedRmdSubjectType,
  poolKeyForRmdAccount,
  spouseMoreThan10YearsYounger,
  sumPoolShortfallCents,
  type RmdAccountProfileFacts,
  type RmdAccountType,
} from './rmd';
import {
  isValidRmdBoolean,
  isValidRmdIsoDate,
  isValidRmdBeneficiaryType,
  isValidRmdBeneficiaryElection,
} from '../db/rmd-fact-validation';
import { isRmdOverflowCashAccountId } from './drawdown-engine-per-account-strategy-helpers';
import {
  isPureRothEmployerType,
  isRothDesignatedPostBucket,
  isRothDesignatedRetirementType,
} from './balance-calc';
import type {
  RothBasisCarrier,
  SolverDesignatedRothStates,
} from './balance-projection-runner-roth-basis.js';
import {
  applyFactBasedRothIraOrdering,
  applyFactBasedDesignatedRothDistribution,
  householdRothIraClock,
  householdDesignatedRothClock,
  ownerReached59HalfForWholeYear,
} from './balance-projection-runner-roth-basis.js';
// The exact 59½ half-birthday proration the penalty engine applies downstream —
// used to attribute an aggregate slice's penalty snapshot to the owner whose
// proration is LARGEST, so the funded 10% matches the conservative base.
import { penaltyFractionForYear } from './early-withdrawal-penalty';
import type {
  RothInPlanRolloverLotCents,
  DesignatedRothAccountFactsCents,
  RothIraPoolFactsCents,
  RothDistributionFacts,
} from './roth-distribution-tax';
import { rothIraPoolKey } from './roth-distribution-tax';
import { resolveRothStartYear } from './roth-start-year';
import { deriveRothPoolBasisCents } from './roth-basis-derivation';
import {
  rothFactDollarsToCents,
  isValidRothMoney,
  isValidRothTaxYear,
  safeRothBasisFloorFromBigInt,
} from '../db/roth-fact-validation';

/** Jan-1-shifted effective birth year per ISO birthdate,
 *  memoized. `null` = unparseable (the caller's `!isoBirthdate` early-return
 *  above still short-circuits truly empty/nullish input before the memo).
 *  FIFO-bounded to 128 entries (mirrors `SNAPSHOT_RESOLUTION_MEMO` in
 *  tax-integration-helpers.ts) — a long session probing many distinct
 *  birthdates can't grow it unbounded. */
const EFFECTIVE_BIRTH_YEAR_MEMO = new Map<string, number | null>();
const EFFECTIVE_BIRTH_YEAR_MEMO_MAX_ENTRIES = 128;

/**
 * Whether a person with the given ISO birthdate has attained age `targetAge`
 * by the END of `taxYear`, applying the IRS born-on-January-1 rule.
 *
 * IRS convention: a person born on January 1 is treated as reaching their age
 * on December 31 of the PRIOR year, so a Jan-1-1960 person attains age 65 for
 * tax year 2024 — one year earlier than the naive `taxYear − birthYear`
 * formula. We shift a Jan-1 birthdate's effective birth year back one (treating
 * it as Dec-31 of the prior year), then compare on year only.
 *
 * The Jan-1-shifted effective birth year is memoized per
 * `isoBirthdate` (module `EFFECTIVE_BIRTH_YEAR_MEMO`); an unparseable birthdate
 * caches as `null` and returns `false` on every call.
 *
 * Unparseable / empty birthdate → false (caller decides the fallback).
 */
export function hasAttainedAgeByYearEnd(
  isoBirthdate: string | null | undefined,
  taxYear: number,
  targetAge: number,
): boolean {
  if (!isoBirthdate) return false;
  let effectiveBirthYear = EFFECTIVE_BIRTH_YEAR_MEMO.get(isoBirthdate);
  if (effectiveBirthYear === undefined) {
    const birthYear = parseInt(isoBirthdate.slice(0, 4), 10);
    if (Number.isNaN(birthYear)) {
      effectiveBirthYear = null;
    } else {
      const birthMonth = parseInt(isoBirthdate.slice(5, 7), 10);
      const birthDay = parseInt(isoBirthdate.slice(8, 10), 10);
      // Born Jan 1 → treated as reaching the age on Dec 31 of the prior year.
      effectiveBirthYear = birthMonth === 1 && birthDay === 1 ? birthYear - 1 : birthYear;
    }
    if (EFFECTIVE_BIRTH_YEAR_MEMO.size >= EFFECTIVE_BIRTH_YEAR_MEMO_MAX_ENTRIES) {
      // FIFO eviction: Map iteration order is insertion order, so the first
      // key is the oldest-inserted one.
      const oldestKey = EFFECTIVE_BIRTH_YEAR_MEMO.keys().next().value;
      if (oldestKey !== undefined) EFFECTIVE_BIRTH_YEAR_MEMO.delete(oldestKey);
    }
    EFFECTIVE_BIRTH_YEAR_MEMO.set(isoBirthdate, effectiveBirthYear);
  }
  if (effectiveBirthYear === null) return false;
  return taxYear - effectiveBirthYear >= targetAge;
}

/**
 * THE canonical per-member separation-from-service
 * calendar year, keyed by member id.
 *
 * A household can retire in STAGGERED years (each member retires on their own
 * date), and "retired" gates real money: the shared health resolver only gives
 * a member automatic Marketplace months once THEY have separated, and the
 * §401(a)(9)(C) later-of RMD rule reads the same year. One derivation for every
 * consumer — the deterministic member inputs (`buildMemberInputs`), the RMD
 * engine facts (`buildRmdEngineFactsFragment`) and the Monte Carlo tax context
 * (`buildMcTaxContext`) — so the twin engines cannot resolve different
 * retirement years for the same member.
 *
 * A `Map` (never a plain object) because the keys are user-controlled member
 * ids: an IMPORTED household member may legitimately carry the id
 * `"__proto__"` (CWE-1321). Serializing consumers convert it to their own
 * canonical plain shape.
 *
 * A secondary whose own retirement date is missing OR unparseable falls back to
 * the primary's year — the same-date default, never `NaN` (an `NaN` retirement
 * year silently reads as "never retired" in every `taxYear >= retirementYear`
 * comparison).
 */
export function resolveRetirementYearByMember(
  ctx: PipelineContext,
): ReadonlyMap<string, number> {
  const byMember = new Map<string, number>([[ctx.primary.id, ctx.primaryRetirementYear]]);
  if (ctx.secondary) {
    const secRetIso = ctx.retirementByMember.get(ctx.secondary.id);
    const secYear = secRetIso ? Number.parseInt(secRetIso.slice(0, 4), 10) : Number.NaN;
    byMember.set(
      ctx.secondary.id,
      Number.isFinite(secYear) ? secYear : ctx.primaryRetirementYear,
    );
  }
  return byMember;
}

/** Build the per-member `TaxMemberInput` array for a single projection year.
 *  Excludes any member whose projected death year is strictly before `taxYear`
 *  so deceased members don't inflate household size or Medicare counts. */
export function buildMemberInputs(
  ctx: PipelineContext,
  taxYear: number,
  primaryAlive: boolean,
  secondaryAlive: boolean,
): readonly TaxMemberInput[] {
  const members: TaxMemberInput[] = [];

  const pushMember = (
    member: Aggregate<{ birthdate?: string | null; isPrimary: boolean }>,
    isRetiredByYear: boolean,
    /** This member's separation-from-service calendar year, resolved by the
     *  caller from `ctx.retirementByMember`. Feeds the §401(a)(9)(C) later-of
     *  first-distribution-year rule; absent → that resolution withholds. */
    retirementYear?: number,
  ): void => {
    const iso = member.payload.birthdate ?? `${taxYear - 65}-01-01`;
    // Medicare timing, Marketplace months and the §36B(c)(2)(B) overlap
    // rule all come from ONE shared resolver that the Monte Carlo twin
    // (`buildYearMemberFlags`) calls with the same facts, so the two engines
    // cannot drift on coverage months. It applies the real rule rather than a
    // whole-year approximation (12 Medicare months for a January–June birthday, 0 for
    // July–December): entitlement starts in the birthday
    // month, or the month BEFORE for a first-of-month birthday.
    //
    // ACA opt-out (per-member): a member the scenario marked as NOT on the
    // Marketplace (retiree / COBRA / spousal coverage) gets no ACA-PTC subsidy
    // unless the scenario states Marketplace months for them explicitly. This is
    // the single point of truth — flipping it removes the member from BOTH
    // the household benchmark sum AND the ACA-block engagement gate.
    // `householdSize` (the FPL denominator = tax family) is deliberately NOT
    // narrowed — an opted-out member stays in the tax household (§36B / Pub 974).
    const coverage = resolveMemberHealthCoverage({
      isoBirthdate: iso,
      taxYear,
      retired: isRetiredByYear,
      optedOut: ctx.acaMarketplaceOptOutMemberIds.has(member.id),
      stored: readStoredCoverageMonths(ctx.healthCoverageMonths, member.id, taxYear),
    });
    members.push({
      memberId: member.id,
      isoBirthdate: iso,
      ...coverage,
      ...(retirementYear !== undefined ? { retirementYear } : {}),
    });
  };

  // The ONE canonical per-member retirement year (`resolveRetirementYearByMember`)
  // the Monte Carlo twin also threads, so a staggered-retirement household
  // resolves the same "retired by this year" fact — and therefore the same
  // Marketplace months — on both engines.
  const retirementYearByMember = resolveRetirementYearByMember(ctx);

  if (primaryAlive) {
    const primaryRetYear = retirementYearByMember.get(ctx.primary.id) ?? ctx.primaryRetirementYear;
    pushMember(ctx.primary, taxYear >= primaryRetYear, primaryRetYear);
  }

  if (ctx.secondary && secondaryAlive) {
    // Secondary: retired if the year ≥ THEIR OWN retirement year (which equals
    // the primary's under the same-date anchor, and when the secondary's own
    // date is missing or unparseable).
    const secRetYear =
      retirementYearByMember.get(ctx.secondary.id) ?? ctx.primaryRetirementYear;
    pushMember(ctx.secondary, taxYear >= secRetYear, secRetYear);
  }

  return members;
}

/** Build per-account snapshots for RMD computation from the PRIOR year's
 *  `DrawdownYear.accountBalances` (RMD uses Dec-31 balance of prior year).
 *
 *  For every account that HAS a Roth-designated pocket populate
 *  `postBalancePriorYearDollars` so the tax-integration layer can pass
 *  `rothPortionCents` to the RMD engine (SECURE 2.0 §325). Year-0 uses the ledger
 *  initial post bucket; year y>0 uses the prior `DrawdownAccountYear.postEnd`.
 *
 *  "Has a Roth-designated pocket" means MIXED (a pre-tax plan holding a
 *  designated-Roth sub-account) OR a pure Roth account (POST_TAX / ROTH, whose
 *  whole balance is Roth money). Restricting it to MIXED would leave an INHERITED
 *  Roth account passing its full Roth balance as a pre-tax
 *  RMD base, which the tax pass would then gross up as ordinary income.
 *  The Monte Carlo producers apply the identical rule via
 *  `buildMcRmdAccountInput`. */
export function buildAccountSnapshotsFromPriorYear(
  ctx: PipelineContext,
  priorYear: DrawdownYear | undefined,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  /** The year TWO before the tax year, used ONLY to size a first-year
   *  deferral catch-up. Absent → the catch-up is a blocker, never guessed. */
  priorPriorYear?: DrawdownYear,
): readonly TaxAccountSnapshot[] {
  const accountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  // An INHERITED account is subject to BENEFICIARY RMD rules even when the
  // living-owner test rejects it (an inherited Roth IRA / designated-Roth account
  // owes post-death distributions its living owner would not), so the snapshot
  // filter admits it. `isInheritedRmdSubjectType` still excludes HSAs and every
  // non-retirement type, which no inheritance makes RMD-subject.
  const rmdRelevant = (
    id: string,
    type: AccountType,
    taxTreatment: AccountTaxTreatment,
  ): { relevant: boolean; facts?: RmdAccountProfileFacts } => {
    const facts = ctx.rmdProfileFactsByAccountId.get(id);
    if (facts?.inheritedAccount === true) {
      return { relevant: isInheritedRmdSubjectType(type as RmdAccountType), facts };
    }
    return {
      relevant: isQualifyingAccount(type as RmdAccountType, taxTreatment),
      ...(facts !== undefined ? { facts } : {}),
    };
  };

  // Year 0 of drawdown: use initial ledger balances (at retirement).
  if (priorYear === undefined) {
    return ledgerAccounts
      .map((a) => {
        const account = accountById.get(a.id);
        if (!account) return null;
        const { type, taxTreatment, ownerId } = account.payload;
        const { relevant, facts } = rmdRelevant(a.id, type, taxTreatment);
        if (!relevant) return null;
        const snap: TaxAccountSnapshot = {
          id: a.id,
          type,
          taxTreatment,
          ownerId,
          balancePriorYearDollars: a.initialPre + a.initialPost,
          withdrawalDollars: 0,
          ...(hasRothDesignatedPocket(taxTreatment)
            ? { postBalancePriorYearDollars: a.initialPost }
            : {}),
          ...(facts !== undefined ? { rmdFacts: facts } : {}),
        };
        return snap;
      })
      .filter((s): s is TaxAccountSnapshot => s !== null);
  }

  // Year 1+: use prior DrawdownYear.accountBalances.
  const priorBalances = priorYear.accountBalances;
  if (!priorBalances) return [];
  const priorPriorBalances = priorPriorYear?.accountBalances;
  const out: TaxAccountSnapshot[] = [];
  for (const [id, row] of priorBalances.entries()) {
    const account = accountById.get(id);
    if (!account) continue;
    const { type, taxTreatment, ownerId } = account.payload;
    const { relevant, facts } = rmdRelevant(id, type, taxTreatment);
    if (!relevant) continue;
    const twoYearsPriorRow = priorPriorBalances?.get(id);
    const twoYearsPrior = twoYearsPriorRow?.balance;
    out.push({
      id,
      type,
      taxTreatment,
      ownerId,
      balancePriorYearDollars: row.balance,
      withdrawalDollars: row.withdrawn,
      ...(hasRothDesignatedPocket(taxTreatment)
        ? { postBalancePriorYearDollars: row.postEnd }
        : {}),
      ...(facts !== undefined ? { rmdFacts: facts } : {}),
      ...(twoYearsPrior !== undefined
        ? { balanceTwoYearsPriorDollars: twoYearsPrior }
        : {}),
      // The SECURE 2.0 §325 Roth-designated portion of that same
      // two-years-prior balance, so the shared `rmdTwoYearsPriorBaseCents`
      // resolver nets it out exactly like the current-year base. Without it a
      // MIXED account's deferred first-year catch-up would be sized on its
      // Roth-designated dollars too (which owe no RMD), and a pure Roth
      // inherited account's on its entire Roth balance.
      ...(hasRothDesignatedPocket(taxTreatment) && twoYearsPriorRow !== undefined
        ? { postBalanceTwoYearsPriorDollars: twoYearsPriorRow.postEnd }
        : {}),
    });
  }
  return out;
}

/**
 * Sum taxable non-SS ordinary income for a calendar year from per-month rows.
 * Includes pension + part-time wages. Excludes `depositInflow` (portfolio
 * additions — return-of-principal / rollover, not taxable ordinary income).
 * OneOff windfalls are included as ordinary income (conservative; no cost-basis
 * data available to split the taxable portion in v1).
 *
 * Unit contract: per `IncomeMonthOutput`, `pensionIncome` + `partTimeIncome`
 * are ANNUALIZED RUN-RATES ($/yr at that month) — `mean(rate_m for m in
 * 0..11) = annual sum`. Summing 12 months of a constant $30k/yr pension
 * naively gives $360k; the correct annual amount is the mean ($30k).
 * `oneOffIncome` is the literal event-month spike (not a rate) and is
 * summed unchanged. Same semantics as `buildMonthlyIncomeSeries`.
 */
export function otherOrdinaryIncomeForYear(
  incomeRows: ReadonlyArray<MonthlyIncomeRow>,
  calendarYear: number,
): number {
  let runRateSum = 0;
  let spikeSum = 0;
  for (const r of incomeRows) {
    if (r.year !== calendarYear) continue;
    runRateSum += r.pensionIncome + r.partTimeIncome;
    spikeSum += r.oneOffIncome;
  }
  return runRateSum / 12 + spikeSum;
}

/** Compute gross SS dollars for a calendar year from per-month SS rows.
 *
 *  Unit contract: per `SsMonthOutput`, `total` is an ANNUALIZED RUN-RATE
 *  ($/yr at that month) — `mean(rate_m for m in 0..11) = annual sum`.
 *  Summing 12 months of a flat $30k/yr SS naively gives $360k; the
 *  correct annual amount is the mean ($30k). Same semantics as
 *  `buildMonthlyIncomeSeries`'s SS branch (which divides by 12). */
export function grossSsForYear(
  ssRows: ReadonlyArray<SsRunRateRow>,
  calendarYear: number,
): number {
  const runRateSum = ssRows
    .filter((r) => r.year === calendarYear)
    .reduce((sum, r) => sum + r.total, 0);
  return runRateSum / 12;
}

/**
 * Per-member OWN gross SS dollars for a calendar year, keyed by member ID
 * (hybrid-IRMAA). Each Medicare member's surcharge is withheld only from
 * that member's own SS, never the household pool — so the split needs each
 * member's own benefit. Run-rate → annual via the same `/12` mean as
 * `grossSsForYear`. Members with no SS row for the year (or `$0`) are absent
 * from the map, so their whole IRMAA surcharge falls to the cash need.
 */
export function ownSsByMemberForYear(
  ssRows: ReadonlyArray<SsRunRateRow>,
  calendarYear: number,
  primaryId: string,
  secondaryId: string | undefined,
): Record<string, number> {
  let primaryRunRate = 0;
  let secondaryRunRate = 0;
  for (const r of ssRows) {
    if (r.year !== calendarYear) continue;
    primaryRunRate += r.primary;
    secondaryRunRate += r.secondary ?? 0;
  }
  const out: Record<string, number> = {};
  if (primaryRunRate > 0) out[primaryId] = primaryRunRate / 12;
  if (secondaryId !== undefined && secondaryRunRate > 0) out[secondaryId] = secondaryRunRate / 12;
  return out;
}

/**
 * Account types whose POST_TAX withdrawals are return of already-taxed
 * principal — cash-like instruments + HSA. The WITHDRAWAL itself
 * contributes $0 taxable income and $0 MAGI. The interest that SAVINGS /
 * MONEY_MARKET / CD balances EARN is modeled separately as annually-taxable
 * ordinary income (`isTaxableCashInterestAccount` +
 * `computeCashLikeInterestDollars` below), which is exactly why the
 * withdrawal stays return of already-taxed principal. HSA growth stays
 * tax-free (§223 — excluded from the interest set by type AND treatment), and
 * the HSA nonqualified-withdrawal income + pre-65 20% additional tax are
 * layered on separately by the penalty pass (the medical-qualified vs
 * emergency split).
 * `BROKERAGE` and `OTHER` are NOT in this set — they hold taxable investments
 * and route to the LTCG proxy.
 */
const CASH_LIKE_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'SAVINGS',
  'MONEY_MARKET',
  'CD',
  'HSA',
]);

/** True when a POST_TAX (non-Roth) account's withdrawals are return of
 *  already-taxed principal rather than a long-term-capital-gain proxy. */
export function isCashLikeAccountType(type: AccountType): boolean {
  return CASH_LIKE_ACCOUNT_TYPES.has(type);
}

/** True when the account is a brokerage-like POST_TAX taxable account
 *  (`BROKERAGE` / `OTHER`, treatment `POST_TAX`) — the only accounts that
 *  generate the LTCG/QDI withdrawal proxy AND the annual assumed-yield drag.
 *  Cash-like POST_TAX (`SAVINGS`/`MONEY_MARKET`/`CD`/`HSA`), pre-tax, Roth, and
 *  MIXED accounts are excluded. Exported so the Monte Carlo tax path
 *  selects the yield-drag account set with the identical predicate. */
export function isBrokerageLikeAccount(
  type: AccountType,
  taxTreatment: AccountTaxTreatment,
): boolean {
  return taxTreatment === 'POST_TAX' && !CASH_LIKE_ACCOUNT_TYPES.has(type);
}

/** True when the account's annual growth is ordinary taxable interest:
 *  cash-like POST_TAX (`SAVINGS` / `MONEY_MARKET` / `CD`). HSA is EXCLUDED
 *  both by type and by treatment — HSA growth is tax-free (§223), preserving
 *  the HSA source identity. Pre-tax / Roth / MIXED accounts are excluded (their
 *  growth is taxed by their own regimes). Shared by the deterministic and
 *  Monte Carlo engines so the interest account set can never diverge. */
export function isTaxableCashInterestAccount(
  type: AccountType,
  taxTreatment: AccountTaxTreatment,
): boolean {
  return (
    taxTreatment === 'POST_TAX' && CASH_LIKE_ACCOUNT_TYPES.has(type) && type !== 'HSA'
  );
}

// ---------------------------------------------------------------------------
// Brokerage-like cost-basis evolution — cross-year accumulator
// ---------------------------------------------------------------------------

/**
 * Per-brokerage-like-account cost-basis state carried across projection years.
 * `basisDollars` is the running cost basis (dollars); the market value
 * lives on the drawdown rows. The accumulator is keyed by account id; an
 * account is added the first year it has a balance.
 */
export interface BrokerageLikeBasisState {
  /** Account id → running cost basis in dollars (after the prior year's
   *  withdrawal depletion). */
  readonly basisByAccountId: Map<string, number>;
  /** Seed cost-basis fraction for an account's first appearance (default 0.5,
   *  from `assumedCostBasisFractionOfTaxableWithdrawal`). */
  readonly seedBasisFraction: number;
}

/** Result of advancing the basis accumulator one projection year. */
export interface BrokerageLikeYearBasis {
  /**
   * Brokerage-like balance at the START of the year (prior year-end), in
   * dollars — the yield base `B`.
   */
  readonly startBalanceDollars: number;
  /**
   * Withdrawal-weighted PRE-withdrawal cost-basis fraction across all
   * brokerage-like accounts this year, clamped to [0,1]. Supplied to
   * `TaxYearInput.assumedCostBasisFraction` so the withdrawal-time LTCG gain
   * is `withdrawal × (1 − fraction)`. Falls back to the seed fraction when no
   * brokerage-like withdrawal occurred (the fraction is then unused — no LTCG).
   */
  readonly preWithdrawalBasisFraction: number;
}

/** One brokerage-like account's year inputs for the basis evolution step. */
interface BrokerageAccountYearInput {
  readonly id: string;
  /** Prior year-end market value (start-of-year balance), dollars. */
  readonly startBalanceDollars: number;
  /** Year-end market value AFTER this year's withdrawal + growth, dollars. */
  readonly endBalanceDollars: number;
  /** This year's withdrawal from the account, dollars. */
  readonly withdrawnDollars: number;
  /** This year's contribution/deposit into the account (new basis), dollars. */
  readonly depositDollars: number;
}

/**
 * Advance the brokerage-like cost-basis accumulator one projection year and
 * return the year's yield base + withdrawal-weighted pre-withdrawal basis
 * fraction. Mutates `state.basisByAccountId` in place.
 *
 * Ordering (load-bearing): grow basis by deposits +
 * reinvested yield BEFORE the withdrawal; compute the withdrawal's gain from
 * the PRE-withdrawal fraction; THEN deplete basis pro-rata.
 *
 *   basisPreWithdrawal = basisPrev + deposit + reinvestedYield
 *   preWithdrawalFraction = clamp(basisPreWithdrawal / V, 0, 1)   // V = pre-withdrawal value
 *   basisWithdrawn = withdrawal × preWithdrawalFraction
 *   basisNext = basisPreWithdrawal − basisWithdrawn
 *
 * `V` (pre-withdrawal market value) = endBalance + withdrawn (add the
 * withdrawal back to the post-withdrawal year-end balance). Reinvested yield is
 * the FULL annually-taxed yield (`startBalance × totalYieldPct`) — the yield/basis
 * coupling invariant that stops the annually-taxed dollars being taxed again at
 * withdrawal. The carried fraction for next year is `clamp(basisNext / endBalance, 0, 1)`.
 *
 * @param accounts brokerage-like account year rows.
 * @param state mutable per-account basis state (carried across years).
 * @param totalYieldPct the year's assumed total taxable yield (e.g. 0.02).
 */
export function advanceBrokerageLikeBasis(
  accounts: readonly BrokerageAccountYearInput[],
  state: BrokerageLikeBasisState,
  totalYieldPct: number,
): BrokerageLikeYearBasis {
  let startBalanceTotal = 0;
  let withdrawnTotal = 0;
  let basisWithdrawnTotal = 0;
  const yieldRate = Math.max(0, totalYieldPct);

  for (const acc of accounts) {
    const start = Math.max(0, acc.startBalanceDollars);
    startBalanceTotal += start;

    const withdrawn = Math.max(0, acc.withdrawnDollars);
    // V = pre-withdrawal market value (post-growth, pre-withdrawal).
    const preWithdrawalValue = Math.max(0, acc.endBalanceDollars) + withdrawn;

    // On first appearance, seed the basis from the seed fraction × the account's
    // pre-existing value. Prefer the start-of-year value (`initialValue`); when
    // it is unknown (e.g. year 0 with no ledger initial), fall back to the
    // pre-withdrawal value MINUS this year's deposit — the deposit is its own cost
    // basis and is added once below (and is already inside `preWithdrawalValue` via
    // `endBalanceDollars`), so seeding from the gross pre-withdrawal value would
    // double-count it and overstate basis (hiding same-year gain on a brokerage
    // account funded from a zero start balance).
    const seedBase = start > 0 ? start : Math.max(0, preWithdrawalValue - Math.max(0, acc.depositDollars));
    const basisPrev = state.basisByAccountId.has(acc.id)
      ? (state.basisByAccountId.get(acc.id) as number)
      : seedBase * state.seedBasisFraction;

    const reinvestedYield = start * yieldRate;
    const basisPreWithdrawal = basisPrev + Math.max(0, acc.depositDollars) + reinvestedYield;

    const preWithdrawalFraction =
      preWithdrawalValue > 0 ? clamp01(basisPreWithdrawal / preWithdrawalValue) : 0;

    const basisWithdrawn = Math.min(basisPreWithdrawal, withdrawn * preWithdrawalFraction);
    withdrawnTotal += withdrawn;
    basisWithdrawnTotal += basisWithdrawn;

    const basisNext = Math.max(0, basisPreWithdrawal - basisWithdrawn);
    const endBalance = Math.max(0, acc.endBalanceDollars);
    // Carry the post-withdrawal basis forward; clamp the implied fraction so a
    // tiny fp residue cannot push basis above value next year.
    const carriedBasis = endBalance > 0 ? Math.min(basisNext, endBalance) : 0;
    state.basisByAccountId.set(acc.id, carriedBasis);
  }

  const preWithdrawalBasisFraction =
    withdrawnTotal > 0 ? clamp01(basisWithdrawnTotal / withdrawnTotal) : state.seedBasisFraction;

  return { startBalanceDollars: startBalanceTotal, preWithdrawalBasisFraction };
}

/** Clamp a number to [0, 1]. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** One taxable account's year rows for the basis / interest passes. */
export interface TaxableAccountYearRow {
  readonly id: string;
  /** Owning household member id — lets a separate-returns year report
   *  this account's yield base / interest on its OWNER's return instead of
   *  splitting it evenly. ABSENT when the caller has no per-account owner
   *  detail (the Monte Carlo pooled path): those dollars stay unattributed and
   *  fall back to the even split. */
  readonly ownerId?: string;
  readonly startBalanceDollars: number;
  readonly endBalanceDollars: number;
  readonly withdrawnDollars: number;
  readonly depositDollars: number;
}

/** Shared row assembly for the per-account taxable-income passes: joins the
 *  current `DrawdownYear`'s per-account rows to a start-of-year balance (prior
 *  year-end, else ledger initial for year 0), keeping only accounts matching
 *  `predicate`. Returns `[]` when the year carries no per-account map
 *  (bucket-allocation paths). */
function buildTaxCharacterYearAccounts(
  ctx: PipelineContext,
  year: DrawdownYear,
  priorYear: DrawdownYear | undefined,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  predicate: (type: AccountType, taxTreatment: AccountTaxTreatment) => boolean,
  opts?: {
    /** Cash-interest rows: when the start-of-year balance is UNKNOWN (no
     *  prior row AND no ledger entry — hand-rolled callers only; production
     *  always supplies the ledger) synthesize a zero-growth start
     *  (`end + withdrawn − deposit`) instead of `0`, so the interest
     *  derivation never invents income out of an unknown opening balance. The
     *  brokerage rows keep the `0` fallback (their seed logic
     *  handles it downstream in `advanceBrokerageLikeBasis`). */
    readonly unknownStartIsZeroGrowth?: boolean;
  },
): readonly TaxableAccountYearRow[] {
  const current = year.accountBalances;
  if (!current) return [];
  const accountById = new Map(ctx.accountProjections.map((p) => [p.account.id, p.account]));
  const priorBalances = priorYear?.accountBalances;
  const ledgerById = new Map(ledgerAccounts.map((a) => [a.id, a]));

  const out: TaxableAccountYearRow[] = [];
  for (const [id, row] of current.entries()) {
    const account = accountById.get(id);
    if (!account) continue;
    const { type, taxTreatment, ownerId } = account.payload;
    if (!predicate(type, taxTreatment)) continue;
    // Start-of-year value: prior year-end balance, else ledger initial (year 0).
    let startBalance: number;
    if (priorBalances?.has(id)) {
      startBalance = priorBalances.get(id)?.balance ?? 0;
    } else {
      const ledger = ledgerById.get(id);
      if (ledger) {
        startBalance = ledger.initialPre + ledger.initialPost;
      } else {
        startBalance = opts?.unknownStartIsZeroGrowth
          ? Math.max(0, row.balance + row.withdrawn - row.deposit)
          : 0;
      }
    }
    out.push({
      id,
      ownerId,
      startBalanceDollars: startBalance,
      endBalanceDollars: row.balance,
      withdrawnDollars: row.withdrawn,
      depositDollars: row.deposit,
    });
  }
  return out;
}

/**
 * Build the brokerage-like account year rows for the basis accumulator
 * from the current `DrawdownYear` and the prior year's balances. Start balance
 * is the prior year-end (or the ledger initial value for year 0); end balance,
 * withdrawal, and deposit come from the current year's per-account row. Returns
 * `[]` when the year carries no per-account map (bucket-allocation paths —
 * no brokerage-like routing there, so no yield drag / basis evolution).
 */
export function buildBrokerageLikeYearAccounts(
  ctx: PipelineContext,
  year: DrawdownYear,
  priorYear: DrawdownYear | undefined,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
): readonly TaxableAccountYearRow[] {
  return buildTaxCharacterYearAccounts(ctx, year, priorYear, ledgerAccounts, isBrokerageLikeAccount);
}

/**
 * Build the cash-like interest account year rows (`SAVINGS` /
 * `MONEY_MARKET` / `CD`, POST_TAX; HSA excluded — tax-free) from the current
 * `DrawdownYear` and the prior year's balances. Same start/end/withdrawn/
 * deposit shape as the brokerage rows; `computeCashLikeInterestDollars` turns
 * them into the year's ordinary taxable interest. Returns `[]` when the year
 * carries no per-account map (bucket-allocation paths — no interest modeled
 * there, the documented fallback).
 */
export function buildCashLikeYearAccounts(
  ctx: PipelineContext,
  year: DrawdownYear,
  priorYear: DrawdownYear | undefined,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
): readonly TaxableAccountYearRow[] {
  return buildTaxCharacterYearAccounts(
    ctx,
    year,
    priorYear,
    ledgerAccounts,
    isTaxableCashInterestAccount,
    { unknownStartIsZeroGrowth: true },
  );
}

/**
 * Annual ordinary taxable interest earned by cash-like accounts, derived
 * from each account's own REALIZED growth for the year:
 *
 *   interest_account = max(0, endBalance + withdrawn − deposits − startBalance)
 *
 * (the pre-withdrawal value minus what was put in — exactly the account's
 * growth at its own configured/simulated rate). Clamped at 0 per account — a
 * negative cash return produces no negative income (one-sided; interest income
 * is never below zero and cash losses are not deductible here). Two consumers,
 * one formula: the deterministic post-pass ANNOTATION (`buildCashLikeYearAccounts`
 * rows) and the Monte Carlo representative-DISPLAY post-pass
 * (`advanceMcTaxableIncomeState` → `applyMcTaxToRepresentativeYears`), so the
 * DISPLAYED savings/CD interest is derived identically by construction in both
 * engines. Neither engine's FUNDED path runs it: the deterministic within-year
 * cashflow solver and the MC funded per-path tax fill both deliberately omit
 * cash interest (the shared pre-commit approximation that keeps funded
 * balances in cross-engine parity).
 */
export function computeCashLikeInterestDollars(
  accounts: readonly TaxableAccountYearRow[],
): number {
  let interest = 0;
  for (const acc of accounts) {
    const start = Math.max(0, acc.startBalanceDollars);
    const growth =
      Math.max(0, acc.endBalanceDollars) +
      Math.max(0, acc.withdrawnDollars) -
      Math.max(0, acc.depositDollars) -
      start;
    interest += Math.max(0, growth);
  }
  return interest;
}

/** Per-OWNER cash-like ordinary interest for one year (the same growth
 *  formula as {@link computeCashLikeInterestDollars}, kept per account owner so
 *  a separate-returns year reports each spouse's own interest). */
export function computeCashLikeInterestByOwner(
  accounts: readonly TaxableAccountYearRow[],
): Record<string, number> {
  const byOwner: Record<string, number> = {};
  for (const acc of accounts) {
    const start = Math.max(0, acc.startBalanceDollars);
    const growth =
      Math.max(0, acc.endBalanceDollars) +
      Math.max(0, acc.withdrawnDollars) -
      Math.max(0, acc.depositDollars) -
      start;
    if (growth > 0 && acc.ownerId !== undefined) {
      byOwner[acc.ownerId] = (byOwner[acc.ownerId] ?? 0) + growth;
    }
  }
  return byOwner;
}

/** Per-OWNER start-of-year brokerage-like balance (the assumed-yield
 *  base), so a separate-returns year charges each spouse's yield drag to the
 *  return that actually owns the account. */
export function brokerageStartBalanceByOwner(
  accounts: readonly TaxableAccountYearRow[],
): Record<string, number> {
  const byOwner: Record<string, number> = {};
  for (const acc of accounts) {
    const start = Math.max(0, acc.startBalanceDollars);
    if (start > 0 && acc.ownerId !== undefined) {
      byOwner[acc.ownerId] = (byOwner[acc.ownerId] ?? 0) + start;
    }
  }
  return byOwner;
}

/** The four withdrawal tax buckets one projection year splits into. */
type WithdrawalTaxBucket = 'preTax' | 'postTaxNonRoth' | 'postTaxCashLike' | 'roth';

/**
 * One year's withdrawals split by tax treatment, with the per-OWNER breakdown
 * each bucket's dollars came from.
 *
 * The household totals are what a single-return year reports. The `byOwner`
 * maps are what a SEPARATE-returns year needs: each spouse's return reports the
 * withdrawals from the accounts THEY own, not half of the household's. Dollars
 * drawn from a pool with no owner (the bucket-allocation fallback, the synthetic
 * RMD-overflow cash carrier, an unknown account id) are deliberately absent from
 * `byOwner` — they stay genuinely unattributed and fall back to the even split.
 */
export interface WithdrawalTaxSplit {
  preTax: number;
  postTaxNonRoth: number;
  postTaxCashLike: number;
  roth: number;
  /** `bucket → ownerId → dollars`. Owner-attributed dollars only. */
  readonly byOwner: Record<WithdrawalTaxBucket, Record<string, number>>;
}

/** A zeroed {@link WithdrawalTaxSplit}. */
function emptyWithdrawalTaxSplit(): WithdrawalTaxSplit {
  return {
    preTax: 0,
    postTaxNonRoth: 0,
    postTaxCashLike: 0,
    roth: 0,
    byOwner: { preTax: {}, postTaxNonRoth: {}, postTaxCashLike: {}, roth: {} },
  };
}

/** Add one account's withdrawal to a bucket total AND, when the owner is known,
 *  to that owner's attributed share of the bucket. */
function addWithdrawal(
  split: WithdrawalTaxSplit,
  bucket: WithdrawalTaxBucket,
  ownerId: string | undefined,
  dollars: number,
): void {
  split[bucket] += dollars;
  if (ownerId === undefined) return;
  split.byOwner[bucket][ownerId] = (split.byOwner[bucket][ownerId] ?? 0) + dollars;
}

/**
 * Compute per-account pre-tax / post-tax-non-roth / post-tax-cash-like / roth
 * withdrawal splits from a `DrawdownYear`'s `accountBalances` map.
 *
 * MIXED accounts (e.g. an IRA carrying Roth + pre-tax buckets)
 * split the per-account withdrawal into pre + post via the engine-
 * supplied `preWithdrawnCents` / `postWithdrawnCents` fields. Pre lands
 * in `preTax`; post is classified by the account's `type` — `BROKERAGE` /
 * `OTHER` land in `postTaxNonRoth` (LTCG proxy applies), cash-like types
 * `{SAVINGS, MONEY_MARKET, CD, HSA}` land in `postTaxCashLike` ($0
 * taxable income, $0 MAGI). Roth accounts carry `taxTreatment === 'ROTH'`,
 * not MIXED. Fall back to "all post" routing only when the engine
 * did not surface the per-bucket split.
 */
export function splitWithdrawalsByTaxTreatment(
  ctx: PipelineContext,
  year: DrawdownYear,
): WithdrawalTaxSplit {
  const accountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  const split = emptyWithdrawalTaxSplit();
  // Rows without an `accountBalances` map (legacy / bucket-allocation single
  // pool) classify the WHOLE net draw as pre-tax (conservative fallback). The
  // pool carries no owner, so the household total stays UNATTRIBUTED
  // (a separate-filing year then splits it evenly, the documented fallback).
  if (!year.accountBalances) {
    addWithdrawal(split, 'preTax', undefined, year.withdrawn);
    return split;
  }
  for (const [id, row] of year.accountBalances.entries()) {
    // The synthetic RMD-overflow cash carrier is return-of-principal held
    // cash — $0 taxable income, $0 MAGI, tax-free. Route its withdrawals to the
    // cash-like bucket (NOT the brokerage LTCG proxy). It is not a real account,
    // so it is absent from `accountById`; handle it before the unknown-id guard.
    if (isRmdOverflowCashAccountId(id)) {
      addWithdrawal(split, 'postTaxCashLike', undefined, row.withdrawn);
      continue;
    }
    const account = accountById.get(id);
    if (!account) {
      // Unknown account ID — treat as post-tax non-Roth (conservative low-tax
      // direction: under-taxes rather than over-taxes the unknown bucket).
      // Log once to surface misconfiguration without spamming the console.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[tax-integration] unknown account id "${id}" in splitWithdrawalsByTaxTreatment — routing to postTaxNonRoth`);
      }
      addWithdrawal(split, 'postTaxNonRoth', undefined, row.withdrawn);
      continue;
    }
    const { taxTreatment, type, ownerId } = account.payload;
    if (taxTreatment === 'PRE_TAX') {
      addWithdrawal(split, 'preTax', ownerId, row.withdrawn);
      continue;
    }
    if (taxTreatment === 'HSA') {
      // Qualified HSA withdrawals carry no income tax + no MAGI. Route the
      // return-of-principal to the cash-like post-tax bucket — the same
      // bucket the HSA account TYPE already maps to — so the existing HSA tax
      // model is preserved: the nonqualified-fraction ordinary income + the
      // pre-65 20% §223(f)(4) additional tax are layered on separately by the
      // early-withdrawal/HSA penalty pass, independent of treatment.
      addWithdrawal(split, 'postTaxCashLike', ownerId, row.withdrawn);
      continue;
    }
    if (taxTreatment === 'ROTH') {
      addWithdrawal(split, 'roth', ownerId, row.withdrawn);
      continue;
    }
    const cashLike = isCashLikeAccountType(type);
    if (taxTreatment === 'MIXED') {
      // Route pre / post buckets independently when the engine
      // surfaced the split; the post sub-bucket follows the same
      // brokerage-vs-cash-like rule by the account's `type`. Fallback
      // path treats the whole withdrawal as post for legacy compatibility.
      //
      // MIXED Roth-designated (401k/403b/457b/TSP) post bucket →
      // `roth` bucket ($0 income, $0 MAGI); only the pre tranche stays
      // pre-tax. MIXED OTHER post bucket is unchanged (LTCG/cash-like proxy).
      const rothDesignated = isRothDesignatedPostBucket(taxTreatment, type);
      const postBucket = rothDesignated ? 'roth' : cashLike ? 'postTaxCashLike' : 'postTaxNonRoth';
      const preCents = row.preWithdrawnCents;
      const postCents = row.postWithdrawnCents;
      if (preCents !== undefined && postCents !== undefined) {
        addWithdrawal(split, 'preTax', ownerId, preCents / 100);
        addWithdrawal(split, postBucket, ownerId, postCents / 100);
      } else if (rothDesignated) {
        // Legacy / no-split fallback for Roth-designated MIXED: whole
        // withdrawal to Roth (post=0 → no basis consumed, no penalty;
        // conservative — the pre tranche has already been penalized separately
        // by `buildPenaltyAccountsForYear`).
        addWithdrawal(split, 'roth', ownerId, row.withdrawn);
      } else {
        addWithdrawal(split, postBucket, ownerId, row.withdrawn);
      }
      continue;
    }
    // POST_TAX non-Roth: cash-like principal vs brokerage/OTHER LTCG proxy.
    addWithdrawal(split, cashLike ? 'postTaxCashLike' : 'postTaxNonRoth', ownerId, row.withdrawn);
  }
  return split;
}

/**
 * Build the per-account early-withdrawal / HSA penalty inputs for one
 * projection year from the current `DrawdownYear.accountBalances`.
 *
 * Penalty basis (`penaltyPreTaxWithdrawalDollars`):
 *   - PRE_TAX account → whole current-year withdrawal.
 *   - MIXED account → pre-tax tranche only (`preWithdrawnCents`); falls back to
 *     0 when the engine did not surface the split (no penalizable basis known).
 *   - POST_TAX / Roth / cash-like → 0 (no 10% basis).
 * HSA accounts carry `hsaWithdrawalDollars` (the 20% additional-tax path keys
 * off the nonqualified portion downstream).
 *
 * Returns `[]` when the year carries no per-account map (bucket-allocation
 * paths), so the penalty is simply not assessed on those approximation paths
 * (documented limitation — they lack per-account tax treatment).
 */
export function buildPenaltyAccountsForYear(
  ctx: PipelineContext,
  year: DrawdownYear,
): readonly PenaltyAccountSnapshot[] {
  if (!year.accountBalances) return [];
  const accountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  const out: PenaltyAccountSnapshot[] = [];
  for (const [id, row] of year.accountBalances.entries()) {
    const account = accountById.get(id);
    if (!account) continue;
    const { type, taxTreatment, ownerId } = account.payload;
    if (type === 'HSA') {
      // Carry the medical-qualified split so the tax pass excludes those
      // dollars from BOTH income and the 20% penalty basis; the emergency
      // residual is `withdrawn − medicalQualified` (the residual rule). Falls
      // back to 0 medical (whole draw = emergency) when the engine did not
      // surface the split (legacy / kernel approximation rows).
      // Carry the committed HSA withdrawal cents + the medical-qualified
      // cents so the tax pass derives the emergency residual in integer cents
      // (medical + emergency reconcile EXACTLY to the committed cents, no penny
      // drift). The dollar fields stay populated for legacy consumers.
      const hsaWithdrawalCents = Math.round(row.withdrawn * 100);
      const hsaMedicalQualifiedCents = row.medicalQualifiedWithdrawnCents ?? 0;
      out.push({
        id,
        type,
        ownerId,
        penaltyPreTaxWithdrawalDollars: 0,
        hsaWithdrawalDollars: row.withdrawn,
        hsaMedicalQualifiedDollars: hsaMedicalQualifiedCents / 100,
        hsaWithdrawalCents,
        hsaMedicalQualifiedCents,
      });
      continue;
    }
    if (isRothAccount(account.payload)) continue; // Roth → no penalty basis.
    let preTaxBasis = 0;
    if (taxTreatment === 'PRE_TAX') {
      preTaxBasis = row.withdrawn;
    } else if (taxTreatment === 'MIXED') {
      // §72(t) "includible in gross income" → pre-tax tranche only.
      preTaxBasis = row.preWithdrawnCents !== undefined ? row.preWithdrawnCents / 100 : 0;
    } else if (taxTreatment === 'HSA') {
      // Unreachable today: `'HSA'` treatment exists only on HSA-TYPE accounts,
      // which the type guard above already handled + continued. Kept as an
      // explicit no-op (no §72(t) pre-tax basis) so a future non-HSA-type
      // account carrying `'HSA'` treatment cannot silently regress.
      preTaxBasis = 0;
    }
    if (preTaxBasis <= 0) continue;
    out.push({
      id,
      type,
      ownerId,
      penaltyPreTaxWithdrawalDollars: preTaxBasis,
      hsaWithdrawalDollars: 0,
      // §72(t)(2)(A)(ii): a distribution from an INHERITED account is made
      // on account of the original owner's death and carries no 10% additional
      // tax at any beneficiary age (the beneficiary is in fact REQUIRED to take
      // it). The ordinary income tax on it is unaffected.
      ...(ctx.rmdProfileFactsByAccountId?.get(id)?.inheritedAccount === true
        ? { inheritedFromDeceasedOwner: true }
        : {}),
    });
  }
  return out;
}

/**
 * Build the early-withdrawal / HSA / Roth-earnings penalty inputs for the
 * cashflow solver's SECOND pass, from the converged trial
 * classification and the per-owner Roth basis carrier.
 *
 * The cashflow solver runs at household-aggregate granularity (the trial
 * classifier returns the four tax buckets, not a per-account split), so the
 * penalty is funded against the aggregate buckets:
 *   - the whole pre-tax bucket is the §72(t) 10% basis, attributed to the
 *     PRIMARY owner's birthdate (the engine's aggregate-solver stance —
 *     per-owner birthdate precision lives in the post-pass annotation);
 *   - the cash-like bucket's HSA share funds the 20% §223(f)(4) additional
 *     tax (folded via the HSA branch using the household emergency-HSA
 *     qualified% — the share of EMERGENCY HSA withdrawals treated as
 *     qualified; modeled medical-qualified withdrawals are always 100%
 *     qualified);
 *   - the Roth bucket is split into its §408A (Roth-IRA) and §402A (designated)
 *     slices by the classifier's committed designated subset
 *     (`rothDesignatedDollars`), and each slice runs the SAME fact-based
 *     ordering primitive its annotation twin runs. Dollar state is consumed PER
 *     OWNER via the classifier's per-account attribution
 *     (`rothIraDollarsByAccountId` / `rothDesignatedDollarsByAccountId` /
 *     `rothInheritedDesignatedDollarsByAccountId`): each drawn account's
 *     dollars charge that account's REAL owner's contribution basis + FIFO
 *     conversion lots (IRA slice) or pooled plan balance/basis/lots (§402A pro
 *     rata, designated slices) — never a housemate's, whatever the ledger
 *     order. Age and five-year qualification are reduced
 *     household-conservatively as a separate decision. Roth-IRA basis also
 *     never consumes a designated plan's rollover lots, nor the other way
 *     around. An attribution-free classification (hand-rolled callers) falls
 *     back to charging the selected ledger owner.
 *
 * This is the funding pass: the dollars it produces are folded into the
 * solver's `federalTaxCents` and raised into the year's withdrawal target so
 * the penalty reduces balances. The
 * exact per-account penalty (with each owner's birthdate) is still computed in
 * the annotation post-pass against the committed split, which owns the
 * displayed `earlyWithdrawalPenaltyCents`. Returns `[]` when no penalizable
 * basis exists. Mutates `rothBasisCarrier` AND `designatedRoth` in place
 * (consumes basis / lots / pooled balance for the year). The Roth taxable
 * excess (dollars) is returned separately so the caller can add it to the
 * solver's ordinary income; it is $0 for a QUALIFIED distribution (five-year
 * clock met + owner 59½ for the whole year) exactly as the annotation and MC
 * paths report.
 */
/**
 * Estimate the HSA share of the solver's aggregate cash-like withdrawal bucket.
 * The cash-like bucket lumps HSA principal with SAVINGS/MONEY_MARKET/CD
 * principal; only the HSA portion is the §223(f)(4) nonqualified-tax basis.
 *
 * The cashflow solver has no committed per-account draw at trial time, so the
 * HSA share is approximated as the HSA ledger account's balance share of ALL
 * cash-like ledger accounts' balances. Caps the result at the bucket total so
 * floating-point residue can never push it above the aggregate. When no
 * cash-like balance is recorded the share is 0 (no HSA basis assessed) — a
 * documented solver-pass approximation; the post-pass annotation owns the exact
 * per-account HSA draw.
 */
function hsaShareOfCashLike(
  hsaLedger: DrawdownAccountInput,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  cashLikeDollars: number,
): number {
  const ledgerBalance = (a: DrawdownAccountInput): number =>
    Math.max(0, a.initialPre + a.initialPost);
  let cashLikeBalanceTotal = 0;
  for (const a of ledgerAccounts) {
    if (a.accountType === 'HSA' || isCashLikeAccountType(a.accountType)) {
      cashLikeBalanceTotal += ledgerBalance(a);
    }
  }
  if (cashLikeBalanceTotal <= 0) return 0;
  const share = ledgerBalance(hsaLedger) / cashLikeBalanceTotal;
  return Math.min(cashLikeDollars, cashLikeDollars * share);
}

/**
 * HOUSEHOLD-conservative qualification reduction for one aggregate Roth slice
 * of the funding pass (one-sided — overstating tax, never understating).
 * FALLBACK-only: it applies when the classification carries no per-account
 * attribution (hand-rolled callers), where the slice pools every listed
 * owner's dollars with no owner information, so reading one ledger-picked
 * owner's clock/age would let ledger ORDER decide whether the whole
 * household's draw is tax-free. An attributed classification resolves
 * qualification per DRAWN owner from that owner's own facts instead — a pooled
 * reduction there would let an owner who drew NOTHING fund phantom tax on a
 * housemate's qualified draw. Across `ownerIds`:
 *   - 59½ holds only when EVERY owner reached it for the WHOLE year;
 *   - the five-year clock is the LATEST across owners and ABSENT when any owner
 *     lacks one (an unknown clock must not count as met);
 *   - `penaltyOwnerId` is the failing owner whose §72(t) half-birthday
 *     proration fraction is LARGEST — the penalty engine prorates the funded
 *     10% by the SNAPSHOT owner's birthdate, so attributing the snapshot to any
 *     already-59½ owner would zero out a base this reduction just decided is
 *     penalizable. A `null` fraction (missing/unparseable birthdate) never wins
 *     the attribution: the penalty engine would skip that owner entirely,
 *     under-funding the leg; when no failing owner has a usable fraction the
 *     caller's fallback (the ledger-picked owner) stands.
 */
function reduceRothSliceQualification(args: {
  readonly ownerIds: ReadonlySet<string>;
  readonly birthdateByOwner: ReadonlyMap<string, string | null | undefined>;
  readonly taxYear: number;
  readonly clockByOwner: (ownerId: string) => number | undefined;
  readonly fallbackPenaltyOwnerId: string;
}): {
  ownerReached59Half: boolean;
  fiveYearClock: number | undefined;
  penaltyOwnerId: string;
} {
  let ownerReached59Half = true;
  let latestClock: number | undefined;
  let clockMissing = false;
  let penaltyOwnerId = args.fallbackPenaltyOwnerId;
  let maxPenaltyFraction = 0;
  for (const ownerId of args.ownerIds) {
    const birthdate = args.birthdateByOwner.get(ownerId);
    if (!ownerReached59HalfForWholeYear(birthdate, args.taxYear)) {
      ownerReached59Half = false;
      const fraction = penaltyFractionForYear(birthdate, args.taxYear, {
        ageYears: 59,
        ageMonths: 6,
      });
      if (fraction !== null && fraction > maxPenaltyFraction) {
        maxPenaltyFraction = fraction;
        penaltyOwnerId = ownerId;
      }
    }
    const clock = args.clockByOwner(ownerId);
    if (clock === undefined) clockMissing = true;
    else latestClock = latestClock === undefined ? clock : Math.max(latestClock, clock);
  }
  return {
    ownerReached59Half,
    fiveYearClock: clockMissing ? undefined : latestClock,
    penaltyOwnerId,
  };
}

/**
 * Group a classifier's per-ACCOUNT attribution of one Roth slice into
 * per-OWNER integer cents that sum EXACTLY to the slice's cents. Each owner's
 * share is their attributed dollars scaled onto `sliceCents` with cumulative
 * rounding, and owners are visited in SORTED id order, so neither the split nor
 * the ±1¢ rounding remainder can depend on ledger order. Returns `undefined`
 * when the classification carries no positive attribution (hand-rolled
 * callers), which sends the caller to its single-ledger-owner fallback.
 */
function ownerCentsFromDrawAttribution(
  dollarsByAccountId: ReadonlyMap<string, number> | undefined,
  sliceCents: number,
  ownerOfAccount: (accountId: string) => string,
): Map<string, number> | undefined {
  if (dollarsByAccountId === undefined || sliceCents <= 0) return undefined;
  const dollarsByOwner = new Map<string, number>();
  let totalDollars = 0;
  for (const [accountId, dollars] of dollarsByAccountId) {
    if (!(dollars > 0)) continue;
    const ownerId = ownerOfAccount(accountId);
    dollarsByOwner.set(ownerId, (dollarsByOwner.get(ownerId) ?? 0) + dollars);
    totalDollars += dollars;
  }
  if (totalDollars <= 0) return undefined;
  const owners = [...dollarsByOwner.keys()].sort();
  const out = new Map<string, number>();
  let cumulativeDollars = 0;
  let allocatedCents = 0;
  owners.forEach((ownerId, i) => {
    cumulativeDollars += dollarsByOwner.get(ownerId) ?? 0;
    const cumulativeCents =
      i === owners.length - 1
        ? sliceCents
        : Math.min(sliceCents, Math.round((cumulativeDollars / totalDollars) * sliceCents));
    const cents = Math.max(0, cumulativeCents - allocatedCents);
    allocatedCents += cents;
    if (cents > 0) out.set(ownerId, cents);
  });
  return out;
}

/**
 * Allocate one drawn owner's §408A/§402A ADDITIONAL-TAX base back across that
 * owner's attributed accounts, in proportion to each account's attributed
 * dollars (accounts visited in SORTED id order with cumulative rounding, so
 * neither the split nor the ±1¢ remainder depends on ledger order; the parts
 * sum EXACTLY to `totalCents`). Mirrors the annotation pass's per-account
 * emission (`allocateByDraw`): the penalty engine waives a snapshot by
 * its ACCOUNT id (`earlyWithdrawalPenaltyExemptAccountIds`), so a
 * scenario-marked exempt account must waive only its OWN share of the base —
 * an aggregate snapshot under one ledger-picked id let a single exempt account
 * waive (or a single non-exempt account charge) every sibling account's share.
 */
function allocateSliceBaseByAccount(
  dollarsByAccountId: ReadonlyMap<string, number> | undefined,
  drawOwnerId: string,
  ownerOfAccount: (accountId: string) => string,
  totalCents: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (dollarsByAccountId === undefined || totalCents <= 0) return out;
  const entries: Array<[string, number]> = [];
  let totalDollars = 0;
  for (const [accountId, dollars] of dollarsByAccountId) {
    if (!(dollars > 0) || ownerOfAccount(accountId) !== drawOwnerId) continue;
    entries.push([accountId, dollars]);
    totalDollars += dollars;
  }
  if (totalDollars <= 0) return out;
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let cumulativeDollars = 0;
  let allocatedCents = 0;
  entries.forEach(([accountId, dollars], i) => {
    cumulativeDollars += dollars;
    const cumulativeCents =
      i === entries.length - 1
        ? totalCents
        : Math.min(totalCents, Math.round((cumulativeDollars / totalDollars) * totalCents));
    const cents = Math.max(0, cumulativeCents - allocatedCents);
    allocatedCents += cents;
    if (cents > 0) out.set(accountId, cents);
  });
  return out;
}

export function buildSolverPenaltyAccountsForYear(args: {
  readonly ctx: PipelineContext;
  /** The year being funded — dates the §402A(c)(4)(D) recapture windows below. */
  readonly taxYear: number;
  readonly ledgerAccounts: ReadonlyArray<DrawdownAccountInput>;
  readonly classification: {
    readonly preTaxDollars: number;
    readonly postTaxCashLikeDollars: number;
    readonly rothDollars: number;
    /** The INHERITED Roth IRA portion of `rothDollars` — a SUBSET, not a
     *  separate bucket, so every funded/taxed total keeps its current value and
     *  only the §408A carrier consumption below changes. */
    readonly rothInheritedTaxFreeDollars?: number;
    /** The committed NON-inherited DESIGNATED-Roth portion of `rothDollars`
     *  (`TaxCashflowYearClassification.rothDesignatedDollars`) — likewise a
     *  SUBSET, disjoint from the inherited one. It selects the slice that runs
     *  the pooled §402A pro-rata regime below; the remainder runs the §408A
     *  carrier. Absent / 0 ⇒ the whole tranche is the §408A slice. */
    readonly rothDesignatedDollars?: number;
    /** The committed INHERITED DESIGNATED-Roth portion of `rothDollars`
     *  (`TaxCashflowYearClassification.rothInheritedDesignatedDollars`) — a
     *  third disjoint SUBSET. It selects the slice that runs against the
     *  per-owner INHERITED designated state below, where the original owner's
     *  DEATH is the qualifying event (§402A(d)(2)(B)(i)) and the 10% is waived
     *  at any beneficiary age (§72(t)(2)(A)(ii)) — never the §408A carrier,
     *  whose ordering would tax those dollars as earnings excess and charge a
     *  10% the statute forbids. Absent / 0 ⇒ no inherited designated draw. */
    readonly rothInheritedDesignatedDollars?: number;
    /** Per-ACCOUNT attribution of the §408A Roth-IRA remainder slice
     *  (`TaxCashflowYearClassification.rothIraDollarsByAccountId`). When
     *  present, each account's dollars are grouped onto that account's REAL
     *  owner, charged against that owner's own carrier entry, AND qualified by
     *  that owner's own facts (their 59½ status + their carrier clock), with
     *  any additional-tax base emitted per REAL account id — the aggregate
     *  `rothDollars` carries no owner information, so without it a single
     *  ledger-picked owner's basis/lots absorbed the whole household slice and
     *  a pooled qualification reduction decided the tax. Absent (hand-rolled
     *  callers) ⇒ the single-ledger-owner, household-conservative fallback. */
    readonly rothIraDollarsByAccountId?: ReadonlyMap<string, number>;
    /** Per-ACCOUNT attribution of `rothDesignatedDollars`, same contract. */
    readonly rothDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
    /** Per-ACCOUNT attribution of `rothInheritedDesignatedDollars`, same
     *  contract. */
    readonly rothInheritedDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
    /** HSA dollars funded against medical demand (subset of the cash-like
     *  bucket). Narrows the §223 nonqualified basis to the emergency residual. */
    readonly hsaMedicalQualifiedDollars?: number;
    /** Classifier-modeled HSA TOTAL draw (medical-first + emergency). When
     *  supplied it replaces the balance-share estimate so the §223 emergency
     *  basis matches the committing medical-first kernel. */
    readonly hsaWithdrawalDollars?: number;
  };
  readonly rothBasisCarrier: RothBasisCarrier;
  /** The funding pass's per-owner pooled DESIGNATED-Roth state (basis,
   *  dated in-plan-rollover lots, participation clock, running pooled balance),
   *  accompanying `rothBasisCarrier` and mutated with it
   *  (`seedSolverDesignatedRothStates`). The designated slice charges each
   *  drawn owner's OWN entry via the classifier's attribution; the §408A
   *  carrier beside it holds Roth-IRA basis, which is not basis of a
   *  §402A(d)(4) distribution. Empty when the household records no
   *  designated-Roth facts. */
  readonly designatedRoth: SolverDesignatedRothStates;
  /** The INHERITED counterpart of `designatedRoth`: per-owner pooled state for
   *  INHERITED designated-Roth plans, each entry carrying
   *  `inheritedFromDeceasedOwner: true` so the original owner's death is the
   *  qualifying event and the 10% is waived
   *  (`seedSolverInheritedDesignatedRothStates`). Optional so hand-rolled
   *  callers with no inherited designated draw can omit it; absent with a
   *  positive inherited subset ⇒ the conservative $0-basis default below. */
  readonly inheritedDesignatedRoth?: SolverDesignatedRothStates;
}): { penaltyAccounts: readonly PenaltyAccountSnapshot[]; rothEarningsExcessDollars: number } {
  const { ctx, ledgerAccounts, classification, rothBasisCarrier } = args;
  const accountById = new Map(ctx.accountProjections.map((p) => [p.account.id, p.account]));
  const out: PenaltyAccountSnapshot[] = [];
  const primaryOwnerId = ctx.primary.id;

  // §72(t) pre-tax tranche (aggregate). Attribute to a representative pre-tax /
  // MIXED ledger account so the penalty engine resolves the owner birthdate;
  // fall back to the primary owner when no such ledger account exists.
  if (classification.preTaxDollars > 0) {
    const preTaxLedger = ledgerAccounts.find(
      (a) => a.taxTreatment === 'PRE_TAX' || a.taxTreatment === 'MIXED',
    );
    const account = preTaxLedger ? accountById.get(preTaxLedger.id) : undefined;
    out.push({
      id: preTaxLedger?.id ?? 'solver-pretax',
      type: (preTaxLedger?.accountType ?? 'RETIREMENT_IRA') as AccountType,
      ownerId: account?.payload.ownerId ?? primaryOwnerId,
      penaltyPreTaxWithdrawalDollars: classification.preTaxDollars,
      hsaWithdrawalDollars: 0,
    });
  }

  // HSA additional tax (cash-like bucket's HSA portion). The cash-like
  // bucket aggregates HSA principal AND SAVINGS/CD/MM principal; only the HSA
  // share is the §223(f)(4) nonqualified basis. Feeding the WHOLE bucket to the
  // HSA leg over-taxes savings/CD/MM principal as nonqualified HSA income + 20%
  // whenever `hsaQualifiedMedicalExpensePct < 100`. The solver runs at
  // household-aggregate granularity (no committed per-account draw at trial
  // time), so estimate the HSA share by the HSA ledger account's balance share
  // of all cash-like ledger accounts (a documented solver-pass approximation;
  // the post-pass annotation uses the exact per-account HSA draw). Savings/CD/MM
  // principal is never fed to the HSA leg.
  const hsaLedger = ledgerAccounts.find((a) => a.accountType === 'HSA');
  if (hsaLedger && classification.postTaxCashLikeDollars > 0) {
    const account = accountById.get(hsaLedger.id);
    // When the classifier supplies the medical-first HSA TOTAL draw
    // (`hsaWithdrawalDollars`), feed it directly so the §223 emergency basis
    // matches the committing medical-first kernel. Otherwise (the named-strategy
    // trial path, unchanged) estimate the HSA share of the aggregate cash-like
    // bucket by balance proportion — a documented solver-pass approximation.
    const hsaWithdrawalDollars =
      classification.hsaWithdrawalDollars !== undefined
        ? Math.max(0, classification.hsaWithdrawalDollars)
        : hsaShareOfCashLike(hsaLedger, ledgerAccounts, classification.postTaxCashLikeDollars);
    if (hsaWithdrawalDollars > 0) {
      // The classifier's medical-qualified HSA figure is already
      // HSA-specific (the HSA share of the cash-like draw, capped at demand), so
      // feed it through capped at this snapshot's HSA withdrawal. The tax pass
      // then narrows the §223 nonqualified basis to the emergency residual
      // identically to the committing post-pass.
      const hsaMedicalQualifiedDollars = Math.min(
        hsaWithdrawalDollars,
        Math.max(0, classification.hsaMedicalQualifiedDollars ?? 0),
      );
      const hsaWithdrawalCents = Math.round(hsaWithdrawalDollars * 100);
      const hsaMedicalQualifiedCents = Math.round(hsaMedicalQualifiedDollars * 100);
      out.push({
        id: hsaLedger.id,
        type: 'HSA',
        ownerId: account?.payload.ownerId ?? primaryOwnerId,
        penaltyPreTaxWithdrawalDollars: 0,
        hsaWithdrawalDollars,
        hsaMedicalQualifiedDollars,
        hsaWithdrawalCents,
        hsaMedicalQualifiedCents,
      });
    }
  }

  // Roth tranche: under the classifier's per-account attribution, dollar state
  // AND age/clock qualification are both resolved per DRAWN owner — each
  // owner's cents run against their own basis/lots/denominator, and their own
  // birthdate + their own carrier clock decide qualification, exactly the
  // annotation pass's inputs. Only an attribution-free classification
  // (hand-rolled callers) falls back to the household-conservative
  // qualification reduction, where pooled dollars carry no owner information.
  let rothEarningsExcessDollars = 0;
  // Inherited Roth IRA dollars leave the ordered withdrawal BEFORE the
  // carrier is touched, never netted off the earnings tranche afterwards: doing it
  // afterwards still exhausts the owner's OWN basis, and the following year's own
  // draw comes back wrongly taxable. They stay inside `classification.rothDollars`
  // (and so inside `rothWithdrawalDollars` / `fundedDollars`) — netting them out
  // there would silently move the effective-tax-rate gross-income denominator.
  const inheritedRothDollars = Math.min(
    Math.max(0, classification.rothDollars),
    Math.max(0, classification.rothInheritedTaxFreeDollars ?? 0),
  );
  const carrierRothDollars = classification.rothDollars - inheritedRothDollars;
  if (carrierRothDollars > 0) {
    const withdrawnCents = Math.round(carrierRothDollars * 100);
    // The committed DESIGNATED-Roth subset of the Roth bucket
    // (`classifyAccountDraw`), capped at the non-inherited total. Absent → 0
    // (no designated draw modeled), so the whole tranche runs the §408A slice.
    // This split is what keeps an unrelated Roth-IRA draw from ever consuming a
    // designated plan's in-plan-rollover lots — and a designated draw from ever
    // consuming §408A contribution basis.
    const designatedCents = Math.min(
      withdrawnCents,
      Math.round(Math.max(0, classification.rothDesignatedDollars ?? 0) * 100),
    );
    // The INHERITED designated subset (disjoint from the non-inherited one):
    // those dollars run their own slice below — the original owner's death is
    // the qualifying event and none of their principal is recapture-bearing —
    // never the §408A carrier and never the non-inherited pooled state.
    const inheritedDesignatedCents = Math.min(
      withdrawnCents - designatedCents,
      Math.round(Math.max(0, classification.rothInheritedDesignatedDollars ?? 0) * 100),
    );
    const iraCents = withdrawnCents - designatedCents - inheritedDesignatedCents;
    const birthdateByOwner = new Map<string, string | null | undefined>([
      [ctx.primary.id, ctx.primary.payload.birthdate],
    ]);
    if (ctx.secondary) {
      birthdateByOwner.set(ctx.secondary.id, ctx.secondary.payload.birthdate);
    }
    let taxableExcessCents = 0;

    if (iraCents > 0) {
      // This slice holds only NON-inherited, non-designated Roth dollars, so
      // the inherited Roth IRA that contributed none of them must not decide
      // whose carrier entry they are charged against — it has no carrier entry,
      // and picking it would score the whole tranche as earnings excess. Skip it
      // so the fallbacks can find the account the dollars came from. The
      // employer-Roth fallbacks remain for classifications that carry no
      // designated subsets (hand-rolled callers): those dollars land here. An
      // INHERITED designated plan's dollars carry their own classifier subset
      // and run the inherited slice below, never this carrier.
      // Optional-chained: hand-rolled test contexts may omit the map, and a
      // missing map simply means "no recorded facts" → not inherited.
      const rothLedger =
        ledgerAccounts.find(
          (a) =>
            a.accountType === 'RETIREMENT_ROTH_IRA' &&
            ctx.rmdProfileFactsByAccountId?.get(a.id)?.inheritedAccount !== true,
        ) ??
        ledgerAccounts.find((a) => isPureRothEmployerType(a.accountType)) ??
        ledgerAccounts.find(
          (a) =>
            a.taxTreatment === 'MIXED' && isRothDesignatedPostBucket(a.taxTreatment, a.accountType),
        );
      const ownerId =
        (rothLedger ? accountById.get(rothLedger.id)?.payload.ownerId : undefined) ??
        primaryOwnerId;
      // Dollar consumption is PER OWNER: the classifier's per-account
      // attribution (`rothIraDollarsByAccountId`) groups each drawn account's
      // dollars onto that account's REAL owner, and each owner's cents run the
      // SAME §408A ordering the annotation pass runs (contribution basis first,
      // conversion lots FIFO with their own five-tax-year recapture windows,
      // then earnings) against THAT owner's own entry — never a housemate's, so
      // ledger order can neither pick who pays nor whose basis shields whom.
      // A classification with no attribution (hand-rolled callers) falls back
      // to charging the selected ledger owner, exactly the prior behaviour.
      const ownerCents = ownerCentsFromDrawAttribution(
        classification.rothIraDollarsByAccountId,
        iraCents,
        (accountId) => accountById.get(accountId)?.payload.ownerId ?? primaryOwnerId,
      );
      // §408A qualification: under attribution the dollars identify their
      // owner, so each drawn owner's OWN facts decide — their own 59½ status
      // and their own carrier entry's five-year clock, exactly the annotation
      // pass's per-pool inputs. An owner who drew NOTHING can therefore never
      // turn a housemate's qualified draw into funded phantom income or a
      // phantom 10%. Only WITHOUT attribution does the slice pool every
      // owner's Roth-IRA dollars ownerlessly, and only there does the
      // HOUSEHOLD-conservative reduction (`reduceRothSliceQualification`)
      // apply: across every owner holding a NON-inherited Roth-IRA ledger
      // account, the clock is the LATEST and ABSENT when any of them lacks
      // one, and 59½ holds only when EVERY such owner reached it for the whole
      // year — overstating tax, never understating. The fallback
      // snapshot's OWNER is the reduction's `penaltyOwnerId`, because the
      // penalty engine prorates the funded 10% by that owner's birthdate.
      let fallbackReached59Half = false;
      let fallbackClock: number | undefined;
      let penaltyOwnerId = ownerId;
      if (ownerCents === undefined) {
        const iraOwnerIds = new Set<string>();
        for (const a of ledgerAccounts) {
          if (
            a.accountType === 'RETIREMENT_ROTH_IRA' &&
            ctx.rmdProfileFactsByAccountId?.get(a.id)?.inheritedAccount !== true
          ) {
            iraOwnerIds.add(accountById.get(a.id)?.payload.ownerId ?? primaryOwnerId);
          }
        }
        if (iraOwnerIds.size > 0) {
          const reduced = reduceRothSliceQualification({
            ownerIds: iraOwnerIds,
            birthdateByOwner,
            taxYear: args.taxYear,
            clockByOwner: (id) => rothBasisCarrier.get(id)?.firstContributionTaxYear,
            fallbackPenaltyOwnerId: ownerId,
          });
          fallbackReached59Half = reduced.ownerReached59Half;
          fallbackClock = reduced.fiveYearClock;
          penaltyOwnerId = reduced.penaltyOwnerId;
        } else {
          fallbackReached59Half = ownerReached59HalfForWholeYear(
            birthdateByOwner.get(ownerId),
            args.taxYear,
          );
          fallbackClock = householdRothIraClock(rothBasisCarrier);
        }
      }
      let additionalTaxBaseCents = 0;
      for (const [drawOwnerId, cents] of ownerCents ?? new Map([[ownerId, iraCents]])) {
        const entry = rothBasisCarrier.get(drawOwnerId) ?? {
          rothBasisRemainingCents: 0,
          rothCumulativeWithdrawnCents: 0,
        };
        rothBasisCarrier.set(drawOwnerId, entry);
        const result = applyFactBasedRothIraOrdering(entry, {
          withdrawalCents: cents,
          distributionTaxYear: args.taxYear,
          ownerReached59Half:
            ownerCents !== undefined
              ? ownerReached59HalfForWholeYear(
                  birthdateByOwner.get(drawOwnerId),
                  args.taxYear,
                )
              : fallbackReached59Half,
          // The owner's own carrier clock under attribution (a default entry
          // carries none → conservatively unmet); the household-
          // conservative clock otherwise.
          firstContributionTaxYear:
            ownerCents !== undefined ? entry.firstContributionTaxYear : fallbackClock,
        });
        taxableExcessCents += result.incomeTaxableCents;
        if (ownerCents !== undefined) {
          // `rothOrderedAdditionalTaxBase`: the ordering engine already
          // resolved every source-level exemption, so the penalty engine
          // applies the 10% (with its own half-birthday proration) without
          // re-testing the type. Emitted per REAL account id (mirroring the
          // annotation pass) so a scenario-marked exempt Roth IRA waives
          // only its own share; the OWNER is the drawn owner, whose birthdate
          // drives the same proration their qualification above used.
          for (const [accountId, baseCents] of allocateSliceBaseByAccount(
            classification.rothIraDollarsByAccountId,
            drawOwnerId,
            (id) => accountById.get(id)?.payload.ownerId ?? primaryOwnerId,
            result.additionalTaxBaseCents,
          )) {
            out.push({
              id: accountId,
              type: accountById.get(accountId)?.payload.type ?? 'RETIREMENT_ROTH_IRA',
              ownerId: drawOwnerId,
              penaltyPreTaxWithdrawalDollars: baseCents / 100,
              rothOrderedAdditionalTaxBase: true,
              hsaWithdrawalDollars: 0,
            });
          }
        } else {
          additionalTaxBaseCents += result.additionalTaxBaseCents;
        }
      }
      if (ownerCents === undefined && additionalTaxBaseCents > 0) {
        out.push({
          id: rothLedger?.id ?? 'solver-roth',
          type: rothLedger?.accountType ?? 'RETIREMENT_ROTH_IRA',
          ownerId: penaltyOwnerId,
          penaltyPreTaxWithdrawalDollars: additionalTaxBaseCents / 100,
          rothOrderedAdditionalTaxBase: true,
          hsaWithdrawalDollars: 0,
        });
      }
    }

    if (designatedCents > 0) {
      // Only a NON-inherited designated plan may name the owner this slice is
      // charged to: `classifyAccountDraw` keeps inherited designated dollars
      // out of this subset (they run the inherited slice below), so an
      // inherited plan is guaranteed to hold none of these dollars — the same
      // predicate the §408A pick above applies to an inherited Roth IRA.
      // Without it an inherited plan first in ledger order captures the whole
      // slice and runs it against a fabricated $0-basis state for an owner who
      // drew nothing.
      const notInherited = (a: DrawdownAccountInput): boolean =>
        ctx.rmdProfileFactsByAccountId?.get(a.id)?.inheritedAccount !== true;
      const isMixedDesignated = (a: DrawdownAccountInput): boolean =>
        a.taxTreatment === 'MIXED' && isRothDesignatedPostBucket(a.taxTreatment, a.accountType);
      const designatedLedger =
        ledgerAccounts.find((a) => isPureRothEmployerType(a.accountType) && notInherited(a)) ??
        ledgerAccounts.find((a) => isMixedDesignated(a) && notInherited(a));
      const ownerId =
        (designatedLedger ? accountById.get(designatedLedger.id)?.payload.ownerId : undefined) ??
        primaryOwnerId;
      // Dollar consumption is PER OWNER, exactly like the §408A slice above:
      // the classifier's attribution (`rothDesignatedDollarsByAccountId`)
      // groups each drawn plan's dollars onto its real owner, and each owner's
      // cents run the §402A(d)(4) pro-rata against THAT owner's own pooled
      // running balance (never below the owner's draw, so the basis fraction
      // can never exceed 1) — the same fallback denominator MC's pooled slice
      // uses. Delegates the split AND the ordered lot allocation to
      // `computeDesignatedRothDistribution` / `allocateDesignatedRothBasis`
      // (single source of truth), so the funded recapture is the pro-rata
      // in-window figure, never taxable-first. An attribution-free
      // classification (hand-rolled callers) falls back to charging the
      // selected ledger owner.
      const ownerCents = ownerCentsFromDrawAttribution(
        classification.rothDesignatedDollarsByAccountId,
        designatedCents,
        (accountId) => accountById.get(accountId)?.payload.ownerId ?? primaryOwnerId,
      );
      // §402A qualification, exactly like the §408A slice above: under
      // attribution each drawn owner's OWN facts decide — their own 59½ status
      // and their own pooled state's participation clock (the annotation
      // pass's per-account inputs), so a non-drawing owner's open clock or age
      // can never fund phantom tax on a housemate's qualified draw. Only an
      // attribution-free classification pools every owner's non-inherited
      // designated dollars ownerlessly, and only there does the HOUSEHOLD-
      // conservative reduction apply: 59½ only when EVERY such owner reached
      // it for the whole year, the participation clock the LATEST and ABSENT
      // when any owner lacks one — overstating tax, never understating.
      // The fallback snapshot's OWNER is the reduction's `penaltyOwnerId` so
      // the penalty engine's per-owner proration matches the qualification
      // assumption.
      let fallbackReached59Half = false;
      let fallbackClock: number | undefined;
      let penaltyOwnerId = ownerId;
      if (ownerCents === undefined) {
        const designatedOwnerIds = new Set<string>();
        for (const a of ledgerAccounts) {
          if ((isPureRothEmployerType(a.accountType) || isMixedDesignated(a)) && notInherited(a)) {
            designatedOwnerIds.add(accountById.get(a.id)?.payload.ownerId ?? primaryOwnerId);
          }
        }
        if (designatedOwnerIds.size > 0) {
          const reduced = reduceRothSliceQualification({
            ownerIds: designatedOwnerIds,
            birthdateByOwner,
            taxYear: args.taxYear,
            clockByOwner: (id) => args.designatedRoth.get(id)?.entry.firstParticipationTaxYear,
            fallbackPenaltyOwnerId: ownerId,
          });
          fallbackReached59Half = reduced.ownerReached59Half;
          fallbackClock = reduced.fiveYearClock;
          penaltyOwnerId = reduced.penaltyOwnerId;
        } else {
          fallbackReached59Half = ownerReached59HalfForWholeYear(
            birthdateByOwner.get(ownerId),
            args.taxYear,
          );
          fallbackClock = householdDesignatedRothClock(args.designatedRoth);
        }
      }
      // A drawn owner with NO recorded designated facts gets the annotation
      // pass's on-demand conservative default: $0 basis, no lots, unmet
      // clock — the whole share is earnings. Under attribution its §72(t)(9)
      // carve-out flag is granted only when EVERY non-inherited designated
      // ledger account of THAT owner is a governmental 457(b)
      // (order-independent; a non-457(b) sibling's genuine 10% is never
      // waived); the fallback keeps the selected ledger's flag.
      const ownerAll457b = (forOwnerId: string): boolean => {
        let any = false;
        for (const a of ledgerAccounts) {
          if (!(isPureRothEmployerType(a.accountType) || isMixedDesignated(a))) continue;
          if (!notInherited(a)) continue;
          if ((accountById.get(a.id)?.payload.ownerId ?? primaryOwnerId) !== forOwnerId) continue;
          any = true;
          if (!isGovernmental457bType(a.accountType)) return false;
        }
        return any;
      };
      let additionalTaxBaseCents = 0;
      for (const [drawOwnerId, cents] of ownerCents ?? new Map([[ownerId, designatedCents]])) {
        let state = args.designatedRoth.get(drawOwnerId);
        if (state === undefined) {
          state = {
            entry: {
              accountId: `solver-designated:${drawOwnerId}`,
              ownerId: drawOwnerId,
              designatedRothBasisRemainingCents: 0,
              inPlanRolloverLots: [],
              isGovernmental457b:
                ownerCents !== undefined
                  ? ownerAll457b(drawOwnerId)
                  : designatedLedger !== undefined &&
                    isGovernmental457bType(designatedLedger.accountType),
            },
            balanceRemainingCents: 0,
          };
          args.designatedRoth.set(drawOwnerId, state);
        }
        const balanceCents = Math.max(state.balanceRemainingCents, cents);
        const result = applyFactBasedDesignatedRothDistribution(state.entry, {
          accountBalanceCents: balanceCents,
          withdrawalCents: cents,
          distributionTaxYear: args.taxYear,
          ownerReached59Half:
            ownerCents !== undefined
              ? ownerReached59HalfForWholeYear(
                  birthdateByOwner.get(drawOwnerId),
                  args.taxYear,
                )
              : fallbackReached59Half,
          // Under attribution the entry's OWN participation clock governs (the
          // on-demand default above carries none → conservatively unmet);
          // the household-conservative clock replaces it otherwise.
          ...(ownerCents !== undefined
            ? {}
            : { pooledParticipationClock: { firstParticipationTaxYear: fallbackClock } }),
        });
        state.balanceRemainingCents = Math.max(0, balanceCents - cents);
        taxableExcessCents += result.incomeTaxableCents;
        if (ownerCents !== undefined) {
          // Per REAL account id under attribution (mirrors the annotation
          // pass): a scenario-marked exempt plan waives only its own
          // share, and the drawn owner's birthdate drives the proration.
          for (const [accountId, baseCents] of allocateSliceBaseByAccount(
            classification.rothDesignatedDollarsByAccountId,
            drawOwnerId,
            (id) => accountById.get(id)?.payload.ownerId ?? primaryOwnerId,
            result.additionalTaxBaseCents,
          )) {
            out.push({
              id: accountId,
              type: accountById.get(accountId)?.payload.type ?? 'RETIREMENT_ROTH_401K',
              ownerId: drawOwnerId,
              penaltyPreTaxWithdrawalDollars: baseCents / 100,
              rothOrderedAdditionalTaxBase: true,
              hsaWithdrawalDollars: 0,
            });
          }
        } else {
          additionalTaxBaseCents += result.additionalTaxBaseCents;
        }
      }
      if (ownerCents === undefined && additionalTaxBaseCents > 0) {
        out.push({
          id: designatedLedger?.id ?? 'solver-roth-designated',
          type: designatedLedger?.accountType ?? 'RETIREMENT_ROTH_401K',
          ownerId: penaltyOwnerId,
          penaltyPreTaxWithdrawalDollars: additionalTaxBaseCents / 100,
          rothOrderedAdditionalTaxBase: true,
          hsaWithdrawalDollars: 0,
        });
      }
    }

    // INHERITED designated slice: the original owner's DEATH is the qualifying
    // event (§402A(d)(2)(B)(i)), so the slice runs the same §402A pro-rata
    // primitive against the per-owner INHERITED pooled state — whose entries
    // carry `inheritedFromDeceasedOwner: true` — and can fund ordinary income
    // on nonqualified earnings (unmet participation clock) but never a 10%
    // additional tax (§72(t)(2)(A)(ii) waives it at any beneficiary age, so no
    // penalty snapshot is ever emitted here). These dollars deliberately never
    // touch the §408A carrier (whose ordering would score them as earnings
    // excess and charge a 10% the statute waives — tax the annotation post-pass
    // never reports) nor the non-inherited pooled state (none of their
    // principal is recapture-bearing, and an inherited plan's basis must not
    // shield a sibling plan's lots).
    if (inheritedDesignatedCents > 0) {
      const inheritedStates: SolverDesignatedRothStates =
        args.inheritedDesignatedRoth ?? new Map();
      const isInheritedDesignated = (a: DrawdownAccountInput): boolean =>
        (isPureRothEmployerType(a.accountType) ||
          (a.taxTreatment === 'MIXED' &&
            isRothDesignatedPostBucket(a.taxTreatment, a.accountType))) &&
        ctx.rmdProfileFactsByAccountId?.get(a.id)?.inheritedAccount === true;
      const inheritedLedger = ledgerAccounts.find(isInheritedDesignated);
      const ownerId =
        (inheritedLedger
          ? accountById.get(inheritedLedger.id)?.payload.ownerId
          : undefined) ?? primaryOwnerId;
      // Dollar consumption is PER BENEFICIARY, mirroring the two slices above:
      // the classifier's attribution groups each inherited plan's dollars onto
      // the beneficiary who actually drew them, so one beneficiary's basis can
      // never shield another's draw and ledger order picks nothing. The
      // attribution-free fallback charges the selected ledger owner.
      const ownerCents = ownerCentsFromDrawAttribution(
        classification.rothInheritedDesignatedDollarsByAccountId,
        inheritedDesignatedCents,
        (accountId) => accountById.get(accountId)?.payload.ownerId ?? primaryOwnerId,
      );
      // The participation clock, exactly like the two slices above: under
      // attribution each drawn beneficiary's OWN pooled entry carries their
      // clock (the on-demand default below carries none → conservatively
      // unmet), so a non-drawing beneficiary's open clock can never fund
      // phantom income on a housemate's met-clock draw. Only an
      // attribution-free classification reduces HOUSEHOLD-conservatively:
      // across every owner holding an INHERITED designated ledger account, the
      // clock is the LATEST and ABSENT when any owner lacks one. The
      // reduction's 59½/penalty legs are unused here because the death event
      // decides qualification and §72(t)(2)(A)(ii) waives the 10%.
      let fallbackClock: number | undefined;
      if (ownerCents === undefined) {
        const inheritedDesignatedOwnerIds = new Set<string>();
        for (const a of ledgerAccounts) {
          if (isInheritedDesignated(a)) {
            inheritedDesignatedOwnerIds.add(
              accountById.get(a.id)?.payload.ownerId ?? primaryOwnerId,
            );
          }
        }
        fallbackClock =
          inheritedDesignatedOwnerIds.size > 0
            ? reduceRothSliceQualification({
                ownerIds: inheritedDesignatedOwnerIds,
                birthdateByOwner,
                taxYear: args.taxYear,
                clockByOwner: (id) =>
                  inheritedStates.get(id)?.entry.firstParticipationTaxYear,
                fallbackPenaltyOwnerId: primaryOwnerId,
              }).fiveYearClock
            : householdDesignatedRothClock(inheritedStates);
      }
      for (const [drawOwnerId, cents] of ownerCents ??
        new Map([[ownerId, inheritedDesignatedCents]])) {
        let state = inheritedStates.get(drawOwnerId);
        if (state === undefined) {
          // No recorded facts for this beneficiary — conservative default:
          // $0 basis, no lots, unmet clock, so the whole share is nonqualified
          // earnings (ordinary income; the inherited flag still waives the 10%).
          state = {
            entry: {
              accountId: `solver-inherited-designated:${drawOwnerId}`,
              ownerId: drawOwnerId,
              designatedRothBasisRemainingCents: 0,
              inPlanRolloverLots: [],
              isGovernmental457b: false,
              inheritedFromDeceasedOwner: true,
            },
            balanceRemainingCents: 0,
          };
          inheritedStates.set(drawOwnerId, state);
        }
        const balanceCents = Math.max(state.balanceRemainingCents, cents);
        const result = applyFactBasedDesignatedRothDistribution(state.entry, {
          accountBalanceCents: balanceCents,
          withdrawalCents: cents,
          distributionTaxYear: args.taxYear,
          // The death event, not any owner's age, decides qualification here
          // (the selected entry's `inheritedFromDeceasedOwner` flag carries it,
          // and the same flag zeroes the additional-tax base), so `false` keeps
          // this input conservative without changing the primitive's result.
          ownerReached59Half: false,
          // Under attribution the entry's OWN participation clock governs; the
          // household-conservative clock replaces it otherwise.
          ...(ownerCents !== undefined
            ? {}
            : { pooledParticipationClock: { firstParticipationTaxYear: fallbackClock } }),
        });
        state.balanceRemainingCents = Math.max(0, balanceCents - cents);
        taxableExcessCents += result.incomeTaxableCents;
      }
    }

    rothEarningsExcessDollars = taxableExcessCents / 100;
  }

  return { penaltyAccounts: out, rothEarningsExcessDollars };
}

/**
 * Per-owner at-retirement DESIGNATED-Roth pocket balance (integer cents) — the
 * seed for the funding pass's pooled §402A(d)(4) pro-rata denominator
 * (`seedSolverDesignatedRothStates`). Mirrors the MC pool's composition
 * (`mcDesignatedRothPoolBalanceDollars`): a PURE Roth employer account
 * contributes its whole ledger balance, a MIXED Roth-designated account only
 * its POST (Roth-designated) sub-bucket, everything else nothing. By default an
 * INHERITED plan contributes nothing — its draws run the separate INHERITED
 * slice (§72(t)(2)(A)(ii)); pass `inherited: true` to size THAT slice's
 * denominator instead (only inherited plans contribute).
 */
export function solverDesignatedRothBalanceCentsByOwner(
  ctx: PipelineContext,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  inherited = false,
): Map<string, number> {
  const accountById = new Map(ctx.accountProjections.map((p) => [p.account.id, p.account]));
  const out = new Map<string, number>();
  for (const a of ledgerAccounts) {
    const account = accountById.get(a.id);
    if (!account) continue;
    if ((ctx.rmdProfileFactsByAccountId?.get(a.id)?.inheritedAccount === true) !== inherited)
      continue;
    let dollars = 0;
    if (isPureRothEmployerType(a.accountType)) {
      dollars = Math.max(0, a.initialPre) + Math.max(0, a.initialPost);
    } else if (
      a.taxTreatment === 'MIXED' &&
      isRothDesignatedPostBucket(a.taxTreatment, a.accountType)
    ) {
      dollars = Math.max(0, a.initialPost);
    } else {
      continue;
    }
    const ownerId = account.payload.ownerId;
    out.set(ownerId, (out.get(ownerId) ?? 0) + Math.round(dollars * 100));
  }
  return out;
}

/** Count living taxpayers age 65+ in the given tax year.
 *  Deceased members (primaryAlive / secondaryAlive = false) are excluded. */
export function countTaxpayersAge65Plus(
  ctx: PipelineContext,
  taxYear: number,
  primaryAlive: boolean,
  secondaryAlive: boolean,
): number {
  let count = 0;
  const countMember = (member: Aggregate<{ birthdate?: string | null }>): void => {
    // Born-Jan-1 rule applied via hasAttainedAgeByYearEnd.
    if (hasAttainedAgeByYearEnd(member.payload.birthdate, taxYear, 65)) count += 1;
  };
  if (primaryAlive) countMember(ctx.primary);
  if (ctx.secondary && secondaryAlive) countMember(ctx.secondary);
  return count;
}

/**
 * RMD shortfall measured against the IRS-aggregated pool minimum
 * (integer cents).
 *
 * Household netting hides a single account's missed RMD: account A overshooting
 * its required minimum can mask account B falling short, so a household-level
 * `max(0, rmdFloorCents − totalPreTaxWithdrawn)` reports $0 even though B is
 * non-compliant. But the strict per-ACCOUNT figure over-counts the other way:
 * the IRS lets a required minimum be satisfied across aggregated accounts (all
 * of one owner's traditional IRAs pool together; all of one owner's 403(b)s
 * pool together), so taking the whole IRA minimum from one of several IRAs is
 * fully compliant and must NOT show a shortfall.
 *
 * This groups each account's required minimum + pre-tax withdrawal into its IRS
 * pool (`poolKeyForRmdAccount`), sums `required` and `withdrawn` within each
 * pool, then `shortfall = Σ_pools max(0, poolRequired − poolWithdrawn)`. Within
 * an aggregable pool one account's overshoot legitimately covers a sibling's
 * under-draw; across pools / owners / non-aggregable plans (each 401(k),
 * 457(b), TSP, cash-balance is a singleton pool) a real miss still surfaces.
 *
 * Per-account satisfying withdrawal cents (the pool-withdrawn contribution) come
 * from the SHARED `rmdEligibleWithdrawnCents` rule:
 *   - PRE_TAX account → whole `withdrawn`.
 *   - MIXED account   → the pre-tax tranche (`preWithdrawnCents`), or 0 when the
 *     engine did not surface the split (conservative — Roth/post dollars cannot
 *     mask a pre-tax pool miss).
 *   - PURE Roth account → whole `withdrawn`. Only an INHERITED Roth account ever
 *     carries a required amount (a living Roth owner has none), and a beneficiary
 *     distribution satisfies §401(a)(9)(B) regardless of being untaxed.
 *   - HSA → nothing (never RMD-subject).
 *
 * An id with no resolvable account (orphan) falls into its own singleton pool
 * keyed by the bare id (never dropped, never throws). Pool summation is over
 * already-rounded integer-cent shares → order-independent.
 *
 * QCD-satisfied IRA RMD: a Qualified Charitable Distribution is debited
 * directly to the source IRA's pre-tax bucket (never written to
 * `accountBalances[*].withdrawn`) and COUNTS TOWARD the owner's IRA RMD (IRC
 * §408(d)(8)). The engine stamps the per-owner IRA-pool offset on
 * `year.qcdRmdOffsetCentsByOwner`; this credits each owner's offset to that
 * owner's IRA aggregation pool's `withdrawn` (scoped to `::pool:IRA` ONLY, never
 * the 401k/457/TSP/CBP pools) so an over-RMD QCD year shows no phantom shortfall.
 *
 * Returns `null` when the per-account map is empty or the year carries no
 * `accountBalances` map (bucket-allocation paths) — the caller then falls
 * back to the household-level shortfall.
 */
export function derivePerAccountRmdShortfallCents(
  ctx: PipelineContext,
  year: DrawdownYear,
  rmdPerAccountCents: Record<string, number>,
): number | null {
  const accountBalances = year.accountBalances;
  if (!accountBalances) return null;
  const ids = Object.keys(rmdPerAccountCents);
  if (ids.length === 0) return null;
  const accountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  // Pool required + withdrawn within each IRS aggregation pool, then take the
  // positive part per pool (not per account).
  const poolRequired = new Map<string, number>();
  const poolWithdrawn = new Map<string, number>();
  // Seed each owner's IRA pool with the QCD RMD offset that satisfied it.
  // `poolKeyForRmdAccount(ownerId, 'RETIREMENT_IRA', _)` ignores the account-id
  // argument for IRAs (returns `${ownerId}::pool:IRA`), so the credit lands on
  // exactly the IRA pool — never an employer-plan pool.
  for (const [ownerId, offsetCents] of Object.entries(
    year.qcdRmdOffsetCentsByOwner ?? {},
  )) {
    if (offsetCents <= 0) continue;
    const iraPoolKey = poolKeyForRmdAccount(ownerId, 'RETIREMENT_IRA', ownerId);
    poolWithdrawn.set(iraPoolKey, (poolWithdrawn.get(iraPoolKey) ?? 0) + offsetCents);
  }
  for (const id of ids) {
    const requiredCents = rmdPerAccountCents[id];
    if (requiredCents <= 0) continue;
    const account = accountById.get(id);
    // Orphan id (no resolvable account) → own singleton pool keyed by the bare
    // id (RETIREMENT_401K → `${id}::acct:${id}`); never deref undefined.
    // An INHERITED account never aggregates (not with the beneficiary's own
    // IRAs, not with another decedent's) — `poolKeyForRmdAccount` gives it a
    // singleton key so a compliant own-IRA draw can never cover an inherited
    // minimum (or vice versa).
    const poolKey = account
      ? poolKeyForRmdAccount(
          account.payload.ownerId,
          account.payload.type,
          id,
          // Optional-chained: hand-rolled test contexts may omit the map, and a
          // missing map simply means "no recorded facts" → not inherited.
          ctx.rmdProfileFactsByAccountId?.get(id)?.inheritedAccount === true,
        )
      : poolKeyForRmdAccount(id, 'RETIREMENT_401K', id);
    const row = accountBalances.get(id);
    // Delegate to the SHARED `rmdEligibleWithdrawnCents` rule instead of
    // re-spelling the treatment cases here, so this surface, `hasRmdShortfall`
    // and the MC post-pass cannot disagree about what satisfies a requirement
    // (an inlined copy that counted no Roth cents at all would leave an
    // inherited Roth account short in every year).
    const satisfyingWithdrawnCents =
      row && account ? rmdEligibleWithdrawnCents(row, account.payload.taxTreatment) : 0;
    poolRequired.set(poolKey, (poolRequired.get(poolKey) ?? 0) + requiredCents);
    poolWithdrawn.set(
      poolKey,
      (poolWithdrawn.get(poolKey) ?? 0) + satisfyingWithdrawnCents,
    );
  }
  return sumPoolShortfallCents(poolRequired, poolWithdrawn);
}

// ---------------------------------------------------------------------------
// Per-tax-unit filing-plan bridge
// ---------------------------------------------------------------------------
//
// These build the inputs the transition-safe `resolveFilingPlanForYear`
// (filing-status.ts) needs, from the pipeline context. `buildFilingPlanContextForYear`
// is consumed by the deterministic runner's `resolveTaxUnitsForYear`, which layers
// the scenario's `taxFilingPlan` on top.

/** Parse an ISO birthdate's four-digit year, or `undefined` when unparseable. */
function birthYearOf(isoBirthdate: string | null | undefined): number | undefined {
  if (!isoBirthdate) return undefined;
  const y = parseInt(isoBirthdate.slice(0, 4), 10);
  return Number.isNaN(y) ? undefined : y;
}

/**
 * Build the `FilingPlanContext` for one projection year from the pipeline
 * context. Sources: `ctx.secondary` presence (household cardinality), the
 * per-year alive flags the caller already computed, the legacy scalar
 * `filingStatus` override, and each member's birth year (for age-anchored
 * `statusWindows`). The scenario's `taxFilingPlan` is deliberately left
 * `undefined` here so this stays a pure context factory; the deterministic
 * runner's `resolveTaxUnitsForYear` layers the stored plan on top. With no plan
 * the resolver derives one from the scalar × household-cardinality matrix,
 * exactly as it does when nothing is stored.
 *
 * DETERMINISTIC-ONLY. The Monte Carlo engine reads its facts from the
 * serializable `McTaxContext` (which crosses a worker boundary and has no
 * `PipelineContext`), so it builds its own `FilingPlanContext` in
 * `resolveMcFilingForYear` rather than sharing this builder.
 */
export function buildFilingPlanContextForYear(
  ctx: PipelineContext,
  taxYear: number,
  primaryAlive: boolean,
  secondaryAlive: boolean,
): FilingPlanContext {
  const override = ctx.resolvedScenario.filingStatus ?? undefined;
  return {
    filingStatusOverride: override as FilingStatusOverride | undefined,
    hasSecondaryMember: ctx.secondary !== undefined,
    primaryAlive,
    secondaryAlive,
    taxYear,
    primaryBirthYear: birthYearOf(ctx.primary.payload.birthdate),
    secondaryBirthYear: birthYearOf(ctx.secondary?.payload.birthdate),
  };
}

/**
 * THE canonical calendar year in which one member is
 * projected to die (`birth year + life-expectancy age`), or `undefined` when it
 * cannot be derived. Death is modelled as Dec 31 of the returned year, so the
 * member is alive through all of it.
 *
 * UNKNOWN BIRTHDATE ⇒ NO DEATH YEAR ⇒ ALIVE INDEFINITELY. The two engines must
 * not answer this differently: parsing the leading four characters with
 * `parseInt` returns `NaN` for an imported non-numeric birthdate, and every
 * `taxYear <= NaN` comparison is `false`, so the member would read as DEAD IN
 * EVERY YEAR, while the Monte Carlo side's `undefined` reads as alive. A
 * household with one malformed birthdate would then price different household
 * sizes into `computeAcaPtc` on the two engines — different
 * subsidies for the same plan. "Alive" is the chosen semantics because it is
 * what BOTH engines already did for an ABSENT birthdate (so only the malformed
 * case moves), because silently deleting a member from every projection year is
 * the far more destructive failure, and because `NaN` was never an intentional
 * signal — it was an unguarded parse.
 *
 * Validation is the repo's ONE strict ISO-calendar-date check
 * (`isValidRmdIsoDate`, also what the health resolver's `isUsableBirthdate`
 * uses): a complete, real `YYYY-MM-DD` inside `[1900, 2200]`. A structurally
 * numeric but impossible date (`1961-99-99`) is reachable off an imported
 * payload and must not silently price a death year.
 */
function resolveMemberDeathYear(
  birthdateIso: string | null | undefined,
  lifeExpectancyAge: number,
): number | undefined {
  if (!isValidRmdIsoDate(birthdateIso)) return undefined;
  return Number(birthdateIso.slice(0, 4)) + lifeExpectancyAge;
}

/** The household's two projected death years, from ONE derivation shared by the
 *  deterministic tax post-pass (`buildTaxLoopShared`, which maps `undefined` to
 *  `Infinity` for its plain-number comparisons) and the Monte Carlo contexts
 *  (`buildMcTaxContext` / `buildMcRmdContext`, which omit an absent year). A
 *  single-member household has no secondary year. */
export function resolveHouseholdDeathYears(ctx: PipelineContext): {
  readonly primaryDeathYear: number | undefined;
  readonly secondaryDeathYear: number | undefined;
} {
  const lifeExpect = ctx.resolvedScenario.lifeExpectancy;
  return {
    primaryDeathYear: resolveMemberDeathYear(
      ctx.primary.payload.birthdate,
      lifeExpect?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
    ),
    secondaryDeathYear: ctx.secondary
      ? resolveMemberDeathYear(
          ctx.secondary.payload.birthdate,
          lifeExpect?.secondary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
        )
      : undefined,
  };
}

/** A runtime consumption-boundary re-validation of a stored tax year against the
 *  IDENTICAL `[1998, 2200]` bound the migration sanitiser uses — a
 *  current-schema-version (v5) payload bypasses the v4→v5 migration, so it must
 *  be re-checked here. Returns the year, or `undefined` when out of bounds. */
function validRothFactTaxYear(year: number | undefined): number | undefined {
  return isValidRothTaxYear(year) ? year : undefined;
}

/** Whether an account's underlying plan type is a GOVERNMENTAL 457(b): its
 *  ordinary Roth earnings are exempt from the 10% §72(t) additional tax
 *  (§72(t)(9)). The app models every Roth 457(b) as governmental
 *  (consistent with the existing 457(b) penalty exemption in
 *  `applyRothBasisOrdering`): the pure `RETIREMENT_ROTH_457B` and the MIXED
 *  `RETIREMENT_457B` designated subaccount. */
function isGovernmental457bType(type: AccountType): boolean {
  return type === 'RETIREMENT_ROTH_457B' || type === 'RETIREMENT_457B';
}

/**
 * Roth-engine adapter. Maps the account ledger
 * (Roth account payloads) plus the household's annual balance rows to the
 * cents-normalised Roth distribution facts the fact-based carriers consume,
 * applying the conservative missing-fact defaults at the boundary ($0 basis,
 * five-year anchor absent). This is the ONE place either engine turns account
 * data into Roth basis, which is what makes deterministic and Monte Carlo agree
 * on the same data structurally rather than by convention. The rules themselves
 * are explained in `docs/math-retirement-accounts.md`, "Roth withdrawal rules".
 *
 * Roth IRAs aggregate **per §408A pool** (`rothIraPoolKey`). An owner's OWN
 * `RETIREMENT_ROTH_IRA` accounts share one pool (`ownerId`; primary/secondary
 * distinct, per Pub 590-B). The pool's regular-contribution basis and its
 * remaining conversion lots are DERIVED from the pool's recorded balance history
 * (`deriveRothPoolBasisCents`), not read from a stored aggregate: contributions
 * credited, recorded and imputed outflows charged, contributions first then
 * conversion lots FIFO by tax year. The lots this adapter emits are therefore
 * what SURVIVES that history, each keeping its tax year and its
 * taxable/nontaxable split. The first-contribution year stays the EARLIEST of the
 * pool's ACTIVE accounts (the §408A clock runs from the owner's first-funded Roth
 * IRA), and Roth qualification is out of scope for the derivation — so the clock
 * stays scoped to ACTIVE accounts while the basis widens to every
 * non-deleted Roth IRA the owner holds.
 *
 * An INHERITED Roth IRA gets NO pool at all: its dollars are wholesale
 * tax-free in both engines and carry no basis state, so this adapter skips it
 * outright rather than emitting an empty or $0 one — an emitted pool is enough on
 * its own to materialise basis state downstream (the carrier seeding and the
 * ordering pass both create an entry from any pool key). The scope is exactly
 * `RETIREMENT_ROTH_IRA`: an inherited DESIGNATED-Roth plan keeps its existing
 * §402A treatment below.
 *
 * Designated-Roth accounts are keyed **per ACCOUNT id** — they do NOT
 * pool across plans/accounts the way Roth IRAs do (IRC §402A(d),
 * Treas. Reg. §1.402A-1: each account has its own 5-tax-year clock and pro-rata
 * basis recovery). One fact set is built per qualifying ACTIVE account: the pure
 * designated-Roth employer types (Roth 401(k)/403(b)/457(b)/TSP) AND the
 * Roth-designated post-tax subaccount of MIXED account types
 * (401(k)/403(b)/457(b)/TSP). Each carries its own in-plan Roth rollover lots
 * and governmental-457(b) flag, and its basis IS that recorded
 * in-plan-rollover principal — a plan with no recorded rollover has $0.
 * Both engines seed their Roth carriers from this adapter's output.
 *
 * Every Roth fact comes from the ANNUAL BALANCE ROWS, not the account
 * payload: a Roth-IRA conversion (§408A) and a designated-Roth in-plan rollover
 * (§402A(c)(4)) each happen in one tax year, so each is recorded against that
 * year's row on the Account Balances page alongside every other yearly figure,
 * and the contribution history the §408A basis derives from is those same rows.
 * The account payload carries no conversion or in-plan-rollover lot arrays and
 * no stored Roth-basis DOLLAR TOTALS (schema v7); only the two first-year
 * anchors are taken off the account — they have no year to be recorded against.
 */

/** One per-year Roth movement in cents, before it is named as a conversion or an
 *  in-plan rollover. Both facts share this shape; only the field names and the
 *  Code section they fall under differ. */
interface DatedRothAmountCents {
  readonly taxYear: number;
  readonly taxableCents: number;
  readonly nontaxableCents: number;
}

/**
 * Per-year Roth movements per account, derived from the annual balance rows.
 *
 * Shared by BOTH dated Roth facts — Roth-IRA conversions (§408A) and
 * designated-Roth in-plan rollovers (§402A(c)(4)) — which differ in the statute
 * they fall under and in the account types they apply to, but not in how they are
 * recorded or aggregated. The caller passes the pair of payload keys and names the
 * result.
 *
 * One entry per year that records a movement; a row with neither amount is skipped
 * entirely, so a year the user never touched contributes nothing (absent is a
 * weaker claim than a stored `0`, and the difference decides whether a five-year
 * clock starts at all).
 *
 * Every value is re-validated here even though the balance migrations sanitise the
 * same keys: a CURRENT-schema row from an import bundle bypasses those
 * migrations and reaches this adapter unsanitised, and the numbers feed the
 * cents-based ordering engine. An amount that fails `isValidRothMoney` reads as `0`
 * (`rothFactDollarsToCents`); a row whose YEAR is not a valid tax year is dropped
 * wholesale, because the year IS the lot's five-year-clock key and a lot without
 * one cannot be ordered.
 *
 * Two rows for the same account and year resolve to ONE — the first in input
 * order — rather than summing. In practice there is never more than one: an
 * `accountBalance` aggregate's id is deterministic (`bal-<accountId>-<year>`), so
 * the balances page's pre-aggregate version condition enforces one row per
 * (account, year), and two devices editing the same year offline collide on that
 * SAME id rather than creating a second row. Only an import bundle carrying a
 * foreign id can produce a genuine duplicate (`data-import.ts` replays `a.id`
 * verbatim without reconciling on `(accountId, year)`).
 *
 * First-in-order is not an arbitrary choice: it is the SAME row the rest of the
 * engine keeps. Both seed-balance reducers — `balance-projection-runner-projection.ts`
 * and `projection.ts` — pick the latest year with a strict `>`, so on a tie the
 * accumulator survives and the FIRST row of the input array wins. Summing instead
 * would credit two rows' worth of Roth basis against one row's balance, and these
 * fields are ANNUAL TOTALS, not increments: a duplicated annual record is a
 * restatement of the same year, never two separate movements to be added. The
 * inflated basis would shrink earnings and so UNDERSTATE ordinary income — the
 * direction `roth-distribution-tax.ts` exists to avoid.
 *
 * That one-row-per-(account, year) invariant is also what makes the per-lot cents
 * safe integers: each amount is bounded by `isValidRothMoney`, so a lot read from a
 * single row can never exceed `Number.MAX_SAFE_INTEGER` cents and needs no
 * lossy read-back. Only the cross-YEAR principal total can still overflow, and it
 * accumulates in BigInt for that reason.
 *
 * NOT capped, deliberately. A lot array on the account payload would need a
 * lot-count DoS guard because it could hold any number
 * of entries for one tax year. That threat does not exist here: the tax year
 * IS the key, so the output is bounded by the number of valid years — 203, from
 * `isValidRothTaxYear`'s `[1998, 2200]` range — per account, whatever the input.
 * A 200-lot cap would sit BELOW that natural bound and silently drop up
 * to three legitimate years; and because the lots sort ascending, it would drop the
 * LATEST ones — the years most likely to still be inside a five-year window. That is
 * not the conservative direction for a governmental 457(b), whose earnings are exempt
 * from the 10% additional tax: losing a late taxable rollover lot removes its
 * RECAPTURE rather than adding tax.
 */
function buildDatedRothAmountsByAccount(
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
  taxableKey: keyof AccountBalancePayload,
  nontaxableKey: keyof AccountBalancePayload,
): Map<string, { lots: DatedRothAmountCents[]; principalCents: bigint }> {
  // First row wins per (account, tax year) — see the docblock. `Map.has` rather
  // than `Map.set` keeps the FIRST row seen, which is the row both seed-balance
  // reducers keep on their strict-`>` tie, so the lots and the projected balance
  // describe the same record.
  // A `null` slot means "the winning row for this (account, year) recorded no
  // movement" — distinct from an ABSENT slot, which means no row for the year at
  // all. Claiming the slot is what makes the tie-break agree with the reducers.
  const byAccount = new Map<string, Map<number, DatedRothAmountCents | null>>();
  for (const { payload } of balances) {
    const taxYear = validRothFactTaxYear(payload.year);
    // The year IS the lot's five-year-clock key, so a row without a usable one
    // cannot be ordered and is dropped wholesale. It claims no slot either: with
    // no tax year there is no (account, year) for a later row to collide with.
    if (taxYear === undefined) continue;
    let byYear = byAccount.get(payload.accountId);
    if (!byYear) {
      byYear = new Map<number, DatedRothAmountCents | null>();
      byAccount.set(payload.accountId, byYear);
    }
    // The FIRST row for this (account, year) claims the slot, and it does so
    // BEFORE the has-a-movement test. Testing first would let a later duplicate
    // supply the facts whenever the winning row happens to record none — and the
    // seed reducers would still be reading the winning row's balance, which is the
    // mismatch this whole rule exists to prevent. A $10k conversion on the loser
    // row would then create $10k of basis against the winner's balance, turning a
    // fully taxable early withdrawal into a tax-free, penalty-free one.
    if (byYear.has(taxYear)) continue;
    const taxable = payload[taxableKey];
    const nontaxable = payload[nontaxableKey];
    // Nothing recorded for this year — not a $0 movement, no lot. Absent is a
    // weaker claim than a stored 0, and the difference decides whether a five-year
    // clock starts at all.
    if (!isValidRothMoney(taxable) && !isValidRothMoney(nontaxable)) {
      byYear.set(taxYear, null);
      continue;
    }
    // Each amount is bounded by `isValidRothMoney`, so ONE row's cents is always a
    // safe integer and needs no lossy read-back. That bound is per-lot only: the
    // §408A POOL merges lots from every Roth IRA an owner holds, and two accounts
    // converting in the same year can still overflow the aggregate
    // `orderRothIraDistribution` re-computes — which throws rather than
    // understating, a pre-existing and deliberate choice pinned by its own test.
    byYear.set(taxYear, {
      taxYear,
      taxableCents: rothFactDollarsToCents(taxable),
      nontaxableCents: rothFactDollarsToCents(nontaxable),
    });
  }
  const out = new Map<string, { lots: DatedRothAmountCents[]; principalCents: bigint }>();
  for (const [accountId, byYear] of byAccount.entries()) {
    const lots = [...byYear.values()]
      .filter((lot): lot is DatedRothAmountCents => lot !== null)
      .sort((a, b) => a.taxYear - b.taxYear);
    // Every year for this account recorded nothing — same as having no rows.
    if (lots.length === 0) continue;
    // The principal total spans up to 203 years, so it accumulates in BigInt
    // even though each addend is safe. It feeds the designated-Roth basis FLOOR,
    // and `computeDesignatedRothDistribution` derives ordinary (non-lot) basis as
    // `basisCents − lotsTotal`, recomputing `lotsTotal` from these same lots. Any
    // excess in the floor would become basis belonging to NO lot — and ordinary
    // basis is consumed BEFORE every rollover lot, so an over-large floor silently
    // removes all §72(t) recapture instead of protecting it. Deriving both totals
    // from one set of numbers is what keeps `ordinaryBasisCents` at 0 when the
    // cross-year floor saturates.
    let principalCents = 0n;
    for (const lot of lots) {
      principalCents += BigInt(lot.taxableCents) + BigInt(lot.nontaxableCents);
    }
    out.set(accountId, { principalCents, lots });
  }
  return out;
}

/**
 * The account-input shape `buildRothDistributionFacts` expects, projected off
 * the household's NON-DELETED accounts. A pure `{id,
 * payload}` projection, not a filter — the two branches inside
 * `buildRothDistributionFacts` scope active/inactive themselves. Shared
 * by the production runner (`buildPipelineContext`) and the report's Roth
 * tax-free-amounts table so both resolve `buildRothDistributionFacts` over
 * exactly the same account set; do not copy this projection at either call
 * site.
 */
export function buildRothAccountFactInputs(
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): ReadonlyArray<{ id: string; payload: AccountPayload }> {
  return accounts.map((account) => ({ id: account.id, payload: account.payload }));
}

export function buildRothDistributionFacts(
  /** The household's NON-DELETED accounts, active and inactive alike. The
   *  two branches below scope themselves differently and deliberately: a Roth
   *  IRA's recorded contribution history counts whatever its account's status,
   *  an employer plan's designated-Roth facts count only while it is active. */
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  /** The household's annual account-balance rows — the source of every Roth-IRA
   *  contribution, conversion and withdrawal, and of every designated-Roth
   *  in-plan rollover. Rows for accounts outside `accounts` are ignored. */
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): RothDistributionFacts {
  // The designated-Roth dated fact still comes off the balance rows through the
  // shared per-account helper. The Roth-IRA side no longer does: its remaining
  // lots are whatever the pool's §408A derivation has left after the recorded
  // history is consumed, so raw per-account lots are never handed through.
  const rolloverLotsByAccount = buildDatedRothAmountsByAccount(
    balances,
    'rothInPlanRolloverTaxableAmount',
    'rothInPlanRolloverNontaxableAmount',
  );
  interface MutablePoolFacts {
    /** Every non-deleted Roth IRA in this §408A pool — ACTIVE OR NOT. The
     *  derivation runs over the whole set at the end: an inactive Roth IRA's
     *  recorded contribution history is real §408A basis that followed the money
     *  into whichever sibling account it was consolidated to. */
    readonly accounts: { id: string }[];
    /** The pooled five-year anchor. Contributed by ACTIVE accounts ONLY — the
     *  clock is scoped to active accounts. */
    rothIraFirstYear?: number;
    /** True when at least one of the pool's accounts is ACTIVE. An
     *  all-inactive pool whose derivation also resolves to nothing is not
     *  emitted at all — see the emission loop below. */
    hasActiveAccount: boolean;
    /** The real member id behind the pool (the map key is the POOL key). */
    readonly ownerId: string;
  }
  const rothIraAcc = new Map<string, MutablePoolFacts>();
  const pool = (poolKey: string, ownerId: string): MutablePoolFacts => {
    let o = rothIraAcc.get(poolKey);
    if (!o) {
      o = { accounts: [], hasActiveAccount: false, ownerId };
      rothIraAcc.set(poolKey, o);
    }
    return o;
  };
  const earliest = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);

  const designatedByAccount = new Map<string, DesignatedRothAccountFactsCents>();

  for (const { id, payload } of accounts) {
    if (payload.type === 'RETIREMENT_ROTH_IRA') {
      // An INHERITED Roth IRA's dollars are wholesale tax-free in both
      // engines, so it gets no basis state at all: not a $0 pool, an ABSENT one.
      // Emitting a pool here would be enough to defeat that on its own — the
      // carrier seeding and the ordering pass both materialise $0 basis plus lot
      // state for any pool key handed to them. Read off the raw payload with
      // the same `=== true` discipline the designated branch below uses, so only a
      // literal `true` counts as inherited. The scope is exactly this type: an
      // inherited DESIGNATED-Roth plan keeps its existing §402A treatment below.
      if (payload.rmdInheritedAccount === true) continue;
      // The pool takes this account whatever its status. Its basis and its
      // remaining conversion lots are derived from the pool's recorded history
      // below, so nothing here depends on `active`.
      const o = pool(rothIraPoolKey(payload.ownerId, id, false), payload.ownerId);
      o.accounts.push({ id });
      // …but the CLOCK does. Roth qualification is not part of the basis derivation,
      // so the five-year anchor is scoped to active accounts: an
      // inactive account's year never enters a pool's anchor. A pool whose
      // accounts are ALL inactive therefore carries real basis with NO anchor —
      // the unmet clock the household already had when the pool did not exist,
      // and the conservative direction wherever a sibling pool is seasoned.
      if (!payload.active) continue;
      o.hasActiveAccount = true;
      const rothStart = resolveRothStartYear({
        accountId: id,
        type: payload.type,
        taxTreatment: payload.taxTreatment,
        explicitYear: payload.rothIraFirstContributionTaxYear,
        balances,
      });
      o.rothIraFirstYear = earliest(o.rothIraFirstYear, rothStart.year);
    } else if (
      isPureRothEmployerType(payload.type) ||
      (payload.taxTreatment === 'MIXED' && isRothDesignatedRetirementType(payload.type))
    ) {
      // The designated branch stays ACTIVE-ONLY: an inactive
      // employer plan carries no balance at all (`ACCOUNT_NOT_ZEROED` enforces
      // that at save time), so its recorded basis would inflate the pooled basis
      // numerator with no balance behind it in the denominator — the opposite of
      // the Roth-IRA case, where the money moved to a sibling account the pool
      // still holds.
      if (!payload.active) continue;
      const rothStart = resolveRothStartYear({
        accountId: id,
        type: payload.type,
        taxTreatment: payload.taxTreatment,
        explicitYear: payload.designatedRothFirstParticipationTaxYear,
        balances,
      });
      // One per-account fact set — designated-Roth accounts never pool.
      // In-plan rollover lots come from THIS account's annual balance rows —
      // already validated, resolved to one row per tax year and sorted by the
      // shared helper above, exactly like the Roth-IRA conversion lots.
      const rollover = rolloverLotsByAccount.get(id);
      const inPlanRolloverLots: RothInPlanRolloverLotCents[] = (rollover?.lots ?? []).map(
        (lot) => ({
          taxYear: lot.taxYear,
          taxableRolloverPrincipalCents: lot.taxableCents,
          nontaxableRolloverPrincipalCents: lot.nontaxableCents,
        }),
      );
      // Every in-plan Roth rollover dollar (taxable OR nontaxable) is BASIS — it
      // was taxed / already after-tax at the rollover. So the total rollover
      // principal is a KNOWN LOWER BOUND for the account's designated-Roth basis.
      // Derived from the SAME lot values the distribution helper re-sums,
      // so the floor can never exceed them (see the helper's note).
      const lotsPrincipal = rollover?.principalCents ?? 0n;
      // The account's designated-Roth basis IS its recorded in-plan-rollover
      // principal, and nothing else. There is no stored designated-Roth basis
      // total on the payload (schema v7):
      // the app could not verify an aggregate the user typed, so a plan with no
      // recorded in-plan rollover resolves $0 basis and its whole nonqualified
      // distribution is earnings.
      // Consequence, deliberate: `computeDesignatedRothDistribution` derives
      // ordinary (non-lot) basis as `basisCents − lotsTotal`, and those two are
      // equal by construction, so ordinary designated-Roth basis is ALWAYS $0
      // and IRS Notice 2010-84 Q&A-13's "exhaust ordinary basis first" stage is
      // vacuous. Both moves are in the more-tax direction.
      // This is a known-basis FLOOR, so on a
      // safe-integer overflow it SATURATES high rather than collapsing to a
      // floor-removing 0 — otherwise a large-but-individually-valid rollover set
      // would drop its known taxable principal out of the §72(t) recapture base.
      const basisCents = safeRothBasisFloorFromBigInt(lotsPrincipal);
      designatedByAccount.set(id, {
        accountId: id,
        ownerId: payload.ownerId,
        basisCents,
        firstParticipationTaxYear: rothStart.year,
        inPlanRolloverLots,
        isGovernmental457b: isGovernmental457bType(payload.type),
        // An INHERITED designated-Roth account's distributions are made on
        // account of the original owner's death: qualified once the account's own
        // five-year period is met, and never subject to the 10% additional tax
        // (§72(t)(2)(A)(ii)), whatever the beneficiary's age.
        ...(payload.rmdInheritedAccount === true
          ? { inheritedFromDeceasedOwner: true }
          : {}),
      });
    }
  }

  const rothIraByPool = new Map<string, RothIraPoolFactsCents>();
  for (const [poolKey, o] of rothIraAcc.entries()) {
    // ONE derivation per §408A pool over the pool's WHOLE recorded history
    // (pool-level, never per-account-then-sum). What comes back is what SURVIVES
    // that history: the remaining regular-contribution basis and the remaining
    // conversion lots, each keeping its tax year and its taxable/nontaxable split
    // so the §72(t) recapture clock and the ordered allocation still key on them.
    // The engine carriers consume these remainders against PROJECTED future
    // withdrawals, so the historical outflows are never re-applied downstream.
    const derived = deriveRothPoolBasisCents(o.accounts, balances);
    // A pool with no ACTIVE account whose history also resolves to NOTHING — no
    // remaining regular-contribution basis and no remaining conversion-lot
    // principal (and, the anchor being active-only, no clock either) — is an
    // ABSENCE, not a $0 fact, the same stance taken for an inherited pool.
    // Emitting it would deliver only disqualification: the MC pooled profile
    // walks every emitted pool, so a closed, fully-withdrawn Roth IRA would
    // blank the HOUSEHOLD's five-year clock and add its owner to the pooled
    // 59½ set, taxing a seasoned spouse's qualified earnings. §408A(d)(2)(B)
    // runs the clock from the FIRST contribution to any Roth IRA and it keeps
    // running after the account closes — a closed Roth IRA can only make a
    // household clock earlier, never absent. A basis-carrying all-inactive
    // pool IS still emitted: its recorded history is real §408A basis
    // that followed the money into a sibling account.
    const hasRemainingBasis =
      derived.regularContributionBasisCents > 0 ||
      derived.conversionLots.some(
        (lot) =>
          lot.taxableConvertedPrincipalCents > 0 || lot.nontaxableConvertedPrincipalCents > 0,
      );
    if (!o.hasActiveAccount && !hasRemainingBasis) continue;
    rothIraByPool.set(poolKey, {
      rothIra: {
        regularContributionBasisCents: derived.regularContributionBasisCents,
        firstContributionTaxYear: o.rothIraFirstYear,
        conversionLots: derived.conversionLots,
      },
      ownerId: o.ownerId,
      // An emitted basis-carrying pool whose accounts are ALL inactive is
      // flagged so the MC aggregate seed can exclude its (undrawable) basis and
      // lots while its conservative clock/owner-set consequences stay in force.
      ...(o.hasActiveAccount ? {} : { allAccountsInactive: true as const }),
    });
  }
  return { rothIraByPool, designatedByAccount };
}

// ---------------------------------------------------------------------------
// RMD profile-fact adapter (shared by BOTH engines)
// ---------------------------------------------------------------------------

/**
 * Normalize one account payload's stored `rmd*` facts into the DB-free engine
 * shape `RmdAccountProfileFacts`.
 *
 * Every stored value is RE-VALIDATED here against the shared
 * `db/rmd-fact-validation.ts` SSOT rather than trusted, because the v5→v6
 * migration sanitiser only runs on BELOW-current payloads: a hand-constructed or
 * directly-imported current-version row reaches this boundary unsanitised. An
 * invalid value is DROPPED (never coerced), which makes the field ABSENT and so
 * resolves to its one-sided conservative default at the engine — for an inherited
 * account that means the RMD is WITHHELD and the missing fact is listed, and
 * for an owner account it means the larger-RMD Uniform Lifetime default.
 *
 * Returns `undefined` when the payload carries NO recognisable RMD fact at all,
 * so a fact-free household keeps the RMD engine on its default path.
 */
function buildRmdProfileFacts(
  payload: AccountPayload,
  /** The spouse's birthdate as recorded on the HOUSEHOLD (the other member,
   *  relative to this account's owner). The editor no longer asks for it —
   *  re-typing a date the household already stores was both redundant and a
   *  second copy that could drift out of date. Consulted only for an account
   *  carrying the sole-spouse designation. Household dates are canonical: a
   *  legacy copied date never overrides them, and a missing/ineligible pair
   *  falls back immediately to the standard Table III path. */
  householdSpouseBirthdate?: string,
  /** This account OWNER's own birthdate from the household. On an inherited
   *  account the owner IS the beneficiary, so this is the Table I birthdate —
   *  asking for it again in the editor duplicated a date the household already
   *  holds. Used only on an inherited account (which already carries a fact, so
   *  no fact-free household is affected). It is canonical whenever present; a
   *  legacy stored copy is only a fallback when this value is absent. */
  householdOwnerBirthdate?: string,
): RmdAccountProfileFacts | undefined {
  const bool = (v: unknown): boolean | undefined =>
    isValidRmdBoolean(v) ? v : undefined;
  const date = (v: unknown): string | undefined => (isValidRmdIsoDate(v) ? v : undefined);
  const householdSpouseEligible =
    payload.rmdSoleSpouseBeneficiary === true &&
    spouseMoreThan10YearsYounger(householdOwnerBirthdate, householdSpouseBirthdate) === true;
  const facts: RmdAccountProfileFacts = {
    inheritedAccount: bool(payload.rmdInheritedAccount),
    currentEmployerPlan: bool(payload.rmdCurrentEmployerPlan),
    fivePercentOwner: bool(payload.rmdFivePercentOwner),
    planRequiresDistributionAtStatutoryAge: bool(
      payload.rmdPlanRequiresDistributionAtStatutoryAge,
    ),
    firstYearDeferralElected: bool(payload.rmdFirstYearDeferralElected),
    // The designation is accepted only while the household's canonical dates
    // prove the Table II age gap. Missing/ineligible dates drop the stale flag at
    // this boundary and use the standard Table III path immediately.
    soleSpouseBeneficiaryMoreThan10YrsYounger: householdSpouseEligible || undefined,
    spouseBeneficiaryBirthdate: householdSpouseEligible
      ? date(householdSpouseBirthdate)
      : undefined,
    beneficiaryType: isValidRmdBeneficiaryType(payload.rmdBeneficiaryType)
      ? payload.rmdBeneficiaryType
      : undefined,
    inheritedOwnerDeathDate: date(payload.rmdInheritedOwnerDeathDate),
    inheritedOwnerDiedOnOrAfterRbd: bool(payload.rmdInheritedOwnerDiedOnOrAfterRbd),
    // The inherited account's owner IS its beneficiary. Prefer their current
    // household birthdate; the per-account copy survives only as a read fallback
    // for legacy/imported data when the household date is absent.
    beneficiaryBirthdate:
      (payload.rmdInheritedAccount === true ? date(householdOwnerBirthdate) : undefined) ??
      date(payload.rmdBeneficiaryBirthdate),
    originalOwnerBirthdate: date(payload.rmdOriginalOwnerBirthdate),
    beneficiaryElection: isValidRmdBeneficiaryElection(payload.rmdBeneficiaryElection)
      ? payload.rmdBeneficiaryElection
      : undefined,
  };
  return Object.values(facts).some((v) => v !== undefined) ? facts : undefined;
}

/** Per-account RMD profile facts for a whole account set, keyed by account id.
 *  Accounts carrying no facts are OMITTED (so the engine's default path stays
 *  unchanged for a fact-free household). */
export function buildRmdProfileFactsByAccount(
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  /** Each owner's SPOUSE birthdate as recorded on the household, keyed by the
   *  owner's member id — i.e. for member A the value is member B's birthdate.
   *  Supplies `spouseBeneficiaryBirthdate` so the account editor does not have
   *  to ask for a date the household already holds (see `buildRmdProfileFacts`).
   *  Absent or ineligible → a stale designation is ignored and the standard
   *  Table III path applies; the old per-account spouse copy is not consulted. */
  spouseBirthdateByOwnerId?: ReadonlyMap<string, string>,
  /** Each member's OWN birthdate, keyed by member id — the Table I birthdate on
   *  an inherited account, where the owner is the beneficiary. */
  ownBirthdateByMemberId?: ReadonlyMap<string, string>,
): Map<string, RmdAccountProfileFacts> {
  const out = new Map<string, RmdAccountProfileFacts>();
  for (const { id, payload } of accounts) {
    const facts = buildRmdProfileFacts(
      payload,
      spouseBirthdateByOwnerId?.get(payload.ownerId),
      ownBirthdateByMemberId?.get(payload.ownerId),
    );
    if (facts !== undefined) out.set(id, facts);
  }
  return out;
}
