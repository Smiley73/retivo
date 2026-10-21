/**
 * Shared types for the drawdown engine. Split from `drawdown-engine.ts`
 * so the per-account path gets its own implementation file under the shape
 * cap, and all consumers import from one shared type surface.
 */
import type {
  AccountTaxTreatment,
  AccountType,
  CustomDrawdownOrder,
  WithdrawalStrategy,
} from '../db/types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import type { MagiCapWindowRuntime } from './drawdown-engine-per-account-strategy-helpers';

export interface DrawdownInput {
  /** Combined balance at the start of the retirement year. Retained for
   *  caller compatibility; the per-account branch draws from `accounts`. */
  portfolioAtRetirement: number;
  /** Annual return rate, percent. Retained for caller compatibility; the
   *  per-account branch grows each account by its own rate. */
  ratePct: number;
  /** Per-month gross expenses. Must align to (retirementYear, 0). */
  expensesByMonth: MonthlyCashflowSeries;
  /** Per-month non-portfolio income. Must align to (retirementYear, 0). */
  incomeByMonth: MonthlyCashflowSeries;
  /** Per-month household deposit series. Under `accounts` each per-account
   *  ledger also carries its own deposit slot. */
  depositsByMonth: MonthlyCashflowSeries;
  /** Per-month HSA-qualified medical demand, in INTEGER CENTS.
   *  A STRICT SUBSET of the same projection that built `expensesByMonth`:
   *  the sum of the per-month expense categories flagged `isMedical`,
   *  out-of-pocket only (health/ACA premiums excluded). Aligned to
   *  (retirementYear, 0); same length as `expensesByMonth.values` when present.
   *  Drives the medical-qualified HSA draw pass: each month the engine may
   *  fund up to `min(medicalDemand, positive portfolio need, HSA balance)` from
   *  HSA balances tax-free, BEFORE any ordinary drain. Absent / empty ⇒ 0 every
   *  month: the HSA medical pass is a no-op and only the emergency-reserve path
   *  remains. Integer cents so the medical/emergency split sums
   *  exactly to the committed HSA withdrawal cents (residual rule). */
  medicalDemandByMonth?: ReadonlyArray<number>;
  /** First year of drawdown. */
  retirementYear: number;
  /** Last year to simulate (inclusive). */
  horizonYear: number;
  /** Withdrawal ordering strategy. The tax-aware kinds (`taxEfficient`,
   *  `proportional`, `rothFirst`, `customOrder`) activate the year-by-year
   *  strategy-aware drawdown that distributes withdrawals in strategy-priority
   *  order. Defaults to `taxEfficient` when absent. */
  withdrawalStrategy?: WithdrawalStrategy;
  /** Per-account ledger set. When supplied, engine runs the
   *  per-account branch. Asset allocation reaches this path via each
   *  non-CBP account's blended-glide `returnPctByMonth`. */
  accounts?: ReadonlyArray<DrawdownAccountInput>;
  /** Per-account RMD context. It is the only input that drives the RMD
   *  floor; there is no precomputed per-year floor array. When supplied
   *  under a strategy-aware withdrawal strategy
   *  (`taxEfficient`/`rothFirst`/`proportional`), the
   *  engine computes the per-owner per-account RMD floor at each year
   *  start using the year-(y-1) Dec-31 sub-bucket balances it just
   *  finished computing (year-0 uses initial ledger balances). The floor
   *  is enforced ONLY on the owner's qualifying accounts before the
   *  strategy allocates remaining need. Surplus (when floor exceeds the
   *  year's net need) credits the first POST_TAX-non-Roth account as a
   *  deposit; surplus with no POST_TAX-non-Roth landing site surfaces on
   *  `DrawdownYear.rmdOverflowToCashCents`. */
  rmdContext?: RmdContextInput;
  /** Per-owner QCD context. When supplied under a strategy-aware
   *  withdrawal strategy, the engine runs a 70½-gated forced-outflow pass that
   *  debits the resolved Qualified Charitable Distribution from the source IRA
   *  first-dollars, offsets only that owner's IRA-pool RMD floor by
   *  `min(Q, grossIraPoolRmd)`, subtracts Q from the forced-RMD base so it never
   *  funds net need, and stamps `qcdCents` / `netTaxableRmdCents` on the year.
   *  Absent → no QCD. */
  qcdContext?: QcdContextInput;
  /** Custom tier ordering for `withdrawalStrategy.kind === 'customOrder'`.
   *  Each tier is an array of account IDs; tier[0] is drained first.
   *  `excludedAccountIds` are never drawn from (emergency reserve etc.). */
  customDrawdownOrder?: CustomDrawdownOrder;
  /** MAGI-cap WINDOW SCHEDULE. Each entry is a
   *  resolved `[startYear, endYear)` window + its per-window runtime config,
   *  pre-built by the runner (`resolveMagiCapWindows`) — sorted by the total
   *  order `(startYear, endYear, originalIndex)` with broken-anchor windows
   *  flagged. The engine selects ≤ 1 active window per projection
   *  year via `selectActiveMagiCapWindow`; a gap year is cap-off. Orthogonal
   *  to withdrawal strategy — compatible with every named strategy. Absent /
   *  empty → no cap. */
  magiCapWindows?: ReadonlyArray<MagiCapWindowRuntime>;
  /** Per-year tax-cashflow hook. When supplied, the engine raises
   *  each year's withdrawal target by the solver's tax cashflow need so
   *  federal tax + the IRMAA cash portion (minus the ACA PTC offset) are
   *  funded from the portfolio. When absent, the engine runs tax-free
   *  (legacy / unit-test behaviour). Active on the per-account strategy
   *  path. */
  taxCashflow?: TaxCashflowHook;
}

