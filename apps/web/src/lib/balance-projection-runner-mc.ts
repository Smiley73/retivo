/**
 * Monte Carlo bundle assembly for the balance-projection runner: `assembleMcBundle` builds the
 * `BalanceProjectionMcBundle` and `mcInputFromBundle` flattens it into the worker's `MonteCarloInput`. It
 * assembles input only; `runMonteCarlo` runs in `monte-carlo.worker.ts`.
 */
import {
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
} from '../db/types';
import {
  buildIncomeContext,
  projectIncomeByYear,
} from './income-projection';
import { buildMemberRetirementMap } from './balance-projection-runner-projection';
import { resolveIncomeForScenario } from './income-resolution';
import {
  type BalanceProjectionMcBundle,
  type ClassifiedDepositEvent,
} from './balance-projection-bundle';
import type {
  MonteCarloInput,
  McTaxContext,
  McRmdContext,
  McQcdContext,
  MonteCarloAccountLedger,
} from './monte-carlo';
import { qcdFirstEligibleTaxYear } from './qcd';
import { storedAcaBenchmarkOverrides } from './tax-integration-helpers';
import {
  buildCustomTierIndices,
  MissingCustomDrawdownOrderError,
} from './drawdown-engine-per-account-magi-cap';
import { isMagiCapDisabled, type MagiCapOverride } from '../db/types';
import { resolveMagiCapWindowBounds } from './balance-projection-runner-drawdown';
import type {
  AccountProjection,
  CandidateOverlay,
  PipelineContext,
  RunBalanceProjectionArgs,
  SsRunRateRow,
} from './balance-projection-runner-types';
import { CbpUnconfiguredError, NoPrimaryRetirementError } from './balance-projection-runner-types';
import {
  buildPipelineContext,
  buildRmdEngineFactsFragment,
} from './balance-projection-runner-context';
import {
  resolveHouseholdDeathYears,
  resolveRetirementYearByMember,
} from './balance-projection-runner-tax-helpers';
import { buildCashflowSeries } from './balance-projection-runner-cashflow';
import { deriveFilingStatus } from './filing-status';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import { carriesTenPercentPenalty } from './early-withdrawal-penalty';
import { isPureRothEmployerType, isRothDesignatedRetirementType } from './balance-calc';
import {
  canonicalMcRothBasisByOwner,
  type McRothOrderedProfile,
} from './monte-carlo-tax';
import {
  assembleMcBundle,
  computeSsByYearForClaimAges,
} from './monte-carlo-input-bundle';

/**
 * Deterministic seed for the MC sweep, so two runs on the same inputs rank pairs identically;
 * `optimizer-mc-runner.ts` overrides the bundle seed with this value.
 */
export const OPTIMIZER_MC_SEED = 1;
const OPTIMIZER_MC_DEFAULT_PATHS = 1000;

/**
 * Deterministic seed for the live Guardrails "Check now" run, distinct from `OPTIMIZER_MC_SEED` so repeated
 * clicks give the same probability of success without aliasing the optimizer.
 */
export const GUARDRAILS_LIVE_MC_SEED = 2;

// The income subset that tracks CPI (`tracksInflation`), which the MC engine scales per path by the realized
// CPI ratio.
function computeTracksInflationIncomeByYear(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  horizonYears: number,
): number[] {
  const todayYear = runArgs.todayYear;
  const allResolved = resolveIncomeForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    [...runArgs.incomeStreams],
  );
  const tracksInflationStreams = allResolved.filter(
    (s) => s.payload.tracksInflation === true,
  );
  if (tracksInflationStreams.length === 0) return new Array(horizonYears).fill(0);
  const inflationPct =
    ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  const lifeExp = ctx.resolvedScenario.lifeExpectancy;
  const retirementDateByMember = buildMemberRetirementMap(ctx.retirementByMember);
  const incomeCtx = buildIncomeContext([...runArgs.members], {
    retirementStartYear: ctx.primaryRetirementYear,
    lifeExpectancyPrimary: lifeExp?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
    lifeExpectancySecondary: lifeExp?.secondary,
    retirementDateByMember,
    todayYear,
    todayMonthIndex: runArgs.todayMonthIndex,
    inflationPct,
  });
  const yearRange = { from: todayYear, to: todayYear + horizonYears - 1 };
  const byYear = projectIncomeByYear(tracksInflationStreams, incomeCtx, yearRange);
  return byYear.map((row) => row.spendable.total);
}

/**
 * Assembles the strategy and income options the MC engine needs from the resolved scenario and pipeline
 * context; shared by both `mcInputFromBundle` call sites.
 */
