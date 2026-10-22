/**
 * Fill-mode Roth-conversion step, run once per year after the monthly withdrawal loop.
 * See the Fill conversions section of `docs/math-retirement-accounts.md`.
 */
import { floorEligibleDollars, isRmdOverflowCashAccountId, type AccountRunState, type MagiCapRuntimeConfig } from './drawdown-engine-per-account-strategy-helpers';
import { classifyCommittedYearDraw, isMagiNeutralPostBucket } from './drawdown-engine-per-account-strategy-cap';
import type { TaxCashflowHook } from './drawdown-engine-types';

/** Result of the per-year conversion fill step. */
export interface RothConversionFillResult {
  /** Principal moved pre-tax to the target Roth, in integer cents. */
  readonly convertedCents: number;
  /**
   * Same-year conversion tax funded from MAGI-neutral `post` balances, in integer cents; ending balances drop
   * by it.
   */
  readonly fundedTaxCents: number;
  /**
   * Same-year incremental conversion tax owed, in integer cents; exceeds `fundedTaxCents` when MAGI-neutral
   * balances run out.
   */
  readonly taxNeedCents: number;
  /**
   * True when Fill was active with room left but no target Roth resolved; the engine degrades to
   * withdrawal-only.
   */
  readonly degradedNoTargetRoth: boolean;
  /**
   * Cents the tax funding drew from each account id; present only when the hook records the zero-conversion
   * point.
   */
  readonly taxFundingCentsByAccount?: ReadonlyMap<string, number>;
}

const NO_CONVERSION: RothConversionFillResult = {
  convertedCents: 0,
  fundedTaxCents: 0,
  taxNeedCents: 0,
  degradedNoTargetRoth: false,
};

const EMPTY_EXCLUDED: ReadonlySet<number> = new Set<number>();

/**
 * Applies the Fill-mode auto-conversion for one year. `capRemainingDollars` is the cap room left after the
 * RMD pre-pass and withdrawals; mutates `state` only on the committing path.
 */
export function applyRothConversionFill(args: {
  readonly state: AccountRunState[];
  readonly magiCapConfig: MagiCapRuntimeConfig | undefined;
  readonly capActive: boolean;
  /** Residual gross cap room (dollars) after RMD + withdrawals. Null = no cap. */
  readonly capRemainingDollars: number | null;
  readonly taxCashflow: TaxCashflowHook | undefined;
  readonly yearIndex: number;
  /**
   * Committed per-account year withdrawal split (the conv=0 MAGI basis); the post accumulator is mutated by
   * the tax-funding draw.
   */
  readonly yearPreWithdrawnByAcct: ReadonlyArray<number>;
  readonly yearPostWithdrawnByAcct: number[];
  /** Per-account total-withdrawal accumulator, mutated by the tax-funding draw. */
  readonly yearWithdrawnByAcct: number[];
  /**
   * State indices of accounts excluded from drawdown; never debited by the conversion or its tax funding.
   */
  readonly excludedIndices?: ReadonlySet<number>;
}): RothConversionFillResult {
  const { state, magiCapConfig, capActive, capRemainingDollars, taxCashflow,
    yearIndex, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct, yearWithdrawnByAcct } = args;
  const excludedIndices = args.excludedIndices ?? EMPTY_EXCLUDED;

  if (!capActive || magiCapConfig === undefined || magiCapConfig.capMode !== 'fill') {
    return NO_CONVERSION;
  }
  if (taxCashflow?.solveFillConversionForYear === undefined) return NO_CONVERSION;
  const room = capRemainingDollars ?? 0;
  if (room <= 0) return NO_CONVERSION;

  const targetRothIndex = magiCapConfig.findTargetRothIndex(state);
  if (targetRothIndex === undefined) {
    return { convertedCents: 0, fundedTaxCents: 0, taxNeedCents: 0, degradedNoTargetRoth: true };
  }

  const withdrawalClassification = classifyCommittedYearDraw(
    state,
    yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct,
  );
  const convertedDollars = taxCashflow.solveFillConversionForYear(
    yearIndex,
    withdrawalClassification,
    room,
    magiCapConfig.capMagiLine,
    magiCapConfig.capDollars,
  );
  if (convertedDollars <= 0) return NO_CONVERSION;

  // Integer cents, so the debit total equals the Roth credit with no penny drift.
  let remainingCents = Math.round(convertedDollars * 100);
  let movedCents = 0;
  for (let a = 0; a < state.length && remainingCents > 0; a += 1) {
    if (a === targetRothIndex) continue;
    if (excludedIndices.has(a)) continue;
    const st = state[a];
    // Only pre-tax dollars convert; a MIXED account's `post` tranche never does.
    if (isRmdOverflowCashAccountId(st.id)) continue;
    const availableCents = Math.max(0, Math.round(st.pre * 100));
    if (availableCents <= 0) continue;
    const moveCents = Math.min(remainingCents, availableCents);
    st.pre = Math.max(0, (Math.round(st.pre * 100) - moveCents) / 100);
    remainingCents -= moveCents;
    movedCents += moveCents;
  }
  if (movedCents <= 0) return NO_CONVERSION;

  // The tax-funding draw may only reach down to the target Roth's pre-conversion `post` balance, so under 59½
  // the converted principal is not misdrawn as Roth earnings (§72(t)).
  const target = state[targetRothIndex];
  const targetPreConversionPostCents = Math.max(0, Math.round(target.post * 100));
  target.post = (Math.round(target.post * 100) + movedCents) / 100;

  // The conversion tax is funded only from MAGI-neutral `post` balances (Roth, cash-like): a brokerage or
  // MIXED-post draw adds LTCG to MAGI and would overshoot the ceiling the bisection filled.
  // The draw is an ordinary withdrawal in the post accumulators, not a §72(t) distribution of the conversion.
  const movedDollars = movedCents / 100;
  const taxNeedDollars =
    taxCashflow.fundConversionTaxForYear?.(yearIndex, withdrawalClassification, movedDollars) ?? 0;
  const taxNeedCents = Math.round(taxNeedDollars * 100);
  const postBeforeFunding = taxCashflow.recordsConversionZeroPoint === true
    ? yearPostWithdrawnByAcct.slice()
    : undefined;
  const fundedTaxCents = drawCapSafeTaxFunding({
    state,
    targetRothIndex,
    targetRothMaxDrawCents: targetPreConversionPostCents,
    needCents: taxNeedCents,
    yearWithdrawnByAcct,
    yearPostWithdrawnByAcct,
    excludedIndices,
  });

  return {
    convertedCents: movedCents,
    fundedTaxCents,
    taxNeedCents,
    degradedNoTargetRoth: false,
    ...(postBeforeFunding === undefined
      ? {}
      : { taxFundingCentsByAccount: fundingCentsByAccount(state, postBeforeFunding, yearPostWithdrawnByAcct) }),
  };
}

