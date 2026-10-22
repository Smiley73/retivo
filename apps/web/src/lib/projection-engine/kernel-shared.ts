/** Shared types for the monthly kernel (`kernel.ts` and `kernel-single-pool.ts`). */
import type { WithdrawalStrategy } from './withdrawal-strategies';

/** One per-account ledger entry; every `Float64Array` has length `stepCount` and is not re-validated. */
export interface KernelAccount {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  readonly contribPre: Float64Array;
  readonly contribPost: Float64Array;
  /** Lump-sum deposit dollars in drawdown, summed across all sources. */
  readonly deposit: Float64Array;
  /** Post-primary spouse contribution in drawdown, designated-Roth slice; routed to `post` (SECURE 2.0 §325). Read only by the named-strategy MC slice. */
  readonly depositPost?: Float64Array;
  /** Per-step return in percent (0.5 = 0.5 %/mo); the caller applies `monthlyEquivalent`. */
  readonly returnPct: Float64Array;
  /** HSA-treatment account: held out of the proportional pool and drawn only via the medical-first / emergency two-pass. */
  readonly isHsa?: boolean;
}

export interface StepInputs {
  /** Main-portfolio return in percent per step; required when `accounts` is absent, ignored otherwise. */
  readonly mainReturnPct: Float64Array;
  /** Per-step CPI change in percent (0.25 = 0.25 %/mo). */
  readonly cpiPct: Float64Array;
  readonly contribPre: Float64Array;
  readonly contribPost: Float64Array;
  /** Gross expense; ignored before `retirementStepIdx`. */
  readonly expense: Float64Array;
  readonly income: Float64Array;
  readonly deposit: Float64Array;
  /** Read only by the single-pool branch; the per-account branch models each CBP account as its own `KernelAccount`. */
  readonly subPortfolio?: {
    readonly initialBalance: number;
    readonly returnPct: Float64Array;
  };
  /** First drawdown step; 0 means already retired. */
  readonly retirementStepIdx: number;
  readonly initialPre: number;
  readonly initialPost: number;
  readonly withdrawalStrategy?: WithdrawalStrategy;
  /** Supplying it selects the per-account branch. */
  readonly accounts?: ReadonlyArray<KernelAccount>;
  /** HSA-qualified medical demand per step in integer cents; absent or all-zero makes the medical pass a no-op. */
  readonly medicalDemandCents?: Float64Array;
}

export interface StepOutcome {
  /** Pre-tax balance at each step end; aggregate (sum across accounts) when the per-account branch ran. */
  readonly preEnd: Float64Array;
  readonly postEnd: Float64Array;
  readonly growth: Float64Array;
  readonly contributions: Float64Array;
  readonly withdrawal: Float64Array;
  readonly deposit: Float64Array;
  readonly expense: Float64Array;
  readonly income: Float64Array;
  readonly cumCpi: Float64Array;
  /** Per-account arrays are populated only when the per-account branch ran. */
  readonly accountPreEnd?: ReadonlyArray<Float64Array>;
  readonly accountPostEnd?: ReadonlyArray<Float64Array>;
  readonly accountWithdrawal?: ReadonlyArray<Float64Array>;
  readonly accountDeposit?: ReadonlyArray<Float64Array>;
  /** Dollars drawn per HSA account in the medical-first pass; the tax post-pass treats them as tax-free. */
  readonly accountMedicalQualifiedWithdrawal?: ReadonlyArray<Float64Array>;
  /** Pre-tax dollars withdrawn per account per step; HSA records 0 (all HSA draws are post). */
  readonly accountPreWithdrawn?: ReadonlyArray<Float64Array>;
  /** Post-tax dollars withdrawn per account per step; `pre + post === withdrawal` at every step. */
  readonly accountPostWithdrawn?: ReadonlyArray<Float64Array>;
  /** First step where the target exceeded the pool, or -1; aggregate under per-account. */
  readonly depletionStepIdx: number;
}
