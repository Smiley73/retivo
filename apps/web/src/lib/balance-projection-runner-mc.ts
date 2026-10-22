/**
 * MC-bundle assembly half of the BPP-equivalent helper. Pulled into a
 * sibling file so `balance-projection-runner.ts` stays under the
 * ≤400-ln file shape cap. Exports two helpers the deterministic runner
 * calls via `runBalanceProjectionMc`:
 *
 *   - `assembleMcBundle` — builds the `BalanceProjectionMcBundle` the
 *     existing MC builder consumes (same shape BPP's `mcBundle` memo
 *     produces).
 *   - `mcInputFromBundle` — flattens that bundle into the
 *     `MonteCarloInput` the worker consumes.
 *
 * The helper **assembles** the input only — `runMonteCarlo`
 * runs exclusively inside `monte-carlo.worker.ts`.
 *
 * The MC kernel consumes `ssByYear` + `incomeByYear` (pre-computed
 * nominal arrays) rather than today's-dollar scalars. SS applies its own
 * COLA (`resolveSsColaPct` — scenario inflation by default, or the fixed
 * `colaPct` when the override opts out) year-by-year from the claim year
 * onward; non-SS income streams apply `tracksInflation` / `colaPct`
 * resolution using the scenario inflation rate. The kernel no longer
 * applies CPI to income — only expenses inflate stochastically per path.
 *
 * `computeSsByYear` delegates to `buildSsContext` + `projectSsByYear`
 * (ss-projection.ts) — the same implementation as the deterministic runner,
 * so the two cannot drift on secondary-SS defaults or claim-year
 * arithmetic.
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
// The MC synthetic-pool mirror of the fact-based Roth state.
import {
  canonicalMcRothBasisByOwner,
  type McRothOrderedProfile,
} from './monte-carlo-tax';
import {
  assembleMcBundle,
  computeSsByYearForClaimAges,
} from './monte-carlo-input-bundle';

/** Deterministic seed for the MC sweep — pinned so two runs on
 *  the same inputs return identical pair rankings. Exported because
 *  `optimizer-mc-runner.ts` also overrides the bundle seed to this
 *  value; one source of truth keeps the two in lockstep. */
export const OPTIMIZER_MC_SEED = 1;
const OPTIMIZER_MC_DEFAULT_PATHS = 1000;

/** Deterministic seed for the live Guardrails-page "Check now" MC run.
 *  A distinct fixed value from `OPTIMIZER_MC_SEED = 1`
 *  so repeated clicks against unchanged inputs return the SAME probability-of-
 *  success (UX stability + test pinning), while staying separate from the
 *  optimizer/stress-test seeds so the two surfaces never alias. */
export const GUARDRAILS_LIVE_MC_SEED = 2;

/** Returns the income subset that tracks CPI (payload.tracksInflation === true).
 *  The runner passes this as `tracksInflationIncomeByYear` so the MC engine can
 *  scale it per-path by the realized CPI ratio. Mirrors `computeNonSsIncomeByYear`
 *  but filters to inflation-tracked streams only. */
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

/** Assemble the full strategy/income options the MC engine needs
 *  from the resolved scenario + pipeline context. Shared by both
 *  `mcInputFromBundle` call sites (BPP entry + optimizer setup). */
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
  // Build the MAGI-ceiling cap config for the MC strategy path, the
  // SAME way `runDrawdownForMethod` builds it for the deterministic engine
  // (the explicit-disable sentinel coerces to "no cap").
  const rawMagiCap = ctx.resolvedScenario.magiCap;
  const magiCap = isMagiCapDisabled(rawMagiCap) ? undefined : rawMagiCap;
  // Thread the SERIALIZABLE overlay (the windows
  // array) + the index-aligned precomputed per-window resolved bounds (never
  // the closure-bearing `MagiCapRuntimeConfig`, which `DataCloneError`s when the
  // MC input is posted to a Web Worker). The engine rebuilds one runtime config
  // per window via `buildMagiCapConfig` inside `runOnePathViaStrategyEngine` and
  // selects ≤ 1 active window per path-year. An empty / unresolvable ladder
  // yields no bounds → no cap overlay threaded.
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

/** Add the per-calendar-year rolled-CBP RMD income (dollars) to a copy
 *  of `incomeByYear` (indexed by year-offset from `todayYear`). Returns the
 *  input unchanged when there is no rolled-RMD income. */
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

