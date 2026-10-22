/**
 * Pipeline-context builder for the BPP-equivalent helper. Owns scenario
 * resolution + horizon + SS-start computation; delegates per-account
 * projection + targeted-deposit classification to
 * `balance-projection-runner-projection.ts`.
 *
 * Split out of `balance-projection-runner.ts` so each sibling file stays
 * ≤ 400 ln.
 */
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgePerMember,
  ScenarioPayload,
} from '../db/types';
import {
  DEFAULT_LIFE_EXPECTANCY_AGE,
} from '../db/types';
import {
  resolveAccountFloorsForScenario,
  resolveInflationForScenario,
  resolveMedicalInflationPct,
  resolveQcdForScenario,
  resolveScenario,
  type ResolvedAccountFloor,
  type ScenarioAggregate,
} from './scenario-resolution';
import { resolveMemberRetirementDates } from './retirement-date-math';
import { validateCbpResolution } from './cbp-resolution';
import { projectedDeathFractionalYear } from './expense-preview-projection';
import { type ProjectionContext } from './projection-context';
import {
  type PipelineContext,
  type RunBalanceProjectionArgs,
} from './balance-projection-runner-types';
import {
  classifyTargetedDeposits,
  preProjectCbpAccounts,
  projectActiveAccounts,
} from './balance-projection-runner-projection';
import { resolveLinkedCbpIncomeStreams } from './cbp-resolution';
import { isPureRothEmployerType, isRothDesignatedRetirementType } from './balance-calc';
// The fact-based Roth / RMD profile adapters.
import {
  buildRothAccountFactInputs,
  buildRothDistributionFacts,
  buildRmdProfileFactsByAccount,
  resolveRetirementYearByMember,
} from './balance-projection-runner-tax-helpers';
import { computePreRetirementRothConversions } from './roth-conversion-projection';
import type { PreDepositList } from './balance-projection-runner-types';
import { emptyMonthlySeries, addOneOff } from './monthly-cashflow';
import type { ClassifiedDepositEvent } from './balance-projection-bundle';
import type { DrawdownAccountInput } from './drawdown-engine-types';
import type { ProjectionMethod } from './balance-projection-runner-types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import { splitInitialByTaxTreatment } from './tax-treatment-split';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import { splitRolloverByRmd } from './rmd-rollover-split';
import type { RmdAccountProfileFacts } from './rmd';
import { monthlyEquivalent } from './projection-engine/monthly-conversion';
import { blendedGlideReturnPct } from './allocation-glide';
import type { RetirementAllocationOverride } from '../db/types';

// Re-export the projection helpers so callers (cashflow) can keep a
// single import surface for the runner internals.
export {
  buildMemberRetirementMap,
  makeCbpBalanceLookup,
} from './balance-projection-runner-projection';

/** Result shape: the per-account ledger AND the post-primary CBP
 *  lump-sum deposits that have been routed per-account. The caller MUST
 *  subtract these dollars from the household-aggregate `depositsByMonth`
 *  before threading into `simulateDrawdown` — otherwise the kernel will
 *  apply them BOTH per-account (via `acc.deposit[i]`) AND proportionally
 *  via the household-aggregate `s.deposit[i]`, double-counting at the
 *  event step. Mirrors the MC bundle's `skipsPortfolio: true` semantic
 *  for lumpSum-elected CBP. */
export interface PerAccountDrawdownLedger {
  readonly accounts: ReadonlyArray<DrawdownAccountInput>;
  /** Post-primary CBP lump-sum deposits already attributed to a target
   *  account's `depositsByMonth`. Callers subtract these from the
   *  household-aggregate `depositsByMonth` to avoid double-count. */
  readonly cbpLumpSumDeposits: ReadonlyArray<{
    readonly year: number;
    readonly month0: number;
    readonly amount: number;
  }>;
  /** Plain-pension lump-sum dollars that WERE placed into a target
   *  account's `depositsByMonth` (the target was present in the ledger).
   *  Callers subtract these from the household-aggregate `depositsByMonth`
   *  to avoid double-count — events whose target was NOT in the ledger are
   *  omitted here so they stay in the household spread. */
  readonly plainPensionDeposits: ReadonlyArray<{
    readonly year: number;
    readonly month0: number;
    readonly amount: number;
  }>;
  /** Per-CALENDAR-YEAR rolled-CBP RMD income in dollars (the rollover-year
   *  RMD carved out of a linked-CBP lump-sum landing in/after the source
   *  owner's RMD trigger year). Taxable ordinary income + spendable cash —
   *  the runner injects it into BOTH the deterministic ordinary-income tax
   *  inlet AND the spendable income series (mirrors the MC `otherIncome`
   *  semantics so the two engines agree to the cent). Empty when no split fired. */
  readonly rolledRmdIncomeByYear: ReadonlyMap<number, number>;
}

/**
 * Build the per-account drawdown ledger from a resolved pipeline
 * context. Excludes annuity-elected CBP accounts (their
 * balance flows in via `incomeByMonth`, never as a ledger) AND every
 * `lumpSum`-elected linked-CBP source account, regardless of event
 * timing relative to primary retirement. Pre-primary lumpSum
 * sources already have their balance routed into the target via
 * `classifyTargetedDeposits`/`preDepositsByAccount`; post-primary
 * lumpSum sources are modeled as a TRANSFER — the source CBP is
 * excluded from the ledger and the projected at-event balance lands
 * in the target account's `depositsByMonth` slot. Mirrors the MC
 * bundle factory's `skipsPortfolio: true` contract for `lumpSum`
 * elections (`applyCbpAccount` in `balance-projection-bundle.ts`).
 *
 * Returns BOTH the ledger AND the list of CBP lump-sum deposits
 * already attributed to targets; callers MUST subtract those from the
 * household-aggregate `depositsByMonth` before invoking
 * `simulateDrawdown` (the household-aggregate series carries the same
 * dollars via `incomeProjection.depositInflow` and the kernel would
 * apply them twice otherwise).
 */
