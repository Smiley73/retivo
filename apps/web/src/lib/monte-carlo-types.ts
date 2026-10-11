/**
 * Public type surface for the Monte Carlo engine.
 *
 * Extracted from `monte-carlo.ts` to keep the implementation file under the
 * shape cap. All symbols re-exported from `monte-carlo.ts`
 * so consumer import paths are unchanged.
 */
import type { RmdAccountProfileFacts } from './rmd';
import type {
  AssetMix,
  AccountTaxTreatment,
  AccountType,
  DownturnGuardrailsOverride,
  MagiCapOverride,
} from '../db/types.js';
import type { McTaxContext } from './monte-carlo-tax.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';

/**
 * Monte Carlo scenario basis (representative-run tier). Selecting one on the
 * Balance Projection page drives every per-year surface that varies with
 * market/inflation luck from a single coherent representative run:
 *   - `mc-typical`      → the path at the P50 real-ending-balance rank.
 *   - `mc-pessimistic`  → the path at the P25 real-ending-balance rank.
 *   - `mc-bad-luck`     → the path at the P10 real-ending-balance rank.
 *
 * Independent of `ProjectionMethod` ('planned' | 'twr'): the per-account
 * table, the Account Balance Stack, and the income-breakdown chart hold the
 * last deterministic method (the MC engine runs a single pooled portfolio,
 * so there is no per-account MC detail).
 */
export type McBasis = 'mc-typical' | 'mc-pessimistic' | 'mc-bad-luck';

/**
 * A representative simulated run (the path at a P10/P25/P50 real-ending-
 * balance rank, deterministic pathIndex tie-break) replayed under full
 * per-year capture. Mirrors the page's `DrawdownByMethodResult` shape
 * (`years` carrying nominal `DrawdownYear` rows + `depletionYear` +
 * `perMonthWithdrawal`) so the page's year-by-year / cashflow / portfolio-
 * flow / tax-burden surfaces consume it through the same builders the
 * deterministic methods use.
 *
 * Carries BOTH nominal (on the `DrawdownYear` rows) AND real (today's-
 * dollar) per-year balance + growth, deflated by the PATH'S OWN sampled CPI
 * (NOT the scenario's deterministic deflator — a high-inflation path sees
 * its real balance compressed). The today/future display toggle picks
 * the right series with no engine re-run. `realBalanceByYear[i]` /
 * `realGrowthByYear[i]` index the calendar year `firstYear + i`, same length
 * and alignment as `years`. `seed` is the path's replay seed (derivable from
 * its `pathIndex`); surfaced for parity / reproducibility.
 */
export interface RepresentativeRun {
  readonly firstYear: number;
  readonly seed: number;
  /** Per-year drawdown rows in NOMINAL dollars (same shape the deterministic
   *  methods expose). `balance` / `withdrawn` / `growth` / `netNeed` /
   *  `depleted` + the tax cents are captured from the replayed path.
   *
   *  Each DRAWDOWN-PHASE row additionally carries `accountBalances` (the
   *  per-account year-end pre/post sub-bucket balances + per-account withdrawal,
   *  same `DrawdownYear.accountBalances` contract the deterministic path uses —
   *  `drawdown-engine-types.ts`) plus `rmdFloorCents` / `rmdShortfallCents`
   *  populated by the `monte-carlo-rmd.ts` post-pass (per-owner IRS floor on the
   *  prior-year `preEnd` sub-bucket, per-account shortfall against the IRS pool
   *  minimum). The
   *  per-owner RMD grouping keys on `MonteCarloAccountLedger.ownerId` (an account
   *  with no `ownerId` buckets under its own id — its own owner). Pre-retirement
   *  accumulation rows carry no `accountBalances` / RMD fields (the
   *  `resolvedDrawdown` adapter slices them off before chart consumption). These
   *  fields are present only after the capture replay runs (absent in
   *  `successOnly` mode, which skips the replay). All three are optional on
   *  `DrawdownYear`. */
  readonly years: ReadonlyArray<DrawdownYear>;
  readonly depletionYear: number | null;
  readonly perMonthWithdrawal: Float64Array;
  /** Per-year real (today's-dollar) balance, deflated by the path's own CPI.
   *  Index = calendar year offset from `firstYear`. */
  readonly realBalanceByYear: number[];
  /** Per-year real (today's-dollar) investment growth, deflated by the
   *  path's own CPI. Index = calendar year offset from `firstYear`. */
  readonly realGrowthByYear: number[];
  /** Per-year real-deflation FACTOR (`1 / cumCpi` at year-end) — the exact
   *  reciprocal that produces `realBalanceByYear[i] = years[i].balance *
   *  realFactorByYear[i]`. The Balance Projection page's basis-aware
   *  `basisDeflator` multiplies each MC-sourced nominal display cent by this
   *  factor so every MC display surface (RMD / tax / Roth / surplus / account
   *  stack / portfolio flow / cashflow) deflates by the path's OWN CPI,
   *  consistent with the MC balance LINE — NOT the scenario's flat
   *  `viewDeflator`. Allocated over the full indexed domain where
   *  `realBalanceByYear` is computed (kernel path `[0, horizonYears)`; strategy
   *  path `[0, horizonYears)` with the unused tail `[years.length, horizonYears)`
   *  left at zero, never indexed — consumers key by calendar year over the run's
   *  own `years`). Index = calendar year offset from `firstYear`. */
  readonly realFactorByYear: number[];
  /** Per-account year-end balances for the PRE-RETIREMENT (accumulation) years
   *  of this run. Each entry is one accumulation calendar year carrying a
   *  per-account map in the SAME `DrawdownAccountYear` shape the drawdown-phase
   *  rows use, but populated with STACKING FIELDS ONLY (`balance` / `preEnd` /
   *  `postEnd`; `withdrawn` / `deposit` are 0; no tax / RMD / conversion cent
   *  fields). Captured in-place from the kernel's already-computed accumulation
   *  arrays (`accountPreEnd` / `accountPostEnd`) — no extra RNG draw, no second
   *  traversal. Enables the Account Balances "over time" stacked chart to draw
   *  the saving-years segment from the SAME displayed representative path under a
   *  Monte Carlo basis. Deliberately a SEPARATE additive field, NOT
   *  populated onto `years[]`: the `years[]` accumulation rows still carry no
   *  `accountBalances`, so every presence-based accumulation-vs-drawdown phase
   *  discriminator (`monte-carlo-rmd.ts`, `monte-carlo-tax-burden.ts`, the
   *  Balance Projection chart filters) stays valid.
   *  Absent when the run was not captured (e.g. `successOnly` mode) or when the
   *  run has no pre-retirement years. */
  readonly accumulationAccountBalances?: ReadonlyArray<{
    readonly year: number;
    readonly accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }>;
  /**
   * Account ids whose distributions are made on account of the ORIGINAL
   * owner's death (inherited accounts). §72(t)(2)(A)(ii) waives their 10%
   * additional tax at any beneficiary age, so the DISPLAYED tax matches the funded
   * per-path tax (which resolves the same per-source exemption from
   * `mcRmdContext.rmdFactsByAccountId`). Absent → none inherited.
   */
  readonly deathExemptAccountIds?: readonly string[];
}

