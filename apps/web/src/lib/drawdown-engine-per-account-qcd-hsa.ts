/**
 * QCD, RMD and HSA forced-outflow passes for the strategy-aware drawdown engine (IRC §408(d)(8), §401(a)(9),
 * SECURE 2.0 §325).
 * See `docs/math-retirement-accounts.md` and `docs/math-withdrawals.md` ("Where the code lives").
 */
import type { QcdContextInput, RmdContextInput } from './drawdown-engine-types';
import {
  ageInTaxYear,
  computeRmd,
  rmdDeclaredRothPortionCents,
  isInheritedRmdSubjectType,
  isQualifyingAccount,
  rmdTriggerAge,
  type RmdAccountInput,
  type RmdAccountType,
} from './rmd';
import {
  computeQcdForOwnerYear,
  type QcdEntryForOwnerYear,
} from './qcd';
import {
  applyFloorAwareShare,
  floorEligibleDollars,
  isHsaAccount,
  isPostTaxNonRoth,
  isRmdOverflowCashAccountId,
  reserveDrawable,
  type AccountRunState,
  type RmdFloorPrePassResult,
  type RmdSurplusDispositionResult,
} from './drawdown-engine-per-account-strategy-helpers';

/**
 * Builds the per-account RMD floor for `taxYear`: `computeRmd` runs per living owner over only that owner's
 * accounts, on the engine's current pre-tax sub-bucket; recorded RMD profile facts and the owner's separation
 * year go to the shared engine, so the forced draw agrees with the tax floor.
 * Limitation: only the pre-tax sub-bucket can be debited, so an inherited account that is entirely Roth has a
 * $0 base and is never force-drawn. Returns an array aligned with `state`.
 */