/** Subtract the ledger-MATCHED plain-pension placement amounts (by month)
 *  from the household-spread one-off events. A plain-pension placement is
 *  "matched" when its `accountId` resolves to an MC ledger entry — those dollars
 *  are already deposited per-account by the bundle factory, so they must be
 *  removed from the household spread (which carries the same dollars via
 *  `depositInflow`). Unmatched placements are left in the spread. The
 *  subtraction is clamped at 0 per event and never produces negative deposits;
 *  it mirrors `subtractCbpLumpSumsFromHouseholdDeposits` on the deterministic
 *  side so the two engines apply each plain-pension dollar exactly once. */
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

/**
 * Build an `McTaxContext` from the `PipelineContext` for threading into
 * `MonteCarloInput`. Always returns a context — every withdrawal strategy is
 * tax-supported (mcTaxSupported is always true).
 *
 * When `ctx.taxBundle` is absent the default bundle is used automatically
 * so UI callers that do not supply an explicit bundle still get MC tax
 * annotation.
 *
 * The returned context is a snapshot of household-level info used to
 * approximate per-year tax in the MC engine (see McTaxContext JSDoc for
 * the key simplifications).
 */
/**
 * Pre-resolve the per-leg penalty waiver for the MC synthetic pool.
 *
 * The MC kernel pools accounts into synthetic pre-tax / Roth buckets, so a real
 * exempt account id can never match the synthetic `mc-pretax` / `mc-roth` ids the
 * MC penalty leg uses. Resolve the waiver here against the real scenario
 * accounts, counting EVERY account that feeds the corresponding classification
 * bucket and treating an account as exempt when it is scenario-marked exempt OR
 * statutorily penalty-free at the SOURCE:
 *
 *   - §72(t) pre-tax leg: every PRE_TAX / MIXED account feeds the pooled
 *     pre-tax bucket. A type outside `carriesTenPercentPenalty` (the
 *     governmental 457(b)) is source-exempt — the deterministic per-account
 *     engine never penalizes it, so a household whose pre-tax dollars come
 *     ONLY from 457(b) plans must not have the pooled leg fire.
 *   - Roth-earnings leg: every account feeding `rothBasisOrderedDollars`
 *     (`RETIREMENT_ROTH_IRA`, the pure employer Roth types, and the MIXED
 *     Roth-designated post sub-buckets). `RETIREMENT_ROTH_457B` and the MIXED
 *     `RETIREMENT_457B` post bucket are source-exempt (governmental §72(t)
 *     exception — `isGovernmental457bType` on the deterministic side).
 *
 * A leg is waived here only when EVERY contributing account is exempt (scenario
 * or statutory). A PARTLY-exempt pool does not over-penalize: the
 * MC classifier preserves per-source provenance
 * (`classifyMcWithdrawal` → `preTaxPenaltyExemptDollars` /
 * `rothOrderedPenaltyExemptDollars`), so `computeMcPenaltyDollars` penalizes
 * only the non-exempt-source portion of a mixed withdrawal — matching the
 * deterministic per-account engine. These whole-leg flags remain the fallback
 * for classifications built without per-source exemption info (and the fast
 * path for the all-exempt case).
 */
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
    // Count every pooled-pre-tax-bucket source; statutorily penalty-free
    // types (457(b)) count as exempt instead of being left uncounted.
    if (taxTreatment === 'PRE_TAX' || taxTreatment === 'MIXED') {
      preTaxCount += 1;
      if (exempt.has(id) || !carriesTenPercentPenalty(type)) preTaxExemptCount += 1;
    }
    // Count every §408A-ordered Roth bucket source — ROTH_IRA, the pure
    // employer Roth types, and MIXED Roth-designated post sub-buckets. The
    // governmental 457(b) variants count as SOURCE-exempt (0% §72(t) by
    // statute), so an all-457(b) Roth bucket waives the pooled leg; mixed with
    // a penalized 401(k)/403(b)/TSP/IRA source the whole-leg flag stays false
    // and the classifier's per-source split penalizes only the
    // non-exempt share of the earnings excess.
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
 * Canonicalize the ACA opt-out member-id set for the MC input: sorted +
 * deduped (so semantically-identical sets — different order / dupes — hash to ONE
 * `mcCacheKey`, keeping runs bit-for-bit reproducible), and OMITTED
 * entirely when empty (so a no-opt-out scenario's serialized `MonteCarloInput` is
 * byte-unchanged). Returns a spreadable fragment: `{}` when empty, otherwise
 * `{ acaMarketplaceOptOutMemberIds: [...] }`. Never a `Set` — `JSON.stringify(new
 * Set)` is `{}` and would be invisible to the cache key.
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
 * Each year's PRIMARY share of the household's gross Social Security,
 * canonicalized for the MC cache key (ascending by year, one entry per year the
 * household actually receives SS).
 *
 * Social Security belongs to the member who receives it (§86 / IRS Pub 555). A
 * `separate` couple's two returns must therefore each run §86 on their OWN
 * benefit — the deterministic engine attributes it that way, and a blanket
 * 50/50 split in MC would produce a DIFFERENT taxable-SS figure (§86 is
 * non-linear per return) and so different funded balances and success
 * probabilities for the same household.
 *
 * Returns a spreadable fragment, OMITTED entirely for a one-member household or
 * a household with no SS at all, so a scenario the split cannot affect keeps a
 * byte-identical serialized `MonteCarloInput` + `mcCacheKey`.
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

