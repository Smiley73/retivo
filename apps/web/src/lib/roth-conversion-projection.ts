/**
 * Deterministic working-years Roth-conversion pre-pass (Monte Carlo is untouched): converts the flat scheduled amount each
 * working year, before the owner's RMD trigger year (SECURE 2.0: 73/75 by birth year) and retirement, clamped to the source pre-tax balance at a pinned January event month.
 */
import type {
  Aggregate,
  AccountBalancePayload,
  AccountPayload,
  HouseholdMemberPayload,
} from '../db/types';
import {
  resolvePreRetirementRothConversions,
  resolveAccountReturnsForScenario,
  resolveAccountContributionsForScenario,
  resolveContributionGrowth,
  type ScenarioAggregate,
} from './scenario-resolution';
import { project } from './projection';
import { rmdTriggerAge } from './rmd';
import { resolveStartMonth, resolveEndMonth } from './schedule-resolution';
import type {
  PreDepositList,
  PreWithdrawalList,
} from './balance-projection-runner-types';
import {
  shouldCreditWorkingYearsConversionBasisSeparately,
  isSameAccountMixedInPlanConversion,
} from './roth-conversion-eligibility';

const CONVERSION_EVENT_MONTH0 = 0; // January

export interface PreRetirementRothConversionResult {
  readonly preWithdrawalsByAccount: ReadonlyMap<string, PreWithdrawalList>;
  readonly preDepositsByAccount: ReadonlyMap<string, PreDepositList>;
  /** Per-owner converted-principal total in integer cents, folded by the caller into the at-retirement Roth IRA basis seed; Roth IRA targets only. */
  readonly basisCentsByOwner: ReadonlyMap<string, number>;
  /** Per-owner same-account MIXED in-plan conversion total (cents), kept deterministic-only and folded into the deterministic §408A seed, which preserves the Monte Carlo seed invariant. */
  readonly mixedInPlanBasisCentsByOwner: ReadonlyMap<string, number>;
  /** The same principal keyed by target account: designated-Roth accounts never pool (§402A / Treas. Reg. §1.402A-1), so an owner-level total could be recovered pro rata against a sibling plan that never received the conversion. */
  readonly mixedInPlanBasisCentsByAccount: ReadonlyMap<string, number>;
  /**
   * The Roth-IRA conversion principal dated: owner id → conversion tax year → cents. A conversion starts its own
   * five-tax-year §408A(d)(3)(F) recapture clock; undated basis would let a pre-59½ withdrawal in that window escape the
   * 10% recapture. Consumed by `mergeFactBasedRothIraSeeds` as conversion lots.
   */
  readonly basisCentsByOwnerYear: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** The in-plan conversion principal dated by target account: account id → year → cents. An in-plan rollover starts its own five-tax-year §402A(c)(4)(D) recapture clock, so it becomes a dated rollover lot. */
  readonly mixedInPlanBasisCentsByAccountYear: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** Total conversion cents per calendar year across all conversions; drives the pre-retirement bars of the conversions chart. */
  readonly conversionCentsByYear: ReadonlyMap<number, number>;
  readonly taxRatePct: number;
}

const EMPTY_RESULT: PreRetirementRothConversionResult = {
  preWithdrawalsByAccount: new Map(),
  preDepositsByAccount: new Map(),
  basisCentsByOwner: new Map(),
  mixedInPlanBasisCentsByOwner: new Map(),
  mixedInPlanBasisCentsByAccount: new Map(),
  basisCentsByOwnerYear: new Map(),
  mixedInPlanBasisCentsByAccountYear: new Map(),
  conversionCentsByYear: new Map(),
  taxRatePct: 0,
};

