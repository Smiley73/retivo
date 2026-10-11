/**
 * Working-years (still-employed) Roth-conversion pre-pass for the DETERMINISTIC
 * projection (Monte Carlo is untouched).
 *
 * For each resolved + hardened conversion entry
 * (`resolvePreRetirementRothConversions`), for each WORKING year in the entry's
 * window — bounded BEFORE the source owner's RMD trigger year (SECURE 2.0:
 * 73/75 by birth year — RMD dollars can't be converted) AND within the source
 * owner's working years (strictly before the owner's retirement) AND inside the
 * projection's accumulation horizon — this:
 *
 *   1. takes the scheduled amount as the flat nominal `annualAmountDollars`
 *      (the typed dollars converted as-is each year — no inflation growth),
 *   2. clamps it to the source pre-tax sub-bucket balance AT the pinned event
 *      month (read from the source account's own pre-projection — the clamp;
 *      for MIXED sources, only the pre tranche is withdrawn),
 *   3. emits the source pre-tax OUTFLOW (`preRetirementWithdrawals`) + the
 *      target Roth INFLOW (`preRetirementDeposits`) of the SAME `actualGross`
 *      (full, no haircut) at ONE pinned event month, and
 *   4a. for Roth IRA targets: accumulates the per-owner `actualGross` total
 *       (integer cents) into `basisCentsByOwner` so the caller folds it into
 *       the at-retirement Roth basis seed — converted principal is then
 *       tax-free in drawdown via `preRetirementConversionBasisCentsByOwner`.
 *   4b. for same-account MIXED in-plan targets: accumulates `actualGross` into
 *       `mixedInPlanBasisCentsByOwner`; the runner stores this at
 *       context-build time in `mixedInPlanConversionBasisCentsByOwner`
 *       (deterministic-only — `buildMcTaxContext` reads no owner-level designated
 *       roll-up) and folds it only into the deterministic funding pass's
 *       §408A seed, preserving the MC seed invariant.
 *
 * The event month is pinned to JANUARY (`month0 = 0`) of each working year so
 * the source clamp + target credit share one deterministic, growth-consistent
 * step.
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

/** Pinned event month for every working-years conversion step. */
const CONVERSION_EVENT_MONTH0 = 0; // January

