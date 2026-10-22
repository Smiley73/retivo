/**
 * Pipeline-context builder shared by the deterministic and MC entry points: scenario resolution, horizon, SS
 * start and the per-account drawdown ledger.
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
// The fact-based Roth and RMD profile adapters.
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

export {
  buildMemberRetirementMap,
  makeCbpBalanceLookup,
} from './balance-projection-runner-projection';

/**
 * The per-account ledger plus the post-primary CBP lump-sum deposits already routed per account. The caller
 * must subtract those dollars from the household-aggregate `depositsByMonth`, or the kernel applies them
 * twice.
 */
export interface PerAccountDrawdownLedger {
  readonly accounts: ReadonlyArray<DrawdownAccountInput>;
  /**
   * Post-primary CBP lump-sum deposits already attributed to a target account's `depositsByMonth`; callers
   * subtract them from the household aggregate.
   */
  readonly cbpLumpSumDeposits: ReadonlyArray<{
    readonly year: number;
    readonly month0: number;
    readonly amount: number;
  }>;
  /**
   * Plain-pension lump-sum dollars placed into a target account's `depositsByMonth`; callers subtract them
   * from the household aggregate. Events whose target was not in the ledger are omitted and stay in the
   * spread.
   */
  readonly plainPensionDeposits: ReadonlyArray<{
    readonly year: number;
    readonly month0: number;
    readonly amount: number;
  }>;
  /**
   * Per-calendar-year rolled-CBP RMD income in dollars: the rollover-year RMD carved from a linked-CBP
   * lump-sum landing in or after the source owner's RMD trigger year. It is ordinary income and spendable
   * cash, injected into both the tax inlet and the income series (as MC `otherIncome` does). Empty when no
   * split fired.
   */
  readonly rolledRmdIncomeByYear: ReadonlyMap<number, number>;
}

/**
 * Builds the per-account drawdown ledger from a resolved pipeline context. Annuity-elected CBP and every
 * lump-sum-elected linked-CBP source are excluded; a post-primary lump-sum source is a transfer, so its
 * projected at-event balance lands in the target's `depositsByMonth`.
 * Returns the ledger and the CBP lump-sum deposits already attributed to targets, which callers must subtract
 * from the household aggregate (it carries the same dollars via `depositInflow`).
 */