/** Computes the working-years conversion legs; pure. The source clamp reads fresh per-account pre-projections without conversions, so it sees the un-converted trajectory. */
export function computePreRetirementRothConversions(args: {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly retirementByMember: ReadonlyMap<string, string | null>;
  readonly primaryRetIso: string;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
  readonly stopContributionsToday: boolean;
}): PreRetirementRothConversionResult {
  const resolved = resolvePreRetirementRothConversions(
    args.scenarioId,
    [...args.scenarios],
    args.accounts.map((a) => ({ id: a.id, payload: a.payload })),
  );
  if (resolved.conversions.length === 0) {
    return { ...EMPTY_RESULT, taxRatePct: resolved.taxRatePct };
  }
  const resolveCtx = buildConversionResolveCtx(args);
  const accountById = new Map(args.accounts.map((a) => [a.id, a]));
  const balancesByAccount = groupBalances(args.balances);
  // The same scenario overrides the main runner applies in `projectActiveAccounts`, so the source trajectory and clamp match the real projection.
  const accountsForResolve = args.accounts.map((a) => ({ id: a.id, payload: a.payload }));
  const returnOverrides = resolveAccountReturnsForScenario(
    args.scenarioId,
    [...args.scenarios],
    accountsForResolve,
  );
  const contribOverrides = resolveAccountContributionsForScenario(
    args.scenarioId,
    [...args.scenarios],
    accountsForResolve,
  );
  const growthByAccount = resolveContributionGrowth(
    args.scenarioId,
    [...args.scenarios],
    accountsForResolve,
  );
  const sourceProjCache = new Map<string, ReturnType<typeof project>>();
  const preWithdrawals = new Map<string, PreWithdrawalList[number][]>();
  const preDeposits = new Map<string, PreDepositList[number][]>();
  const basisCentsByOwner = new Map<string, number>();
  const mixedInPlanBasisCentsByOwner = new Map<string, number>();
  const mixedInPlanBasisCentsByAccount = new Map<string, number>();
  // The same principals dated by tax year, so each carries its own recapture clock.
  const basisCentsByOwnerYear = new Map<string, Map<number, number>>();
  const mixedInPlanBasisCentsByAccountYear = new Map<string, Map<number, number>>();
  const addDated = (
    map: Map<string, Map<number, number>>,
    key: string,
    year: number,
    cents: number,
  ): void => {
    const byYear = map.get(key) ?? new Map<number, number>();
    byYear.set(year, (byYear.get(year) ?? 0) + cents);
    map.set(key, byYear);
  };
  const conversionCentsByYear = new Map<number, number>();
  // Cents already scheduled per source and year: entries sharing both would otherwise each read the full balance and
  // over-credit the Roth target (the kernel re-clamps the withdrawals, but deposits and basis are emitted here).
  const scheduledBySourceYear = new Map<string, Map<number, number>>();

  for (const conv of resolved.conversions) {
    const source = accountById.get(conv.sourceAccountId);
    const target = accountById.get(conv.targetRothAccountId);
    if (!source || !target) continue;
    const sourceProj = projectSource({
      source,
      balances: balancesByAccount.get(source.id) ?? [],
      retirementByMember: args.retirementByMember,
      primaryRetIso: args.primaryRetIso,
      todayYear: args.todayYear,
      todayMonthIndex: args.todayMonthIndex,
      stopContributionsToday: args.stopContributionsToday,
      ratePct: returnOverrides.get(source.id) ?? source.payload.planningReturnPct,
      contribOverride: contribOverrides.get(source.id),
      contributionGrowthPct: growthByAccount.get(source.id)?.ratePct ?? 0,
      cache: sourceProjCache,
    });
    if (!sourceProj?.perStep) continue;
    const years = resolveWorkingYears({
      conv,
      source,
      resolveCtx,
      members: args.members,
      retirementByMember: args.retirementByMember,
      todayYear: args.todayYear,
    });
    for (const year of years) {
      // Integer cents throughout avoids floating-point drift in the depletion arithmetic.
      const scheduledCents = Math.round(conv.annualAmountDollars * 100);
      const availableCents = Math.round(sourcePreAtEvent(sourceProj.perStep, year) * 100);
      let yearMap = scheduledBySourceYear.get(source.id);
      if (!yearMap) {
        yearMap = new Map<number, number>();
        scheduledBySourceYear.set(source.id, yearMap);
      }
      const alreadyScheduledCents = yearMap.get(year) ?? 0;
      const effectiveAvailableCents = Math.max(0, availableCents - alreadyScheduledCents);
      const actualGrossCents = Math.min(scheduledCents, effectiveAvailableCents);
      if (!(actualGrossCents > 0)) continue;
      yearMap.set(year, alreadyScheduledCents + actualGrossCents);
      conversionCentsByYear.set(year, (conversionCentsByYear.get(year) ?? 0) + actualGrossCents);
      const actualGross = actualGrossCents / 100;
      pushEntry(preWithdrawals, source.id, {
        year,
        month0: CONVERSION_EVENT_MONTH0,
        preTax: actualGross,
      });
      pushEntry(preDeposits, target.id, {
        year,
        month0: CONVERSION_EVENT_MONTH0,
        preTax: 0,
        postTax: actualGross,
      });
      const ownerId = target.payload.ownerId;
      const sourceRec = { id: source.id, payload: source.payload };
      const targetRec = { id: target.id, payload: target.payload };
      if (shouldCreditWorkingYearsConversionBasisSeparately(targetRec)) {
        basisCentsByOwner.set(ownerId, (basisCentsByOwner.get(ownerId) ?? 0) + actualGrossCents);
        addDated(basisCentsByOwnerYear, ownerId, year, actualGrossCents);
      } else if (isSameAccountMixedInPlanConversion(sourceRec, targetRec)) {
        // The context-build seed reads input snapshots and never sees converted dollars, so credit here to avoid double taxation in drawdown.
        mixedInPlanBasisCentsByOwner.set(
          ownerId,
          (mixedInPlanBasisCentsByOwner.get(ownerId) ?? 0) + actualGrossCents,
        );
        mixedInPlanBasisCentsByAccount.set(
          target.id,
          (mixedInPlanBasisCentsByAccount.get(target.id) ?? 0) + actualGrossCents,
        );
        addDated(mixedInPlanBasisCentsByAccountYear, target.id, year, actualGrossCents);
      }
    }
  }

  return {
    preWithdrawalsByAccount: preWithdrawals,
    preDepositsByAccount: preDeposits,
    basisCentsByOwner,
    mixedInPlanBasisCentsByOwner,
    mixedInPlanBasisCentsByAccount,
    basisCentsByOwnerYear,
    mixedInPlanBasisCentsByAccountYear,
    conversionCentsByYear,
    taxRatePct: resolved.taxRatePct,
  };
}

