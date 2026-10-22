/**
 * Pure fact-based Roth distribution-tax rules (IRS Pub. 590-B ordering, §408A(d) / §402A: conversion recapture clocks,
 * designated-Roth pro rata, qualification) in integer cents. A leaf module with no imports, so it mirrors the persisted shapes itself.
 */

/** The §408A / §402A qualification period: five taxable years. */
export const ROTH_FIVE_TAX_YEAR_PERIOD = 5;

/** One conversion lot in integer cents. */
export interface RothConversionLotCents {
  readonly taxYear: number;
  readonly taxableConvertedPrincipalCents: number;
  readonly nontaxableConvertedPrincipalCents: number;
}

/**
 * One in-plan Roth rollover lot in cents; a taxable in-plan rollover starts its own five-tax-year §402A(c)(4)(D)
 * recapture clock. One lot per tax year with the halves pre-summed: the clock attaches to the tax year, so there is no
 * principled order within a year, and consuming all of a year's taxable principal first (as §408A(d)(4)(B) does)
 * recaptures 100 where per-lot ordering would recapture 1 on a 100 withdrawal. It errs toward more recapture.
 */
export interface RothInPlanRolloverLotCents {
  readonly taxYear: number;
  readonly taxableRolloverPrincipalCents: number;
  readonly nontaxableRolloverPrincipalCents: number;
}

/** Conservative, cents-normalised Roth-IRA distribution facts for one owner. */
export interface RothIraDistributionFactsCents {
  /**
   * Distribution from an inherited Roth IRA, made on account of the original owner's death: qualified once the
   * five-taxable-year period (from the original owner's first contribution year) is met (IRC §408A(d)(2)(A)(ii)), and
   * no 10% additional tax at any beneficiary age (IRC §72(t)(2)(A)(ii)). Absent means an owner account.
   */
  readonly inheritedFromDeceasedOwner?: boolean;
  /** Remaining regular-contribution basis (cents); 0 when absent (conservative). */
  readonly regularContributionBasisCents: number;
  /** First Roth-IRA contribution tax year; undefined means the five-year rule is not satisfied. */
  readonly firstContributionTaxYear?: number;
  /** Conversion lots, FIFO by `taxYear`. */
  readonly conversionLots: readonly RothConversionLotCents[];
}

/** Conservative cents-normalised designated-Roth facts for one account; unlike Roth IRAs, designated-Roth accounts do not aggregate across plans. */
export interface DesignatedRothDistributionFactsCents {
  /** Known designated-Roth basis (cents), including in-plan rollover principal (taxed at rollover); 0 when absent (conservative). */
  readonly basisCents: number;
  readonly firstParticipationTaxYear?: number;
  /** In-plan Roth rollover lots, each with its own §402A(c)(4)(D) five-tax-year recapture clock. */
  readonly inPlanRolloverLots?: readonly RothInPlanRolloverLotCents[];
  /** Governmental 457(b): ordinary Roth earnings are exempt from the 10% §72(t) additional tax (§72(t)(9)). */
  readonly isGovernmental457b?: boolean;
  /** Inherited account: a distribution on account of the original owner's death is qualified once the account's own five-year period is met (§402A(d)(2)(B)(i)) and never carries the 10% additional tax (§72(t)(2)(A)(ii)). Absent means an owner account. */
  readonly inheritedFromDeceasedOwner?: boolean;
}

/** Per-account designated-Roth facts, keyed by account id. */
export interface DesignatedRothAccountFactsCents extends DesignatedRothDistributionFactsCents {
  readonly accountId: string;
  readonly ownerId: string;
}

/**
 * One §408A Roth-IRA pool's distribution facts (cents). A pool is an owner's own Roth IRAs, which aggregate as one
 * account for §408A ordering (Pub 590-B). An inherited Roth IRA has no pool (its dollars are tax-free with no basis
 * state, so `buildRothDistributionFacts` emits none); designated-Roth accounts never pool and are carried per account.
 * Declared here so the pipeline context type avoids an import cycle through the carrier.
 */
export interface RothIraPoolFactsCents {
  readonly rothIra?: RothIraDistributionFactsCents;
  /** Member who owns (or inherited) the account(s) behind the pool; the map is keyed by pool, so per-owner roll-ups need the real id. */
  readonly ownerId: string;
  /**
   * Every account behind the pool is inactive. The pool is still emitted because its history leaves real §408A basis
   * or lots, but no engine can draw from it, so the MC aggregate seed excludes them (otherwise MC would shelter dollars
   * no deterministic draw can reach, under-reporting tax); the blanked pooled clock and widened 59½ owner set stay.
   */
  readonly allAccountsInactive?: true;
}

