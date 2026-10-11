/**
 * Fill-mode Roth-conversion fill step for the per-account
 * drawdown engine, extracted from `drawdown-engine-per-account-strategy.ts`
 * to keep that file near its shape cap.
 *
 * Runs ONCE per year, AFTER the committing monthly withdrawal loop:
 * the residual cap room is only known then. Gated on an ACTIVE cap under FILL
 * mode with a resolved target Roth and leftover headroom. The conversion:
 *   - sizes itself by the outer bisection in the tax-cashflow hook
 *     (`solveFillConversionForYear`), so realized MAGI on the selected line
 *     lands AT the ceiling, never above it;
 *   - moves principal from pre-tax / MIXED-PRE sub-buckets ONLY — never a MIXED
 *     post-tranche — into the user-designated target Roth's post bucket;
 *   - is an INTERNAL TRANSFER: it does NOT increment the year's withdrawal
 *     accumulators, so it is correctly excluded from the §72(t) early-withdrawal
 *     penalty (a conversion is not a distribution) and never charted as a
 *     Portfolio Flow / income. The converted amount IS ordinary income —
 *     that is recognized inside the bisection probes (raising both divergent
 *     MAGIs, NIIT, the senior-bonus phase-out) via the conversion ordinary
 *     income addend, never folded into the withdrawal pre-tax classification.
 *
 * The converted dollars are returned as integer cents so the caller can stamp
 * `DrawdownYear.rothConvertedCents`. When no conversion occurs (Minimize,
 * no cap, after cap-off, no/dangling target Roth, RMD-breach year, or no
 * headroom) the step returns 0 and mutates nothing.
 *
 * See the Fill conversions section of `docs/math-retirement-accounts.md` for
 * how the conversion is sized and taxed.
 */
import { floorEligibleDollars, isRmdOverflowCashAccountId, type AccountRunState, type MagiCapRuntimeConfig } from './drawdown-engine-per-account-strategy-helpers';
import { classifyCommittedYearDraw, isMagiNeutralPostBucket } from './drawdown-engine-per-account-strategy-cap';
import type { TaxCashflowHook } from './drawdown-engine-types';

/** Result of the per-year conversion fill step. */
export interface RothConversionFillResult {
  /** Converted principal moved pre-tax → target Roth, in integer cents.
   *  Zero when no conversion occurred. */
  readonly convertedCents: number;
  /** Same-year incremental conversion tax FUNDED from MAGI-neutral `post`
   *  balances (Roth + cash-like only), in integer cents. The caller
   *  adds this to the year's withdrawal so ending balances drop by the funded
   *  tax (balance is conserved MINUS the funded tax).
   *  Zero when no conversion occurred or the year owes no incremental tax. */
  readonly fundedTaxCents: number;
  /** Same-year incremental conversion tax the year OWES, in integer cents.
   *  Equals `fundedTaxCents` when MAGI-neutral balances cover it; larger
   *  when they are exhausted (the unfundable residual makes the year a
   *  depletion via the caller's withdrawal/need comparison). */
  readonly taxNeedCents: number;
  /** True when Fill mode was active with leftover room but no target Roth could
   *  be resolved (no/dangling Roth) — the engine degrades to withdrawal-only and
   *  the UI surfaces a notice. */
  readonly degradedNoTargetRoth: boolean;
}

const NO_CONVERSION: RothConversionFillResult = {
  convertedCents: 0,
  fundedTaxCents: 0,
  taxNeedCents: 0,
  degradedNoTargetRoth: false,
};

const EMPTY_EXCLUDED: ReadonlySet<number> = new Set<number>();

/**
 * Apply the Fill-mode auto-conversion for one year. `capRemainingDollars` is the
 * gross-dollar cap room left AFTER the RMD pre-pass + the discretionary
 * withdrawal loop — the bisection's upper bracket. Mutates `state` only
 * on the committing path; returns the converted cents + degrade flag.
 */
