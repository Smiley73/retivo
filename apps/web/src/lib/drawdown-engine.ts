/**
 * Drawdown engine — simulates household portfolio depletion through
 * retirement.
 *
 * Built on the shared monthly-stepping kernel
 * (`apps/web/src/lib/projection-engine/kernel.ts`).
 *
 * Per-account path:
 *   Monthly cadence. Each `DrawdownAccountInput` becomes one kernel
 *   ledger; per-account `planningReturnPct`/TWR drives growth (or the
 *   per-month `returnPctByMonth` blended-glide series under allocation);
 *   the household monthly target distributes in withdrawal-strategy
 *   priority order. MIXED-tax pre/post drift by current ratio per step.
 *   Implementation in `drawdown-engine-per-account.ts`. EVERY named
 *   withdrawal strategy routes through this per-account path.
 *
 * Pre-retirement years are out of scope here — the per-account
 * `project()` math already handles the accumulation phase. This engine
 * runs from the household's retirement year through the horizon.
 */
import { simulatePerAccountMonthly } from './drawdown-engine-per-account';
import type {
  DrawdownInput,
  DrawdownOutput,
} from './drawdown-engine-types';

export type {
  DrawdownInput,
  DrawdownOutput,
  DrawdownYear,
} from './drawdown-engine-types';

export function simulateDrawdown(input: DrawdownInput): DrawdownOutput {
  const yearCount = input.horizonYear - input.retirementYear + 1;
  if (yearCount <= 0) {
    return { years: [], depletionYear: null, perMonthWithdrawal: new Float64Array(0) };
  }
  // There is no single-pool fallback, so a run with no
  // per-account ledger has nothing to draw from — return a zero-withdrawal
  // projection rather than synthesizing a pool.
  if (!input.accounts || input.accounts.length === 0) {
    return { years: [], depletionYear: null, perMonthWithdrawal: new Float64Array(0) };
  }
  return simulatePerAccountMonthly(input, yearCount);
}