export function buildPerAccountDrawdownLedger(args: {
  ctx: import('./balance-projection-runner-types').PipelineContext;
  method: ProjectionMethod;
  expensesByMonth: MonthlyCashflowSeries;
  /**
   * Post-primary spouse contribution events (with pre/post split and `accountId`), routed into their
   * destination account's deposit series instead of the household pool.
   */
  postPrimaryEvents?: ReadonlyArray<ClassifiedDepositEvent>;
  /**
   * Post-retirement plain-pension lump-sum events (with `accountId` and absolute `month`), routed whole into
   * the target account like a one-off windfall. Targets absent from the ledger stay in the household spread
   * and are not reported in `plainPensionDeposits`.
   */
  plainPensionEvents?: ReadonlyArray<ClassifiedDepositEvent>;
}): PerAccountDrawdownLedger {
  const { ctx, method, expensesByMonth } = args;
  // Grouped by destination account so each ledger entry folds in its own pre/post deposit slices.
  const postPrimaryByAccount = new Map<string, ClassifiedDepositEvent[]>();
  for (const ev of args.postPrimaryEvents ?? []) {
    if (!ev.accountId) continue;
    const list = postPrimaryByAccount.get(ev.accountId);
    if (list) list.push(ev);
    else postPrimaryByAccount.set(ev.accountId, [ev]);
  }
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
  const postRetirementCbpDeposits = collectPostRetirementCbpLumpSumDeposits({
    ctx,
    cbpElections,
  });
  const horizonYear =
    expensesByMonth.startYear +
    Math.floor(expensesByMonth.values.length / 12) -
    1;
  // Each Fill-mode window's target Roth must keep its drawdown-state slot at a $0 balance, or a freshly
  // created empty Roth would be dropped by the zero-balance filter and the conversion would silently degrade.
  const rawCap = ctx.resolvedScenario.magiCap;
  const fillTargetRothIds = new Set<string>();
  if (rawCap !== undefined && !('disabled' in rawCap)) {
    for (const w of rawCap.windows) {
      if (w.capMode === 'fill' && w.targetRothAccountId !== undefined) {
        fillTargetRothIds.add(w.targetRothAccountId);
      }
    }
  }
  // With a `retirementAllocation` override, non-CBP accounts get a blended-glide `returnPctByMonth` so
  // allocation routes through the per-account path; CBP keeps its scalar rate, as in MC.
  const allocationOverride = ctx.resolvedScenario.retirementAllocation;
  const retirementYear = ctx.primaryRetirementYear;
  const stepCount = (horizonYear - expensesByMonth.startYear + 1) * 12;
  // Per-account floors (per-field first-ancestor-wins, CWE-20 sanitised).
  const floorsByAccount = resolveAccountFloorsForScenario(
    ctx.scenarioId,
    [...ctx.effectiveScenarios],
    ctx.accountProjections.map((p) => p.account),
  );
  const accounts: DrawdownAccountInput[] = [];
  // Tracks the placements that landed in a ledger entry, so the caller subtracts exactly those from the
  // household spread.
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
  // With no funded non-CBP account for the glide to reach, synthesize one household-pool account carrying the
  // blended return so an allocation scenario never errors or runs a zero-return pool.
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

// Blended-glide `returnPctByMonth` over the full-run step domain (`stepCount = yearCount * 12`): drawdown
// starts at retirement, so every step maps to `retirementYear + floor(i/12)`, and steps before retirement
// would hold the account's base scalar rate.
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

// A $0 POST_TAX/BROKERAGE household-pool account that carries the glide return when allocation reaches no
// real account; never RMD-eligible.
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

// Sums the carved rollover-year RMD portions (dollars) per calendar year across linked-CBP post-retirement
// deposits.
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

// Resolves CBP elections: annuity-elected ids (income flows via the linked stream) and lump-sum-elected ids
// (balance routes to the target as a deposit), both excluded from the ledger.
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
  /**
   * Dollars that roll into the target's pre-tax bucket: the excess (whole minus RMD portion) at or after the
   * trigger year, otherwise the whole rolled balance.
   */
  readonly amount: number;
  readonly sourceCbpId: string;
  /**
   * Rollover-year RMD carved out of the lump-sum, in integer cents, distributed as taxable ordinary income
   * rather than rolled. 0 before the owner's RMD trigger year, with no owner birthdate, or when the source is
   * not RMD-qualifying.
   */
  readonly rmdPortionCents: number;
}

// Builds one account's ledger entry, or `null` without a usable projection or rate. Zero-balance CBP lump-sum
// targets and Fill-target Roths keep their slot, since deposits and conversions land in them later; MIXED
// accounts pass their actual pre/post buckets.
function buildLedgerEntry(args: {
  proj: import('./balance-projection-runner-types').AccountProjection;
  method: ProjectionMethod;
  startYear: number;
  horizonYear: number;
  targetedCbpDeposits: ReadonlyArray<PostRetirementCbpDeposit> | undefined;
  isFillTargetRoth: boolean;
  postPrimaryEvents: ReadonlyArray<ClassifiedDepositEvent> | undefined;
  plainPensionEvents: ReadonlyArray<ClassifiedDepositEvent> | undefined;
  /**
   * When set, each non-CBP account gets a blended-glide `returnPctByMonth`; CBP accounts keep their scalar
   * rate (glide-excluded, as in MC).
   */
  allocation: RetirementAllocationOverride | undefined;
  retirementYear: number;
  stepCount: number;
  /** The resolved per-account floor and HSA mode; undefined means no floor. */
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
  // Drop only an account with no positive balance, no incoming targeted CBP deposit, no post-primary
  // contribution and that is not the Fill target; otherwise a spouse account funded only by post-primary
  // contributions would vanish and diverge from MC.
  if (
    totalAtRet <= 0 &&
    !hasTargetedDeposit &&
    !hasPostPrimaryDeposit &&
    !hasPlainPensionDeposit &&
    !isFillTargetRoth
  )
    return null;
  // An account without an empirical TWR rate falls back to its planned rate everywhere in the Historical
  // view, including this ledger.
  const ratePct = proj.ratePctByMethod[method] ?? proj.ratePctByMethod.planned;
  if (ratePct === null) return null;
  const taxTreatment = proj.account.payload.taxTreatment;
  const { initialPre, initialPost } = splitInitialByTaxTreatment(
    totalAtRet,
    taxTreatment,
    { preTax: projOut.preTax, postTax: projOut.postTax },
  );
  const depositsByMonth = emptyMonthlySeries(startYear, horizonYear);
  if (targetedCbpDeposits) {
    // `ev.amount` is the rolled excess; the carved RMD portion is taxed via the income inlet, not rolled.
    for (const ev of targetedCbpDeposits) {
      if (ev.amount > 0) addOneOff(depositsByMonth, ev.year, ev.month0, ev.amount);
    }
  }
  // Plain-pension lump-sums route whole through `depositsByMonth` (bucketed by treatment downstream), like
  // linked-CBP; no RMD split.
  if (args.plainPensionEvents) {
    for (const ev of args.plainPensionEvents) {
      if (ev.amount <= 0) continue;
      const year = Math.floor(ev.month / 12);
      const month0 = ev.month - year * 12;
      addOneOff(depositsByMonth, year, month0, ev.amount);
    }
  }
  // The pre-tax slice joins `depositsByMonth`; the designated-Roth slice goes to a post-only series that
  // always lands in `post` (a MIXED account's Roth slice stays RMD-exempt, §325).
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
  // A CBP account keeps its scalar rate (glide-excluded); every other account under an allocation override
  // gets the blended-glide series.
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
    // Only set when a floor resolved; engine eligibility (POST_TAX, HSA) gates its effect.
    ...(args.floor !== undefined
      ? { floorDollars: args.floor.floorDollars, floorHsaMode: args.floor.hsaMode }
      : {}),
  };
}

