/**
 * Strategy-aware year-by-year drawdown path extracted from
 * `drawdown-engine-per-account.ts` to keep each file under the 400-line
 * shape cap. Consumed only by `simulatePerAccountMonthly` in the parent
 * module; not part of the public drawdown-engine surface.
 *
 * The RMD floor is computed INSIDE the year loop using
 * each owner's current per-account balances (year-0 uses initial ledger
 * balances; year y>0 uses the year-(y-1) Dec-31 sub-bucket the engine
 * just finished). The per-account floor is enforced per-owner against
 * only that owner's qualifying accounts.
 *
 * Per-account `preWithdrawnCents` / `postWithdrawnCents` surface
 * on `DrawdownAccountYear` so the tax post-pass can route MIXED
 * withdrawals correctly.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it
 * is the per-account strategy-aware year loop — the per-run tier prebuild
 * (`prebuiltTiers`) sits on the SAME per-run precompute seam as this file's
 * existing per-year RMD-floor work, so peeling it out would split one cohesive
 * per-run loop for no boundary gain. Trigger: a change adding 5 or more lines
 * here must either refactor the file back under the limit or re-justify this
 * exception in this note.
 */
import { monthlyEquivalent } from './projection-engine/monthly-conversion';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import type {
  DrawdownAccountInput,
  DrawdownAccountYear,
  DrawdownYear,
  DrawdownInput,
  QcdContextInput,
  RmdContextInput,
} from './drawdown-engine-types';
import {
  buildStrategyTiers,
  distributeWithdrawalByStrategy,
  hsaStateIndices,
  isPostTaxNonRoth,
  isRmdOverflowCashAccountId,
  selectActiveMagiCapWindow,
  RMD_OVERFLOW_CASH_ACCOUNT_ID,
  type AccountRunState,
  type MagiCapRuntimeConfig,
  type MagiCapWindowRuntime,
  type RmdFloorPrePassResult,
  type RmdSurplusDispositionResult,
  type StrategyAwareKind,
} from './drawdown-engine-per-account-strategy-helpers';
import {
  applyQcdPrePass,
  applyRmdFloorPrePass,
  buildPerOwnerRmdFloor,
  consumeOverflowCashFirst,
  disposeRmdSurplus,
  drawFloorReserve,
  drawHsaEmergency,
  drawHsaMedical,
  type QcdPrePassResult,
} from './drawdown-engine-per-account-qcd-hsa';
import type {
  TaxCashflowHook,
  TaxCashflowYearClassification,
  TaxCashflowYearOutcome,
} from './drawdown-engine-types';
import {
  classifyTrialYearDraw,
  distributeWithdrawalByCustomTiersWithCap,
  sumYearWindow,
  applyMonthlyDeposits,
  applyMonthlyGrowth,
  type TrialWithinYearInputs,
} from './drawdown-engine-per-account-strategy-cap';
import { applyRothConversionFill } from './drawdown-engine-roth-conversion';
import {
  fundedRatio,
  applyGuardrailStep,
  initGuardrailState,
  type GuardrailConfig,
  type GuardrailPathState,
} from './guardrails';

/**
 * Per-path downturn-guardrail runtime context threaded
 * into `runYearByYearStrategyAware`. Present only on a Monte Carlo named-
 * strategy path with an ENABLED config; absent everywhere else.
 *
 * The engine fires the guardrail once per drawdown year at the year-START
 * (pre-withdrawal) pool: it computes the funded ratio from the currently-
 * settled spend path, steps the settled spend factor via `applyGuardrailStep`,
 * then SCALES that year's 12 `expense` months in place by the resulting factor.
 * The scaled expense flows through the whole year (RMD/tax solve + monthly
 * withdrawal) so BOTH tax passes see the same guardrail-adjusted spending
 * — the caller runs the guardrail on pass 1 only, leaving the already-
 * scaled shared `expense` array for pass 2 (no re-evaluation).
 *
 * All REAL series are today's-dollar, index 0 = the first drawdown year, length
 * = the drawdown-year count.
 */
export interface GuardrailRuntimeContext {
  readonly config: GuardrailConfig;
  /** REAL total spending on the 100% baseline path, per drawdown year. */
  readonly baselineTotalRealByYear: readonly number[];
  /** REAL net spending need (total − guaranteed income) on the baseline
   *  path, per drawdown year. */
  readonly baselineNetNeedRealByYear: readonly number[];
  /** REAL essential-only spending on the baseline path, per drawdown year —
   *  the per-year cut floor. */
  readonly essentialRealByYear: readonly number[];
  /** Cumulative CPI factor at the START of each drawdown year (this path's
   *  own sampled CPI), index 0 = first drawdown year. Deflates the nominal
   *  year-start pool to today's dollars. */
  readonly cumCpiAtYearStart: readonly number[];
  /** Effective-tax gross-up fraction for the funded-ratio liability. */
  readonly effectiveTaxRate: number;
  /** Mutable per-year output: the settled spend factor the guardrail applied
   *  to each year (index 0 = first drawdown year). Filled by the engine on the
   *  pass it evaluates; length = drawdown-year count. */
  readonly appliedFactorByYear: number[];
}

/** Stamp the tax-cashflow diagnostic fields onto a year row. */
function stampTaxCashflowRow(row: DrawdownYear, outcome: TaxCashflowYearOutcome): void {
  row.federalTaxCashNeedCents = outcome.federalTaxCashNeedCents;
  row.irmaaWithheldFromSsCents = outcome.irmaaWithheldFromSsCents;
  row.irmaaCashNeedCents = outcome.irmaaCashNeedCents;
  row.acaPtcCashflowOffsetCents = outcome.acaPtcCashflowOffsetCents;
  row.acaCreditAppliedToPremiumsCents = outcome.acaCreditAppliedToPremiumsCents;
  row.totalTaxCashflowNeedCents = outcome.totalTaxCashflowNeedCents;
  row.taxCashflowIterations = outcome.taxCashflowIterations;
  row.taxCashflowConverged = outcome.taxCashflowConverged;
  row.taxCashflowShortfallCents = outcome.taxCashflowShortfallCents;
}

export type {  MagiCapRuntimeConfig,   } from './drawdown-engine-per-account-strategy-helpers';