/** Per-year withdrawal classification fed to the tax-cashflow solver. */
export interface TaxCashflowYearClassification {
  readonly preTaxDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  readonly rothDollars: number;
  readonly fundedDollars: number;
  /**
   * The INHERITED Roth IRA portion of the year's Roth draw, in whole dollars:
   * a SUBSET of `rothDollars`, exactly as `hsaMedicalQualifiedDollars` below is a
   * subset of `postTaxCashLikeDollars`. Those dollars are wholesale tax-free and
   * carry no §408A basis state, so `buildSolverPenaltyAccountsForYear` consumes
   * `rothDollars − this` against the basis carrier. It is a subset rather than a
   * deduction from `rothDollars` so the funded and taxable totals — and with them
   * the effective-tax-rate gross-income denominator — do not move. Absent / 0 ⇒ no
   * inherited Roth IRA draw this year.
   */
  readonly rothInheritedTaxFreeDollars?: number;
  /**
   * The committed NON-inherited DESIGNATED-Roth portion of the year's Roth draw
   * (pure Roth employer plans + MIXED Roth-designated post sub-buckets), in
   * whole dollars: a SUBSET of `rothDollars`, exactly like
   * `rothInheritedTaxFreeDollars` above and disjoint from it (that subset is
   * Roth-IRA-only). The funding solver runs these dollars through the pooled
   * §402A pro-rata regime and only the remainder through the §408A carrier, so
   * an unrelated Roth-IRA draw can never consume a designated plan's
   * in-plan-rollover lots (nor a designated draw the owner's Roth-IRA basis).
   * An INHERITED designated plan's draw is deliberately NOT counted here — it
   * carries its own subset below (§72(t)(2)(A)(ii): none of its principal is
   * recapture-bearing, so it must never consume this pooled state). Absent /
   * 0 ⇒ no non-inherited designated-Roth draw this year.
   */
  readonly rothDesignatedDollars?: number;
  /**
   * The committed INHERITED DESIGNATED-Roth portion of the year's Roth draw, in
   * whole dollars: a third SUBSET of `rothDollars`, disjoint from both subsets
   * above. The funding solver runs these dollars through its INHERITED
   * designated slice, where the original owner's DEATH is the qualifying event
   * (§402A(d)(2)(B)(i)) and the 10% is waived at any beneficiary age
   * (§72(t)(2)(A)(ii)) — never through the §408A carrier, whose ordering would
   * tax them as earnings excess and charge a 10% the statute forbids. Absent /
   * 0 ⇒ no inherited designated-Roth draw this year.
   */
  readonly rothInheritedDesignatedDollars?: number;
  /**
   * Per-LEDGER-ACCOUNT attribution of the NON-inherited Roth-IRA remainder of
   * `rothDollars` (the §408A slice: `rothDollars` minus the three subsets
   * above), in whole dollars keyed by account id. The aggregate subsets carry
   * no owner information, so without this the funding solver had to pick ONE
   * ledger owner to charge the whole household slice to — letting ledger ORDER
   * decide whose basis/lots a pooled draw consumes. With it the solver groups
   * each account's dollars onto that account's REAL owner and charges each
   * owner's own §408A state, never a housemate's. Absent (hand-rolled
   * classifications) ⇒ the solver falls back to the single-ledger-owner pick.
   */
  readonly rothIraDollarsByAccountId?: ReadonlyMap<string, number>;
  /**
   * Per-LEDGER-ACCOUNT attribution of `rothDesignatedDollars`, same contract
   * as `rothIraDollarsByAccountId`: each non-inherited designated draw's
   * dollars keyed by the account they actually left, so the funding solver
   * charges each owner's pooled §402A state with that owner's own dollars.
   */
  readonly rothDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
  /**
   * Per-LEDGER-ACCOUNT attribution of `rothInheritedDesignatedDollars`, same
   * contract as the two maps above, for the INHERITED designated slice.
   */
  readonly rothInheritedDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
  /**
   * Portion of the year's HSA draw funded against modeled `isMedical` demand
   * (the medical-qualified pass), in whole dollars — a SUBSET of
   * `postTaxCashLikeDollars` (HSA balances classify cash-like). The funding
   * solver feeds this into `PenaltyAccountSnapshot.hsaMedicalQualifiedDollars`
   * so the trial gross-up narrows the §223(f)(4) nonqualified basis to the
   * EMERGENCY residual identically to the committing post-pass. Absent /
   * 0 ⇒ no medical-funded HSA draw this year (no HSA, no demand, or a
   * classifier that does not model it).
   */
  readonly hsaMedicalQualifiedDollars?: number;
  /**
   * The classifier-modeled HSA TOTAL draw for the year, in whole dollars
   * (medical-first qualified + emergency residual). When present the funding
   * solver feeds THIS as the §223(f)(4) HSA basis instead of estimating the HSA
   * share of the aggregate cash-like bucket by balance proportion — so the
   * funding gross-up's emergency residual
   * (`hsaWithdrawalDollars − hsaMedicalQualifiedDollars`) matches the committing
   * medical-first kernel exactly (no trial-vs-commit over-funding). Absent ⇒ the
   * solver falls back to the balance-share estimate.
   */
  readonly hsaWithdrawalDollars?: number;
}

/** Outcome of one year's tax-cashflow solve, returned to the engine so it
 *  can raise the target and stamp the row's diagnostic fields. */
