/**
 * Roth §408A basis carriers and the fact-based §408A / §402A ordering helpers.
 * See `docs/math-retirement-accounts.md`.
 */
import type { AccountType } from '../db/types';
import { isMagiCapDisabled } from '../db/types';
import type { MagiCapOverride } from '../db/types';
import type { DrawdownYear } from './drawdown-engine-types';
import type { PipelineContext } from './balance-projection-runner-types';
import { isPureRothEmployerType, isRothDesignatedPostBucket } from './balance-calc';
import type { PenaltyAccountSnapshot } from './tax-integration';
// Reuses the penalty engine's half-birthday resolver so ordering and the §72(t) proration agree on the year
// the owner reached 59½.
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
 * Cumulative Roth-IRA basis carrier, one entry per §408A aggregation pool (`rothIraPoolKey`: the bare
 * `ownerId` for an owner's own Roth IRAs, one account per Pub 590-B). An inherited Roth IRA has no entry. A
 * pool's withdrawals consume `rothBasisRemainingCents` first; only the excess is earnings (taxed, plus 10%
 * pre-59½). Mutated in place each year.
 * The funding pass keeps its own owner-keyed copy (`flattenRothIraPoolsByOwner`).
 */
interface RothBasisCarrierEntry {
  /** Remaining tax/penalty-free §408A contribution basis (integer cents). */
  rothBasisRemainingCents: number;
  /** Cumulative Roth-IRA dollars withdrawn so far (integer cents). */
  rothCumulativeWithdrawnCents: number;
  /**
   * Remaining conversion-lot basis for the fact-based ordering, consumed FIFO after regular contributions,
   * each lot keeping its own tax year for its five-tax-year recapture clock. Populated only by
   * `seedFactBasedRothBasisCarrier`.
   */
  conversionLots?: MutableRothConversionLot[];
  /**
   * The entry's accounts are inherited, so draws are made on account of the original owner's death (§408A
   * death qualifying event, §72(t)(2)(A)(ii) exemption).
   */
  inheritedFromDeceasedOwner?: boolean;
  /**
   * The pool's §408A five-taxable-year clock (first contribution tax year). In the owner-flattened funding
   * carrier it is the latest clock across the owner's pools, absent when any pool lacks one; the annotation
   * and MC paths pass their own clock.
   */
  readonly firstContributionTaxYear?: number;
}

/** Mutable conversion-lot basis tracked on the fact-based carrier. */
interface MutableRothConversionLot {
  /** The lot's conversion tax year, which starts its five-tax-year recapture clock. */
  readonly taxYear: number;
  /** Remaining taxable-converted principal (integer cents). */
  taxableRemainingCents: number;
  /** Remaining nontaxable-converted principal (integer cents). */
  nontaxableRemainingCents: number;
}

/**
 * Mutable in-plan Roth rollover lot on the fact-based designated-Roth carrier. Remaining principal is
 * decremented by each year's ordered allocation, so a lot's lifetime §402A(c)(4)(D) recapture is capped at
 * its original taxable principal.
 */
interface MutableRothInPlanRolloverLot {
  /** The lot's rollover tax year, which starts its own five-tax-year recapture clock. */
  readonly taxYear: number;
  /** Remaining taxable in-plan Roth rollover principal (integer cents). */
  taxableRolloverPrincipalRemainingCents: number;
  /** Remaining nontaxable in-plan Roth rollover principal (integer cents). */
  nontaxableRolloverPrincipalRemainingCents: number;
}

/** Pool-keyed Roth basis carrier (`rothIraPoolKey`). */
export type RothBasisCarrier = Map<string, RothBasisCarrierEntry>;

