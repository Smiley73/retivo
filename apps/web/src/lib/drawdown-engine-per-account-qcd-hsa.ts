/**
 * QCD / RMD / HSA forced-outflow pass for the strategy-aware drawdown engine
 * (`drawdown-engine-per-account-strategy.ts`). Extracted from
 * `drawdown-engine-per-account-strategy-helpers.ts` for shape-cap compliance
 * (pure code motion; no logic change).
 *
 * Keeps the whole RMD-forced-outflow sequence — the per-owner RMD floor
 * builder plus the pass that consumes it — in one module (one financial
 * invariant: IRC §408(d)(8) / §401(a)(9) / SECURE 2.0 §325).
 *
 * Covers:
 *   - The per-owner per-account RMD floor builder
 *     (`buildPerOwnerRmdFloor`).
 *   - The 70½-gated QCD forced-outflow pass (`applyQcdPrePass`).
 *   - The RMD floor pre-pass (`applyRmdFloorPrePass`) + the post-tax-solve
 *     surplus disposition (`disposeRmdSurplus`) and the spend-first step
 *     (`consumeOverflowCashFirst`).
 *   - The HSA medical / emergency draws and the last-resort floor-reserve
 *     drain (`drawHsaMedical`, `drawHsaEmergency`, `drawFloorReserve`).
 *
 * `AccountRunState` and the shared floor/predicate helpers stay in the parent
 * helper module and are imported here (one-directional import; no cycle).
 *
 * See `docs/math-retirement-accounts.md` for the RMD and QCD rules in plain words.
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
 * Build the per-account RMD floor for the supplied calendar
 * year. Groups RMD-admissible accounts by owner (`ownerByAccountId`) and,
 * for each owner who has not yet died, calls `computeRmd` against ONLY
 * that owner's accounts. The engine consumes the current per-account
 * pre-tax sub-bucket (`state[a].pre`) — for year 0 that is `initialPre`;
 * for year y>0 it is the year-(y-1) Dec-31 sub-bucket the engine just
 * finished.
 *
 * RMD basis = the drawable pre-tax sub-bucket only. An account with NO
 * Roth-designated pocket (PRE_TAX / HSA) passes
 * `balanceDec31PriorYearCents = round(pre * 100)` with no `rothPortionCents`. An
 * account WITH one — a MIXED plan holding a designated-Roth sub-account, or a PURE
 * Roth account whose whole balance is that pocket — passes the full `round((pre +
 * post) * 100)` together with `rothPortionCents = round(post * 100)` (the post-tax
 * sub-bucket, which is exactly the part of the balance NOT pre-tax) so the RMD
 * engine subtracts the Roth-designated portion per SECURE 2.0 §325 and
 * lands on the same drawable-pre-tax basis.
 *
 * When the household records RMD profile facts, the SAME shared fact-based
 * engine that produces the tax floor and the report disclosures also sizes this
 * forced draw — the account's `facts` and the owner's separation year are passed
 * straight through to `computeRmd`. A money-moving pass on the legacy
 * owner/Uniform-Lifetime branch would contradict its own disclosure:
 * a still-working-deferred plan would be force-withdrawn (and taxed) in a year the
 * report said the withdrawal was postponed, and an inherited account would be
 * force-drawn at the beneficiary's own Uniform Lifetime divisor — or not at all
 * while the beneficiary was below their own trigger age — against a required
 * amount the shortfall flag is measuring.
 *
 * DISCLOSED LIMITATION: the forced pass can debit only the pre-tax
 * sub-bucket, so an inherited account whose balance is entirely Roth (an
 * inherited Roth IRA, or a pure designated-Roth employer plan) has a $0 drawable
 * base here and is never force-drawn, even though the beneficiary really does owe
 * a post-death distribution on it.
 *
 * Returns an array aligned with `state` (zero for non-admissible / non-owned /
 * pre-trigger / withheld / deferred accounts).
 */