/**
 * Dated portfolio-addition event applied by the MC kernel.
 *
 * Routing convention (applied inside `buildStepInputs`):
 *   - `month < retirementStepIdx`  → folded into `contribPost[month]`
 *   - `month >= retirementStepIdx` → folded into `deposit[month]`
 */
export interface MonteCarloPortfolioEvent {
  /** Step index where the event lands (0 = January of `firstYear`). */
  readonly month: number;
  /** Dollar amount added to the portfolio at `month` (nominal). For a
   *  `secondaryContribution` this is the summed `amountPre + amountPost`
   *  (the value the kernel reads). */
  readonly amount: number;
  /** Pre-tax slice of a `secondaryContribution` (post-primary spouse
   *  contribution). Carried so the named-strategy ledger routes it to the
   *  destination account's `pre` bucket. Undefined for CBP / one-off events. */
  readonly amountPre?: number;
  /** Designated-Roth (post-tax) slice of a `secondaryContribution` — routed to
   *  the destination's `post` bucket regardless of treatment (§325). Undefined
   *  for CBP / one-off events. */
  readonly amountPost?: number;
  /** Event origin tag for diagnostics + caller correlation. */
  readonly source: 'cbpLumpSum' | 'targetedOneOff' | 'secondaryContribution';
  /** Optional account id when the event ties back to a specific account. */
  readonly targetAccountId?: string;
}

/**
 * Per-account ledger entry consumed by the MC runner (per-account
 * sampling). Shape matches `AccountMcLedgerEntry` in
 * `balance-projection-bundle.ts`; redeclared here so the engine module
 * stays free of bundle-layer imports.
 */
export interface MonteCarloAccountLedger {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  readonly contribPre: Float64Array;
  readonly contribPost: Float64Array;
  /** Summed post-retirement deposit dollars (kernel reads this). */
  readonly deposit: Float64Array;
  /** Post-primary spouse contribution PRE-tax slice (named-strategy slice
   *  only). Optional — absent on pre-feature / hand-rolled test ledgers. */
  readonly depositPre?: Float64Array;
  /** Post-primary spouse contribution POST-tax (designated-Roth) slice
   *  (named-strategy slice only; always → `post`, §325). Optional. */
  readonly depositPost?: Float64Array;
  readonly assetMix: AssetMix | null;
  /** Per-step glide-derived mix; when present, overrides flat `assetMix`
   *  per step. Matches `AccountMcLedgerEntry.assetMixSeries`. */
  readonly assetMixSeries: ReadonlyArray<AssetMix> | null;
  readonly cbpPlanningReturnPct: number | null;
  /**
   * Account tax treatment. Drives per-account withdrawal
   * classification for the MC tax cashflow: PRE_TAX → ordinary income,
   * ROTH → tax-free, POST_TAX → taxable basis by `accountType`, MIXED →
   * split by the account's current pre/post bucket ratio. Roth is routed by
   * `taxTreatment === 'ROTH'` (treatment-based, not by account type).
   * `undefined` on a ledger built without tax metadata (e.g. a test
   * fixture) — the engine then falls back to the all-pre-tax
   * classification.
   */
  readonly taxTreatment?: AccountTaxTreatment;
  /**
   * Account type. Splits POST_TAX-non-Roth withdrawals into the
   * LTCG/QDI proxy (`BROKERAGE` / `OTHER`) vs cash-like return-of-principal
   * (`SAVINGS` / `MONEY_MARKET` / `CD` / `HSA`). Roth is identified by
   * `taxTreatment === 'ROTH'` (not by this type). Mirrors the deterministic
   * `splitWithdrawalsByTaxTreatment` rules. `undefined` → all-pre-tax fallback.
   */
  readonly accountType?: AccountType;
  /**
   * Owning member id. Reserved for per-member tax routing parity with
   * the deterministic pass; the MC per-path tax estimate aggregates household
   * withdrawals, so it is carried for completeness + future per-member splits.
   */
  readonly ownerId?: string;
  /**
   * Contribution-growth mode for the planned base contribution series.
   * `'fixed'` → the explicit
   * growth is already baked into `contribPre`/`contribPost`; `'tracks-
   * inflation'` → the series is a today's-dollars base the runner scales by
   * each path's own `cumCpi[i]` so the contribution holds real value on
   * every inflation path. `undefined` on a ledger built without growth
   * metadata (e.g. a test fixture) → treated as flat-nominal (no
   * per-path scaling).
   */
  readonly contribGrowthMode?: 'tracks-inflation' | 'fixed';
  /**
   * Planned-only post-tax contribution base (today's dollars), captured
   * before any targeted event dollars routed onto `contribPost`. Present
   * only for `'tracks-inflation'` accounts — the runner CPI-scales exactly
   * this planned portion per path, leaving routed nominal event dollars
   * untouched. `null` / absent → no per-path scaling of the post-tax
   * series.
   */
  readonly plannedContribPostBase?: Float64Array | null;
  /**
   * Per-account minimum balance floor.
   * Eligible when `taxTreatment ∈ {POST_TAX, HSA}`. Absent / undefined = no
   * floor. Sanitized by `resolveAccountFloorsForScenario` (CWE-20: non-finite
   * or negative → no floor; non-'strict' hsaMode → 'emergencyOnly').
   */
  readonly floorDollars?: number;
  /** HSA draw-mode when `floorDollars` is set. Absent = 'emergencyOnly'. */
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
}