export function buildPerAccountDrawdownLedger(args: {
  ctx: import('./balance-projection-runner-types').PipelineContext;
  method: ProjectionMethod;
  expensesByMonth: MonthlyCashflowSeries;
  /** Post-primary spouse contribution events (carry the pre/post split +
   *  `accountId`). Each routes into its destination account's per-account
   *  deposit series instead of the household pool. Defaults to none. */
  postPrimaryEvents?: ReadonlyArray<ClassifiedDepositEvent>;
  /** Post-retirement plain-pension lump-sum placement events (carry
   *  `accountId` + absolute `month`). Routed whole into the target account's
   *  `depositsByMonth` (bucketed by treatment via `applyMonthlyDeposits`),
   *  like a one-off windfall — but per-account. Targets absent from the ledger
   *  are left in the household spread; they are NOT reported back in
   *  `plainPensionDeposits` so the caller does not subtract them. */
  plainPensionEvents?: ReadonlyArray<ClassifiedDepositEvent>;
}): PerAccountDrawdownLedger {
  const { ctx, method, expensesByMonth } = args;
  // Group post-primary events by destination account so each account's ledger
  // entry can fold in its own pre/post deposit slices (routing is a
  // ledger-build concern; the cashflow producer only emits the events).
  const postPrimaryByAccount = new Map<string, ClassifiedDepositEvent[]>();
  for (const ev of args.postPrimaryEvents ?? []) {
    if (!ev.accountId) continue;
    const list = postPrimaryByAccount.get(ev.accountId);
    if (list) list.push(ev);
    else postPrimaryByAccount.set(ev.accountId, [ev]);
  }
  // Group plain-pension placement events by destination account.
  const plainPensionByAccount = new Map<string, ClassifiedDepositEvent[]>();
  for (const ev of args.plainPensionEvents ?? []) {
    if (!ev.accountId) continue;
    const list = plainPensionByAccount.get(ev.accountId);
    if (list) list.push(ev);
    else plainPensionByAccount.set(ev.accountId, [ev]);
  }
  const cbpElections = resolveLinkedCbpIncomeStreams({
    scenarioId: ctx.scenarioId,
    scenarios: ctx.effectiveScenarios,
    accounts: ctx.accountProjections.map((p) => p.account),
    incomeStreams: ctx.incomeStreams,
  });
  const elections = resolveCbpElections(cbpElections);
  // The rollover-year RMD split runs for every named strategy.
  const postRetirementCbpDeposits = collectPostRetirementCbpLumpSumDeposits({
    ctx,
    cbpElections,
  });
  const horizonYear =
    expensesByMonth.startYear +
    Math.floor(expensesByMonth.values.length / 12) -
    1;
  // A Fill-mode MAGI-cap WINDOW converts pre-tax dollars INTO its designated
  // Roth. Each such Roth must keep its drawdown-state slot even at a $0 balance
  // — otherwise a freshly-created empty Roth set as a window's conversion target
  // is dropped by the zero-balance filter below and the conversion silently
  // degrades (no target). Collect every Fill window's target across the ladder.
  const rawCap = ctx.resolvedScenario.magiCap;
  const fillTargetRothIds = new Set<string>();
  if (rawCap !== undefined && !('disabled' in rawCap)) {
    for (const w of rawCap.windows) {
      if (w.capMode === 'fill' && w.targetRothAccountId !== undefined) {
        fillTargetRothIds.add(w.targetRothAccountId);
      }
    }
  }
  // When the scenario sets a `retirementAllocation` override, build the
  // household BLENDED GLIDE `returnPctByMonth` for each non-CBP account so
  // allocation routes through the per-account drawdown path. CBP accounts
  // keep their scalar planning rate (excluded from the glide, mirroring MC).
  // Absent override → undefined → byte-for-byte unchanged scalar-rate growth.
  const allocationOverride = ctx.resolvedScenario.retirementAllocation;
  const retirementYear = ctx.primaryRetirementYear;
  const stepCount = (horizonYear - expensesByMonth.startYear + 1) * 12;
  // Resolve the per-account floor (per-field
  // first-ancestor-wins, CWE-20 sanitised) so each eligible account's ledger
  // entry carries its floor into the strategy-aware engine. Empty map when no
  // floors set.
  const floorsByAccount = resolveAccountFloorsForScenario(
    ctx.scenarioId,
    [...ctx.effectiveScenarios],
    ctx.accountProjections.map((p) => p.account),
  );
  const accounts: DrawdownAccountInput[] = [];
  // Track which plain-pension placements actually landed in a ledger
  // entry so the caller subtracts exactly those from the household spread
  // (a target dropped from the ledger stays in the spread).
  const placedPlainPension: Array<{ year: number; month0: number; amount: number }> = [];
  for (const proj of ctx.accountProjections) {
    if (elections.annuityIds.has(proj.account.id)) continue;
    if (elections.lumpSumElectedCbpIds.has(proj.account.id)) continue;
    const plainForAccount = plainPensionByAccount.get(proj.account.id);
    const entry = buildLedgerEntry({
      proj,
      method,
      startYear: expensesByMonth.startYear,
      horizonYear,
      targetedCbpDeposits: postRetirementCbpDeposits.get(proj.account.id),
      isFillTargetRoth: fillTargetRothIds.has(proj.account.id),
      postPrimaryEvents: postPrimaryByAccount.get(proj.account.id),
      plainPensionEvents: plainForAccount,
      allocation: allocationOverride,
      retirementYear,
      stepCount,
      floor: floorsByAccount.get(proj.account.id),
    });
    if (entry) {
      accounts.push(entry);
      for (const ev of plainForAccount ?? []) {
        if (ev.amount > 0) {
          const y = Math.floor(ev.month / 12);
          placedPlainPension.push({ year: y, month0: ev.month - y * 12, amount: ev.amount });
        }
      }
    }
  }
  const cbpLumpSumDeposits = flattenCbpDeposits(postRetirementCbpDeposits);
  const rolledRmdIncomeByYear = buildRolledRmdIncomeByYear(postRetirementCbpDeposits);
  // Empty / CBP-only / all-$0 allocation ledger — synthesize a single
  // household-pool account carrying the blended `returnPctByMonth` so an
  // allocation scenario with no funded non-CBP account still uses the glide
  // return and never errors or silently runs a zero-return pool. Only when
  // the glide reaches NO ledger account.
  const finalAccounts =
    allocationOverride !== undefined && !accounts.some((a) => a.returnPctByMonth !== undefined)
      ? [
          ...accounts,
          synthesizeHouseholdGlidePool({
            startYear: expensesByMonth.startYear,
            horizonYear,
            allocation: allocationOverride,
            retirementYear,
            stepCount,
          }),
        ]
      : accounts;
  return {
    accounts: finalAccounts,
    cbpLumpSumDeposits,
    plainPensionDeposits: placedPlainPension,
    rolledRmdIncomeByYear,
  };
}

/** Build the per-account blended-glide `returnPctByMonth` over the
 *  FULL-RUN step domain (length `stepCount = yearCount*12`). The deterministic
 *  drawdown starts AT retirement (`retirementStepIdx = 0`), so every step is a
 *  drawdown step mapped `y = retirementYear + floor(i/12)` (mirrors
 *  `buildGlideAssetMixSeries`'s `firstYear + floor(i/12)`). Were a caller ever
 *  to run with a pre-retirement accumulation phase, steps before retirement hold
 *  the account's base scalar rate. Each drawdown step holds
 *  `monthlyEquivalent(blended(y))`. */
function buildBlendedGlideReturnPctByMonth(args: {
  startYear: number;
  baseAnnualRatePct: number;
  allocation: RetirementAllocationOverride;
  retirementYear: number;
  stepCount: number;
}): Float64Array {
  const { startYear, baseAnnualRatePct, allocation, retirementYear, stepCount } = args;
  const baseMonthly = monthlyEquivalent(baseAnnualRatePct);
  const out = new Float64Array(stepCount);
  for (let i = 0; i < stepCount; i += 1) {
    const y = startYear + Math.floor(i / 12);
    out[i] =
      y < retirementYear
        ? baseMonthly
        : monthlyEquivalent(blendedGlideReturnPct(y, allocation, retirementYear));
  }
  return out;
}