export function buildPerOwnerRmdFloor(args: {
  readonly taxYear: number;
  readonly state: ReadonlyArray<AccountRunState>;
  readonly rmdContext: RmdContextInput;
  /**
   * Each account's Dec-31 sub-buckets TWO years before `taxYear`, index-
   * aligned to `state`. Sizes a first-year-deferral catch-up ("two RMDs in one
   * year") from the trigger year's own base; absent → the engine reports the
   * catch-up as a blocker rather than guessing it. The caller supplies it
   * only once the run is two years in AND facts are recorded. Dollars, same
   * units as `AccountRunState.pre` / `.post`.
   */
  readonly twoYearsPriorDollars?: ReadonlyArray<{ readonly pre: number; readonly post: number }>;
}): number[] {
  const { taxYear, state, rmdContext, twoYearsPriorDollars } = args;
  const floors = new Array<number>(state.length).fill(0);
  const factsById = rmdContext.rmdFactsByAccountId;

  // Group qualifying account indices by owner.
  const indicesByOwner = new Map<string, number[]>();
  for (let a = 0; a < state.length; a += 1) {
    const st = state[a];
    const ownerId = rmdContext.ownerByAccountId.get(st.id);
    if (!ownerId) continue;
    const accType = st.accountType as RmdAccountType;
    // An INHERITED account is subject to BENEFICIARY rules even when the
    // living-owner test rejects its type, so admission follows the same
    // inherited-aware gate the tax floor and the MC surfaces use
    // (`isInheritedRmdSubjectType`). `resolveRmdRule` inside the shared engine
    // owns the actual rule; this only decides admission.
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
    // Death = Dec 31 of `deathYear`; the owner is alive through all of
    // `deathYear`, so the RMD floor (and its tax) still applies in the
    // death year and stops only after it.
    if (taxYear > meta.deathYear) continue;
    const birthYear = parseInt(meta.isoBirthdate.slice(0, 4), 10);
    const ownerAge = ageInTaxYear(meta.isoBirthdate, taxYear);
    // The owner-level trigger-age short-circuit is a shortcut for the LEGACY
    // branch only. Once any of this owner's accounts carries facts, `computeRmd`
    // takes its fact-based branch, which re-applies the same trigger-age gate
    // PER ACCOUNT for owner-path accounts and correctly does NOT apply it to an
    // inherited account (a beneficiary obligation the beneficiary's own age
    // never gates). Short-circuiting here would silently drop that.
    const ownerHasFacts = accountIdxs.some((a) => factsById?.[state[a].id] !== undefined);
    if (!ownerHasFacts && ownerAge < rmdTriggerAge(birthYear)) continue;

    const ownerAccounts: RmdAccountInput[] = accountIdxs.map((a) => {
      const st = state[a];
      // RMD basis = the account's DRAWABLE pre-tax sub-bucket only. The
      // forced RMD withdrawal can draw only from `st.pre`, so the floor must be
      // built on `st.pre` alone — counting `st.post` would inflate the floor and
      // manufacture a false shortfall the engine can never satisfy. This is the
      // single uniform rule for every qualifying account type; the MIXED
      // Roth-portion subtraction below is one instance of it. (A non-MIXED
      // PRE_TAX `post` bucket is a deposit artifact — initial post = 0 — never
      // real after-tax IRA basis, so excluding it is correct.)
      //
      // This is deliberately NOT the Monte Carlo representative assembler's
      // whole-balance convention (`buildMcRmdAccountInput`): that surface only
      // DISPLAYS a floor, while this one has to be satisfiable by a pass that can
      // debit `st.pre` and nothing else.
      const facts = factsById?.[st.id];
      const twoYearsPrior = twoYearsPriorDollars?.[a];
      const baseInput: RmdAccountInput = {
        id: st.id,
        balanceDec31PriorYearCents: Math.round(st.pre * 100),
        accountType: st.accountType as RmdAccountType,
        taxTreatment: st.taxTreatment,
        ...(facts !== undefined ? { facts } : {}),
        // The catch-up base follows the SAME drawable-pre-tax convention as the
        // current-year base above, so a deferred first-year amount is sized on
        // exactly the bucket the forced draw can debit.
        ...(twoYearsPrior !== undefined
          ? { balanceDec31TwoYearsPriorCents: Math.round(twoYearsPrior.pre * 100) }
          : {}),
      };
      // An account with a Roth-designated pocket (a MIXED plan's designated-Roth
      // sub-account, or a PURE Roth account whose whole balance is that pocket)
      // passes the full balance with the pocket declared through the engine's own
      // shared `rmdDeclaredRothPortionCents`: the engine subtracts the
      // Roth-designated slice (SECURE 2.0 §325), leaving exactly `pre` as the basis
      // for a MIXED plan and $0 for a pure Roth account — the same
      // drawable-pre-tax result as the no-Roth-pocket branch above, just routed
      // through the §325 exclusion the RMD engine already implements. Using the
      // shared declaration keeps this producer's base identical to the
      // deterministic snapshot builder's and both MC producers' for the same
      // account.
      // It does NOT receive §408A contribution-first ordering: designated-Roth
      // pre-59½ treatment is the deferred / conservatively-approximated path
      // (Pub 575 cost-recovery, not §408A) — §408A ordering is
      // `RETIREMENT_ROTH_IRA`-only.
      const priorCents = Math.round((st.pre + st.post) * 100);
      const rothPortionCents = rmdDeclaredRothPortionCents(
        st.taxTreatment,
        priorCents,
        Math.round(st.post * 100),
      );
      // PRE_TAX / HSA declare no pocket and keep the pre-only base input. HSA-TYPE
      // accounts never reach here (RMD-exempt — BOTH admission predicates exclude
      // the type, inherited or not).
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
        // The §401(a)(9)(C) later-of first-distribution year needs the
        // owner's separation year; absent → the affected account WITHHOLDS
        // rather than assuming the trigger-age year.
        ...(retirementYear !== undefined ? { retirementYear } : {}),
      },
      rmdContext.rmdSnapshot,
    );
    if (!result.applicable) continue;

    // Distribute the per-account RMD floor back into the engine-index
    // aligned array. `perAccountRmdCents` is keyed by account id.
    for (const a of accountIdxs) {
      const cents = result.perAccountRmdCents[state[a].id] ?? 0;
      if (cents > 0) floors[a] = cents / 100;
    }
    // Defensive consistency: per-account sum may differ from owner total
    // by ≤ 1 cent (allocateProportional largest-remainder rounding);
    // engine forces only the per-account floor, owner total is the sum
    // of `floors[accountIdxs]`.
  }
  return floors;
}

