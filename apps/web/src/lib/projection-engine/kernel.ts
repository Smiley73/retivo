/** Monthly-stepping kernel shared by the deterministic engine, the Monte Carlo runner and the drawdown engine;
 * single-pool, or per-account when `accounts` is supplied. Pure: same inputs, same `StepOutcome`. */
import { netNeedStrategy, type WithdrawalStrategy } from './withdrawal-strategies';
import type {
  KernelAccount,
  StepInputs,
  StepOutcome,
} from './kernel-shared';
import { runSinglePoolKernel } from './kernel-single-pool';

export type {
  KernelAccount,
  StepInputs,
  StepOutcome,
} from './kernel-shared';

export function runStepKernel(s: StepInputs): StepOutcome {
  if (s.accounts && s.accounts.length > 0) {
    return runPerAccount(s);
  }
  return runSinglePoolKernel(s);
}

interface AccountState {
  pre: number;
  post: number;
  preEnd: Float64Array;
  postEnd: Float64Array;
  withdrawal: Float64Array;
  deposit: Float64Array;
  medicalQualifiedWithdrawal: Float64Array;
  preWithdrawn: Float64Array;
  postWithdrawn: Float64Array;
  isHsa: boolean;
}

interface AggregateOutputs {
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

function runPerAccount(s: StepInputs): StepOutcome {
  const stepCount = s.cpiPct.length;
  const strategy = s.withdrawalStrategy ?? netNeedStrategy;
  const accounts = s.accounts!;

  const out = allocateAggregateOutputs(stepCount);
  const states: AccountState[] = accounts.map((acc) => ({
    pre: acc.initialPre,
    post: acc.initialPost,
    preEnd: new Float64Array(stepCount),
    postEnd: new Float64Array(stepCount),
    withdrawal: new Float64Array(stepCount),
    deposit: new Float64Array(stepCount),
    medicalQualifiedWithdrawal: new Float64Array(stepCount),
    preWithdrawn: new Float64Array(stepCount),
    postWithdrawn: new Float64Array(stepCount),
    isHsa: acc.isHsa === true,
  }));

  const ctx: PerAccountStepCtx = {
    cum: 1,
    priorWithdrawal: 0,
    depletionStepIdx: -1,
    entryBalance: 0,
    entryReconstructed: false,
  };

  for (let i = 0; i < stepCount; i += 1) {
    runPerAccountStep(states, accounts, i, stepCount, s, strategy, out, ctx);
  }

  return {
    ...out,
    accountPreEnd: states.map((st) => st.preEnd),
    accountPostEnd: states.map((st) => st.postEnd),
    accountWithdrawal: states.map((st) => st.withdrawal),
    accountDeposit: states.map((st) => st.deposit),
    accountMedicalQualifiedWithdrawal: states.map((st) => st.medicalQualifiedWithdrawal),
    accountPreWithdrawn: states.map((st) => st.preWithdrawn),
    accountPostWithdrawn: states.map((st) => st.postWithdrawn),
    depletionStepIdx: ctx.depletionStepIdx,
  };
}

interface PerAccountStepCtx {
  cum: number;
  priorWithdrawal: number;
  depletionStepIdx: number;
  entryBalance: number;
  entryReconstructed: boolean;
}

function runPerAccountStep(
  states: AccountState[],
  accounts: ReadonlyArray<KernelAccount>,
  i: number,
  stepCount: number,
  s: StepInputs,
  strategy: WithdrawalStrategy,
  out: AggregateOutputs,
  ctx: PerAccountStepCtx,
): void {
  ctx.cum *= 1 + s.cpiPct[i] / 100;
  out.cumCpi[i] = ctx.cum;
  out.expense[i] = s.expense[i];
  out.income[i] = s.income[i];

  if (i < s.retirementStepIdx) {
    applyAccumulationStep(states, accounts, i, out);
    return;
  }

  if (!ctx.entryReconstructed) {
    ctx.entryBalance = sumPoolNow(states);
    ctx.entryReconstructed = true;
  }

  out.deposit[i] = applyDrawdownPreWithdrawal(states, accounts, i, out, s.deposit[i] ?? 0);
  applyDrawdownStrategyAndWithdraw(states, i, stepCount, s, strategy, out, ctx);
  finalizeStepEnd(states, i, out);
}

function applyDrawdownStrategyAndWithdraw(
  states: AccountState[],
  i: number,
  stepCount: number,
  s: StepInputs,
  strategy: WithdrawalStrategy,
  out: AggregateOutputs,
  ctx: PerAccountStepCtx,
): void {
  const pool = sumPoolNow(states);
  const target = strategy({
    stepIdx: i,
    stepsRemaining: stepCount - i - 1,
    currentBalance: pool,
    initialBalance: ctx.entryBalance,
    inflatedExpense: s.expense[i],
    income: s.income[i],
    cumCpi: ctx.cum,
    priorWithdrawal: ctx.priorWithdrawal,
  });
  const rawTaken = Math.min(pool, target);
  if (rawTaken < target && ctx.depletionStepIdx === -1) ctx.depletionStepIdx = i;
  // A negative target is surplus income; clamp to 0 so balances and tax classification match a strategy that never returns a negative need.
  const taken = Math.max(0, rawTaken);
  out.withdrawal[i] = taken;
  // HSA is held out of the proportional pool: medical-qualified draw (tax-free) first, then the proportional non-HSA drain, then an emergency HSA draw once the non-HSA pool is exhausted.
  const hasHsa = states.some((st) => st.isHsa);
  if (!hasHsa) {
    distributeWithdrawal(states, i, pool, taken);
    ctx.priorWithdrawal = taken;
    return;
  }
  const demand = (s.medicalDemandCents?.[i] ?? 0) / 100;
  const medicalDrawn = drawHsaPass(states, i, Math.min(taken, demand), true);
  let remaining = taken - medicalDrawn;
  const nonHsaPool = sumNonHsaPoolNow(states);
  const ordinaryDrawn = Math.min(remaining, nonHsaPool);
  distributeNonHsaWithdrawal(states, i, nonHsaPool, ordinaryDrawn);
  remaining -= ordinaryDrawn;
  if (remaining > 0) drawHsaPass(states, i, remaining, false);
  ctx.priorWithdrawal = taken;
}

function sumNonHsaPoolNow(states: ReadonlyArray<AccountState>): number {
  let sum = 0;
  for (const st of states) if (!st.isHsa) sum += st.pre + st.post;
  return sum;
}

// HSA is cash-like, so the draw debits `post`; `medical` also records each slice for tax-free treatment in the tax post-pass.
function drawHsaPass(
  states: AccountState[],
  i: number,
  target: number,
  medical: boolean,
): number {
  let remaining = Math.max(0, target);
  if (remaining <= 0) return 0;
  let drawn = 0;
  for (const st of states) {
    if (!st.isHsa || remaining <= 0) continue;
    const available = Math.max(0, st.post);
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    st.post = Math.max(0, st.post - take);
    st.withdrawal[i] += take;
    if (medical) st.medicalQualifiedWithdrawal[i] += take;
    st.postWithdrawn[i] += take;
    drawn += take;
    remaining -= take;
  }
  return drawn;
}

function distributeNonHsaWithdrawal(
  states: AccountState[],
  i: number,
  nonHsaPool: number,
  taken: number,
): void {
  if (nonHsaPool <= 0 || taken <= 0) return;
  for (const st of states) {
    if (st.isHsa) continue;
    const acctPool = st.pre + st.post;
    if (acctPool <= 0) continue;
    let share = taken * (acctPool / nonHsaPool);
    if (share > acctPool) share = acctPool;
    st.withdrawal[i] += share;
    const preShare = share * (st.pre / acctPool);
    const postShare = share - preShare;
    st.preWithdrawn[i] += preShare;
    st.postWithdrawn[i] += postShare;
    st.pre = Math.max(0, st.pre - preShare);
    st.post = Math.max(0, st.post - postShare);
  }
}

function applyAccumulationStep(
  states: AccountState[],
  accounts: ReadonlyArray<KernelAccount>,
  i: number,
  out: AggregateOutputs,
): void {
  let aggGrowth = 0;
  let aggContrib = 0;
  let aggPre = 0;
  let aggPost = 0;
  for (let a = 0; a < states.length; a += 1) {
    const st = states[a];
    const acc = accounts[a];
    const cPre = acc.contribPre[i];
    const cPost = acc.contribPost[i];
    aggContrib += cPre + cPost;
    st.pre += cPre;
    st.post += cPost;
    const factor = 1 + acc.returnPct[i] / 100;
    const preBefore = st.pre;
    const postBefore = st.post;
    st.pre = preBefore * factor;
    st.post = postBefore * factor;
    aggGrowth += st.pre - preBefore + (st.post - postBefore);
    st.preEnd[i] = st.pre;
    st.postEnd[i] = st.post;
    aggPre += st.pre;
    aggPost += st.post;
  }
  out.contributions[i] = aggContrib;
  out.growth[i] = aggGrowth;
  out.preEnd[i] = aggPre;
  out.postEnd[i] = aggPost;
}

function applyDrawdownPreWithdrawal(
  states: AccountState[],
  accounts: ReadonlyArray<KernelAccount>,
  i: number,
  out: AggregateOutputs,
  householdDeposit: number,
): number {
  const poolBefore = sumPoolNow(states);
  let aggDeposit = householdDeposit;
  for (let a = 0; a < states.length; a += 1) {
    const st = states[a];
    const acc = accounts[a];
    const targetedDep = acc.deposit[i];
    const householdShare =
      poolBefore > 0 && householdDeposit > 0
        ? householdDeposit * ((st.pre + st.post) / poolBefore)
        : householdDeposit / Math.max(1, states.length);
    const dep = targetedDep + householdShare;
    st.deposit[i] = dep;
    aggDeposit += targetedDep;
    st.post += dep;
  }
  out.growth[i] = applyDrawdownGrowth(states, accounts, i);
  return aggDeposit;
}

function applyDrawdownGrowth(
  states: AccountState[],
  accounts: ReadonlyArray<KernelAccount>,
  i: number,
): number {
  let aggGrowth = 0;
  for (let a = 0; a < states.length; a += 1) {
    const st = states[a];
    const acc = accounts[a];
    const factor = 1 + acc.returnPct[i] / 100;
    const preBefore = st.pre;
    const postBefore = st.post;
    st.pre = preBefore * factor;
    st.post = postBefore * factor;
    aggGrowth += st.pre - preBefore + (st.post - postBefore);
  }
  return aggGrowth;
}

// Proportional-to-balance withdrawal scales every positive account by the same factor, so depletion is synchronous and only the aggregate `depletionStepIdx` is kept.
function distributeWithdrawal(
  states: AccountState[],
  i: number,
  pool: number,
  taken: number,
): void {
  if (pool <= 0 || taken <= 0) return;
  for (const st of states) {
    const acctPool = st.pre + st.post;
    if (acctPool <= 0) continue;
    let share = taken * (acctPool / pool);
    // fp64 clamp: the split is <= acctPool in exact arithmetic; the residual is accept-loss (sub-cent, no second pass).
    if (share > acctPool) share = acctPool;
    st.withdrawal[i] = share;
    const preShare = share * (st.pre / acctPool);
    const postShare = share - preShare;
    st.preWithdrawn[i] = preShare;
    st.postWithdrawn[i] = postShare;
    st.pre = Math.max(0, st.pre - preShare);
    st.post = Math.max(0, st.post - postShare);
  }
}

function finalizeStepEnd(
  states: AccountState[],
  i: number,
  out: AggregateOutputs,
): void {
  let aggPre = 0;
  let aggPost = 0;
  for (const st of states) {
    st.preEnd[i] = st.pre;
    st.postEnd[i] = st.post;
    aggPre += st.pre;
    aggPost += st.post;
  }
  out.preEnd[i] = aggPre;
  out.postEnd[i] = aggPost;
}

function sumPoolNow(states: ReadonlyArray<AccountState>): number {
  let sum = 0;
  for (const st of states) sum += st.pre + st.post;
  return sum;
}

function allocateAggregateOutputs(stepCount: number): AggregateOutputs {
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