export function buildMcStrategyOptsFromContext(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  bundle: BalanceProjectionMcBundle,
): McStrategyOpts {
  const horizonYears = ctx.horizonYear - runArgs.todayYear + 1;
  const tracksInflationIncomeByYear = computeTracksInflationIncomeByYear(
    runArgs,
    ctx,
    horizonYears,
  );
  const strategy = ctx.resolvedScenario.withdrawalStrategy ?? { kind: 'taxEfficient' as const };
  const strategyBits = buildMcStrategyOpts(
    strategy,
    ctx.resolvedScenario.customDrawdownOrder,
    bundle.accountMcLedger,
  );
  // Same MAGI-cap build as `runDrawdownForMethod`; the disable sentinel coerces to no cap.
  const rawMagiCap = ctx.resolvedScenario.magiCap;
  const magiCap = isMagiCapDisabled(rawMagiCap) ? undefined : rawMagiCap;
  // Thread the serializable windows and index-aligned resolved bounds, never the closure-bearing
  // `MagiCapRuntimeConfig`, which throws `DataCloneError` on `postMessage`; the engine rebuilds each window's
  // config.
  const magiCapWindowBounds =
    magiCap !== undefined ? resolveMagiCapWindowBounds(magiCap, ctx) : undefined;
  return {
    ...strategyBits,
    tracksInflationIncomeByYear,
    ...(magiCap !== undefined && magiCapWindowBounds !== undefined
      ? { magiCapOverride: magiCap, magiCapWindowBounds }
      : {}),
  };
}

// Adds the rolled-CBP RMD income to a copy of `incomeByYear` (indexed from `todayYear`).
function foldRolledRmdIntoIncomeByYear(
  incomeByYear: number[],
  rolledRmdIncomeByYear: ReadonlyMap<number, number>,
  todayYear: number,
): number[] {
  if (rolledRmdIncomeByYear.size === 0) return incomeByYear;
  const out = [...incomeByYear];
  rolledRmdIncomeByYear.forEach((dollars, year) => {
    const idx = year - todayYear;
    if (idx >= 0 && idx < out.length) out[idx] += dollars;
  });
  return out;
}

// Subtracts ledger-matched plain-pension placements from the household-spread one-off events: the bundle
// factory already deposits them per account, so the spread must not apply them again. Mirrors
// `subtractCbpLumpSumsFromHouseholdDeposits`; clamped at 0 per event.
function subtractMatchedPlainPension(
  householdEvents: ReadonlyArray<ClassifiedDepositEvent>,
  plainPensionEvents: ReadonlyArray<ClassifiedDepositEvent>,
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
): ClassifiedDepositEvent[] {
  const ledgerIds = new Set<string>();
  for (const entry of ledger) ledgerIds.add(entry.id);
  const matchedByMonth = new Map<number, number>();
  for (const ev of plainPensionEvents) {
    if (!ev.accountId || !ledgerIds.has(ev.accountId)) continue;
    matchedByMonth.set(ev.month, (matchedByMonth.get(ev.month) ?? 0) + ev.amount);
  }
  if (matchedByMonth.size === 0) return [...householdEvents];
  return householdEvents.map((ev) => {
    const owed = matchedByMonth.get(ev.month);
    if (owed === undefined || owed <= 0) return ev;
    const reduce = Math.min(ev.amount, owed);
    matchedByMonth.set(ev.month, owed - reduce);
    return { ...ev, amount: ev.amount - reduce };
  });
}

// Pre-resolves the per-leg penalty waiver for the MC synthetic pool, whose `mc-pretax` / `mc-roth` ids never
// match real account ids. A leg is waived only when every contributing account is scenario-exempt or
// statutorily penalty-free at the source (governmental 457(b), §72(t)); a partly-exempt pool is handled by
// the classifier's per-source split.
function resolveMcPenaltyExemptions(ctx: PipelineContext): {
  preTaxAllExempt: boolean;
  rothAllExempt: boolean;
} {
  const exempt = new Set(ctx.resolvedScenario.earlyWithdrawalPenaltyExemptAccountIds ?? []);
  let preTaxCount = 0;
  let preTaxExemptCount = 0;
  let rothCount = 0;
  let rothExemptCount = 0;
  for (const p of ctx.accountProjections) {
    const id = p.account.id;
    const { type, taxTreatment } = p.account.payload;
    // Statutorily penalty-free types (457(b)) count as exempt rather than uncounted.
    if (taxTreatment === 'PRE_TAX' || taxTreatment === 'MIXED') {
      preTaxCount += 1;
      if (exempt.has(id) || !carriesTenPercentPenalty(type)) preTaxExemptCount += 1;
    }
    // Counts every §408A-ordered Roth source; governmental 457(b) variants are source-exempt, so an
    // all-457(b) bucket waives the pooled leg.
    const feedsRothOrderedBucket =
      type === 'RETIREMENT_ROTH_IRA' ||
      isPureRothEmployerType(type) ||
      (taxTreatment === 'MIXED' && isRothDesignatedRetirementType(type));
    if (feedsRothOrderedBucket) {
      const statutorilyExempt =
        type === 'RETIREMENT_ROTH_457B' || type === 'RETIREMENT_457B';
      rothCount += 1;
      if (exempt.has(id) || statutorilyExempt) rothExemptCount += 1;
    }
  }
  return {
    preTaxAllExempt: preTaxCount > 0 && preTaxExemptCount === preTaxCount,
    rothAllExempt: rothCount > 0 && rothExemptCount === rothCount,
  };
}

