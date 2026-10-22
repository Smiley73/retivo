/**
 * Pure tax-computation helpers shared by the deterministic runner and the Monte Carlo path: member inputs,
 * RMD snapshots, income and SS rollups, brokerage basis and cash-interest rows, withdrawal tax splits, and
 * the twin-engine resolvers.
 * See `docs/math-taxes.md` and `docs/math-retirement-accounts.md`.
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
// The one shared health-coverage resolver both engines call.
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
// The penalty engine's 59½ half-birthday proration, used to attribute an aggregate slice's penalty to the
// owner whose proration is largest, so the funded 10% matches the conservative base.
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

// Jan-1-shifted effective birth year per ISO birthdate; `null` means unparseable. FIFO-bounded to 128
// entries.
const EFFECTIVE_BIRTH_YEAR_MEMO = new Map<string, number | null>();
const EFFECTIVE_BIRTH_YEAR_MEMO_MAX_ENTRIES = 128;

/**
 * Whether a person with the given ISO birthdate has attained age `targetAge` by the end of `taxYear`, under
 * the IRS born-on-January-1 rule: a Jan-1 birthdate counts as Dec 31 of the prior year, so a Jan-1-1960
 * person attains 65 for tax year 2024. An unparseable or empty birthdate gives false.
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
      // Born Jan 1 is treated as reaching the age on Dec 31 of the prior year.
      effectiveBirthYear = birthMonth === 1 && birthDay === 1 ? birthYear - 1 : birthYear;
    }
    if (EFFECTIVE_BIRTH_YEAR_MEMO.size >= EFFECTIVE_BIRTH_YEAR_MEMO_MAX_ENTRIES) {
      // FIFO eviction: Map iteration is insertion order, so the first key is the oldest.
      const oldestKey = EFFECTIVE_BIRTH_YEAR_MEMO.keys().next().value;
      if (oldestKey !== undefined) EFFECTIVE_BIRTH_YEAR_MEMO.delete(oldestKey);
    }
    EFFECTIVE_BIRTH_YEAR_MEMO.set(isoBirthdate, effectiveBirthYear);
  }
  if (effectiveBirthYear === null) return false;
  return taxYear - effectiveBirthYear >= targetAge;
}

/**
 * Per-member separation-from-service calendar year by member id: the one derivation behind the member inputs,
 * the RMD facts and the MC tax context, gating automatic Marketplace months and the §401(a)(9)(C) later-of
 * RMD rule.
 * A `Map` because member ids are user-controlled and may be `"__proto__"` (CWE-1321). A secondary with a
 * missing or unparseable date falls back to the primary's year, never `NaN`, which would read as never
 * retired.
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

/**
 * Builds the per-member `TaxMemberInput` array for one projection year, excluding members whose projected
 * death year is before `taxYear`.
 */
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
    /**
     * This member's separation-from-service calendar year (from `ctx.retirementByMember`), feeding the
     * §401(a)(9)(C) later-of rule; absent withholds that resolution.
     */
    retirementYear?: number,
  ): void => {
    const iso = member.payload.birthdate ?? `${taxYear - 65}-01-01`;
    // Account types whose POST_TAX withdrawals return already-taxed principal ($0 taxable, $0 MAGI):
    // cash-like instruments plus HSA. Savings, money-market and CD interest is taxed annually
    // (`isTaxableCashInterestAccount`); HSA growth is tax-free (§223) and its nonqualified income and pre-65
    // 20% tax come from the penalty pass. BROKERAGE and OTHER use the LTCG proxy instead.
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

  // The canonical per-member retirement year, also threaded by the MC twin, so a staggered household resolves
  // the same Marketplace months on both engines.
  const retirementYearByMember = resolveRetirementYearByMember(ctx);

  if (primaryAlive) {
    const primaryRetYear = retirementYearByMember.get(ctx.primary.id) ?? ctx.primaryRetirementYear;
    pushMember(ctx.primary, taxYear >= primaryRetYear, primaryRetYear);
  }

  if (ctx.secondary && secondaryAlive) {
    // The secondary is retired from their own retirement year, which equals the primary's under the same-date
    // anchor or when their date is missing or unparseable.
    const secRetYear =
      retirementYearByMember.get(ctx.secondary.id) ?? ctx.primaryRetirementYear;
    pushMember(ctx.secondary, taxYear >= secRetYear, secRetYear);
  }

  return members;
}

/**
 * Builds per-account RMD snapshots from the prior year's `DrawdownYear.accountBalances` (year 0 uses ledger
 * initial balances). Every account with a Roth-designated pocket (a MIXED plan, or a pure Roth account) gets
 * `postBalancePriorYearDollars` so the tax layer passes `rothPortionCents` to the RMD engine (SECURE 2.0
 * §325); limiting it to MIXED would send an inherited Roth account's full balance as a pre-tax RMD base. The
 * MC producers apply the same rule via `buildMcRmdAccountInput`.
 */
export function buildAccountSnapshotsFromPriorYear(
  ctx: PipelineContext,
  priorYear: DrawdownYear | undefined,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  /**
   * The year two before the tax year, used only to size a first-year deferral catch-up; absent makes the
   * catch-up a blocker.
   */
  priorPriorYear?: DrawdownYear,
): readonly TaxAccountSnapshot[] {
  const accountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  // An inherited account follows beneficiary RMD rules even when the living-owner test rejects it, so the
  // filter admits it; `isInheritedRmdSubjectType` still excludes HSAs and non-retirement types.
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

  // Year 0 uses the ledger initial balances.
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
      // The Roth-designated portion of the two-years-prior balance, so `rmdTwoYearsPriorBaseCents` nets it
      // out like the current-year base (SECURE 2.0 §325); otherwise a catch-up would be sized on Roth dollars
      // that owe no RMD.
      ...(hasRothDesignatedPocket(taxTreatment) && twoYearsPriorRow !== undefined
        ? { postBalanceTwoYearsPriorDollars: twoYearsPriorRow.postEnd }
        : {}),
    });
  }
  return out;
}

/**
 * Sums taxable non-SS ordinary income (pension and part-time wages) for a calendar year from per-month rows,
 * excluding `depositInflow`; one-off windfalls are included, conservatively. `pensionIncome` and
 * `partTimeIncome` are annualized run-rates ($/yr), so the annual amount is the mean of the 12 months, not
 * the sum; `oneOffIncome` is the literal event-month spike.
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

/**
 * Gross SS dollars for a calendar year from per-month rows. `total` is an annualized run-rate ($/yr), so the
 * annual amount is the mean of the 12 months, as in `buildMonthlyIncomeSeries`.
 */
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
 * Per-member own gross SS dollars for a calendar year by member id, for hybrid IRMAA: each Medicare member's
 * surcharge is withheld only from their own SS. Members with no SS for the year are absent, so their whole
 * surcharge is a cash need.
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