/** Synthesize a single household-pool ledger account carrying the blended
 *  glide return when allocation reaches no real (non-CBP, funded) account. The
 *  pool starts at $0 (the real accounts hold the balances) — its purpose is to
 *  carry the glide return seam so the run uses the configured return, not a
 *  zero-return pool. POST_TAX/BROKERAGE so it is tax-classified conservatively
 *  and never RMD-eligible. */
function synthesizeHouseholdGlidePool(args: {
  startYear: number;
  horizonYear: number;
  allocation: RetirementAllocationOverride;
  retirementYear: number;
  stepCount: number;
}): DrawdownAccountInput {
  const returnPctByMonth = buildBlendedGlideReturnPctByMonth({
    startYear: args.startYear,
    baseAnnualRatePct: 0,
    allocation: args.allocation,
    retirementYear: args.retirementYear,
    stepCount: args.stepCount,
  });
  return {
    id: '__household-glide-pool__',
    initialPre: 0,
    initialPost: 0,
    annualRatePct: 0,
    depositsByMonth: emptyMonthlySeries(args.startYear, args.horizonYear),
    taxTreatment: 'POST_TAX',
    accountType: 'BROKERAGE',
    returnPctByMonth,
  };
}

/** Sum the carved rollover-year RMD portions (dollars) per calendar
 *  year across every linked-CBP post-retirement deposit. Returns an empty
 *  map when no split fired. */
function buildRolledRmdIncomeByYear(
  byTarget: ReadonlyMap<string, ReadonlyArray<PostRetirementCbpDeposit>>,
): ReadonlyMap<number, number> {
  const out = new Map<number, number>();
  byTarget.forEach((list) => {
    for (const ev of list) {
      if (ev.rmdPortionCents > 0) {
        out.set(ev.year, (out.get(ev.year) ?? 0) + ev.rmdPortionCents / 100);
      }
    }
  });
  return out;
}

interface ResolvedElections {
  readonly annuityIds: ReadonlySet<string>;
  readonly lumpSumElectedCbpIds: ReadonlySet<string>;
}

/** Resolve CBP election sets: annuity-elected ids (excluded from the
 *  ledger, income flows via the linked stream) and lumpSum-elected ids
 *  (excluded from the ledger; balance routes to target as a deposit). */
function resolveCbpElections(
  cbpElections: ReadonlyMap<string, import('./cbp-resolution').ResolvedCbpElection>,
): ResolvedElections {
  const annuityIds = new Set<string>();
  const lumpSumElectedCbpIds = new Set<string>();
  for (const [acctId, election] of cbpElections.entries()) {
    if (election.kind === 'annuity') annuityIds.add(acctId);
    else if (election.kind === 'lumpSum') lumpSumElectedCbpIds.add(acctId);
  }
  return { annuityIds, lumpSumElectedCbpIds };
}

interface PostRetirementCbpDeposit {
  readonly year: number;
  readonly month0: number;
  /** The dollars that ROLL into the target account's pre-tax bucket. For an
   *  at/after-trigger-year rollover this is the EXCESS (whole − RMD portion);
   *  otherwise the whole rolled balance. */
  readonly amount: number;
  readonly sourceCbpId: string;
  /** Rollover-year RMD carved out of the lump-sum (integer cents,
   *  distributed as taxable ordinary income — NOT rolled). 0 when the event
   *  is before the owner's RMD trigger year, the owner birthdate is missing,
   *  or the source is not RMD-qualifying (whole amount rolls). */
  readonly rmdPortionCents: number;
}

/** Build the ledger entry for a single account projection. Returns
 *  `null` when the account has no usable projection / unresolved rate.
 *  Zero-balance accounts that are CBP lump-sum targets KEEP
 *  their slot — pre/post start at zero, the event-month deposit
 *  attaches via `acc.deposit[i]`, the kernel compounds forward. Dropping
 *  the entry on `totalAtRet <= 0` would lose it before the deposit got
 *  attached, vanishing the transferred CBP dollars.
 *  A Fill-mode Roth conversion target (`isFillTargetRoth`) keeps its
 *  slot for the same reason — converted pre-tax dollars land in it via
 *  the per-year conversion step; a $0 starting balance must not drop it.
 *  Mixed-tax accounts pass actual `preTax`/`postTax` buckets so
 *  the per-account drawdown reflects the stored split. */