/**
 * The Roth-DESIGNATED (post) slice of a MIXED account's balance, in cents.
 *
 * A MIXED employer plan's pre-tax sub-account NEVER enters the MC Roth-ordered
 * pool — `classifyMcWithdrawal` routes only the account's POST share into
 * `rothBasisOrderedDollars`. Counting the whole balance would inflate the
 * pool denominator and mis-split every pooled Roth draw between the §408A
 * contribution-first regime (Roth IRA) and the §402A pro-rata regime (designated),
 * e.g. a $100k Roth IRA beside a $900k MIXED plan holding only $100k of Roth money
 * scored the IRA share at ~0.10 instead of ~0.50. This mirrors
 * `mcDesignatedRothPoolBalanceDollars`, which already used the post bucket only.
 *
 * The pocket share comes from the account's own projection buckets for the run's
 * method (`preTax` / `postTax` at retirement — the only per-account pre/post split
 * available at this seam) applied to the pooled balance basis. With no usable
 * split the whole balance is kept in the designated pool: that is the direction
 * that routes MORE of the pooled draw through §402A pro rata (taxable earnings in
 * every dollar) rather than §408A contribution-first, i.e. the conservative
 * fallback.
 */
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

/**
 * Build the MC synthetic pool's fact-based Roth state (`McRothOrderedProfile`).
 *
 * The MC kernel has one pooled Roth bucket, so this reduces the household's
 * per-POOL Roth-IRA facts and per-ACCOUNT designated-Roth facts to the minimum
 * the pool needs while keeping every aggregation one-sided conservative:
 *
 *  - `iraShareOfOrderedPool` splits the ordered draw between the two regimes by the
 *    ledger's initial Roth balances (the only per-source information the MC input
 *    carries), counting a MIXED plan's Roth-DESIGNATED pocket only — never its
 *    pre-tax sub-account, which never enters the Roth-ordered pool
 *    (`mixedDesignatedPocketCents`) — and never an INHERITED Roth IRA, whose
 *    dollars are wholesale tax-free and never enter it either. No Roth
 *    balance at all → 1 (all-IRA).
 *  - the Roth-IRA five-year clock is the LATEST of the §408A pools' (already
 *    within-pool-earliest) first-contribution years, and it is ABSENT entirely when
 *    ANY contributing pool has no recorded year. IRC §408A's five-year period and
 *    the age-59½ test are both PER INDIVIDUAL ACCOUNT-SET, and the MC kernel has a
 *    single household Roth bucket with no owner or account attribution at withdrawal
 *    time, so the only safe pooled clock is the one no pool can beat (a
 *    cross-owner EARLIEST would let an older spouse's seasoned IRA qualify a younger
 *    spouse's brand-new one). `rothOwnerIds` carries the contributing owners so the
 *    59½ test likewise requires EVERY one of them to have reached it — and an owner
 *    whose ONLY Roth account is inherited contributes no pool, so they are absent
 *    from that list rather than gating it.
 *  - the DESIGNATED clock is the LATEST first-participation year and is ABSENT when
 *    ANY designated account lacks one — order-independently (a later account
 *    with a known clock would otherwise overwrite the missing-clock state, so
 *    household iteration order would decide whether an unknown clock counted as met).
 *  - the governmental-457(b) earnings carve-out is applied only when EVERY
 *    designated source is a 457(b), so a non-457(b) sibling's genuine 10% is never
 *    waived by pooling.
 *  - conversion and in-plan-rollover lots are AGGREGATED BY TAX YEAR, which is both
 *    the statutory grouping (§408A(d)(4)(B)) and a natural bound on how many lots
 *    the per-path ordering has to scan (one per distinct year, not one per account).
 *
 * Returns `undefined` when the household records no Roth facts at all, so a
 * fact-free scenario's serialized `MonteCarloInput` (and `mcCacheKey`) is unchanged.
 */