// Account types whose POST_TAX withdrawals return already-taxed principal ($0 taxable, $0 MAGI): cash-like
// instruments plus HSA. Savings, money-market and CD interest is taxed annually as ordinary income
// (`isTaxableCashInterestAccount`); HSA growth is tax-free (§223); HSA nonqualified income and the pre-65 20%
// additional tax come from the penalty pass. BROKERAGE and OTHER are not in this set (LTCG proxy).
const CASH_LIKE_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'SAVINGS',
  'MONEY_MARKET',
  'CD',
  'HSA',
]);

/**
 * True when a POST_TAX non-Roth account's withdrawals return already-taxed principal rather than an LTCG
 * proxy.
 */
export function isCashLikeAccountType(type: AccountType): boolean {
  return CASH_LIKE_ACCOUNT_TYPES.has(type);
}

/**
 * True for a brokerage-like POST_TAX taxable account (`BROKERAGE` / `OTHER`), the only accounts that get the
 * LTCG/QDI withdrawal proxy and the assumed-yield drag; the MC tax path uses the same predicate.
 */
export function isBrokerageLikeAccount(
  type: AccountType,
  taxTreatment: AccountTaxTreatment,
): boolean {
  return taxTreatment === 'POST_TAX' && !CASH_LIKE_ACCOUNT_TYPES.has(type);
}

/**
 * True when the account's annual growth is ordinary taxable interest: cash-like POST_TAX (`SAVINGS`,
 * `MONEY_MARKET`, `CD`). HSA is excluded by type and treatment since its growth is tax-free (§223). Shared
 * with MC so the interest account set cannot diverge.
 */
export function isTaxableCashInterestAccount(
  type: AccountType,
  taxTreatment: AccountTaxTreatment,
): boolean {
  return (
    taxTreatment === 'POST_TAX' && CASH_LIKE_ACCOUNT_TYPES.has(type) && type !== 'HSA'
  );
}

/**
 * Per-brokerage-like-account cost-basis state carried across projection years: `basisDollars` is the running
 * cost basis, keyed by account id and added the first year the account has a balance.
 */
export interface BrokerageLikeBasisState {
  /** Account id to running cost basis in dollars, after the prior year's withdrawal depletion. */
  readonly basisByAccountId: Map<string, number>;
  /**
   * Seed cost-basis fraction for an account's first appearance (default 0.5, from
   * `assumedCostBasisFractionOfTaxableWithdrawal`).
   */
  readonly seedBasisFraction: number;
}

/** Result of advancing the basis accumulator one projection year. */
export interface BrokerageLikeYearBasis {
  /** Brokerage-like balance at the start of the year (prior year-end), in dollars: the yield base. */
  readonly startBalanceDollars: number;
  /**
   * Withdrawal-weighted pre-withdrawal cost-basis fraction across brokerage-like accounts, clamped to [0,1],
   * so the withdrawal-time LTCG gain is `withdrawal * (1 - fraction)`; the seed fraction when no
   * brokerage-like withdrawal occurred.
   */
  readonly preWithdrawalBasisFraction: number;
}

/** One brokerage-like account's year inputs for the basis evolution step. */
interface BrokerageAccountYearInput {
  readonly id: string;
  /** Prior year-end market value (start-of-year balance), dollars. */
  readonly startBalanceDollars: number;
  /** Year-end market value after this year's withdrawal and growth, dollars. */
  readonly endBalanceDollars: number;
  /** This year's withdrawal from the account, dollars. */
  readonly withdrawnDollars: number;
  /** This year's deposit into the account (new basis), dollars. */
  readonly depositDollars: number;
}

// Only the HSA share of the cash-like bucket is the §223(f)(4) nonqualified basis; feeding the whole bucket
// would over-tax savings/CD/MM principal. The solver has no per-account draw, so the share is the HSA's
// balance share of cash-like ledger balances.
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
    // V is the pre-withdrawal market value (post-growth).
    const preWithdrawalValue = Math.max(0, acc.endBalanceDollars) + withdrawn;

    // On first appearance seed basis from the seed fraction times the pre-existing value; when unknown, use
    // the pre-withdrawal value minus this year's deposit, since the deposit is its own basis and is added
    // once below (seeding from the gross value would double-count it and hide same-year gain on an account
    // funded from a zero start).
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
    // Clamp the carried basis so fp residue cannot push basis above value next year.
    const carriedBasis = endBalance > 0 ? Math.min(basisNext, endBalance) : 0;
    state.basisByAccountId.set(acc.id, carriedBasis);
  }

  const preWithdrawalBasisFraction =
    withdrawnTotal > 0 ? clamp01(basisWithdrawnTotal / withdrawnTotal) : state.seedBasisFraction;

  return { startBalanceDollars: startBalanceTotal, preWithdrawalBasisFraction };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export interface TaxableAccountYearRow {
  readonly id: string;
  /**
   * Owning household member id, so a separate-returns year reports this account's yield base and interest on
   * its owner's return; absent (the MC pooled path) leaves the dollars unattributed, falling back to the even
   * split.
   */
  readonly ownerId?: string;
  readonly startBalanceDollars: number;
  readonly endBalanceDollars: number;
  readonly withdrawnDollars: number;
  readonly depositDollars: number;
}

// Shared row assembly for the per-account taxable-income passes: joins the year's per-account rows to a
// start-of-year balance (prior year-end, else ledger initial) for accounts matching `predicate`; `[]` without
// a per-account map.
function buildTaxCharacterYearAccounts(
  ctx: PipelineContext,
  year: DrawdownYear,
  priorYear: DrawdownYear | undefined,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  predicate: (type: AccountType, taxTreatment: AccountTaxTreatment) => boolean,
  opts?: {
    // For cash-interest rows with an unknown start balance (hand-rolled callers only), synthesize a
    // zero-growth start (`end + withdrawn - deposit`) so no interest is invented from an unknown opening
    // balance; brokerage rows keep the 0 fallback.
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
 * Builds the brokerage-like account year rows for the basis accumulator from the current `DrawdownYear` and
 * the prior year's balances; `[]` without a per-account map (no yield drag or basis evolution on
 * bucket-allocation paths).
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
 * Builds the cash-like interest account year rows (`SAVINGS`, `MONEY_MARKET`, `CD`, POST_TAX; HSA excluded as
 * tax-free) in the same shape as the brokerage rows; `[]` without a per-account map.
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
 * Seeds the funding pass's per-owner pooled designated-Roth balance (see
 * `balance-projection-runner-roth-basis.ts`).
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