/**
 * §408A pool key: an owner's own Roth IRAs share one pool keyed by the bare `ownerId` (IRC §408A / Pub 590-B treat
 * them as one account: basis sums, conversion lots merge FIFO, the five-taxable-year clock runs from the earliest).
 * The `inherited` branch yields a per-account key namespaced with `::inherited-acct:` so it cannot collide with an
 * owner id; no §408A caller passes `true`, since an inherited Roth IRA has no pool.
 */
export function rothIraPoolKey(
  ownerId: string,
  accountId: string,
  inherited: boolean,
): string {
  const owner = ownerId === '' ? accountId : ownerId;
  return inherited ? `${owner}::inherited-acct:${accountId}` : owner;
}

/** Household fact-based Roth tax profile: per-pool Roth-IRA facts plus per-account designated-Roth facts. */
export interface RothDistributionFacts {
  readonly rothIraByPool: ReadonlyMap<string, RothIraPoolFactsCents>;
  readonly designatedByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>;
}

/** Full §408A ordering breakdown for one Roth-IRA distribution. */
export interface RothIraDistributionResult {
  readonly qualified: boolean;
  readonly regularContributionCents: number;
  readonly conversionTaxablePrincipalCents: number;
  readonly conversionNontaxablePrincipalCents: number;
  readonly earningsCents: number;
  readonly incomeTaxableCents: number;
  /** Cents subject to the 10% §72(t) additional tax: nonqualified pre-59½ earnings plus taxable-converted principal inside its year's five-year window; 0 when qualified or 59½+. */
  readonly additionalTaxBaseCents: number;
}

interface DesignatedRothLotConsumptionCents {
  readonly taxableConsumedCents: number;
  readonly nontaxableConsumedCents: number;
}

interface DesignatedRothBasisAllocationCents {
  readonly ordinaryBasisConsumedCents: number;
  readonly lotConsumptions: readonly DesignatedRothLotConsumptionCents[];
  readonly recaptureCents: number;
}

/** Split of a designated-Roth distribution into its tax buckets. */
export interface DesignatedRothDistributionResult {
  readonly qualified: boolean;
  readonly basisCents: number;
  readonly earningsCents: number;
  readonly incomeTaxableCents: number;
  /** 10% §72(t) base: nonqualified pre-59½ earnings (except governmental-457(b) ordinary earnings) plus in-window taxable in-plan Roth rollover principal; 0 when qualified or 59½+. */
  readonly additionalTaxBaseCents: number;
  /** The ordered basis allocation the recapture was computed from; the carrier decrements each lot by exactly `lotConsumptions[i]`, so recapture and state cannot diverge at a cent boundary. */
  readonly basisAllocation: DesignatedRothBasisAllocationCents;
}

// round(a × b / d) half-up in BigInt: no float drift and no intermediate overflow past MAX_SAFE_INTEGER.
function integerHalfUp(factorA: number, factorB: number, denominator: number): number {
  const num = BigInt(factorA) * BigInt(factorB) * 2n + BigInt(denominator);
  const den = 2n * BigInt(denominator);
  return Number(num / den);
}

// Throws rather than coercing anything but a nonnegative safe integer, the cents contract the ordering math relies on.
function requireSafeNonnegIntCents(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `roth-distribution-tax: ${label} must be a nonnegative safe integer (got ${String(value)})`,
    );
  }
  return value;
}

/** Rounds a Roth cents input, clamps a negative to 0 (conservative) and rejects a non-finite or unsafe value rather than propagating it into the ordering buckets. */
export function normalizeRothCents(value: number, label: string): number {
  return requireSafeNonnegIntCents(Math.max(0, Math.round(value)), label);
}

/** True when the five-taxable-year clock from `startTaxYear` is met; a missing anchor counts as not met (conservative: overstates tax, never understates). */
export function isRothFiveYearClockMet(
  startTaxYear: number | undefined,
  distributionTaxYear: number,
): boolean {
  if (startTaxYear === undefined) return false;
  return distributionTaxYear - startTaxYear >= ROTH_FIVE_TAX_YEAR_PERIOD;
}

/**
 * Qualified when the five-year clock is met and a qualifying event occurred: the owner reaching 59½ or, for an
 * inherited Roth IRA, the original owner's death (§408A(d)(2)(A)(ii)); the clock then runs from the original owner's
 * first contribution year. Missing five-year facts mean not qualified. Disability and first-home events are not
 * modeled, which is conservative.
 */
