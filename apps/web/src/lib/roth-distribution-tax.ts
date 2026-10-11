/**
 * Pure Roth distribution-tax rules (§408A ordering, conversion recapture clocks,
 * designated-Roth pro rata, qualification) — the fact-based Roth engine.
 *
 * This module is a LEAF: it has NO imports at all — it defines its own
 * integer-cents mirror interfaces (`RothConversionLotCents`,
 * `RothInPlanRolloverLotCents`, …) of the persisted dollar shapes rather than
 * importing them, so it stays free of any db / projection dependency.
 * All math is in integer cents (the tax-engine discipline — no float drift in
 * ordering math). Both engines run it on the live output path
 * (`applyRothBasisOrdering` deterministically, `applyMcRothBasisOrdering` per MC
 * path); `balance-projection-runner-roth-basis.test.ts` covers it directly.
 *
 * Legal model (IRS Pub. 590-B ordering rules + §408A(d) / §402A):
 *  - A Roth-IRA distribution is QUALIFIED when the five-tax-year clock is met AND
 *    a qualifying event occurred; we model the age-59½ event only (death /
 *    disability / first-home are out of scope, so their absence is conservative).
 *  - A NONQUALIFIED Roth-IRA distribution comes out in order: (1) regular
 *    contributions, (2) conversion lots — AGGREGATED BY TAX YEAR (§408A(d)(4)(B):
 *    all same-year conversions/rollovers aggregate, then that year's total
 *    taxable-converted principal is consumed before that year's total nontaxable
 *    principal, years FIFO), (3) earnings. Contributions and nontaxable
 *    conversion principal are always tax- and penalty-free; earnings are ordinary
 *    income (and 10% §72(t) before 59½); taxable-converted principal is never
 *    re-taxed as income but carries the 10% recapture when withdrawn inside its
 *    own year's five-tax-year window before 59½.
 *  - A designated-Roth (employer-plan) NONQUALIFIED distribution is PRO RATA
 *    between basis and earnings — NOT contribution-first. Governmental 457(b)
 *    ordinary earnings are EXEMPT from the 10% §72(t) additional tax (§72(t)(9)),
 *    except amounts attributable to a rollover from a different plan type; taxable
 *    in-plan Roth rollover principal within its own §402A(c)(4)(D) five-tax-year
 *    recapture window (before 59½) enters the additional-tax base.
 *
 * Conservative missing-fact defaults: a missing five-year anchor is treated
 * as NOT satisfied; a missing basis is treated as $0. Both overstate tax/penalty
 * and never understate.
 */

/** The §408A / §402A qualification period: five TAXABLE years. */
export const ROTH_FIVE_TAX_YEAR_PERIOD = 5;

/** One conversion lot in integer cents (the engine-side mirror of the stored
 *  dollar `RothConversionLot`). */
export interface RothConversionLotCents {
  readonly taxYear: number;
  readonly taxableConvertedPrincipalCents: number;
  readonly nontaxableConvertedPrincipalCents: number;
}

/** One in-plan Roth rollover lot in integer cents (the engine-side mirror of the
 *  stored dollar rollover amounts). A taxable in-plan Roth rollover starts its OWN
 *  separate five-tax-year §402A(c)(4)(D) recapture clock.
 *
 *  ONE LOT PER TAX YEAR. Since the amounts are recorded on the annual balance
 *  rows, a year's taxable and nontaxable halves arrive already summed, and the
 *  allocator consumes ALL of a year's taxable principal before ANY of that year's
 *  nontaxable principal. Consuming several lots for one year taxable-then-
 *  nontaxable PER LOT would recapture only 1 on a 100 withdrawal from a year
 *  holding `{taxable 1, nontaxable 99}` and `{taxable 99, nontaxable 1}`; the
 *  annual reading recaptures 100.
 *
 *  The annual reading is deliberate. §402A(c)(4)(D) attaches the recapture clock
 *  to the TAX YEAR of the rollover, not to the individual transfer, so two moves
 *  in one year share one clock and there is no principled order between them; a
 *  per-lot answer would depend on the order the user happened to type the rows
 *  in. It also matches the §408A(d)(4)(B) treatment the Roth-IRA side already
 *  applies, and it errs toward MORE recapture, which is the conservative
 *  direction this engine is required to take when a rule is ambiguous. */
