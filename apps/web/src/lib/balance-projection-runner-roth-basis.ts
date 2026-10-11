/**
 * Roth §408A basis carrier + ordering helpers — split out of
 * `balance-projection-runner-tax-helpers.ts` to keep that file smaller.
 * `balance-projection-runner-tax-helpers.ts`,
 * `balance-projection-runner-tax.ts`, `monte-carlo-tax.ts`, `monte-carlo.ts`,
 * and `balance-projection-runner-mc.ts` import these back where they consume
 * the carrier (`buildSolverPenaltyAccountsForYear` stayed in
 * `balance-projection-runner-tax-helpers.ts` — its `hsaShareOfCashLike` /
 * `isCashLikeAccountType` dependencies are NOT carrier-internal, so the move
 * would have crossed a non-carrier seam).
 */
import type { AccountType } from '../db/types';
import { isMagiCapDisabled } from '../db/types';
import type { MagiCapOverride } from '../db/types';
import type { DrawdownYear } from './drawdown-engine-types';
import type { PipelineContext } from './balance-projection-runner-types';
import { isPureRothEmployerType, isRothDesignatedPostBucket } from './balance-calc';
import type { PenaltyAccountSnapshot } from './tax-integration';
// The year-granular 59½ boundary reuses the penalty engine's exact
// half-birthday resolver so the ordering engine and the §72(t) proration can
// never disagree about which year the owner reached 59½.
import { penaltyFractionForYear } from './early-withdrawal-penalty';
import {
  resolveStartMonth,
  resolveEndMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';
import {
  ROTH_FIVE_TAX_YEAR_PERIOD,
  isRothIraDistributionQualified,
  computeDesignatedRothDistribution,
  normalizeRothCents,
  rothIraPoolKey,
  type RothConversionLotCents,
  type RothInPlanRolloverLotCents,
  type RothIraDistributionFactsCents,
  type DesignatedRothAccountFactsCents,
  type RothIraPoolFactsCents,
  type RothIraDistributionResult,
  type DesignatedRothDistributionResult,
} from './roth-distribution-tax';

/**
 * Cumulative Roth-IRA basis carrier, one entry per §408A AGGREGATION POOL
 * (`rothIraPoolKey`): the bare `AccountPayload.ownerId` for an owner's own Roth
 * IRAs (primary and secondary are distinct keys, and one person's own Roth IRAs
 * count as a single account per Pub 590-B). An INHERITED Roth IRA has NO entry —
 * its dollars are wholesale tax-free and never reach this carrier. Seeded
 * once at projection start. §408A ordering is CUMULATIVE across projection years: a pool's
 * withdrawals consume `rothBasisRemainingCents` first (tax/penalty-free); only the
 * excess over the remaining basis is earnings (taxed + 10% pre-59½). The carrier is
 * mutated in place each year as the basis is drawn down.
 *
 * The household-aggregate FUNDING pass keeps its own OWNER-keyed copy (the pools
 * flattened by `flattenRothIraPoolsByOwner`) — it has no committed per-account draw
 * to attribute to a pool; the annotation post-pass owns per-pool precision.
 */
interface RothBasisCarrierEntry {
  /** Remaining tax/penalty-free §408A contribution basis (integer cents). */
  rothBasisRemainingCents: number;
  /** Cumulative Roth-IRA dollars withdrawn so far (integer cents). */
  rothCumulativeWithdrawnCents: number;
  /**
   * Remaining conversion-lot basis for the FACT-BASED
   * §408A ordering, consumed FIFO after regular contributions. Each lot keeps its
   * own tax year so the separate five-tax-year recapture clock applies. Absent on
   * the test-only owner-keyed seed (`seedRothBasisCarrier`), which carries a bare
   * per-owner total; populated only by `seedFactBasedRothBasisCarrier`.
   */
  conversionLots?: MutableRothConversionLot[];
  /** The account(s) behind this entry are INHERITED (the draw is made on
   *  account of the original owner's death). Set from the RMD profile facts at
   *  seed/draw time; drives the §408A death qualifying event + the
   *  §72(t)(2)(A)(ii) exemption. */
  inheritedFromDeceasedOwner?: boolean;
  /** The pool's §408A five-taxable-year clock (first contribution tax year),
   *  seeded from the pool facts. For the owner-flattened FUNDING carrier this is
   *  the LATEST clock across the owner's pools and ABSENT when any pool lacks
   *  one (`flattenRothIraPoolsByOwner`) — the conservative pooled clock the
   *  funding pass's qualified test reads. The annotation and MC paths pass
   *  their own clock into the ordering explicitly and never read this field. */
  readonly firstContributionTaxYear?: number;
}

/** Mutable conversion-lot basis tracked on the fact-based carrier. */
interface MutableRothConversionLot {
  /** The lot's conversion tax year (starts its five-tax-year recapture clock). */
  readonly taxYear: number;
  /** Remaining taxable-converted principal (integer cents). */
  taxableRemainingCents: number;
  /** Remaining nontaxable-converted principal (integer cents). */
  nontaxableRemainingCents: number;
}

/**
 * Mutable in-plan Roth rollover lot tracked on the fact-based designated-Roth
 * carrier. Mirrors `MutableRothConversionLot`: the remaining
 * taxable/nontaxable rollover principal is decremented by the ordered basis
 * allocation each year (ordinary basis first, then this lot in FIFO order,
 * taxable before nontaxable), so a lot's LIFETIME §402A(c)(4)(D) recapture across
 * all partial-withdrawal years is capped at its original taxable principal (an
 * undecremented lot would re-count its full principal every year).
 */
interface MutableRothInPlanRolloverLot {
  /** The lot's rollover tax year (starts its own five-tax-year recapture clock). */
  readonly taxYear: number;
  /** Remaining taxable in-plan Roth rollover principal (integer cents). */
  taxableRolloverPrincipalRemainingCents: number;
  /** Remaining nontaxable in-plan Roth rollover principal (integer cents). */
  nontaxableRolloverPrincipalRemainingCents: number;
}

/** Pool-keyed Roth basis carrier (`rothIraPoolKey`). */
export type RothBasisCarrier = Map<string, RothBasisCarrierEntry>;

/**
 * Seed the owner-keyed Roth basis carrier from a per-owner basis map. Each owner
 * starts with their full basis remaining and $0 cumulative withdrawn.
 * Returns a fresh mutable carrier so callers own an independent copy.
 *
 * Test-only: the production seams both seed per POOL
 * (`seedFactBasedRothBasisCarrier`) from the fact adapter's output.
 */
export function seedRothBasisCarrier(
  basisCentsByOwner: ReadonlyMap<string, number>,
): RothBasisCarrier {
  const carrier: RothBasisCarrier = new Map();
  for (const [ownerId, basisCents] of basisCentsByOwner.entries()) {
    carrier.set(ownerId, {
      rothBasisRemainingCents: basisCents,
      rothCumulativeWithdrawnCents: 0,
    });
  }
  return carrier;
}

/** Per-owner Roth earnings split for one year (fact-based). */
export interface RothEarningsSplit {
  /** Ordinary-income-taxable Roth dollars for the year: nonqualified Roth-IRA
   *  earnings (after §408A ordering) PLUS the earnings portion of every
   *  nonqualified designated-Roth pro-rata distribution. */
  readonly earningsExcessDollars: number;
  /** Per-ACCOUNT §72(t)/§402A additional-tax inputs. Each entry's
   *  `penaltyPreTaxWithdrawalDollars` is the account's share of the
   *  §408A/§402A ADDITIONAL-TAX BASE — nonqualified earnings plus taxable
   *  converted / in-plan-rolled-over principal still inside its own five-tax-year
   *  recapture window — and carries `rothOrderedAdditionalTaxBase: true` so the
   *  penalty engine applies the 10% without re-testing the account type. Keyed by
   *  the REAL account id, so a scenario-marked exempt Roth account waives only its
   *  own share. */
  readonly penaltyAccounts: readonly PenaltyAccountSnapshot[];
}

/** True when the owner was 59½ for the WHOLE tax year.
 *
 *  The projection is year-granular while §408A qualification and the five-year
 *  recapture windows are date-granular, so the boundary has to pick a side. It
 *  picks the CONSERVATIVE one: the owner counts as having reached 59½ only
 *  once the year carries no §72(t) proration at all (`penaltyFractionForYear ===
 *  0`). In the half-birthday year the distribution is therefore treated as
 *  nonqualified — overstating tax/penalty, never understating. A missing or
 *  unparseable birthdate likewise counts as NOT reached. */
export function ownerReached59HalfForWholeYear(
  ownerBirthdate: string | null | undefined,
  taxYear: number,
): boolean {
  return penaltyFractionForYear(ownerBirthdate, taxYear, { ageYears: 59, ageMonths: 6 }) === 0;
}

/** One Roth account's committed draw for the year, in integer cents. */
interface RothAccountDraw {
  readonly accountId: string;
  readonly ownerId: string;
  readonly accountType: AccountType;
  readonly drawCents: number;
  /** Pre-distribution balance of the taxed pocket (integer cents) — the pro-rata
   *  denominator for a designated-Roth account. */
  readonly preDistributionBalanceCents: number;
  /** The account is INHERITED, so this draw is made on account of the
   *  original owner's death (§408A(d)(2)(A)(ii) qualifying event +
   *  §72(t)(2)(A)(ii) exemption, both independent of the beneficiary's age). */
  readonly inherited: boolean;
}

/** Collect each Roth account's committed draw for the year, split into the §408A
 *  Roth-IRA draws (grouped into aggregation pools by the caller) and the
 *  per-ACCOUNT designated-Roth set (§402A accounts never pool).
 *
 *  An INHERITED Roth IRA's draw is DROPPED here: its dollars are wholesale
 *  tax-free, so they must never reach `applyRothBasisOrdering`, which would
 *  otherwise CREATE a $0 pool for them on demand. Dropping the draw is what makes
 *  that absence hold; an inherited DESIGNATED-Roth plan keeps its `inherited` flag
 *  and its existing §402A treatment untouched.
 *
 *  MIXED Roth-designated accounts contribute only their POST sub-bucket
 *  (`postWithdrawnCents`) — the pre tranche is owned by
 *  `buildPenaltyAccountsForYear`, so including it here would double-count. */
function collectRothDraws(
  ctx: PipelineContext,
  year: DrawdownYear,
): { iraDraws: RothAccountDraw[]; designatedDraws: RothAccountDraw[] } {
  const iraDraws: RothAccountDraw[] = [];
  const designatedDraws: RothAccountDraw[] = [];
  const accountBalances = year.accountBalances;
  if (!accountBalances) return { iraDraws, designatedDraws };
  const accountById = new Map(ctx.accountProjections.map((p) => [p.account.id, p.account]));
  for (const [id, row] of accountBalances.entries()) {
    const account = accountById.get(id);
    if (!account) continue;
    const tt = account.payload.taxTreatment;
    const t = account.payload.type;
    const isMixedRothDesignated = isRothDesignatedPostBucket(tt, t) && tt === 'MIXED';
    const isRothIra = t === 'RETIREMENT_ROTH_IRA';
    const isPureRothEmployer = isPureRothEmployerType(t);
    if (!isRothIra && !isPureRothEmployer && !isMixedRothDesignated) continue;
    // Legacy / no-split rows leave `postWithdrawnCents` undefined → 0.
    const drawCents = isMixedRothDesignated
      ? row.postWithdrawnCents !== undefined
        ? Math.round(row.postWithdrawnCents)
        : 0
      : Math.round(row.withdrawn * 100);
    if (drawCents <= 0) continue;
    // Pro-rata denominator: the pocket's balance BEFORE this year's draw.
    const preDistributionBalanceCents = isMixedRothDesignated
      ? Math.round(row.postEnd * 100) + drawCents
      : Math.round(row.balance * 100) + drawCents;
    // Optional-chained for hand-rolled test contexts that omit the map (absent
    // map → no recorded facts → not inherited).
    const inherited = ctx.rmdProfileFactsByAccountId?.get(id)?.inheritedAccount === true;
    // Wholesale tax-free, and no basis state anywhere. Scoped to the Roth-IRA
    // type alone; the designated set below is unaffected.
    if (isRothIra && inherited) continue;
    const draw: RothAccountDraw = {
      accountId: id,
      ownerId: account.payload.ownerId,
      accountType: t,
      drawCents,
      preDistributionBalanceCents,
      inherited,
    };
    if (isRothIra) iraDraws.push(draw);
    else designatedDraws.push(draw);
  }
  return { iraDraws, designatedDraws };
}

/** Allocate an owner-level cents figure back across that owner's per-account
 *  draws in proportion to each draw, absorbing the rounding residual on the
 *  LARGEST draw so the parts sum EXACTLY to `totalCents`. */
function allocateByDraw(
  draws: readonly RothAccountDraw[],
  totalCents: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (totalCents <= 0 || draws.length === 0) return out;
  let drawTotal = 0;
  for (const d of draws) drawTotal += d.drawCents;
  if (drawTotal <= 0) return out;
  let allocated = 0;
  let largestIdx = 0;
  for (let i = 0; i < draws.length; i += 1) {
    const cents = Math.round((totalCents * draws[i].drawCents) / drawTotal);
    out.set(draws[i].accountId, cents);
    allocated += cents;
    if (draws[i].drawCents > draws[largestIdx].drawCents) largestIdx = i;
  }
  const drift = totalCents - allocated;
  if (drift !== 0) {
    const id = draws[largestIdx].accountId;
    out.set(id, (out.get(id) ?? 0) + drift);
  }
  return out;
}

/**
 * Apply the FACT-BASED §408A / §402A Roth distribution rules for one year across
 * every Roth account type, mutating both carriers in place.
 *
 * The two regimes are deliberately DIFFERENT — that difference is the whole point,
 * and pooling them would make a designated-Roth
 * withdrawal look contribution-first and treat an entire projected Roth balance
 * as recoverable basis:
 *
 *  - **Roth IRAs** aggregate across the OWNER's OWN accounts (IRS Pub. 590-B) and
 *    come out in §408A order: recorded regular contributions, then conversion lots
 *    FIFO aggregated by tax year (taxable converted principal before nontaxable
 *    within each year), then earnings. Each conversion lot carries its OWN
 *    five-tax-year recapture clock. An INHERITED Roth IRA is not ordered at all:
 *    its draw is dropped by `collectRothDraws`, so it consumes no basis,
 *    creates no pool and produces no taxable earnings or additional-tax base.
 *  - **Designated-Roth employer accounts** (pure Roth 401(k)/403(b)/457(b)/TSP and
 *    the Roth-designated post sub-bucket of the MIXED variants) never pool: each
 *    keeps its own five-year participation clock, its own recorded basis, and its
 *    own in-plan-rollover lots, and a nonqualified distribution is PRO RATA
 *    basis/earnings per §402A(d)(4).
 *
 * Missing facts stay conservative: $0 recorded basis means every distributed
 * dollar past recorded lots is earnings, and an absent five-year anchor counts as
 * NOT satisfied. Returns a zero split when the year has no per-account map
 * (bucket-allocation paths carry no per-account Roth detail).
 */
export function applyRothBasisOrdering(
  ctx: PipelineContext,
  year: DrawdownYear,
  carrier: RothBasisCarrier,
  designatedCarrier: DesignatedRothCarrier,
): RothEarningsSplit {
  const { iraDraws, designatedDraws } = collectRothDraws(ctx, year);
  if (iraDraws.length === 0 && designatedDraws.length === 0) {
    return { earningsExcessDollars: 0, penaltyAccounts: [] };
  }
  const taxYear = year.year;
  const birthdateByOwner = new Map<string, string | null | undefined>([
    [ctx.primary.id, ctx.primary.payload.birthdate],
  ]);
  if (ctx.secondary) {
    birthdateByOwner.set(ctx.secondary.id, ctx.secondary.payload.birthdate);
  }
  const penaltyAccounts: PenaltyAccountSnapshot[] = [];
  let incomeTaxableCents = 0;

  // --- Roth IRAs: §408A ordering per AGGREGATION POOL (`rothIraPoolKey`) ---
  // An owner's OWN Roth IRAs share one pool (Pub 590-B treats them as a single
  // account). No inherited draw reaches this loop (`collectRothDraws` drops
  // them), which is what keeps an inherited pool out of the carrier: the
  // `?? { … }` below CREATES a pool from any key it is handed, so filtering at
  // the draw is the only place the absence can be enforced.
  const iraByPool = new Map<string, RothAccountDraw[]>();
  for (const draw of iraDraws) {
    const poolKey = rothIraPoolKey(draw.ownerId, draw.accountId, draw.inherited);
    const list = iraByPool.get(poolKey) ?? [];
    list.push(draw);
    iraByPool.set(poolKey, list);
  }
  for (const [poolKey, draws] of iraByPool) {
    const ownerId = draws[0].ownerId;
    const entry = carrier.get(poolKey) ?? {
      rothBasisRemainingCents: 0,
      rothCumulativeWithdrawnCents: 0,
    };
    carrier.set(poolKey, entry);
    let withdrawalCents = 0;
    for (const d of draws) withdrawalCents += d.drawCents;
    const result = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents,
      distributionTaxYear: taxYear,
      ownerReached59Half: ownerReached59HalfForWholeYear(
        birthdateByOwner.get(ownerId),
        taxYear,
      ),
      firstContributionTaxYear:
        ctx.rothDistributionFacts.rothIraByPool.get(poolKey)?.rothIra
          ?.firstContributionTaxYear,
      // Always false today (no inherited Roth-IRA draw survives `collectRothDraws`);
      // passed explicitly so the ordering primitive is never left to infer it.
      inheritedFromDeceasedOwner: draws.every((d) => d.inherited),
    });
    incomeTaxableCents += result.incomeTaxableCents;
    // The owner-level ordering is authoritative (Pub. 590-B aggregates an
    // owner's Roth IRAs), but the ADDITIONAL-TAX base is emitted per real account
    // id so a single scenario-marked exempt Roth IRA waives only its own share.
    for (const [accountId, cents] of allocateByDraw(draws, result.additionalTaxBaseCents)) {
      if (cents <= 0) continue;
      penaltyAccounts.push({
        id: accountId,
        type: 'RETIREMENT_ROTH_IRA',
        ownerId,
        penaltyPreTaxWithdrawalDollars: cents / 100,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      });
    }
  }

  // --- Designated-Roth accounts: per-ACCOUNT pro rata (never pooled) ---
  for (const draw of designatedDraws) {
    const entry = designatedCarrier.get(draw.accountId);
    // An account absent from the carrier has no recorded designated-Roth facts,
    // so it has $0 basis and an unsatisfied five-year clock — the conservative
    // default. Seed the entry on demand rather than skipping it, otherwise
    // its earnings would escape ordinary income entirely.
    const resolved: MutableDesignatedRothAccountEntry = entry ?? {
      accountId: draw.accountId,
      ownerId: draw.ownerId,
      designatedRothBasisRemainingCents: 0,
      inPlanRolloverLots: [],
      isGovernmental457b:
        draw.accountType === 'RETIREMENT_ROTH_457B' || draw.accountType === 'RETIREMENT_457B',
      ...(draw.inherited ? { inheritedFromDeceasedOwner: true } : {}),
    };
    if (!entry) designatedCarrier.set(draw.accountId, resolved);
    const result = applyFactBasedDesignatedRothDistribution(resolved, {
      accountBalanceCents: draw.preDistributionBalanceCents,
      withdrawalCents: draw.drawCents,
      distributionTaxYear: taxYear,
      ownerReached59Half: ownerReached59HalfForWholeYear(
        birthdateByOwner.get(draw.ownerId),
        taxYear,
      ),
      // §72(t)(2)(A)(ii) / death qualifying event on an inherited plan account.
      inheritedFromDeceasedOwner: draw.inherited,
    });
    incomeTaxableCents += result.incomeTaxableCents;
    if (result.additionalTaxBaseCents > 0) {
      penaltyAccounts.push({
        id: draw.accountId,
        type: draw.accountType,
        ownerId: draw.ownerId,
        penaltyPreTaxWithdrawalDollars: result.additionalTaxBaseCents / 100,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      });
    }
  }

  return { earningsExcessDollars: incomeTaxableCents / 100, penaltyAccounts };
}