export function buildPerOwnerRmdFloor(args: {
  readonly taxYear: number;
  readonly state: ReadonlyArray<AccountRunState>;
  readonly rmdContext: RmdContextInput;
  /**
   * Each account's Dec-31 sub-buckets two years before `taxYear`, index-aligned to `state` and in dollars;
   * sizes a first-year-deferral catch-up, and absent means the engine reports a blocker instead of guessing.
   */
  readonly twoYearsPriorDollars?: ReadonlyArray<{ readonly pre: number; readonly post: number }>;
}): number[] {
  const { taxYear, state, rmdContext, twoYearsPriorDollars } = args;
  const floors = new Array<number>(state.length).fill(0);
  const factsById = rmdContext.rmdFactsByAccountId;

  const indicesByOwner = new Map<string, number[]>();
  for (let a = 0; a < state.length; a += 1) {
    const st = state[a];
    const ownerId = rmdContext.ownerByAccountId.get(st.id);
    if (!ownerId) continue;
    const accType = st.accountType as RmdAccountType;
    // An inherited account follows beneficiary rules even when the living-owner test rejects its type, so
    // admission uses `isInheritedRmdSubjectType`, as the tax floor and the MC surfaces do.
    const admitted =
      factsById?.[st.id]?.inheritedAccount === true
        ? isInheritedRmdSubjectType(accType)
        : isQualifyingAccount(accType, st.taxTreatment);
    if (!admitted) continue;
    if (!indicesByOwner.has(ownerId)) indicesByOwner.set(ownerId, []);
    indicesByOwner.get(ownerId)!.push(a);
  }
  if (indicesByOwner.size === 0) return floors;

  for (const [ownerId, accountIdxs] of indicesByOwner) {
    const meta = rmdContext.ownerMeta.get(ownerId);
    if (!meta) continue;
    // Death is Dec 31 of `deathYear`, so the floor applies through the death year.
    if (taxYear > meta.deathYear) continue;
    const birthYear = parseInt(meta.isoBirthdate.slice(0, 4), 10);
    const ownerAge = ageInTaxYear(meta.isoBirthdate, taxYear);
    // The owner-level trigger-age short-circuit is for the legacy branch only: with facts, `computeRmd`
    // applies the trigger age per account and never to an inherited account.
    const ownerHasFacts = accountIdxs.some((a) => factsById?.[state[a].id] !== undefined);
    if (!ownerHasFacts && ownerAge < rmdTriggerAge(birthYear)) continue;

    const ownerAccounts: RmdAccountInput[] = accountIdxs.map((a) => {
      const st = state[a];
      // RMD basis is the drawable pre-tax sub-bucket (`st.pre`) only: counting `st.post` would inflate the
      // floor into a shortfall the pass can never satisfy. This differs from the display-only MC assembler
      // `buildMcRmdAccountInput`, which uses the whole balance.
      const facts = factsById?.[st.id];
      const twoYearsPrior = twoYearsPriorDollars?.[a];
      const baseInput: RmdAccountInput = {
        id: st.id,
        balanceDec31PriorYearCents: Math.round(st.pre * 100),
        accountType: st.accountType as RmdAccountType,
        taxTreatment: st.taxTreatment,
        ...(facts !== undefined ? { facts } : {}),
        // The catch-up base uses the same drawable-pre-tax convention as the current-year base.
        ...(twoYearsPrior !== undefined
          ? { balanceDec31TwoYearsPriorCents: Math.round(twoYearsPrior.pre * 100) }
          : {}),
      };
      // An account with a Roth-designated pocket passes the full balance plus `rmdDeclaredRothPortionCents`,
      // so the engine subtracts the pocket (SECURE 2.0 §325) and lands on the same pre-tax basis as every
      // other producer. Designated-Roth pre-59½ treatment is cost recovery (Pub 575), not §408A ordering,
      // which is `RETIREMENT_ROTH_IRA`-only.
      const priorCents = Math.round((st.pre + st.post) * 100);
      const rothPortionCents = rmdDeclaredRothPortionCents(
        st.taxTreatment,
        priorCents,
        Math.round(st.post * 100),
      );
      if (rothPortionCents === undefined) return baseInput;
      const twoYearsPriorCents =
        twoYearsPrior === undefined
          ? undefined
          : Math.round((twoYearsPrior.pre + twoYearsPrior.post) * 100);
      return {
        ...baseInput,
        balanceDec31PriorYearCents: priorCents,
        rothPortionCents,
        ...(twoYearsPriorCents !== undefined
          ? {
              balanceDec31TwoYearsPriorCents: twoYearsPriorCents,
              rothPortionTwoYearsPriorCents: rmdDeclaredRothPortionCents(
                st.taxTreatment,
                twoYearsPriorCents,
                Math.round(twoYearsPrior!.post * 100),
              )!,
            }
          : {}),
      };
    });

    const retirementYear = rmdContext.retirementYearByOwner?.[ownerId];
    const result = computeRmd(
      {
        isoBirthdate: meta.isoBirthdate,
        taxYear,
        accounts: ownerAccounts,
        // The §401(a)(9)(C) later-of first-distribution year needs the owner's separation year; absent, the
        // account withholds rather than assuming the trigger-age year.
        ...(retirementYear !== undefined ? { retirementYear } : {}),
      },
      rmdContext.rmdSnapshot,
    );
    if (!result.applicable) continue;

    for (const a of accountIdxs) {
      const cents = result.perAccountRmdCents[state[a].id] ?? 0;
      if (cents > 0) floors[a] = cents / 100;
    }
    // The per-account sum may differ from the owner total by up to 1 cent (largest-remainder rounding); the
    // engine forces only the per-account floor.
  }
  return floors;
}

/** Per-year QCD outcome for one household (both owners merged). */
export interface QcdPrePassResult {
  /** Total QCD directed across both owners this year, integer cents. */
  readonly totalQcdCents: number;
  /** Total QCD that offset an IRA-pool RMD floor, integer cents. */
  readonly rmdOffsetCents: number;
  /** Gross IRA-pool RMD floor across both owners before the QCD offset, integer cents. */
  readonly grossIraPoolRmdCents: number;
  /**
   * Per-owner QCD RMD offset (integer cents, `min(Q_owner, grossIraPoolRmd_owner)`), keyed by owner id; the
   * tax post-pass credits it to that owner's IRA pool so the QCD that satisfied the RMD (§408(d)(8)) never
   * shows as a missed RMD.
   */
  readonly rmdOffsetCentsByOwner: Readonly<Record<string, number>>;
  /**
   * The cumulative inflation factor this pass used to inflate the real QCD amount to nominal, anchored at the
   * year end; stamped as `qcdInflationFactor` so the display reverses the gift exactly. 1 in a no-QCD or
   * zero-inflation year.
   */
  readonly inflationFactor: number;
}