interface ConversionResolveCtx {
  retirementYear: number;
  retirementMonth0: number;
  primary?: { birthdate: string };
  secondary?: { birthdate: string };
}

function buildConversionResolveCtx(args: {
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  primaryRetIso: string;
}): ConversionResolveCtx {
  const primary = args.members.find((m) => m.payload.isPrimary);
  const secondary = args.members.find((m) => !m.payload.isPrimary);
  return {
    retirementYear: Number(args.primaryRetIso.slice(0, 4)),
    retirementMonth0: Number(args.primaryRetIso.slice(5, 7)) - 1,
    primary: primary?.payload.birthdate
      ? { birthdate: primary.payload.birthdate }
      : undefined,
    secondary: secondary?.payload.birthdate
      ? { birthdate: secondary.payload.birthdate }
      : undefined,
  };
}

// Working years are the entry's [start, end) window from today on, before the owner's retirement and RMD trigger year
// (RMD dollars can't be converted); an anchor that cannot resolve (missing birthdate) gives none.
function resolveWorkingYears(args: {
  conv: { start: unknown; end: unknown };
  source: Aggregate<AccountPayload>;
  resolveCtx: ConversionResolveCtx;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  retirementByMember: ReadonlyMap<string, string | null>;
  todayYear: number;
}): number[] {
  const { conv, source, resolveCtx, todayYear } = args;
  const startMonth = resolveStartMonth(
    conv.start as Parameters<typeof resolveStartMonth>[0],
    resolveCtx,
  );
  if (!startMonth) return [];
  const endMonth = resolveEndMonth(
    conv.end as Parameters<typeof resolveEndMonth>[0],
    startMonth,
    resolveCtx,
  );
  if (!endMonth) return [];
  const windowStartYear = startMonth.year;
  const windowEndYearExclusive = endMonth.year; // active iff start ≤ Y < end
  const ownerId = source.payload.ownerId;
  const ownerBirthYear = birthYearOf(ownerId, args.members);
  const rmdBoundExclusive =
    ownerBirthYear !== null ? ownerBirthYear + rmdTriggerAge(ownerBirthYear) : Infinity;
  const ownerRetIso = args.retirementByMember.get(ownerId) ?? null;
  const ownerRetYear = ownerRetIso ? Number(ownerRetIso.slice(0, 4)) : Infinity;
  const upperExclusive = Math.min(
    windowEndYearExclusive,
    rmdBoundExclusive,
    ownerRetYear,
  );
  const lowerInclusive = Math.max(windowStartYear, todayYear);
  const out: number[] = [];
  for (let y = lowerInclusive; y < upperExclusive; y += 1) out.push(y);
  return out;
}