/**
 * Resolve the cap window active in `calendarYear` from a MAGI-cap schedule,
 * reusing the shared anchor resolver. Mirrors the engine's
 * earliest-start-on-overlap selection: resolves every window's
 * `[startYear, endYear)`, sorts them by the SAME total order the engine uses
 * `(startYear, endYear, originalIndex)`, then returns the first whose half-open
 * interval contains `calendarYear`. The sort matters on a residual overlap —
 * stored-first ≠ sorted-first, and the engine's `selectActiveMagiCapWindow`
 * scans the sorted list, so scanning stored order here would credit the §408A
 * basis to the WRONG window's `targetRothAccountId`. A window with an
 * unresolvable anchor is skipped. `undefined` in a gap.
 */
function resolveActiveCapWindow(
  windows: MagiCapOverride['windows'],
  resolveCtx: ScheduleResolveContext,
  calendarYear: number,
): MagiCapOverride['windows'][number] | undefined {
  const resolved: {
    window: MagiCapOverride['windows'][number];
    startYear: number;
    endYear: number;
    originalIndex: number;
  }[] = [];
  windows.forEach((w, originalIndex) => {
    const startMonth = resolveStartMonth(w.start, resolveCtx);
    if (!startMonth) return;
    const endMonth = resolveEndMonth(w.end, startMonth, resolveCtx);
    if (!endMonth) return;
    if (endMonth.year <= startMonth.year) return;
    resolved.push({
      window: w,
      startYear: startMonth.year,
      endYear: endMonth.year,
      originalIndex,
    });
  });
  // Same `(startYear, endYear, originalIndex)` total order as the engine's
  // `compareMagiCapWindows` — earliest start wins on a residual overlap.
  resolved.sort(
    (a, b) =>
      a.startYear - b.startYear ||
      a.endYear - b.endYear ||
      a.originalIndex - b.originalIndex,
  );
  for (const r of resolved) {
    if (calendarYear >= r.startYear && calendarYear < r.endYear) return r.window;
  }
  return undefined;
}