/**
 * Canonicalizes the ACA opt-out member ids for the MC input: sorted and deduped so equal sets share one
 * `mcCacheKey`, and omitted when empty. Returns a spreadable fragment; never a `Set`, which `JSON.stringify`
 * would erase from the cache key.
 */
export function canonicalOptOutSet(
  ids: readonly string[] | undefined,
): { acaMarketplaceOptOutMemberIds?: readonly string[] } {
  if (!ids || ids.length === 0) return {};
  const canonical = [...new Set(ids)].sort();
  if (canonical.length === 0) return {};
  return { acaMarketplaceOptOutMemberIds: canonical };
}

/**
 * Each year's primary share of the household's gross Social Security, canonicalized for the cache key. §86
 * runs on each member's own benefit for a `separate` couple, so a blanket 50/50 split would change taxable
 * SS. Omitted for a one-member household or none with SS.
 */
export function canonicalSsSharesByYear(
  ssRows: ReadonlyArray<SsRunRateRow> | undefined,
  hasSecondary: boolean,
): { ssSharesByYear?: ReadonlyArray<{ year: number; primaryShare: number }> } {
  if (!hasSecondary || !ssRows || ssRows.length === 0) return {};
  const totals = new Map<number, { primary: number; total: number }>();
  for (const row of ssRows) {
    const entry = totals.get(row.year) ?? { primary: 0, total: 0 };
    entry.primary += row.primary;
    entry.total += row.total;
    totals.set(row.year, entry);
  }
  const shares = [...totals.entries()]
    .filter(([, v]) => v.total > 0)
    .map(([year, v]) => ({ year, primaryShare: v.primary / v.total }))
    .sort((a, b) => a.year - b.year);
  return shares.length === 0 ? {} : { ssSharesByYear: shares };
}

// The Roth-designated (post) slice of a MIXED account's balance in cents: the pre-tax sub-account never
// enters the MC Roth-ordered pool, so counting the whole balance would skew the §408A-versus-§402A split.
// With no usable split the whole balance is kept, the conservative direction.
function mixedDesignatedPocketCents(
  projection: AccountProjection,
  method: PipelineContext['method'],
  balanceCents: number,
): number {
  const out = projection.outputs[method] ?? projection.outputs.planned;
  if (out === null) return balanceCents;
  const post = Math.max(0, out.postTax);
  const total = Math.max(0, out.preTax) + post;
  if (total <= 0) return balanceCents;
  return Math.round(balanceCents * Math.min(1, post / total));
}