export interface TaxCashflowYearOutcome {
  /** Same-year amount to ADD to the year's net withdrawal target, in dollars.
   *  Equals the cash tax need (`totalTaxCashflowNeedCents` — federal tax +
   *  IRMAA cash − ACA offset) PLUS the IRMAA portion withheld from Social
   *  Security (`irmaaWithheldFromSsCents`): the withheld surcharge shrinks the
   *  member's SS check while the spendable income series spends gross SS, so the
   *  portfolio must fund the difference. Both components are counted
   *  exactly once. MINUS the credit applied to premiums
   *  (`acaCreditAppliedToPremiumsCents`), so it can be negative — never below
   *  minus the year's ordinary need. */
  readonly addedNeedDollars: number;
  readonly federalTaxCashNeedCents: number;
  readonly irmaaWithheldFromSsCents: number;
  readonly irmaaCashNeedCents: number;
  readonly acaPtcCashflowOffsetCents: number;
  readonly acaCreditAppliedToPremiumsCents: number;
  readonly totalTaxCashflowNeedCents: number;
  readonly taxCashflowIterations: number;
  readonly taxCashflowConverged: boolean;
  readonly taxCashflowShortfallCents: number;
}

/**
 * Per-year tax-cashflow hook the runner injects. The engine calls
 * `solveForYear(yearIndex, ordinaryNetNeedDollars, classify)` once per
 * year BEFORE the committing draw; the hook runs the within-year solver
 * and returns the tax cashflow outcome. `classify(targetDollars)` is the
 * engine-supplied trial classifier — given a candidate total target it
 * returns the per-bucket split the year's withdrawals would produce
 * (proportional / strategy-priority on the per-account path). The hook never
 * throws (graceful degradation).
 */
export type TaxCashflowHook = {
  readonly solveForYear: (
    yearIndex: number,
    ordinaryNetNeedDollars: number,
    classify: (targetDollars: number) => TaxCashflowYearClassification,
  ) => TaxCashflowYearOutcome;
  /**
   * Fill-mode Roth-conversion solve. Called once per year AFTER the
   * committing monthly withdrawal loop, only when a MAGI cap is active under
   * Fill mode with a resolved target Roth and leftover headroom. Given the
   * year's COMMITTED withdrawal classification, the gross-dollar cap room left
   * (the bisection's upper bracket), and the selected MAGI line, runs the OUTER
   * bisection (wrapping the inner tax surface) and returns the converted dollars
   * — sized so realized MAGI on the selected line lands AT the ceiling, never
   * above it, rounded DOWN to whole cents. Side-effect-free; consumes no RNG.
   * Optional so legacy stub hooks need not implement it (Fill lives only on the
   * per-account strategy path).
   */
  readonly solveFillConversionForYear?: (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertibleRoomDollars: number,
    capMagiLine: 'irmaa' | 'aca',
    magiCeilingDollars: number,
  ) => number;
  /**
   * Fund the SAME-YEAR incremental ordinary-income tax a committed conversion
   * creates. Called once per year on the committing path AFTER
   * `solveFillConversionForYear` sized the conversion, with the engine-committed
   * `convertedDollars`. Returns the extra same-year tax cashflow need (federal +
   * IRMAA cash − ACA offset) the conversion adds — the delta between the year's
   * conversion-inclusive funding solve and its withdrawals-only solve — so the
   * engine can draw it from cap-safe (post-tax / Roth) balances. Side effect: it
   * REPLACES the year's live IRMAA look-back MAGI sample with the
   * conversion-inclusive MAGI, so the conversion's Y+2 surcharge is FUNDED (not
   * merely displayed). The funded need is the federal/IRMAA same-year cash tax
   * on the converted ordinary income regardless of `capMagiLine` (an ACA-line
   * Fill still owes the real federal tax). Optional, paired with
   * `solveFillConversionForYear`.
   */
  readonly fundConversionTaxForYear?: (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertedDollars: number,
  ) => number;
};

/** Per-owner metadata + calibration the engine needs to compute the
 *  RMD floor at each year-start using current per-account balances.
 *  Required when the runner wants engine-enforced RMDs. */
export interface RmdContextInput {
  /** Owner-id keyed metadata: birthdate (for trigger-age + divisor) and
   *  projected death year (engine skips the floor after the owner has
   *  died). */
  readonly ownerMeta: ReadonlyMap<string, { readonly isoBirthdate: string; readonly deathYear: number }>;
  /** Account-id → ownerId map. Engine groups qualifying accounts by
   *  this so the per-owner RMD floor only enforces against that owner's
   *  qualifying accounts. */
  readonly ownerByAccountId: ReadonlyMap<string, string>;
  /** RMD calibration snapshot — the engine forwards this to `computeRmd`. */
  readonly rmdSnapshot: import('./calibration').CalibrationSnapshot<import('./rmd').RmdTable>;
  /**
   * Per-account stored RMD profile facts, keyed by account id, so the
   * FORCED withdrawal (the pass that actually moves the money) resolves the same
   * per-account rule the tax floor and the report disclosures resolve. Without
   * it the forced draw ran the legacy owner/Uniform-Lifetime path and could
   * contradict its own disclosure — force-withdrawing a still-working-deferred
   * plan the report said was postponed, or refusing an inherited account's real
   * beneficiary minimum the shortfall flag was measuring against.
   *
   * A plain `Record` (not a `Map`) because the Monte Carlo path rebuilds this
   * from the structured-clone-safe `McRmdContext.rmdFactsByAccountId`. Accounts
   * with nothing recorded are ABSENT, and the whole field is omitted for a
   * fact-free household, which keeps `computeRmd` on its byte-identical legacy
   * branch there.
   */
  readonly rmdFactsByAccountId?: Readonly<Record<string, import('./rmd').RmdAccountProfileFacts>>;
  /**
   * Each owner's separation-from-service calendar year, keyed by owner id.
   * Resolves the §401(a)(9)(C) "later of statutory age or retirement" first
   * distribution year; an owner absent here makes that resolution WITHHOLD
   * rather than assume the trigger-age year. Omitted alongside
   * `rmdFactsByAccountId`.
   */
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
}