function buildLedgerEntry(args: {
  proj: import('./balance-projection-runner-types').AccountProjection;
  method: ProjectionMethod;
  startYear: number;
  horizonYear: number;
  targetedCbpDeposits: ReadonlyArray<PostRetirementCbpDeposit> | undefined;
  isFillTargetRoth: boolean;
  postPrimaryEvents: ReadonlyArray<ClassifiedDepositEvent> | undefined;
  plainPensionEvents: ReadonlyArray<ClassifiedDepositEvent> | undefined;
  /** When set, each NON-CBP account gets a blended-glide
   *  `returnPctByMonth` so allocation routes through the per-account path. CBP
   *  accounts (`RETIREMENT_CASH_BALANCE`) keep their scalar rate (glide-excluded,
   *  mirroring MC). Absent → no allocation → scalar-rate growth (unchanged). */
  allocation: RetirementAllocationOverride | undefined;
  retirementYear: number;
  stepCount: number;
  /** The resolved per-account floor + HSA mode for
   *  this account. Undefined ⇒ no floor (the common case). */
  floor?: ResolvedAccountFloor;
}): DrawdownAccountInput | null {
  const { proj, method, startYear, horizonYear, targetedCbpDeposits, isFillTargetRoth } = args;
  const projOut = proj.outputs[method];
  if (!projOut) return null;
  const totalAtRet = projOut.total;
  const hasTargetedDeposit =
    targetedCbpDeposits !== undefined && targetedCbpDeposits.length > 0;
  const hasPostPrimaryDeposit =
    args.postPrimaryEvents !== undefined && args.postPrimaryEvents.length > 0;
  const hasPlainPensionDeposit =
    args.plainPensionEvents !== undefined && args.plainPensionEvents.length > 0;
  // Drop only when the account has no positive balance, no incoming targeted
  // CBP deposit, no post-primary spouse contribution, and is not the
  // Fill-mode conversion target — each is a legitimate destination that starts
  // empty and is funded forward. Without the post-primary guard a spouse's
  // account that projects to $0 at primary retirement (funded only by
  // post-primary contributions) would silently vanish + diverge from MC.
  if (
    totalAtRet <= 0 &&
    !hasTargetedDeposit &&
    !hasPostPrimaryDeposit &&
    !hasPlainPensionDeposit &&
    !isFillTargetRoth
  )
    return null;
  // Any account lacking an empirical TWR rate falls back to its own
  // planned rate everywhere in the Historical view — including the per-account
  // drawdown ledger.  The Fill-target Roth additionally enters at $0 and needs
  // this fallback, but it is not the only account that can need it (a
  // short-history non-conversion account must also stay in the ledger).
  // `ratePctByMethod.planned` is the resolved planned rate
  // (`returnOverrides.get(id) ?? planningReturnPct`), matching what
  // `projectActiveAccounts` builds as `outputs[method]` for this account.
  const ratePct = proj.ratePctByMethod[method] ?? proj.ratePctByMethod.planned;
  if (ratePct === null) return null;
  const taxTreatment = proj.account.payload.taxTreatment;
  const { initialPre, initialPost } = splitInitialByTaxTreatment(
    totalAtRet,
    taxTreatment,
    // Pass actual projected pre/post buckets so MIXED accounts
    // reflect their stored split (not a 50/50 fallback).
    { preTax: projOut.preTax, postTax: projOut.postTax },
  );
  const depositsByMonth = emptyMonthlySeries(startYear, horizonYear);
  if (targetedCbpDeposits) {
    // `ev.amount` is the rolled EXCESS (whole − rollover-year RMD); the
    // carved RMD portion is distributed/taxed via the income inlet, not rolled.
    for (const ev of targetedCbpDeposits) {
      if (ev.amount > 0) addOneOff(depositsByMonth, ev.year, ev.month0, ev.amount);
    }
  }
  // Fold plain-pension lump-sum placements into the deposit series. The
  // whole amount routes via the `depositsByMonth` slot (→ bucketed by the
  // account's treatment by `applyMonthlyDeposits` downstream), the same seam
  // linked-CBP uses. Plain pensions get NO RMD split.
  if (args.plainPensionEvents) {
    for (const ev of args.plainPensionEvents) {
      if (ev.amount <= 0) continue;
      const year = Math.floor(ev.month / 12);
      const month0 = ev.month - year * 12;
      addOneOff(depositsByMonth, year, month0, ev.amount);
    }
  }
  // Fold each post-primary contribution's pre/post split into the
  // per-account deposit series. The pre-tax slice joins `depositsByMonth`
  // (routed to `pre` by treatment via `applyMonthlyDeposits`); the
  // designated-Roth slice goes to a parallel post-only series that always
  // lands in `post` (a MIXED account's Roth slice stays RMD-exempt, §325).
  const depositsPostByMonth = emptyMonthlySeries(startYear, horizonYear);
  if (args.postPrimaryEvents) {
    for (const ev of args.postPrimaryEvents) {
      const year = Math.floor(ev.month / 12);
      const month0 = ev.month - year * 12;
      const pre = ev.amountPre ?? 0;
      const post = ev.amountPost ?? 0;
      if (pre !== 0) addOneOff(depositsByMonth, year, month0, pre);
      if (post !== 0) addOneOff(depositsPostByMonth, year, month0, post);
    }
  }
  // A CBP account keeps its scalar planning rate (glide-excluded); every
  // other account under an allocation override gets the household blended-glide
  // per-month return series so the per-account path applies the configured glide.
  const accountType = proj.account.payload.type;
  const returnPctByMonth =
    args.allocation !== undefined && accountType !== 'RETIREMENT_CASH_BALANCE'
      ? buildBlendedGlideReturnPctByMonth({
          startYear,
          baseAnnualRatePct: ratePct,
          allocation: args.allocation,
          retirementYear: args.retirementYear,
          stepCount: args.stepCount,
        })
      : undefined;
  return {
    id: proj.account.id,
    initialPre,
    initialPost,
    annualRatePct: ratePct,
    depositsByMonth,
    depositsPostByMonth,
    taxTreatment,
    accountType,
    ...(returnPctByMonth ? { returnPctByMonth } : {}),
    // Carry the resolved per-account floor +
    // HSA mode into the engine. Only set when a real floor resolved; engine
    // eligibility (taxTreatment ∈ {POST_TAX, HSA}) gates effect.
    ...(args.floor !== undefined
      ? { floorDollars: args.floor.floorDollars, floorHsaMode: args.floor.hsaMode }
      : {}),
  };
}

/** Resolve post-primary-retirement CBP lump-sum events to their target
 *  accounts. The CBP source's lump-sum amount is the source's projected
 *  pre+post balance compounded forward from primary retirement to the
 *  event month at the source's `planningReturnPct` — the CBP
 *  projection's `perStep` ends at retirement (no drawdown phase in
 *  `project()`), so post-primary balances must be derived forward. */
function collectPostRetirementCbpLumpSumDeposits(args: {
  ctx: import('./balance-projection-runner-types').PipelineContext;
  cbpElections: ReadonlyMap<string, import('./cbp-resolution').ResolvedCbpElection>;
}): ReadonlyMap<string, ReadonlyArray<PostRetirementCbpDeposit>> {
  const { ctx, cbpElections } = args;
  const cbpAccountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  // Owner-birthdate lookup for the rollover-year RMD split. Resolve
  // the source CBP owner via `payload.ownerId` → the household member's
  // birthdate. Any miss falls through to `rmdPortion = 0` (whole amount rolls).
  const birthdateByMemberId = new Map<string, string>();
  if (ctx.primary?.payload?.birthdate) {
    birthdateByMemberId.set(ctx.primary.id, ctx.primary.payload.birthdate);
  }
  if (ctx.secondary?.payload?.birthdate) {
    birthdateByMemberId.set(ctx.secondary.id, ctx.secondary.payload.birthdate);
  }
  const rmdSnapshot = (ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE).rmd;
  const byTarget = new Map<string, PostRetirementCbpDeposit[]>();
  for (const [cbpId, eventAbsMonth] of ctx.cbpLumpSumEventAbsMonth.entries()) {
    if (eventAbsMonth < ctx.primaryRetirementAbsMonth) continue;
    const election = cbpElections.get(cbpId);
    if (!election || election.kind !== 'lumpSum') continue;
    const target = election.targetAccountId;
    if (!target) continue;
    const cbpProj = ctx.cbpProjectionByAccount.get(cbpId);
    if (!cbpProj) continue;
    const cbpAccount = cbpAccountById.get(cbpId);
    if (!cbpAccount) continue;
    const monthsPastRetirement = eventAbsMonth - ctx.primaryRetirementAbsMonth;
    if (monthsPastRetirement < 0) continue;
    const planningRate = cbpAccount.payload.planningReturnPct;
    const monthlyFactor = Math.pow(1 + planningRate / 100, 1 / 12);
    const amount = cbpProj.total * Math.pow(monthlyFactor, monthsPastRetirement);
    if (amount <= 0) continue;
    const year = Math.floor(eventAbsMonth / 12);
    const month0 = eventAbsMonth - year * 12;
    // Split (linked-CBP only): when the rollover lands in/after the source
    // owner's RMD trigger year, carve that year's RMD out FIRST (taxable,
    // distributed) and roll only the excess. The shared pure helper is the
    // SINGLE split site — the MC seam calls the same signature so the two
    // engines agree to the cent.
    const ownerBirthdate = birthdateByMemberId.get(cbpAccount.payload.ownerId);
    const basisCents = Math.round(amount * 100);
    const split = splitRolloverByRmd({
      basisCents,
      ownerBirthdate,
      eventYear: year,
      sourceTaxTreatment: cbpAccount.payload.taxTreatment,
      // A MIXED source CBP carves its RMD only on the pre-tax
      // (non-Roth-designated) portion (SECURE 2.0 §325). The Roth fraction
      // is the projected post-tax bucket share, applied to the rolled basis.
      ...(cbpAccount.payload.taxTreatment === 'MIXED'
        ? { rothPortionCents: cbpRothPortionCents(cbpProj, basisCents) }
        : {}),
      rmdSnapshot,
    });
    const entry: PostRetirementCbpDeposit = {
      year,
      month0,
      // Only the EXCESS rolls into the target's pre-tax bucket.
      amount: split.rolloverExcessCents / 100,
      sourceCbpId: cbpId,
      rmdPortionCents: split.rmdPortionCents,
    };
    const list = byTarget.get(target);
    if (list) list.push(entry);
    else byTarget.set(target, [entry]);
  }
  return byTarget;
}