export interface RothInPlanRolloverLotCents {
  readonly taxYear: number;
  readonly taxableRolloverPrincipalCents: number;
  readonly nontaxableRolloverPrincipalCents: number;
}

/** Conservative, cents-normalised Roth-IRA distribution facts for one owner. */
export interface RothIraDistributionFactsCents {
  /**
   * The distribution comes from an INHERITED Roth IRA, i.e. it is made on
   * account of the ORIGINAL owner's death. Two statutory consequences, both
   * independent of the BENEFICIARY's own age:
   *   - IRC §408A(d)(2)(A)(ii): death is itself a qualifying event, so the
   *     distribution is QUALIFIED once the five-taxable-year period (which runs
   *     from the ORIGINAL owner's first contribution year — the year recorded in
   *     `firstContributionTaxYear` on an inherited account) is satisfied.
   *   - IRC §72(t)(2)(A)(ii): a distribution made on account of death carries NO
   *     10% additional tax at any beneficiary age.
   * Absent → an owner account (the beneficiary's own 59½ test applies).
   */
  readonly inheritedFromDeceasedOwner?: boolean;
  /** Regular-contribution basis remaining (integer cents); 0 when the fact is
   *  absent (conservative). */
  readonly regularContributionBasisCents: number;
  /** First Roth-IRA contribution tax year, or `undefined` (→ five-year rule NOT
   *  satisfied). */
  readonly firstContributionTaxYear?: number;
  /** Conversion lots, FIFO by `taxYear`. Empty when absent. */
  readonly conversionLots: readonly RothConversionLotCents[];
}

/** Conservative, cents-normalised designated-Roth facts for one ACCOUNT
 *  (designated-Roth accounts do NOT aggregate across plans/accounts the way Roth
 *  IRAs do; each account keeps its own clock/basis/balance). */
export interface DesignatedRothDistributionFactsCents {
  /** Known designated-Roth basis for this account (integer cents); 0 when absent
   *  (conservative). Includes any in-plan Roth rollover principal (which is
   *  basis — it was taxed at rollover). */
  readonly basisCents: number;
  /** First designated-Roth participation tax year for this account, or
   *  `undefined`. */
  readonly firstParticipationTaxYear?: number;
  /** In-plan Roth rollover lots for this account, each with its own separate
   *  §402A(c)(4)(D) five-tax-year recapture clock. Empty when absent. */
  readonly inPlanRolloverLots?: readonly RothInPlanRolloverLotCents[];
  /** True when the plan is a GOVERNMENTAL 457(b): its ordinary Roth earnings are
   *  exempt from the 10% §72(t) additional tax (§72(t)(9)). */
  readonly isGovernmental457b?: boolean;
  /** The account is INHERITED, so the distribution is made on account of the
   *  original owner's death: qualified once the account's own five-year
   *  participation period is met (§402A(d)(2)(B)(i) death event) and never subject
   *  to the 10% additional tax (§72(t)(2)(A)(ii)), regardless of the beneficiary's
   *  age. Absent → an owner account (the owner's own 59½ test applies). */
  readonly inheritedFromDeceasedOwner?: boolean;
}

/** Per-ACCOUNT designated-Roth facts, keyed by account id. */
export interface DesignatedRothAccountFactsCents extends DesignatedRothDistributionFactsCents {
  readonly accountId: string;
  readonly ownerId: string;
}