function buildMcRothOrderedProfile(
  ctx: PipelineContext,
): McRothOrderedProfile | undefined {
  const facts = ctx.rothDistributionFacts;
  const designated = [...facts.designatedByAccount.values()];
  const iraPools = [...facts.rothIraByPool.values()];
  if (designated.length === 0 && iraPools.length === 0) return undefined;

  // Roth pool shares from each account's latest recorded balance — the only
  // per-source magnitude the MC input carries. Pure Roth pockets count in full; a
  // MIXED Roth-designated account contributes ONLY its Roth-designated (post)
  // pocket, because that is the only part `classifyMcWithdrawal` ever routes into
  // the Roth-ordered pool and the part the §402A pro-rata rule applies to. An
  // INHERITED Roth IRA contributes NOTHING for the same reason:
  // `classifyMcWithdrawal` routes its draw to the wholesale tax-free bucket, so
  // counting its balance would compute the pool's §408A-vs-§402A split against
  // dollars that never enter it. A household with no Roth balance at all leaves
  // the share at 1 (all-IRA).
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

  // Roth IRAs: LATEST clock across every §408A POOL (each owner's own accounts —
  // an inherited Roth IRA has no pool at all), sticky-absent when any pool has
  // none. The pooled clock, the lots and `rothOwnerIds` therefore drop an inherited
  // account automatically, because the fact map they walk no longer holds one.
  let iraFirstContributionTaxYear: number | undefined;
  let anyIraClockMissing = false;
  const iraLotsByYear = new Map<number, { taxableCents: number; nontaxableCents: number }>();
  const rothOwnerIds = new Set<string>();
  for (const pool of facts.rothIraByPool.values()) {
    const ira = pool.rothIra;
    if (!ira) continue;
    // The REAL member id, not the pool key — an inherited pool's key carries an
    // account-id suffix and would never match a member for the 59½ test.
    rothOwnerIds.add(pool.ownerId);
    if (ira.firstContributionTaxYear === undefined) {
      anyIraClockMissing = true;
    } else {
      iraFirstContributionTaxYear =
        iraFirstContributionTaxYear === undefined
          ? ira.firstContributionTaxYear
          : Math.max(iraFirstContributionTaxYear, ira.firstContributionTaxYear);
    }
    // An ALL-INACTIVE pool's remaining lots are money no deterministic
    // draw can ever reach (the annotation keys on the drawn pool, the funding
    // pass on drawn ledger owners), so crediting them to the MC aggregate would
    // shelter OTHER owners' dollars with unreachable basis and under-report tax
    // relative to the deterministic engine. The pool's conservative
    // consequences above (owner in the 59½ set, missing clock blanking the
    // pooled clock) deliberately stay.
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

  // Designated Roth: LATEST clock, sticky-absent when ANY account has none, and
  // the pooled in-plan-rollover lots (their own §402A(c)(4)(D) recapture clocks).
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
  // Order-independent: an absent clock anywhere in the pool means the pooled clock
  // is NOT satisfied, regardless of which account was visited last.
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
    // Sorted so two semantically-identical households serialise to ONE cache key.
    rothOwnerIds: [...rothOwnerIds].sort(),
  };
}

/**
 * The per-owner Roth-IRA regular-contribution basis a Monte Carlo path may
 * actually SHELTER dollars with: `ctx.rothBasisCentsByOwner` minus every
 * ALL-INACTIVE pool's share. An all-closed pool's derived basis is real (it is
 * the resolved figure the profile page shows) but no engine can draw from it —
 * the deterministic annotation keys its carrier on the DRAWN pool and the
 * funding pass charges drawn ledger owners, so that basis is never consumed
 * there. Seeding it into the MC aggregate carrier would let it shield OTHER
 * owners' Roth draws on every path, making MC under-report tax relative to the
 * deterministic engine for the same data. Both engines therefore agree by both
 * NOT crediting it.
 */
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