/** One resolved QCD directive the engine consumes for the forced-outflow pass. The window is resolved to whole tax years by the runner
 *  (`resolveQcdForScenario` + the schedule resolver); `endYear` is the EXCLUSIVE
 *  boundary (a single-year gift has `startYear === endYear − 1`). The directing
 *  member id is the source account's owner. */
interface QcdContextEntry {
  readonly memberId: string;
  readonly sourceAccountId: string;
  /** REAL (today's-dollars) annual amount; the engine inflates it to nominal
   *  per year via `inflationFactorForYear` before the cap comparison. */
  readonly annualAmountDollars: number;
  /** First active tax year (inclusive) — already clamped to the 70½ floor. */
  readonly startYear: number;
  /** Exclusive end tax year (active THROUGH `endYear − 1`). */
  readonly endYear: number;
}

/** Per-owner QCD context the engine threads into its 70½-gated forced-outflow
 *  pass. Mirrors `RmdContextInput`'s "metadata + calibration"
 *  shape — no balances precomputed here; the engine reads the source IRA's
 *  prior-year-end pre-tax balance at each year-start. */
export interface QcdContextInput {
  /** Resolved QCD directives across both owners (engine groups by `memberId`). */
  readonly entries: ReadonlyArray<QcdContextEntry>;
  /** Owner-id → first 70½-eligible tax year. An owner with no birthdate is
   *  absent → the pass skips them (never forces a pre-70½ outflow). */
  readonly firstEligibleYearByOwner: ReadonlyMap<string, number>;
  /** Cumulative inflation factor applied to the REAL annual amount for the given
   *  tax year — the same canonical scenario inflation the runner builds. */
  readonly inflationFactorForYear: (taxYear: number) => number;
  /** The indexed per-person §408(d)(8) QCD exclusion limit for the given tax
   *  year, in integer cents — inflation-extrapolated forward past the
   *  latest published year by the runner. */
  readonly qcdLimitCentsForYear: (taxYear: number) => number;
}

/** One per-account ledger entry consumed by the per-account drawdown
 *  branch. Caller assembles these upstream. */
export interface DrawdownAccountInput {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  /** Annual return rate, percent. Converted to the monthly factor via
   *  `monthlyEquivalent()`. */
  readonly annualRatePct: number;
  /** Per-month deposit dollars routed to this account (CBP lump-sum,
   *  targeted one-off, and a post-primary spouse contribution's PRE-tax
   *  slice). Routed to the bucket selected by the destination account's tax
   *  treatment (CBP/one-off) or — for the post-primary pre-tax slice — to
   *  `pre`. */
  readonly depositsByMonth: MonthlyCashflowSeries;
  /** Per-month post-primary spouse contribution POST-tax (designated-Roth)
   *  slice routed to this account. Always lands in the account's `post`
   *  bucket regardless of treatment (a MIXED account's Roth slice stays
   *  RMD-exempt, §325). Omitted on callers that route no split (every value
   *  treated as zero). */
  readonly depositsPostByMonth?: MonthlyCashflowSeries;
  /** Tax treatment of this account — used by the withdrawal-order
   *  redistribution pass to classify per-account withdrawals. */
  readonly taxTreatment: AccountTaxTreatment;
  /** Account type — used alongside `taxTreatment` to identify Roth
   *  accounts in the redistribution pass. */
  readonly accountType: AccountType;
  /** Per-month per-account return percent. The same
   *  per-account per-month return series the kernel grows by
   *  (`KernelAccount.returnPct[i]`). Two suppliers:
   *    - MONTE CARLO: the sampled historical per-step return.
   *    - DETERMINISTIC ALLOCATION: the household BLENDED GLIDE return
   *      (`blendedGlideReturnPct` → `monthlyEquivalent`) filled over the
   *      full-run step domain so allocation routes through this per-account
   *      path (accumulation steps hold the base scalar rate; drawdown steps
   *      hold the blended glide rate).
   *  When present, the strategy-aware year-by-year engine grows this account by
   *  `1 + returnPctByMonth[stepIdx] / 100` each month instead of the scalar
   *  `monthlyEquivalent(annualRatePct)`. ABSENT on the non-allocation
   *  deterministic / optimizer call path, so growth stays scalar-rate.
   *  Length must equal
   *  the run's total step count (`yearCount * 12`) when supplied. */
  readonly returnPctByMonth?: Float64Array;
  /** Per-account minimum-balance floor in DOLLARS.
   *  When set and positive, the strategy-aware drawdown engine never takes a
   *  DISCRETIONARY withdrawal that would drop this account below the floor — the
   *  account contributes only `max(0, balance − floor)` to each year's draw
   *  (surplus above the floor re-enters automatically when returns lift
   *  the balance). Enforced ONLY on floor-eligible accounts
   *  (`taxTreatment ∈ {POST_TAX, HSA}`); an entry on a PRE_TAX/Roth account
   *  is ignored by the engine predicate. For HSA the `floorHsaMode` field
   *  governs the medical-vs-emergency interaction. Absent / 0 ⇒ no floor.
   *  RMD forced draws are NOT floor-limited (eligible types carry no RMD). */
  readonly floorDollars?: number;
  /** HSA floor mode. Only meaningful on an HSA
   *  account with a positive `floorDollars`. `'emergencyOnly'` (default): the
   *  floor blocks only the emergency-reserve draw (PASS B, compared against the
   *  POST-PASS-A balance); medical-qualified draws (PASS A) always proceed.
   *  `'strict'`: the floor blocks ALL HSA draws including medical (PASS A and
   *  PASS B). Ignored for POST_TAX accounts. */
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
}

