/**
 * Shared types for the monthly-stepping kernel — split out so the
 * single-pool branch (`kernel-single-pool.ts`) and the per-account
 * branch (`kernel.ts`) share one type surface without an import
 * cycle.
 */
import type { WithdrawalStrategy } from './withdrawal-strategies';

/**
 * One per-account ledger entry consumed by the per-account branch.
 * All `Float64Array` fields are length `stepCount` (parallel to
 * `cpiPct`); the kernel does not re-validate length.
 */
export interface KernelAccount {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  /** Per-step pre-tax contribution dollars (accumulation only). */
  readonly contribPre: Float64Array;
  /** Per-step post-tax contribution dollars (accumulation only). */
  readonly contribPost: Float64Array;
  /** Per-step lump-sum deposit dollars (drawdown phase). SUMMED across all
   *  sources — the per-account kernel branch (`applyDrawdownPreWithdrawal`)
   *  reads this slot and is unchanged by the post-primary split. */
  readonly deposit: Float64Array;
  /** Per-step post-primary spouse contribution POST-tax (designated-Roth)
   *  slice (drawdown phase). Read ONLY by the named-strategy MC slice; always
   *  routed to `post` (§325). Optional — absent on pre-feature ledgers. */
  readonly depositPost?: Float64Array;
  /** Per-step return as a percent (e.g. 0.5 for 0.5 %/mo). Caller is
   *  responsible for the monthly conversion (`monthlyEquivalent`). */
  readonly returnPct: Float64Array;
  /** True for an HSA-treatment account (HSA withdrawal reserve). The
   *  single-pool kernel HOLDS HSA OUT of the proportional pool
   *  and draws it only via the two-pass routing (medical-qualified before the
   *  ordinary drain, emergency-reserve after the non-HSA pool is exhausted).
   *  Absent / false → an ordinary pool member. */
  readonly isHsa?: boolean;
}

export interface StepInputs {
  /** Main-portfolio per-step return as a percent (e.g. 0.5 for 0.5 %/mo).
   *  Length `stepCount`. Required when `accounts` is absent; ignored
   *  when `accounts` is present (per-account `returnPct` drives growth). */
  readonly mainReturnPct: Float64Array;
  /** Per-step CPI percent change (e.g. 0.25 for 0.25 %/mo). Length
   *  `stepCount`. */
  readonly cpiPct: Float64Array;
  /** Per-step pre-tax contribution dollars (single-pool only). */
  readonly contribPre: Float64Array;
  /** Per-step post-tax contribution dollars (single-pool only). */
  readonly contribPost: Float64Array;
  /** Per-step gross expense (drawdown phase only; ignored before
   *  `retirementStepIdx`). */
  readonly expense: Float64Array;
  /** Per-step non-portfolio income (SS + pension + other). */
  readonly income: Float64Array;
  /** Per-step lump-sum deposits (CBP payouts, oneOff windfalls) —
   *  single-pool only. */
  readonly deposit: Float64Array;
  /** Optional sub-portfolio (CBP-style) — **consumed only by the
   *  single-pool branch** (`kernel-single-pool.ts`) for the legacy
   *  bucket-allocation / non-`accounts` callers. The per-account branch
   *  ignores this field; each CBP account is its own `KernelAccount`
   *  with its own `returnPct` series. Kept on `StepInputs` so the
   *  single-pool branch survives without an API break. */
  readonly subPortfolio?: {
    readonly initialBalance: number;
    readonly returnPct: Float64Array;
  };
  /** First drawdown step. 0 ↔ already retired. */
  readonly retirementStepIdx: number;
  /** Initial pre-tax balance (single-pool only). */
  readonly initialPre: number;
  /** Initial post-tax balance (single-pool only). */
  readonly initialPost: number;
  /** Optional withdrawal strategy. Defaults to `netNeedStrategy`. */
  readonly withdrawalStrategy?: WithdrawalStrategy;
  /** Per-account ledger set. When supplied (and `allocation`
   *  is not), kernel runs the per-account branch. */
  readonly accounts?: ReadonlyArray<KernelAccount>;
  /** Per-step HSA-qualified medical demand in INTEGER CENTS (HSA
   *  withdrawal reserve). Drives the proportional kernel's
   *  medical-first HSA draw — each drawdown step funds up to
   *  `min(medical demand, the step's withdrawal target, HSA balance)` from HSA
   *  accounts tax-free before the proportional non-HSA drain; the remaining need
   *  taps HSA as an emergency reserve only after the non-HSA pool is exhausted.
   *  Length `stepCount` (parallel to `cpiPct`). Absent / all-zero ⇒ the medical
   *  pass is a no-op (emergency-reserve path intact). */
  readonly medicalDemandCents?: Float64Array;
}

export interface StepOutcome {
  /** Pre-tax balance at the end of each step (aggregate when
   *  per-account ran). */
  readonly preEnd: Float64Array;
  /** Post-tax balance at the end of each step (aggregate). */
  readonly postEnd: Float64Array;
  /** Growth dollars added this step (aggregate). */
  readonly growth: Float64Array;
  /** Total contributions added this step (aggregate). */
  readonly contributions: Float64Array;
  /** Withdrawal taken this step (aggregate). */
  readonly withdrawal: Float64Array;
  /** Lump-sum deposit applied this step (aggregate). */
  readonly deposit: Float64Array;
  /** Gross expense exposed each step. */
  readonly expense: Float64Array;
  /** Non-portfolio income exposed each step. */
  readonly income: Float64Array;
  /** Cumulative CPI factor at end of each step. */
  readonly cumCpi: Float64Array;
  /** Per-account end-of-step pre-tax balances (per-account path only). */
  readonly accountPreEnd?: ReadonlyArray<Float64Array>;
  readonly accountPostEnd?: ReadonlyArray<Float64Array>;
  readonly accountWithdrawal?: ReadonlyArray<Float64Array>;
  readonly accountDeposit?: ReadonlyArray<Float64Array>;
  /** Per-account dollars drawn this step against the medical-first HSA pass
   *  (HSA withdrawal reserve). Populated only for HSA accounts on the
   *  per-account path; zero elsewhere. The account-row builder
   *  stamps these into `DrawdownAccountYear.medicalQualifiedWithdrawnCents`
   *  so the tax post-pass classifies medical-funded HSA draws as tax-free. */
  readonly accountMedicalQualifiedWithdrawal?: ReadonlyArray<Float64Array>;
  /** Per-account pre-tax (pre-bucket) dollars withdrawn each step (per-account
   *  path only). Parallel to `accountWithdrawal`. Used to populate
   *  `DrawdownAccountYear.preWithdrawnCents` on the kernel path — the exact
   *  split the kernel already computes at each step but previously discarded.
   *  HSA accounts record 0 here (all HSA draws are post).
   *  Absent when the per-account branch did not run. */
  readonly accountPreWithdrawn?: ReadonlyArray<Float64Array>;
  /** Per-account post-tax (post-bucket) dollars withdrawn each step (per-account
   *  path only). Parallel to `accountWithdrawal`. Complement of `accountPreWithdrawn`
   *  so `pre + post === withdrawal` holds at every step. HSA accounts record the
   *  full draw here (cash-like, always post). Absent when the per-account branch
   *  did not run. */
  readonly accountPostWithdrawn?: ReadonlyArray<Float64Array>;
  /** First step where target exceeded the pool, or -1.
   *  Aggregate semantics under per-account (synchronous
   *  depletion). */
  readonly depletionStepIdx: number;
}