export function buildMcTaxContext(
  ctx: PipelineContext,
  /** Per-month SS run-rate rows for the run — the source of the per-year
   *  per-member SS attribution above. Absent → MC keeps the even split. */
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
      // Use retirement year as a proxy: Medicare at 65. The MC engine
      // checks age against 65 each year — this birthdate drives that calc.
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
  // Pre-resolve the per-leg penalty waiver against the real accounts.
  const penaltyExemptions = resolveMcPenaltyExemptions(ctx);

  // Projected death years drive the per-year MC alive-state: ONE shared
  // derivation with the deterministic twin
  // (`resolveHouseholdDeathYears`) so an imported malformed birthdate cannot
  // make a member dead on one engine and alive on the other — which fed
  // different household sizes into the same `computeAcaPtc`.
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
    // Thread the scenario's filing plan across the worker boundary so the
    // MC per-path tax resolves the SAME tax units the deterministic runner
    // resolves (joint / separate / death-year / bounded QSS-HoH windows). A
    // plain data union — structured-clone-safe, and part of the MC cache key
    // via the serialized tax context, so editing the plan invalidates cached
    // results.
    taxFilingPlan: resolved.taxFilingPlan,
    // Thread the per-owner Roth-IRA REGULAR-contribution basis into the MC
    // context so each path seeds its cumulative §408A basis carrier identically
    // to the deterministic engine.
    // Sourced from `rothDistributionFacts.rothIraByPool` — the same pools
    // `ctx.rothBasisCentsByOwner` sums — MINUS every ALL-INACTIVE pool's share
    // (`mcDrawableRothBasisCentsByOwner`): no deterministic pass can consume an
    // all-closed pool's basis, so the MC aggregate must not shelter with it
    // either. The pure-employer-Roth and MIXED Roth-designated post
    // sub-bucket sources are not part of this field; that basis rides on
    // `rothOrderedProfile` below instead (`buildMcRothOrderedProfile`, §402A
    // pooled state). Working-years conversion basis is deterministic-only and
    // is NOT included in the MC seed.
    // Canonicalized to a PLAIN sorted array — a `Map` here would be invisible
    // to `mcCacheKey` (`JSON.stringify(new Map())` is `{}`), so two households with
    // different resolved Roth basis would share one cached summary.
    rothBasisCentsByOwner: canonicalMcRothBasisByOwner(mcDrawableRothBasisCentsByOwner(ctx)),
    // The fact-based §408A/§402A state for the MC synthetic pool.
    rothOrderedProfile: buildMcRothOrderedProfile(ctx),
    // Thread the scenario exempt-account ids + pre-resolve the per-leg
    // waiver (pooled MC buckets cannot match real account ids at withdrawal time).
    earlyWithdrawalPenaltyExemptAccountIds:
      resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [],
    mcPreTaxPenaltyAllExempt: penaltyExemptions.preTaxAllExempt,
    mcRothPenaltyAllExempt: penaltyExemptions.rothAllExempt,
    // Thread the two MAGI bootstrap lookbacks so the MC ring seeds
    // years 0–1 IRMAA in agreement with the deterministic engine.
    magiBootstrapLookbackMinus2: resolved.magiBootstrapLookbackMinus2,
    magiBootstrapLookbackMinus1: resolved.magiBootstrapLookbackMinus1,
    // Per-year SS attribution shares (omitted for one-member households
    // and for households with no SS, so the cache key is unchanged there).
    ...canonicalSsSharesByYear(ssRows, ctx.secondary !== undefined),
    // ACA opt-out: thread the RAW member-id set, canonicalized as a sorted +
    // deduped array and omitted when empty so a no-opt-out scenario's
    // serialized input (and `mcCacheKey`) is unchanged, while two
    // semantically-identical sets hash to the same key.
    ...canonicalOptOutSet(resolved.acaMarketplaceOptOutMemberIds),
    // The month-aware health facts. Each is omitted when the scenario
    // stores none, so a scenario without monthly coverage data keeps a
    // byte-identical serialized `MonteCarloInput` + `mcCacheKey`. All three are
    // plain JSON values (object / string / array) — never a `Map` or `Set`,
    // which `JSON.stringify` would erase from the hashed key.
    ...(resolved.healthCoverageMonths !== undefined
      ? { healthCoverageMonths: resolved.healthCoverageMonths }
      : {}),
    ...(resolved.acaFplRegion !== undefined ? { acaFplRegion: resolved.acaFplRegion } : {}),
    ...canonicalAcaBenchmark(resolved.acaPtcBenchmark),
    // Each member's OWN retirement year, emitted only
    // when the household actually staggers — otherwise every member's year IS
    // the household scalar MC already passes, and the serialized input stays
    // byte-identical.
    ...canonicalMcRetirementYears(ctx),
  };
}

/**
 * Canonicalize the per-member retirement years for the
 * MC input: one entry per member, ASCENDING by member id (so two
 * semantically-identical households hash to ONE `mcCacheKey`), and OMITTED
 * entirely when every member retires in the same year.
 *
 * The omission keeps a same-date household (the common
 * case, and every household the frozen parity fixtures record) serializing
 * exactly as it always has, while a STAGGERED household tells the MC engine when
 * each member actually stops working instead of letting the secondary inherit
 * the primary's year — which would switch them onto ACA Marketplace coverage years
 * early and break the twin-engine contract.
 */
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
 * Canonicalize the per-year ACA benchmark overrides for the MC input:
 * ascending by tax year (so two semantically-identical arrays in different
 * orders hash to ONE `mcCacheKey`), and
 * OMITTED entirely when empty so a scenario with no override keeps a
 * byte-unchanged serialized input. Mirrors `canonicalOptOutSet`.
 *
 * The sort and the shape check are the SAME shared
 * `storedAcaBenchmarkOverrides` reader every other surface uses, so an
 * envelope-only-validated import cannot throw out of MC context assembly and a
 * malformed row can never enter the hashed `mcCacheKey`.
 */