/**
 * Minimal RMD metadata threaded into `MonteCarloInput`. Used by the
 * `applyMcRmdToRepresentativeYears` post-pass to populate `rmdFloorCents` /
 * `rmdShortfallCents` on representative-run drawdown rows.
 *
 * `MonteCarloInput.taxContext` carries the same data for named strategies; this
 * field is the fallback used when `taxContext` is absent (injected-return /
 * unit-test runs that thread RMD data without a full tax context).
 */
export interface McRmdContext {
  readonly members: McTaxContext['members'];
  readonly rmdSnapshot: McTaxContext['taxBundle']['rmd'];
  readonly primaryDeathYear?: number;
  readonly secondaryDeathYear?: number;
  /**
   * Per-ACCOUNT normalized RMD profile facts, as a plain `Record` (NOT a
   * `Map`: `JSON.stringify(new Map())` is `{}`, which would make the facts
   * invisible to `mcCacheKey` and let two households with different beneficiary
   * facts share one cached summary).
   *
   * Routed into the SHARED `computeRmd` engine, so the MC representative RMD
   * floor/shortfall selects the same Table I/II/III, honours the same
   * still-working exception and first-year deferral, and WITHHOLDS on the same
   * incomplete inherited facts as the deterministic engine. Accounts with no
   * recorded fact are omitted, keeping a fact-free household unchanged.
   */
  readonly rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>;
  /** Each owner's separation-from-service calendar year, keyed by member id.
   *  Resolves the §401(a)(9)(C) later-of first-distribution year; an owner absent
   *  here WITHHOLDS that resolution rather than assuming the trigger-age year. */
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
}

/**
 * SERIALIZABLE per-path Qualified Charitable Distribution context.
 * The MC engine rebuilds the engine's `QcdContextInput` per path INSIDE
 * `runOnePathViaStrategyEngine`, inflating each REAL annual amount by the PATH'S
 * OWN cumulative CPI (`cumCpi`) and resolving the indexed per-person §408(d)(8)
 * limit per tax year (inflation-extrapolated forward by `scenarioInflationPct`).
 * Carries only plain (structured-clone-safe) data — no closures, no `Map` — so
 * it survives `postMessage` to the Worker AND the `JSON.stringify` cache key
 * (`firstEligibleYearByOwner` is a plain `Record`, NOT a `Map` whose
 * `JSON.stringify` is `{}`). Absent when no QCD resolved → the
 * MC path is identical to a no-QCD run.
 */
export interface McQcdContext {
  /** Resolved QCD directives across both owners (engine groups by `memberId`).
   *  Same plain shape the engine's `QcdContextEntry` consumes. */
  readonly entries: ReadonlyArray<{
    readonly memberId: string;
    readonly sourceAccountId: string;
    /** REAL (today's-dollars) annual amount; the engine inflates it to nominal
     *  per path-year via the path's own `cumCpi`. */
    readonly annualAmountDollars: number;
    /** First active tax year (inclusive) — already clamped to the 70½ floor. */
    readonly startYear: number;
    /** Exclusive end tax year (active THROUGH `endYear − 1`). */
    readonly endYear: number;
  }>;
  /** Owner-id → first 70½-eligible tax year as a plain `Record` (a `Map`
   *  JSON-stringifies to `{}`, colliding cache keys). An owner absent here
   *  is skipped (no pre-70½ outflow). */
  readonly firstEligibleYearByOwner: Readonly<Record<string, number>>;
  /** Annual scenario inflation rate (percent) — the limit is INDEXED, so years
   *  past the latest published §408(d)(8) figure are extrapolated forward by
   *  this rate, mirroring the deterministic runner. */
  readonly inflationPct: number;
}

