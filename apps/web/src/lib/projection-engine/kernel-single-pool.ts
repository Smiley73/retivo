/** Single-pool branch of the monthly kernel, used when no per-account ledger is supplied.
 * The entry point is `runStepKernel` in `kernel.ts`. */
import {
  type WithdrawalStrategy,
  netNeedStrategy,
} from './withdrawal-strategies';
import type { StepInputs, StepOutcome } from './kernel-shared';

interface SinglePoolState {
  pre: number;
  post: number;
  sub: number;
  pool: number;
  priorWithdrawal: number;
  depletionStepIdx: number;
  cum: number;
  entryPreRatio: number;
  entryBalance: number;
  entryReconstructed: boolean;
}

export function runSinglePoolKernel(s: StepInputs): StepOutcome {
  const stepCount = s.mainReturnPct.length;
  const strategy: WithdrawalStrategy = s.withdrawalStrategy ?? netNeedStrategy;
  const buf = allocateBuffers(stepCount);
  const state: SinglePoolState = {
    pre: s.initialPre,
    post: s.initialPost,
    sub: s.subPortfolio?.initialBalance ?? 0,
    pool: 0,
    priorWithdrawal: 0,
    depletionStepIdx: -1,
    cum: 1,
    entryPreRatio: 1,
    entryBalance: 0,
    entryReconstructed: false,
  };

  for (let i = 0; i < stepCount; i += 1) {
    runSinglePoolStep(state, s, i, stepCount, strategy, buf);
  }

  return buildSinglePoolOutcome(buf, state.depletionStepIdx);
}

function runSinglePoolStep(
  state: SinglePoolState,
  s: StepInputs,
  i: number,
  stepCount: number,
  strategy: WithdrawalStrategy,
  buf: SinglePoolBuffers,
): void {
  state.cum *= 1 + s.cpiPct[i] / 100;
  buf.cumCpi[i] = state.cum;
  buf.expense[i] = s.expense[i];
  buf.income[i] = s.income[i];
  buf.deposit[i] = s.deposit[i];

  if (i < s.retirementStepIdx) {
    applySinglePoolAccumulation(state, s, i, buf);
    return;
  }
  reconstructEntryStateIfNeeded(state);
  applyCombinedGrowth(state, s, i, buf);
  applyWithdrawalStep(state, s, i, stepCount, strategy, buf);
}

function applySinglePoolAccumulation(
  state: SinglePoolState,
  s: StepInputs,
  i: number,
  buf: SinglePoolBuffers,
): void {
  buf.contributions[i] = s.contribPre[i] + s.contribPost[i];
  state.pre += s.contribPre[i];
  state.post += s.contribPost[i];
  if (s.subPortfolio && i < s.subPortfolio.returnPct.length) {
    state.sub *= 1 + s.subPortfolio.returnPct[i] / 100;
  }
  const factor = 1 + s.mainReturnPct[i] / 100;
  const preBefore = state.pre;
  const postBefore = state.post;
  state.pre = preBefore * factor;
  state.post = postBefore * factor;
  buf.growth[i] = state.pre - preBefore + (state.post - postBefore);
  buf.preEnd[i] = state.pre;
  buf.postEnd[i] = state.post;
}

function reconstructEntryStateIfNeeded(state: SinglePoolState): void {
  if (state.entryReconstructed) return;
  state.post += state.sub;
  state.sub = 0;
  state.pool = state.pre + state.post;
  state.entryBalance = state.pool;
  state.entryPreRatio = state.pool > 0 ? state.pre / state.pool : 1;
  state.entryReconstructed = true;
}

function applyCombinedGrowth(
  state: SinglePoolState,
  s: StepInputs,
  i: number,
  buf: SinglePoolBuffers,
): void {
  const grown = (state.pool + s.deposit[i]) * (1 + s.mainReturnPct[i] / 100);
  buf.growth[i] = grown - (state.pool + s.deposit[i]);
  state.pool = grown;
}

function applyWithdrawalStep(
  state: SinglePoolState,
  s: StepInputs,
  i: number,
  stepCount: number,
  strategy: WithdrawalStrategy,
  buf: SinglePoolBuffers,
): void {
  const target = strategy({
    stepIdx: i,
    stepsRemaining: stepCount - i - 1,
    currentBalance: state.pool,
    initialBalance: state.entryBalance,
    inflatedExpense: s.expense[i],
    income: s.income[i],
    cumCpi: state.cum,
    priorWithdrawal: state.priorWithdrawal,
  });
  const rawTaken = Math.min(state.pool, target);
  if (rawTaken < target && state.depletionStepIdx === -1) state.depletionStepIdx = i;
  // A negative target is surplus income; clamp to 0 so balances, the depletion test and tax integration match a strategy that never returns a negative need.
  const taken = Math.max(0, rawTaken);
  buf.withdrawal[i] = taken;
  state.pool = Math.max(0, state.pool - taken);
  buf.preEnd[i] = state.pool * state.entryPreRatio;
  buf.postEnd[i] = state.pool - buf.preEnd[i];
  state.priorWithdrawal = Math.max(0, taken);
}

function buildSinglePoolOutcome(
  buf: SinglePoolBuffers,
  depletionStepIdx: number,
): StepOutcome {
  return {
    preEnd: buf.preEnd,
    postEnd: buf.postEnd,
    growth: buf.growth,
    contributions: buf.contributions,
    withdrawal: buf.withdrawal,
    deposit: buf.deposit,
    expense: buf.expense,
    income: buf.income,
    cumCpi: buf.cumCpi,
    depletionStepIdx,
  };
}

interface SinglePoolBuffers {
  preEnd: Float64Array;
  postEnd: Float64Array;
  growth: Float64Array;
  contributions: Float64Array;
  withdrawal: Float64Array;
  deposit: Float64Array;
  expense: Float64Array;
  income: Float64Array;
  cumCpi: Float64Array;
}

function allocateBuffers(stepCount: number): SinglePoolBuffers {
  return {
    preEnd: new Float64Array(stepCount),
    postEnd: new Float64Array(stepCount),
    growth: new Float64Array(stepCount),
    contributions: new Float64Array(stepCount),
    withdrawal: new Float64Array(stepCount),
    deposit: new Float64Array(stepCount),
    expense: new Float64Array(stepCount),
    income: new Float64Array(stepCount),
    cumCpi: new Float64Array(stepCount),
  };
}