// Builds the MC pool's fact-based Roth state (`McRothOrderedProfile`), one-sided conservative: the
// IRA/designated split uses initial ledger Roth balances (a MIXED plan's designated pocket only, never an
// inherited Roth IRA); the Roth-IRA clock is the latest across pools (absent if any lacks one) and
// `rothOwnerIds` requires every owner to be 59½, since §408A is per account set; the designated clock is
// order-independent; lots aggregate by tax year (§408A(d)(4)(B)). `undefined` for a fact-free household.
function buildMcRothOrderedProfile(
  ctx: PipelineContext,
): McRothOrderedProfile | undefined {
  const facts = ctx.rothDistributionFacts;
  const designated = [...facts.designatedByAccount.values()];
  const iraPools = [...facts.rothIraByPool.values()];
  if (designated.length === 0 && iraPools.length === 0) return undefined;

  // Pool shares come from each account's latest balance; a MIXED plan counts its Roth-designated pocket only,
  // and an inherited Roth IRA counts nothing since its draws are tax-free and never enter the pool. No Roth
  // balance leaves the share at 1 (all-IRA).
  let iraBalanceCents = 0;
  let designatedBalanceCents = 0;
  for (const p of ctx.accountProjections) {
    const { type, taxTreatment } = p.account.payload;
    if (!p.account.payload.active) continue;
    const latestCents = Math.round(Math.max(0, p.latestBalance) * 100);
    if (type === 'RETIREMENT_ROTH_IRA') {
      if (p.account.payload.rmdInheritedAccount !== true) iraBalanceCents += latestCents;
    } else if (isPureRothEmployerType(type)) {
      designatedBalanceCents += latestCents;
    } else if (taxTreatment === 'MIXED' && isRothDesignatedRetirementType(type)) {
      designatedBalanceCents += mixedDesignatedPocketCents(p, ctx.method, latestCents);
    }
  }
  const poolCents = iraBalanceCents + designatedBalanceCents;

  // Roth IRA clock: the latest across §408A pools, absent when any pool has none; an inherited Roth IRA has
  // no pool, so it drops out of the clock, lots and `rothOwnerIds`.
  let iraFirstContributionTaxYear: number | undefined;
  let anyIraClockMissing = false;
  const iraLotsByYear = new Map<number, { taxableCents: number; nontaxableCents: number }>();
  const rothOwnerIds = new Set<string>();
  for (const pool of facts.rothIraByPool.values()) {
    const ira = pool.rothIra;
    if (!ira) continue;
    // The real member id, not the pool key, which carries an account-id suffix for an inherited pool.
    rothOwnerIds.add(pool.ownerId);
    if (ira.firstContributionTaxYear === undefined) {
      anyIraClockMissing = true;
    } else {
      iraFirstContributionTaxYear =
        iraFirstContributionTaxYear === undefined
          ? ira.firstContributionTaxYear
          : Math.max(iraFirstContributionTaxYear, ira.firstContributionTaxYear);
    }
    // An all-inactive pool's lots are unreachable by any deterministic draw, so crediting them would shelter
    // other owners' dollars and under-report tax versus the deterministic engine; its owner stays in the 59½
    // set and its missing clock still blanks the pooled clock.
    if (pool.allAccountsInactive === true) continue;
    for (const lot of ira.conversionLots) {
      const entry = iraLotsByYear.get(lot.taxYear) ?? { taxableCents: 0, nontaxableCents: 0 };
      iraLotsByYear.set(lot.taxYear, {
        taxableCents: entry.taxableCents + lot.taxableConvertedPrincipalCents,
        nontaxableCents: entry.nontaxableCents + lot.nontaxableConvertedPrincipalCents,
      });
    }
  }
  if (anyIraClockMissing) iraFirstContributionTaxYear = undefined;
  const iraConversionLots = [...iraLotsByYear.entries()]
    .map(([taxYear, v]) => ({ taxYear, ...v }))
    .sort((a, b) => a.taxYear - b.taxYear);

  // Designated Roth: latest clock, absent when any account has none, plus pooled in-plan-rollover lots
  // (§402A(c)(4)(D)).
  let designatedBasisCents = 0;
  let designatedFirstParticipationTaxYear: number | undefined;
  let anyDesignatedClockMissing = false;
  let designatedAllGovernmental457b = designated.length > 0;
  const rolloverLotsByYear = new Map<number, { taxableCents: number; nontaxableCents: number }>();
  for (const d of designated) {
    designatedBasisCents += d.basisCents;
    rothOwnerIds.add(d.ownerId);
    if (d.firstParticipationTaxYear === undefined) {
      anyDesignatedClockMissing = true;
    } else {
      designatedFirstParticipationTaxYear =
        designatedFirstParticipationTaxYear === undefined
          ? d.firstParticipationTaxYear
          : Math.max(designatedFirstParticipationTaxYear, d.firstParticipationTaxYear);
    }
    if (d.isGovernmental457b !== true) designatedAllGovernmental457b = false;
    for (const lot of d.inPlanRolloverLots ?? []) {
      const entry = rolloverLotsByYear.get(lot.taxYear) ?? {
        taxableCents: 0,
        nontaxableCents: 0,
      };
      rolloverLotsByYear.set(lot.taxYear, {
        taxableCents: entry.taxableCents + lot.taxableRolloverPrincipalCents,
        nontaxableCents: entry.nontaxableCents + lot.nontaxableRolloverPrincipalCents,
      });
    }
  }
  // Order-independent: an absent clock anywhere means the pooled clock is unmet.
  if (anyDesignatedClockMissing) designatedFirstParticipationTaxYear = undefined;
  const designatedInPlanRolloverLots = [...rolloverLotsByYear.entries()]
    .map(([taxYear, v]) => ({ taxYear, ...v }))
    .sort((a, b) => a.taxYear - b.taxYear);

  return {
    iraShareOfOrderedPool: poolCents > 0 ? iraBalanceCents / poolCents : 1,
    ...(iraFirstContributionTaxYear !== undefined ? { iraFirstContributionTaxYear } : {}),
    iraConversionLots,
    designatedBasisCents,
    designatedBalanceCents,
    ...(designatedFirstParticipationTaxYear !== undefined
      ? { designatedFirstParticipationTaxYear }
      : {}),
    designatedAllGovernmental457b,
    designatedInPlanRolloverLots,
    // Sorted so equal households serialize to one cache key.
    rothOwnerIds: [...rothOwnerIds].sort(),
  };
}

// Per-owner Roth-IRA regular basis an MC path may shelter with: `ctx.rothBasisCentsByOwner` minus every
// all-inactive pool's share, because no engine draws from a closed pool's basis and seeding it would
// under-report tax relative to the deterministic engine.
function mcDrawableRothBasisCentsByOwner(ctx: PipelineContext): Map<string, number> {
  const out = new Map<string, number>();
  for (const pool of ctx.rothDistributionFacts.rothIraByPool.values()) {
    if (pool.allAccountsInactive === true) continue;
    const cents = pool.rothIra?.regularContributionBasisCents ?? 0;
    if (cents <= 0) continue;
    out.set(pool.ownerId, (out.get(pool.ownerId) ?? 0) + cents);
  }
  return out;
}

/**
 * Builds the `McTaxContext` threaded into `MonteCarloInput`: a snapshot of household info for approximating
 * per-year tax in MC. Uses the default calibration bundle when `ctx.taxBundle` is absent.
 */