export function canonicalAcaBenchmark(
  overrides: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }> | undefined,
): { acaPtcBenchmark?: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }> } {
  const sorted = storedAcaBenchmarkOverrides(overrides);
  if (sorted.length === 0) return {};
  return { acaPtcBenchmark: sorted };
}

/**
 * Build minimal RMD metadata threaded as `MonteCarloInput.mcRmdContext` so the
 * RMD post-pass can run on representative runs even when `taxContext` is absent.
 * Uses `DEFAULT_TAX_CALIBRATION_BUNDLE` as a fallback when `ctx.taxBundle` is
 * absent (mirroring `buildMcTaxContext`).
 */
export function buildMcRmdContext(ctx: PipelineContext): McRmdContext | undefined {
  const taxBundle = ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE;
  // The SAME shared derivation the deterministic
  // engine uses (`resolveHouseholdDeathYears`).
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
    // The per-account RMD facts + per-owner separation years the shared
    // `computeRmd` engine needs, as plain `Record`s so both survive `postMessage`
    // AND the `JSON.stringify` cache key (no `Map`). Omitted when nothing is
    // recorded, so a fact-free household's serialized input is byte-unchanged.
    // The SAME derivation feeds the deterministic forced-withdrawal context
    // (`buildRmdContext`), so the two engines cannot drift on it.
    ...buildRmdEngineFactsFragment(ctx),
  };
}

/**
 * Build the SERIALIZABLE per-path QCD context threaded as
 * `MonteCarloInput.qcdContext`. Mirrors the deterministic
 * `buildQcdContext` (balance-projection-runner-drawdown.ts) but emits a plain,
 * structured-clone-safe shape (no closures, no `Map`): the engine rebuilds the
 * runtime `QcdContextInput` per path, inflating the REAL amount by THAT path's
 * own CPI and resolving the indexed limit by `inflationPct`. The 70½
 * first-eligible tax year is derived per owner from the member birthdate (an
 * owner with a missing / malformed birthdate is omitted → the engine skips
 * them). Returns `undefined` when no QCD resolved (no `qcdContext` on the input
 * → byte-identical no-QCD MC run + unchanged cache key).
 */