// The resolver guarantees PRE_TAX treatment and owner equality; the engine re-checks the type only to scope
// the IRA-pool RMD offset.
function isIraAccount(st: AccountRunState): boolean {
  return st.accountType === 'RETIREMENT_IRA';
}

/**
 * Runs the 70½-gated QCD forced-outflow pass for one year. Per owner and active entry,
 * `Q = min(inflated real amount, remaining per-person limit, source IRA prior-year-end pre-tax balance)` is
 * debited from the source IRA's pre-tax sub-bucket and offsets only that owner's IRA-pool RMD floor by
 * `min(Q, grossIraPoolRmd)`.
 * Mutates `state[*].pre` and `rmdFloorByAccountDollars` before `applyRmdFloorPrePass`, so donated dollars
 * never become RMD surplus or fund net need.
 */
export function applyQcdPrePass(args: {
  state: AccountRunState[];
  /**
   * Per-account RMD floor in dollars, index-aligned to `state`; the owner's IRA-pool entries are reduced by
   * the QCD offset.
   */
  rmdFloorByAccountDollars: number[];
  qcdContext: QcdContextInput;
  ownerByAccountId: ReadonlyMap<string, string>;
  taxYear: number;
}): QcdPrePassResult {
  const { state, rmdFloorByAccountDollars, qcdContext, ownerByAccountId, taxYear } = args;
  const entriesByOwner = new Map<string, QcdContextInput['entries'][number][]>();
  for (const e of qcdContext.entries) {
    if (taxYear < e.startYear || taxYear >= e.endYear) continue; // window inactive
    const firstEligible = qcdContext.firstEligibleYearByOwner.get(e.memberId);
    if (firstEligible === undefined || taxYear < firstEligible) continue; // pre-70½
    const list = entriesByOwner.get(e.memberId);
    if (list) list.push(e);
    else entriesByOwner.set(e.memberId, [e]);
  }
  if (entriesByOwner.size === 0) {
    return {
      totalQcdCents: 0,
      rmdOffsetCents: 0,
      grossIraPoolRmdCents: 0,
      rmdOffsetCentsByOwner: {},
      inflationFactor: 1,
    };
  }

  const inflationFactor = qcdContext.inflationFactorForYear(taxYear);
  const qcdLimitCentsForYear = qcdContext.qcdLimitCentsForYear(taxYear);
  let totalQcdCents = 0;
  let totalOffsetCents = 0;
  let totalGrossIraPoolRmdCents = 0;
  const rmdOffsetCentsByOwner: Record<string, number> = {};

  for (const [ownerId, ownerEntries] of entriesByOwner) {
    const sorted = [...ownerEntries].sort(
      (a, b) =>
        a.startYear - b.startYear || a.sourceAccountId.localeCompare(b.sourceAccountId),
    );
    // All of an owner's IRAs aggregate into one pool.
    const iraIdxs: number[] = [];
    let grossIraPoolRmdCents = 0;
    for (let a = 0; a < state.length; a += 1) {
      if (ownerByAccountId.get(state[a].id) !== ownerId) continue;
      if (!isIraAccount(state[a])) continue;
      iraIdxs.push(a);
      grossIraPoolRmdCents += Math.round((rmdFloorByAccountDollars[a] ?? 0) * 100);
    }
    totalGrossIraPoolRmdCents += grossIraPoolRmdCents;

    // The cap uses the source account's own `pre`, never a per-owner aggregate.
    const idxBySource = new Map<string, number>();
    const sourceBalancesPreTaxCents = new Map<string, number>();
    for (const e of sorted) {
      let idx = idxBySource.get(e.sourceAccountId);
      if (idx === undefined) {
        idx = state.findIndex((st) => st.id === e.sourceAccountId);
        idxBySource.set(e.sourceAccountId, idx);
      }
      if (idx < 0) {
        sourceBalancesPreTaxCents.set(e.sourceAccountId, 0);
      } else {
        sourceBalancesPreTaxCents.set(
          e.sourceAccountId,
          Math.max(0, Math.round(state[idx].pre * 100)),
        );
      }
    }

    const entriesForCompute: QcdEntryForOwnerYear[] = sorted.map((e) => ({
      sourceAccountId: e.sourceAccountId,
      annualAmountDollars: e.annualAmountDollars,
    }));
    const result = computeQcdForOwnerYear({
      entries: entriesForCompute,
      year: taxYear,
      inflationFactor,
      sourceBalancesPreTaxCents,
      grossIraPoolRmdCents,
      qcdLimitCentsForYear,
    });
    if (result.totalQcdCents <= 0) continue;

    for (const pe of result.perEntry) {
      if (pe.qcdCents <= 0) continue;
      const e = sorted[pe.entryIndex];
      const idx = idxBySource.get(e.sourceAccountId);
      if (idx === undefined || idx < 0) continue;
      state[idx].pre = Math.max(0, state[idx].pre - pe.qcdCents / 100);
    }

    let remainingOffsetCents = result.rmdOffsetCents;
    if (remainingOffsetCents > 0 && iraIdxs.length > 0) {
      const order = [...iraIdxs].sort(
        (a, b) => (rmdFloorByAccountDollars[b] ?? 0) - (rmdFloorByAccountDollars[a] ?? 0),
      );
      for (const a of order) {
        if (remainingOffsetCents <= 0) break;
        const floorCents = Math.round((rmdFloorByAccountDollars[a] ?? 0) * 100);
        if (floorCents <= 0) continue;
        const take = Math.min(remainingOffsetCents, floorCents);
        rmdFloorByAccountDollars[a] = (floorCents - take) / 100;
        remainingOffsetCents -= take;
      }
    }

    totalQcdCents += result.totalQcdCents;
    totalOffsetCents += result.rmdOffsetCents;
    // Only the owner's IRA pool floor was reduced, so the tax post-pass credits the offset to that pool,
    // never to the 401k/457/TSP/CBP pools.
    if (result.rmdOffsetCents > 0) {
      rmdOffsetCentsByOwner[ownerId] =
        (rmdOffsetCentsByOwner[ownerId] ?? 0) + result.rmdOffsetCents;
    }
  }

  return {
    totalQcdCents,
    rmdOffsetCents: totalOffsetCents,
    grossIraPoolRmdCents: totalGrossIraPoolRmdCents,
    rmdOffsetCentsByOwner,
    inflationFactor,
  };
}