export function isRothIraDistributionQualified(
  facts: Pick<
    RothIraDistributionFactsCents,
    'firstContributionTaxYear' | 'inheritedFromDeceasedOwner'
  >,
  distributionTaxYear: number,
  ownerReached59Half: boolean,
): boolean {
  return (
    (ownerReached59Half || facts.inheritedFromDeceasedOwner === true) &&
    isRothFiveYearClockMet(facts.firstContributionTaxYear, distributionTaxYear)
  );
}

/** Designated-Roth qualification: its own five-year participation clock is met and the owner reached 59½ or, on an inherited account, the original owner died. Missing facts mean not qualified. */
export function isDesignatedRothDistributionQualified(
  facts: Pick<
    DesignatedRothDistributionFactsCents,
    'firstParticipationTaxYear' | 'inheritedFromDeceasedOwner'
  >,
  distributionTaxYear: number,
  ownerReached59Half: boolean,
): boolean {
  return (
    (ownerReached59Half || facts.inheritedFromDeceasedOwner === true) &&
    isRothFiveYearClockMet(facts.firstParticipationTaxYear, distributionTaxYear)
  );
}

/**
 * §408A(d)(4)(B) ordering of one Roth-IRA distribution: regular contributions, then conversion lots aggregated by tax
 * year (all of a year's taxable-converted principal before its nontaxable, years FIFO), then earnings. Lots dated after
 * the distribution year are skipped. Contributions and nontaxable principal are tax- and penalty-free; earnings are
 * ordinary income (and 10% §72(t) before 59½); taxable-converted principal is not re-taxed but carries the 10% recapture
 * inside its own year's five-tax-year window before 59½. Pure; the caller owns carrier mutation.
 */
export function orderRothIraDistribution(input: {
  readonly facts: RothIraDistributionFactsCents;
  readonly withdrawalCents: number;
  readonly distributionTaxYear: number;
  readonly ownerReached59Half: boolean;
}): RothIraDistributionResult {
  const { facts, distributionTaxYear, ownerReached59Half } = input;
  const withdrawalCents = normalizeRothCents(input.withdrawalCents, 'withdrawalCents');

  const qualified = isRothIraDistributionQualified(
    facts,
    distributionTaxYear,
    ownerReached59Half,
  );

  let remaining = withdrawalCents;

  const regularContributionCents = Math.min(
    remaining,
    normalizeRothCents(facts.regularContributionBasisCents, 'regularContributionBasisCents'),
  );
  remaining -= regularContributionCents;

  // Aggregate lots by tax year first: a pool merges every account's lots, so two accounts converting in one year arrive as two
  // lots sharing a year. Totals accumulate in BigInt and an aggregate past MAX_SAFE_INTEGER is rejected rather than letting an inflated basis understate tax.
  const byYear = new Map<number, { taxable: bigint; nontaxable: bigint }>();
  for (const lot of facts.conversionLots) {
    if (lot.taxYear > distributionTaxYear) continue;
    const taxable = normalizeRothCents(
      lot.taxableConvertedPrincipalCents,
      'taxableConvertedPrincipalCents',
    );
    const nontaxable = normalizeRothCents(
      lot.nontaxableConvertedPrincipalCents,
      'nontaxableConvertedPrincipalCents',
    );
    const agg = byYear.get(lot.taxYear) ?? { taxable: 0n, nontaxable: 0n };
    agg.taxable += BigInt(taxable);
    agg.nontaxable += BigInt(nontaxable);
    byYear.set(lot.taxYear, agg);
  }
  let conversionTaxablePrincipalCents = 0;
  let conversionNontaxablePrincipalCents = 0;
  let recaptureCents = 0;
  for (const taxYear of [...byYear.keys()].sort((a, b) => a - b)) {
    if (remaining <= 0) break;
    const aggBig = byYear.get(taxYear)!;
    const agg = {
      taxable: requireSafeNonnegIntCents(Number(aggBig.taxable), 'conversionTaxableYearAggregate'),
      nontaxable: requireSafeNonnegIntCents(
        Number(aggBig.nontaxable),
        'conversionNontaxableYearAggregate',
      ),
    };
    const taxableDrawn = Math.min(remaining, agg.taxable);
    conversionTaxablePrincipalCents += taxableDrawn;
    remaining -= taxableDrawn;
    if (
      taxableDrawn > 0 &&
      !ownerReached59Half &&
      distributionTaxYear - taxYear < ROTH_FIVE_TAX_YEAR_PERIOD
    ) {
      recaptureCents += taxableDrawn;
    }
    if (remaining <= 0) break;
    const nontaxableDrawn = Math.min(remaining, agg.nontaxable);
    conversionNontaxablePrincipalCents += nontaxableDrawn;
    remaining -= nontaxableDrawn;
  }

  const earningsCents = remaining;

  const incomeTaxableCents = qualified ? 0 : earningsCents;
  // §72(t)(2)(A)(ii): a death distribution carries no 10% additional tax at any beneficiary age, on earnings or in-window recapture.
  const deathExempt = facts.inheritedFromDeceasedOwner === true;
  const additionalTaxBaseCents = qualified || deathExempt
    ? 0
    : recaptureCents + (ownerReached59Half ? 0 : earningsCents);

  return {
    qualified,
    regularContributionCents,
    conversionTaxablePrincipalCents,
    conversionNontaxablePrincipalCents,
    earningsCents,
    incomeTaxableCents,
    additionalTaxBaseCents,
  };
}