/**
 * Per-owner cash-like ordinary interest for one year (same formula as {@link
 * computeCashLikeInterestDollars}), so a separate-returns year reports each spouse's own interest.
 */
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

/**
 * Per-owner start-of-year brokerage-like balance (the assumed-yield base), so a separate-returns year charges
 * each spouse's yield drag to the return that owns the account.
 */
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

// The four withdrawal tax buckets one projection year splits into.
type WithdrawalTaxBucket = 'preTax' | 'postTaxNonRoth' | 'postTaxCashLike' | 'roth';

/**
 * One year's withdrawals split by tax treatment, with the per-owner breakdown behind each bucket. `byOwner`
 * serves separate-returns years, where each spouse reports withdrawals from accounts they own; ownerless
 * dollars (bucket-allocation fallback, the synthetic RMD-overflow carrier, an unknown id) stay unattributed
 * and fall back to the even split.
 */
export interface WithdrawalTaxSplit {
  preTax: number;
  postTaxNonRoth: number;
  postTaxCashLike: number;
  roth: number;
  /** `bucket -> ownerId -> dollars`, owner-attributed dollars only. */
  readonly byOwner: Record<WithdrawalTaxBucket, Record<string, number>>;
}

// A zeroed `WithdrawalTaxSplit`.
function emptyWithdrawalTaxSplit(): WithdrawalTaxSplit {
  return {
    preTax: 0,
    postTaxNonRoth: 0,
    postTaxCashLike: 0,
    roth: 0,
    byOwner: { preTax: {}, postTaxNonRoth: {}, postTaxCashLike: {}, roth: {} },
  };
}

// Adds one account's withdrawal to a bucket total and, when the owner is known, to that owner's share.
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
 * Splits a `DrawdownYear`'s `accountBalances` into pre-tax, post-tax non-Roth, post-tax cash-like and Roth
 * withdrawals. MIXED accounts split via `preWithdrawnCents` / `postWithdrawnCents`: pre lands in `preTax`,
 * post by account type (`BROKERAGE` / `OTHER` to `postTaxNonRoth` for the LTCG proxy;
 * `{SAVINGS, MONEY_MARKET, CD, HSA}` to `postTaxCashLike`, $0 taxable and $0 MAGI). Roth accounts carry
 * `taxTreatment === 'ROTH'`, not MIXED.
 */
export function splitWithdrawalsByTaxTreatment(
  ctx: PipelineContext,
  year: DrawdownYear,
): WithdrawalTaxSplit {
  const accountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  const split = emptyWithdrawalTaxSplit();
  // Rows without an `accountBalances` map (bucket-allocation single pool) classify the whole net draw as
  // pre-tax, conservatively, and stay unattributed to an owner (a separate-filing year splits it evenly).
  if (!year.accountBalances) {
    addWithdrawal(split, 'preTax', undefined, year.withdrawn);
    return split;
  }
  for (const [id, row] of year.accountBalances.entries()) {
    // The synthetic RMD-overflow cash carrier is return-of-principal cash ($0 taxable, $0 MAGI), routed to
    // the cash-like bucket before the unknown-id guard since it is not a real account.
    if (isRmdOverflowCashAccountId(id)) {
      addWithdrawal(split, 'postTaxCashLike', undefined, row.withdrawn);
      continue;
    }
    const account = accountById.get(id);
    if (!account) {
      // An unknown account id is treated as post-tax non-Roth, which under-taxes rather than over-taxes;
      // logged once.
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
      // Qualified HSA withdrawals carry no income tax or MAGI and route to the cash-like bucket; the
      // nonqualified income and the pre-65 20% §223(f)(4) additional tax are layered on by the penalty pass.
      addWithdrawal(split, 'postTaxCashLike', ownerId, row.withdrawn);
      continue;
    }
    if (taxTreatment === 'ROTH') {
      addWithdrawal(split, 'roth', ownerId, row.withdrawn);
      continue;
    }
    const cashLike = isCashLikeAccountType(type);
    if (taxTreatment === 'MIXED') {
      // Pre and post route independently when the engine surfaced the split. A MIXED Roth-designated
      // (401k/403b/457b/TSP) post bucket goes to `roth` ($0 income, $0 MAGI) and only its pre tranche stays
      // pre-tax; a MIXED OTHER post bucket keeps the LTCG or cash-like proxy.
      const rothDesignated = isRothDesignatedPostBucket(taxTreatment, type);
      const postBucket = rothDesignated ? 'roth' : cashLike ? 'postTaxCashLike' : 'postTaxNonRoth';
      const preCents = row.preWithdrawnCents;
      const postCents = row.postWithdrawnCents;
      if (preCents !== undefined && postCents !== undefined) {
        addWithdrawal(split, 'preTax', ownerId, preCents / 100);
        addWithdrawal(split, postBucket, ownerId, postCents / 100);
      } else if (rothDesignated) {
        // With no split the whole Roth-designated MIXED withdrawal goes to Roth (post = 0, so no basis
        // consumed and no penalty); the pre tranche is penalized separately by `buildPenaltyAccountsForYear`.
        addWithdrawal(split, 'roth', ownerId, row.withdrawn);
      } else {
        addWithdrawal(split, postBucket, ownerId, row.withdrawn);
      }
      continue;
    }
    // POST_TAX non-Roth: cash-like principal versus the brokerage/OTHER LTCG proxy.
    addWithdrawal(split, cashLike ? 'postTaxCashLike' : 'postTaxNonRoth', ownerId, row.withdrawn);
  }
  return split;
}