/**
 * Credit a year's Fill-mode Roth-conversion principal to the target Roth's
 * §408A basis carrier. A converted dollar was already taxed as ordinary
 * income in the conversion year, so it is never re-taxed as income when withdrawn
 * — but it is CONVERSION basis, so it is credited as a DATED conversion lot
 * for the conversion year and carries that lot's own five-taxable-year
 * §408A(d)(3)(F) recapture window. Must run AFTER
 * `applyRothBasisOrdering` for the same year (the converted dollars land at
 * year-end, so they are basis only for LATER years' withdrawals, never the
 * same year's). Resolves the target Roth's owner by the ACTIVE cap window's
 * `targetRothAccountId` for `year.year`; a no-op when no
 * conversion occurred, no window is active, no target is configured, or the
 * target is not a live `RETIREMENT_ROTH_IRA`.
 */
/**
 * The aggregate cap on conversion lots one carrier entry may hold.
 *
 * Lots are aggregated BY TAX YEAR (the §408A(d)(4)(B) grouping), so a projection
 * that credits one engine-generated conversion per year adds at most one lot per
 * year; the cap bounds the recorded + engine-generated total so the per-year FIFO
 * scan can never grow without limit on a hostile / pathological input.
 *
 * Unlike a stored-lot cap this one never DROPS a lot: at the bound the incoming
 * cents merge into the newest lot, so no principal is lost and the merged dollars
 * date no earlier than they really are. Recorded lots are themselves bounded by the
 * 203 valid tax years, so reaching this cap needs a recorded history longer than a
 * human lifetime. (With one lot per year, the tax-year range IS the bound.)
 */