/**
 * One §408A Roth-IRA POOL's fact-based distribution facts (cents).
 *
 * A pool is an owner's OWN Roth IRAs, which do aggregate — all of one person's
 * Roth IRAs count as one account for §408A ordering (Pub 590-B). An INHERITED
 * Roth IRA has NO pool here at all: its dollars are wholesale tax-free in
 * both engines and carry no basis state, so `buildRothDistributionFacts` never
 * emits an entry for one. Designated-Roth accounts never pool either and are
 * carried per ACCOUNT (`DesignatedRothAccountFactsCents`).
 *
 * Declared in this leaf (rather than alongside the carrier) so the pipeline
 * context type can reference the fact shapes without importing the carrier
 * module, which would close an import cycle.
 */
export interface RothIraPoolFactsCents {
  readonly rothIra?: RothIraDistributionFactsCents;
  /** The member who owns (or inherited) the account(s) behind this pool. Carried
   *  on the value because the map is keyed by POOL, not by owner — the per-owner
   *  roll-ups (MC basis seed, the 59½ owner set) still need the real member id. */
  readonly ownerId: string;
  /** EVERY account behind this pool is INACTIVE (closed). The pool is still
   *  emitted because its recorded history leaves real §408A basis or lots, but
   *  no engine can ever DRAW from it: the deterministic passes credit basis only
   *  through a drawn/ledger-listed account, so the MC aggregate seed must
   *  exclude this pool's basis and lots too — otherwise MC shelters household
   *  dollars with money no deterministic draw can reach (under-reporting tax).
   *  The pool's conservative consequences (blanked pooled clock, widened 59½
   *  owner set) stay in force. Absent → at least one active account. */
  readonly allAccountsInactive?: true;
}

/**
 * The §408A aggregation-pool key for one Roth-IRA account.
 *
 * An owner's OWN Roth IRAs share one pool keyed by the bare `ownerId`: IRC §408A
 * / Pub 590-B treat all of one person's Roth IRAs as a single account for the
 * ordering rules, so their regular basis sums, their conversion lots merge FIFO,
 * and the five-taxable-year clock runs from the EARLIEST of them.
 *
 * The `inherited` branch yields a per-account singleton key, mirroring
 * `poolKeyForRmdAccount`'s inherited singleton including its namespaced
 * `::inherited-acct:` discriminant so a key can never collide with a bare owner
 * id. No §408A caller passes `inherited = true`: an inherited
 * Roth IRA has NO pool here at all — `buildRothDistributionFacts` skips the
 * account outright (its remaining call passes a literal `false`), and
 * `collectRothDraws` drops inherited draws before `applyRothBasisOrdering`
 * groups by this key. The branch is retained only so the key stays total over
 * the `inherited` flag its callers carry, not because any singleton pool is
 * still built from it.
 */
export function rothIraPoolKey(
  ownerId: string,
  accountId: string,
  inherited: boolean,
): string {
  const owner = ownerId === '' ? accountId : ownerId;
  return inherited ? `${owner}::inherited-acct:${accountId}` : owner;
}

/** The household's whole fact-based Roth tax profile: per-POOL Roth-IRA facts
 *  (one own-accounts pool per owner; an inherited Roth IRA has no pool at all)
 *  plus per-ACCOUNT designated-Roth facts. */
export interface RothDistributionFacts {
  readonly rothIraByPool: ReadonlyMap<string, RothIraPoolFactsCents>;
  readonly designatedByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>;
}

/** Full §408A ordering breakdown for one Roth-IRA distribution. */
export interface RothIraDistributionResult {
  /** True when the whole distribution is qualified (tax- and penalty-free). */
  readonly qualified: boolean;
  /** Return-of-regular-contribution cents (always tax/penalty-free). */
  readonly regularContributionCents: number;
  /** Taxable-converted principal withdrawn (never re-taxed as income). */
  readonly conversionTaxablePrincipalCents: number;
  /** Nontaxable-converted principal withdrawn (never taxed, never penalized). */
  readonly conversionNontaxablePrincipalCents: number;
  /** Earnings withdrawn (ordinary income unless qualified). */
  readonly earningsCents: number;
  /** Cents subject to ordinary income tax (earnings when nonqualified; 0 when
   *  qualified). */
  readonly incomeTaxableCents: number;
  /** Cents subject to the 10% §72(t) additional tax: earnings (nonqualified,
   *  pre-59½) PLUS taxable-converted principal still inside its year's five-year
   *  recapture window (pre-59½). 0 when qualified or 59½+. */
  readonly additionalTaxBaseCents: number;
}