/** The Roth-designated (post-tax) portion of a MIXED source CBP's
 *  rolled basis, in integer cents. The split helper excludes this from the
 *  RMD computation (SECURE 2.0 §325) so a MIXED plan does not over-distribute.
 *  Derived from the projection's post-tax bucket SHARE applied to the rolled
 *  basis (the basis is the projected total compounded to the event month, so
 *  the share — not the at-retirement post-tax dollars — keeps it consistent).
 *  Returns 0 when the projection has no positive total (whole basis is pre-tax). */
function cbpRothPortionCents(
  cbpProj: import('./projection').ProjectionOutput,
  basisCents: number,
): number {
  if (cbpProj.total <= 0 || cbpProj.postTax <= 0) return 0;
  const rothFraction = Math.min(1, cbpProj.postTax / cbpProj.total);
  return Math.round(basisCents * rothFraction);
}

/** Flatten the per-target CBP deposit map into a list the runner
 *  subtracts from the household-aggregate `depositsByMonth`.
 *
 *  The household-aggregate series carries the FULL GROSS rolled balance
 *  (via `incomeProjection.depositInflow`), so the subtraction must remove the
 *  full gross too — the rolled EXCESS (`ev.amount`) PLUS the carved RMD portion
 *  (`ev.rmdPortionCents`). The carved RMD is re-injected as taxable income +
 *  spendable cash via `rolledRmdIncomeByYear`; without subtracting it here it
 *  would remain in the household deposit spread AND be added to income —
 *  a double-count. The per-account deposit routing still uses only `ev.amount`
 *  (the excess), so the target account is credited correctly. */
function flattenCbpDeposits(
  byTarget: ReadonlyMap<string, ReadonlyArray<PostRetirementCbpDeposit>>,
): ReadonlyArray<{ year: number; month0: number; amount: number }> {
  const out: Array<{ year: number; month0: number; amount: number }> = [];
  byTarget.forEach((list) => {
    for (const ev of list) {
      const gross = ev.amount + ev.rmdPortionCents / 100;
      if (gross > 0) {
        out.push({ year: ev.year, month0: ev.month0, amount: gross });
      }
    }
  });
  return out;
}

/**
 * Build the resolved pipeline context the deterministic + MC entry
 * points share. Returns `null` when the scenario has no primary or no
 * resolvable primary retirement date — callers throw
 * `NoPrimaryRetirementError` to fail-fast.
 */