const MAX_CARRIER_CONVERSION_LOTS = 200;

/**
 * Credit `cents` of engine-generated conversion principal to `entry` as a
 * DATED conversion lot for `taxYear`, so it carries its own five-taxable-year
 * §408A(d)(3)(F) recapture clock through the same FIFO machinery a user-recorded
 * lot uses. Converted pre-tax dollars are TAXABLE converted principal (the
 * recapture-bearing tranche).
 *
 * Same-year credits MERGE into the existing lot for that year (statutory
 * aggregation, and it keeps the lot count bounded). At the cap, the credit merges
 * into the NEWEST lot rather than being dropped: newest keeps the LONGEST remaining
 * recapture window, so the bound can only over-state recapture, never waive it.
 */
function creditConversionLot(
  entry: RothBasisCarrierEntry,
  taxYear: number,
  cents: number,
): void {
  if (cents <= 0) return;
  const lots = entry.conversionLots ?? [];
  entry.conversionLots = lots;
  const sameYear = lots.find((lot) => lot.taxYear === taxYear);
  if (sameYear !== undefined) {
    sameYear.taxableRemainingCents += cents;
    return;
  }
  if (lots.length >= MAX_CARRIER_CONVERSION_LOTS) {
    let newest = lots[0];
    for (const lot of lots) if (lot.taxYear > newest.taxYear) newest = lot;
    newest.taxableRemainingCents += cents;
    return;
  }
  lots.push({
    taxYear,
    taxableRemainingCents: cents,
    nontaxableRemainingCents: 0,
  });
  // The carrier's FIFO consumption relies on ascending tax-year order.
  lots.sort((a, b) => a.taxYear - b.taxYear);
}

export function creditRothConversionToBasisCarrier(
  ctx: PipelineContext,
  year: DrawdownYear,
  carrier: RothBasisCarrier,
): void {
  const convertedCents = year.rothConvertedCents ?? 0;
  if (convertedCents <= 0) return;
  const magiCap = ctx.resolvedScenario.magiCap;
  if (magiCap === undefined || isMagiCapDisabled(magiCap)) return;
  const resolveCtx: ScheduleResolveContext = {
    retirementYear: ctx.primaryRetirementYear,
    retirementMonth0: ctx.primaryRetirementMonth0,
    primary: ctx.primary.payload.birthdate
      ? { birthdate: ctx.primary.payload.birthdate }
      : undefined,
    secondary: ctx.secondary?.payload.birthdate
      ? { birthdate: ctx.secondary.payload.birthdate }
      : undefined,
  };
  const activeWindow = resolveActiveCapWindow(magiCap.windows, resolveCtx, year.year);
  if (activeWindow === undefined) return;
  const targetId = activeWindow.targetRothAccountId;
  if (targetId === undefined) return;
  const target = ctx.accountProjections.find((p) => p.account.id === targetId);
  if (!target || target.account.payload.type !== 'RETIREMENT_ROTH_IRA') return;
  // Defence in depth: an INHERITED Roth IRA cannot receive a conversion, so
  // `findTargetRothIndex` never resolves one and no converted cents can reach this
  // year. Were one to, the credit below would land on the BENEFICIARY's own pool
  // (the key is the bare owner id) and buy tax-free basis on their own Roth IRAs
  // for dollars sitting in the inherited account.
  if (ctx.rmdProfileFactsByAccountId?.get(targetId)?.inheritedAccount === true) return;
  const ownerId = target.account.payload.ownerId;
  // The owner's OWN §408A pool (`rothIraPoolKey`'s bare owner id), deliberately: a
  // conversion can only ever land in an account the owner opened themselves — an
  // inherited Roth IRA cannot receive one (enforced above and by
  // `isWorkingYearsRothConversionTarget`) — so it never credits an inherited pool.
  const entry = carrier.get(ownerId) ?? {
    rothBasisRemainingCents: 0,
    rothCumulativeWithdrawnCents: 0,
  };
  // Credited as a DATED conversion lot for this projection year, not as
  // undated regular basis — an in-projection conversion starts its own
  // five-taxable-year recapture clock, so a pre-59½ withdrawal inside that window
  // owes the 10% §408A(d)(3)(F) recapture. Undated basis would escape it entirely.
  creditConversionLot(entry, year.year, convertedCents);
  carrier.set(ownerId, entry);
}

/**
 * One §408A POOL's fact-based Roth-IRA distribution facts (cents) used to
 * seed the fact-based §408A carrier. Re-exported from the leaf
 * `roth-distribution-tax` (where it lives so the pipeline-context type can
 * reference it without closing an import cycle through this carrier module).
 */
export type { RothIraPoolFactsCents };

/**
 * Build the DETERMINISTIC §408A seed facts for every POOL: the Roth-IRA
 * profile `buildRothDistributionFacts` DERIVES from each pool's recorded balance
 * history, plus the deterministic-only working-years converted-principal basis.
 *
 * The engine-generated conversion basis is keyed by OWNER, and a conversion always
 * lands in an account the owner opened (you cannot convert into an inherited Roth
 * IRA), so it is credited to the owner's OWN pool — whose key is the bare
 * `ownerId`, never an inherited pool's namespaced key.
 *
 * A working-years Roth conversion was taxed as ordinary income in its conversion
 * year, so the converted principal becomes recoverable §408A basis — but it is a
 * CONVERSION, which starts its own five-taxable-year §408A(d)(3)(F) recapture
 * clock. The engine therefore seeds it as a DATED CONVERSION LOT keyed by the
 * conversion tax year (from `datedConversionCentsByOwner`), consumed through the
 * same FIFO recapture machinery a user-recorded lot uses, so a pre-59½ withdrawal
 * within five tax years of the conversion carries the 10% recapture. Crediting it
 * as undated regular-contribution basis would let exactly that
 * withdrawal escape recapture entirely. The whole converted amount came out of
 * pre-tax dollars, so it is TAXABLE converted principal (the recapture-bearing
 * tranche). When only the undated total is available (no dated map), it falls
 * back to regular basis.
 *
 * The Monte Carlo seed deliberately EXCLUDES these maps (MC does not model the
 * conversion deposit legs).
 */
export function mergeFactBasedRothIraSeeds(
  factsByPool: ReadonlyMap<string, RothIraPoolFactsCents>,
  extraRegularBasisCentsByOwner: ReadonlyMap<string, number> | undefined,
  /** Owner id → conversion tax year → integer cents of engine-generated
   *  working-years conversion principal. When an owner appears here, the dated
   *  lots REPLACE the undated total for that owner (same dollars, now recapture-
   *  aware). */
  datedConversionCentsByOwner?: ReadonlyMap<string, ReadonlyMap<number, number>>,
): Map<string, RothIraPoolFactsCents> {
  const out = new Map<string, RothIraPoolFactsCents>();
  for (const [poolKey, facts] of factsByPool) out.set(poolKey, facts);
  for (const [ownerId, extraCents] of extraRegularBasisCentsByOwner ?? new Map()) {
    if (extraCents <= 0) continue;
    // The owner's OWN pool is keyed by the bare owner id (`rothIraPoolKey`), so this
    // can never land on an inherited pool's `::inherited-acct:` key.
    const existing = out.get(ownerId)?.rothIra;
    const dated = datedConversionCentsByOwner?.get(ownerId);
    if (dated !== undefined && dated.size > 0) {
      // Dated: one conversion lot per conversion year, merged with any recorded
      // lots and kept ascending by tax year (the FIFO order the carrier expects).
      const merged: RothConversionLotCents[] = [...(existing?.conversionLots ?? [])];
      for (const [taxYear, cents] of dated) {
        if (cents <= 0) continue;
        merged.push({
          taxYear,
          taxableConvertedPrincipalCents: cents,
          nontaxableConvertedPrincipalCents: 0,
        });
      }
      out.set(ownerId, {
        rothIra: {
          regularContributionBasisCents: existing?.regularContributionBasisCents ?? 0,
          firstContributionTaxYear: existing?.firstContributionTaxYear,
          conversionLots: merged.sort((a, b) => a.taxYear - b.taxYear),
        },
        ownerId,
      });
      continue;
    }
    out.set(ownerId, {
      rothIra: {
        regularContributionBasisCents:
          (existing?.regularContributionBasisCents ?? 0) + extraCents,
        firstContributionTaxYear: existing?.firstContributionTaxYear,
        conversionLots: existing?.conversionLots ?? [],
      },
      ownerId,
    });
  }
  return out;
}