/**
 * Seeds the owner-keyed Roth basis carrier from a per-owner basis map, each owner starting with full basis
 * and $0 withdrawn. Test-only: production seeds per pool via `seedFactBasedRothBasisCarrier`.
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
  /**
   * Ordinary-income-taxable Roth dollars for the year: nonqualified Roth-IRA earnings (after §408A ordering)
   * plus the earnings portion of nonqualified designated-Roth pro-rata distributions.
   */
  readonly earningsExcessDollars: number;
  /**
   * Per-account §72(t)/§402A additional-tax inputs. `penaltyPreTaxWithdrawalDollars` is the account's share
   * of the additional-tax base (nonqualified earnings plus taxable converted or rolled-over principal inside
   * its five-tax-year window); keyed by real account id so a marked-exempt Roth account waives only its own
   * share.
   */
  readonly penaltyAccounts: readonly PenaltyAccountSnapshot[];
}

/**
 * True when the owner was 59½ for the whole tax year. The year-granular projection takes the conservative
 * side: the owner counts as 59½ only once the year carries no §72(t) proration, so the half-birthday year is
 * nonqualified. A missing or unparseable birthdate counts as not reached.
 */
export function ownerReached59HalfForWholeYear(
  ownerBirthdate: string | null | undefined,
  taxYear: number,
): boolean {
  return penaltyFractionForYear(ownerBirthdate, taxYear, { ageYears: 59, ageMonths: 6 }) === 0;
}

interface RothAccountDraw {
  readonly accountId: string;
  readonly ownerId: string;
  readonly accountType: AccountType;
  readonly drawCents: number;
  readonly preDistributionBalanceCents: number;
  readonly inherited: boolean;
}

// Collects each Roth account's committed draw: §408A Roth-IRA draws (pooled by the caller) and per-account
// designated-Roth draws (§402A accounts never pool).
// An inherited Roth IRA's draw is dropped, since it is tax-free and `applyRothBasisOrdering` would otherwise
// create a $0 pool for it. MIXED accounts contribute only their post sub-bucket;
// `buildPenaltyAccountsForYear` owns the pre tranche.
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
    const drawCents = isMixedRothDesignated
      ? row.postWithdrawnCents !== undefined
        ? Math.round(row.postWithdrawnCents)
        : 0
      : Math.round(row.withdrawn * 100);
    if (drawCents <= 0) continue;
    const preDistributionBalanceCents = isMixedRothDesignated
      ? Math.round(row.postEnd * 100) + drawCents
      : Math.round(row.balance * 100) + drawCents;
    // Optional-chained for hand-rolled test contexts that omit the map.
    const inherited = ctx.rmdProfileFactsByAccountId?.get(id)?.inheritedAccount === true;
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

// Allocates an owner-level cents figure across the owner's draws in proportion, with the rounding residual on
// the largest draw so the parts sum exactly.
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
 * Applies the fact-based §408A / §402A Roth distribution rules for one year across every Roth account type,
 * mutating both carriers in place.
 * Roth IRAs aggregate across the owner's own accounts (Pub 590-B) and come out in §408A order: contributions,
 * then conversion lots FIFO by tax year (taxable before nontaxable), then earnings. Designated-Roth employer
 * accounts never pool: each keeps its own clock, basis and rollover lots, with nonqualified draws pro rata
 * (§402A(d)(4)). Missing facts stay conservative.
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

  // An owner's own Roth IRAs share one pool (Pub 590-B). Inherited draws are filtered out upstream because
  // the `?? { ... }` below would create a pool from any key it is given.
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
      // Always false in practice, since no inherited Roth-IRA draw survives `collectRothDraws`.
      inheritedFromDeceasedOwner: draws.every((d) => d.inherited),
    });
    incomeTaxableCents += result.incomeTaxableCents;
    // The owner-level ordering is authoritative, but the additional-tax base is emitted per real account id
    // so a marked-exempt Roth IRA waives only its own share.
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

  for (const draw of designatedDraws) {
    const entry = designatedCarrier.get(draw.accountId);
    // An account absent from the carrier gets $0 basis and an unmet five-year clock, the conservative
    // default, so its earnings do not escape ordinary income.
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
      // Death qualifying event and §72(t)(2)(A)(ii) on an inherited plan account.
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

// Resolves the cap window active in `calendarYear`, sorted in the engine's
// `(startYear, endYear, originalIndex)` order: scanning stored order could credit the §408A basis to the
// wrong window's `targetRothAccountId`. A window with an unresolvable anchor is skipped.
// @455 delete
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

// At the cap, incoming cents merge into the newest lot rather than being dropped, so no principal is lost;
// lots are aggregated by tax year (§408A(d)(4)(B)).
const MAX_CARRIER_CONVERSION_LOTS = 200;

// Credits engine-generated conversion principal as a dated, taxable conversion lot for `taxYear`, so it
// carries its own five-taxable-year §408A(d)(3)(F) recapture clock. Same-year credits merge; at the cap the
// credit merges into the newest lot, which keeps the longest recapture window and so can only overstate
// recapture.
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
  // FIFO consumption needs ascending tax-year order.
  lots.sort((a, b) => a.taxYear - b.taxYear);
}