export function buildPipelineContext(
  args: RunBalanceProjectionArgs,
): PipelineContext | null {
  const primary = args.members.find((m) => m.payload.isPrimary);
  if (!primary) return null;
  const effectiveScenarios = withCandidateOverlay(args);
  const resolved = resolveScenario(args.scenarioId, [...effectiveScenarios]);
  const retirementByMember = resolveMemberRetirementDates(
    resolved.retirementAge,
    args.members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate,
    })),
  );
  const primaryRetIso = retirementByMember.get(primary.id) ?? null;
  if (!primaryRetIso) return null;
  const primaryRetirementYear = Number(primaryRetIso.slice(0, 4));
  const primaryRetirementMonth0 = Number(primaryRetIso.slice(5, 7)) - 1;
  const primaryRetirementAbsMonth =
    primaryRetirementYear * 12 + primaryRetirementMonth0;
  const secondary = args.members.find((m) => !m.payload.isPrimary);
  const horizonYear = computeHorizonYear(primary, secondary, resolved.lifeExpectancy);
  const horizonAbsMonth = horizonYear * 12 + 11;
  const activeAccounts = args.accounts.filter((a) => a.payload.active);
  const cbpAccounts = activeAccounts.filter(
    (a) => a.payload.type === 'RETIREMENT_CASH_BALANCE',
  );
  // Phase order: CBP-validation runs first, then method-availability
  // check, then projection. `cbpValidation` is unconditional on the
  // returned context — the public `runBalanceProjection` surfaces it
  // on `RunBalanceProjectionFullResult.cbpResolution` even when later
  // phases short-circuit. `runBalanceProjectionMc` (optimizer / MC
  // orchestrator path) keeps the throw semantics by checking it
  // separately after this call.
  const cbpValidation =
    cbpAccounts.length > 0
      ? validateCbpResolution({
          scenarioId: args.scenarioId,
          scenarios: effectiveScenarios,
          accounts: cbpAccounts,
          incomeStreams: args.incomeStreams,
        })
      : null;
  const cbpProjectionByAccount = preProjectCbpAccounts({
    activeAccounts,
    args,
    resolved,
    primaryRetIso,
    retirementByMember,
  });
  const { preDepositsByAccount, cbpLumpSumEventAbsMonth } = classifyTargetedDeposits({
    args,
    primary,
    secondary,
    primaryRetirementAbsMonth,
    primaryRetirementYear,
    primaryRetirementMonth0,
    resolved,
    retirementByMember,
    cbpProjectionByAccount,
  });
  // Working-years Roth conversions (deterministic only). The
  // pre-pass projects each source account (no conversions) to clamp each year's
  // conversion to the available source pre-tax balance, then emits the source
  // pre-tax OUTFLOW + target Roth INFLOW legs of the SAME `actualGross`. The
  // target inflow merges into the targeted-deposit map; the source outflow
  // threads into `project()` as `preRetirementWithdrawals`. The per-owner
  // converted-principal cents fold into the at-retirement Roth basis seed
  // so the converted principal is tax-free in drawdown.
  const rothConversions = computePreRetirementRothConversions({
    scenarioId: args.scenarioId,
    scenarios: effectiveScenarios,
    accounts: activeAccounts,
    balances: args.balances,
    members: args.members,
    retirementByMember,
    primaryRetIso,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex,
    stopContributionsToday: resolved.contributions?.stopContributionsToday ?? false,
  });
  const preDepositsWithConversions = mergePreDeposits(
    preDepositsByAccount,
    rothConversions.preDepositsByAccount,
  );
  const {
    projections: accountProjections,
    methodAvailable,
    fallbackAccounts,
  } = projectActiveAccounts({
    activeAccounts,
    args,
    resolved,
    primaryRetIso,
    retirementByMember,
    preDepositsByAccount: preDepositsWithConversions,
    preWithdrawalsByAccount: rothConversions.preWithdrawalsByAccount,
  });
  const ssStartYear = computeSsStartYear(primary, resolved.socialSecurity);
  // Numbers-in. No Date reads inside the runner — the caller
  // pre-resolves the anchor (BPP: local; optimizer: UTC).
  // The household's Roth tax profile, built once here by the profile adapter.
  // It replaces any balance-derived basis estimate: seeding pure employer-Roth
  // balances and the Roth slice of MIXED accounts as though the ENTIRE
  // projected balance were recoverable basis would overstate basis. A Roth
  // IRA's §408A basis is derived from the pool's recorded
  // contribution/withdrawal history instead of a stored total, and an
  // employer plan's designated-Roth basis is its recorded in-plan-rollover
  // principal alone; nothing is ever back-filled from a projected balance.
  const accountFactInputs = buildRothAccountFactInputs(args.accounts);
  // The adapter gets the NON-DELETED account set (`args.accounts` is already
  // tombstone-filtered upstream), because its two branches scope themselves
  // differently on purpose:
  //   - Roth IRAs count ACTIVE AND INACTIVE alike. An inactive Roth IRA's
  //     recorded contribution history is real §408A basis: the money did not
  //     evaporate when the account closed, it followed a rollover into a sibling
  //     account the pool still holds, and the §408A pool is the owner's Roth IRAs
  //     as one taxpayer-level whole (Pub 590-B aggregation).
  //   - Designated-Roth employer facts stay ACTIVE-ONLY. An
  //     inactive plan carries no balance at all (`ACCOUNT_NOT_ZEROED` enforces
  //     that at save time), so its recorded basis has nothing behind it and would
  //     inflate the pooled basis numerator against an active sibling's balance.
  // The pooled five-year CLOCK is likewise still contributed by active accounts
  // only — the widening is about basis, not about Roth qualification.
  // The adapter only looks up balance rows for accounts it was handed, so passing
  // the whole ledger keeps each branch's scoping intact.
  const rothDistributionFacts = buildRothDistributionFacts(
    accountFactInputs,
    args.balances,
  );
  // Each member's SPOUSE birthdate (the other member's), so the RMD
  // engine's Table II age-gap test reads the household's own dates instead of a
  // second copy re-typed into every account. A single-member household has no
  // spouse, so the map stays empty and the engine's conservative default holds.
  const spouseBirthdateByOwnerId = new Map<string, string>();
  if (secondary) {
    if (primary.payload.birthdate) {
      spouseBirthdateByOwnerId.set(secondary.id, primary.payload.birthdate);
    }
    if (secondary.payload.birthdate) {
      spouseBirthdateByOwnerId.set(primary.id, secondary.payload.birthdate);
    }
  }
  // Each member's own birthdate — on an INHERITED account the owner is the
  // beneficiary, so this is the Table I date the editor used to ask for again.
  const ownBirthdateByMemberId = new Map<string, string>();
  for (const m of args.members) {
    if (m.payload.birthdate) ownBirthdateByMemberId.set(m.id, m.payload.birthdate);
  }
  const rmdProfileFactsByAccountId = buildRmdProfileFactsByAccount(
    accountFactInputs,
    spouseBirthdateByOwnerId,
    ownBirthdateByMemberId,
  );
  // Each owner's REMAINING Roth-IRA regular-contribution basis
  // (integer cents), derived by the adapter from the pool's recorded balance
  // history: contributions credited, recorded and imputed withdrawals charged,
  // contributions consumed before conversion lots. Seeds the DETERMINISTIC
  // cumulative §408A tracker; the MC tracker does NOT read this map — it
  // seeds from a DRAWABLE-only re-derivation over the same pools
  // (`mcDrawableRothBasisCentsByOwner` in `buildMcTaxContext`, which excludes
  // every `allAccountsInactive` pool's share, so an all-closed pool's
  // unreachable basis never shelters another owner's MC draw). An owner whose
  // history leaves nothing is absent (→ $0, every distributed dollar past the
  // remaining lots is earnings). Summed across the owner's §408A POOLS — which
  // are their OWN accounts only: an inherited Roth IRA contributes no pool,
  // so no inherited basis can enter this total on either engine's side
  // (MC's ordered pool excludes the same inherited dollars on its own). The
  // five-year CLOCKS stay per-pool (`rothDistributionFacts.rothIraByPool` →
  // `rothOrderedProfile`).
  const rothBasisCentsByOwner = new Map<string, number>();
  for (const pool of rothDistributionFacts.rothIraByPool.values()) {
    const cents = pool.rothIra?.regularContributionBasisCents ?? 0;
    if (cents <= 0) continue;
    rothBasisCentsByOwner.set(
      pool.ownerId,
      (rothBasisCentsByOwner.get(pool.ownerId) ?? 0) + cents,
    );
  }
  // The working-years converted-principal basis is kept in a SEPARATE
  // per-owner map — NOT folded into `rothBasisCentsByOwner`. `rothBasisCentsByOwner`
  // is threaded into the MC tax context (`buildMcTaxContext`), and the MC path does
  // NOT model the conversion deposit legs (working-years conversions are modeled
  // only in the deterministic projections, not in the stress test). Folding the conversion basis there
  // would inflate the MC Roth basis seed and shield MC Roth withdrawals from tax that
  // the MC Roth balance never received. The DETERMINISTIC drawdown path adds this
  // separate map to its basis seed (`balance-projection-runner-tax.ts` →
  // `seedRothBasisCarrier`), so the converted principal withdraws tax-free
  // (§408A contributions-first) there and only there.
  const preRetirementConversionBasisCentsByOwner = new Map<string, number>(
    rothConversions.basisCentsByOwner,
  );
  // Per-owner PURE designated-Roth employer-plan basis, taken from
  // each account's recorded in-plan-rollover principal instead of its
  // at-retirement balance. No runtime consumer: the deterministic
  // FUNDING pass — the one consumer this was derived for — now pools its
  // designated state per owner directly from
  // `rothDistributionFacts.designatedByAccount` (`seedSolverDesignatedRothStates`),
  // and the ANNOTATION post-pass and Monte Carlo read per-account state as they
  // always did (`designatedByAccount` / `rothOrderedProfile`). Kept as a
  // context-surface convenience with its derivation pinned. No recorded in-plan
  // rollover → $0.
  const pureRothBasisCentsByOwner = args.accounts.reduce<Map<string, number>>(
    (map, account) => {
      if (!isPureRothEmployerType(account.payload.type)) return map;
      if (!account.payload.active) return map;
      const cents = rothDistributionFacts.designatedByAccount.get(account.id)?.basisCents ?? 0;
      if (cents <= 0) return map;
      const ownerId = account.payload.ownerId;
      map.set(ownerId, (map.get(ownerId) ?? 0) + cents);
      return map;
    },
    new Map<string, number>(),
  );
  // Per-owner MIXED Roth-designated employer-plan basis, likewise
  // the account's recorded in-plan-rollover principal rather than the
  // at-retirement post sub-bucket balance. Same status as
  // `pureRothBasisCentsByOwner` above (no runtime consumer: the funding
  // pass reads the per-account facts); the two stay mutually disjoint because
  // a given account is either a pure-Roth employer type or a MIXED
  // Roth-designated one.
  const mixedRothDesignatedBasisCentsByOwner = args.accounts.reduce<Map<string, number>>(
    (map, account) => {
      if (account.payload.taxTreatment !== 'MIXED') return map;
      if (!isRothDesignatedRetirementType(account.payload.type)) return map;
      if (!account.payload.active) return map;
      const cents = rothDistributionFacts.designatedByAccount.get(account.id)?.basisCents ?? 0;
      if (cents <= 0) return map;
      const ownerId = account.payload.ownerId;
      map.set(ownerId, (map.get(ownerId) ?? 0) + cents);
      return map;
    },
    new Map<string, number>(),
  );
  // Dual-write contract: store the same-account MIXED in-plan conversion basis
  // in its own field (`mixedInPlanConversionBasisCentsByOwner`) rather than folding
  // it into `mixedRothDesignatedBasisCentsByOwner`. Keeping them apart means
  // conversion principal (which MC does not model) can never leak into a map an
  // MC seed might read. MC seeds from `rothOrderedProfile` and reads neither
  // map, so the split records PROVENANCE
  // only: recorded account facts vs engine-generated conversion principal. The
  // deterministic FUNDING pass takes this principal through the DATED per-account
  // maps below (`mergeDesignatedRothSeeds` → `seedSolverDesignatedRothStates`),
  // the same merge the annotation pass seeds from, so this owner-level total has
  // no runtime consumer either.
  const mixedInPlanConversionBasisCentsByOwner = new Map<string, number>(
    rothConversions.mixedInPlanBasisCentsByOwner,
  );
  // The same principal keyed by target ACCOUNT, credited to that account's
  // own designated-Roth carrier (designated-Roth accounts never pool).
  const mixedInPlanConversionBasisCentsByAccount = new Map<string, number>(
    rothConversions.mixedInPlanBasisCentsByAccount,
  );
  // The SAME two principals DATED by conversion / rollover tax year, so the
  // deterministic seeds create real dated LOTS (each with its own five-tax-year
  // recapture clock) instead of undated basis that could never be recaptured.
  const preRetirementConversionBasisCentsByOwnerYear = new Map<
    string,
    ReadonlyMap<number, number>
  >(rothConversions.basisCentsByOwnerYear);
  const mixedInPlanConversionBasisCentsByAccountYear = new Map<
    string,
    ReadonlyMap<number, number>
  >(rothConversions.mixedInPlanBasisCentsByAccountYear);
  const asOfMonth = args.todayYear * 12 + args.todayMonthIndex;
  // Source the general rate from the per-key resolver so one resolver owns
  // the deterministic pipeline's inflation (the cashflow band reads the same
  // resolver for per-category rates → tax feedback flows automatically).
  // The income / balance deflators legitimately use the single general rate.
  const resolvedInflation = resolveInflationForScenario(args.scenarioId, [
    ...effectiveScenarios,
  ]);
  // QCD: resolve + harden the per-member directives against the live
  // account + member sets. Drops malformed / cross-owner / non-PRE_TAX-IRA /
  // invalid-window entries and clamps each start to the 70½ floor; empty when
  // nothing resolves (engine pass is then a no-op).
  const resolvedQcd = resolveQcdForScenario(
    args.scenarioId,
    [...effectiveScenarios],
    activeAccounts.map((a) => ({ id: a.id, payload: a.payload })),
    args.members,
  );
  const projCtx: ProjectionContext = {
    asOfYear: args.todayYear,
    asOfMonthIndex: args.todayMonthIndex,
    asOfMonth,
    firstProjectionMonth: asOfMonth,
    primaryRetirementMonth: primaryRetirementAbsMonth,
    horizonMonth: horizonAbsMonth,
    inflationPct: resolvedInflation.ratePct,
  };
  return {
    scenarioId: args.scenarioId,
    method: args.method ?? 'planned',
    incomeStreams: args.incomeStreams,
    resolvedScenario: resolved,
    effectiveScenarios,
    primary,
    secondary,
    primaryRetIso,
    primaryRetirementYear,
    primaryRetirementMonth0,
    primaryRetirementAbsMonth,
    retirementByMember,
    horizonYear,
    horizonAbsMonth,
    ssStartYear,
    projCtx,
    accountProjections,
    cbpLumpSumEventAbsMonth,
    preDepositsByAccount,
    cbpProjectionByAccount,
    cbpValidation,
    methodAvailable,
    fallbackAccounts,
    taxBundle: args.taxBundle,
    rothBasisCentsByOwner,
    rothDistributionFacts,
    rmdProfileFactsByAccountId,
    preRetirementConversionBasisCentsByOwner,
    pureRothBasisCentsByOwner,
    mixedRothDesignatedBasisCentsByOwner,
    mixedInPlanConversionBasisCentsByOwner,
    mixedInPlanConversionBasisCentsByAccount,
    preRetirementConversionBasisCentsByOwnerYear,
    mixedInPlanConversionBasisCentsByAccountYear,
    preRetirementConversionCentsByYear: rothConversions.conversionCentsByYear,
    // ACA opt-out: resolve the member-id set (default `[]`) into a Set the
    // tax-integration member-flag derivation reads (`buildMemberInputs` →
    // `hasAcaCoverage`). Always present; an absent override → no opt-outs.
    acaMarketplaceOptOutMemberIds: new Set(
      resolved.acaMarketplaceOptOutMemberIds ?? [],
    ),
    // Per-member/year coverage months + FPL region. Both sparse-optional:
    // an absent key leaves the whole-year derivation / contiguous-48 FPL in
    // place, so a scenario that sets neither is unchanged.
    ...(resolved.healthCoverageMonths !== undefined
      ? { healthCoverageMonths: resolved.healthCoverageMonths }
      : {}),
    ...(resolved.acaFplRegion !== undefined ? { acaFplRegion: resolved.acaFplRegion } : {}),
    medicalInflationRatePct: resolveMedicalInflationPct(args.scenarioId, [
      ...effectiveScenarios,
    ]),
    resolvedQcd,
  };
}