/**
 * Collapse the POOL-keyed Roth-IRA facts onto the OWNER, for the
 * household-aggregate FUNDING (solver) pass only.
 *
 * The funding pass has no committed per-account draw at trial time, so it cannot
 * attribute an aggregate Roth withdrawal to a specific §408A pool; it keeps ONE
 * owner-pooled carrier entry and consumes only `rothBasisRemainingCents` from it
 * (`buildSolverPenaltyAccountsForYear`), while the ANNOTATION post-pass re-derives
 * the exact per-pool split against the committed draw.
 *
 * There is nothing inherited left to flatten: an inherited Roth IRA has no
 * pool in `rothIraByPool` at all, and its dollars leave the solver's aggregate Roth
 * bucket before that bucket reaches the carrier
 * (`classification.rothInheritedTaxFreeDollars`). So the household total the solver
 * funds against is exactly the basis resolved for the owners' OWN pools, which is
 * the only basis the post-pass can shield.
 *
 * The clock is the LATEST across the owner's pools and ABSENT when any pool lacks
 * one (the same one-sided conservative reduction the MC pool uses). The funding
 * pass reads it through the carrier entry (`firstContributionTaxYear`) for its
 * §408A qualified test, so a qualified household's Roth draw funds no phantom
 * ordinary income there.
 */
export function flattenRothIraPoolsByOwner(
  factsByPool: ReadonlyMap<string, RothIraPoolFactsCents>,
): Map<string, RothIraPoolFactsCents> {
  const basisByOwner = new Map<string, number>();
  const lotsByOwner = new Map<string, RothConversionLotCents[]>();
  const clockByOwner = new Map<string, number | undefined>();
  const clockMissing = new Set<string>();
  for (const pool of factsByPool.values()) {
    const { ownerId } = pool;
    const ira = pool.rothIra;
    if (!ira) continue;
    basisByOwner.set(
      ownerId,
      (basisByOwner.get(ownerId) ?? 0) + ira.regularContributionBasisCents,
    );
    const lots = lotsByOwner.get(ownerId) ?? [];
    lots.push(...ira.conversionLots);
    lotsByOwner.set(ownerId, lots);
    if (ira.firstContributionTaxYear === undefined) {
      clockMissing.add(ownerId);
    } else {
      const current = clockByOwner.get(ownerId);
      clockByOwner.set(
        ownerId,
        current === undefined ? ira.firstContributionTaxYear : Math.max(current, ira.firstContributionTaxYear),
      );
    }
  }
  const out = new Map<string, RothIraPoolFactsCents>();
  for (const [ownerId, regularContributionBasisCents] of basisByOwner) {
    const clock = clockMissing.has(ownerId) ? undefined : clockByOwner.get(ownerId);
    const rothIra: RothIraDistributionFactsCents = {
      regularContributionBasisCents,
      firstContributionTaxYear: clock,
      conversionLots: (lotsByOwner.get(ownerId) ?? []).sort((a, b) => a.taxYear - b.taxYear),
    };
    out.set(ownerId, { rothIra, ownerId });
  }
  return out;
}

/**
 * One owner's pooled DESIGNATED-plan state for the household-aggregate FUNDING
 * pass. Kept apart from the §408A carrier entry beside it because that entry
 * holds Roth-IRA contribution basis, and Roth-IRA basis is not basis of a
 * §402A(d)(4) distribution — the two regimes never share a dollar here.
 *
 * The `entry` is the SAME mutable shape the annotation pass's per-account
 * designated carrier uses, so the funding pass runs the SAME primitive
 * (`applyFactBasedDesignatedRothDistribution` →
 * `computeDesignatedRothDistribution` → `allocateDesignatedRothBasis`): pro-rata
 * basis/earnings split against the pooled balance, then the ordered lot
 * allocation with each lot's own §402A(c)(4)(D) recapture window. Pooled onto
 * the OWNER (the solver has no committed per-account draw), the same reduction
 * the MC profile applies household-wide (`seedMcDesignatedRothPool`).
 */
interface SolverDesignatedRothState {
  /** The pooled mutable designated entry (basis, dated rollover lots, clock,
   *  457(b) flag), consumed exactly once across the projection's years. */
  readonly entry: MutableDesignatedRothAccountEntry;
  /**
   * Running pooled designated balance (integer cents) — the §402A(d)(4)
   * pro-rata denominator. Seeded from the at-retirement designated ledger
   * balances and decremented by each year's designated draw, mirroring
   * `McDesignatedRothPool.balanceRemainingCents` (the same fallback MC uses
   * when the year's real pocket balance is not supplied). Never used below the
   * draw itself, so the basis fraction can never exceed 1.
   */
  balanceRemainingCents: number;
}

/** Owner id → that owner's pooled designated-Roth funding state. Mutated across
 *  years exactly like the funding carrier it accompanies. */
export type SolverDesignatedRothStates = Map<string, SolverDesignatedRothState>;

/**
 * Seed the FUNDING pass's per-owner pooled designated-Roth state from the
 * SAME per-account designated facts the annotation pass seeds its per-account
 * carrier from (post `mergeDesignatedRothSeeds`, so engine-generated MIXED
 * in-plan conversion principal arrives as dated lots here too).
 *
 * Why the solver needs it at all: a designated
 * account's basis IS its recorded in-plan-rollover principal, so every
 * designated dollar the solver shelters is principal that may still be inside
 * its own five-tax-year §402A(c)(4)(D) recapture window. Sheltering it as plain
 * contribution basis would fund none of the recapture the annotation post-pass
 * reports — the committed withdrawal would come up short by exactly that amount.
 *
 * Pooling rules mirror `buildMcRothOrderedProfile`'s designated reduction, per
 * OWNER instead of per household (one-sided conservative):
 *   - basis sums; lots aggregate by tax year (§408A(d)(4)(B)-style grouping),
 *     ascending;
 *   - the participation clock is the LATEST across the owner's plans and ABSENT
 *     when any plan lacks one (an unknown clock must not count as met);
 *   - the governmental-457(b) earnings carve-out applies only when EVERY plan is
 *     a 457(b), so a non-457(b) sibling's genuine 10% is never waived by pooling.
 *
 * An INHERITED plan contributes NOTHING here: its distributions are made on
 * account of the original owner's death, which carries no 10% at any beneficiary
 * age (§72(t)(2)(A)(ii)), so none of its principal is recapture-bearing — and
 * its basis must not shield a sibling plan's lots either. Its dollars carry
 * their own classifier subset (`rothInheritedDesignatedDollars`) and run
 * against the per-owner INHERITED pooled state instead
 * (`seedSolverInheritedDesignatedRothStates`), where the death event decides
 * qualification.
 */
export function seedSolverDesignatedRothStates(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
  /** Per-owner at-retirement designated pocket balance (integer cents) — the
   *  pro-rata denominator seed (`solverDesignatedRothBalanceCentsByOwner`). */
  designatedBalanceCentsByOwner: ReadonlyMap<string, number>,
): SolverDesignatedRothStates {
  return poolSolverDesignatedRothStates(factsByAccount, designatedBalanceCentsByOwner, false);
}

/**
 * The INHERITED counterpart of `seedSolverDesignatedRothStates`: pool ONLY
 * the inherited designated-Roth facts per owner, each pooled entry carrying
 * `inheritedFromDeceasedOwner: true` so the funding pass's inherited slice runs
 * the same `computeDesignatedRothDistribution` primitive with the original
 * owner's DEATH as the qualifying event (§402A(d)(2)(B)(i)) and the 10%
 * waived at any beneficiary age (§72(t)(2)(A)(ii)). Same pooling reductions as
 * the non-inherited seed. These dollars deliberately never touch the §408A
 * carrier: its ordering would score them as earnings excess and charge a 10%
 * the statute waives — income the annotation post-pass never reports.
 */