/**
 * Arg bundle for `applyMcTaxToRepresentativeYears`: stamps
 * `federalTaxCents` / `irmaaSurchargeCents` / `acaPtcSubsidyCents` on the
 * representative run's drawdown-phase rows. The named-strategy drawdown funds
 * tax per path upstream (two-pass expense fold); this post-pass
 * stamps only the three DISPLAY tax-cent fields on the representative run.
 * Runs only when a `McTaxContext` is
 * present (the named-strategy discriminant).
 */
export interface McTaxPostPassArgs {
  /** Representative-run drawdown rows (mutated in place). Pre-retirement rows
   *  carry no `accountBalances` and are skipped. */
  readonly years: ReadonlyArray<DrawdownYear>;
  /** Per-account ledger — taxTreatment / accountType per account id. */
  readonly ledger: ReadonlyArray<MonteCarloAccountLedger>;
  /** Per-path tax context (filing status, members, death years, calibration
   *  bundle, MAGI bootstrap, Roth basis, penalty-exemption flags). */
  readonly taxCtx: McTaxContext;
  /** First calendar year of the run (maps `year` → `ssByYear` index). */
  readonly firstYear: number;
  /** Calendar year of household retirement (the drawdown-phase gate). */
  readonly retirementYear: number;
  /** Pre-computed nominal annual SS benefit by year-offset from `firstYear`. */
  readonly ssByYear: ReadonlyArray<number>;
  /** Pre-computed nominal annual non-SS income by year-offset from `firstYear`. */
  readonly incomeByYear: ReadonlyArray<number>;
  /**
   * The calendar year the representative path depleted, or null when
   * it never ran out. The absorbing-depletion clamp zeroes
   * `DrawdownYear.balance` for the depletion year AND every later year, but the
   * depletion year ITSELF had real taxable withdrawals / RMDs / conversions —
   * so its tax must still be stamped. The post-pass skips only STRICTLY-post-
   * depletion years (`year.year > depletionYear`), not the depletion year. Absent
   * / null → the `balance === 0` skip (no depletion on this path).
   */
  readonly depletionYear?: number | null;
  /**
   * The representative run's per-account accumulation balances
   * (`RepresentativeRun.accumulationAccountBalances`), when the run has an
   * accumulation phase. The LAST entry's balances are the drawdown-entry
   * start-of-year buckets for the taxable-income (yield drag / cost basis /
   * cash interest) replay; absent (already
   * retired) → the ledger initial balances seed the first drawdown year.
   */
  readonly accumulationAccountBalances?: ReadonlyArray<{
    readonly year: number;
    readonly accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }>;
  /**
   * Account ids whose distributions are made on account of the ORIGINAL
   * owner's death (inherited accounts). §72(t)(2)(A)(ii) waives their 10%
   * additional tax at any beneficiary age, so the DISPLAYED tax matches the funded
   * per-path tax (which resolves the same per-source exemption from
   * `mcRmdContext.rmdFactsByAccountId`). Absent → none inherited.
   */
  readonly deathExemptAccountIds?: readonly string[];
}