/**
 * Forces a PRE_TAX (and MIXED pre-bucket) withdrawal meeting the per-account RMD floor. Only the mandatory
 * forced draw runs here, before the tax solve; the surplus disposition is `disposeRmdSurplus`.
 * The forced draw is clamped to the account's pre-bucket; a shortfall surfaces as `rmdShortfallCents` in the
 * tax post-pass.
 */
export function applyRmdFloorPrePass(args: {
  state: AccountRunState[];
  /** Per-account RMD floor in dollars; index-aligned to `state`. */
  rmdFloorByAccountDollars: ReadonlyArray<number>;
}): RmdFloorPrePassResult {
  const { state, rmdFloorByAccountDollars } = args;
  const preTaxWithdrawn: number[] = new Array(state.length).fill(0);

  let totalForced = 0;
  for (let a = 0; a < state.length; a += 1) {
    const floor = rmdFloorByAccountDollars[a] ?? 0;
    if (floor <= 0) continue;
    const drawable = Math.max(0, state[a].pre);
    const draw = Math.min(floor, drawable);
    if (draw <= 0) continue;
    state[a].pre = Math.max(0, state[a].pre - draw);
    preTaxWithdrawn[a] = draw;
    totalForced += draw;
  }

  return { preTaxWithdrawn, totalForcedPreTaxWithdrawn: totalForced };
}

/**
 * Disposes the RMD surplus after the year's tax-cashflow need is known:
 * `surplus = max(0, totalForcedPreTaxWithdrawn - netNeedDollars - taxAddedNeed)`, since in an over-RMD year
 * the forced RMD funds the tax cash itself.
 * The surplus is reinvested into the first real POST_TAX non-Roth account, else credited to the synthetic
 * carrier `RMD_OVERFLOW_CASH_ACCOUNT_ID` (pre-appended at run start); both stay in the portfolio.
 */