export function seedSolverInheritedDesignatedRothStates(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
  /** Per-owner at-retirement INHERITED designated pocket balance (integer
   *  cents) — `solverDesignatedRothBalanceCentsByOwner(ctx, ledger, true)`. */
  designatedBalanceCentsByOwner: ReadonlyMap<string, number>,
): SolverDesignatedRothStates {
  return poolSolverDesignatedRothStates(factsByAccount, designatedBalanceCentsByOwner, true);
}

/** Shared per-owner pooling for the two funding-pass designated seeds above —
 *  `inherited` selects which facts are pooled and marks the pooled entries. */
function poolSolverDesignatedRothStates(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
  designatedBalanceCentsByOwner: ReadonlyMap<string, number>,
  inherited: boolean,
): SolverDesignatedRothStates {
  interface OwnerAccumulator {
    basisCents: number;
    firstParticipationTaxYear?: number;
    anyClockMissing: boolean;
    allGovernmental457b: boolean;
    readonly lotsByYear: Map<number, { taxableCents: number; nontaxableCents: number }>;
  }
  const byOwner = new Map<string, OwnerAccumulator>();
  for (const facts of factsByAccount.values()) {
    if ((facts.inheritedFromDeceasedOwner === true) !== inherited) continue;
    let acc = byOwner.get(facts.ownerId);
    if (acc === undefined) {
      acc = {
        basisCents: 0,
        anyClockMissing: false,
        allGovernmental457b: true,
        lotsByYear: new Map(),
      };
      byOwner.set(facts.ownerId, acc);
    }
    acc.basisCents += Math.max(0, Math.round(facts.basisCents));
    if (facts.firstParticipationTaxYear === undefined) {
      acc.anyClockMissing = true;
    } else {
      acc.firstParticipationTaxYear =
        acc.firstParticipationTaxYear === undefined
          ? facts.firstParticipationTaxYear
          : Math.max(acc.firstParticipationTaxYear, facts.firstParticipationTaxYear);
    }
    if (facts.isGovernmental457b !== true) acc.allGovernmental457b = false;
    for (const lot of facts.inPlanRolloverLots ?? []) {
      const entry = acc.lotsByYear.get(lot.taxYear) ?? { taxableCents: 0, nontaxableCents: 0 };
      acc.lotsByYear.set(lot.taxYear, {
        taxableCents: entry.taxableCents + Math.max(0, Math.round(lot.taxableRolloverPrincipalCents)),
        nontaxableCents:
          entry.nontaxableCents + Math.max(0, Math.round(lot.nontaxableRolloverPrincipalCents)),
      });
    }
  }
  const out: SolverDesignatedRothStates = new Map();
  for (const [ownerId, acc] of byOwner) {
    out.set(ownerId, {
      entry: {
        accountId: `${inherited ? 'solver-inherited-designated' : 'solver-designated'}:${ownerId}`,
        ownerId,
        designatedRothBasisRemainingCents: acc.basisCents,
        ...(acc.anyClockMissing || acc.firstParticipationTaxYear === undefined
          ? {}
          : { firstParticipationTaxYear: acc.firstParticipationTaxYear }),
        inPlanRolloverLots: [...acc.lotsByYear.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([taxYear, v]) => ({
            taxYear,
            taxableRolloverPrincipalRemainingCents: v.taxableCents,
            nontaxableRolloverPrincipalRemainingCents: v.nontaxableCents,
          })),
        isGovernmental457b: acc.allGovernmental457b,
        ...(inherited ? { inheritedFromDeceasedOwner: true } : {}),
      },
      balanceRemainingCents: Math.max(
        0,
        Math.round(designatedBalanceCentsByOwner.get(ownerId) ?? 0),
      ),
    });
  }
  return out;
}

/**
 * Build the DETERMINISTIC designated-Roth seed facts: the recorded
 * per-account facts plus the deterministic-only same-account MIXED in-plan
 * conversion basis, credited to the exact TARGET ACCOUNT that received it
 * (designated-Roth accounts never pool — an owner-level credit could
 * otherwise be recovered pro rata against a sibling plan).
 */
export function mergeDesignatedRothSeeds(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
  extraBasisCentsByAccount: ReadonlyMap<string, number> | undefined,
  /** Target account id → rollover tax year → integer cents of
   *  engine-generated same-account MIXED in-plan conversion principal. When an
   *  account appears here the dollars are seeded as a DATED in-plan rollover LOT
   *  (basis that carries its own §402A(c)(4)(D) five-tax-year recapture window)
   *  as well as counted in the account's basis, exactly like a user-recorded lot.
   *  Absent → the undated basis-only credit. */
  datedInPlanRolloverCentsByAccount?: ReadonlyMap<string, ReadonlyMap<number, number>>,
): Map<string, DesignatedRothAccountFactsCents> {
  const out = new Map<string, DesignatedRothAccountFactsCents>();
  for (const [accountId, facts] of factsByAccount) out.set(accountId, facts);
  for (const [accountId, extraCents] of extraBasisCentsByAccount ?? new Map()) {
    if (extraCents <= 0) continue;
    const existing = out.get(accountId);
    // An account with no recorded designated-Roth facts is not in the map (it is
    // not a designated-Roth account, or the adapter found nothing); skip rather
    // than fabricating an entry with no owner.
    if (!existing) continue;
    const dated = datedInPlanRolloverCentsByAccount?.get(accountId);
    const lots: RothInPlanRolloverLotCents[] = [...(existing.inPlanRolloverLots ?? [])];
    for (const [taxYear, cents] of dated ?? new Map<number, number>()) {
      if (cents <= 0) continue;
      lots.push({
        taxYear,
        // An in-plan conversion of pre-tax dollars is TAXABLE rollover principal —
        // the tranche §402A(c)(4)(D) recaptures inside its five-tax-year window.
        taxableRolloverPrincipalCents: cents,
        nontaxableRolloverPrincipalCents: 0,
      });
    }
    out.set(accountId, {
      ...existing,
      basisCents: existing.basisCents + extraCents,
      inPlanRolloverLots: lots.sort((a, b) => a.taxYear - b.taxYear),
    });
  }
  return out;
}

/**
 * Seed the POOL-keyed Roth-IRA basis carrier from the
 * per-pool facts the adapter derives from each pool's recorded balance history
 * (`buildRothDistributionFacts` → `deriveRothPoolBasisCents`), rather than from
 * the bare per-owner total `seedRothBasisCarrier` takes. Each pool starts with
 * what its history LEFT: the remaining regular-contribution basis, and the
 * remaining conversion lots (sorted FIFO by tax year) as remaining lot basis.
 * Returns a fresh mutable carrier so each engine path owns an independent copy.
 * Designated-Roth accounts are seeded separately by `seedDesignatedRothCarrier`.
 *
 * Takes the STRUCTURAL fact shape rather than `RothIraPoolFactsCents` itself, so the
 * MC synthetic single-pocket seed (`seedMcAggregateRothBasisCarrier`) can reuse it
 * without inventing an owner id for its aggregate key.
 */