export function buildMcTaxContext(
  ctx: PipelineContext,
  /**
   * Per-month SS run-rate rows, the source of the per-year per-member SS attribution; absent keeps the even
   * split.
   */
  ssRows?: ReadonlyArray<SsRunRateRow>,
): McTaxContext | undefined {
  const filingStatus = deriveFilingStatus({
    primaryAlive: true,
    secondaryAlive: ctx.secondary !== undefined,
    filingStatusOverride: ctx.resolvedScenario.filingStatus ?? undefined,
  });

  const members = [
    {
      memberId: ctx.primary.id,
      isoBirthdate: ctx.primary.payload.birthdate ?? `${ctx.projCtx.asOfYear - 55}-01-01`,
      // Retirement year is a proxy; the MC engine checks age 65 each year.
      onMedicare: false, // recomputed per-year inside applyTaxYear
      hasAcaCoverage: false, // recomputed per-year inside applyTaxYear
    },
    ...(ctx.secondary
      ? [
          {
            memberId: ctx.secondary.id,
            isoBirthdate:
              ctx.secondary.payload.birthdate ?? `${ctx.projCtx.asOfYear - 55}-01-01`,
            onMedicare: false,
            hasAcaCoverage: false,
          },
        ]
      : []),
  ];

  const resolved = ctx.resolvedScenario;
  const assumedCostBasisFraction =
    resolved.assumedCostBasisFractionOfTaxableWithdrawal ?? undefined;
  const penaltyExemptions = resolveMcPenaltyExemptions(ctx);

  // One shared derivation with the deterministic twin (`resolveHouseholdDeathYears`), so a malformed imported
  // birthdate cannot make a member dead on one engine and alive on the other.
  const { primaryDeathYear, secondaryDeathYear } = resolveHouseholdDeathYears(ctx);

  return {
    taxBundle: ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus,
    members,
    householdSize: ctx.secondary ? 2 : 1,
    assumedCostBasisFraction,
    inflationRatePct: ctx.projCtx.inflationPct,
    medicalInflationRatePct: ctx.medicalInflationRatePct,
    primaryDeathYear,
    secondaryDeathYear,
    filingStatusOverride: resolved.filingStatus ?? undefined,
    // The filing plan is plain data, so it survives the worker boundary and enters the cache key via the
    // serialized tax context.
    taxFilingPlan: resolved.taxFilingPlan,
    // Per-owner Roth-IRA regular basis from `rothDistributionFacts.rothIraByPool`, minus all-inactive pools
    // (`mcDrawableRothBasisCentsByOwner`). Employer-Roth basis rides on `rothOrderedProfile`; working-years
    // conversion basis is deterministic-only. Canonicalized to a sorted array because a `Map` is invisible to
    // `mcCacheKey`.
    rothBasisCentsByOwner: canonicalMcRothBasisByOwner(mcDrawableRothBasisCentsByOwner(ctx)),
    rothOrderedProfile: buildMcRothOrderedProfile(ctx),
    // Scenario exempt-account ids plus the pre-resolved per-leg waiver, since pooled MC buckets cannot match
    // real ids.
    earlyWithdrawalPenaltyExemptAccountIds:
      resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [],
    mcPreTaxPenaltyAllExempt: penaltyExemptions.preTaxAllExempt,
    mcRothPenaltyAllExempt: penaltyExemptions.rothAllExempt,
    // The two MAGI bootstrap lookbacks seed the MC ring for years 0-1 as the deterministic engine does.
    magiBootstrapLookbackMinus2: resolved.magiBootstrapLookbackMinus2,
    magiBootstrapLookbackMinus1: resolved.magiBootstrapLookbackMinus1,
    // Omitted for one-member households and households with no SS, so the cache key is unchanged.
    ...canonicalSsSharesByYear(ssRows, ctx.secondary !== undefined),
    // Canonical opt-out set, omitted when empty so a no-opt-out scenario's cache key is unchanged.
    ...canonicalOptOutSet(resolved.acaMarketplaceOptOutMemberIds),
    // Month-aware health facts, each omitted when unset to keep the cache key stable; plain JSON values,
    // never a `Map` or `Set`.
    ...(resolved.healthCoverageMonths !== undefined
      ? { healthCoverageMonths: resolved.healthCoverageMonths }
      : {}),
    ...(resolved.acaFplRegion !== undefined ? { acaFplRegion: resolved.acaFplRegion } : {}),
    ...canonicalAcaBenchmark(resolved.acaPtcBenchmark),
    // Each member's own retirement year, emitted only when the household staggers.
    ...canonicalMcRetirementYears(ctx),
  };
}

// One entry per member ascending by member id, omitted when every member retires in the same year. A
// staggered household tells MC when each member stops working, so the secondary does not move to ACA coverage
// years early.
function canonicalMcRetirementYears(ctx: PipelineContext): {
  retirementYearByMember?: readonly { memberId: string; retirementYear: number }[];
} {
  const byMember = resolveRetirementYearByMember(ctx);
  const years = [...byMember.values()];
  if (years.length < 2 || years.every((y) => y === years[0])) return {};
  return {
    retirementYearByMember: [...byMember.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([memberId, retirementYear]) => ({ memberId, retirementYear })),
  };
}

/**
 * Canonicalizes the per-year ACA benchmark overrides for the MC input: ascending by tax year, omitted when
 * empty, using the shared `storedAcaBenchmarkOverrides` reader so a malformed row never enters the hashed
 * `mcCacheKey`.
 */