export function disposeRmdSurplus(args: {
  state: AccountRunState[];
  /** Total forced pre-tax withdrawal across all accounts, from the pre-pass. */
  totalForcedPreTaxWithdrawn: number;
  /** Ordinary net need this year (E - I, summed over the 12 months). */
  netNeedDollars: number;
  /** Same-year tax cashflow add-on (federal tax + IRMAA cash − ACA offset). */
  taxAddedNeed: number;
}): RmdSurplusDispositionResult {
  const { state, totalForcedPreTaxWithdrawn, netNeedDollars, taxAddedNeed } = args;
  const postTaxNonRothDeposit: number[] = new Array(state.length).fill(0);

  const surplus = Math.max(0, totalForcedPreTaxWithdrawn - netNeedDollars - taxAddedNeed);
  let reinvested = 0;
  let overflowToCash = 0;
  if (surplus > 0) {
    const targetIdx = state.findIndex(
      (st) => isPostTaxNonRoth(st) && !isRmdOverflowCashAccountId(st.id),
    );
    if (targetIdx >= 0) {
      state[targetIdx].post += surplus;
      postTaxNonRothDeposit[targetIdx] = surplus;
      reinvested = surplus;
    } else {
      const cashIdx = state.findIndex((st) => isRmdOverflowCashAccountId(st.id));
      if (cashIdx >= 0) {
        state[cashIdx].post += surplus;
        postTaxNonRothDeposit[cashIdx] = surplus;
      }
      overflowToCash = surplus;
    }
  }

  return {
    postTaxNonRothDeposit,
    reinvestedDollars: reinvested,
    overflowToCashDollars: overflowToCash,
  };
}

/**
 * Spend-first pre-step: before the strategy router draws any account, consumes the synthetic RMD-overflow
 * cash carrier toward the discretionary `target` (net need minus the RMD credit), under every strategy kind.
 * The carrier is POST_TAX cash-like, so the dollars go in the post-tax accumulators. Returns the dollars
 * drawn.
 */
export function consumeOverflowCashFirst(args: {
  state: AccountRunState[];
  target: number;
  yearWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
}): number {
  const { state, target, yearWithdrawnByAcct, yearPostWithdrawnByAcct } = args;
  if (target <= 0) return 0;
  const idx = state.findIndex((st) => isRmdOverflowCashAccountId(st.id));
  if (idx < 0) return 0;
  const available = Math.max(0, state[idx].post);
  if (available <= 0) return 0;
  const drawn = Math.min(target, available);
  state[idx].post = Math.max(0, state[idx].post - drawn);
  yearWithdrawnByAcct[idx] += drawn;
  yearPostWithdrawnByAcct[idx] += drawn;
  return drawn;
}

/**
 * Per-month medical-qualified HSA draw (pass A): draws up to `min(target, demand, available HSA balance)`
 * across `hsaIndices` in `state` order, debiting `post` and recording into both the post accumulator and
 * `medicalQualifiedByAcct` (cents reconcile via the residual rule). `demand` is in dollars. Returns the
 * dollars drawn.
 */
export function drawHsaMedical(args: {
  state: AccountRunState[];
  hsaIndices: ReadonlyArray<number>;
  /** Month's discretionary need still unmet (dollars). */
  target: number;
  /** Month's modeled medical demand (dollars). */
  demand: number;
  yearWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /** Per-account medical-qualified accumulator (dollars), index-aligned. */
  medicalQualifiedByAcct: number[];
}): number {
  const { state, hsaIndices, target, demand,
    yearWithdrawnByAcct, yearPostWithdrawnByAcct, medicalQualifiedByAcct } = args;
  let remaining = Math.min(Math.max(0, target), Math.max(0, demand));
  if (remaining <= 0) return 0;
  let drawn = 0;
  for (const a of hsaIndices) {
    if (remaining <= 0) break;
    // The medical pass is blocked at the floor only in `'strict'` mode.
    const floor = state[a].floorHsaMode === 'strict' ? floorEligibleDollars(state[a]) : 0;
    const available = floor > 0
      ? Math.max(0, state[a].post - floor)
      : Math.max(0, state[a].post);
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    state[a].post = Math.max(0, state[a].post - take);
    yearWithdrawnByAcct[a] += take;
    yearPostWithdrawnByAcct[a] += take;
    medicalQualifiedByAcct[a] += take;
    drawn += take;
    remaining -= take;
  }
  return drawn;
}

/**
 * Per-month emergency HSA draw (pass B): funds the remaining need from HSA balances only after all non-HSA
 * accounts are exhausted. These dollars are not medical-qualified (post accumulator only), so the residual
 * `committed - medicalQualified` is the emergency bucket that `hsaQualifiedMedicalExpensePct` and the 20%
 * additional tax govern. Returns the dollars drawn.
 */