function fundingCentsByAccount(
  state: readonly AccountRunState[],
  before: readonly number[],
  after: readonly number[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (let a = 0; a < state.length; a += 1) {
    const cents = Math.round((after[a] - before[a]) * 100);
    if (cents > 0) out.set(state[a].id, cents);
  }
  return out;
}

// Draws `needCents` from MAGI-neutral `post` balances (Roth `post`, cash-like SAVINGS/MONEY_MARKET/CD, HSA).
// Brokerage and MIXED-post draws are excluded because their LTCG feeds MAGI; an uncoverable remainder
// surfaces as depletion.
// Floor-protected accounts are capped at their post-only floor, and the target Roth is drawn last, only down
// to `targetRothMaxDrawCents`.
function drawCapSafeTaxFunding(args: {
  readonly state: AccountRunState[];
  readonly targetRothIndex: number;
  /** Max cents drawable from the target Roth (its pre-conversion post balance). */
  readonly targetRothMaxDrawCents: number;
  readonly needCents: number;
  readonly yearWithdrawnByAcct: number[];
  readonly yearPostWithdrawnByAcct: number[];
  readonly excludedIndices: ReadonlySet<number>;
}): number {
  const { state, targetRothIndex, targetRothMaxDrawCents, needCents,
    yearWithdrawnByAcct, yearPostWithdrawnByAcct, excludedIndices } = args;
  if (needCents <= 0) return 0;
  let remainingCents = needCents;
  let fundedCents = 0;
  const order: number[] = [];
  for (let a = 0; a < state.length; a += 1) if (a !== targetRothIndex) order.push(a);
  order.push(targetRothIndex);
  for (const a of order) {
    if (remainingCents <= 0) break;
    if (excludedIndices.has(a)) continue;
    const st = state[a];
    if (!isMagiNeutralPostBucket(st)) continue;
    let availableCents = Math.max(0, Math.round(st.post * 100));
    availableCents = Math.max(0, availableCents - Math.round(floorEligibleDollars(st) * 100));
    if (a === targetRothIndex) availableCents = Math.min(availableCents, targetRothMaxDrawCents);
    if (availableCents <= 0) continue;
    const drawCents = Math.min(remainingCents, availableCents);
    st.post = Math.max(0, (Math.round(st.post * 100) - drawCents) / 100);
    yearWithdrawnByAcct[a] += drawCents / 100;
    yearPostWithdrawnByAcct[a] += drawCents / 100;
    remainingCents -= drawCents;
    fundedCents += drawCents;
  }
  return fundedCents;
}