export function seedFactBasedRothBasisCarrier(
  factsByPool: ReadonlyMap<string, { readonly rothIra?: RothIraDistributionFactsCents }>,
): RothBasisCarrier {
  const carrier: RothBasisCarrier = new Map();
  for (const [poolKey, facts] of factsByPool.entries()) {
    // Defence in depth: an inherited pool holds no basis state of any kind,
    // and the `Math.max(0, …)` below would otherwise MATERIALISE a $0 entry for
    // one. `buildRothDistributionFacts` does not emit such a pool, so this only
    // fires for a caller that hands one over anyway.
    if (facts.rothIra?.inheritedFromDeceasedOwner === true) continue;
    const lots: MutableRothConversionLot[] = [...(facts.rothIra?.conversionLots ?? [])]
      .sort((a, b) => a.taxYear - b.taxYear)
      .map((lot) => ({
        taxYear: lot.taxYear,
        taxableRemainingCents: Math.max(0, Math.round(lot.taxableConvertedPrincipalCents)),
        nontaxableRemainingCents: Math.max(0, Math.round(lot.nontaxableConvertedPrincipalCents)),
      }));
    carrier.set(poolKey, {
      rothBasisRemainingCents: Math.max(
        0,
        Math.round(facts.rothIra?.regularContributionBasisCents ?? 0),
      ),
      rothCumulativeWithdrawnCents: 0,
      conversionLots: lots,
      // The pool's five-year clock rides along so the FUNDING pass can run the
      // same §408A qualified test the annotation pass runs; absent → unmet
      // (conservative).
      ...(facts.rothIra?.firstContributionTaxYear !== undefined
        ? { firstContributionTaxYear: facts.rothIra.firstContributionTaxYear }
        : {}),
    });
  }
  return carrier;
}

/**
 * Mutable per-ACCOUNT designated-Roth carrier entry.
 * Each designated-Roth account keeps its OWN five-tax-year clock, basis,
 * in-plan rollover lots, and governmental-457(b) flag — designated-Roth accounts
 * do NOT pool across plans/accounts the way Roth IRAs do.
 */
export interface MutableDesignatedRothAccountEntry {
  readonly accountId: string;
  readonly ownerId: string;
  /** Remaining known designated-Roth basis (integer cents), decremented across
   *  years by each pro-rata distribution's basis portion. */
  designatedRothBasisRemainingCents: number;
  readonly firstParticipationTaxYear?: number;
  /** Mutable in-plan rollover lots — each lot's remaining taxable/nontaxable
   *  rollover principal is decremented as basis is consumed across years. */
  readonly inPlanRolloverLots: readonly MutableRothInPlanRolloverLot[];
  readonly isGovernmental457b: boolean;
  /** The account is INHERITED: a distribution from it is made on account of
   *  the original owner's death, so it is qualified once the account's own
   *  five-year participation period is met and carries no 10% additional tax at
   *  any beneficiary age (§72(t)(2)(A)(ii)). */
  readonly inheritedFromDeceasedOwner?: boolean;
}

/** Account-id-keyed designated-Roth carrier. */
export type DesignatedRothCarrier = Map<string, MutableDesignatedRothAccountEntry>;

/**
 * Seed the account-keyed designated-Roth carrier from
 * per-ACCOUNT facts. One entry per qualifying designated-Roth account,
 * each keeping its own clock/basis/lots — never pooled across accounts. Returns
 * a fresh mutable carrier so each engine path owns an independent copy.
 */
export function seedDesignatedRothCarrier(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
): DesignatedRothCarrier {
  const carrier: DesignatedRothCarrier = new Map();
  for (const [accountId, facts] of factsByAccount.entries()) {
    carrier.set(accountId, {
      accountId,
      ownerId: facts.ownerId,
      designatedRothBasisRemainingCents: Math.max(0, Math.round(facts.basisCents)),
      firstParticipationTaxYear: facts.firstParticipationTaxYear,
      inPlanRolloverLots: (facts.inPlanRolloverLots ?? []).map((lot) => ({
        taxYear: lot.taxYear,
        taxableRolloverPrincipalRemainingCents: Math.max(
          0,
          Math.round(lot.taxableRolloverPrincipalCents),
        ),
        nontaxableRolloverPrincipalRemainingCents: Math.max(
          0,
          Math.round(lot.nontaxableRolloverPrincipalCents),
        ),
      })),
      isGovernmental457b: facts.isGovernmental457b ?? false,
      ...(facts.inheritedFromDeceasedOwner === true
        ? { inheritedFromDeceasedOwner: true }
        : {}),
    });
  }
  return carrier;
}

/**
 * Apply the fact-based §408A ordering for one owner's
 * Roth-IRA distribution against the mutable carrier entry: consume remaining
 * regular contributions, then conversion lots FIFO (taxable-converted principal
 * then nontaxable within each lot, applying each lot's own five-tax-year
 * recapture clock), then earnings. Mutates `entry` in place (decrements
 * remaining basis / lot basis, increments cumulative withdrawn) and returns the
 * tax breakdown.
 *
 * The stateless reference implementation is `orderRothIraDistribution`
 * (roth-distribution-tax.ts); this variant walks the SAME order over the
 * carrier's mutable remaining state so cumulative multi-year ordering works.
 */