// ---------------------------------------------------------------------------
// QCD forced-outflow pass — Qualified Charitable
// Distributions. Gated on the 70½ floor only, INDEPENDENT of the RMD trigger
// age (a 70½–72 owner has a QCD but no RMD floor).
// ---------------------------------------------------------------------------

/** Per-year QCD outcome for one household (both owners merged). */
export interface QcdPrePassResult {
  /** Total QCD directed across both owners this year, integer cents. */
  readonly totalQcdCents: number;
  /** Total QCD that offset an IRA-pool RMD floor, integer cents. */
  readonly rmdOffsetCents: number;
  /** Gross IRA-pool RMD floor across both owners BEFORE the QCD offset, integer
   *  cents — the basis for `netTaxableRmdCents = gross − offset` display. */
  readonly grossIraPoolRmdCents: number;
  /** Per-OWNER QCD RMD offset (integer cents, `min(Q_owner, grossIraPoolRmd_owner)`),
   *  keyed by owner id. The tax post-pass credits each owner's offset toward
   *  that owner's IRA aggregation pool when computing the RMD shortfall, so the
   *  QCD that satisfied the IRA RMD (IRC §408(d)(8)) never surfaces as a phantom
   *  missed RMD. Empty when no QCD offset applied. */
  readonly rmdOffsetCentsByOwner: Readonly<Record<string, number>>;
  /** The EXACT cumulative inflation factor (base = the projection's base year)
   *  this pass used to inflate the REAL annual QCD amount to nominal for the year
   *  (`qcdContext.inflationFactorForYear(taxYear)`). Both engines anchor at the
   *  year END: deterministic uses the December `inflationFactorAt` factor,
   *  Monte Carlo the path's year-END `cumCpi` — whichever the active engine fed.
   *  Stamped on the row as `qcdInflationFactor` so the today's-dollars display
   *  reverses the gift EXACTLY (`qcdCents ÷ factor` → the configured REAL
   *  amount, uncapped). 1 in a no-QCD/zero-inflation year. */
  readonly inflationFactor: number;
}