export function applyRothConversionFill(args: {
  readonly state: AccountRunState[];
  readonly magiCapConfig: MagiCapRuntimeConfig | undefined;
  readonly capActive: boolean;
  /** Residual gross cap room (dollars) after RMD + withdrawals. Null = no cap. */
  readonly capRemainingDollars: number | null;
  readonly taxCashflow: TaxCashflowHook | undefined;
  readonly yearIndex: number;
  /** Committed per-account year withdrawal split (the conv=0 MAGI basis). The
   *  post accumulator is MUTATED to record the cap-safe conversion-tax funding
   *  draw. */
  readonly yearPreWithdrawnByAcct: ReadonlyArray<number>;
  readonly yearPostWithdrawnByAcct: number[];
  /** Per-account total-withdrawal accumulator. MUTATED by the cap-safe
   *  conversion-tax funding draw. */
  readonly yearWithdrawnByAcct: number[];
  /** State indices of accounts the engine excludes from drawdown (e.g. an
   *  excluded HSA). NEVER debited by the conversion or its tax funding. */
  readonly excludedIndices?: ReadonlySet<number>;
}): RothConversionFillResult {
  const { state, magiCapConfig, capActive, capRemainingDollars, taxCashflow,
    yearIndex, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct, yearWithdrawnByAcct } = args;
  const excludedIndices = args.excludedIndices ?? EMPTY_EXCLUDED;

  // Conversions exist only while a cap is ACTIVE under FILL mode.
  if (!capActive || magiCapConfig === undefined || magiCapConfig.capMode !== 'fill') {
    return NO_CONVERSION;
  }
  // The hook owns the MAGI surface + the bisection; without it the engine cannot
  // size a conversion against the actual MAGI line (unit-test / tax-free path).
  if (taxCashflow?.solveFillConversionForYear === undefined) return NO_CONVERSION;
  // No residual room (RMD alone breached the cap; or withdrawals filled
  // it) → nothing to convert.
  const room = capRemainingDollars ?? 0;
  if (room <= 0) return NO_CONVERSION;

  // Resolve the user-designated target Roth by equality to an
  // own-household live Roth in `state`. Dangling / deleted / non-Roth → degrade
  // to withdrawal-only fill with a notice.
  const targetRothIndex = magiCapConfig.findTargetRothIndex(state);
  if (targetRothIndex === undefined) {
    return { convertedCents: 0, fundedTaxCents: 0, taxNeedCents: 0, degradedNoTargetRoth: true };
  }

  // Size the conversion via the outer bisection: the committed
  // withdrawal classification is the conv=0 MAGI basis; the solve adds the
  // conversion as ordinary income and lands realized MAGI at the ceiling.
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

  // COMMIT: move principal from pre-tax / MIXED-PRE buckets in account
  // order into the target Roth. Integer-cent accounting throughout so the
  // debit total exactly equals the Roth credit with no penny drift.
  let remainingCents = Math.round(convertedDollars * 100);
  let movedCents = 0;
  for (let a = 0; a < state.length && remainingCents > 0; a += 1) {
    if (a === targetRothIndex) continue;
    // An engine-excluded account (e.g. a default-excluded HSA) is never
    // drawn — its pre-tax dollars are NOT a conversion source.
    if (excludedIndices.has(a)) continue;
    const st = state[a];
    // Convert ONLY pre-tax dollars. A MIXED account's `pre` sub-bucket is
    // convertible; its `post` (already-taxed Roth-designated / after-tax)
    // tranche is NEVER converted. The synthetic RMD-overflow cash carrier
    // holds no pre-tax dollars and is skipped implicitly (pre === 0).
    if (isRmdOverflowCashAccountId(st.id)) continue;
    const availableCents = Math.max(0, Math.round(st.pre * 100));
    if (availableCents <= 0) continue;
    const moveCents = Math.min(remainingCents, availableCents);
    st.pre = Math.max(0, (Math.round(st.pre * 100) - moveCents) / 100);
    remainingCents -= moveCents;
    movedCents += moveCents;
  }
  if (movedCents <= 0) return NO_CONVERSION;

  // Credit the target Roth's post bucket with exactly the moved principal — the
  // converted dollars are spendable later as Roth (the transfer itself conserves
  // total balance; the conversion's incremental income tax is funded separately
  // below, so total balance ends conserved MINUS that funded tax).
  // Capture the target Roth's PRE-conversion post balance BEFORE crediting
  // the converted principal. The tax-funding draw may only reach DOWN TO this
  // floor — never into the same-year converted principal — so under-59½ that
  // principal is not misdrawn as Roth earnings (§72(t)).
  const target = state[targetRothIndex];
  const targetPreConversionPostCents = Math.max(0, Math.round(target.post * 100));
  target.post = (Math.round(target.post * 100) + movedCents) / 100;

  // FUND the conversion's same-year incremental ordinary-income tax. The
  // monthly withdrawal loop ran with conv=0, so without this draw the unfunded
  // conversion tax would overstate ending balances and let Fill spuriously
  // dominate Minimize. The hook returns the extra federal/IRMAA cash need (and
  // makes the live IRMAA look-back buffer conversion-inclusive so Y+2 is funded
  // too). Draw it from MAGI-NEUTRAL `post` balances ONLY (Roth + cash-like) —
  // A brokerage / MIXED-post `post` draw is NOT MAGI-neutral (its gain is
  // LTCG → MAGI), so funding from it would push realized MAGI past the ceiling
  // the bisection just filled; and a further pre-tax draw is doubly wrong (the
  // pre-tax cap headroom is already consumed by the conversion). This draw is
  // NOT a §72(t)-penalizable distribution of the conversion (a conversion is
  // not a distribution) — it is an ordinary cap-safe withdrawal recorded
  // in the post accumulators, exactly like any other already-taxed draw.
  const movedDollars = movedCents / 100;
  const taxNeedDollars =
    taxCashflow.fundConversionTaxForYear?.(yearIndex, withdrawalClassification, movedDollars) ?? 0;
  const taxNeedCents = Math.round(taxNeedDollars * 100);
  const fundedTaxCents = drawCapSafeTaxFunding({
    state,
    targetRothIndex,
    targetRothMaxDrawCents: targetPreConversionPostCents,
    needCents: taxNeedCents,
    yearWithdrawnByAcct,
    yearPostWithdrawnByAcct,
    excludedIndices,
  });

  return { convertedCents: movedCents, fundedTaxCents, taxNeedCents, degradedNoTargetRoth: false };
}