/** Per-bucket gain detail. Emitted by the runner post-pass under
 *  allocation as a DERIVED estimated return attribution — `gain` is the
 *  total gain split by the year's glide growth share, NOT a realized
 *  per-bucket placement. Feeds the growth/income Gains tooltip. */
interface DrawdownBucketYear {
  gain: number;
}

/** Per-account year row emitted only when the engine ran the
 *  per-account branch. */
export interface DrawdownAccountYear {
  readonly balance: number;
  readonly preEnd: number;
  readonly postEnd: number;
  readonly withdrawn: number;
  readonly deposit: number;
  /** Dec 31 balance of the prior year's pre-tax sub-bucket, captured during
   *  representative-run build as `accPre[a][endStep-12]` (or `initialPre` when
   *  `endStep-12 < 0`). Used by the MC RMD post-pass to derive the correct RMD
   *  base for the accumulation→drawdown boundary year when the prior row is a
   *  pre-retirement row (no `accountBalances`). Absent on rows produced by
   *  `drawdown-engine.ts` (strategy path). */
  readonly priorPreEnd?: number;
  /** Withdrawn portion attributable to the pre-tax sub-bucket.
   *  Sum of pre + post equals `withdrawn` (within fp residue). Populated
   *  by the year-by-year per-account strategy-aware path. Absent on
   *  legacy callers that carry no per-account split. */
  readonly preWithdrawnCents?: number;
  /** Withdrawn portion attributable to the post-tax sub-bucket.
   *  Same provenance + caveats as `preWithdrawnCents`. */
  readonly postWithdrawnCents?: number;
  /**
   * Portion of this HSA account's current-year withdrawal funded against
   * modeled `isMedical` demand (the medical-qualified pass), in INTEGER
   * CENTS. Tax-free / qualified by construction (medical-category draws are
   * 100% §223-qualified, an approximation). Populated only for HSA-treatment
   * accounts on the per-account strategy + kernel paths; absent / 0 on
   * non-HSA accounts and legacy callers.
   *
   * RESIDUAL-ALLOCATION RULE: `medicalQualifiedWithdrawnCents` plus the
   * emergency/nonmedical HSA cents (the committed HSA withdrawal minus this
   * field) sum EXACTLY to the account's committed HSA withdrawal cents
   * (`round(withdrawn * 100)`). The emergency portion is the residual —
   * never independently rounded — so the two buckets reconcile to the cent.
   * The tax pass derives the emergency portion as
   * `round(withdrawn*100) − medicalQualifiedWithdrawnCents`.
   */
  readonly medicalQualifiedWithdrawnCents?: number;
}

/** Withdrawn cents from one account row that COUNT TOWARD that account's required
 *  minimum distribution (SECURE 2.0 §325). Applied consistently by
 *  `hasRmdShortfall` (withdrawal-guidance-data.ts), the deterministic engine's
 *  `derivePerAccountRmdShortfallCents` (balance-projection-runner-tax-helpers.ts)
 *  and the MC RMD post-pass (monte-carlo-rmd.ts) so no surface can drift.
 *
 * - PRE_TAX: full `withdrawn` counts (accurate for pure pre-tax accounts).
 * - MIXED: only the pre-tax tranche (`preWithdrawnCents`) counts. The
 *   designated-Roth sub-account is a SEPARATE account for §401(a)(9) purposes and
 *   is itself RMD-exempt (SECURE 2.0 §325), so a draw from it cannot satisfy the
 *   pre-tax sub-account's minimum — which is exactly the minimum the engine sized
 *   for this row. Falls back to 0 when the field is absent (defensive — fresh
 *   kernel-path rows always carry the split; the `?? 0`
 *   covers only transient stale cache rows and is conservative: it surfaces rather
 *   than hides a shortfall, the safe direction for an RMD-compliance nudge).
 * - PURE Roth (POST_TAX / ROTH): the full `withdrawn` counts. A living owner's
 *   Roth account carries no RMD at all, so nothing is ever compared against it —
 *   but a BENEFICIARY of an INHERITED Roth account IS subject to post-death
 *   distributions (§401(a)(9)(B)), which are admitted into `perAccountRmdCents`.
 *   What satisfies that requirement is the DISTRIBUTION AMOUNT, not its tax
 *   treatment: the beneficiary must take the money out; that it comes out untaxed
 *   does not mean the requirement went unmet. Returning 0 here left such an
 *   account flagged as short in EVERY year forever, with no disclosure branch able
 *   to explain it.
 * - HSA: 0 — never RMD-subject, inherited or not. */
export function rmdEligibleWithdrawnCents(
  row: DrawdownAccountYear,
  taxTreatment: AccountTaxTreatment,
): number {
  if (taxTreatment === 'PRE_TAX') return Math.round(row.withdrawn * 100);
  if (taxTreatment === 'MIXED') return row.preWithdrawnCents ?? 0;
  if (taxTreatment === 'POST_TAX' || taxTreatment === 'ROTH') {
    return Math.round(row.withdrawn * 100);
  }
  return 0;
}