/** Merge the working-years Roth-conversion target inflows into the
 *  targeted-deposit map (both keyed by account id). A fresh map is returned;
 *  per-account lists are concatenated (conversion deposits appended after the
 *  existing targeted deposits — deterministic order). Either map may be empty. */
function mergePreDeposits(
  base: ReadonlyMap<string, PreDepositList>,
  conversions: ReadonlyMap<string, PreDepositList>,
): ReadonlyMap<string, PreDepositList> {
  if (conversions.size === 0) return base;
  const out = new Map<string, PreDepositList[number][]>();
  for (const [id, list] of base) out.set(id, [...list]);
  for (const [id, list] of conversions) {
    const existing = out.get(id);
    if (existing) existing.push(...list);
    else out.set(id, [...list]);
  }
  return out;
}

function withCandidateOverlay(
  args: RunBalanceProjectionArgs,
): ReadonlyArray<ScenarioAggregate> {
  if (!args.candidateOverlay) return args.scenarios;
  const target = args.scenarios.find((s) => s.id === args.scenarioId);
  if (!target) return args.scenarios;
  const others = args.scenarios.filter((s) => s.id !== args.scenarioId);
  // Seed the overlaid block from the RESOLVED (inherited-aware) SS
  // override, not the target's LOCAL block. Writing a local `socialSecurity`
  // block onto a child scenario shadows the parent's whole section
  // (resolution is section-level first-wins), so basing the overlay on the
  // local block would silently drop inherited fields — survivor claim ages,
  // COLA / benefit-reduction settings — whenever the candidate carried no
  // value of its own (reachable: the prospective survivor past 70 makes the
  // survivor dimension empty while the other spouse's claim age is still
  // searched). MC (`computeSsByYearForClaimAges`) and Apply
  // (`mergeSsOverride`) already read the resolved block; the deterministic
  // ranking must simulate the same plan.
  const resolvedSs = resolveScenario(args.scenarioId, [
    ...args.scenarios,
  ]).socialSecurity;
  const overlaid: ScenarioPayload = {
    ...target.payload,
    overrides: {
      ...target.payload.overrides,
      socialSecurity: {
        ...(resolvedSs ?? {}),
        primary: args.candidateOverlay.socialSecurity.primary,
        ...(args.candidateOverlay.socialSecurity.secondary
          ? { secondary: args.candidateOverlay.socialSecurity.secondary }
          : {}),
        // Overlay-supplied survivor claim ages win; otherwise the
        // RESOLVED stored survivor section (spread above) is preserved.
        ...(args.candidateOverlay.socialSecurity.survivor
          ? { survivor: args.candidateOverlay.socialSecurity.survivor }
          : {}),
      },
    },
  };
  return [{ ...target, payload: overlaid }, ...others];
}