/** True for the QCD source-account type — a traditional IRA. The resolver
 *  already guarantees PRE_TAX treatment + owner equality; the engine
 *  re-checks the type only to scope the IRA-pool RMD offset. */
function isIraAccount(st: AccountRunState): boolean {
  return st.accountType === 'RETIREMENT_IRA';
}

/**
 * Run the 70½-gated QCD forced-outflow pass for one projection year.
 * Per owner, for each active entry (window `startYear ≤ taxYear < endYear`,
 * owner past their 70½ first-eligible year):
 *   1. cap `Q = min(inflated REAL amount, remaining per-person limit, source IRA
 *      prior-year-end pre-tax balance)` in integer cents, the per-person limit
 *      consumed once across the owner's entries — via
 *      `computeQcdForOwnerYear`;
 *   2. DEBIT the source IRA's pre-tax sub-bucket by `Q` first-dollars (the gift
 *      leaves the portfolio exactly once);
 *   3. reduce ONLY that owner's IRA-pool RMD floor (the `RETIREMENT_IRA`
 *      accounts in `rmdFloorByAccountDollars`) by `rmdOffsetCents = min(Q,
 *      grossIraPoolRmd)`, distributed across the pool accounts largest-
 *      balance-first so a per-account floor never goes negative.
 *
 * MUTATES `state[*].pre` (the debit) and `rmdFloorByAccountDollars` (the offset)
 * in place, and runs BEFORE `applyRmdFloorPrePass` so the forced TAXABLE RMD is
 * `gross − min(Q, gross)`. The donated dollars are NOT part of the forced
 * draw, so they never become reinvested RMD surplus and never fund net need.
 *
 * The IRA-pool RMD basis uses the owner's IRA accounts only; the QCD cap
 * uses the SOURCE IRA account's own prior-year-end pre-tax balance, never
 * a per-owner aggregate, so a depleted source clamps `Q = 0`.
 */