// Resolves post-primary CBP lump-sum events to target accounts. The amount is the source's projected balance
// compounded forward from retirement to the event month at its `planningReturnPct`, since the CBP projection
// ends at retirement.
function collectPostRetirementCbpLumpSumDeposits(args: {
  ctx: import('./balance-projection-runner-types').PipelineContext;
  cbpElections: ReadonlyMap<string, import('./cbp-resolution').ResolvedCbpElection>;
}): ReadonlyMap<string, ReadonlyArray<PostRetirementCbpDeposit>> {
  const { ctx, cbpElections } = args;
  const cbpAccountById = new Map(
    ctx.accountProjections.map((p) => [p.account.id, p.account]),
  );
  // Owner-birthdate lookup for the rollover-year RMD split; any miss gives `rmdPortion = 0` and the whole
  // amount rolls.
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
    // Linked-CBP only: when the rollover lands in or after the owner's RMD trigger year, carve that year's
    // RMD out first (taxable) and roll the excess. The shared pure helper is the one split site, so MC agrees
    // to the cent.
    const ownerBirthdate = birthdateByMemberId.get(cbpAccount.payload.ownerId);
    const basisCents = Math.round(amount * 100);
    const split = splitRolloverByRmd({
      basisCents,
      ownerBirthdate,
      eventYear: year,
      sourceTaxTreatment: cbpAccount.payload.taxTreatment,
      // A MIXED source CBP carves its RMD only on the non-Roth-designated portion (SECURE 2.0 §325), using
      // the projected post-tax bucket share.
      ...(cbpAccount.payload.taxTreatment === 'MIXED'
        ? { rothPortionCents: cbpRothPortionCents(cbpProj, basisCents) }
        : {}),
      rmdSnapshot,
    });
    const entry: PostRetirementCbpDeposit = {
      year,
      month0,
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

// The Roth-designated portion of a MIXED source CBP's rolled basis, in integer cents, excluded from the RMD
// computation (SECURE 2.0 §325). It applies the projection's post-tax bucket share to the rolled basis, since
// that basis is the projected total compounded to the event month; 0 when the projection has no positive
// total.
function cbpRothPortionCents(
  cbpProj: import('./projection').ProjectionOutput,
  basisCents: number,
): number {
  if (cbpProj.total <= 0 || cbpProj.postTax <= 0) return 0;
  const rothFraction = Math.min(1, cbpProj.postTax / cbpProj.total);
  return Math.round(basisCents * rothFraction);
}

// Flattens the per-target CBP deposit map for subtraction from the household aggregate. That aggregate
// carries the full gross rolled balance, so the subtraction removes the excess plus the carved RMD portion;
// the RMD is re-injected via `rolledRmdIncomeByYear`, so leaving it in the spread would double-count.
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
 * Builds the resolved pipeline context the deterministic and MC entry points share; returns `null` without a
 * primary or a resolvable primary retirement date, which callers turn into `NoPrimaryRetirementError`.
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
  // `cbpValidation` is set on the context regardless of later short-circuits; `runBalanceProjectionMc` checks
  // it separately to keep its throw semantics.
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
  // Working-years Roth conversions (deterministic only): source pre-tax outflow legs feed `project()` as
  // `preRetirementWithdrawals`, target inflows merge into the targeted deposits, and converted principal
  // folds into the Roth basis seed so it withdraws tax-free in drawdown.
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
  // The household's Roth tax profile from the adapter replaces any balance-derived basis estimate, which
  // would treat every projected Roth dollar as recoverable basis: a Roth IRA's §408A basis comes from the
  // pool's recorded history, an employer plan's designated basis from its recorded in-plan-rollover
  // principal.
  const accountFactInputs = buildRothAccountFactInputs(args.accounts);
  // Roth IRAs count active and inactive alike: a closed account's recorded contribution history is real §408A
  // basis (Pub 590-B treats the owner's Roth IRAs as one whole). Designated-Roth employer facts stay
  // active-only: an inactive plan holds no balance, so its basis would inflate an active sibling's pooled
  // numerator. The five-year clock is contributed by active accounts only.
  const rothDistributionFacts = buildRothDistributionFacts(
    accountFactInputs,
    args.balances,
  );
  // Each member's spouse birthdate for the RMD engine's Table II age-gap test; empty for a single-member
  // household, keeping the conservative default.
  const spouseBirthdateByOwnerId = new Map<string, string>();
  if (secondary) {
    if (primary.payload.birthdate) {
      spouseBirthdateByOwnerId.set(secondary.id, primary.payload.birthdate);
    }
    if (secondary.payload.birthdate) {
      spouseBirthdateByOwnerId.set(primary.id, secondary.payload.birthdate);
    }
  }
  // Each member's own birthdate; on an inherited account the owner is the beneficiary, so this is the Table I
  // date.
  const ownBirthdateByMemberId = new Map<string, string>();
  for (const m of args.members) {
    if (m.payload.birthdate) ownBirthdateByMemberId.set(m.id, m.payload.birthdate);
  }
  const rmdProfileFactsByAccountId = buildRmdProfileFactsByAccount(
    accountFactInputs,
    spouseBirthdateByOwnerId,
    ownBirthdateByMemberId,
  );
  // Each owner's remaining Roth-IRA regular basis (integer cents) from the adapter, summed over the owner's
  // own §408A pools; an inherited Roth IRA contributes no pool. It seeds the deterministic §408A tracker
  // only: MC re-derives a drawable-only basis (`mcDrawableRothBasisCentsByOwner`). An owner with nothing left
  // is absent (counts as $0). Five-year clocks stay per pool.
  const rothBasisCentsByOwner = new Map<string, number>();
  for (const pool of rothDistributionFacts.rothIraByPool.values()) {
    const cents = pool.rothIra?.regularContributionBasisCents ?? 0;
    if (cents <= 0) continue;
    rothBasisCentsByOwner.set(
      pool.ownerId,
      (rothBasisCentsByOwner.get(pool.ownerId) ?? 0) + cents,
    );
  }
  // Kept apart from `rothBasisCentsByOwner`, which feeds the MC tax context: MC does not model the
  // working-years conversion deposit legs, so folding it in would shield MC Roth withdrawals from tax. The
  // deterministic path adds this map to its basis seed (`seedRothBasisCarrier`).
  const preRetirementConversionBasisCentsByOwner = new Map<string, number>(
    rothConversions.basisCentsByOwner,
  );
  // Per-owner pure designated-Roth basis from recorded in-plan-rollover principal, $0 when none. No runtime
  // consumer: the funding pass pools designated state from `rothDistributionFacts.designatedByAccount`.
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
  // Per-owner MIXED Roth-designated basis from recorded rollover principal; same status as
  // `pureRothBasisCentsByOwner`, and disjoint from it.
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
  // Kept apart from `mixedRothDesignatedBasisCentsByOwner` so engine-generated conversion principal, which MC
  // does not model, can never leak into a map an MC seed might read. The split records provenance only;
  // funding takes this principal through the dated per-account maps (`mergeDesignatedRothSeeds`).
  const mixedInPlanConversionBasisCentsByOwner = new Map<string, number>(
    rothConversions.mixedInPlanBasisCentsByOwner,
  );
  // The same principal keyed by target account, credited to that account's own designated-Roth carrier.
  const mixedInPlanConversionBasisCentsByAccount = new Map<string, number>(
    rothConversions.mixedInPlanBasisCentsByAccount,
  );
  // The same two principals dated by conversion or rollover tax year, so the seeds create real lots with
  // their own five-tax-year recapture clocks.
  const preRetirementConversionBasisCentsByOwnerYear = new Map<
    string,
    ReadonlyMap<number, number>
  >(rothConversions.basisCentsByOwnerYear);
  const mixedInPlanConversionBasisCentsByAccountYear = new Map<
    string,
    ReadonlyMap<number, number>
  >(rothConversions.mixedInPlanBasisCentsByAccountYear);
  const asOfMonth = args.todayYear * 12 + args.todayMonthIndex;
  // The per-key resolver owns the deterministic pipeline's inflation; the income and balance deflators use
  // the single general rate.
  const resolvedInflation = resolveInflationForScenario(args.scenarioId, [
    ...effectiveScenarios,
  ]);
  // Resolves and hardens per-member QCD directives against the live account and member sets; empty when
  // nothing resolves.
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
    // Opt-out member ids (default `[]`) as a `Set` for `buildMemberInputs`; always present.
    acaMarketplaceOptOutMemberIds: new Set(
      resolved.acaMarketplaceOptOutMemberIds ?? [],
    ),
    // Coverage months and FPL region are sparse-optional: absent keeps the whole-year derivation and the
    // contiguous-48 FPL.
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

// Merges the working-years Roth-conversion target inflows into the targeted-deposit map by account id;
// returns a fresh map with conversion deposits appended after existing ones.
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
  // Seed the overlay from the resolved (inherited-aware) SS override, not the target's local block: a local
  // `socialSecurity` block shadows the parent's whole section and would drop inherited fields (survivor claim
  // ages, COLA settings). MC and Apply already read the resolved block.
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
        // Overlay-supplied survivor claim ages win; otherwise the resolved stored survivor section is
        // preserved.
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
  // Death is Dec 31 of `deathYear`, the terminal year, so the horizon ends there for everyone; `Math.ceil` is
  // the identity on the integer `projectedDeathFractionalYear`.
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
 * The per-account RMD facts and per-owner separation years the shared `computeRmd` engine needs, as plain
 * `Record`s (so the MC shape survives `postMessage` and the cache key). One derivation for the deterministic
 * and MC contexts, with account ids in ascending order so equal fact sets hash to one `mcCacheKey`; `{}` for
 * a fact-free household.
 */
export function buildRmdEngineFactsFragment(ctx: PipelineContext): {
  rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>;
  retirementYearByOwner?: Readonly<Record<string, number>>;
} {
  if (ctx.rmdProfileFactsByAccountId.size === 0) return {};
  // Built via `Object.fromEntries`, not `obj[id] = ...`: ids are user-controlled, and assigning to
  // `"__proto__"` hits the prototype accessor, silently dropping the account's RMD facts from the MC input
  // while the deterministic `Map` keeps them (CWE-1321).
  const rmdFactsByAccountId = Object.fromEntries(
    [...ctx.rmdProfileFactsByAccountId.keys()]
      .sort()
      .map((accountId): [string, RmdAccountProfileFacts] => [
        accountId,
        ctx.rmdProfileFactsByAccountId.get(accountId)!,
      ]),
  );
  // Same per-member derivation as the health twin (`resolveRetirementYearByMember`), so the RMD later-of rule
  // and the Marketplace-month gate agree; fixed primary-then-secondary order, built via `Object.fromEntries`
  // so an imported `"__proto__"` member id cannot reach the prototype.
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