/**
 * Credits a year's Fill-mode conversion principal to the target Roth's §408A basis carrier as a dated
 * conversion lot. Run after `applyRothBasisOrdering` for the same year, since converted dollars land at year
 * end and are basis only for later years. A no-op when no conversion occurred, no window is active, or the
 * target is not a live `RETIREMENT_ROTH_IRA`.
 */
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
  // An inherited Roth IRA cannot receive a conversion, so no converted cents should reach here; if they did,
  // the credit would land on the beneficiary's own pool and buy tax-free basis for dollars in the inherited
  // account.
  if (ctx.rmdProfileFactsByAccountId?.get(targetId)?.inheritedAccount === true) return;
  const ownerId = target.account.payload.ownerId;
  // The owner's own pool (bare owner id): a conversion can only land in an account the owner opened.
  const entry = carrier.get(ownerId) ?? {
    rothBasisRemainingCents: 0,
    rothCumulativeWithdrawnCents: 0,
  };
  // Credited as a dated conversion lot, not undated basis: a pre-59½ withdrawal inside the five-taxable-year
  // window owes the 10% §408A(d)(3)(F) recapture.
  creditConversionLot(entry, year.year, convertedCents);
  carrier.set(ownerId, entry);
}

/**
 * Per-pool Roth-IRA distribution facts (cents) that seed the carrier; defined in the leaf
 * `roth-distribution-tax` to avoid an import cycle through this module.
 */
export type { RothIraPoolFactsCents };

/**
 * Builds the deterministic §408A seed facts per pool: the profile `buildRothDistributionFacts` derives from
 * recorded history, plus the working-years converted principal, credited to the owner's own pool.
 * Converted principal seeds as a dated conversion lot (`datedConversionCentsByOwner`) so a pre-59½ withdrawal
 * within five tax years carries the §408A(d)(3)(F) recapture; with only an undated total it falls back to
 * regular basis. The MC seed excludes these maps.
 */