export function drawHsaEmergency(args: {
  state: AccountRunState[];
  hsaIndices: ReadonlyArray<number>;
  /** Month's remaining unmet need after the ordinary router (dollars). */
  target: number;
  yearWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
}): number {
  const { state, hsaIndices, target,
    yearWithdrawnByAcct, yearPostWithdrawnByAcct } = args;
  let remaining = Math.max(0, target);
  if (remaining <= 0) return 0;
  let drawn = 0;
  for (const a of hsaIndices) {
    if (remaining <= 0) break;
    // The emergency pass is blocked at the floor in both modes, comparing against the balance after pass A.
    const floor = floorEligibleDollars(state[a]);
    const available = floor > 0
      ? Math.max(0, state[a].post - floor)
      : Math.max(0, state[a].post);
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    state[a].post = Math.max(0, state[a].post - take);
    yearWithdrawnByAcct[a] += take;
    yearPostWithdrawnByAcct[a] += take;
    drawn += take;
    remaining -= take;
  }
  return drawn;
}

/**
 * Last-resort floor-reserve draw, after every ordinary path (cash spend-first, pass A, the strategy router,
 * pass B): drains the below-floor reserve of each floor-eligible account so a depleted plan reaches $0.
 * Non-HSA reserves drain first in `tiers` order (HSA is held out even if a custom tier lists it), then HSA
 * reserves last, keeping the pre-65 20% §223(f)(4) tax a true last resort. Excluded indices are never
 * drained. Returns the dollars drawn.
 */
export function drawFloorReserve(args: {
  state: AccountRunState[];
  /**
   * Ordinary tier layout (state indices) for non-HSA reserve ordering; empty makes the non-HSA step a no-op.
   */
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  /** State indices of the floor-eligible HSA accounts to drain last, already filtered for excluded HSAs. */
  hsaIndices: ReadonlyArray<number>;
  /** State indices never drained, even as last resort. */
  excludedIndices: ReadonlySet<number>;
  /** Month's remaining unmet need after every ordinary path (dollars). */
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /**
   * Drain non-HSA reserves within each tier in listed order (customOrder) instead of balance-proportionally;
   * default false.
   */
  sequentialWithinTier?: boolean;
}): number {
  const { state, tiers, hsaIndices, excludedIndices, yearWithdrawnByAcct,
    yearPreWithdrawnByAcct, yearPostWithdrawnByAcct, sequentialWithinTier = false } = args;
  let remaining = Math.max(0, args.target);
  if (remaining <= 0) return 0;
  let totalDrawn = 0;

  const drainReserveAcct = (a: number): void => {
    if (remaining <= 0 || excludedIndices.has(a)) return;
    const acctPool = reserveDrawable(state[a]);
    if (acctPool <= 0) return;
    const share = Math.min(remaining, acctPool);
    const { preShare, postShare } = applyFloorAwareShare(state[a], share);
    yearWithdrawnByAcct[a] += share;
    yearPreWithdrawnByAcct[a] += preShare;
    yearPostWithdrawnByAcct[a] += postShare;
    totalDrawn += share;
    remaining -= share;
  };

  for (const tier of tiers) {
    if (remaining <= 0) break;
    if (sequentialWithinTier) {
      for (const a of tier) {
        if (isHsaAccount(state[a])) continue;
        drainReserveAcct(a);
      }
      continue;
    }
    let tierPool = 0;
    for (const a of tier) {
      if (excludedIndices.has(a) || isHsaAccount(state[a])) continue;
      tierPool += reserveDrawable(state[a]);
    }
    if (tierPool <= 0) continue;
    const drawn = Math.min(remaining, tierPool);
    for (const a of tier) {
      if (excludedIndices.has(a) || isHsaAccount(state[a])) continue;
      const acctPool = reserveDrawable(state[a]);
      if (acctPool <= 0) continue;
      let share = drawn * (acctPool / tierPool);
      if (share > acctPool) share = acctPool;
      const { preShare, postShare } = applyFloorAwareShare(state[a], share);
      yearWithdrawnByAcct[a] += share;
      yearPreWithdrawnByAcct[a] += preShare;
      yearPostWithdrawnByAcct[a] += postShare;
      totalDrawn += share;
    }
    remaining -= drawn;
  }

  for (const a of hsaIndices) {
    if (remaining <= 0) break;
    drainReserveAcct(a);
  }
  return totalDrawn;
}