/**
 * Builds the per-account early-withdrawal and HSA penalty inputs for one projection year from
 * `DrawdownYear.accountBalances`. The §72(t) basis is the whole withdrawal for PRE_TAX, the pre-tax tranche
 * for MIXED (0 without the split), and 0 for POST_TAX, Roth and cash-like; HSA accounts carry
 * `hsaWithdrawalDollars`. Returns `[]` without a per-account map, so those paths assess no penalty.
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
      // Carry the medical-qualified split so the tax pass excludes those dollars from income and the 20%
      // basis; the emergency residual is `withdrawn - medicalQualified` in integer cents, reconciling exactly
      // to the committed cents. Without the split the whole draw is emergency.
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
      // §72(t) applies to the amount includible in gross income: the pre-tax tranche only.
      preTaxBasis = row.preWithdrawnCents !== undefined ? row.preWithdrawnCents / 100 : 0;
    } else if (taxTreatment === 'HSA') {
      // Unreachable today (`'HSA'` treatment exists only on HSA-type accounts, handled above); kept as an
      // explicit no-op so a future non-HSA account with that treatment cannot silently regress.
      preTaxBasis = 0;
    }
    if (preTaxBasis <= 0) continue;
    out.push({
      id,
      type,
      ownerId,
      penaltyPreTaxWithdrawalDollars: preTaxBasis,
      hsaWithdrawalDollars: 0,
      // §72(t)(2)(A)(ii): a distribution from an inherited account is on account of the original owner's
      // death and carries no 10% additional tax at any beneficiary age; ordinary income tax still applies.
      ...(ctx.rmdProfileFactsByAccountId?.get(id)?.inheritedAccount === true
        ? { inheritedFromDeceasedOwner: true }
        : {}),
    });
  }
  return out;
}

// Estimates the HSA share of the solver's aggregate cash-like bucket as the HSA ledger account's balance
// share of all cash-like ledger balances, capped at the bucket total; 0 when no cash-like balance is
// recorded. Only the HSA portion is the §223(f)(4) nonqualified basis; the post-pass uses the exact
// per-account draw.
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

// Household-conservative qualification reduction for one aggregate Roth slice, used only without per-account
// attribution. Across `ownerIds`, 59½ holds only if every owner reached it for the whole year, the five-year
// clock is the latest (absent if any lacks one), and `penaltyOwnerId` is the failing owner with the largest
// §72(t) proration fraction, since the penalty prorates by the snapshot owner's birthdate; a `null` fraction
// never wins.
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

// Groups a per-account Roth-slice attribution into per-owner integer cents that sum exactly to the slice,
// scaled with cumulative rounding over owners in sorted id order so neither the split nor the 1-cent
// remainder depends on ledger order. `undefined` without a positive attribution, which sends the caller to
// the single-ledger-owner fallback.
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

// Allocates a drawn owner's §408A/§402A additional-tax base across that owner's accounts in proportion to
// attributed dollars (sorted id order, cumulative rounding, exact sum), so a scenario-marked exempt account
// waives only its own share, as in `allocateByDraw`.
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

/**
 * Builds the early-withdrawal, HSA and Roth-earnings penalty inputs for the cashflow solver's second pass
 * from the converged trial classification and the per-owner Roth carrier. The solver is household-aggregate:
 * the whole pre-tax bucket is the §72(t) basis (primary owner's birthdate), the cash-like bucket's HSA share
 * funds the 20% §223(f)(4) tax, and the Roth bucket splits into §408A and §402A slices.
 * Dollar state is consumed per owner via the classifier's per-account attribution; the exact per-account
 * penalty is computed in the annotation post-pass. Mutates `rothBasisCarrier` and `designatedRoth`; the Roth
 * taxable excess is returned separately and is $0 for a qualified distribution.
 */