export function mergeFactBasedRothIraSeeds(
  factsByPool: ReadonlyMap<string, RothIraPoolFactsCents>,
  extraRegularBasisCentsByOwner: ReadonlyMap<string, number> | undefined,
  /**
   * Owner id to conversion tax year to cents of working-years conversion principal; the dated lots replace
   * the owner's undated total.
   */
  datedConversionCentsByOwner?: ReadonlyMap<string, ReadonlyMap<number, number>>,
): Map<string, RothIraPoolFactsCents> {
  const out = new Map<string, RothIraPoolFactsCents>();
  for (const [poolKey, facts] of factsByPool) out.set(poolKey, facts);
  for (const [ownerId, extraCents] of extraRegularBasisCentsByOwner ?? new Map()) {
    if (extraCents <= 0) continue;
    // The owner's own pool is keyed by the bare owner id, never an inherited pool's key.
    const existing = out.get(ownerId)?.rothIra;
    const dated = datedConversionCentsByOwner?.get(ownerId);
    if (dated !== undefined && dated.size > 0) {
      // One lot per conversion year, merged with recorded lots and kept ascending by tax year.
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
 * Collapses pool-keyed Roth-IRA facts onto the owner for the household-aggregate funding pass, which has no
 * committed per-account draw to attribute to a pool; the annotation post-pass re-derives the per-pool split.
 * Inherited dollars never reach it (`rothInheritedTaxFreeDollars`). The clock is the latest across the
 * owner's pools and absent when any pool lacks one.
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
 * One owner's pooled designated-plan state for the funding pass, kept apart from the §408A carrier entry
 * because Roth-IRA basis is not basis of a §402A(d)(4) distribution. It runs the same primitive as the
 * annotation pass (`applyFactBasedDesignatedRothDistribution`), pooled onto the owner as in
 * `seedMcDesignatedRothPool`.
 */
interface SolverDesignatedRothState {
  /**
   * The pooled mutable designated entry (basis, dated rollover lots, clock, 457(b) flag), consumed once
   * across the projection's years.
   */
  readonly entry: MutableDesignatedRothAccountEntry;
  /**
   * Running pooled designated balance (integer cents), the §402A(d)(4) pro-rata denominator: seeded from
   * at-retirement ledger balances, decremented by each year's draw, and never used below the draw itself so
   * the basis fraction cannot exceed 1.
   */
  balanceRemainingCents: number;
}

/**
 * Owner id to that owner's pooled designated-Roth funding state, mutated across years like the funding
 * carrier.
 */
export type SolverDesignatedRothStates = Map<string, SolverDesignatedRothState>;

/**
 * Seeds the funding pass's per-owner pooled designated-Roth state from the per-account designated facts
 * (after `mergeDesignatedRothSeeds`). A designated account's basis is its in-plan-rollover principal, which
 * may still be inside its §402A(c)(4)(D) recapture window, so it cannot be sheltered as plain basis.
 * Pooling is conservative: basis sums, lots aggregate by tax year, the clock is the latest and absent when
 * any plan lacks one, and the 457(b) carve-out needs every plan to be a 457(b). An inherited plan contributes
 * nothing (no 10% at any age, §72(t)(2)(A)(ii)); it runs against the inherited pooled state.
 */
export function seedSolverDesignatedRothStates(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
  /** Per-owner at-retirement designated pocket balance (integer cents), the pro-rata denominator seed. */
  designatedBalanceCentsByOwner: ReadonlyMap<string, number>,
): SolverDesignatedRothStates {
  return poolSolverDesignatedRothStates(factsByAccount, designatedBalanceCentsByOwner, false);
}

/**
 * Inherited counterpart of `seedSolverDesignatedRothStates`: pools only inherited designated-Roth facts, each
 * entry marked `inheritedFromDeceasedOwner: true` so the death event (§402A(d)(2)(B)(i)) qualifies the draw
 * and the 10% is waived (§72(t)(2)(A)(ii)). These dollars never touch the §408A carrier, whose ordering would
 * charge a 10% the statute waives.
 */
export function seedSolverInheritedDesignatedRothStates(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
  /** Per-owner at-retirement inherited designated pocket balance (integer cents). */
  designatedBalanceCentsByOwner: ReadonlyMap<string, number>,
): SolverDesignatedRothStates {
  return poolSolverDesignatedRothStates(factsByAccount, designatedBalanceCentsByOwner, true);
}

// Shared per-owner pooling for the two seeds above; `inherited` selects which facts are pooled.
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
 * Builds the deterministic designated-Roth seed facts: the recorded per-account facts plus the same-account
 * MIXED in-plan conversion basis, credited to the exact target account because designated-Roth accounts never
 * pool.
 */
export function mergeDesignatedRothSeeds(
  factsByAccount: ReadonlyMap<string, DesignatedRothAccountFactsCents>,
  extraBasisCentsByAccount: ReadonlyMap<string, number> | undefined,
  /**
   * Target account id to rollover tax year to cents of engine-generated in-plan conversion principal, seeded
   * as a dated rollover lot with its own §402A(c)(4)(D) window; absent gives the undated basis-only credit.
   */
  datedInPlanRolloverCentsByAccount?: ReadonlyMap<string, ReadonlyMap<number, number>>,
): Map<string, DesignatedRothAccountFactsCents> {
  const out = new Map<string, DesignatedRothAccountFactsCents>();
  for (const [accountId, facts] of factsByAccount) out.set(accountId, facts);
  for (const [accountId, extraCents] of extraBasisCentsByAccount ?? new Map()) {
    if (extraCents <= 0) continue;
    const existing = out.get(accountId);
    // An account with no recorded designated-Roth facts is skipped rather than given a fabricated entry.
    if (!existing) continue;
    const dated = datedInPlanRolloverCentsByAccount?.get(accountId);
    const lots: RothInPlanRolloverLotCents[] = [...(existing.inPlanRolloverLots ?? [])];
    for (const [taxYear, cents] of dated ?? new Map<number, number>()) {
      if (cents <= 0) continue;
      lots.push({
        taxYear,
        // In-plan conversion of pre-tax dollars is taxable rollover principal, the tranche §402A(c)(4)(D)
        // recaptures inside its window.
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
 * Seeds the pool-keyed Roth-IRA basis carrier from the per-pool facts derived from recorded balance history
 * (`buildRothDistributionFacts`): each pool starts with its remaining regular basis and conversion lots (FIFO
 * by tax year). Takes the structural fact shape so the MC single-pocket seed can reuse it.
 */
export function seedFactBasedRothBasisCarrier(
  factsByPool: ReadonlyMap<string, { readonly rothIra?: RothIraDistributionFactsCents }>,
): RothBasisCarrier {
  const carrier: RothBasisCarrier = new Map();
  for (const [poolKey, facts] of factsByPool.entries()) {
    // An inherited pool holds no basis state, and the `Math.max(0, ...)` below would otherwise materialise a
    // $0 entry for one.
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
      // The pool's five-year clock rides along so the funding pass runs the same §408A qualified test; absent
      // is unmet.
      ...(facts.rothIra?.firstContributionTaxYear !== undefined
        ? { firstContributionTaxYear: facts.rothIra.firstContributionTaxYear }
        : {}),
    });
  }
  return carrier;
}

/**
 * Mutable per-account designated-Roth carrier entry: each account keeps its own clock, basis, in-plan
 * rollover lots and governmental-457(b) flag, since designated-Roth accounts do not pool.
 */
export interface MutableDesignatedRothAccountEntry {
  readonly accountId: string;
  readonly ownerId: string;
  /**
   * Remaining known designated-Roth basis (integer cents), decremented by each pro-rata distribution's basis
   * portion.
   */
  designatedRothBasisRemainingCents: number;
  readonly firstParticipationTaxYear?: number;
  /** Mutable in-plan rollover lots, decremented as basis is consumed across years. */
  readonly inPlanRolloverLots: readonly MutableRothInPlanRolloverLot[];
  readonly isGovernmental457b: boolean;
  /**
   * The account is inherited: distributions are on account of the original owner's death, so they are
   * qualified once the account's own five-year period is met and carry no 10% at any beneficiary age
   * (§72(t)(2)(A)(ii)).
   */
  readonly inheritedFromDeceasedOwner?: boolean;
}

/** Account-id-keyed designated-Roth carrier. */
export type DesignatedRothCarrier = Map<string, MutableDesignatedRothAccountEntry>;

/**
 * Seeds the account-keyed designated-Roth carrier from per-account facts, one entry per qualifying account,
 * never pooled.
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
 * Applies the fact-based §408A ordering for one owner's Roth-IRA distribution against the mutable carrier
 * entry: regular contributions, then conversion lots FIFO (each with its own five-tax-year recapture clock),
 * then earnings. Mutates `entry` and returns the tax breakdown; `orderRothIraDistribution` is the stateless
 * reference.
 */
export function applyFactBasedRothIraOrdering(
  entry: RothBasisCarrierEntry,
  args: {
    readonly withdrawalCents: number;
    readonly distributionTaxYear: number;
    readonly ownerReached59Half: boolean;
    readonly firstContributionTaxYear?: number;
    /**
     * The draw comes from an inherited Roth IRA: death is the qualifying event (§408A(d)(2)(A)(ii)) and no
     * 10% applies at any beneficiary age (§72(t)(2)(A)(ii)). Absent, the entry's pool status decides, then
     * the owner's own 59½ test.
     */
    readonly inheritedFromDeceasedOwner?: boolean;
  },
): RothIraDistributionResult {
  // Same strict cents validation as the pure engine: reject a non-finite or NaN withdrawal or basis; a
  // negative clamps to 0.
  const withdrawalCents = normalizeRothCents(args.withdrawalCents, 'withdrawalCents');
  // The entry's own inherited status also counts, as in `applyFactBasedDesignatedRothDistribution`; safe
  // because a pool holds either the owner's own accounts or one inherited account.
  const inherited =
    args.inheritedFromDeceasedOwner === true || entry.inheritedFromDeceasedOwner === true;
  // Death is a qualifying event on an inherited Roth IRA, but the five-year period from the original owner's
  // first contribution year still applies.
  const qualified = isRothIraDistributionQualified(
    {
      firstContributionTaxYear: args.firstContributionTaxYear,
      inheritedFromDeceasedOwner: inherited,
    },
    args.distributionTaxYear,
    args.ownerReached59Half,
  );

  let remaining = withdrawalCents;

  const regularContributionCents = Math.min(
    remaining,
    normalizeRothCents(entry.rothBasisRemainingCents, 'rothBasisRemainingCents'),
  );
  entry.rothBasisRemainingCents -= regularContributionCents;
  remaining -= regularContributionCents;

  // Conversion lots FIFO, aggregated by tax year (§408A(d)(4)(B)): a year's taxable converted principal is
  // consumed before any of its nontaxable principal. Lots dated after the distribution year are skipped.
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

  const earningsCents = remaining;
  entry.rothCumulativeWithdrawnCents += withdrawalCents;

  const incomeTaxableCents = qualified ? 0 : earningsCents;
  const additionalTaxBaseCents =
    qualified || inherited
      ? 0
      : recaptureCents + (args.ownerReached59Half ? 0 : earningsCents);
  // Prune fully consumed lots so later years do not rescan them; numerically a no-op.
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
 * Applies the designated-Roth pro-rata nonqualified rule for one account against its mutable entry, given the
 * account's current balance (integer cents). Delegates the split and ordered basis allocation to
 * `computeDesignatedRothDistribution`, then decrements the entry's basis and each rollover lot by exactly
 * what that allocation drew, so multi-year recapture stays capped at each lot's original taxable principal.
 */
export function applyFactBasedDesignatedRothDistribution(
  entry: MutableDesignatedRothAccountEntry,
  args: {
    readonly accountBalanceCents: number;
    readonly withdrawalCents: number;
    readonly distributionTaxYear: number;
    readonly ownerReached59Half: boolean;
    /**
     * Earnings attributable to a rollover from a different plan type into a governmental 457(b); absent is 0.
     */
    readonly rolloverAttributableEarningsCents?: number;
    /**
     * The distribution is on account of the original owner's death; overrides the entry's own flag when
     * supplied.
     */
    readonly inheritedFromDeceasedOwner?: boolean;
    /**
     * Funding pass: a household-conservative participation clock for a pooled slice, replacing the entry's
     * own clock in the §402A qualification test (undefined means absent, unmet). Per-account callers omit it.
     */
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
      // Pass each lot's remaining (not original) principal so in-window recapture ignores principal consumed
      // in earlier years.
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
  // Decrement each lot by exactly what the ordered basis allocator drew, the same allocation the recapture
  // was computed from, so a taxable-rollover cent is recaptured in the year it is decremented and never again
  // (§402A(c)(4)(D)).
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

// The household-conservative five-year clock across a funding map's pooled entries: the latest, absent when
// any entry lacks one or the map is empty.
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