/** Read a monthly cashflow series into a typed buffer of length `stepCount`.
 *  Exported for unit testing the fast path — not part of the module's
 *  public API. */
export function readSeriesIntoBuffer(series: MonthlyCashflowSeries, stepCount: number): Float64Array {
  // An exact-length `Float64Array` is already the buffer we would
  // build — return it directly (no defensive copy). Verified safe: the resulting
  // `state.deposits` / `state.depositsPost` are only ever READ downstream
  // (`applyMonthlyDeposits`, drawdown-engine-per-account-strategy-cap.ts), never
  // written, and the MC caller's per-path buffers are private. A shorter (or
  // non-typed) array still zero-pads via the copy path below.
  if (series.values instanceof Float64Array && series.values.length === stepCount) {
    return series.values;
  }
  const out = new Float64Array(stepCount);
  for (let i = 0; i < stepCount; i += 1) {
    if (i < series.values.length) out[i] = series.values[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunYearByYearArgs {
  readonly input: DrawdownInput;
  readonly yearCount: number;
  readonly accountsIn: ReadonlyArray<DrawdownAccountInput>;
  readonly expense: Float64Array;
  readonly income: Float64Array;
  readonly householdDeposit: Float64Array;
  /** Strategy kind for the year-by-year path. `proportional` distributes
   *  proportional-to-balance across all accounts (single tier); others use
   *  tax-class priority ordering. */
  readonly strategyKind: StrategyAwareKind;
  /** Per-account RMD context. When undefined the engine skips RMD
   *  enforcement entirely (legacy behaviour for callers that haven't
   *  threaded it yet). */
  readonly rmdContext?: RmdContextInput;
  /** Per-owner QCD context. When supplied, the engine runs the
   *  70½-gated forced-outflow pass each year before the RMD floor pre-pass. */
  readonly qcdContext?: QcdContextInput;
  /** Pre-built custom-order tier arrays (state indices). Required when
   *  `strategyKind === 'customOrder'`. Tier[0] drained first. */
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  /** Excluded account state indices for the custom-order path. */
  readonly excludedIndices?: ReadonlySet<number>;
  /** MAGI-cap WINDOW SCHEDULE. When supplied,
   *  the engine selects ≤ 1 active window per projection year
   *  (`selectActiveMagiCapWindow`) and enforces that window's per-year pre-tax
   *  withdrawal cap with skip-ahead routing. A gap year is cap-off. Active for
   *  both strategy-based AND custom-order paths. */
  readonly magiCapWindows?: ReadonlyArray<MagiCapWindowRuntime>;
  /** Per-year tax-cashflow hook. When supplied, each year's net
   *  withdrawal target is raised by the solver's tax cashflow need. */
  readonly taxCashflow?: TaxCashflowHook;
  /** Downturn-guardrail runtime context. When supplied AND
   *  `config.enabled`, the engine fires the funded-ratio spending guardrail at
   *  each year-START boundary and SCALES that year's `expense` months in place.
   *  Absent / disabled → no guardrail. Supplied on the pass that EVALUATES the
   *  factor (tax pass 1); the caller reuses the already-scaled `expense` for
   *  pass 2. */
  readonly guardrail?: GuardrailRuntimeContext;
}

interface YearStepArgs {
  readonly y: number;
  readonly state: AccountRunState[];
  readonly yearCount: number;
  readonly expense: Float64Array;
  readonly income: Float64Array;
  readonly householdDeposit: Float64Array;
  readonly strategyKind: StrategyAwareKind;
  /** Per-account RMD floor in dollars. Index aligned with `state`.
   *  Zero entries skip the per-account forced draw. */
  readonly rmdFloorByAccountDollars: number[];
  readonly perMonthWithdrawal: Float64Array;
  readonly retirementYear: number;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  /** The per-year ACTIVE window's runtime config, selected from the schedule
   *  by `selectActiveMagiCapWindow(calendarYear)`. `undefined` in a gap year
   *  (cap off) or when no schedule was supplied. */
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  readonly taxCashflow?: TaxCashflowHook;
  /** State indices of the HSA-treatment accounts. The year loop runs
   *  the medical + emergency two-pass HSA routing against these; the ordinary
   *  router never touches them (`buildStrategyTiers` holds HSA out). */
  readonly hsaIndices: ReadonlyArray<number>;
  /** Per-month HSA-qualified medical demand in DOLLARS. Sub-slice of
   *  the same projection that built `expense`; aligned to the run step domain.
   *  Empty / absent ⇒ 0 every month (medical pass is a no-op). */
  readonly medicalDemand: Float64Array;
  /** QCD pre-pass outcome for the year. Already debited the gift from
   *  the source IRA + reduced the IRA-pool RMD floor before this step ran;
   *  carried here only to stamp `qcdCents` / `netTaxableRmdCents` on the row.
   *  Undefined → no QCD context. */
  readonly qcdResult?: QcdPrePassResult;
  /** Tiers built ONCE per `runYearByYearStrategyAware` call
   *  (never for `customOrder`). Both per-month consumers (the cap-active
   *  preset branch below, `distributeWithdrawalByStrategy`) fall back to
   *  building when absent, so non-MC / pre-feature callers are unchanged. */
  readonly prebuiltTiers?: ReadonlyArray<ReadonlyArray<number>>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Year-by-year per-account drawdown that respects withdrawal-order
 * strategy and (when `rmdContext` supplied) the per-owner RMD floor.
 *
 * Algorithm per year:
 *   1. Compute the per-account RMD floor from each qualifying
 *      account's pre-tax sub-bucket entering the year. Year-0 uses
 *      `accountsIn[*].initialPre/initialPost`; year y>0 uses the
 *      year-(y-1) Dec-31 sub-bucket carried in `state[a].pre/post`.
 *   2. Apply RMD floor pre-pass: force withdrawals from the owner's
 *      qualifying PRE_TAX + MIXED-preTax accounts; surplus (when forced
 *      > net need) credits the first POST_TAX-non-Roth account.
 *   3. For each month: apply deposits, grow accounts, withdraw remaining
 *      monthly net need in strategy-priority order.
 *   4. Year-end: capture per-account balances + pre/post split totals.
 */
export function runYearByYearStrategyAware(args: RunYearByYearArgs): {
  years: DrawdownYear[];
  depletionYear: number | null;
  perMonthWithdrawal: Float64Array;
} {
  const { input, yearCount, accountsIn, expense, income, householdDeposit, strategyKind,
    customTiers, excludedIndices, magiCapWindows, taxCashflow, qcdContext } = args;
  const stepCount = yearCount * 12;

  // Per-account running state — separate pre/post buckets per account.
  const state: AccountRunState[] = accountsIn.map((a) => ({
    id: a.id,
    pre: a.initialPre,
    post: a.initialPost,
    annualRatePct: a.annualRatePct,
    monthlyRate: monthlyEquivalent(a.annualRatePct),
    taxTreatment: a.taxTreatment,
    accountType: a.accountType,
    deposits: readSeriesIntoBuffer(a.depositsByMonth, stepCount),
    // The post-primary spouse contribution's designated-Roth slice routes
    // to `post` regardless of treatment. Absent on callers with no split.
    depositsPost: a.depositsPostByMonth
      ? readSeriesIntoBuffer(a.depositsPostByMonth, stepCount)
      : new Float64Array(stepCount),
    // Carry the MC per-month return series onto run state
    // so `applyMonthlyGrowth(state, i)` grows on the path's sampled returns.
    // Absent on the deterministic/optimizer path → scalar-rate growth.
    returnPctByMonth: a.returnPctByMonth,
    // Carry the per-account floor + HSA mode
    // onto run state. Eligibility (taxTreatment ∈ {POST_TAX, HSA}) is enforced
    // by the `floorEligibleDollars` read point, so an entry on an ineligible
    // account is inert. Absent → no floor.
    floorDollars: a.floorDollars,
    floorHsaMode: a.floorHsaMode,
    // The inherited marker the per-account draw classifier needs. Sourced from
    // the RMD context — present on BOTH engines (the deterministic runner builds
    // it; Monte Carlo rebuilds it in `buildStrategyRmdContext` from the already
    // serialized `McRmdContext`) — so this adds no new serialized MC input field.
    // Read from `args.rmdContext`, not `input.rmdContext`: they are the same object
    // on the deterministic path, and the MC path supplies only the former.
    inheritedAccount:
      args.rmdContext?.rmdFactsByAccountId?.[a.id]?.inheritedAccount === true,
  }));

  // When the household has NO real POST_TAX-non-Roth account to reinvest
  // RMD surplus into, pre-append a zero-balance synthetic cash-like carrier so
  // overflow surplus stays in the portfolio (preserved in `totalBalance`)
  // instead of leaking out of the projection. Materialized once at run START
  // (never mid-loop) and APPENDED LAST so every real-account state index — and
  // the upstream-built custom tiers / excluded indices keyed off `accountsIn`
  // order — stays aligned. The carrier is a member of `CASH_LIKE_ACCOUNT_TYPES`
  // (`SAVINGS` + `POST_TAX`) so the existing $0-MAGI / tax-free machinery fires;
  // it grows 0% (annualRatePct 0) and is spent first via `consumeOverflowCashFirst`.
  const hasRealPostTaxNonRoth = state.some(
    (st) => isPostTaxNonRoth(st) && !isRmdOverflowCashAccountId(st.id),
  );
  if (args.rmdContext && !hasRealPostTaxNonRoth) {
    state.push({
      id: RMD_OVERFLOW_CASH_ACCOUNT_ID,
      pre: 0,
      post: 0,
      annualRatePct: 0,
      monthlyRate: 0,
      taxTreatment: 'POST_TAX',
      accountType: 'SAVINGS',
      deposits: new Float64Array(stepCount),
      depositsPost: new Float64Array(stepCount),
      // No per-month return series → flat 0% growth on every path (incl. MC).
    });
  }

  // HSA medical-reserve routing: HSA accounts are held out of the
  // ordinary tiers; the year loop runs the medical + emergency two-pass against
  // these indices. Computed once over the (immutable) account ordering — the
  // synthetic RMD-overflow carrier is POST_TAX so it never appears here.
  //
  // For `customOrder` the drawdown is fully user-controlled — an HSA is
  // drawn ONLY if the user placed it in a tier. An HSA the user left in
  // `excludedAccountIds` (the default) must stay UNTOUCHED, so the medical + emergency two-pass must NOT
  // target an excluded HSA. The built-in strategies pass no `excludedIndices`
  // (they hold HSA out of the ORDINARY tiers via `buildStrategyTiers` but DO
  // intend the reserve passes to draw it), so this filter is a no-op for them.
  const hsaIndices =
    strategyKind === 'customOrder' && excludedIndices !== undefined
      ? hsaStateIndices(state).filter((a) => !excludedIndices.has(a))
      : hsaStateIndices(state);
  // Tier membership depends only on account type/treatment,
  // which never changes mid-run — build ONCE here (state ordering is final
  // now that the synthetic RMD-overflow carrier has been pushed) instead of
  // every month × year × tax pass. NEVER for `customOrder` (`buildStrategyTiers`
  // throws on it; custom tiers arrive prebuilt from the caller already).
  const prebuiltTiers =
    strategyKind === 'customOrder' ? undefined : buildStrategyTiers(state, strategyKind);
  // Per-month medical demand in DOLLARS (the input carries integer cents). Empty
  // / absent ⇒ all-zero so the medical pass is a no-op.
  const medicalDemand = new Float64Array(stepCount);
  const demandCents = input.medicalDemandByMonth;
  if (demandCents) {
    for (let i = 0; i < stepCount && i < demandCents.length; i += 1) {
      medicalDemand[i] = (demandCents[i] ?? 0) / 100;
    }
  }

  const perMonthWithdrawal = new Float64Array(stepCount);
  const years: DrawdownYear[] = [];
  let depletionYear: number | null = null;

  // The year-START sub-buckets of the PREVIOUS loop iteration — i.e. Dec 31
  // of `taxYear − 2` — which is the base a first-year-deferral catch-up ("two RMDs
  // in one year") is sized from. Tracked only when the household actually records
  // RMD facts, so a fact-free run allocates nothing and stays byte-identical.
  const tracksRmdFacts = args.rmdContext?.rmdFactsByAccountId !== undefined;
  let twoYearsPriorDollars: { pre: number; post: number }[] | undefined;

  // Downturn guardrail. Per-path state RESETS here at
  // path entry (never leaks across paths). Evaluated ONLY when an enabled config
  // is supplied — otherwise the year loop is unaffected.
  const guardrail = args.guardrail;
  const guardrailActive = guardrail !== undefined && guardrail.config.enabled === true;
  const guardrailState: GuardrailPathState | undefined = guardrailActive
    ? initGuardrailState()
    : undefined;

  for (let y = 0; y < yearCount; y += 1) {
    const calendarYear = input.retirementYear + y;
    // (0) Guardrail firing at the year-START boundary: evaluate the funded
    // ratio from the CURRENTLY-SETTLED spend path on the pre-withdrawal pool,
    // step the settled factor, and SCALE this year's 12 `expense` months in
    // place. Scaling the (per-path-inflated nominal) expense flows the adjusted
    // spending through the RMD/tax solve AND the monthly withdrawal, so both
    // tax passes tax the adjusted withdrawals.
    if (guardrailActive && guardrail !== undefined && guardrailState !== undefined) {
      const factor = evaluateGuardrailForYear({
        y,
        state,
        guardrail,
        guardrailState,
      });
      guardrail.appliedFactorByYear[y] = factor;
      if (factor !== 1) {
        const base = y * 12;
        for (let m = 0; m < 12; m += 1) expense[base + m] *= factor;
      }
    }
    // Snapshot the year-START sub-buckets (= Dec 31 of `calendarYear − 1`) BEFORE
    // any pass mutates them, then hand the PREVIOUS iteration's snapshot (Dec 31 of
    // `calendarYear − 2`) to the floor builder as the catch-up base. Withheld for
    // the first TWO drawdown years — `y === 1`'s predecessor snapshot is the
    // at-retirement ledger balance, which the deterministic tax floor
    // (`priorPriorYear = i > 1 ? years[i - 2] : undefined`) does NOT have, so
    // supplying it here would make the forced draw exceed the floor it is measured
    // against. Both engines withhold the catch-up for those years instead.
    const yearStartDollars = tracksRmdFacts
      ? state.map((st) => ({ pre: st.pre, post: st.post }))
      : undefined;
    const catchUpBase = y > 1 ? twoYearsPriorDollars : undefined;
    const rmdFloorByAccountDollars = args.rmdContext
      ? buildPerOwnerRmdFloor({
          taxYear: calendarYear,
          state,
          rmdContext: args.rmdContext,
          ...(catchUpBase !== undefined ? { twoYearsPriorDollars: catchUpBase } : {}),
        })
      : new Array<number>(state.length).fill(0);
    twoYearsPriorDollars = yearStartDollars;
    // QCD forced-outflow pass — gated on the 70½ floor only,
    // INDEPENDENT of the RMD trigger age. Runs BEFORE the RMD floor pre-pass so
    // the forced TAXABLE RMD is `gross − min(Q, gross)`. Debits the gift from the
    // source IRA + reduces the IRA-pool floor in place; returns the totals stamped
    // on the year row. Needs the owner→account map from `rmdContext` (always built
    // when the ledger has accounts).
    const qcdResult =
      qcdContext && args.rmdContext
        ? applyQcdPrePass({
            state,
            rmdFloorByAccountDollars,
            qcdContext,
            ownerByAccountId: args.rmdContext.ownerByAccountId,
            taxYear: calendarYear,
          })
        : undefined;
    // Select the per-year active window's runtime config from the cap
    // schedule (gap year / no schedule → undefined → cap off this year). Leaf
    // distributors + the conversion fill stay time-unaware.
    const magiCapConfig =
      magiCapWindows !== undefined
        ? selectActiveMagiCapWindow(magiCapWindows, calendarYear)?.config
        : undefined;
    const yr = runOneStrategyYear({
      y,
      state,
      yearCount,
      expense,
      income,
      householdDeposit,
      strategyKind,
      rmdFloorByAccountDollars,
      perMonthWithdrawal,
      retirementYear: input.retirementYear,
      customTiers,
      excludedIndices,
      magiCapConfig,
      taxCashflow,
      hsaIndices,
      medicalDemand,
      qcdResult,
      prebuiltTiers,
    });
    if (yr.depleted && depletionYear === null) depletionYear = yr.year;
    years.push(yr);
  }

  return { years, depletionYear, perMonthWithdrawal };
}

// ---------------------------------------------------------------------------
// Downturn guardrail
// ---------------------------------------------------------------------------

/**
 * Evaluate + apply the guardrail for one drawdown year.
 * Computes the funded ratio from the year-START pre-withdrawal pool against the
 * currently-settled spend path, steps `guardrailState.settledFactor`, and
 * returns the new settled factor to scale this year's spending by.
 *
 * The funded-ratio denominator uses the settled factor ENTERING the year (the
 * factor from prior adjustments, before this year's step): the remaining
 * years `y..end` are held at that factor. Net need on the settled path =
 * `baselineNetNeedReal + baselineTotalReal × (settled − 1)` — the guardrail
 * scales TOTAL spending, and guaranteed income (baselineTotal − baselineNetNeed)
 * is unaffected, so netNeed shifts by the spending delta only.
 */
function evaluateGuardrailForYear(args: {
  readonly y: number;
  readonly state: ReadonlyArray<AccountRunState>;
  readonly guardrail: GuardrailRuntimeContext;
  readonly guardrailState: GuardrailPathState;
}): number {
  const { y, state, guardrail, guardrailState } = args;
  const priorSettled = guardrailState.settledFactor;

  // Year-start (pre-withdrawal) pool, nominal dollars.
  let poolNominal = 0;
  for (let a = 0; a < state.length; a += 1) poolNominal += state[a].pre + state[a].post;

  // Remaining-years settled real net need + flat (real-series pass-through) CPI.
  const n = guardrail.baselineNetNeedRealByYear.length;
  const remaining = Math.max(0, n - y);
  const netNeedReal = new Array<number>(remaining);
  const cumOnes = new Array<number>(remaining);
  for (let k = 0; k < remaining; k += 1) {
    const idx = y + k;
    const baseNet = guardrail.baselineNetNeedRealByYear[idx] ?? 0;
    const baseTotal = guardrail.baselineTotalRealByYear[idx] ?? 0;
    // Settled-path net need: scale TOTAL spending by the settled factor; leave
    // guaranteed income (baseTotal − baseNet) untouched.
    netNeedReal[k] = baseNet + baseTotal * (priorSettled - 1);
    cumOnes[k] = 1; // series is already REAL (path-CPI-independent)
  }

  const cumCpi = guardrail.cumCpiAtYearStart[y] ?? 1;
  const ratio = fundedRatio({
    portfolioNominal: poolNominal,
    portfolioCumCpi: cumCpi,
    netNeedNominalByYear: netNeedReal,
    cumCpiByYear: cumOnes,
    effectiveTaxRate: guardrail.effectiveTaxRate,
  });

  // Essential floor factor for this year: essential real spending ÷ baseline
  // total real spending. A zero-baseline year yields a 0 floor (a cut
  // could reach 0, but a zero-baseline year has no spending to cut anyway).
  const baseTotalThisYear = guardrail.baselineTotalRealByYear[y] ?? 0;
  const essentialThisYear = guardrail.essentialRealByYear[y] ?? 0;
  const essentialFloorFactor =
    baseTotalThisYear > 0 ? essentialThisYear / baseTotalThisYear : 0;

  const stepped = applyGuardrailStep({
    state: guardrailState,
    ratio,
    config: guardrail.config,
    essentialFloorFactor,
  });
  return stepped.factor;
}

// ---------------------------------------------------------------------------
// Per-year step
// ---------------------------------------------------------------------------

/** Run the per-year tax-cashflow solve via the hook. Returns the outcome
 *  (added need + diagnostics) or `undefined` when no hook is configured.
 *  The classifier deep-copies state for a non-committing trial draw, so
 *  the real run state (which RMD already mutated) is untouched. */
function solveYearTaxCashflow(args: {
  readonly taxCashflow: TaxCashflowHook | undefined;
  readonly yearIndex: number;
  readonly ordinaryNetNeed: number;
  readonly state: ReadonlyArray<AccountRunState>;
  readonly strategyKind: StrategyAwareKind;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  readonly rmdResult: RmdFloorPrePassResult;
  /** Active MAGI-cap config + the post-RMD pre-tax cap budget, threaded
   *  so the TRIAL classifier routes tax funding to taxable/Roth before capped
   *  pre-tax — exactly as the committing path does. */
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  readonly capRemainingDollars: number | null;
  /** Within-year per-month deposit/income/expense context so the trial
   *  simulation mirrors the committing within-year deposits → growth →
   *  withdrawal sequence (years with post-retirement cash inflows). */
  readonly within: TrialWithinYearInputs;
}): TaxCashflowYearOutcome | undefined {
  const { taxCashflow, yearIndex, ordinaryNetNeed, state, strategyKind,
    customTiers, excludedIndices, rmdResult, magiCapConfig, capRemainingDollars, within } = args;
  if (!taxCashflow) return undefined;
  const classify = (targetDollars: number): TaxCashflowYearClassification =>
    classifyTrialYearDraw({
      state,
      strategyKind,
      customTiers,
      excludedIndices,
      rmdForcedTotal: rmdResult.totalForcedPreTaxWithdrawn,
      totalTargetDollars: targetDollars,
      magiCapConfig,
      capRemainingDollars,
      within,
    });
  return taxCashflow.solveForYear(yearIndex, ordinaryNetNeed, classify);
}

function runOneStrategyYear(args: YearStepArgs): DrawdownYear {
  const { y, state, expense, income, householdDeposit, strategyKind, rmdFloorByAccountDollars,
    perMonthWithdrawal, retirementYear, customTiers, excludedIndices, magiCapConfig, taxCashflow,
    hsaIndices, medicalDemand, qcdResult } = args;
  const calendarYear = retirementYear + y;
  // Snapshot per-account totals over the year for the year row.
  const yearWithdrawnByAcct = new Array<number>(state.length).fill(0);
  const yearPreWithdrawnByAcct = new Array<number>(state.length).fill(0);
  const yearPostWithdrawnByAcct = new Array<number>(state.length).fill(0);
  const yearDepositByAcct = new Array<number>(state.length).fill(0);
  // HSA medical-qualified dollars per account. The emergency residual
  // is `committed HSA withdrawn − this` (the residual rule), derived at row
  // assembly so the two buckets reconcile to the cent.
  const yearMedicalQualifiedByAcct = new Array<number>(state.length).fill(0);
  let yearWithdrawn = 0;
  let yearDeposit = 0;
  let yearGrowth = 0;
  let yearExpense = 0;
  let yearIncome = 0;

  // MAGI-cap tracking for the year.
  let yearMagiCapBreachDollars = 0;
  let yearMagiCapTierOverrideDollars = 0;
  // Remaining pre-tax cap budget for the year (null = cap not active).
  const capActive = magiCapConfig !== undefined && calendarYear < magiCapConfig.capOffYear;
  let capRemainingDollars = capActive ? magiCapConfig!.capDollars : null;

  // (1) RMD floor pre-pass at year-start. The MANDATORY forced draw only —
  // the surplus disposition is deferred to AFTER the tax solve so the
  // tax portion of the forced RMD is funded out of the portfolio, not
  // reinvested back into it.
  const yearNetNeed = sumYearWindow(expense, income, y);
  const rmdResult = applyRmdFloorPrePass({
    state,
    rmdFloorByAccountDollars,
  });
  // Record RMD forced-draw per-account effects. The pre-pass draws ONLY from
  // the pre-tax bucket (qualifying accounts), so the withdrawn amount
  // lands entirely in `pre`. (Surplus deposits are recorded after the tax
  // solve via `disposeRmdSurplus`.)
  for (let a = 0; a < state.length; a += 1) {
    yearWithdrawnByAcct[a] += rmdResult.preTaxWithdrawn[a];
    yearPreWithdrawnByAcct[a] += rmdResult.preTaxWithdrawn[a];
    yearWithdrawn += rmdResult.preTaxWithdrawn[a];
  }
  // RMD pre-pass may itself draw pre-tax dollars — deduct from cap budget.
  // When the forced RMD pre-tax exceeds the cap, the overage is an
  // unavoidable cap breach (RMD is mandatory). Record the excess in
  // `yearMagiCapBreachDollars` so the UI reports the breach even when the
  // year's discretionary withdrawals stay within cap.
  if (capRemainingDollars !== null) {
    const rmdPreTax = rmdResult.totalForcedPreTaxWithdrawn;
    if (rmdPreTax > capRemainingDollars) {
      yearMagiCapBreachDollars += rmdPreTax - capRemainingDollars;
    }
    capRemainingDollars = Math.max(0, capRemainingDollars - rmdPreTax);
  }

  // (1b) Tax-cashflow solve. Raise the year's net need by the
  // solver's tax cashflow need so federal tax + the IRMAA cash portion
  // (minus the ACA PTC offset) are funded from the portfolio. The added
  // need is spread across the months proportional to monthly net need
  // (evenly when there is no ordinary need, e.g. an all-RMD year).
  const taxOutcome = solveYearTaxCashflow({
    taxCashflow, yearIndex: y, ordinaryNetNeed: yearNetNeed,
    state, strategyKind, customTiers, excludedIndices, rmdResult,
    // Thread the active cap + post-RMD budget so the trial classifier
    // routes tax funding the same cap-aware way the committing path does.
    magiCapConfig, capRemainingDollars,
    // Thread the within-year per-month deposit/income/expense context so
    // the trial sim mirrors the committing deposits → growth → withdrawal order.
    // Also thread the HSA indices + medical demand so the trial mirrors the
    // committing two-pass HSA routing (medical-first, emergency-after).
    within: { yearIndex: y, expense, income, householdDeposit, yearNetNeed, hsaIndices, medicalDemand },
  });
  // Negative when the credit applied to premiums outweighs the tax need; never
  // below minus `yearNetNeed`, and the monthly spread below is proportional to
  // each month's ordinary need, so no month's target goes below zero.
  const taxAddedNeed = taxOutcome?.addedNeedDollars ?? 0;

  // (1c) RMD surplus disposition AFTER the tax solve. The retained
  // surplus excludes the same-year tax cashflow add-on, because in an over-RMD
  // year the monthly RMD credit drives `monthTargetGross → 0` and the tax cash
  // is funded out of the forced RMD itself. Runs BEFORE the monthly loop so the
  // synthetic carrier balance exists for any later-year spend-first (same-year
  // spend cannot occur — `monthTargetGross → 0` in a surplus year). The deposit
  // is a transfer (no income), so it does not affect the tax solve above.
  const surplusResult = disposeRmdSurplus({
    state,
    totalForcedPreTaxWithdrawn: rmdResult.totalForcedPreTaxWithdrawn,
    netNeedDollars: yearNetNeed,
    taxAddedNeed,
  });
  for (let a = 0; a < state.length; a += 1) {
    yearDepositByAcct[a] += surplusResult.postTaxNonRothDeposit[a];
    yearDeposit += surplusResult.postTaxNonRothDeposit[a];
  }

  for (let m = 0; m < 12; m += 1) {
    const i = y * 12 + m;
    yearExpense += expense[i];
    yearIncome += income[i];
    const ordinaryMonthlyNeed = Math.max(0, expense[i] - income[i]);
    const taxMonthShare =
      yearNetNeed > 0 ? ordinaryMonthlyNeed / yearNetNeed : 1 / 12;
    const monthlyNetNeed = ordinaryMonthlyNeed + taxAddedNeed * taxMonthShare;
    // Apply deposits (per-account + household-split).
    const depositSum = applyMonthlyDeposits({
      state,
      stepIdx: i,
      householdDepositAmount: householdDeposit[i] ?? 0,
      yearDepositByAcct,
    });
    yearDeposit += depositSum;
    // Apply monthly growth — captured in yearGrowth. Pass the step index so
    // an MC path grows on its per-month sampled returns; the
    // deterministic path (no `returnPctByMonth`) ignores it and uses the
    // scalar monthly rate.
    yearGrowth += applyMonthlyGrowth(state, i);
    // Distribute month's needed withdrawal across strategy tiers.
    // The portion of the month's need still covered after the RMD
    // pre-pass credit. Spread the credit proportional to the ORDINARY
    // monthly need (RMD funds ordinary spending, not the tax add-on).
    const monthShareOfYearNeed = yearNetNeed > 0 ? ordinaryMonthlyNeed / yearNetNeed : 0;
    const monthRmdCredit = rmdResult.totalForcedPreTaxWithdrawn * monthShareOfYearNeed;
    const monthTargetGross = Math.max(0, monthlyNetNeed - monthRmdCredit);

    // Universal spend-first: consume the synthetic RMD-overflow cash carrier
    // for this month's discretionary need BEFORE the strategy router draws any
    // real account — strategy-agnostic, so held cash is always spent before
    // tapping pre-tax again (reducing this year's discretionary pre-tax draw).
    const cashSpent = consumeOverflowCashFirst({
      state,
      target: monthTargetGross,
      yearWithdrawnByAcct,
      yearPostWithdrawnByAcct,
    });
    const afterCashTarget = monthTargetGross - cashSpent;

    // HSA PASS A — medical-qualified (pinned before the ordinary drain).
    // Fund modeled `isMedical` demand from HSA balances tax-free, up to
    // min(this month's remaining need, the month's medical demand, HSA balance).
    // Fires only when a positive portfolio need exists, so surplus-income years
    // leave HSA untouched.
    const medicalHsaSpent = drawHsaMedical({
      state,
      hsaIndices,
      target: afterCashTarget,
      demand: medicalDemand[i] ?? 0,
      yearWithdrawnByAcct,
      yearPostWithdrawnByAcct,
      medicalQualifiedByAcct: yearMedicalQualifiedByAcct,
    });
    const monthTarget = afterCashTarget - medicalHsaSpent;

    let monthWithdrawn: number;
    if (strategyKind === 'customOrder' && customTiers !== undefined) {
      // Custom-order path with optional MAGI-cap enforcement:
      // accounts drain within each tier in the user-specified order, diverting
      // to a cap-safe source only at the breach dollar.
      monthWithdrawn = distributeWithdrawalByCustomTiersWithCap({
        state,
        tiers: customTiers,
        excludedIndices: excludedIndices ?? new Set(),
        target: monthTarget,
        yearWithdrawnByAcct,
        yearPreWithdrawnByAcct,
        yearPostWithdrawnByAcct,
        capRemainingDollars,
        magiCapConfig,
        onCapBreachDollars: (d) => { yearMagiCapBreachDollars += d; },
        onTierOverrideDollars: (d) => { yearMagiCapTierOverrideDollars += d; },
        onPreTaxDrawn: (d) => {
          if (capRemainingDollars !== null) capRemainingDollars = Math.max(0, capRemainingDollars - d);
        },
        sequentialWithinTier: true,
      });
    } else if (capRemainingDollars !== null && magiCapConfig !== undefined) {
      // Preset strategy with an active MAGI cap (the cap applies to all
      // named strategies). Build tiers from the preset strategy and
      // route through the cap-aware distributor.
      // strategyKind !== 'customOrder' guaranteed by the outer if-branch above.
      // Reuse the per-run prebuilt tiers when available.
      const presetTiers = args.prebuiltTiers ?? buildStrategyTiers(state, strategyKind);
      monthWithdrawn = distributeWithdrawalByCustomTiersWithCap({
        state,
        tiers: presetTiers,
        excludedIndices: new Set(),
        target: monthTarget,
        yearWithdrawnByAcct,
        yearPreWithdrawnByAcct,
        yearPostWithdrawnByAcct,
        capRemainingDollars,
        magiCapConfig,
        onCapBreachDollars: (d) => { yearMagiCapBreachDollars += d; },
        onTierOverrideDollars: (d) => { yearMagiCapTierOverrideDollars += d; },
        onPreTaxDrawn: (d) => {
          if (capRemainingDollars !== null) capRemainingDollars = Math.max(0, capRemainingDollars - d);
        },
      });
    } else {
      monthWithdrawn = distributeWithdrawalByStrategy({
        state,
        strategyKind,
        target: monthTarget,
        yearWithdrawnByAcct,
        yearPreWithdrawnByAcct,
        yearPostWithdrawnByAcct,
        // Reuse the per-run prebuilt tiers when available.
        tiers: args.prebuiltTiers,
      });
    }
    // HSA PASS B — emergency reserve (pinned AFTER the ordinary router).
    // The ordinary router holds HSA out of its tiers, so a residual after
    // the router means every non-HSA account is exhausted. Only then does HSA
    // act as a last-resort reserve. These dollars are NOT medical-qualified, so
    // they form the emergency residual the pct + 20% additional tax govern.
    const emergencyResidual = monthTarget - monthWithdrawn;
    const emergencyHsaSpent = emergencyResidual > 1e-9
      ? drawHsaEmergency({
          state,
          hsaIndices,
          target: emergencyResidual,
          yearWithdrawnByAcct,
          yearPostWithdrawnByAcct,
        })
      : 0;
    // LAST-RESORT floor-reserve draw.
    // Only when unmet need STILL remains after every ordinary path (incl. the
    // HSA emergency pass) — drain protected floor reserves so a truly depleted
    // plan reaches $0 instead of stranding cash behind a floor. HSA reserve
    // draws route through the withdrawn + post accumulators only (never the
    // medical accumulator), so the residual rule taxes them as emergency /
    // nonmedical. Excluded accounts stay untouched.
    const reserveResidual = emergencyResidual - emergencyHsaSpent;
    const reserveSpent = reserveResidual > 1e-9
      ? drawFloorReserve({
          state,
          tiers: strategyKind === 'customOrder'
            ? (customTiers ?? [])
            : (args.prebuiltTiers ?? buildStrategyTiers(state, strategyKind)),
          hsaIndices,
          excludedIndices: excludedIndices ?? new Set(),
          target: reserveResidual,
          yearWithdrawnByAcct,
          yearPreWithdrawnByAcct,
          yearPostWithdrawnByAcct,
          sequentialWithinTier: strategyKind === 'customOrder',
        })
      : 0;
    // `cashSpent` (synthetic carrier) + the medical HSA draw + the router draw +
    // the emergency HSA draw + the last-resort floor-reserve draw all fund this
    // month's need; the forced-RMD credit is the remaining source. Depletion is
    // measured AFTER this pass via `yearWithdrawn`, so a reserve-funded
    // year keeps `depleted = false`.
    perMonthWithdrawal[i] =
      cashSpent + medicalHsaSpent + monthWithdrawn + emergencyHsaSpent + reserveSpent + monthRmdCredit;
    yearWithdrawn += cashSpent + medicalHsaSpent + monthWithdrawn + emergencyHsaSpent + reserveSpent;
  }

  // (4) Fill-mode Roth-conversion fill. AFTER the monthly loop —
  // the residual cap room is only known now. Gated on an ACTIVE cap under FILL
  // mode; converts leftover headroom (the gross-dollar residual cap room)
  // into the target Roth, sized by the outer bisection against the actual MAGI
  // line so realized MAGI lands AT the ceiling. Commits the principal move ONCE
  // (debit pre-tax / MIXED-pre, credit the target Roth) and is excluded from the
  // §72(t) penalty by NOT touching the withdrawal accumulators.
  const conversionResult = applyRothConversionFill({
    state,
    magiCapConfig,
    capActive,
    capRemainingDollars,
    taxCashflow,
    yearIndex: y,
    yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct,
    yearWithdrawnByAcct,
    // Excluded accounts are never a conversion or tax-funding source.
    excludedIndices,
  });
  // The conversion's same-year incremental tax is FUNDED from cap-safe
  // balances inside `applyRothConversionFill` (recorded in the per-account
  // accumulators); fold the FUNDED portion into the year's total withdrawal so
  // the projected balance drops by it (balance conserved MINUS funded conversion
  // tax). The full NEED drives depletion — an unfundable conversion tax (cap-safe
  // balances exhausted) is a depletion.
  const conversionFundedTax = conversionResult.fundedTaxCents / 100;
  const conversionTaxNeed = conversionResult.taxNeedCents / 100;
  yearWithdrawn += conversionFundedTax;

  const yearNetNeedRow = Math.max(0, yearExpense - yearIncome);
  // Depletion measures against the FULL funded target (ordinary spending + the
  // tax cashflow add-on + the conversion tax NEED) — a year that can cover
  // spending but not the grossed-up tax bill is still a depletion.
  const depleted = yearWithdrawn + 1e-6 < yearNetNeedRow + taxAddedNeed + conversionTaxNeed;

  const row = assembleStrategyYearRow({
    state,
    calendarYear,
    yearWithdrawn,
    yearNetNeedRow,
    yearGrowth,
    yearDeposit,
    depleted,
    yearWithdrawnByAcct,
    yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct,
    yearDepositByAcct,
    yearMedicalQualifiedByAcct,
    surplusResult,
    yearMagiCapBreachDollars,
    yearMagiCapTierOverrideDollars,
    rothConvertedCents: conversionResult.convertedCents,
    rothConversionDegradedNoTarget: conversionResult.degradedNoTargetRoth,
  });
  // The strategy path keeps the solver's own (non-honest) shortfall, so
  // it stamps via the PLAIN row stamper — never the honest-shortfall variant
  // (which the single-pool all-pre-tax paths use to recompute post-draw).
  if (taxOutcome) stampTaxCashflowRow(row, taxOutcome);
  // QCD display fields. Stamp only in a year a QCD applied — the band /
  // tax-detail tiles are conditional on `qcdCents > 0`. `netTaxableRmdCents` is
  // the IRA-pool RMD the user still owes income tax on after the QCD offset
  // (gross IRA-pool RMD − offset); 0 when the QCD ≥ the gross IRA RMD.
  if (qcdResult && qcdResult.totalQcdCents > 0) {
    row.qcdCents = qcdResult.totalQcdCents;
    row.netTaxableRmdCents = Math.max(
      0,
      qcdResult.grossIraPoolRmdCents - qcdResult.rmdOffsetCents,
    );
    // Carry the per-owner IRA-pool RMD offset so the deterministic tax
    // post-pass credits it toward the owner's IRA aggregation pool — the QCD
    // counts toward the IRA RMD (§408(d)(8)), so no phantom shortfall surfaces.
    row.qcdRmdOffsetCentsByOwner = qcdResult.rmdOffsetCentsByOwner;
    // DISPLAY-only: the EXACT factor this engine used to inflate the REAL gift to
    // nominal `qcdCents` (year-END December factor deterministic, path year-END
    // `cumCpi` under the MC representative replay). The today's-dollars QCD
    // surfaces divide it out so a configured REAL QCD round-trips exactly.
    row.qcdInflationFactor = qcdResult.inflationFactor;
  }
  return row;
}

/** Build the per-account balance map + `DrawdownYear` row at year-end.
 *  Extracted from `runOneStrategyYear` to keep that function tractable. */
function assembleStrategyYearRow(args: {
  readonly state: AccountRunState[];
  readonly calendarYear: number;
  readonly yearWithdrawn: number;
  readonly yearNetNeedRow: number;
  readonly yearGrowth: number;
  readonly yearDeposit: number;
  readonly depleted: boolean;
  readonly yearWithdrawnByAcct: number[];
  readonly yearPreWithdrawnByAcct: number[];
  readonly yearPostWithdrawnByAcct: number[];
  readonly yearDepositByAcct: number[];
  /** HSA medical-qualified dollars per account. */
  readonly yearMedicalQualifiedByAcct: number[];
  readonly surplusResult: RmdSurplusDispositionResult;
  readonly yearMagiCapBreachDollars: number;
  readonly yearMagiCapTierOverrideDollars: number;
  /** Fill-mode converted principal for the year, integer cents. */
  readonly rothConvertedCents: number;
  /** True when Fill mode had room but no target Roth resolved. */
  readonly rothConversionDegradedNoTarget: boolean;
}): DrawdownYear {
  const { state, calendarYear, yearWithdrawn, yearNetNeedRow, yearGrowth,
    yearDeposit, depleted, yearWithdrawnByAcct, yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct, yearDepositByAcct, yearMedicalQualifiedByAcct, surplusResult,
    yearMagiCapBreachDollars, yearMagiCapTierOverrideDollars, rothConvertedCents,
    rothConversionDegradedNoTarget } = args;
  const accountBalances = new Map<string, DrawdownAccountYear>();
  let totalBalance = 0;
  for (let a = 0; a < state.length; a += 1) {
    const preEnd = state[a].pre;
    const postEnd = state[a].post;
    // Medical-qualified HSA cents, capped at the account's committed
    // withdrawal cents so the emergency residual (`withdrawn − medical`) is
    // never negative under fp residue (the residual rule keeps them summing
    // to the committed cents exactly).
    const withdrawnCents = Math.round(yearWithdrawnByAcct[a] * 100);
    const medicalCents = state[a].taxTreatment === 'HSA' && yearMedicalQualifiedByAcct[a] > 0
      ? Math.min(withdrawnCents, Math.round(yearMedicalQualifiedByAcct[a] * 100))
      : 0;
    accountBalances.set(state[a].id, {
      balance: preEnd + postEnd,
      preEnd,
      postEnd,
      withdrawn: yearWithdrawnByAcct[a],
      deposit: yearDepositByAcct[a],
      // Per-account pre/post withdrawn split (cents). Tax post-pass
      // routes MIXED withdrawals via these fields.
      preWithdrawnCents: Math.round(yearPreWithdrawnByAcct[a] * 100),
      postWithdrawnCents: Math.round(yearPostWithdrawnByAcct[a] * 100),
      ...(medicalCents > 0 ? { medicalQualifiedWithdrawnCents: medicalCents } : {}),
    });
    totalBalance += preEnd + postEnd;
  }
  return {
    year: calendarYear,
    balance: totalBalance,
    withdrawn: yearWithdrawn,
    netNeed: yearNetNeedRow,
    growth: yearGrowth,
    deposit: yearDeposit,
    depleted,
    accountBalances,
    rmdReinvestedCents:
      surplusResult.reinvestedDollars > 0
        ? Math.round(surplusResult.reinvestedDollars * 100)
        : undefined,
    rmdOverflowToCashCents:
      surplusResult.overflowToCashDollars > 0
        ? Math.round(surplusResult.overflowToCashDollars * 100)
        : undefined,
    magiCapBreachDollars: yearMagiCapBreachDollars > 0 ? yearMagiCapBreachDollars : undefined,
    magiCapTierOverrideDollars:
      yearMagiCapTierOverrideDollars > 0 ? yearMagiCapTierOverrideDollars : undefined,
    rothConvertedCents: rothConvertedCents > 0 ? rothConvertedCents : undefined,
    rothConversionDegradedNoTarget: rothConversionDegradedNoTarget ? true : undefined,
  };
}

// Re-export helpers consumed by sibling tests / callers.

