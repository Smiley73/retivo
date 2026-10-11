/**
 * Monthly-stepping kernel — single primitive shared by the deterministic
 * Balance Projection engine, the Monte Carlo runner, and the drawdown
 * engine. Pure: same inputs always produce the same `StepOutcome`.
 *
 * Two shapes:
 *   Single-pool (see `kernel-single-pool.ts`):
 *     scalar `initialPre`/`initialPost`/`mainReturnPct`/`contribPre`/
 *     `contribPost`/`deposit` drive one merged pool through accumulation
 *     + drawdown. The shared fallback when no `accounts` ledger is supplied
 *     (deterministic / MC / drawdown), dispatched on accounts presence.
 *   Per-account: supply `accounts: ReadonlyArray<KernelAccount>`.
 *     Accumulation compounds each account at its own `returnPct[i]`.
 *     Drawdown follows deposit → growth → withdrawal per-account,
 *     then distributes the household target across accounts proportional
 *     to current balance. MIXED-tax pre/post split by current ratio
 *     per step (no entry-ratio freeze).
 *
 * Aggregate output fields (`preEnd`, `postEnd`, `growth`, `withdrawal`,
 * `deposit`, `contributions`, `depletionStepIdx`) are sums across
 * accounts under per-account. Per-account end-state arrays
 * (`accountPreEnd`, `accountPostEnd`, `accountWithdrawal`,
 * `accountDeposit`) populate only when the per-account branch ran.
 *
 * Depletion is mathematically synchronous under proportional-
 * to-balance withdrawals — every positive account is scaled by the
 * same `1 − taken/Σ` factor. The kernel keeps only the aggregate
 * `depletionStepIdx`.
 *
 * Floating-point clamp residual is accept-loss this step
 * (sub-cent fp64 rounding guard only; no second-pass redistribute).
 */
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
  /** Per-step dollars drawn against the medical-first HSA pass. Zero for
   *  non-HSA accounts; the emergency pass never writes it. */
  medicalQualifiedWithdrawal: Float64Array;
  /** Per-step pre-bucket dollars withdrawn. Summed by `buildAccountBalanceMap`
   *  into `DrawdownAccountYear.preWithdrawnCents`. HSA = always 0 (post-only). */
  preWithdrawn: Float64Array;
  /** Per-step post-bucket dollars withdrawn. Complement of `preWithdrawn` so
   *  `pre + post === withdrawal` per step. */
  postWithdrawn: Float64Array;
  /** HSA withdrawal reserve: held out of the proportional pool + drawn
   *  via the medical/emergency two-pass. */
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

/** Per-step body of the per-account branch. Mutates `states`, `out`,
 *  and the rolling `ctx` (cum CPI, prior withdrawal, depletion index,
 *  entry balance). Extracted from `runPerAccount` to keep each function
 *  short. */
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

/** Drawdown phase: ask the strategy for the step's target, clamp to
 *  the pool, distribute proportional-to-balance, update aggregate
 *  withdrawal output + depletion index + prior-withdrawal carry.
 *  Extracted from `runPerAccountStep` to keep each function short. */
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
  // A negative target means non-portfolio income exceeded the expense
  // (surplus). Clamp to a non-negative withdrawal so per-account balances + the
  // downstream tax classification are the same as for a strategy that never
  // returns a negative need (`distributeWithdrawal` already no-ops on
  // `taken <= 0`). The surplus is NOT routed anywhere — the proportional kernel
  // clamps the recorded withdrawal to ≥ 0, so surplus reduces the effective draw
  // to zero (the per-account strategy engine independently recomputes its own
  // need and never consumes this negative value).
  const taken = Math.max(0, rawTaken);
  out.withdrawal[i] = taken;
  // HSA withdrawal reserve: HSA is held OUT of the proportional pool. Per
  // step: (a) medical-qualified HSA draw against the step's medical demand
  // (tax-free) BEFORE the ordinary drain, (b) proportional NON-HSA drain,
  // (c) emergency HSA draw for any residual after the non-HSA pool is exhausted.
  // No HSA account → all three reduce to a plain proportional draw.
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

/** Sum of the NON-HSA pool's current balances (HSA held out). */
function sumNonHsaPoolNow(states: ReadonlyArray<AccountState>): number {
  let sum = 0;
  for (const st of states) if (!st.isHsa) sum += st.pre + st.post;
  return sum;
}

/**
 * Draw `target` from the HSA accounts only (HSA withdrawal reserve). HSA
 * balances are cash-like (held in `post`), so the draw debits `post` and records
 * into the per-account `withdrawal[i]` accumulator. Drained sequentially in
 * `states` order. When `medical` is true the draw is the medical-qualified pass,
 * so each account's slice is ALSO recorded into `medicalQualifiedWithdrawal[i]`;
 * the account-row builder stamps that into
 * `DrawdownAccountYear.medicalQualifiedWithdrawnCents` so the tax post-pass treats
 * medical-funded HSA dollars as tax-free (the emergency pass passes `false` and
 * leaves the residual untouched). Returns the dollars drawn (≤ target,
 * ≤ HSA balance).
 */
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
    // HSA draws are entirely from the post (cash-like) bucket — pre = 0.
    // postWithdrawn accumulates across the medical + emergency passes.
    st.postWithdrawn[i] += take;
    drawn += take;
    remaining -= take;
  }
  return drawn;
}

/** Distribute `taken` across the NON-HSA accounts proportional to current
 *  balance (HSA excluded). Mirrors `distributeWithdrawal` but skips HSA.
 *  Records per-step pre/post split into `st.preWithdrawn[i]` / `st.postWithdrawn[i]`
 *  (accumulated — called alongside `drawHsaPass` for the HSA-present code path). */
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

/** Accumulation: per-account contribution + per-account growth.
 *  Writes per-account pre/post end + aggregate growth/contrib/pre/post. */
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

/** Drawdown pre-withdrawal: per-account deposit (post-tax bucket) +
 *  optional household-aggregate deposit split proportional-to-balance
 *  + per-account growth. Returns aggregate deposit dollars so
 *  the caller can write the aggregate output. */
function applyDrawdownPreWithdrawal(
  states: AccountState[],
  accounts: ReadonlyArray<KernelAccount>,
  i: number,
  out: AggregateOutputs,
  householdDeposit: number,
): number {
  // Household deposit (no target account) splits proportional to
  // current balance at deposit time. Per-account `deposit[i]`
  // attributes to its named account directly (CBP lump-sum, targeted
  // one-off, post-primary contribution).
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
    // Deposit attributes to post-tax bucket (CBP / one-off dollars).
    st.post += dep;
  }
  out.growth[i] = applyDrawdownGrowth(states, accounts, i);
  return aggDeposit;
}

/** Per-account growth step under drawdown — applies each account's
 *  `returnPct[i]` factor to both buckets and returns the aggregate
 *  growth dollars. Split out of `applyDrawdownPreWithdrawal` to keep each
 *  function short. */
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

/** Distribute household withdrawal across accounts proportional to
 *  current balance. MIXED-tax pre/post by current ratio. fp64
 *  clamp residual = accept-loss. Records per-step pre/post split
 *  into `st.preWithdrawn[i]` / `st.postWithdrawn[i]` for kernel-path
 *  `preWithdrawnCents` population. */
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
    // fp64 safety clamp — proportional split is mathematically
    // ≤ acctPool in exact arithmetic; residual is accept-loss.
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