/** One in-plan Roth rollover lot's principal consumed by an ordered
 *  designated-Roth basis allocation, indexed to align with the input
 *  lot order so the carrier can decrement each lot by exactly these amounts.
 *  Consumed structurally off `DesignatedRothDistributionResult.basisAllocation`
 *  (no external import), so it is module-private. */
interface DesignatedRothLotConsumptionCents {
  readonly taxableConsumedCents: number;
  readonly nontaxableConsumedCents: number;
}

/** Ordered designated-Roth basis allocation (IRS Notice 2010-84 Q&A-13):
 *  how the withdrawal's basis portion was drawn from the account's ordinary
 *  (non-rollover) basis and its in-plan rollover lots, plus the resulting
 *  in-window taxable-rollover recapture. The recapture computation AND the
 *  carrier's lot-state decrement read this SINGLE allocation, so they can never
 *  disagree at a cent boundary. Consumed structurally off
 *  `DesignatedRothDistributionResult.basisAllocation` (no external import), so it
 *  is module-private. */
interface DesignatedRothBasisAllocationCents {
  /** Non-rollover ("ordinary") designated basis consumed (never recaptured). */
  readonly ordinaryBasisConsumedCents: number;
  /** Per-lot consumed principal, in the SAME order as the input lots. */
  readonly lotConsumptions: readonly DesignatedRothLotConsumptionCents[];
  /** In-window taxable in-plan Roth rollover principal consumed → the
   *  §402A(c)(4)(D) additional-tax recapture base. */
  readonly recaptureCents: number;
}

/** Split of a designated-Roth distribution into its tax buckets. */
export interface DesignatedRothDistributionResult {
  readonly qualified: boolean;
  /** Return-of-basis cents (tax/penalty-free; pro-rata even when qualified). */
  readonly basisCents: number;
  /** Earnings cents. */
  readonly earningsCents: number;
  /** Ordinary-income-taxable cents (earnings when nonqualified; 0 when qualified). */
  readonly incomeTaxableCents: number;
  /** 10% §72(t) additional-tax base: nonqualified pre-59½ earnings (except
   *  governmental-457(b) ordinary earnings) PLUS in-window taxable in-plan
   *  Roth rollover principal. 0 when qualified or 59½+. */
  readonly additionalTaxBaseCents: number;
  /** The ordered basis allocation the recapture was computed from.
   *  The carrier decrements each rollover lot's remaining principal by exactly
   *  `lotConsumptions[i]` so the recapture base and the state decrement can never
   *  diverge at a cent boundary. */
  readonly basisAllocation: DesignatedRothBasisAllocationCents;
}

/** `round(factorA * factorB / denominator)` half-up, computed EXACTLY with
 *  BigInt so there is no IEEE-754 float drift and no intermediate-product
 *  overflow past `Number.MAX_SAFE_INTEGER`. Callers guarantee
 *  `denominator > 0` and all args are nonnegative safe integers. */
function integerHalfUp(factorA: number, factorB: number, denominator: number): number {
  const num = BigInt(factorA) * BigInt(factorB) * 2n + BigInt(denominator);
  const den = 2n * BigInt(denominator);
  return Number(num / den);
}

/** Assert a value is a nonnegative safe integer, throwing (never silently
 *  coercing) otherwise — the cents contract the ordering math relies on.
 *  The mutable carrier (`balance-projection-runner-roth-basis.ts`) reuses this
 *  same check on its own Roth-IRA cents inputs via the exported
 *  `normalizeRothCents` wrapper rather than duplicating it. */