export function buildSolverPenaltyAccountsForYear(args: {
  readonly ctx: PipelineContext;
  /** The year being funded; dates the §402A(c)(4)(D) recapture windows. */
  readonly taxYear: number;
  readonly ledgerAccounts: ReadonlyArray<DrawdownAccountInput>;
  readonly classification: {
    readonly preTaxDollars: number;
    readonly postTaxCashLikeDollars: number;
    readonly rothDollars: number;
    /**
     * The inherited Roth IRA portion of `rothDollars`: a subset, not a separate bucket, so funded and taxed
     * totals are unchanged and only the §408A carrier consumption changes.
     */
    readonly rothInheritedTaxFreeDollars?: number;
    /**
     * The committed non-inherited designated-Roth portion of `rothDollars`, a disjoint subset that selects
     * the slice run through the pooled §402A pro-rata regime; the remainder runs the §408A carrier.
     */
    readonly rothDesignatedDollars?: number;
    /**
     * The committed inherited designated-Roth portion of `rothDollars`, a third disjoint subset run against
     * the per-owner inherited state, where the owner's death is the qualifying event (§402A(d)(2)(B)(i)) and
     * the 10% is waived (§72(t)(2)(A)(ii)); never the §408A carrier.
     */
    readonly rothInheritedDesignatedDollars?: number;
    /**
     * Per-account attribution of the §408A Roth-IRA remainder slice. When present, each account's dollars are
     * charged against its real owner's own carrier entry and qualified on that owner's own facts (59½ and
     * carrier clock), with additional-tax base emitted per real account id; absent falls back to the
     * single-ledger-owner, household-conservative path.
     */
    readonly rothIraDollarsByAccountId?: ReadonlyMap<string, number>;
    /** Per-account attribution of `rothDesignatedDollars`, with the same contract. */
    readonly rothDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
    /** Per-account attribution of `rothInheritedDesignatedDollars`, with the same contract. */
    readonly rothInheritedDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
    /**
     * HSA dollars funded against medical demand (a subset of the cash-like bucket); narrows the §223
     * nonqualified basis to the emergency residual.
     */
    readonly hsaMedicalQualifiedDollars?: number;
    /**
     * Classifier-modeled HSA total draw (medical-first plus emergency); replaces the balance-share estimate
     * so the §223 emergency basis matches the committing kernel.
     */
    readonly hsaWithdrawalDollars?: number;
  };
  readonly rothBasisCarrier: RothBasisCarrier;
  /**
   * The funding pass's per-owner pooled designated-Roth state (`seedSolverDesignatedRothStates`), mutated
   * with `rothBasisCarrier`; each drawn owner's own entry is charged via the classifier's attribution. The
   * §408A carrier holds Roth-IRA basis, which is not basis of a §402A(d)(4) distribution. Empty without
   * designated-Roth facts.
   */
  readonly designatedRoth: SolverDesignatedRothStates;
  /**
   * The inherited counterpart of `designatedRoth` (`seedSolverInheritedDesignatedRothStates`), whose entries
   * make the owner's death the qualifying event and waive the 10%; optional, and absent with a positive
   * inherited subset gives the conservative $0-basis default.
   */
  readonly inheritedDesignatedRoth?: SolverDesignatedRothStates;
}): { penaltyAccounts: readonly PenaltyAccountSnapshot[]; rothEarningsExcessDollars: number } {
  const { ctx, ledgerAccounts, classification, rothBasisCarrier } = args;
  const accountById = new Map(ctx.accountProjections.map((p) => [p.account.id, p.account]));
  const out: PenaltyAccountSnapshot[] = [];
  const primaryOwnerId = ctx.primary.id;

  // The aggregate §72(t) pre-tax tranche is attributed to a pre-tax or MIXED ledger account so the penalty
  // engine finds the owner birthdate; the primary owner is the fallback.
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

  // Only the HSA share of the cash-like bucket is the §223(f)(4) nonqualified basis; feeding the whole bucket
  // would over-tax savings/CD/MM principal when `hsaQualifiedMedicalExpensePct < 100`. The solver has no
  // per-account draw, so the share is the HSA's balance share of cash-like ledger balances.
  const hsaLedger = ledgerAccounts.find((a) => a.accountType === 'HSA');
  if (hsaLedger && classification.postTaxCashLikeDollars > 0) {
    const account = accountById.get(hsaLedger.id);
    // Use the classifier's HSA total when supplied, so the §223 emergency basis matches the committing
    // kernel; otherwise estimate the share by balance.
    const hsaWithdrawalDollars =
      classification.hsaWithdrawalDollars !== undefined
        ? Math.max(0, classification.hsaWithdrawalDollars)
        : hsaShareOfCashLike(hsaLedger, ledgerAccounts, classification.postTaxCashLikeDollars);
    if (hsaWithdrawalDollars > 0) {
      // The classifier's medical-qualified figure is already HSA-specific, capped at this snapshot's HSA
      // withdrawal, so the tax pass narrows the §223 basis exactly as the post-pass does.
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

  // Under attribution, dollar state and age/clock qualification resolve per drawn owner, as in the annotation
  // pass; only an attribution-free classification uses the household-conservative reduction.
  let rothEarningsExcessDollars = 0;
  // Inherited Roth IRA dollars leave the ordered withdrawal before the carrier is touched: netting them
  // afterwards would still exhaust the owner's own basis and mis-tax the next year. They stay inside
  // `rothDollars` so the effective-tax-rate denominator does not move.
  const inheritedRothDollars = Math.min(
    Math.max(0, classification.rothDollars),
    Math.max(0, classification.rothInheritedTaxFreeDollars ?? 0),
  );
  const carrierRothDollars = classification.rothDollars - inheritedRothDollars;
  if (carrierRothDollars > 0) {
    const withdrawnCents = Math.round(carrierRothDollars * 100);
    // The designated subset, capped at the non-inherited total, keeps an unrelated Roth-IRA draw from
    // consuming a designated plan's rollover lots and a designated draw from consuming §408A basis. Absent is
    // 0.
    const designatedCents = Math.min(
      withdrawnCents,
      Math.round(Math.max(0, classification.rothDesignatedDollars ?? 0) * 100),
    );
    // The inherited designated subset runs its own slice: the owner's death qualifies it and none of its
    // principal is recapture-bearing, so never the §408A carrier or the non-inherited state.
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
      // This slice holds only non-inherited, non-designated Roth dollars, so an inherited Roth IRA (no
      // carrier entry) must not be picked as the charged owner, or the whole tranche would score as earnings
      // excess. Employer-Roth fallbacks remain for hand-rolled classifications with no designated subsets.
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
      // Dollar consumption is per owner: each drawn account's dollars go to its real owner and run the §408A
      // ordering (basis first, lots FIFO with their own recapture windows, then earnings) against that
      // owner's own entry, so ledger order cannot decide whose basis shields whom. Without attribution the
      // selected ledger owner is charged.
      const ownerCents = ownerCentsFromDrawAttribution(
        classification.rothIraDollarsByAccountId,
        iraCents,
        (accountId) => accountById.get(accountId)?.payload.ownerId ?? primaryOwnerId,
      );
      // Qualification under attribution uses each drawn owner's own 59½ status and carrier clock, so an owner
      // who drew nothing cannot turn a housemate's qualified draw into phantom income or a phantom 10%.
      // Without attribution the household-conservative `reduceRothSliceQualification` applies, and its
      // `penaltyOwnerId` owns the snapshot since the penalty prorates by that owner's birthdate.
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
          // The owner's own carrier clock under attribution (a default entry carries none, conservatively
          // unmet); the household-conservative clock otherwise.
          firstContributionTaxYear:
            ownerCents !== undefined ? entry.firstContributionTaxYear : fallbackClock,
        });
        taxableExcessCents += result.incomeTaxableCents;
        if (ownerCents !== undefined) {
          // `rothOrderedAdditionalTaxBase`: the ordering engine already resolved source-level exemptions, so
          // the penalty engine applies the 10% with its half-birthday proration without re-testing the type.
          // Emitted per real account id so a marked-exempt Roth IRA waives only its own share.
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
      // Only a non-inherited designated plan may name the charged owner: inherited designated dollars run the
      // inherited slice below, so an inherited plan first in ledger order would otherwise capture the slice
      // against a fabricated $0-basis state.
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
      // Dollar consumption is per owner as in the §408A slice: each owner's cents run the §402A(d)(4) pro
      // rata against that owner's pooled running balance (never below the owner's draw, so the basis fraction
      // stays at most 1), via `computeDesignatedRothDistribution` / `allocateDesignatedRothBasis`, so funded
      // recapture is the pro-rata in-window figure.
      const ownerCents = ownerCentsFromDrawAttribution(
        classification.rothDesignatedDollarsByAccountId,
        designatedCents,
        (accountId) => accountById.get(accountId)?.payload.ownerId ?? primaryOwnerId,
      );
      // §402A qualification as in the §408A slice: per drawn owner under attribution (own 59½ status and own
      // pooled participation clock), household-conservative only without it (59½ for every owner, latest
      // clock, absent if any lacks one).
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
      // A drawn owner with no recorded designated facts gets the annotation pass's conservative default ($0
      // basis, no lots, unmet clock). Under attribution the §72(t)(9) carve-out is granted only when every
      // non-inherited designated account of that owner is a governmental 457(b), so a non-457(b) sibling's
      // 10% is never waived.
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
          // Under attribution the entry's own participation clock governs; otherwise the
          // household-conservative clock replaces it.
          ...(ownerCents !== undefined
            ? {}
            : { pooledParticipationClock: { firstParticipationTaxYear: fallbackClock } }),
        });
        state.balanceRemainingCents = Math.max(0, balanceCents - cents);
        taxableExcessCents += result.incomeTaxableCents;
        if (ownerCents !== undefined) {
          // Per real account id under attribution: a marked-exempt plan waives only its own share, and the
          // drawn owner's birthdate drives the proration.
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

    // Inherited designated slice: the owner's death is the qualifying event (§402A(d)(2)(B)(i)), so it runs
    // the §402A pro-rata primitive against the per-owner inherited pooled state. It can fund ordinary income
    // on nonqualified earnings but never a 10% (§72(t)(2)(A)(ii)), so no penalty snapshot is emitted. It
    // never touches the §408A carrier or the non-inherited state, whose lots its principal is not part of.
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
      // Dollar consumption is per beneficiary: each inherited plan's dollars go to the beneficiary who drew
      // them, so one beneficiary's basis never shields another's draw. Without attribution the selected
      // ledger owner is charged.
      const ownerCents = ownerCentsFromDrawAttribution(
        classification.rothInheritedDesignatedDollarsByAccountId,
        inheritedDesignatedCents,
        (accountId) => accountById.get(accountId)?.payload.ownerId ?? primaryOwnerId,
      );
      // Participation clock as in the slices above: under attribution each beneficiary's own pooled entry
      // carries it (a default entry is unmet); without it, the latest across owners holding an inherited
      // designated account, absent if any lacks one. The 59½ and penalty legs are unused because death
      // qualifies and the 10% is waived.
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
          // No recorded facts for this beneficiary: $0 basis, no lots, unmet clock, so the share is
          // nonqualified earnings (ordinary income; the inherited flag still waives the 10%).
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
          // The death event, not age, decides qualification here, so `false` is conservative without changing
          // the primitive's result.
          ownerReached59Half: false,
          // Under attribution the entry's own participation clock governs; the household-conservative clock
          // replaces it otherwise.
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
 * Per-owner at-retirement designated-Roth pocket balance (integer cents), seeding the pooled §402A(d)(4)
 * pro-rata denominator (`seedSolverDesignatedRothStates`): a pure Roth employer account contributes its whole
 * balance, a MIXED Roth-designated one its post sub-bucket. An inherited plan contributes nothing unless
 * `inherited: true`, which sizes the inherited slice instead.
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

/** Counts living taxpayers age 65+ in the tax year, excluding deceased members. */
export function countTaxpayersAge65Plus(
  ctx: PipelineContext,
  taxYear: number,
  primaryAlive: boolean,
  secondaryAlive: boolean,
): number {
  let count = 0;
  const countMember = (member: Aggregate<{ birthdate?: string | null }>): void => {
    // Born-Jan-1 rule applied via `hasAttainedAgeByYearEnd`.
    if (hasAttainedAgeByYearEnd(member.payload.birthdate, taxYear, 65)) count += 1;
  };
  if (primaryAlive) countMember(ctx.primary);
  if (ctx.secondary && secondaryAlive) countMember(ctx.secondary);
  return count;
}

/**
 * RMD shortfall in integer cents against the IRS-aggregated pool minimum:
 * `sum over pools of max(0, poolRequired - poolWithdrawn)`, grouping accounts by `poolKeyForRmdAccount` (an
 * owner's IRAs pool; each 401(k)/457(b)/TSP/cash-balance is its own). A household total hides one account's
 * miss and a per-account figure over-counts where the IRS allows aggregation.
 * Satisfying cents come from `rmdEligibleWithdrawnCents`. A QCD counts toward the owner's IRA RMD
 * (§408(d)(8)), so `qcdRmdOffsetCentsByOwner` is credited to that owner's IRA pool only. Returns `null`
 * without a per-account map, so the caller uses the household figure.
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
  // Pool required and withdrawn within each IRS aggregation pool, then take the positive part per pool.
  const poolRequired = new Map<string, number>();
  const poolWithdrawn = new Map<string, number>();
  // Seed each owner's IRA pool with the QCD offset that satisfied it; `poolKeyForRmdAccount` ignores the
  // account id for IRAs, so the credit lands on exactly that pool.
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
    // An orphan id is its own singleton pool by bare id; an inherited account never aggregates with the
    // beneficiary's own IRAs or another decedent's, so a compliant own-IRA draw cannot cover an inherited
    // minimum.
    const poolKey = account
      ? poolKeyForRmdAccount(
          account.payload.ownerId,
          account.payload.type,
          id,
          // Optional-chained for hand-rolled test contexts that omit the map.
          ctx.rmdProfileFactsByAccountId?.get(id)?.inheritedAccount === true,
        )
      : poolKeyForRmdAccount(id, 'RETIREMENT_401K', id);
    const row = accountBalances.get(id);
    // Delegate to the shared `rmdEligibleWithdrawnCents` so this surface, `hasRmdShortfall` and the MC
    // post-pass agree on what satisfies a requirement.
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

function birthYearOf(isoBirthdate: string | null | undefined): number | undefined {
  if (!isoBirthdate) return undefined;
  const y = parseInt(isoBirthdate.slice(0, 4), 10);
  return Number.isNaN(y) ? undefined : y;
}

/**
 * Builds the `FilingPlanContext` for one projection year from the pipeline context (household cardinality,
 * alive flags, the legacy scalar `filingStatus`, member birth years for age-anchored windows). The stored
 * `taxFilingPlan` is left `undefined` for `resolveTaxUnitsForYear` to layer on. Deterministic only: MC builds
 * its own in `resolveMcFilingForYear`.
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

// The canonical projected death year (`birth year + life-expectancy age`), or `undefined`; death is Dec 31 of
// that year. An unknown or malformed birthdate gives no death year, so the member is alive indefinitely on
// both engines: a `parseInt` would return `NaN` and, since `taxYear <= NaN` is false, read as dead every year
// while MC read alive, pricing different household sizes into `computeAcaPtc`. Validation is the strict
// `isValidRmdIsoDate` (a real `YYYY-MM-DD` in [1900, 2200]).
function resolveMemberDeathYear(
  birthdateIso: string | null | undefined,
  lifeExpectancyAge: number,
): number | undefined {
  if (!isValidRmdIsoDate(birthdateIso)) return undefined;
  return Number(birthdateIso.slice(0, 4)) + lifeExpectancyAge;
}

/**
 * The household's two projected death years from one derivation shared by the deterministic post-pass (which
 * maps `undefined` to `Infinity`) and the MC contexts (which omit an absent year); a single-member household
 * has no secondary year.
 */
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

// Re-validates a stored tax year against the `[1998, 2200]` bound the migration sanitiser uses, since a
// current-version payload bypasses the v4 to v5 migration; `undefined` when out of bounds.
function validRothFactTaxYear(year: number | undefined): number | undefined {
  return isValidRothTaxYear(year) ? year : undefined;
}

// Whether the plan type is a governmental 457(b), whose Roth earnings are exempt from the 10% §72(t)
// additional tax (§72(t)(9)): the app models every Roth 457(b) as governmental (pure `RETIREMENT_ROTH_457B`
// and the MIXED `RETIREMENT_457B` designated subaccount).
function isGovernmental457bType(type: AccountType): boolean {
  return type === 'RETIREMENT_ROTH_457B' || type === 'RETIREMENT_457B';
}

// One per-year Roth movement in cents before it is named a conversion or an in-plan rollover; both facts
// share this shape.
interface DatedRothAmountCents {
  readonly taxYear: number;
  readonly taxableCents: number;
  readonly nontaxableCents: number;
}

// Per-year Roth movements per account from the annual balance rows, shared by the §408A conversion and
// §402A(c)(4) in-plan rollover facts. A row with neither amount is skipped (absent is a weaker claim than a
// stored 0), values are re-validated because an import row bypasses the migrations, and a row with an invalid
// tax year is dropped since the year keys the lot's clock.
// Two rows for one (account, year) resolve to the first, not their sum: the seed-balance reducers keep the
// first, and the amounts are annual totals, so summing would inflate basis and understate ordinary income.
// The output is uncapped, bounded by the 203 valid tax years; a 200-lot cap would drop the latest lots and
// remove recapture.
function buildDatedRothAmountsByAccount(
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
  taxableKey: keyof AccountBalancePayload,
  nontaxableKey: keyof AccountBalancePayload,
): Map<string, { lots: DatedRothAmountCents[]; principalCents: bigint }> {
  // First row wins per (account, tax year). A `null` slot means the winning row recorded no movement,
  // distinct from an absent slot (no row at all).
  const byAccount = new Map<string, Map<number, DatedRothAmountCents | null>>();
  for (const { payload } of balances) {
    const taxYear = validRothFactTaxYear(payload.year);
    // A row without a usable tax year cannot be ordered and is dropped without claiming a slot.
    if (taxYear === undefined) continue;
    let byYear = byAccount.get(payload.accountId);
    if (!byYear) {
      byYear = new Map<number, DatedRothAmountCents | null>();
      byAccount.set(payload.accountId, byYear);
    }
    // The first row claims the slot before the has-a-movement test, so a later duplicate cannot supply facts
    // when the winner records none; otherwise a conversion on the loser row would create basis against the
    // winner's balance and make an early withdrawal tax-free.
    if (byYear.has(taxYear)) continue;
    const taxable = payload[taxableKey];
    const nontaxable = payload[nontaxableKey];
    // Nothing recorded for the year: no lot, since absent is a weaker claim than a stored 0.
    if (!isValidRothMoney(taxable) && !isValidRothMoney(nontaxable)) {
      byYear.set(taxYear, null);
      continue;
    }
    // Each amount is bounded by `isValidRothMoney`, so one row's cents is a safe integer; two accounts
    // converting in the same year can still overflow the pooled aggregate, which `orderRothIraDistribution`
    // deliberately throws on rather than understate.
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
    // Every year for this account recorded nothing, the same as having no rows.
    if (lots.length === 0) continue;
    // The principal total spans up to 203 years, so it accumulates in BigInt. It feeds the designated-Roth
    // basis floor, and `computeDesignatedRothDistribution` derives ordinary basis as `basisCents - lotsTotal`
    // from the same lots; an excess floor would become basis belonging to no lot and, being consumed before
    // every rollover lot, silently remove all §72(t) recapture.
    let principalCents = 0n;
    for (const lot of lots) {
      principalCents += BigInt(lot.taxableCents) + BigInt(lot.nontaxableCents);
    }
    out.set(accountId, { principalCents, lots });
  }
  return out;
}

/**
 * The account-input shape `buildRothDistributionFacts` expects, projected (not filtered) off the household's
 * non-deleted accounts. Shared by `buildPipelineContext` and the report's Roth tax-free-amounts table so both
 * resolve the same account set.
 */
export function buildRothAccountFactInputs(
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): ReadonlyArray<{ id: string; payload: AccountPayload }> {
  return accounts.map((account) => ({ id: account.id, payload: account.payload }));
}

/**
 * Roth-engine adapter: maps Roth account payloads and annual balance rows to the cents-normalised
 * distribution facts both engines' carriers consume, with conservative missing-fact defaults ($0 basis, no
 * five-year anchor). See `docs/math-retirement-accounts.md`, "Roth withdrawal rules".
 * Roth IRAs aggregate per §408A pool (`rothIraPoolKey`, Pub 590-B) with basis and remaining lots derived from
 * recorded history; an inherited Roth IRA gets no pool. Designated-Roth accounts are keyed per account id and
 * never pool (§402A(d), Treas. Reg. §1.402A-1), each with its own clock, rollover lots and 457(b) flag.
 */
export function buildRothDistributionFacts(
  /**
   * The household's non-deleted accounts, active and inactive: a Roth IRA's recorded contribution history
   * counts whatever its status, an employer plan's designated-Roth facts only while active.
   */
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  /**
   * The household's annual account-balance rows, the source of every Roth-IRA contribution, conversion and
   * withdrawal and every designated-Roth in-plan rollover; rows for other accounts are ignored.
   */
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): RothDistributionFacts {
  // The designated-Roth dated fact comes off the balance rows through the shared per-account helper; the
  // Roth-IRA side derives its remaining lots from the pool's §408A derivation instead.
  const rolloverLotsByAccount = buildDatedRothAmountsByAccount(
    balances,
    'rothInPlanRolloverTaxableAmount',
    'rothInPlanRolloverNontaxableAmount',
  );
  interface MutablePoolFacts {
    /**
     * Every non-deleted Roth IRA in this §408A pool, active or not: an inactive account's recorded
     * contribution history is real basis that followed the money into a sibling account.
     */
    readonly accounts: { id: string }[];
    /** The pooled five-year anchor, contributed by active accounts only. */
    rothIraFirstYear?: number;
    /**
     * True when at least one of the pool's accounts is active; an all-inactive pool that derives to nothing
     * is not emitted.
     */
    hasActiveAccount: boolean;
    /** The real member id behind the pool (the map key is the pool key). */
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
      // An inherited Roth IRA gets no pool at all, not a $0 one: an emitted pool alone would materialise
      // basis state in the carrier seeding and the ordering pass. Read off the raw payload with `=== true`;
      // an inherited designated-Roth plan keeps its §402A treatment below.
      if (payload.rmdInheritedAccount === true) continue;
      // The pool takes the account whatever its status; basis and remaining lots are derived from the pool's
      // recorded history below.
      const o = pool(rothIraPoolKey(payload.ownerId, id, false), payload.ownerId);
      o.accounts.push({ id });
      // The clock is scoped to active accounts: Roth qualification is not part of the basis derivation, so an
      // all-inactive pool carries basis with no anchor, the conservative unmet clock.
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
      // The designated branch is active-only: an inactive employer plan holds no balance
      // (`ACCOUNT_NOT_ZEROED`), so its recorded basis would inflate an active sibling's pooled basis
      // numerator.
      if (!payload.active) continue;
      const rothStart = resolveRothStartYear({
        accountId: id,
        type: payload.type,
        taxTreatment: payload.taxTreatment,
        explicitYear: payload.designatedRothFirstParticipationTaxYear,
        balances,
      });
      // One fact set per account, never pooled; rollover lots come from this account's own balance rows,
      // validated and sorted by the shared helper.
      const rollover = rolloverLotsByAccount.get(id);
      const inPlanRolloverLots: RothInPlanRolloverLotCents[] = (rollover?.lots ?? []).map(
        (lot) => ({
          taxYear: lot.taxYear,
          taxableRolloverPrincipalCents: lot.taxableCents,
          nontaxableRolloverPrincipalCents: lot.nontaxableCents,
        }),
      );
      // Every in-plan Roth rollover dollar is basis (taxed or after-tax at rollover), so the total rollover
      // principal is a known lower bound for the account's designated basis, derived from the same lot values
      // the distribution helper re-sums.
      const lotsPrincipal = rollover?.principalCents ?? 0n;
      // The account's designated-Roth basis is its recorded in-plan-rollover principal and nothing else
      // (schema v7 has no stored total), so a plan with no recorded rollover has $0 basis and ordinary
      // designated basis is always $0, both in the more-tax direction. The floor saturates high on a
      // safe-integer overflow, since collapsing to 0 would drop known taxable principal out of the §72(t)
      // recapture base.
      const basisCents = safeRothBasisFloorFromBigInt(lotsPrincipal);
      designatedByAccount.set(id, {
        accountId: id,
        ownerId: payload.ownerId,
        basisCents,
        firstParticipationTaxYear: rothStart.year,
        inPlanRolloverLots,
        isGovernmental457b: isGovernmental457bType(payload.type),
        // An inherited designated-Roth account's distributions are on account of the original owner's death:
        // qualified once its own five-year period is met, and never subject to the 10% (§72(t)(2)(A)(ii)).
        ...(payload.rmdInheritedAccount === true
          ? { inheritedFromDeceasedOwner: true }
          : {}),
      });
    }
  }

  const rothIraByPool = new Map<string, RothIraPoolFactsCents>();
  for (const [poolKey, o] of rothIraAcc.entries()) {
    // One derivation per §408A pool over its whole recorded history, returning what survives (remaining
    // regular basis and conversion lots with tax year and taxable/nontaxable split), so historical outflows
    // are never re-applied downstream.
    const derived = deriveRothPoolBasisCents(o.accounts, balances);
    // A pool with no active account that derives to nothing is an absence, not a $0 fact: emitting it would
    // only disqualify, because the MC pooled profile walks every pool and a closed, fully withdrawn Roth IRA
    // would blank the household clock (§408A(d)(2)(B): the clock keeps running after the account closes). A
    // basis-carrying all-inactive pool is still emitted.
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
      // An all-inactive basis-carrying pool is flagged so the MC aggregate seed excludes its undrawable basis
      // while its clock and owner-set consequences stay.
      ...(o.hasActiveAccount ? {} : { allAccountsInactive: true as const }),
    });
  }
  return { rothIraByPool, designatedByAccount };
}