export interface DrawdownYear {
  year: number;
  balance: number;
  withdrawn: number;
  netNeed: number;
  growth: number;
  deposit: number;
  depleted: boolean;
  /** Estimated growth/income gain attribution under allocation — DERIVED
   *  by the runner post-pass (`growthBucket.gain = nonCbpGain × growthShare`,
   *  `incomeBucket.gain = year.growth − growthBucket.gain`), feeding the Gains
   *  tooltip. Absent without an allocation override. NOT a realized per-bucket
   *  placement (the engine is allocation-agnostic). */
  growthBucket?: DrawdownBucketYear;
  incomeBucket?: DrawdownBucketYear;
  /** Target growth share (`targetGrowthShareForStep`) for the year, used to
   *  derive the estimated growth/income gain split above. Absent without an
   *  allocation override. */
  growthPct?: number;
  accountBalances?: ReadonlyMap<string, DrawdownAccountYear>;
  /**
   * Per-owner year-END pre-tax (RMD-eligible) sub-bucket totals, in INTEGER
   * CENTS, indexed by `input.owners` position. Sparse-optional — ABSENT on
   * accumulation rows (same phase-discriminator pattern as `accountBalances`)
   * and on every non-strategy-aware caller; populated ONLY by
   * `runYearByYearStrategyAware`'s retirement-year loop from per-account balance
   * state. Sums each owner's qualifying pre-tax sub-buckets (traditional IRA,
   * 401k/403b/457b/TSP pre-tax portion, RETIREMENT_CASH_BALANCE PRE_TAX/MIXED);
   * MIXED accounts contribute only their pre-tax sub-bucket (SECURE 2.0 §325);
   * Roth, brokerage, and HSA contribute 0. Consumed by `monte-carlo-fill-
   * conversion.ts` to build the per-year `priorPreTaxByOwner` basis for
   * `computeMcRmdFloorCents` (the per-owner RMD floor), replacing the legacy
   * whole-portfolio synthetic floor. */
  preTaxCentsByOwnerIdx?: readonly number[];
  /**
   * Per-owner ALREADY-RESOLVED required-withdrawal cents for the FOLLOWING
   * tax year, indexed by the same owner position as `preTaxCentsByOwnerIdx`, for
   * the accounts that carry recorded RMD facts (and are therefore EXCLUDED from
   * the pooled pre-tax basis above: an inherited beneficiary schedule, a
   * still-working deferral, a Table II sole-spouse divisor, or a withheld result
   * cannot be expressed as a pooled Uniform-Lifetime balance). Produced by the
   * shared `computeRmd` engine via `buildMcFactRmdRequiredCentsByOwnerIdx`, so the
   * FUNDED Monte Carlo floor and the deterministic engine apply the same rules.
   * Sparse-optional and ABSENT for a household that records no RMD facts, keeping
   * such a run byte-identical. */
  factRmdRequiredCentsByOwnerIdx?: readonly number[];
  // Tax-integration fields — populated by applyTaxIntegrationToDrawdownYears
  // for every named strategy.
  // Absent only on legacy callers that don't run the post-pass.
  /** Federal income tax owed for the year, in integer cents. */
  federalTaxCents?: number;
  /** Taxable portion of gross SS benefits per IRS §86, in integer cents. */
  taxableSsCents?: number;
  /** §86 tier applied: 'none' / 'fifty' / 'eighty-five'. */
  ssTaxationTier?: 'none' | 'fifty' | 'eighty-five';
  /** RMD floor enforced for the year, in integer cents. */
  rmdFloorCents?: number;
  /** Portion of RMD not met by portfolio withdrawals (emergency cash), in integer cents. */
  rmdShortfallCents?: number;
  /**
   * Per-account required RMD for the year, in integer cents, keyed by account
   * id (BOTH household owners merged — ids are unique across owners). A
   * decomposition of `rmdFloorCents`: `Σ values === rmdFloorCents` over the
   * qualifying accounts within a ≤ 1-cent largest-remainder tolerance (NOT
   * independent math). RMD applies only to pre-tax / MIXED-pre-tax sub-buckets,
   * so Roth-designated (§325), HSA, and taxable accounts never appear. The map
   * is `{}` in an applicable year where no account carries a qualifying balance,
   * and ABSENT below the owner's SECURE 2.0 trigger age (no RMD yet).
   *
   * DISPLAY-ONLY, DETERMINISTIC-ONLY: stamped solely by the deterministic tax
   * post-pass (`applyTaxIntegrationToDrawdownYears`, same site as
   * `rmdFloorCents`) from the already-computed `result.rmdPerAccountCents`. It is
   * never set on the strategy-engine / kernel / Monte-Carlo paths, so it never
   * reaches the serialized MC representative-run capture — hence no
   * `ENGINE_VERSION` bump and no MC fixture re-pin (test-enforced no-leak guard).
   * Consumed by the Projected withdrawals page to present the RMD by legal
   * aggregation group.
   */
  perAccountRmdCents?: Record<string, number>;
  /** RMD surplus (forced withdrawal beyond the year's net need) REINVESTED into
   *  a real POST_TAX-non-Roth account, in integer cents. Disposition split with
   *  `rmdOverflowToCashCents`: a household either has a real taxable landing
   *  account (this field) or it does not (the held-as-cash field) — at most one
   *  is non-zero per run. Stays in the portfolio (flows through
   *  `DrawdownAccountYear.deposit` so the cost-basis accumulator credits it).
   *  The full forced RMD remains ordinary taxable income regardless of where the
   *  surplus lands (classified `preTaxWithdrawalDollars`, never netted out).
   *  Populated by the per-account strategy path. */
  rmdReinvestedCents?: number;
  /** RMD surplus HELD AS CASH — credited to a synthetic POST_TAX cash-like
   *  account materialized in the engine when the household has no real
   *  POST_TAX-non-Roth account to reinvest into. PRESERVED in the projected
   *  balance (not dropped): the held cash grows 0%, carries $0 MAGI / tax-free,
   *  and is spent first (before any pre-tax draw) in later years. The full
   *  forced RMD is still ordinary taxable income (the surplus disposition does
   *  not change the tax). Populated by the per-account strategy path. */
  rmdOverflowToCashCents?: number;
  /** Total household Medicare IRMAA surcharge for the year, in integer cents. */
  irmaaSurchargeCents?: number;
  /** IRMAA tier applied: 'none' | 'tier1'…'tier5'. */
  irmaaTier?: 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';
  /** ACA PTC subsidy received for the year, in integer cents. */
  acaPtcSubsidyCents?: number;
  /** ACA PTC eligibility tier. */
  acaPtcTier?: 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';
  /**
   * Dollars of pre-tax withdrawal that exceeded the MAGI cap this year.
   * Two breach paths populate this field:
   *   1. Taxable depletion — cap-aware tier loop tried to route
   *      over-cap pre-tax dollars to later taxable accounts but no later
   *      taxable balance remained; the residual lands here.
   *   2. Mandatory RMD floor — pre-loop RMD enforcement forced
   *      pre-tax dollars above `magiCeilingAnnualDollars`; the excess
   *      (RMD-required pre-tax minus available cap room) lands here.
   * Zero or absent = cap fully honored (or cap not active this year).
   */
  magiCapBreachDollars?: number;
  /**
   * Dollars routed from the cap-active tier to a later-tier taxable
   * account via skip-ahead. Non-zero only when the engine found a
   * taxable account in a later tier to absorb the cap-excess. When
   * non-zero, `magiCapBreachDollars` is 0 for the same year.
   */
  magiCapTierOverrideDollars?: number;
  /**
   * Dollars moved from a pre-tax / MIXED-pre bucket into the user-designated
   * target Roth via a Fill-mode auto-conversion this year, in integer cents.
   * A conversion is an INTERNAL TRANSFER (pre-tax → Roth), not a
   * Portfolio Flow — it is taxed as ordinary income (raising both divergent
   * MAGIs) but never charted as income / inflow. Populated only on the
   * per-account strategy path while a MAGI cap is active under Fill mode;
   * zero / absent under Minimize, with no cap, after `capOffYear`, or in an
   * RMD-breach year.
   */
  rothConvertedCents?: number;
  /**
   * True for a year where Fill mode was active with leftover cap headroom but
   * NO target Roth could be resolved (none designated, or the designated id is
   * dangling / deleted / non-Roth) — so the engine degraded to withdrawal-only
   * fill and converted $0. Drives a user-facing "no target Roth"
   * notice. Absent when a conversion ran or Fill mode was inactive.
   */
  rothConversionDegradedNoTarget?: boolean;
  /** Household MAGI for the year, in integer cents. */
  magiCents?: number;
  /** Household MAGI as a percentage of FPL (e.g. 250 = 250%). */
  fplPercentage?: number;
  /** Effective federal tax rate: totalTax / grossIncome (0–1). */
  effectiveTaxRate?: number;
  /** Net withdrawal after deducting federal tax and adding PTC subsidy, in integer cents. */
  netAfterTaxCents?: number;
  /** True when the tax year was extrapolated beyond the latest snapshot year. */
  taxYearExtrapolated?: boolean;
  // Tax-cashflow fields — populated by the annual solver when tax
  // cashflow is funded for the year (every named strategy).
  // Absent on legacy callers that don't thread the solver.
  /** Federal income tax funded as a same-year cash need, in integer cents. */
  federalTaxCashNeedCents?: number;
  /** IRMAA surcharge withheld from Social Security (no cash draw), integer cents. */
  irmaaWithheldFromSsCents?: number;
  /** IRMAA surcharge paid as a same-year cash need, integer cents. */
  irmaaCashNeedCents?: number;
  /** ACA PTC offset applied against the tax cashflow need, integer cents. */
  acaPtcCashflowOffsetCents?: number;
  /** The part of the ACA credit that lowered the year's portfolio draw because
   *  the premium is a modeled Medical expense, integer cents. Not part of
   *  `totalTaxCashflowNeedCents`: the net effect on the draw is that need minus
   *  this. */
  acaCreditAppliedToPremiumsCents?: number;
  /** Total same-year tax cashflow need funded into the withdrawal target,
   *  integer cents: `max(0, federalTax + irmaaCash − acaPtcOffset)`. */
  totalTaxCashflowNeedCents?: number;
  /** Number of solver passes executed for the year (1..8). */
  taxCashflowIterations?: number;
  /** True when the solver's net tax cost converged before the pass cap. */
  taxCashflowConverged?: boolean;
  /** Dollars of the grossed-up withdrawal the portfolio could NOT supply,
   *  integer cents. Zero when fully fundable. */
  taxCashflowShortfallCents?: number;
  // Early-withdrawal / HSA additional-tax fields — populated by
  // the post-pass annotation against the committed `accountBalances`. Already
  // INCLUDED in `federalTaxCents`; surfaced separately for the year table.
  /** IRA/401k-style 10% early-distribution additional tax, integer cents. */
  earlyWithdrawalPenaltyCents?: number;
  /** HSA 20% additional tax on nonqualified pre-65 withdrawals, integer cents. */
  hsaAdditionalTaxCents?: number;
  /** True when a penalizable account's owner birthdate was missing/unparseable,
   *  so its penalty was skipped — surfaced in the estimate note. */
  penaltySkippedForMissingBirthdate?: boolean;
  // The fact-based RMD disclosures the shared engine produced for
  // this year (`TaxYearResult.rmdWithheldAccounts` / `…StillWorkingDeferred…` /
  // `…FirstYearDeferrals` / `…DeferredCatchUpCents`), stamped by the
  // DETERMINISTIC post-pass only. The Projected-withdrawals page turns them into
  // plain-English per-year notes, so the engine's authoritative "this account's
  // required withdrawal is on hold / deferred" truth reaches the user instead of
  // being re-derived by a looser UI predicate.
  /** Account ids whose required withdrawal is WITHHELD this year (a required
   *  inherited-account fact is missing / an unsupported combination), each
   *  contributing $0 to `rmdFloorCents`. */
  rmdWithheldAccountIds?: readonly string[];
  /** Account ids whose required withdrawal is deferred this year by the
   *  §401(a)(9)(C) still-working exception (a legitimate $0, not a blocker). */
  rmdStillWorkingDeferredAccountIds?: readonly string[];
  /** Account ids whose FIRST required withdrawal is deferred to April 1 of the
   *  following year, so that year carries two. */
  rmdFirstYearDeferredAccountIds?: readonly string[];
  /** Deferred-from-the-prior-year required withdrawal folded into this year's
   *  `rmdFloorCents`, integer cents (the "two in one year" consequence). */
  rmdDeferredCatchUpCents?: number;
  /**
   * Qualified Charitable Distribution (QCD) total directed from the owner's
   * source IRA this year, in integer cents. The first-dollars,
   * non-spending slice of the source-IRA draw: it leaves the portfolio exactly
   * once (subtracted from the forced-RMD base, never reinvested as surplus) and
   * is excluded from ordinary income / MAGI before §86 + across both MAGI lines.
   * Populated by the 70½-gated QCD forced-outflow pass on the per-account
   * strategy path (gated on the 70½ floor only, independent of the RMD trigger
   * age); absent / 0 when no QCD applies.
   */
  qcdCents?: number;
  /**
   * Net TAXABLE required minimum distribution after the QCD offset, in integer
   * cents: `gross IRA-pool RMD − min(Q, gross)` summed across owners.
   * DISPLAY-ONLY — the taxable RMD the user still owes income tax on once the
   * QCD satisfies part of the IRA-pool minimum. Populated alongside `qcdCents`
   * on the per-account strategy path; absent when no QCD applies.
   */
  netTaxableRmdCents?: number;
  /**
   * Per-OWNER QCD RMD offset for this year (integer cents,
   * `min(Q_owner, grossIraPoolRmd_owner)`), keyed by owner id. The QCD
   * is debited directly to the source IRA's pre-tax bucket (never written to
   * `accountBalances[*].withdrawn`) and counts toward the owner's IRA-pool RMD
   * (IRC §408(d)(8)), so the deterministic tax post-pass credits this offset
   * toward the owner's IRA aggregation pool when computing `rmdShortfallCents` —
   * otherwise an over-RMD QCD year reports a phantom missed RMD. Scoped to the
   * IRA pool ONLY; never the 401k/457/TSP/CBP pools. Populated alongside
   * `qcdCents` on the per-account strategy path; absent when no QCD applies.
   */
  qcdRmdOffsetCentsByOwner?: Readonly<Record<string, number>>;
  /**
   * The EXACT cumulative inflation factor (base = the projection's base year)
   * the engine used to inflate the REAL annual QCD amount to nominal `qcdCents`
   * this year. Both engines anchor at the year END: deterministic uses the
   * December `inflationFactorAt` factor, Monte Carlo representative the path's
   * year-END `cumCpi` (whichever engine produced the row). DISPLAY-ONLY companion
   * to `qcdCents`: the today's-dollars QCD surfaces reverse the gift EXACTLY with
   * `qcdCents ÷ qcdInflationFactor` so a configured $10k REAL QCD displays
   * $10,000 (uncapped) / the capped nominal ÷ this same factor (capped). Under a
   * deterministic basis this equals the year-end `viewDeflator(y, 11)` reversal,
   * but the stamped factor stays authoritative — under MC it is the path's OWN
   * CPI, not the display basis. Populated alongside `qcdCents` on the
   * per-account strategy path (deterministic + MC representative replay); absent
   * when no QCD applies.
   */
  qcdInflationFactor?: number;
  /** True when this year's IRMAA look-back MAGI was ESTIMATED from the
   *  engine's projected first-year MAGI (`magiBuffer[0]`) because the member is
   *  on Medicare in projection year 0 or 1 and no stored two-years-prior MAGI
   *  bootstrap was provided. Drives the projected-first-year-MAGI disclosure in
   *  `BalanceProjectionEstimateNote`. Set even when the estimate falls back to
   *  $0 (below the calibration floor) so the disclosure always fires. */
  magiEstimatedFromProjection?: boolean;
  /** True when this year is charged a Medicare income-related
   *  surcharge (IRMAA) while the plan models NO medical spending at all in any
   *  month. The base Medicare premium, Medigap / Advantage and drug-plan
   *  premiums are user-entered medical expenses (never modeled automatically),
   *  so this combination means the plan is understating retirement health costs.
   *  Drives the readiness warning in `BalanceProjectionEstimateNote`. Deliberately
   *  NOT set when the plan records ANY medical spending — the projection cannot
   *  tell whether that amount includes the base premium, and a guess in either
   *  direction would be an unlabeled assumption. */
  medicareBasePremiumMissing?: boolean;
}

export interface DrawdownOutput {
  years: DrawdownYear[];
  depletionYear: number | null;
  perMonthWithdrawal: Float64Array;
}