/**
 * Pro-rata basis/earnings split of a designated-Roth distribution (§402A(d)(4)): the basis fraction is
 * `basis / accountBalance`; a zero balance is all earnings (conservative). Inputs must be nonnegative safe integers or
 * it throws. Exact integer arithmetic rounds a half-cent boundary correctly; earnings are the residual.
 */
export function splitDesignatedRothNonqualified(input: {
  readonly basisCents: number;
  readonly accountBalanceCents: number;
  readonly withdrawalCents: number;
}): { basisCents: number; earningsCents: number } {
  const withdrawalCents = requireSafeNonnegIntCents(input.withdrawalCents, 'withdrawalCents');
  const balanceCents = requireSafeNonnegIntCents(input.accountBalanceCents, 'accountBalanceCents');
  const basisAvailableCents = requireSafeNonnegIntCents(input.basisCents, 'basisCents');
  if (balanceCents === 0) {
    return { basisCents: 0, earningsCents: withdrawalCents };
  }
  const basisCents = Math.min(
    withdrawalCents,
    integerHalfUp(withdrawalCents, basisAvailableCents, balanceCents),
  );
  return { basisCents, earningsCents: withdrawalCents - basisCents };
}

/**
 * Ordered designated-Roth basis allocator (IRS Notice 2010-84 Q&A-13): draws `basisPortionCents` from ordinary
 * (non-rollover) basis first, which carries no recapture, then from in-plan rollover lots FIFO (oldest tax year first,
 * input index within a year), taxable before nontaxable within a lot. Taxable principal drawn from a lot inside its own
 * §402A(c)(4)(D) window before 59½ is the recapture base. The one source for both the additional-tax computation and
 * the carrier's per-lot decrement, so they cannot disagree at a cent boundary. A future-dated lot never recaptures but
 * stays consumable last, so the decrements sum to the basis consumed.
 */
function allocateDesignatedRothBasis(input: {
  readonly basisPortionCents: number;
  readonly ordinaryBasisCents: number;
  readonly inPlanRolloverLots: readonly RothInPlanRolloverLotCents[];
  readonly distributionTaxYear: number;
  readonly ownerReached59Half: boolean;
}): DesignatedRothBasisAllocationCents {
  const { inPlanRolloverLots, distributionTaxYear, ownerReached59Half } = input;
  const basisPortionCents = Math.max(0, Math.round(input.basisPortionCents));
  const ordinaryBasisCents = Math.max(0, Math.round(input.ordinaryBasisCents));

  const lotConsumptions: DesignatedRothLotConsumptionCents[] = inPlanRolloverLots.map(() => ({
    taxableConsumedCents: 0,
    nontaxableConsumedCents: 0,
  }));

  const ordinaryBasisConsumedCents = Math.min(basisPortionCents, ordinaryBasisCents);
  let remaining = basisPortionCents - ordinaryBasisConsumedCents;

  let recaptureCents = 0;
  const order = inPlanRolloverLots
    .map((lot, index) => ({ lot, index }))
    .sort((a, b) => a.lot.taxYear - b.lot.taxYear || a.index - b.index);
  for (const { lot, index } of order) {
    if (remaining <= 0) break;
    const taxable = normalizeRothCents(
      lot.taxableRolloverPrincipalCents,
      'taxableRolloverPrincipalCents',
    );
    const nontaxable = normalizeRothCents(
      lot.nontaxableRolloverPrincipalCents,
      'nontaxableRolloverPrincipalCents',
    );
    const taxableConsumedCents = Math.min(remaining, taxable);
    remaining -= taxableConsumedCents;
    // Recapture only taxable principal of a lot inside its own five-tax-year window before 59½; a future lot has no started clock.
    const inWindow =
      !ownerReached59Half &&
      lot.taxYear <= distributionTaxYear &&
      distributionTaxYear - lot.taxYear < ROTH_FIVE_TAX_YEAR_PERIOD;
    if (taxableConsumedCents > 0 && inWindow) recaptureCents += taxableConsumedCents;
    let nontaxableConsumedCents = 0;
    if (remaining > 0) {
      nontaxableConsumedCents = Math.min(remaining, nontaxable);
      remaining -= nontaxableConsumedCents;
    }
    lotConsumptions[index] = { taxableConsumedCents, nontaxableConsumedCents };
  }

  return { ordinaryBasisConsumedCents, lotConsumptions, recaptureCents };
}