/**
 * Draw `needCents` of conversion-tax funding from MAGI-NEUTRAL `post` balances
 * ONLY — an account's `post` sub-bucket qualifies iff `isMagiNeutralPostBucket`
 * (Roth `post` + cash-like return-of-principal: SAVINGS / MONEY_MARKET / CD /
 * HSA). These add $0 to MAGI, so the draw cannot tip realized MAGI over the
 * ceiling the bisection just filled. A BROKERAGE / OTHER POST_TAX or
 * MIXED-post `post` draw is DELIBERATELY excluded: its gain is LTCG that feeds
 * otherAGI → MAGI (tax-integration.ts §"Step 1"), so funding from it would
 * overshoot the ceiling. When the MAGI-neutral buckets cannot cover the need
 * the funded amount is LESS than `needCents`; the engine never falls back to a
 * MAGI-raising bucket — the residual is an unfundable conversion tax that
 * surfaces as the year's depletion via the caller's withdrawal/need comparison
 * (the balance is conserved MINUS the funded tax).
 *
 * Each candidate's `post` draw is additionally capped at its OWN post-only floor
 * (`post − floorEligibleDollars(st)`, mirroring `drawHsaEmergency`) so a
 * floor-protected HSA / cash-like account is never drained below the minimum
 * balance the user reserved — independent of any `pre` balance the account
 * carries; a floored HSA is blocked at the floor in BOTH `hsaMode`s. An
 * unfloored / ineligible account has `floorEligibleDollars === 0`, so the cap
 * no-ops and its full `post` remains drawable.
 *
 * Engine-excluded accounts (`excludedIndices`) are never drawn. Drained
 * in account order, integer cents (no penny drift). The conversion's own target
 * Roth is drawn LAST and only down to `targetRothMaxDrawCents` — its
 * PRE-conversion `post` balance — so the same-year converted principal is never
 * drawn to fund the tax (avoids a §72(t)/earnings misclassification of the
 * just-converted principal under-59½). Returns the funded cents (≤ needCents).
 */
function drawCapSafeTaxFunding(args: {
  readonly state: AccountRunState[];
  readonly targetRothIndex: number;
  /** Max cents drawable from the target Roth (its PRE-conversion post balance) —
   *  funding may not reach into the same-year converted principal. */
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
  // Non-target MAGI-neutral sources first, then the target Roth as a last resort.
  const order: number[] = [];
  for (let a = 0; a < state.length; a += 1) if (a !== targetRothIndex) order.push(a);
  order.push(targetRothIndex);
  for (const a of order) {
    if (remainingCents <= 0) break;
    // Never draw an engine-excluded account.
    if (excludedIndices.has(a)) continue;
    const st = state[a];
    // Only genuinely MAGI-neutral `post` (Roth / cash-like) may fund.
    if (!isMagiNeutralPostBucket(st)) continue;
    let availableCents = Math.max(0, Math.round(st.post * 100));
    // Respect a floor-eligible account's own POST-ONLY
    // floor (`post − floor`), mirroring `drawHsaEmergency`'s emergency-use
    // formula exactly — NEVER the combined-basis `discretionaryDrawable`, which
    // would let a large `pre` balance absorb the floor and still drain `post` to
    // 0 for a pre-bearing HSA. `floorEligibleDollars(st)` returns 0 for a
    // ROTH / MIXED-post / unfloored / ineligible account, so this no-ops
    // identically for every non-floored funding source. HSA is blocked at the
    // floor in BOTH `hsaMode`s (the helper is mode-invariant), matching PASS B.
    availableCents = Math.max(0, availableCents - Math.round(floorEligibleDollars(st) * 100));
    // Cap the target Roth at its pre-conversion post — the just-converted
    // principal is off-limits to the tax-funding draw.
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