export function canonicalAcaBenchmark(
  overrides: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }> | undefined,
): { acaPtcBenchmark?: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }> } {
  const sorted = storedAcaBenchmarkOverrides(overrides);
  if (sorted.length === 0) return {};
  return { acaPtcBenchmark: sorted };
}

/**
 * Builds the minimal RMD metadata for `MonteCarloInput.mcRmdContext`, so the RMD post-pass can run when
 * `taxContext` is absent; falls back to `DEFAULT_TAX_CALIBRATION_BUNDLE`.
 */
export function buildMcRmdContext(ctx: PipelineContext): McRmdContext | undefined {
  const taxBundle = ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE;
  // Same derivation as the deterministic engine.
  const { primaryDeathYear, secondaryDeathYear } = resolveHouseholdDeathYears(ctx);
  return {
    members: [
      {
        memberId: ctx.primary.id,
        isoBirthdate: ctx.primary.payload.birthdate ?? `${ctx.projCtx.asOfYear - 55}-01-01`,
        onMedicare: false,
        hasAcaCoverage: false,
      },
      ...(ctx.secondary
        ? [
            {
              memberId: ctx.secondary.id,
              isoBirthdate:
                ctx.secondary.payload.birthdate ?? `${ctx.projCtx.asOfYear - 55}-01-01`,
              onMedicare: false,
              hasAcaCoverage: false,
            },
          ]
        : []),
    ],
    rmdSnapshot: taxBundle.rmd,
    ...(primaryDeathYear !== undefined ? { primaryDeathYear } : {}),
    ...(secondaryDeathYear !== undefined ? { secondaryDeathYear } : {}),
    // Per-account RMD facts and separation years as plain `Record`s so they survive `postMessage` and the
    // `JSON.stringify` cache key; omitted when nothing is recorded.
    ...buildRmdEngineFactsFragment(ctx),
  };
}

/**
 * Builds the serializable per-path QCD context for `MonteCarloInput.qcdContext`, mirroring the deterministic
 * `buildQcdContext` without closures or `Map`s. The engine rebuilds the runtime context per path with that
 * path's own CPI. `undefined` when no QCD resolved.
 */
export function buildMcQcdContext(ctx: PipelineContext): McQcdContext | undefined {
  const entries = ctx.resolvedQcd.entries;
  if (entries.length === 0) return undefined;
  // Accumulate in a `Map` and serialize via `Object.fromEntries`: member ids are user-controlled, so a
  // plain-object guard would read `"__proto__"` or `"constructor"` through the prototype chain and drop the
  // owner (CWE-1321).
  const firstEligibleByOwner = new Map<string, number>();
  const addOwner = (id: string, birthdate: string | undefined): void => {
    if (!birthdate || firstEligibleByOwner.has(id)) return;
    try {
      firstEligibleByOwner.set(id, qcdFirstEligibleTaxYear(birthdate));
    } catch {
      // An owner with a malformed birthdate is left out.
    }
  };
  addOwner(ctx.primary.id, ctx.primary.payload.birthdate);
  if (ctx.secondary) addOwner(ctx.secondary.id, ctx.secondary.payload.birthdate);
  return {
    entries: entries.map((e) => ({
      memberId: e.memberId,
      sourceAccountId: e.sourceAccountId,
      annualAmountDollars: e.annualAmountDollars,
      startYear: e.startYear,
      endYear: e.endYear,
    })),
    firstEligibleYearByOwner: Object.fromEntries(firstEligibleByOwner),
    inflationPct: ctx.projCtx.inflationPct,
  };
}

/**
 * Strategy and income options for `mcInputFromBundle`, riding alongside the bundle because it carries neither
 * the per-path strategy switch nor the CPI-scaled inflation-tracked income.
 */
export interface McStrategyOpts {
  readonly strategyKind?: MonteCarloInput['strategyKind'];
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  /** Inflation-tracked income subset (nominal, year-offset from firstYear). */
  readonly tracksInflationIncomeByYear?: number[];
  /**
   * Serializable MAGI-ceiling window schedule; the engine rebuilds the runtime configs because their closures
   * cannot cross `postMessage`.
   */
  readonly magiCapOverride?: MagiCapOverride;
  /** Index-aligned precomputed per-window resolved bounds, companion to `magiCapOverride.windows`. */
  readonly magiCapWindowBounds?: ReadonlyArray<{
    readonly startYear: number;
    readonly endYear: number;
    readonly brokenAnchor: boolean;
  }>;
}