function requireSafeNonnegIntCents(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `roth-distribution-tax: ${label} must be a nonnegative safe integer (got ${String(value)})`,
    );
  }
  return value;
}

/** Normalise one Roth cents input: round, clamp a negative to 0 (conservative),
 *  then REJECT any non-finite / non-safe-integer value (NaN, Infinity, an out-of-
 *  precision magnitude) via `requireSafeNonnegIntCents` — never silently
 *  propagate it into the ordering buckets. Mirrors the designated-Roth
 *  path's `Math.max(0, Math.round(x))`-then-validate discipline. */
export function normalizeRothCents(value: number, label: string): number {
  return requireSafeNonnegIntCents(Math.max(0, Math.round(value)), label);
}

/**
 * True when the five-taxable-year clock started by `startTaxYear` is satisfied
 * for a distribution in `distributionTaxYear`. A missing/undefined anchor is
 * treated as NOT satisfied (conservative).
 */
export function isRothFiveYearClockMet(
  startTaxYear: number | undefined,
  distributionTaxYear: number,
): boolean {
  if (startTaxYear === undefined) return false;
  return distributionTaxYear - startTaxYear >= ROTH_FIVE_TAX_YEAR_PERIOD;
}

/**
 * A Roth-IRA distribution is qualified when the five-year clock is met AND a
 * qualifying event occurred. Two events are modeled: the owner reaching 59½, and
 * — for an INHERITED Roth IRA — the ORIGINAL OWNER'S DEATH, which is itself the
 * qualifying event (§408A(d)(2)(A)(ii)). Requiring the BENEFICIARY's own 59½ on an
 * inherited account was wrong: it taxed a beneficiary's earnings that the statute
 * treats as qualified. The five-taxable-year period still applies (on an inherited
 * account it runs from the original owner's first contribution year, which is the
 * year recorded on that account). Missing five-year facts → not qualified
 * (conservative).
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

/**
 * A designated-Roth distribution is qualified when its own five-year
 * participation clock is met AND a qualifying event occurred — the owner reaching
 * 59½, or (on an INHERITED account) the original owner's DEATH, which is itself
 * the qualifying event regardless of the beneficiary's age. Missing facts → not
 * qualified (conservative).
 */
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
 * Apply the §408A ordering to one Roth-IRA distribution of `withdrawalCents`.
 * Consumes regular contributions, then conversion lots FIFO — AGGREGATED BY TAX
 * YEAR (all same-year lots' taxable-converted principal before all same-year
 * nontaxable, per §408A(d)(4)(B), years ascending) — then earnings. Lots dated
 * AFTER the distribution year are skipped (they cannot exist yet).
 * Returns the full bucket breakdown; a qualified distribution is entirely
 * tax/penalty-free.
 *
 * Pure — the caller owns any carrier mutation.
 */