export interface PreRetirementRothConversionResult {
  /** Source pre-tax OUTFLOW events keyed by source account id. */
  readonly preWithdrawalsByAccount: ReadonlyMap<string, PreWithdrawalList>;
  /** Target Roth INFLOW events keyed by target Roth-IRA account id. */
  readonly preDepositsByAccount: ReadonlyMap<string, PreDepositList>;
  /** Per-owner converted-principal total in INTEGER CENTS — folded into the
   *  at-retirement Roth IRA basis seed by the caller. Populated ONLY
   *  for Roth IRA targets (`shouldCreditWorkingYearsConversionBasisSeparately`);
   *  same-account MIXED in-plan targets do NOT credit this map. */
  readonly basisCentsByOwner: ReadonlyMap<string, number>;
  /** Per-owner same-account MIXED in-plan conversion total in INTEGER CENTS —
   *  stored at context-build in deterministic-only `mixedInPlanConversionBasisCentsByOwner`
   *  and folded into the deterministic §408A seed.
   *  Kept separate from the fact-mirroring `mixedRothDesignatedBasisCentsByOwner`
   *  Zero for plans with no same-account MIXED in-plan conversions. */
  readonly mixedInPlanBasisCentsByOwner: ReadonlyMap<string, number>;
  /** The SAME same-account MIXED in-plan conversion principal keyed by
   *  TARGET ACCOUNT id rather than owner. Designated-Roth accounts never pool
   *  (§402A / Treas. Reg. §1.402A-1), so the deterministic engine credits
   *  this basis to the specific account's designated-Roth carrier; an owner-level
   *  total could otherwise be recovered pro rata against a SIBLING plan that never
   *  received the conversion. Empty when no such conversion resolved. */
  readonly mixedInPlanBasisCentsByAccount: ReadonlyMap<string, number>;
  /**
   * The SAME working-years Roth-IRA conversion principal, but DATED: owner
   * id → conversion tax year → integer cents. An engine-generated conversion is
   * a conversion like any other, so it starts its OWN five-tax-year §408A(d)(3)(F)
   * recapture clock; crediting it as undated regular-contribution basis let a
   * pre-59½ withdrawal inside that window escape the 10% recapture entirely.
   * Consumed by `mergeFactBasedRothIraSeeds`, which turns each year into a real
   * conversion lot on the §408A carrier. Empty when no such conversion resolved.
   */
  readonly basisCentsByOwnerYear: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /**
   * The same-account MIXED in-plan conversion principal, DATED by target
   * account: account id → rollover tax year → integer cents. An in-plan Roth
   * rollover starts its own five-tax-year §402A(c)(4)(D) recapture clock, so it is
   * credited as a dated in-plan rollover LOT on that account's designated-Roth
   * carrier rather than as undated basis. Empty when none resolved.
   */
  readonly mixedInPlanBasisCentsByAccountYear: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** Per-calendar-year total working-years Roth conversion amount in INTEGER
   *  CENTS — summed across ALL conversions for that year regardless of
   *  source/target type. Drives the Roth conversions chart bars for the
   *  pre-retirement years (Fill-mode bars cover post-retirement years). Empty
   *  when no working-years conversion resolved or all clamped to zero. */
  readonly conversionCentsByYear: ReadonlyMap<number, number>;
  /** Assumed display-only tax rate (percent) carried through for reporting. */
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

/**
 * Compute the deterministic working-years Roth-conversion legs. Pure;
 * reads the source account pre-tax balances from fresh per-account
 * pre-projections (no conversions) so the clamp sees the un-converted source
 * trajectory. Returns empty maps when no conversion resolves.
 */
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
  // Resolve the SAME scenario-level overrides the main runner applies when
  // projecting each account (`projectActiveAccounts`) so the source pre-pass
  // trajectory — and thus the clamp / `actualGross` — matches the real
  // projection: per-account return rate, contribution amounts, and the
  // contribution-growth rate.
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
  // Cache one pre-projection per distinct source account (no conversions) so
  // the clamp reads the un-converted pre-tax trajectory.
  const sourceProjCache = new Map<string, ReturnType<typeof project>>();
  const preWithdrawals = new Map<string, PreWithdrawalList[number][]>();
  const preDeposits = new Map<string, PreDepositList[number][]>();
  const basisCentsByOwner = new Map<string, number>();
  const mixedInPlanBasisCentsByOwner = new Map<string, number>();
  const mixedInPlanBasisCentsByAccount = new Map<string, number>();
  // The same principals DATED by conversion/rollover tax year, so each one
  // carries its own five-tax-year recapture clock through the shared FIFO
  // machinery instead of becoming undated (never-recaptured) basis.
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
  // Cumulative same-source/same-year depletion tracker (in INTEGER CENTS).
  // Multiple conversion entries sharing the SAME source account AND the
  // SAME conversion year each read the same un-depleted source balance; without
  // this they would each emit a full deposit + basis fold, over-crediting the
  // Roth target (the kernel re-clamps the WITHDRAWAL list cumulatively, but the
  // deposit/basis legs are emitted here). Tracking in integer cents avoids
  // floating-point drift from multi-entry same-source/same-year dollar-domain
  // subtraction.
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
      // Apply the same per-account overrides the main runner uses.
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
      // Convert scheduled amount and available balance to integer cents
      // immediately so all depletion arithmetic is integer-domain (no FP drift).
      // Working-years conversions are always a flat nominal annual amount — the
      // typed dollars are converted as-is each year (no inflation growth).
      const scheduledCents = Math.round(conv.annualAmountDollars * 100);
      const availableCents = Math.round(sourcePreAtEvent(sourceProj.perStep, year) * 100);
      // Subtract cents already scheduled against this source+year so the
      // effective headroom depletes cumulatively (matching the kernel's
      // withdrawal re-clamp). Without this, two entries on one $100k source in
      // the same year each see the full $100k and over-credit the Roth target.
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
      // Emit dollar legs as cents / 100 (exact for whole-cent values).
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
        // Roth IRA targets — credit the working-years conversion basis map.
        basisCentsByOwner.set(ownerId, (basisCentsByOwner.get(ownerId) ?? 0) + actualGrossCents);
        // The same principal DATED, so it becomes a real conversion lot with
        // its own five-tax-year recapture window.
        addDated(basisCentsByOwnerYear, ownerId, year, actualGrossCents);
      } else if (isSameAccountMixedInPlanConversion(sourceRec, targetRec)) {
        // Same-account MIXED in-plan — credit the MIXED Roth-designated
        // basis accumulator. The context-build seed reads input snapshots; converted
        // dollars are never reflected there, so we must credit here to prevent
        // double-taxation in drawdown regardless of the starting post balance.
        mixedInPlanBasisCentsByOwner.set(
          ownerId,
          (mixedInPlanBasisCentsByOwner.get(ownerId) ?? 0) + actualGrossCents,
        );
        // The same principal keyed by the TARGET ACCOUNT, so the fact-based
        // designated-Roth carrier credits the exact account that received it.
        mixedInPlanBasisCentsByAccount.set(
          target.id,
          (mixedInPlanBasisCentsByAccount.get(target.id) ?? 0) + actualGrossCents,
        );
        // DATED, so it becomes a real in-plan rollover lot with its own
        // §402A(c)(4)(D) five-tax-year recapture window.
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

/** Resolve the conversion entry's working-year set (inclusive calendar years).
 *  Mirrors the MAGI-cap `[startYear, endYear)` half-open collapse, then
 *  intersects with the working-years bound (before the source owner's
 *  retirement year), the source owner's RMD-trigger-year bound, and the
 *  no-past bound (year ≥ todayYear). A broken anchor (missing birthdate) → []. */
function resolveWorkingYears(args: {
  conv: { start: unknown; end: unknown };
  source: Aggregate<AccountPayload>;
  resolveCtx: ConversionResolveCtx;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  retirementByMember: ReadonlyMap<string, string | null>;
  todayYear: number;
}): number[] {
  const { conv, source, resolveCtx, todayYear } = args;
  // The conversion anchors are the `age`/`year` subset of ScheduleStart/End.
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
  // Source owner's RMD trigger year (RMD dollars can't be converted) and
  // working-years cap (strictly before the owner's retirement).
  const ownerId = source.payload.ownerId;
  const ownerBirthYear = birthYearOf(ownerId, args.members);
  const rmdBoundExclusive =
    ownerBirthYear !== null ? ownerBirthYear + rmdTriggerAge(ownerBirthYear) : Infinity;
  const ownerRetIso = args.retirementByMember.get(ownerId) ?? null;
  const ownerRetYear = ownerRetIso ? Number(ownerRetIso.slice(0, 4)) : Infinity;
  // Working years are strictly before the owner's retirement year.
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

/** Source pre-tax balance entering the pinned event month of `year` — the
 *  balance at the end of the step JUST BEFORE the event (mirrors
 *  `makeCbpBalanceLookup`). Out-of-window reads return 0 (no headroom). */
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
  /** Scenario-resolved planning return for this source (override → raw),
   *  the same rate the main runner projects the account with. */
  ratePct: number;
  /** Scenario-resolved planned-contribution amounts for this source
   *  (override → raw); folded onto the account payload so the pre-pass
   *  accumulation trajectory matches `projectActiveAccounts`. Absent → raw. */
  contribOverride:
    | { plannedContributionPreTax: number; plannedContributionPostTax: number }
    | undefined;
  /** Scenario-resolved contribution-growth rate (percent). */
  contributionGrowthPct: number;
  cache: Map<string, ReturnType<typeof project>>;
}): ReturnType<typeof project> {
  const cached = args.cache.get(args.source.id);
  if (cached !== undefined) return cached;
  const ownerRet =
    args.retirementByMember.get(args.source.payload.ownerId) ?? null;
  // Apply the contribution-amount override the same way the main runner
  // builds `effectiveAccount` so the source trajectory matches.
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