export function applyQcdPrePass(args: {
  state: AccountRunState[];
  /** Per-account RMD floor in dollars; index-aligned to `state`. MUTATED: the
   *  owner's IRA-pool entries are reduced by the QCD offset. */
  rmdFloorByAccountDollars: number[];
  qcdContext: QcdContextInput;
  ownerByAccountId: ReadonlyMap<string, string>;
  taxYear: number;
}): QcdPrePassResult {
  const { state, rmdFloorByAccountDollars, qcdContext, ownerByAccountId, taxYear } = args;
  // Group active entries by owner (the directing member = source account owner).
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
    // Stable order: start year then accountId.
    const sorted = [...ownerEntries].sort(
      (a, b) =>
        a.startYear - b.startYear || a.sourceAccountId.localeCompare(b.sourceAccountId),
    );
    // The owner's IRA-pool RMD floor: sum the floors over this owner's
    // RETIREMENT_IRA accounts (all of an owner's IRAs aggregate into one pool).
    const iraIdxs: number[] = [];
    let grossIraPoolRmdCents = 0;
    for (let a = 0; a < state.length; a += 1) {
      if (ownerByAccountId.get(state[a].id) !== ownerId) continue;
      if (!isIraAccount(state[a])) continue;
      iraIdxs.push(a);
      grossIraPoolRmdCents += Math.round((rmdFloorByAccountDollars[a] ?? 0) * 100);
    }
    totalGrossIraPoolRmdCents += grossIraPoolRmdCents;

    // Source IRA prior-year-end pre-tax balance per source account — the
    // SOURCE account's own `pre`, never a per-owner aggregate.
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

    // (2) DEBIT each source IRA's pre-tax sub-bucket by the resolved Q.
    for (const pe of result.perEntry) {
      if (pe.qcdCents <= 0) continue;
      const e = sorted[pe.entryIndex];
      const idx = idxBySource.get(e.sourceAccountId);
      if (idx === undefined || idx < 0) continue;
      state[idx].pre = Math.max(0, state[idx].pre - pe.qcdCents / 100);
    }

    // (3) Reduce ONLY this owner's IRA-pool RMD floor by the offset,
    // distributed across the pool accounts in descending floor order so no
    // per-account floor goes negative.
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
    // Record the owner-scoped offset so the tax post-pass can credit it
    // toward this owner's IRA aggregation pool (never the 401k/457/TSP/CBP
    // pools — the offset reduced only the owner's IRA pool floor).
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
 * Force a PRE_TAX (+ MIXED-preTax-bucket) withdrawal that meets the
 * per-account RMD floor (built per owner and per qualifying account, not a
 * single household floor split proportionally across every PRE_TAX/MIXED
 * account regardless of owner or qualification).
 *
 * This pre-pass performs ONLY the mandatory forced draw (it determines the
 * year's taxable income and so MUST run before the tax-cashflow solve). The
 * surplus DISPOSITION (reinvest into a real taxable account or credit the
 * synthetic cash carrier) is computed separately by `disposeRmdSurplus`
 * AFTER the tax solve, so the tax portion of the forced RMD is funded out of
 * the portfolio rather than reinvested back into it.
 *
 * Per-account forced draw is clamped to the account's actual pre-bucket; any
 * shortfall is the household's problem (surfaces via `rmdShortfallCents` in
 * the tax post-pass, which compares the total floor against actual pre-tax
 * withdrawals).
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
 * Dispose the RMD surplus AFTER the year's tax-cashflow need is known.
 *
 * The surplus retained in the portfolio is the forced pre-tax withdrawal less
 * BOTH the ordinary net need AND the same-year tax cashflow add-on:
 *   `surplus = max(0, totalForcedPreTaxWithdrawn − netNeedDollars − taxAddedNeed)`.
 * The tax portion is excluded because in an over-RMD year the monthly loop's
 * RMD credit drives `monthTargetGross → 0`, so the tax cash is funded out of
 * the forced RMD itself — reinvesting it back into the portfolio overstated the
 * ending balance and the surplus tiles by `min(taxAddedNeed, surplus)`.
 *
 * The retained surplus is REINVESTED:
 *   - into the first REAL POST_TAX-non-Roth account if one exists
 *     (`reinvestedDollars`); else
 *   - CREDITED to the already-existing synthetic cash-like carrier
 *     (`RMD_OVERFLOW_CASH_ACCOUNT_ID`), surfacing as `overflowToCashDollars`
 *     and PRESERVED in the balance.
 *
 * This function ONLY credits the synthetic carrier (it never creates it).
 * The carrier is pre-appended to `state[]` once at run START by
 * `runYearByYearStrategyAware`, so it is always present here; the disposition
 * split distinguishes "landed in a real taxable account" from "landed in the
 * synthetic carrier" for display only — both stay in the portfolio.
 */
export function disposeRmdSurplus(args: {
  state: AccountRunState[];
  /** Total forced pre-tax withdrawal across all accounts (from the pre-pass). */
  totalForcedPreTaxWithdrawn: number;
  /** Ordinary net need this year (E − I, summed over the 12 months). */
  netNeedDollars: number;
  /** Same-year tax cashflow add-on (federal tax + IRMAA cash − ACA offset). */
  taxAddedNeed: number;
}): RmdSurplusDispositionResult {
  const { state, totalForcedPreTaxWithdrawn, netNeedDollars, taxAddedNeed } = args;
  const postTaxNonRothDeposit: number[] = new Array(state.length).fill(0);

  // Surplus = forced RMD beyond BOTH ordinary need AND the tax cashflow add-on
  // The tax cash is drawn from the forced RMD in an over-RMD year, so
  // only the remainder is reinvested / held — never the tax dollars.
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
      // The carrier is pre-appended at run start, so `cashIdx >= 0`
      // whenever no real POST_TAX-non-Roth account exists. The surplus surfaces
      // as held-as-cash regardless (preserved either way).
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
 * Universal spend-first pre-step. BEFORE the strategy router draws any
 * account, consume the synthetic RMD-overflow cash carrier to meet the year's
 * discretionary net need (the portion not already covered by the forced RMD).
 * Strategy-agnostic — guarantees the held-as-cash surplus is spent before
 * tapping pre-tax again under EVERY strategy kind (taxEfficient / rothFirst / proportional /
 * customOrder / cap), reducing this year's discretionary pre-tax draw. The
 * carrier is POST_TAX cash-like (return-of-principal, tax-free), so
 * the consumed dollars are recorded in the post-tax withdrawal accumulators.
 *
 * `target` is the discretionary dollars still needed this period (net need
 * minus the RMD credit). Returns the dollars drawn from the carrier (≤ target,
 * ≤ carrier balance). Mutates `state[carrier].post` and the accumulators.
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
 * Per-month medical-qualified HSA draw (pass A). Draws up to
 * `min(target, demand, available HSA balance)` across the HSA accounts in
 * `hsaIndices`, sequentially (stable order = `state` order). Each HSA account
 * is cash-like (its balance lives entirely in `post`), so the draw debits
 * `post` and records into BOTH the post-withdrawal accumulator AND the
 * per-account `medicalQualifiedByAcct` accumulator (cents reconcile via the
 * residual rule). Returns the dollars drawn (≤ target, ≤ demand).
 *
 * Fires only when a positive portfolio need exists (the caller passes the
 * month's discretionary `target`), so surplus-income years leave HSA untouched.
 * `demand` is the month's medical demand in DOLLARS (the cents series is
 * converted by the caller).
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
    // The medical pass (PASS A) is blocked at the
    // floor ONLY in `'strict'` mode; in `'emergencyOnly'` (default) medical
    // draws may go below the floor. `floorEligibleDollars` already returns 0 for
    // an unfloored / ineligible account, so the no-floor path is unchanged.
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
 * Per-month emergency HSA draw (pass B). Funds the month's REMAINING need
 * from HSA balances ONLY after all non-HSA accounts are exhausted (the ordinary
 * router already ran and returned less than `target`). Drained sequentially in
 * `state` order. These dollars are NOT medical-qualified — recorded only in the
 * post-withdrawal accumulator, so the residual (`committed − medicalQualified`)
 * is the emergency/nonmedical bucket the `hsaQualifiedMedicalExpensePct` + the
 * 20% additional tax govern. Returns the dollars drawn.
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
    // The emergency pass (PASS B) is blocked at the
    // floor in BOTH modes — `floorEligibleDollars` reads the floor for any
    // floored HSA. It runs AFTER the medical pass, so `state[a].post` is the
    // POST-PASS-A balance (the floor comparison reads the post-PASS-A balance).
    // No floor / ineligible → 0, so the unfloored path is unchanged.
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
 * Per-month LAST-RESORT floor-reserve draw. Runs AFTER every ordinary funding path is exhausted — the synthetic-cash
 * spend-first, the HSA medical pass (PASS A), the ordinary/cap-aware strategy
 * router, AND the HSA emergency pass (PASS B) — as the true last resort when
 * unmet need still remains. It drains the protected reserve (the below-floor
 * balance the ordinary path left) of each floor-eligible account so a genuinely
 * depleted plan reaches $0 instead of stranding cash behind a floor.
 *
 * Order (mirrors the account's ordinary reserve role):
 *   1. Non-HSA floored reserves, following `tiers` (the SAME ordinary tier
 *      layout — prebuilt preset tiers or the caller's custom tiers), so a
 *      POST_TAX floor reserve in an earlier tier drains before a later one.
 *      Within a tier the split is sequential (customOrder) or balance-
 *      proportional across the eligible reserves (preset / proportional).
 *      HSA-treatment accounts are held out of this phase even when a
 *      customOrder tier lists their state index (`buildCustomTierIndices`
 *      maps user tiers to indices with no type filter) — an HSA's reserve
 *      never drains here, only in step 2.
 *   2. HSA floored reserves LAST (`hsaIndices`), after all non-HSA reserves —
 *      matching the HSA's existing reserve-after-everything role. This keeps
 *      the pre-65 20% §223(f)(4) additional-tax hit a genuine last resort,
 *      after every non-HSA reserve (including later-tier POST_TAX) is spent.
 *
 * HSA reserve draws are recorded ONLY in the withdrawn + post accumulators, NOT
 * `medicalQualifiedByAcct`, so the residual rule (`withdrawn − medicalQualified`)
 * classifies them as emergency/nonmedical dollars — nonqualified ordinary income
 * + the pre-65 20% §223(f)(4) additional tax, reusing the existing HSA-emergency
 * tax path, no new tax rule.
 *
 * Excluded indices are NEVER drained, even as last resort: a custom-order
 * `excludedAccountIds` opt-out is stronger than a floor. Ineligible accounts
 * (PRE_TAX / MIXED / ROTH) have `reserveDrawable === 0` and stay untouched.
 *
 * Returns the dollars drawn (≤ target, ≤ total reserve balance).
 */
export function drawFloorReserve(args: {
  state: AccountRunState[];
  /** Ordinary tier layout (state indices) for non-HSA reserve ordering. Preset
   *  prebuilt tiers, the caller's custom tiers, or the single proportional tier.
   *  HSA is held out of these (drawn via `hsaIndices`); empty ⇒ non-HSA step is
   *  a no-op. */
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  /** State indices of the floor-eligible HSA accounts to drain LAST (already
   *  filtered for excluded HSAs by the caller). */
  hsaIndices: ReadonlyArray<number>;
  /** State indices never drained, even as last resort. */
  excludedIndices: ReadonlySet<number>;
  /** Month's remaining unmet need after every ordinary path (dollars). */
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /** Drain non-HSA reserves within each tier in listed order (customOrder)
   *  instead of balance-proportional. Defaults to false. */
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

  // (1) Non-HSA floored reserves in ordinary tier order. HSA-treatment accounts
  // are held out of phase 1 even when a custom tier lists their state index —
  // their reserves drain only in phase 2 (`hsaIndices`), so a non-HSA reserve
  // draw never defers behind an HSA's pre-65 §223(f)(4)-taxed reserve.
  for (const tier of tiers) {
    if (remaining <= 0) break;
    if (sequentialWithinTier) {
      for (const a of tier) {
        if (isHsaAccount(state[a])) continue;
        drainReserveAcct(a);
      }
      continue;
    }
    // Balance-proportional split across the tier's eligible non-HSA reserves.
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

  // (2) HSA floored reserves LAST (emergency/nonmedical — never medical-qualified).
  for (const a of hsaIndices) {
    if (remaining <= 0) break;
    drainReserveAcct(a);
  }
  return totalDrawn;
}