export interface MonteCarloInput {
  /** Household portfolio today (cache-key convenience). */
  readonly portfolioToday: number;
  /** Per-account ledger. */
  readonly accountMcLedger: ReadonlyArray<MonteCarloAccountLedger>;
  /** Sum of annual planned contributions (display + cache-signature). */
  readonly annualContribution: number;
  /** First calendar year of the simulation. */
  readonly firstYear: number;
  /**
   * Month within `firstYear` that "today" falls on (0 = January, 11 =
   * December). The today-anchor for tracks-inflation per-path CPI scaling of
   * planned contributions: the
   * scaled contribution holds its today's-dollars value at
   * `asOfMonth = firstYear*12 + todayMonthIndex`, mirroring the deterministic
   * engine's `(eventMonth − asOfMonth)/12` exponent. Absent → 0 (January),
   * matching `ProjectionInput.todayMonthIndex ?? 0`.
   */
  readonly todayMonthIndex?: number;
  /** Calendar year of household retirement. */
  readonly retirementYear: number;
  /** Last calendar year to simulate (inclusive). */
  readonly horizonYear: number;
  /**
   * Windowed per-month expense base in today's dollars. One entry per
   * projection month, indexed `0 = January of
   * `firstYear``; **length must equal the kernel `stepCount`** (`(horizonYear −
   * firstYear + 1) × 12`) — a construction guard in
   * `balance-projection-runner-mc.ts` and a `runMonteCarlo` boundary guard
   * `throw` on mismatch (no silent `?? 0`, mirroring the `ssByYear` /
   * `injectedReturns` guards). Built from `projectExpensesByMonth` (the SAME
   * deterministic windowing helper the Planned/Historical projection uses), so
   * each expense is charged ONLY in the months its start/end window is active
   * (0 outside any window, incl. pre-retirement). Recurring expenses contribute
   * their run-rate ÷ 12 per active month; one-offs contribute the FULL literal
   * amount in their single spike month (so the per-year roll-up ties to
   * `projectExpensesByYear`). The kernel inflates each month per path: scalar
   * path `expense[i] = monthlyExpenseBase[i] × cumCpi[i]`. Plain-number array →
   * structured-clone-safe. A zero-expense scenario is an all-zero base (valid,
   * not an error).
   */
  readonly monthlyExpenseBase: number[];
  /**
   * Per-effective-inflation-rate windowed expense buckets.
   * Splits `monthlyExpenseBase` into today's-dollar per-month
   * slices grouped by each category's effective inflation rate (percent), so
   * the MC kernel can inflate a faster-growing category (e.g. Medical at
   * general + 2 pp) at its own rate via a per-bucket monthly mean-shift
   * (`(ratePct − scenarioInflationPct)/12` added to `cpiPct`, mirroring
   * `cpiShiftMonthly`). The mean-shift factor is the EXISTING horizon-cumulative
   * factor (cumCpi = 1 at today, never reset at window open); windowing enters
   * ONLY through the today's-dollar per-month `amount[i]`. Bucketed kernel:
   * `expense[i] = Σ_b monthlyExpenseBucketsBase[b].amount[i] × bucketCumCpi[b][i]`.
   * **Each `amount` array length must equal `monthlyExpenseBase.length`** (the
   * same `stepCount` length guard — ragged arrays throw); per step `Σ_b
   * amount_b[i] === monthlyExpenseBase[i]` at round2 cent precision (a per-step
   * residual-adjust pins it).
   *
   * Derived IN-PROCESS from the sanitised `resolveInflationForScenario`
   * map (never raw `categoryRates`), so every `ratePct` is finite + in-range by
   * construction; it is structured-clone-safe (plain numbers) and is NOT
   * persisted or imported, so it needs no re-sanitisation. A single
   * `Number.isFinite` assert at bucket construction (balance-projection-runner-mc.ts)
   * guards the Worker/structured-clone boundary as an invariant check.
   *
   * Emitted ONLY when ≥ 1 category's effective rate differs from the scenario
   * general rate; ABSENT when every category inflates at the general rate (the
   * common case) — the kernel then runs the verbatim scalar `monthlyExpenseBase`
   * loop.
   */
  readonly monthlyExpenseBucketsBase?: ReadonlyArray<{
    readonly ratePct: number;
    readonly amount: number[];
  }>;
  /**
   * Per-month HSA-qualified medical demand BASE in today's dollars (HSA
   * withdrawal reserve) — the per-month sum of the `isMedical`-flagged
   * categories, a STRICT SUBSET of `monthlyExpenseBase` built with identical
   * `(recurring − spike)/12 + spike` monthly bucketing. Same length + indexing
   * as `monthlyExpenseBase`. The kernel/strategy path inflates it per path the
   * SAME way the matching expense uses — by the medical effective rate's
   * cumulative CPI (`medicalDemandRatePct`'s mean-shift over the shared sampled
   * CPI) — then converts to integer cents and feeds it to the engine's
   * medical-first HSA pass. ABSENT when no category is flagged `isMedical` (the
   * medical pass is a no-op; emergency-reserve path intact).
   * Plain-number array → structured-clone-safe; feeds the cache key + seed so
   * distinct medical demand → distinct cache key/seed.
   */
  readonly monthlyMedicalDemandBase?: number[];
  /**
   * Effective inflation rate (percent) the `isMedical` categories grow at
   * (default = general + 2 pp, or the scenario general
   * rate when no medical override). Drives the per-path medical-demand CPI
   * (same mean-shift `(ratePct − scenarioInflationPct)/12` the matching expense
   * bucket uses) so the inflated medical demand stays a subset of the inflated
   * expense. Only meaningful when `monthlyMedicalDemandBase` is present; absent
   * → the scenario general rate. Feeds the cache key + seed.
   *
   * SINGLE-RATE ONLY: when distinct `isMedical` categories carry distinct
   * effective rates, `monthlyMedicalDemandBucketsBase` is emitted instead and
   * inflates each medical sub-series at its OWN rate — this scalar then
   * only describes a single shared rate and the bucketed field wins.
   */
  readonly medicalDemandRatePct?: number;
  /**
   * Per-effective-rate medical-demand buckets — the same per-rate
   * grouping `monthlyExpenseBucketsBase` uses, restricted to the `isMedical`
   * categories. Each bucket's `amount[i]` is today's-dollar medical demand for
   * the categories at that rate; the kernel inflates each bucket at its own
   * `(ratePct − scenarioInflationPct)/12` mean-shift, so `Σ_b` of the inflated
   * medical buckets equals the sum of the inflated per-category medical amounts
   * — keeping medical demand a STRICT SUBSET of the inflated medical expense
   * even when two medical categories differ in rate. Emitted ONLY when the
   * `isMedical` categories span > 1 effective rate; absent ⇒ the single-rate
   * `monthlyMedicalDemandBase` × `medicalDemandRatePct` path runs unchanged.
   * Length per bucket = stepCount.
   */
  readonly monthlyMedicalDemandBucketsBase?: ReadonlyArray<{
    readonly ratePct: number;
    readonly amount: number[];
  }>;
  /** Pre-computed nominal annual SS benefit by year-offset from `firstYear`.
   *  Length must equal `horizonYear - firstYear + 1`. */
  readonly ssByYear: number[];
  /** Pre-computed nominal annual non-SS income by year-offset from `firstYear`.
   *  Same length and indexing as `ssByYear`. */
  readonly incomeByYear: number[];
  /**
   * Subset of `incomeByYear` that tracks CPI (e.g. pensions with COLA =
   * inflation). Per path the engine scales this slice by `cumCpi / deterministicCumCpi`
   * so the path's realized inflation variance shifts those streams proportionally.
   * Absent → all non-SS income uses the pre-computed nominal values.
   * Same length and indexing as `incomeByYear`.
   */
  readonly tracksInflationIncomeByYear?: number[];
  /**
   * Downturn-guardrail config (guardrails; explained in docs/math-projections.md,
   * "Spending guardrails"). When present AND `enabled`, the
   * named-strategy MC path fires the funded-ratio spending guardrail per year at
   * each retirement-relative year-start boundary: it scales that
   * year's total spending down (cut, floored at essentials) or up (raise, capped
   * at `maxRaisePct × real baseline`) and the SAME factor flows through the
   * two-pass tax so MAGI/tax/IRMAA/ACA/§86 move with the adjusted withdrawals.
   * Absent / `enabled:false` → NO guardrail; the path math is unchanged
   * (excluding `computedAt`/`engineVersion`).
   */
  readonly downturnGuardrails?: DownturnGuardrailsOverride;
  /**
   * Per-drawdown-year REAL (today's-dollar) net spending need on the 100%
   * BASELINE spend path (guardrails) — the year's total essential+discretionary
   * spending minus guaranteed income (survivor-adjusted SS + lifetime
   * pension/annuity), index 0 = the retirement year, length = drawdown years.
   * The funded-ratio liability discounts THIS series (deflated per-path by the
   * path's own CPI at eval time), so the ratio measures solvency against the
   * currently-settled spend path, not the raw baseline. Only meaningful when
   * `downturnGuardrails.enabled`; absent otherwise. Structured-clone-safe plain
   * numbers.
   */
  readonly guardrailBaselineRealNetNeedByYear?: number[];
  /**
   * Per-drawdown-year REAL (today's-dollar) ESSENTIAL spending on the baseline
   * path (guardrails) — the essential-only slice of total spending, index 0 =
   * retirement year, length = drawdown years. Sets the per-year cut FLOOR (a cut
   * never drops total spending below essentials). Only meaningful when
   * `downturnGuardrails.enabled`; absent otherwise.
   */
  readonly guardrailEssentialRealByYear?: number[];
  /**
   * Per-drawdown-year REAL (today's-dollar) TOTAL spending on the 100% baseline
   * path (guardrails) — the denominator the essential-floor factor and the
   * settled-spend scaling are expressed against, index 0 = retirement year. Only
   * meaningful when `downturnGuardrails.enabled`; absent otherwise.
   */
  readonly guardrailBaselineTotalRealByYear?: number[];
  /**
   * Effective-tax gross-up fraction for the funded-ratio liability (guardrails):
   * the liability PV is divided by `(1 − this)` to fund the after-tax
   * spending with pre-tax withdrawals. In `[0, 1)`; absent → 0 (no gross-up).
   * Only meaningful when `downturnGuardrails.enabled`.
   */
  readonly guardrailEffectiveTaxRate?: number;
  /** Number of paths to simulate. */
  readonly pathCount: number;
  /** PRNG seed. Same seed → bit-identical output. */
  readonly seed: number;
  /** Withdrawal-strategy id (hashed into cache key). */
  readonly withdrawalStrategyId?: string;
  /**
   * Engine-switch discriminant (mirrors `WithdrawalStrategy['kind']`). Every
   * named strategy routes the path through `runOnePathViaStrategyEngine`
   * (`runYearByYearStrategyAware`). Required — every MC run carries one of the
   * four named strategies.
   */
  readonly strategyKind: 'taxEfficient' | 'proportional' | 'rothFirst' | 'customOrder';
  /**
   * Custom-order tier payload (state indices, tier[0] drained first).
   * Required when `strategyKind === 'customOrder'`; built by the runner via
   * `buildCustomTierIndices` so the MC tier construction matches the
   * deterministic per-account engine bit-for-bit.
   */
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  /** Custom-order excluded account state indices (companion to `customTiers`). */
  readonly excludedIndices?: ReadonlySet<number>;
  /**
   * SERIALIZABLE MAGI-ceiling cap WINDOW SCHEDULE for the named-strategy MC
   * path. The runtime `MagiCapRuntimeConfig`
   * (`buildMagiCapConfig`) carries CLOSURES (`findTargetRothIndex` /
   * `findLaterTaxableIndex`), which cannot survive `structuredClone` when
   * `MonteCarloInput` is posted to a Web Worker (`DataCloneError`). So
   * only the plain overlay (the windows array) + the precomputed per-window
   * resolved bounds cross `postMessage`; the engine side rebuilds one runtime
   * config per window via `buildMagiCapConfig` INSIDE
   * `runOnePathViaStrategyEngine` and selects ≤ 1 active window per path-year
   * exactly like the deterministic engine. When supplied, each path enforces
   * the active window's per-year MAGI cap (skip-ahead routing) and — under Fill
   * mode with a resolved target Roth — auto-converts leftover headroom into the
   * target Roth via the same outer bisection the deterministic engine runs.
   * Absent (Minimize-with-no-cap / no cap) → no
   * cap routing, no conversions. The cache key (`JSON.stringify`) separates
   * distinct ladders because the full windows array + bounds are serialized.
   */
  readonly magiCapOverride?: MagiCapOverride;
  /** Index-aligned precomputed per-window resolved `[startYear, endYear)`
   *  bounds + broken-anchor flag, companion to `magiCapOverride.windows`.
   *  Built by the runner via
   *  `resolveMagiCapWindowBounds`; the engine pairs `windows[i]` with
   *  `magiCapWindowBounds[i]` to rebuild the runtime window list. No closures →
   *  survives `postMessage`. */
  readonly magiCapWindowBounds?: ReadonlyArray<{
    readonly startYear: number;
    readonly endYear: number;
    readonly brokenAnchor: boolean;
  }>;
  /**
   * Month-precise retirement: the month within the retirement year
   * (0 = January, 11 = December) the primary retires. Threaded into
   * `retirementStepIdx = (retirementYear - firstYear) * 12 +
   * primaryRetirementMonth0`. Absent → January-of-retirementYear (a
   * year-boundary snap).
   */
  readonly primaryRetirementMonth0?: number;
  /** Progress callback (every `max(25, pathCount/40)` paths). */
  readonly onProgress?: (done: number, total: number) => void;
  /** Optional dated portfolio-addition events. */
  readonly events?: readonly MonteCarloPortfolioEvent[];
  /** Optional injected per-month main-portfolio returns (percent). */
  readonly injectedReturns?: Float64Array;
  /** Companion to `injectedReturns`: per-month CPI percent change. */
  readonly injectedCpi?: Float64Array;
  /** Annual scenario inflation rate (%). Centers the CPI bootstrap mean. */
  readonly scenarioInflationPct?: number;
  /**
   * Annual investment-cost drag (%) — the ongoing portfolio expense
   * (expense ratios + advisory fee) subtracted from every simulated month's
   * blended return as `−annualInvestmentCostPct / 12`.
   * STRESS-ONLY: the base plan never carries a cost — the scenario setting that
   * used to source this was removed — so the only writer is the named "Higher
   * fees" market stress, which sets 0.50 pp via `market-stress.ts`. A single
   * scalar → structured-clone-safe and folded
   * into the `mcCacheKey`. Absent / `0` → NO drag (the ledger return series
   * skips the subtraction entirely).
   * Applied only to market-sampled returns (not CBP fixed planning returns or
   * injected-parity returns).
   */
  readonly annualInvestmentCostPct?: number;
  /**
   * Per-asset-class annual return shock (percentage points) — the
   * "Lower returns" stress. Each field is a POSITIVE reduction
   * subtracted from that asset class's sampled monthly return as the blended
   * per-account mean-shift `−(ws·stocksPct + wb·bondsPct + wc·cashPct) / 12`,
   * so the shift honours each account's own (possibly gliding) mix while the
   * SAME sampled historical draws (seed-identical `sampledIdx`) are retained —
   * a valid before/after comparison. A plain nested object of numbers →
   * structured-clone-safe and folded into the `mcCacheKey`. Absent → NO shock.
   * Applied only to market-sampled returns.
   */
  readonly returnShock?: {
    readonly stocksPct: number;
    readonly bondsPct: number;
    readonly cashPct: number;
  };
  /**
   * Annual inflation shock (percentage points) — the
   * "Higher inflation" stress. Added to the seed-independent CPI bootstrap
   * mean-shift (`cpiShiftMonthlyFor`) as `+ inflationShockPct / 12`, so every
   * path's realized CPI rises by this amount on the SAME sampled residuals
   * (variance/skew/autocorrelation preserved) — expenses inflate faster and
   * real balances erode while the random paths stay identical. Absent / `0` →
   * no shock. A single scalar → structured-clone-safe
   * and folded into the `mcCacheKey`.
   */
  readonly inflationShockPct?: number;
  /** Lightweight tax context for per-path-per-year tax estimation. */
  readonly taxContext?: McTaxContext;
  /**
   * ACA opt-out: household member ids treated as NOT on the ACA Marketplace, as
   * a PLAIN sorted+deduped `readonly string[]` (NEVER a `Set` — `JSON.stringify(new
   * Set)` is `{}`, invisible to the `mcCacheKey`, so an opt-out scenario would
   * collide with the non-opt-out one and serve a stale summary). Mirrors the
   * value threaded into `taxContext`; surfaced top-level so the hashed cache key
   * changes even when `taxContext` is absent. Omitted entirely when empty so a
   * no-opt-out scenario's serialized input is unchanged.
   */
  readonly acaMarketplaceOptOutMemberIds?: readonly string[];
  /**
   * Minimal RMD threading used by `replayRepresentativePath` to call the
   * RMD post-pass when `taxContext` is absent (injected-return / unit-test runs
   * that thread RMD data without a full tax context). Populated by the runner
   * when tax data is available. Absent for runs that don't need RMD output.
   */
  readonly mcRmdContext?: McRmdContext;
  /**
   * SERIALIZABLE per-path QCD context. When present, every
   * MC path runs the 70½-gated forced-outflow pass: the gift is debited
   * first-dollars from the source IRA, offsets that owner's IRA-pool RMD floor,
   * and is excluded from the path's ordinary income / MAGI before §86 — so
   * per-path ending balances AND success probability move (the math is
   * per-path). Absent → identical to a no-QCD run. Omitted entirely when no QCD
   * resolved, so a no-QCD scenario's serialized input (and cache key) is
   * unchanged.
   */
  readonly qcdContext?: McQcdContext;
  /**
   * Optimizer-internal fast path. When `true`, `runMonteCarlo` skips
   * the `runPlannedOverlay` call (the extra seed-1 path run that is the
   * dominant per-pair cost) and returns a full valid `MonteCarloSummary`
   * with `plannedOverlay` set to `[]` (empty `number[]`, never `null`).
   * Every other field — `successProbability`, percentiles, histograms — is
   * computed exactly as in a full run, so `successProbability` is identical
   * to `runMonteCarlo({ ...input, successOnly: false }).successProbability`.
   * The optimizer reads only `successProbability` from the result.
   */
  readonly successOnly?: boolean;
  /**
   * Stationary block bootstrap: mean block length L (months) for the
   * sampler's geometric block draw. Absent → `DEFAULT_MEAN_BLOCK_LENGTH`.
   * `1` reduces exactly to an IID sampler (single-month blocks).
   * Ignored under injected-return parity mode (the block sampler is bypassed).
   */
  readonly meanBlockLength?: number;
}