/** Flattens the bundle into the `MonteCarloInput` the worker consumes. */
export function mcInputFromBundle(
  bundle: BalanceProjectionMcBundle,
  taxContext?: McTaxContext,
  strategyOpts?: McStrategyOpts,
  mcRmdContext?: McRmdContext,
  qcdContext?: McQcdContext,
): MonteCarloInput {
  // `targetedOneOffEvents` (from `depositInflow`) carries every plain-pension lump-sum; subtract the
  // ledger-matched ones the bundle factory already placed per account, and leave unmatched ones in the spread
  // once.
  const householdOneOff = subtractMatchedPlainPension(
    bundle.targetedOneOffEvents,
    bundle.plainPensionPlacementEvents,
    bundle.accountMcLedger,
  );
  const events: ReadonlyArray<{
    month: number;
    amount: number;
    amountPre?: number;
    amountPost?: number;
    source: 'cbpLumpSum' | 'targetedOneOff' | 'secondaryContribution';
    targetAccountId?: string;
  }> = [
    ...bundle.cbpLumpSumEvents.map((e) => ({
      month: e.month,
      amount: e.amount,
      source: 'cbpLumpSum' as const,
      targetAccountId: e.accountId,
    })),
    ...householdOneOff.map((e) => ({
      month: e.month,
      amount: e.amount,
      source: 'targetedOneOff' as const,
      targetAccountId: e.accountId,
    })),
    ...bundle.postPrimaryContributionEvents.map((e) => ({
      month: e.month,
      amount: e.amount,
      // Carry the pre/post split so an unmatched household-level event still routes by source.
      ...(e.amountPre !== undefined ? { amountPre: e.amountPre } : {}),
      ...(e.amountPost !== undefined ? { amountPost: e.amountPost } : {}),
      source: 'secondaryContribution' as const,
      targetAccountId: e.accountId,
    })),
    // No separate plain-pension event is listed: matched ones are already in the ledger and subtracted from
    // the spread, and unmatched ones stay in the spread, so adding any would double-count.
  ];
  return {
    portfolioToday: bundle.portfolioToday,
    accountMcLedger: bundle.accountMcLedger,
    annualContribution: bundle.annualContribution,
    firstYear: bundle.todayYear,
    todayMonthIndex: bundle.todayMonthIndex,
    retirementYear: bundle.retirementYear,
    // Month-precise retirement, so `retirementStepIdx` snaps to the actual month.
    primaryRetirementMonth0: bundle.primaryRetirementMonth0,
    horizonYear: bundle.horizonYear,
    monthlyExpenseBase: bundle.monthlyExpenseBase,
    ...(bundle.monthlyExpenseBucketsBase !== undefined
      ? { monthlyExpenseBucketsBase: bundle.monthlyExpenseBucketsBase }
      : {}),
    // Medical-demand base and rate enable the medical-first HSA pass, as in the deterministic engine; absent
    // means emergency-only HSA routing.
    ...(bundle.monthlyMedicalDemandBase !== undefined
      ? {
          monthlyMedicalDemandBase: bundle.monthlyMedicalDemandBase,
          medicalDemandRatePct: bundle.medicalDemandRatePct,
          ...(bundle.monthlyMedicalDemandBucketsBase !== undefined
            ? { monthlyMedicalDemandBucketsBase: bundle.monthlyMedicalDemandBucketsBase }
            : {}),
        }
      : {}),
    ...(bundle.monthlyMedicalExpenseBase !== undefined
      ? {
          monthlyMedicalExpenseBase: bundle.monthlyMedicalExpenseBase,
          medicalExpenseRatePct: bundle.medicalExpenseRatePct,
          ...(bundle.monthlyMedicalExpenseBucketsBase !== undefined
            ? { monthlyMedicalExpenseBucketsBase: bundle.monthlyMedicalExpenseBucketsBase }
            : {}),
        }
      : {}),
    ssByYear: bundle.ssByYear,
    // Fold the rollover-year RMD cash into non-SS income, so MC spends and taxes what the deterministic
    // engine does.
    incomeByYear: foldRolledRmdIntoIncomeByYear(
      bundle.incomeByYear,
      bundle.rolledRmdIncomeByYear,
      bundle.todayYear,
    ),
    scenarioInflationPct: bundle.scenarioInflationPct,
    pathCount: OPTIMIZER_MC_DEFAULT_PATHS,
    seed: OPTIMIZER_MC_SEED,
    events,
    ...(taxContext !== undefined ? { taxContext } : {}),
    // Surfaced top-level so `mcCacheKey` changes for an opt-out scenario.
    ...(taxContext?.acaMarketplaceOptOutMemberIds !== undefined
      ? { acaMarketplaceOptOutMemberIds: taxContext.acaMarketplaceOptOutMemberIds }
      : {}),
    ...(mcRmdContext !== undefined ? { mcRmdContext } : {}),
    // Omitted when no QCD resolved, so a no-QCD cache key is unchanged.
    ...(qcdContext !== undefined ? { qcdContext } : {}),
    ...(strategyOpts?.tracksInflationIncomeByYear !== undefined
      ? { tracksInflationIncomeByYear: strategyOpts.tracksInflationIncomeByYear }
      : {}),
    // `strategyKind` is required on `MonteCarloInput`; default to `taxEfficient` when no options are
    // supplied.
    strategyKind: strategyOpts?.strategyKind ?? 'taxEfficient',
    ...(strategyOpts?.customTiers !== undefined
      ? { customTiers: strategyOpts.customTiers }
      : {}),
    ...(strategyOpts?.excludedIndices !== undefined
      ? { excludedIndices: strategyOpts.excludedIndices }
      : {}),
    ...(strategyOpts?.magiCapOverride !== undefined
      ? {
          magiCapOverride: strategyOpts.magiCapOverride,
          ...(strategyOpts.magiCapWindowBounds !== undefined
            ? { magiCapWindowBounds: strategyOpts.magiCapWindowBounds }
            : {}),
        }
      : {}),
    // Guardrail config and baseline real series, omitted when no scenario enabled it so the cache key is
    // unchanged.
    ...(bundle.downturnGuardrails !== undefined
      ? {
          downturnGuardrails: bundle.downturnGuardrails.config,
          guardrailBaselineRealNetNeedByYear:
            bundle.downturnGuardrails.baselineNetNeedRealByYear,
          guardrailEssentialRealByYear: bundle.downturnGuardrails.essentialRealByYear,
          guardrailBaselineTotalRealByYear:
            bundle.downturnGuardrails.baselineTotalRealByYear,
          guardrailEffectiveTaxRate: bundle.downturnGuardrails.effectiveTaxRate,
        }
      : {}),
  };
}