export function orderRothIraDistribution(input: {
  readonly facts: RothIraDistributionFactsCents;
  readonly withdrawalCents: number;
  readonly distributionTaxYear: number;
  readonly ownerReached59Half: boolean;
}): RothIraDistributionResult {
  const { facts, distributionTaxYear, ownerReached59Half } = input;
  // Reject a non-finite / NaN withdrawal (never propagate it into the
  // buckets); a negative clamps to 0.
  const withdrawalCents = normalizeRothCents(input.withdrawalCents, 'withdrawalCents');

  const qualified = isRothIraDistributionQualified(
    facts,
    distributionTaxYear,
    ownerReached59Half,
  );

  let remaining = withdrawalCents;

  // Layer 1: regular contributions (tax/penalty-free).
  const regularContributionCents = Math.min(
    remaining,
    normalizeRothCents(facts.regularContributionBasisCents, 'regularContributionBasisCents'),
  );
  remaining -= regularContributionCents;

  // Layer 2: conversion lots — AGGREGATE by tax year first (§408A(d)(4)(B)),
  // then consume each year FIFO: that year's TOTAL taxable-converted principal
  // before that year's TOTAL nontaxable. A lot dated after the distribution year
  // is skipped — it cannot exist yet. Each lot cents is validated,
  // and the same-year totals accumulate in BigInt so summing cannot silently
  // overflow safe-integer precision; a total that would exceed
  // Number.MAX_SAFE_INTEGER is REJECTED (never let an inflated basis understate
  // tax) when the aggregate is read back below.
  //
  // The per-account adapter already aggregates by tax year, so within ONE account
  // this loop sees at most one lot per year. It still has real work to do: a
  // Roth-IRA POOL merges the conversion lots of every account the owner holds
  // (§408A treats them as one contract), so two accounts converting in the same
  // year arrive here as two lots sharing a tax year.
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
    // Reject an aggregate that overflowed safe-integer precision:
    // `Number(bigint)` past MAX_SAFE is not a safe integer → throws.
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
    // 10% recapture: taxable-converted principal withdrawn inside this year's own
    // five-tax-year window before 59½ (never re-taxed as ordinary income).
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

  // Layer 3: earnings (the remainder).
  const earningsCents = remaining;

  const incomeTaxableCents = qualified ? 0 : earningsCents;
  // §72(t)(2)(A)(ii): a distribution made on account of the original owner's
  // DEATH carries no 10% additional tax at any beneficiary age — neither on
  // earnings nor on in-window conversion recapture.
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
 * Pro-rata basis/earnings split of a designated-Roth distribution (§402A(d)(4)):
 * the basis fraction is `basis / accountBalance`. A zero balance yields an
 * all-earnings split (conservative). All inputs MUST be nonnegative safe
 * integers — a non-finite / NaN / negative value is REJECTED (throws), never
 * silently coerced. The split uses EXACT integer arithmetic (no IEEE-754
 * division), so a half-cent boundary rounds correctly. The earnings cents are
 * the residual so the two always sum to the withdrawal.
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
  // Exact half-up pro rata: round(withdrawal * basis / balance), capped at the
  // withdrawal when recorded basis exceeds the balance.
  const basisCents = Math.min(
    withdrawalCents,
    integerHalfUp(withdrawalCents, basisAvailableCents, balanceCents),
  );
  return { basisCents, earningsCents: withdrawalCents - basisCents };
}

/**
 * Ordered designated-Roth basis allocator (IRS Notice 2010-84 Q&A-13):
 * consume `basisPortionCents` from the account's ORDINARY (non-rollover) basis
 * FIRST — that basis was never subject to a rollover's separate five-tax-year
 * clock, so it carries no recapture — then, only once ordinary basis is
 * exhausted, from in-plan Roth rollover lots FIFO (oldest tax year first, stable
 * by input index within a year), and within each lot the TAXABLE principal
 * before the nontaxable (mirroring the same taxable-before-nontaxable rule the
 * Roth-IRA conversion lots use). The taxable principal drawn from a lot still
 * inside its own §402A(c)(4)(D) window before 59½ is the recapture base.
 *
 * This is the SINGLE source of truth for BOTH the additional-tax computation
 * (`computeDesignatedRothDistribution`) and the carrier's per-lot state
 * decrement (`applyFactBasedDesignatedRothDistribution`), so the recaptured
 * amount and the lot-principal decrements are one and the same allocation and can
 * never disagree at a cent boundary. A lot dated after the distribution
 * year cannot exist yet, so it never contributes recapture — but its
 * principal stays consumable last (highest tax year sorts last) so the
 * per-component decrements always sum to exactly the basis consumed. Pure — the
 * caller owns any mutation.
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

  // Step 1: ordinary (non-rollover) basis first — no recapture.
  const ordinaryBasisConsumedCents = Math.min(basisPortionCents, ordinaryBasisCents);
  let remaining = basisPortionCents - ordinaryBasisConsumedCents;

  // Step 2: rollover lots FIFO by tax year (oldest first; stable by input index
  // for same-year lots). Within each lot, taxable principal before nontaxable.
  let recaptureCents = 0;
  const order = inPlanRolloverLots
    .map((lot, index) => ({ lot, index }))
    .sort((a, b) => a.lot.taxYear - b.lot.taxYear || a.index - b.index);
  for (const { lot, index } of order) {
    if (remaining <= 0) break;
    // Validate each lot's principal like the Roth-IRA conversion-lot path
    // (reject a non-finite / NaN value, clamp a negative to 0) so it can never
    // propagate a NaN into recaptureCents / lotConsumptions.
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
    // Recapture only the taxable principal of a lot still inside its OWN
    // five-tax-year window before 59½. A future lot (taxYear > distribution year)
    // has no started clock, so it is excluded.
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
 * Compute the tax buckets of one designated-Roth distribution. Qualified →
 * tax/penalty-free, but the basis/earnings bookkeeping split is STILL computed
 * pro rata (a qualified distribution consumes basis and earnings pro rata; it is
 * only the earnings TAX that is waived). Nonqualified → pro-rata basis
 * (tax-free) vs earnings (ordinary income; 10% §72(t) before 59½, subject to the
 * governmental-457(b) exception and the in-plan-rollover recapture).
 */