export interface HistogramBin {
  readonly lower: number;
  readonly count: number;
}

export interface PercentileSeries {
  readonly p10: number[];
  readonly p25: number[];
  readonly p50: number[];
}

export interface MonteCarloSummary {
  readonly engineVersion: number;
  readonly seed: number;
  readonly pathCount: number;
  readonly computedAt: number;
  readonly firstYear: number;
  readonly horizonYears: number;
  readonly percentilesNominal: PercentileSeries;
  readonly percentilesReal: PercentileSeries;
  readonly successProbability: number;
  readonly medianDepletionYear: number | null;
  /** Year by which 10 % of paths have depleted. `null` when fewer than
   *  10 % of paths deplete. */
  readonly p10DepletionYear: number | null;
  /** Year by which 25 % of paths have depleted. `null` when fewer than
   *  25 % of paths deplete. Backs the "Pessimistic" stress-test tier. */
  readonly p25DepletionYear: number | null;
  readonly medianEndingBalanceNominal: number;
  readonly medianEndingBalanceReal: number;
  readonly p10EndingBalanceNominal: number;
  readonly p10EndingBalanceReal: number;
  readonly p25EndingBalanceNominal: number;
  readonly p25EndingBalanceReal: number;
  /** Per-year-offset count of paths whose depletion year falls in
   *  `firstYear + i`. Zero when 100 % success. */
  readonly failureYearHistogram: number[];
  /** 30 log-spaced bins from $1 000 to $50 000 000, plus a leading
   *  "$0" bin at index 0. Length = 31. */
  readonly endingBalanceHistogramNominal: HistogramBin[];
  readonly endingBalanceHistogramReal: HistogramBin[];
  /** Single seed-1 MC path's portfolio total by year (the Planned-method
   *  overlay). When a `taxContext` is active this series
   *  reflects after-tax balances, since the seed-1 path runs the same
   *  per-path after-tax adjustment. Currently unrendered. */
  readonly plannedOverlay: number[];
  /**
   * Per-year net-after-tax portfolio withdrawal percentile bands.
   * Defined when `MonteCarloInput.taxContext` is supplied (every
   * withdrawal strategy). Each array has length `horizonYears`.
   */
  readonly netAfterTaxPercentilesByYear?: PercentileSeries;
  /** Per-year estimated federal income tax percentile bands. */
  readonly federalTaxPercentilesByYear?: PercentileSeries;
  /** Per-year Medicare IRMAA surcharge percentile bands. */
  readonly irmaaSurchargePercentilesByYear?: PercentileSeries;
  /** Per-year ACA PTC subsidy percentile bands. */
  readonly acaPtcSubsidyPercentilesByYear?: PercentileSeries;
  /** Per-year effective federal tax rate percentile bands. */
  readonly effectiveTaxRatePercentilesByYear?: PercentileSeries;
  /**
   * Representative simulated run per Monte Carlo basis tier. For each
   * of P10/P25/P50 by REAL ending balance, the engine ranks
   * `(realEndingBalance, pathIndex)` pairs, picks the index at that rank
   * (deterministic pathIndex tie-break), recomputes that path's seed,
   * and replays it under full per-year capture — producing a coherent
   * run whose year-by-year figures reconcile (Balance = prior + growth −
   * withdrawal). Drives the Balance Projection screen when a Monte Carlo
   * basis is selected. `null` for a tier when the run cannot be assembled;
   * the WHOLE field is absent in `successOnly` mode (the optimizer fast path
   * skips the replay, mirroring `plannedOverlay`).
   */
  readonly representativeByBasis?: Record<McBasis, RepresentativeRun | null>;
  /**
   * Per-tier band of card-consistent candidate path SEEDS backing the "show
   * another likely path" reroll control. For each basis tier the engine
   * collects the path indices WITHIN that tier's card-consistency window
   * (effectively-depleted tier: `|depletionYear − cardStat| ≤ DEPLETION_BUCKET`;
   * surviving tier: `|endingReal − percentileValue| ≤ SURVIVING_BAND_FRAC ×
   * percentileValue`), caps + even-spreads them to `REROLL_BAND_CAP`, and maps
   * each to its replay seed. **Element 0 is the default reconciled pick;
   * elements 1..N−1 are the alternatives** a reroll walks (never element 0, so
   * every reroll changes the line). The reroll replays the chosen seed's path on
   * the MAIN THREAD via `runOnePath` + the same RMD/tax post-passes the engine
   * applies — the cards/percentile stats never move. Absent in `successOnly`
   * mode (the optimizer fast path skips the representative assembly). */
  readonly representativeBandsByBasis?: Record<McBasis, number[]>;
  /** Replay seed for the Typical (P50) representative run. */
  readonly representativeTypicalSeed?: number;
  /** Replay seed for the Pessimistic (P25) representative run. */
  readonly representativePessimisticSeed?: number;
  /** Replay seed for the Bad-luck (P10) representative run. */
  readonly representativeBadLuckSeed?: number;
}