// Translates the withdrawal strategy into `McStrategyOpts`; `customOrder` pre-builds tier indices via
// `buildCustomTierIndices` so MC tiers match the deterministic engine.
function buildMcStrategyOpts(
  strategy: { kind: NonNullable<MonteCarloInput['strategyKind']> },
  customDrawdownOrder: { tiers: string[][]; excludedAccountIds: string[] } | undefined,
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
): Pick<McStrategyOpts, 'strategyKind' | 'customTiers' | 'excludedIndices'> {
  if (strategy.kind !== 'customOrder') {
    return { strategyKind: strategy.kind };
  }
  // A `customOrder` strategy with no resolved order throws the same error as the deterministic per-account
  // engine, rather than falling through to empty tiers.
  if (!customDrawdownOrder) {
    throw new MissingCustomDrawdownOrderError();
  }
  const minimalAccounts = ledger.map((l) => ({
    id: l.id,
    initialPre: l.initialPre,
    initialPost: l.initialPost,
    annualRatePct: 0,
    depositsByMonth: { startYear: 0, startMonthIndex: 0, values: new Float64Array(0) },
    taxTreatment: l.taxTreatment ?? 'PRE_TAX',
    accountType: l.accountType ?? 'BROKERAGE',
  }));
  const { customTiers, excludedIndices } = buildCustomTierIndices(
    minimalAccounts,
    customDrawdownOrder?.tiers ?? [],
    customDrawdownOrder?.excludedAccountIds ?? [],
  );
  return { strategyKind: strategy.kind, customTiers, excludedIndices };
}

/**
 * Per-scenario optimizer MC setup: the candidate-invariant `MonteCarloInput` built once per scenario, with
 * `mcInputForCandidate` swapping only the candidate-sensitive `ssByYear` slice.
 */
export interface OptimizerMcScenarioSetup {
  /**
   * Builds a candidate's `MonteCarloInput` by swapping only `ssByYear`; `successOnly` makes the worker skip
   * `runPlannedOverlay`.
   */
  readonly mcInputForCandidate: (
    overlay: CandidateOverlay,
    opts?: { readonly successOnly?: boolean },
  ) => MonteCarloInput;
}

/**
 * Runs the BPP pipeline once per scenario and returns the `OptimizerMcScenarioSetup`. Claim age is the only
 * candidate input reaching the SS overlay, so this equals calling `runBalanceProjectionMc` per candidate at a
 * fraction of the cost. Throws `NoPrimaryRetirementError` / `CbpUnconfiguredError` as
 * `runBalanceProjectionMc` does.
 */
export function buildOptimizerMcScenarioSetup(
  args: RunBalanceProjectionArgs,
): OptimizerMcScenarioSetup {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new NoPrimaryRetirementError();
  if (ctx.cbpValidation && !ctx.cbpValidation.ok) {
    throw new CbpUnconfiguredError();
  }
  const series = buildCashflowSeries(args, ctx);
  const bundle = assembleMcBundle({ runArgs: args, ctx, cashflowSeries: series });
  const taxContext = buildMcTaxContext(ctx);
  const strategyOpts = buildMcStrategyOptsFromContext(args, ctx, bundle);
  const invariantInput = mcInputFromBundle(
    bundle,
    taxContext,
    strategyOpts,
    buildMcRmdContext(ctx),
    buildMcQcdContext(ctx),
  );
  const horizonYears = ctx.horizonYear - args.todayYear + 1;
  return {
    mcInputForCandidate: (overlay, opts) => {
      const ssByYear = computeSsByYearForClaimAges({
        runArgs: args,
        ctx,
        horizonYears,
        claimAgePrimary: overlay.socialSecurity.primary,
        claimAgeSecondary: overlay.socialSecurity.secondary,
        // The candidate's survivor overlay carries the verbatim stored age and must reach MC; absent, the
        // stored survivor section applies, as in `withCandidateOverlay`.
        survivor: overlay.socialSecurity.survivor,
      });
      return {
        ...invariantInput,
        ssByYear,
        ...(opts?.successOnly ? { successOnly: true } : {}),
      };
    },
  };
}