function computeHorizonYear(
  primary: Aggregate<HouseholdMemberPayload>,
  secondary: Aggregate<HouseholdMemberPayload> | undefined,
  lifeExpectancy: { primary?: number; secondary?: number } | undefined,
): number {
  // Death = Dec 31 of `deathYear` (`deathYear = birthYear +
  // lifeExpectancyAge`), the terminal year, so the drawdown horizon ends
  // at `deathYear` for everyone. `projectedDeathFractionalYear`
  // returns the integer `deathYear`, so `Math.ceil` is the identity and
  // this matches the integer marker the page derives `lastDeathYear` from.
  // The invalid-birthdate fallback `birthYear + age` = `deathYear` agrees
  // with the main path.
  const candidates: number[] = [];
  const tryAdd = (
    member: Aggregate<HouseholdMemberPayload>,
    slot: 'primary' | 'secondary',
  ): void => {
    const age = lifeExpectancy?.[slot] ?? DEFAULT_LIFE_EXPECTANCY_AGE;
    const iso = member.payload.birthdate;
    if (iso) {
      const frac = projectedDeathFractionalYear(iso, age);
      if (frac !== null) {
        candidates.push(Math.ceil(frac));
        return;
      }
    }
    const birthYear = Number(iso?.slice(0, 4) ?? 0);
    candidates.push(
      Number.isFinite(birthYear) && birthYear > 0
        ? birthYear + age
        : new Date().getFullYear() + age,
    );
  };
  tryAdd(primary, 'primary');
  if (secondary) tryAdd(secondary, 'secondary');
  return Math.max(...candidates);
}

/**
 * The per-account RMD facts + per-owner separation years the shared
 * `computeRmd` engine needs, as plain `Record`s.
 *
 * ONE derivation for all three consumers so they cannot drift: the deterministic
 * forced-withdrawal context (`buildRmdContext`), the Monte Carlo context
 * (`buildMcRmdContext`), and — through the latter — the MC strategy path's own
 * forced-withdrawal context. Plain objects, not `Map`s, because the MC shape has
 * to survive both `postMessage` and the `JSON.stringify` cache key.
 *
 * Account ids are inserted in ASCENDING order so two semantically-identical fact
 * sets serialise identically and hash to ONE `mcCacheKey`. Returns `{}` when the
 * household records no RMD fact at all, which keeps a fact-free household's
 * serialized MC input byte-unchanged AND keeps `computeRmd` on its default
 * Uniform-Lifetime branch in both engines.
 */
export function buildRmdEngineFactsFragment(ctx: PipelineContext): {
  rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>;
  retirementYearByOwner?: Readonly<Record<string, number>>;
} {
  if (ctx.rmdProfileFactsByAccountId.size === 0) return {};
  // Built through `Object.fromEntries`, which DEFINES
  // own properties, NOT by `obj[accountId] = …`. Account ids are user-controlled
  // (an IMPORTED aggregate may carry any non-empty id), and assigning to the id
  // `"__proto__"` hits `Object.prototype`'s accessor instead of creating an own
  // key: the account then VANISHES from `JSON.stringify`, silently dropping its
  // RMD facts from the Monte Carlo input while the deterministic engine's `Map`
  // still holds them (CWE-1321 — a security bug AND a twin divergence).
  const rmdFactsByAccountId = Object.fromEntries(
    [...ctx.rmdProfileFactsByAccountId.keys()]
      .sort()
      .map((accountId): [string, RmdAccountProfileFacts] => [
        accountId,
        ctx.rmdProfileFactsByAccountId.get(accountId)!,
      ]),
  );
  // The SAME canonical per-member derivation the health twin threads
  // (`resolveRetirementYearByMember`), so the RMD later-of rule and the
  // Marketplace-month gate can never disagree about when a member retired.
  // Entries stay in the fixed primary-then-secondary order (deterministic per
  // household, so the serialized `mcRmdContext` is byte-unchanged) and are built
  // through `Object.fromEntries`, which DEFINES own properties rather than
  // assigning — an imported `"__proto__"` member id cannot reach the prototype.
  const retirementYearByOwner = Object.fromEntries(resolveRetirementYearByMember(ctx));
  return { rmdFactsByAccountId, retirementYearByOwner };
}

function computeSsStartYear(
  primary: Aggregate<HouseholdMemberPayload>,
  ssOverride: { primary?: RetirementAgePerMember } | undefined,
): number {
  const birthYear = Number(primary.payload.birthdate?.slice(0, 4) ?? 0);
  const claimAge = ssOverride?.primary?.ageYears ?? 67;
  if (!Number.isFinite(birthYear) || birthYear === 0) {
    return new Date().getFullYear() + claimAge;
  }
  return birthYear + claimAge;
}