/**
 * Tax buckets of one designated-Roth distribution. The pro-rata basis/earnings split is computed even when qualified
 * (only the earnings tax is waived). Nonqualified: pro-rata basis is tax-free, earnings are ordinary income and 10%
 * §72(t) before 59½, subject to the governmental-457(b) exception and in-plan-rollover recapture.
 */
export function computeDesignatedRothDistribution(input: {
  readonly facts: DesignatedRothDistributionFactsCents;
  readonly accountBalanceCents: number;
  readonly withdrawalCents: number;
  readonly distributionTaxYear: number;
  readonly ownerReached59Half: boolean;
  /** Earnings attributable to a rollover from another plan type into a governmental 457(b) still enter the 10% base (exception to the §72(t)(9) exception); ignored for other plans, absent means 0. */
  readonly rolloverAttributableEarningsCents?: number;
}): DesignatedRothDistributionResult {
  const { facts, distributionTaxYear, ownerReached59Half } = input;
  const withdrawalCents = Math.max(0, Math.round(input.withdrawalCents));
  const balanceCents = Math.max(0, Math.round(input.accountBalanceCents));
  const basisCents = Math.max(0, Math.round(facts.basisCents));

  const qualified = isDesignatedRothDistributionQualified(
    facts,
    distributionTaxYear,
    ownerReached59Half,
  );

  const { basisCents: basisPortionCents, earningsCents } = splitDesignatedRothNonqualified({
    basisCents,
    accountBalanceCents: balanceCents,
    withdrawalCents,
  });

  // Ordinary basis is total basis minus every rollover lot's principal (lot principal is basis, taxed at rollover).
  // A qualified distribution requires 59½, so its allocation recaptures nothing.
  const rolloverLots = facts.inPlanRolloverLots ?? [];
  const lotsTotalCents = rolloverLots.reduce(
    (sum, lot) =>
      sum +
      normalizeRothCents(lot.taxableRolloverPrincipalCents, 'taxableRolloverPrincipalCents') +
      normalizeRothCents(lot.nontaxableRolloverPrincipalCents, 'nontaxableRolloverPrincipalCents'),
    0,
  );
  const basisAllocation = allocateDesignatedRothBasis({
    basisPortionCents,
    ordinaryBasisCents: Math.max(0, basisCents - lotsTotalCents),
    inPlanRolloverLots: rolloverLots,
    distributionTaxYear,
    ownerReached59Half,
  });

  if (qualified) {
    return {
      qualified: true,
      basisCents: basisPortionCents,
      earningsCents,
      incomeTaxableCents: 0,
      additionalTaxBaseCents: 0,
      basisAllocation,
    };
  }

  let additionalTaxBaseCents = 0;
  // §72(t)(2)(A)(ii): a post-death distribution from an inherited account carries no 10% additional tax.
  if (!ownerReached59Half && facts.inheritedFromDeceasedOwner !== true) {
    // Governmental 457(b) (§72(t)(9)): ordinary Roth earnings are exempt, but earnings attributable to a rollover into it still count.
    const penaltyEarningsCents = facts.isGovernmental457b
      ? Math.min(
          earningsCents,
          normalizeRothCents(
            input.rolloverAttributableEarningsCents ?? 0,
            'rolloverAttributableEarningsCents',
          ),
        )
      : earningsCents;
    additionalTaxBaseCents = penaltyEarningsCents + basisAllocation.recaptureCents;
  }

  return {
    qualified: false,
    basisCents: basisPortionCents,
    earningsCents,
    incomeTaxableCents: earningsCents,
    additionalTaxBaseCents,
    basisAllocation,
  };
}