export function buildMcQcdContext(ctx: PipelineContext): McQcdContext | undefined {
  const entries = ctx.resolvedQcd.entries;
  if (entries.length === 0) return undefined;
  // Accumulate in a `Map` and serialize through
  // `Object.fromEntries` (which DEFINES own properties). Member ids are
  // user-controlled: a plain-object accumulator would read its own
  // "already added?" guard THROUGH the prototype chain, so an imported owner id
  // of `"__proto__"` or `"constructor"` would look already-present and be silently
  // dropped — no QCD eligibility year, so the engine would skip their gifts
  // (CWE-1321). Insertion order stays primary-then-secondary, so a normal
  // household's serialized `qcdContext` is byte-unchanged.
  const firstEligibleByOwner = new Map<string, number>();
  const addOwner = (id: string, birthdate: string | undefined): void => {
    if (!birthdate || firstEligibleByOwner.has(id)) return;
    try {
      firstEligibleByOwner.set(id, qcdFirstEligibleTaxYear(birthdate));
    } catch {
      // Malformed birthdate — leave the owner out (the entry resolver already
      // dropped any entry whose owner had an unparseable birthdate; defense-in-depth).
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

/** Strategy/income options threaded into `mcInputFromBundle`.
 *  `BalanceProjectionMcBundle` does not carry the per-path strategy switch or the
 *  per-path CPI-scaled inflation-tracked income, so these ride alongside the
 *  bundle rather than mutating its shape. */
export interface McStrategyOpts {
  readonly strategyKind?: MonteCarloInput['strategyKind'];
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  /** Inflation-tracked income subset (nominal, year-offset from firstYear). */
  readonly tracksInflationIncomeByYear?: number[];
  /** SERIALIZABLE MAGI-ceiling cap window
   *  schedule for the MC strategy path. The runtime configs are rebuilt
   *  engine-side (their closures cannot cross `postMessage`). Absent when no
   *  cap. */
  readonly magiCapOverride?: MagiCapOverride;
  /** Index-aligned precomputed per-window
   *  resolved bounds companion to `magiCapOverride.windows`. */
  readonly magiCapWindowBounds?: ReadonlyArray<{
    readonly startYear: number;
    readonly endYear: number;
    readonly brokenAnchor: boolean;
  }>;
}

export function mcInputFromBundle(
  bundle: BalanceProjectionMcBundle,
  taxContext?: McTaxContext,
  strategyOpts?: McStrategyOpts,
  mcRmdContext?: McRmdContext,
  qcdContext?: McQcdContext,
): MonteCarloInput {
  // The household-spread `targetedOneOffEvents` (sourced from
  // `depositInflow`) already carries EVERY plain-pension lump-sum's dollars.
  // The bundle factory also placed the ledger-MATCHED plain-pension dollars
  // per-account (in `entry.deposit[]`). Subtract those matched amounts from the
  // household spread so they are not applied twice (mirrors the deterministic
  // `subtractCbpLumpSumsFromHouseholdDeposits(…, plainPensionDeposits)`).
  // Unmatched targets are NOT subtracted, so they stay in the spread once.
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
      // Carry the pre/post split so a household-level (unmatched)
      // post-primary event still routes by source; ledger-matched events are
      // already split-routed in the bundle (skipped by routeHouseholdLevelEvents).
      ...(e.amountPre !== undefined ? { amountPre: e.amountPre } : {}),
      ...(e.amountPost !== undefined ? { amountPost: e.amountPost } : {}),
      source: 'secondaryContribution' as const,
      targetAccountId: e.accountId,
    })),
    // Ledger-matched plain-pension placements are already in the per-account
    // ledger `deposit[]` (routed by the bundle factory) AND subtracted from the
    // household spread above; unmatched plain-pension stays in `targetedOneOff-
    // Events` (depositInflow) once. So no separate plain-pension event is listed
    // here — that would double-count both matched (ledger + spread) and
    // unmatched (spread + fallback) dollars.
  ];
  return {
    portfolioToday: bundle.portfolioToday,
    accountMcLedger: bundle.accountMcLedger,
    annualContribution: bundle.annualContribution,
    firstYear: bundle.todayYear,
    // Today-anchor for tracks-inflation per-path contribution CPI scaling.
    todayMonthIndex: bundle.todayMonthIndex,
    retirementYear: bundle.retirementYear,
    // Month-precise retirement so the MC `retirementStepIdx` snaps to
    // the actual retirement month (a December retiree does not over-count the year).
    primaryRetirementMonth0: bundle.primaryRetirementMonth0,
    horizonYear: bundle.horizonYear,
    monthlyExpenseBase: bundle.monthlyExpenseBase,
    // Forward the per-effective-rate
    // per-month buckets when present (≥ 1 category ≠ general). Absent ⇒ the
    // kernel's verbatim scalar windowed-base path.
    ...(bundle.monthlyExpenseBucketsBase !== undefined
      ? { monthlyExpenseBucketsBase: bundle.monthlyExpenseBucketsBase }
      : {}),
    // HSA withdrawal-reserve: forward the per-month medical-demand base
    // + its effective rate so the MC strategy path runs the medical-first HSA
    // pass (parity with the deterministic engine). Absent ⇒ no `isMedical`
    // category → emergency-only HSA routing.
    ...(bundle.monthlyMedicalDemandBase !== undefined
      ? {
          monthlyMedicalDemandBase: bundle.monthlyMedicalDemandBase,
          medicalDemandRatePct: bundle.medicalDemandRatePct,
          // Forward the per-rate medical buckets when the medical set
          // spans > 1 effective rate so each sub-series inflates at its own rate.
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
    // Fold the rollover-year RMD cash into the per-year non-SS income
    // (spendable + taxable via the kernel's `otherIncome`) so the MC path sees
    // the same ordinary income the deterministic engine taxes + spends.
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
    // ACA opt-out: surface the canonical set top-level (mirrors the value
    // inside `taxContext`) so the `mcCacheKey` changes for an opt-out scenario.
    // Already sorted+deduped + omitted-when-empty by `canonicalOptOutSet`, so a
    // no-opt-out scenario's serialized input is unchanged.
    ...(taxContext?.acaMarketplaceOptOutMemberIds !== undefined
      ? { acaMarketplaceOptOutMemberIds: taxContext.acaMarketplaceOptOutMemberIds }
      : {}),
    ...(mcRmdContext !== undefined ? { mcRmdContext } : {}),
    // QCD: the SERIALIZABLE per-path QCD context. Omitted when no
    // QCD resolved so a no-QCD scenario's serialized input + `mcCacheKey` are
    // unchanged. Present → every path runs the QCD forced-outflow pass.
    ...(qcdContext !== undefined ? { qcdContext } : {}),
    // Inflation-tracked income subset for per-path CPI scaling.
    ...(strategyOpts?.tracksInflationIncomeByYear !== undefined
      ? { tracksInflationIncomeByYear: strategyOpts.tracksInflationIncomeByYear }
      : {}),
    // Per-path engine switch + custom-order tier payload. strategyKind is
    // required on `MonteCarloInput`; default to `taxEfficient` when no strategy
    // opts are supplied (every production caller passes them).
    strategyKind: strategyOpts?.strategyKind ?? 'taxEfficient',
    ...(strategyOpts?.customTiers !== undefined
      ? { customTiers: strategyOpts.customTiers }
      : {}),
    ...(strategyOpts?.excludedIndices !== undefined
      ? { excludedIndices: strategyOpts.excludedIndices }
      : {}),
    // The SERIALIZABLE MAGI-ceiling cap
    // window schedule rides the strategy payload. The engine rebuilds one
    // closure-bearing runtime config per window.
    ...(strategyOpts?.magiCapOverride !== undefined
      ? {
          magiCapOverride: strategyOpts.magiCapOverride,
          ...(strategyOpts.magiCapWindowBounds !== undefined
            ? { magiCapWindowBounds: strategyOpts.magiCapWindowBounds }
            : {}),
        }
      : {}),
    // Downturn guardrail: thread the resolved config +
    // baseline REAL per-drawdown-year net-need / essential / total series +
    // effective-tax proxy so the named-strategy MC path fires the funded-ratio
    // spending rule. Omitted entirely when no scenario enabled it (bundle block
    // absent) so a no-guardrail scenario's serialized input + `mcCacheKey` is
    // unchanged; `enabled` is a plain boolean in the config
    // so the cache key hashes it distinctly.
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

/** Translate the resolved scenario's withdrawal strategy into the
 *  `McStrategyOpts` the MC engine consumes. Every named strategy routes through
 *  the strategy-aware per-path engine. `customOrder` pre-builds the
 *  tier/excluded state-index payload via `buildCustomTierIndices` so the MC
 *  tiers match the deterministic per-account engine bit-for-bit. */
function buildMcStrategyOpts(
  strategy: { kind: NonNullable<MonteCarloInput['strategyKind']> },
  customDrawdownOrder: { tiers: string[][]; excludedAccountIds: string[] } | undefined,
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
): Pick<McStrategyOpts, 'strategyKind' | 'customTiers' | 'excludedIndices'> {
  if (strategy.kind !== 'customOrder') {
    return { strategyKind: strategy.kind };
  }
  // Guard: MC and deterministic paths must agree — a `customOrder` strategy with
  // no resolved order would silently fall through to empty tiers here, so throw
  // the same error the deterministic per-account engine raises.
  if (!customDrawdownOrder) {
    throw new MissingCustomDrawdownOrderError();
  }
  // buildCustomTierIndices reads only `id` off each account; build minimal rows.
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
 * Per-scenario optimizer MC setup. Builds the candidate-INVARIANT
 * `MonteCarloInput` once — running the full BPP pipeline
 * (`buildPipelineContext` → `buildCashflowSeries` → `assembleMcBundle` →
 * `mcInputFromBundle`) a single time per scenario — and exposes a cheap
 * `mcInputForCandidate` that swaps only the candidate-sensitive `ssByYear`
 * slice (recomputed via the same shared SS projection helpers).
 *
 * Claim age is the ONLY optimizer candidate input that flows into the SS
 * overlay, and `ssByYear` is the only MC-input field it touches — so this
 * is bit-for-bit equivalent to calling `runBalanceProjectionMc` once per
 * candidate, at a fraction of the cost (the invariant accounts / expenses /
 * income / tax-context assembly happens once, not 81× for a couple grid).
 *
 * Throws `NoPrimaryRetirementError` / `CbpUnconfiguredError` exactly as
 * `runBalanceProjectionMc` does, so the optimizer's existing per-scenario
 * terminal-outcome handling is unchanged.
 */
export interface OptimizerMcScenarioSetup {
  /** Builds a candidate's `MonteCarloInput` by swapping only `ssByYear`.
   *  `successOnly` is forwarded so the worker skips `runPlannedOverlay`. */
  readonly mcInputForCandidate: (
    overlay: CandidateOverlay,
    opts?: { readonly successOnly?: boolean },
  ) => MonteCarloInput;
}

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
        // The candidate's survivor overlay (the VERBATIM stored age —
        // the dimension never transforms one) must reach MC too —
        // absent → the stored survivor section applies, matching
        // `withCandidateOverlay`.
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