/**
 * Normalizes one account payload's stored `rmd*` facts into `RmdAccountProfileFacts`, re-validating each
 * against `db/rmd-fact-validation.ts` because a current-version payload bypasses the sanitising migration. An
 * invalid value is dropped, resolving to the conservative default (inherited: RMD withheld, fact listed;
 * owner: larger Uniform Lifetime RMD).
 * Returns `undefined` when no fact is recognisable, keeping a fact-free household on the default path.
 */
function buildRmdProfileFacts(
  payload: AccountPayload,
  /**
   * The spouse's birthdate from the household, for an account with the sole-spouse designation; household
   * dates are canonical, and a missing or ineligible pair falls back to the Table III path.
   */
  householdSpouseBirthdate?: string,
  /**
   * This account owner's own birthdate from the household; on an inherited account the owner is the
   * beneficiary, so it is the Table I birthdate. Canonical whenever present; a stored per-account copy is
   * only a fallback.
   */
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
    // The designation is accepted only while the household dates prove the Table II age gap; otherwise the
    // stale flag is dropped and the standard Table III path applies.
    soleSpouseBeneficiaryMoreThan10YrsYounger: householdSpouseEligible || undefined,
    spouseBeneficiaryBirthdate: householdSpouseEligible
      ? date(householdSpouseBirthdate)
      : undefined,
    beneficiaryType: isValidRmdBeneficiaryType(payload.rmdBeneficiaryType)
      ? payload.rmdBeneficiaryType
      : undefined,
    inheritedOwnerDeathDate: date(payload.rmdInheritedOwnerDeathDate),
    inheritedOwnerDiedOnOrAfterRbd: bool(payload.rmdInheritedOwnerDiedOnOrAfterRbd),
    // The inherited account's owner is its beneficiary: prefer the household birthdate, with the per-account
    // copy only a fallback for legacy data.
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

/**
 * Per-account RMD profile facts for a whole account set by account id; accounts with no facts are omitted.
 */
export function buildRmdProfileFactsByAccount(
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  /**
   * Each owner's spouse birthdate from the household by owner member id (for member A, member B's birthdate);
   * absent or ineligible ignores a stale designation.
   */
  spouseBirthdateByOwnerId?: ReadonlyMap<string, string>,
  /** Each member's own birthdate by member id: the Table I birthdate on an inherited account. */
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