function birthYearOf(
  ownerId: string,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): number | null {
  const m = members.find((mem) => mem.id === ownerId);
  const iso = m?.payload.birthdate;
  if (!iso) return null;
  const y = Number(iso.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
}

// Source pre-tax balance at the end of the step just before the pinned event month; out-of-window reads are 0.
function sourcePreAtEvent(
  perStep: NonNullable<ReturnType<typeof project>>['perStep'],
  year: number,
): number {
  if (!perStep) return 0;
  const stepIdx = (year - perStep.firstYear) * 12 + CONVERSION_EVENT_MONTH0;
  if (stepIdx < 0 || stepIdx >= perStep.preEnd.length) return 0;
  const readIdx = stepIdx === 0 ? 0 : stepIdx - 1;
  return perStep.preEnd[readIdx];
}

function projectSource(args: {
  source: Aggregate<AccountPayload>;
  balances: Aggregate<AccountBalancePayload>[];
  retirementByMember: ReadonlyMap<string, string | null>;
  primaryRetIso: string;
  todayYear: number;
  todayMonthIndex: number;
  stopContributionsToday: boolean;
  ratePct: number;
  contribOverride:
    | { plannedContributionPreTax: number; plannedContributionPostTax: number }
    | undefined;
  contributionGrowthPct: number;
  cache: Map<string, ReturnType<typeof project>>;
}): ReturnType<typeof project> {
  const cached = args.cache.get(args.source.id);
  if (cached !== undefined) return cached;
  const ownerRet =
    args.retirementByMember.get(args.source.payload.ownerId) ?? null;
  const effectiveAccount: Aggregate<AccountPayload> = args.contribOverride
    ? {
        ...args.source,
        payload: {
          ...args.source.payload,
          plannedContributionPreTax: args.contribOverride.plannedContributionPreTax,
          plannedContributionPostTax: args.contribOverride.plannedContributionPostTax,
        },
      }
    : args.source;
  const proj =
    args.balances.length === 0
      ? null
      : project({
          account: effectiveAccount,
          balances: args.balances,
          ratePct: args.ratePct,
          retirementDate: args.primaryRetIso,
          accumulationEndDate: ownerRet ?? args.primaryRetIso,
          stopContributionsToday: args.stopContributionsToday,
          todayYear: args.todayYear,
          todayMonthIndex: args.todayMonthIndex,
          contributionGrowthPct: args.contributionGrowthPct,
        });
  args.cache.set(args.source.id, proj);
  return proj;
}

function groupBalances(
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
): Map<string, Aggregate<AccountBalancePayload>[]> {
  const out = new Map<string, Aggregate<AccountBalancePayload>[]>();
  for (const b of balances) {
    const list = out.get(b.payload.accountId);
    if (list) list.push(b);
    else out.set(b.payload.accountId, [b]);
  }
  return out;
}

function pushEntry<T>(map: Map<string, T[]>, key: string, entry: T): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}