export function applyFactBasedRothIraOrdering(
  entry: RothBasisCarrierEntry,
  args: {
    readonly withdrawalCents: number;
    readonly distributionTaxYear: number;
    readonly ownerReached59Half: boolean;
    readonly firstContributionTaxYear?: number;
    /** The draw comes from an INHERITED Roth IRA, so it is made on account
     *  of the original owner's death: death is the qualifying event
     *  (§408A(d)(2)(A)(ii)) and no 10% additional tax applies at any beneficiary
     *  age (§72(t)(2)(A)(ii)). Absent → the entry's own pool status decides, and
     *  failing that the owner's own 59½ test governs. */
    readonly inheritedFromDeceasedOwner?: boolean;
  },
): RothIraDistributionResult {
  // Apply the SAME strict cents validation the pure engine uses — reject a
  // non-finite / NaN withdrawal or basis (never propagate it through the carrier
  // buckets); a negative clamps to 0.
  const withdrawalCents = normalizeRothCents(args.withdrawalCents, 'withdrawalCents');
  // Mirrors `applyFactBasedDesignatedRothDistribution`: the carrier entry's own
  // inherited status counts too, so a seeded inherited pool keeps the death
  // exception even if a caller omits the argument. Safe because a pool holds either
  // the owner's own accounts or ONE inherited account, never both (`rothIraPoolKey`).
  const inherited =
    args.inheritedFromDeceasedOwner === true || entry.inheritedFromDeceasedOwner === true;
  // Death is itself a qualifying event on an inherited Roth IRA — the five-year
  // period (from the ORIGINAL owner's first contribution year) still applies.
  const qualified = isRothIraDistributionQualified(
    {
      firstContributionTaxYear: args.firstContributionTaxYear,
      inheritedFromDeceasedOwner: inherited,
    },
    args.distributionTaxYear,
    args.ownerReached59Half,
  );

  let remaining = withdrawalCents;

  // Layer 1: regular contributions (tax/penalty-free).
  const regularContributionCents = Math.min(
    remaining,
    normalizeRothCents(entry.rothBasisRemainingCents, 'rothBasisRemainingCents'),
  );
  entry.rothBasisRemainingCents -= regularContributionCents;
  remaining -= regularContributionCents;

  // Layer 2: conversion lots FIFO — AGGREGATED BY TAX YEAR (§408A(d)(4)(B)):
  // all of a year's lots' taxable-converted principal is consumed before any of
  // that year's nontaxable principal. The carrier's lots are seeded sorted
  // ascending by tax year, so same-year lots are adjacent. Lots dated after the
  // distribution year are skipped — they cannot exist yet.
  const lots = entry.conversionLots ?? [];
  let conversionTaxablePrincipalCents = 0;
  let conversionNontaxablePrincipalCents = 0;
  let recaptureCents = 0;
  let idx = 0;
  while (idx < lots.length && remaining > 0) {
    const taxYear = lots[idx].taxYear;
    let end = idx;
    while (end < lots.length && lots[end].taxYear === taxYear) end += 1;
    if (taxYear > args.distributionTaxYear) {
      idx = end; // future lot — skip
      continue;
    }
    const inRecaptureWindow =
      !args.ownerReached59Half &&
      args.distributionTaxYear - taxYear < ROTH_FIVE_TAX_YEAR_PERIOD;
    // Phase 1: this year's TOTAL taxable-converted principal. Each lot's
    // remaining cents is validated before it is drawn.
    for (let k = idx; k < end && remaining > 0; k += 1) {
      const lot = lots[k];
      const taxableDrawn = Math.min(
        remaining,
        normalizeRothCents(lot.taxableRemainingCents, 'taxableRemainingCents'),
      );
      lot.taxableRemainingCents -= taxableDrawn;
      conversionTaxablePrincipalCents += taxableDrawn;
      remaining -= taxableDrawn;
      if (taxableDrawn > 0 && inRecaptureWindow) recaptureCents += taxableDrawn;
    }
    // Phase 2: this year's TOTAL nontaxable-converted principal.
    for (let k = idx; k < end && remaining > 0; k += 1) {
      const lot = lots[k];
      const nontaxableDrawn = Math.min(
        remaining,
        normalizeRothCents(lot.nontaxableRemainingCents, 'nontaxableRemainingCents'),
      );
      lot.nontaxableRemainingCents -= nontaxableDrawn;
      conversionNontaxablePrincipalCents += nontaxableDrawn;
      remaining -= nontaxableDrawn;
    }
    idx = end;
  }

  // Layer 3: earnings (the remainder).
  const earningsCents = remaining;
  entry.rothCumulativeWithdrawnCents += withdrawalCents;

  const incomeTaxableCents = qualified ? 0 : earningsCents;
  // §72(t)(2)(A)(ii) death exception: no 10% at any beneficiary age.
  const additionalTaxBaseCents =
    qualified || inherited
      ? 0
      : recaptureCents + (args.ownerReached59Half ? 0 : earningsCents);
  // Perf: drop lots whose taxable AND nontaxable principal are both fully
  // consumed. A depleted lot contributes nothing to any later year's ordering, so
  // rescanning it every path-year is pure waste; pruning keeps the scan bounded by
  // the lots that still hold basis and is numerically a no-op.
  if (entry.conversionLots !== undefined) {
    const live = entry.conversionLots.filter(
      (lot) => lot.taxableRemainingCents > 0 || lot.nontaxableRemainingCents > 0,
    );
    if (live.length !== entry.conversionLots.length) entry.conversionLots = live;
  }

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
 * Apply the designated-Roth pro-rata nonqualified rule
 * for one ACCOUNT against its mutable carrier entry, given the account's
 * current balance (integer cents). Each account keeps its own five-tax-year
 * clock, basis, in-plan rollover lots, and governmental-457(b) flag
 * on the entry — never borrowed from another account. Delegates the split AND the
 * ordered basis allocation to `computeDesignatedRothDistribution`, then decrements
 * the entry's remaining designated basis by the returned basis portion, and each
 * in-plan rollover lot's remaining principal by exactly the amount that same
 * allocation drew from it, so multi-year recapture stays capped at
 * each lot's original taxable principal (cumulative across years).
 */
export function applyFactBasedDesignatedRothDistribution(
  entry: MutableDesignatedRothAccountEntry,
  args: {
    readonly accountBalanceCents: number;
    readonly withdrawalCents: number;
    readonly distributionTaxYear: number;
    readonly ownerReached59Half: boolean;
    /** Earnings attributable to a rollover from a different plan type into a
     *  governmental 457(b). Absent → 0. */
    readonly rolloverAttributableEarningsCents?: number;
    /** The distribution is made on account of the original owner's death
     *  (inherited account). Overrides the entry's own flag when supplied. */
    readonly inheritedFromDeceasedOwner?: boolean;
    /** Funding pass — HOUSEHOLD-conservative participation clock for a
     *  POOLED slice: when supplied, its `firstParticipationTaxYear` (undefined ⇒
     *  clock ABSENT, conservatively unmet) replaces the entry's own clock in the
     *  §402A qualification test — the pooled slice may aggregate dollars from
     *  owners whose clocks the picked entry does not carry. Per-account
     *  (annotation) callers omit it and the entry's own clock governs. */
    readonly pooledParticipationClock?: { readonly firstParticipationTaxYear?: number };
  },
): DesignatedRothDistributionResult {
  const basisRemainingCents = Math.max(0, entry.designatedRothBasisRemainingCents);
  const result = computeDesignatedRothDistribution({
    facts: {
      basisCents: basisRemainingCents,
      firstParticipationTaxYear:
        args.pooledParticipationClock !== undefined
          ? args.pooledParticipationClock.firstParticipationTaxYear
          : entry.firstParticipationTaxYear,
      // Pass each lot's REMAINING (not original) rollover principal so the
      // in-window recapture is computed against principal not already consumed in
      // an earlier withdrawal year.
      inPlanRolloverLots: entry.inPlanRolloverLots.map((lot) => ({
        taxYear: lot.taxYear,
        taxableRolloverPrincipalCents: lot.taxableRolloverPrincipalRemainingCents,
        nontaxableRolloverPrincipalCents: lot.nontaxableRolloverPrincipalRemainingCents,
      })),
      isGovernmental457b: entry.isGovernmental457b,
      ...(args.inheritedFromDeceasedOwner === true ||
      entry.inheritedFromDeceasedOwner === true
        ? { inheritedFromDeceasedOwner: true }
        : {}),
    },
    accountBalanceCents: args.accountBalanceCents,
    withdrawalCents: args.withdrawalCents,
    distributionTaxYear: args.distributionTaxYear,
    ownerReached59Half: args.ownerReached59Half,
    rolloverAttributableEarningsCents: args.rolloverAttributableEarningsCents,
  });
  // Decrement each in-plan rollover lot's remaining principal by
  // EXACTLY the amounts the ordered basis allocator drew from it — the SAME
  // allocation the additional-tax recapture was computed from
  // (`result.basisAllocation`). Because the recapture base and these state
  // decrements are one shared allocation (ordinary basis first, then rollover
  // lots FIFO, taxable before nontaxable), they can never disagree at a cent
  // boundary: a taxable-rollover cent is recaptured in the SAME year it is
  // decremented and never re-counted in a later year, capping a lot's LIFETIME
  // §402A(c)(4)(D) recapture at its original taxable principal.
  const { lotConsumptions } = result.basisAllocation;
  for (let i = 0; i < entry.inPlanRolloverLots.length; i += 1) {
    const consumed = lotConsumptions[i];
    if (!consumed) continue;
    const lot = entry.inPlanRolloverLots[i];
    lot.taxableRolloverPrincipalRemainingCents = Math.max(
      0,
      lot.taxableRolloverPrincipalRemainingCents - consumed.taxableConsumedCents,
    );
    lot.nontaxableRolloverPrincipalRemainingCents = Math.max(
      0,
      lot.nontaxableRolloverPrincipalRemainingCents - consumed.nontaxableConsumedCents,
    );
  }
  entry.designatedRothBasisRemainingCents = Math.max(
    0,
    basisRemainingCents - result.basisCents,
  );
  return result;
}

/**
 * The household-conservative five-year clock across a funding map's pooled
 * per-owner entries: the LATEST clock across entries and ABSENT when any entry
 * lacks one (or the map is empty — no recorded facts, conservatively unmet).
 * The same one-sided reduction `flattenRothIraPoolsByOwner` /
 * `poolSolverDesignatedRothStates` apply within an owner, taken across the
 * household for the funding slices' no-matching-ledger-account fallback, where
 * no per-owner ledger set exists to reduce over.
 */
function householdClockAcrossEntries(
  clocks: Iterable<number | undefined>,
): number | undefined {
  let latest: number | undefined;
  for (const clock of clocks) {
    if (clock === undefined) return undefined;
    latest = latest === undefined ? clock : Math.max(latest, clock);
  }
  return latest;
}

/** `householdClockAcrossEntries` over a funding §408A carrier's entries. */
export function householdRothIraClock(carrier: RothBasisCarrier): number | undefined {
  return householdClockAcrossEntries(
    [...carrier.values()].map((entry) => entry.firstContributionTaxYear),
  );
}

/** `householdClockAcrossEntries` over pooled designated funding states. */
export function householdDesignatedRothClock(
  states: SolverDesignatedRothStates,
): number | undefined {
  return householdClockAcrossEntries(
    [...states.values()].map((state) => state.entry.firstParticipationTaxYear),
  );
}