export function computeDesignatedRothDistribution(input: {
  readonly facts: DesignatedRothDistributionFactsCents;
  readonly accountBalanceCents: number;
  readonly withdrawalCents: number;
  readonly distributionTaxYear: number;
  readonly ownerReached59Half: boolean;
  /** Earnings attributable to a rollover from a different plan type into a
   *  governmental 457(b): these STILL enter the 10% base even though ordinary
   *  457(b) earnings do not (exception-to-the-exception, §72(t)(9)).
   *  Ignored for non-457(b) plans. Absent → 0. */
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

  // Always compute the pro-rata basis/earnings split first so the basis
  // bookkeeping is correct even for a qualified (tax-free) distribution.
  const { basisCents: basisPortionCents, earningsCents } = splitDesignatedRothNonqualified({
    basisCents,
    accountBalanceCents: balanceCents,
    withdrawalCents,
  });

  // Ordered basis allocation: ordinary basis first, then rollover lots
  // FIFO (taxable before nontaxable), the SINGLE source both the recapture below
  // and the carrier's per-lot decrement read. Ordinary basis is the total
  // basis minus every rollover lot's principal (that lot principal is itself
  // basis — taxed at rollover). A qualified distribution requires 59½, so its
  // allocation naturally recaptures nothing.
  const rolloverLots = facts.inPlanRolloverLots ?? [];
  const lotsTotalCents = rolloverLots.reduce(
    // Validate each lot's principal here too (this reduce independently
    // reads lot principal) — reject a non-finite / NaN value, clamp a negative to
    // 0 — so ordinaryBasisCents can never be derived from a NaN lot total.
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
  // §72(t)(2)(A)(ii): a post-death distribution from an INHERITED designated-Roth
  // account carries no 10% additional tax at any beneficiary age.
  if (!ownerReached59Half && facts.inheritedFromDeceasedOwner !== true) {
    // Earnings component of the 10% base, with the governmental-457(b) exception
    // (§72(t)(9)): ordinary Roth 457(b) earnings are exempt, but earnings
    // attributable to a rollover into the 457(b) still count.
    const penaltyEarningsCents = facts.isGovernmental457b
      ? Math.min(
          earningsCents,
          // Validate this cents input like every other in the file —
          // reject a non-finite / NaN value (never let it propagate to a NaN
          // additionalTaxBaseCents), clamp a negative to 0.
          normalizeRothCents(
            input.rolloverAttributableEarningsCents ?? 0,
            'rolloverAttributableEarningsCents',
          ),
        )
      : earningsCents;
    // In-plan taxable Roth rollover principal still inside its own five-tax-year
    // §402A(c)(4)(D) window, from the ordered allocation above.
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
