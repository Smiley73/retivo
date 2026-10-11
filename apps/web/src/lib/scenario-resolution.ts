/**
 * Scenario resolution helpers.
 *
 * Each scenario stores only the fields it explicitly overrides; reading
 * the resolved view walks the parent chain back to the primary and
 * keeps the first ancestor's value per section.
 */
import type {
  AccountPayload,
  Aggregate,
  DownturnGuardrailsOverride,
  HouseholdMemberPayload,
  QcdEntry,
  ScenarioOverrides,
  ScenarioPayload,
} from '../db/types';
import {
  DANGEROUS_CATEGORY_RATE_KEYS,
  DEFAULT_DOWNTURN_GUARDRAILS,
  DEFAULT_INFLATION_PCT,
  DEFAULT_MEDICAL_INFLATION_SPREAD_PCT,
} from '../db/types';
import { isGuardrailConfigValid } from './guardrails';
import { DEFAULT_EXPENSE_CATEGORY_IDS } from './expense-categories-bootstrap';
import { isValidContributionGrowthPct } from './contribution-growth';
import { isValidWorkingYearsRothConversionPair } from './roth-conversion-eligibility';
import { qcdFirstEligibleTaxYear } from './qcd';

export type ScenarioAggregate = Aggregate<ScenarioPayload>;

/**
 * Walk `scenarioId`'s parent chain to the primary, merging `overrides`
 * per section. For each section the *first* ancestor with a defined
 * value wins (the scenario itself counts as the first ancestor).
 * Sections no ancestor defines are absent from the result.
 *
 * Throws on an unknown scenario id; warns + bails on a cycle in the
 * stored data (corrupt state — caller should never see it post-
 * reconciliation, but resolve must never infinite-loop).
 */
export function resolveScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
): ScenarioOverrides {
  const byId = buildIndex(allScenarios);
  const start = byId.get(scenarioId);
  if (!start) {
    throw new Error(`resolveScenario: unknown scenario id ${scenarioId}`);
  }

  const merged: ScenarioOverrides = {};
  const seen = new Set<string>();
  let current: ScenarioAggregate | undefined = start;
  while (current) {
    if (seen.has(current.id)) {
      console.warn('[scenarios] cycle detected while resolving', { scenarioId });
      break;
    }
    seen.add(current.id);
    mergeFirstWins(merged, current.payload.overrides);
    if (current.payload.parentScenarioId === null) break;
    current = byId.get(current.payload.parentScenarioId);
  }
  return merged;
}

/**
 * Returns a copy of `payload` with the named section key removed from
 * `overrides`. Used by per-section "Reset to inherited" actions. Safe
 * to call on a payload that doesn't currently override the section.
 */
export function resetField(
  payload: ScenarioPayload,
  sectionKey: keyof ScenarioOverrides,
): ScenarioPayload {
  const next: ScenarioOverrides = { ...payload.overrides };
  delete next[sectionKey];
  return { ...payload, overrides: next };
}

/**
 * Returns a copy of `payload` with `overrides` cleared entirely.
 * Used by the scenario-level "Reset all overrides" action. Notes is
 * untouched — only `overrides` clears.
 */
export function resetAllOverrides(payload: ScenarioPayload): ScenarioPayload {
  return { ...payload, overrides: {} };
}

/**
 * True iff setting `candidateParentId` as the parent of `scenarioId`
 * would form a cycle. The check walks up from `candidateParentId` via
 * stored `parentScenarioId` pointers; if it reaches `scenarioId`
 * before hitting `null`, a cycle would form.
 *
 * `candidateParentId === scenarioId` is treated as a cycle (a self-loop).
 * A pre-existing cycle in the stored data short-circuits to `false` —
 * we report only cycles this change would *introduce*.
 */
export function wouldCreateCycle(
  scenarioId: string,
  candidateParentId: string,
  allScenarios: ScenarioAggregate[],
): boolean {
  if (candidateParentId === scenarioId) return true;
  const byId = buildIndex(allScenarios);

  const seen = new Set<string>();
  let cursor: string | null = candidateParentId;
  while (cursor !== null) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    if (cursor === scenarioId) return true;
    const node = byId.get(cursor);
    if (!node) return false;
    cursor = node.payload.parentScenarioId;
  }
  return false;
}

/**
 * Returns every scenario that is `scenarioId` or transitively descends
 * from it. Used by the parent-picker to exclude self + descendants
 * from the dropdown (UI-side mirror of `wouldCreateCycle`).
 */
export function descendantIds(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
): Set<string> {
  const childrenByParent = new Map<string, ScenarioAggregate[]>();
  for (const s of allScenarios) {
    const parent = s.payload.parentScenarioId;
    if (parent === null) continue;
    const list = childrenByParent.get(parent) ?? [];
    list.push(s);
    childrenByParent.set(parent, list);
  }

  const out = new Set<string>([scenarioId]);
  const queue: string[] = [scenarioId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const children = childrenByParent.get(id) ?? [];
    for (const child of children) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

function buildIndex(
  allScenarios: ScenarioAggregate[],
): Map<string, ScenarioAggregate> {
  const out = new Map<string, ScenarioAggregate>();
  for (const s of allScenarios) out.set(s.id, s);
  return out;
}

/**
 * Per-account effective contribution amounts for `scenarioId`.
 *
 * Unlike the generic `resolveScenario` (which is section-level —
 * the first ancestor whose `accountContributions` is defined wins
 * outright), this resolver walks the chain per-accountId and per-field
 * so a child scenario that overrides one account does not blow away
 * the parent's overrides on other accounts.
 *
 * Returned values:
 * - When a scenario in the chain defines an entry for `accountId`,
 *   each side (preTax / postTax) resolves to the first ancestor's
 *   value that defines that side. Sides the chain never defines fall
 *   through to the account's own baseline.
 * - When no scenario in the chain defines an entry for `accountId`,
 *   the map's value uses the account's own baseline for both sides.
 *
 * Every account in `allAccounts` always has an entry in the returned
 * map. Callers can read `result.get(accountId)` without an undefined
 * check.
 */
export function resolveAccountContributionsForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): Map<string, { plannedContributionPreTax: number; plannedContributionPostTax: number }> {
  const out = new Map<
    string,
    { plannedContributionPreTax: number; plannedContributionPostTax: number }
  >();
  const chain = scenarioChain(scenarioId, allScenarios);
  for (const acct of allAccounts) {
    let preTax: number | undefined;
    let postTax: number | undefined;
    for (const sc of chain) {
      const entry = sc.payload.overrides.accountContributions?.perAccount?.[acct.id];
      if (!entry) continue;
      if (preTax === undefined && entry.plannedContributionPreTax !== undefined) {
        preTax = entry.plannedContributionPreTax;
      }
      if (postTax === undefined && entry.plannedContributionPostTax !== undefined) {
        postTax = entry.plannedContributionPostTax;
      }
      if (preTax !== undefined && postTax !== undefined) break;
    }
    out.set(acct.id, {
      plannedContributionPreTax: preTax ?? acct.payload.plannedContributionPreTax,
      plannedContributionPostTax: postTax ?? acct.payload.plannedContributionPostTax,
    });
  }
  return out;
}

/**
 * Per-account effective planning return rate for `scenarioId`.
 *
 * Same per-account first-ancestor-wins semantics as
 * `resolveAccountContributionsForScenario`. Accounts whose chain never
 * sets `planningReturnPct` fall through to `Account.payload.planningReturnPct`.
 *
 * Affects only the **Planned** projection method on the Balance
 * Projection page. The TWR method is empirical (computed
 * from each account's own balance history) and never reads this map.
 */
export function resolveAccountReturnsForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const chain = scenarioChain(scenarioId, allScenarios);
  for (const acct of allAccounts) {
    let rate: number | undefined;
    for (const sc of chain) {
      const entry = sc.payload.overrides.accountReturns?.perAccount?.[acct.id];
      if (!entry) continue;
      if (entry.planningReturnPct !== undefined) {
        rate = entry.planningReturnPct;
        break;
      }
    }
    out.set(acct.id, rate ?? acct.payload.planningReturnPct);
  }
  return out;
}

/** Resolved per-account contribution-growth mode + effective rate.
 *
 *  - `mode === 'tracks-inflation'`: the account carries no explicit rate
 *    anywhere in the chain → its planned contribution grows at the
 *    resolved scenario general inflation rate (`ratePct` here = that
 *    inflation rate). The deterministic engine uses this rate directly;
 *    the Monte Carlo engine instead scales the today's-dollars base by
 *    each path's own cumulative CPI (so the rate is informational for MC).
 *  - `mode === 'fixed'`: an explicit `contributionGrowthPct` resolved (an
 *    override or baseline value, incl. `0`) → fixed-nominal growth at
 *    `ratePct` in both engines.
 *
 *  `ratePct` is always finite (sanitised). */
export interface ResolvedContributionGrowth {
  mode: 'tracks-inflation' | 'fixed';
  ratePct: number;
}

/**
 * Per-account effective contribution-growth rate + mode for `scenarioId`.
 *
 * Same per-account first-ancestor-wins semantics as
 * `resolveAccountReturnsForScenario`, resolved independently of the
 * contribution AMOUNT (override → baseline → absent) so overriding the
 * amount never clobbers an ancestor's growth rate, and vice-versa. The
 * chain reads `overrides.accountContributions.perAccount[id].contributionGrowthPct`
 * first, then the account's own `contributionGrowthPct` baseline.
 *
 * Sanitisation: a non-finite / out-of-band resolved value (corrupt
 * import — the field is an identically-sourced sibling of
 * `inflation.categoryRates`) is rejected and the account falls back to the
 * tracks-inflation default. `contributionGrowthPct === 0` is preserved as
 * an explicit `fixed` (flat-nominal) mode, distinct from absent.
 *
 * The tracks-inflation default's `ratePct` is the scenario's resolved
 * GENERAL inflation rate (`resolveInflationForScenario(...).ratePct`),
 * NOT a per-category rate — contributions track general inflation.
 *
 * Every account in `allAccounts` always has an entry in the returned map.
 */
export function resolveContributionGrowth(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): Map<string, ResolvedContributionGrowth> {
  const out = new Map<string, ResolvedContributionGrowth>();
  const chain = scenarioChain(scenarioId, allScenarios);
  const inflationRatePct = resolveInflationForScenario(
    scenarioId,
    allScenarios,
  ).ratePct;
  for (const acct of allAccounts) {
    let resolved: number | undefined;
    let found = false;
    // First-ancestor-wins over the scenario override entries.
    for (const sc of chain) {
      const entry =
        sc.payload.overrides.accountContributions?.perAccount?.[acct.id];
      if (!entry) continue;
      if (entry.contributionGrowthPct !== undefined) {
        resolved = entry.contributionGrowthPct;
        found = true;
        break;
      }
    }
    // Fall through to the account's own baseline.
    if (!found && acct.payload.contributionGrowthPct !== undefined) {
      resolved = acct.payload.contributionGrowthPct;
      found = true;
    }
    // Sanitise: a non-finite / out-of-band value degrades to the
    // tracks-inflation default. An absent value is tracks-inflation too.
    if (found && isValidContributionGrowthPct(resolved)) {
      out.set(acct.id, { mode: 'fixed', ratePct: resolved as number });
    } else {
      out.set(acct.id, {
        mode: 'tracks-inflation',
        ratePct: inflationRatePct,
      });
    }
  }
  return out;
}

/** One validated working-years Roth-conversion entry. `start`/`end`
 *  carry the same `age`/`year` anchor shapes as the stored entry; the engine
 *  consumes them to bound each entry's window. */
interface ResolvedRothConversion {
  readonly sourceAccountId: string;
  readonly targetRothAccountId: string;
  /** Sanitised annual amount in whole dollars — finite, clamped ≥ 0. */
  readonly annualAmountDollars: number;
  readonly start: NonNullable<ScenarioOverrides['preRetirementRothConversions']>[number]['start'];
  readonly end: NonNullable<ScenarioOverrides['preRetirementRothConversions']>[number]['end'];
}

/** Resolved + hardened working-years Roth-conversion config (deterministic
 *  only). All account-id-keyed validation happens against the household account
 *  set; malformed / orphan / cross-household / wrong-type entries are DROPPED
 *  (no-op, never error). */
export interface ResolvedPreRetirementRothConversions {
  /** Validated entries (stored order preserved; same-source/same-year ordering
   *  is the array order). Empty when nothing resolves. */
  readonly conversions: ReadonlyArray<ResolvedRothConversion>;
  /** Assumed marginal tax rate (percent) for the DISPLAYED burden only.
   * Clamped to `[0, 100]`; absent / non-finite → 0. */
  readonly taxRatePct: number;
}

/**
 * Resolve + HARDEN the working-years Roth conversions for `scenarioId`.
 * Section-level first-ancestor-wins on the three keys
 * (`preRetirementRothConversions`, `preRetirementRothConversionTaxRatePct`)
 * via the shared `resolveScenario` merge, then defensive sanitisation against
 * the household account set:
 *
 *  - amount: reject non-finite; clamp `annualAmountDollars` ≥ 0.
 *  - rate: clamp `[0, 100]`; non-finite → 0.
 *  - drop an entry whose `sourceAccountId` or `targetRothAccountId` is not in
 *    the household account set, or whose (source, target) pair fails
 *    `isValidWorkingYearsRothConversionPair` — this is the pair-aware §408A
 *    guard: source must be active PRE_TAX or MIXED (non-CBP), target must be
 *    an active NON-INHERITED Roth IRA OR the same-account MIXED in-plan case, and
 *    both accounts must share the same owner (IRC §408A is per-individual).
 *
 * The account lookup is a prototype-safe `Map` (CWE-1321). Entries are never
 * mutated in place; a fresh sanitised array is returned. Import-bundle data is
 * the threat surface — this resolver is the sole engine-side guard.
 */
export function resolvePreRetirementRothConversions(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): ResolvedPreRetirementRothConversions {
  const resolved = resolveScenario(scenarioId, allScenarios);
  const rawRate = resolved.preRetirementRothConversionTaxRatePct;
  const taxRatePct =
    typeof rawRate === 'number' && Number.isFinite(rawRate)
      ? Math.min(100, Math.max(0, rawRate))
      : 0;
  const entries = resolved.preRetirementRothConversions ?? [];
  if (entries.length === 0) {
    return { conversions: [], taxRatePct };
  }
  // Prototype-safe Map (CWE-1321) — id lookup only.
  const accountById = new Map<string, AccountPayload>();
  for (const a of allAccounts) accountById.set(a.id, a.payload);
  const conversions: ResolvedRothConversion[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const amount = e.annualAmountDollars;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    const sourcePayload = accountById.get(e.sourceAccountId);
    const targetPayload = accountById.get(e.targetRothAccountId);
    if (!sourcePayload || !targetPayload) continue; // dangling / cross-household id
    // Pair-aware guard: replaces the previous two independent type checks.
    // Drops cross-owner pairs, CBP sources, wrong-type targets, inactive accounts,
    // inherited-Roth-IRA targets, and dedicated-Roth employer-plan cross-account
    // targets.
    const sourceRec = { id: e.sourceAccountId, payload: sourcePayload };
    const targetRec = { id: e.targetRothAccountId, payload: targetPayload };
    if (!isValidWorkingYearsRothConversionPair(sourceRec, targetRec)) continue;
    conversions.push({
      sourceAccountId: e.sourceAccountId,
      targetRothAccountId: e.targetRothAccountId,
      annualAmountDollars: Math.max(0, amount),
      start: e.start,
      end: e.end,
    });
  }
  return { conversions, taxRatePct };
}

/**
 * Resolve the downturn-guardrail config for `scenarioId`, walking the parent
 * chain first-ancestor-wins (mirrors `resolveInflationForScenario` /
 * `resolveScenario` section-level inheritance): the first ancestor whose
 * `downturnGuardrails` is defined wins the whole section, so a child that sets
 * guardrails replaces the parent's config outright.
 *
 * Returns `undefined` when NO scenario in the chain sets the section — the
 * caller treats that as "no guardrail" (disabled), byte-identical to the
 * pre-feature engine. A resolved-but-INVALID config (inverted bands /
 * out-of-range, which the editor blocks but a corrupt import bundle could carry)
 * is DEFENSIVELY coerced to disabled (`enabled: false`) with the default bands,
 * so a bad payload can never drive the engine with a NaN/inverted rule (import-bundle hardening).
 */
export function resolveDownturnGuardrailsForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
): DownturnGuardrailsOverride | undefined {
  const resolved = resolveScenario(scenarioId, allScenarios);
  const cfg = resolved.downturnGuardrails;
  // Defensive against malformed import bundles: the static type
  // promises an object, but a corrupt/hostile bundle can carry `null` or a
  // primitive (the merge only skips `undefined`, and no per-payload zod runs on
  // `overrides`). `isGuardrailConfigValid` destructures its argument, so a
  // non-object would throw a TypeError and crash projection compute — narrow
  // here first (mirrors `resolveQcdForScenario`'s never-throw guard).
  if (cfg === undefined || cfg === null || typeof cfg !== 'object') return undefined;
  // Defensive: a corrupt import bundle could carry an inverted / non-finite
  // config the editor would have rejected. Coerce to a safe disabled default
  // rather than feeding an invalid rule into the engine.
  if (!isGuardrailConfigValid(cfg)) {
    return { ...DEFAULT_DOWNTURN_GUARDRAILS };
  }
  return {
    enabled: cfg.enabled === true,
    lowerBandPct: cfg.lowerBandPct,
    upperBandPct: cfg.upperBandPct,
    stepPct: cfg.stepPct,
    maxRaisePct: cfg.maxRaisePct,
    // Discretionary floor: MATERIALIZE the product default (50 — keep half
    // of discretionary) when the config omits the field, so an enabled guardrail
    // ALWAYS resolves to an explicit floor and the editor card, the report
    // summary, the engine, and the `mcCacheKey` all agree. An enabled scenario
    // that never set the field therefore defaults to keep-50% —
    // the resolver is the single source of truth for the default, not each
    // consumer. `isGuardrailConfigValid` above already rejected a present
    // out-of-range value (coercing the whole config to a safe disabled default),
    // so a present value here is finite and within [0, 100].
    discretionaryFloorPct: cfg.discretionaryFloorPct ?? 50,
  };
}

/** One validated QCD entry as the engine consumes it. `start`/`end`
 *  carry the same `age` / `year` anchor shapes as the stored entry, with `start`
 *  already clamped up to the member's 70½ first-eligible tax year. */
export interface ResolvedQcdEntry {
  readonly memberId: string;
  readonly sourceAccountId: string;
  /** Sanitised annual amount in whole dollars — finite, clamped ≥ 0. */
  readonly annualAmountDollars: number;
  readonly start: QcdEntry['start'];
  readonly end: QcdEntry['end'];
  /** Resolved first ACTIVE tax year (inclusive), already clamped up to the 70½
   *  first-eligible year. The engine consumes whole tax years. */
  readonly startYear: number;
  /** Resolved EXCLUSIVE end tax year — the window is active THROUGH `endYear − 1`
   *  (a `year` end resolves to `year + 1`; a single-year gift has
   *  `startYear === endYear − 1`). Matches `resolveEndMonth`'s convention. */
  readonly endYear: number;
}

/** Resolved + hardened QCD config for a scenario. Malformed / orphan /
 *  cross-owner / non-PRE_TAX-IRA / invalid-window entries are DROPPED (no-op,
 *  never error). */
export interface ResolvedQcd {
  /** Validated entries (stored order preserved). Empty when nothing resolves. */
  readonly entries: ReadonlyArray<ResolvedQcdEntry>;
}

/** Resolve a QCD `age` / `year` anchor to a whole tax year for window math,
 *  matching the canonical schedule-resolution convention.
 *  - `year` START → inclusive at `year`; `year` END → EXCLUSIVE at `year + 1`
 *    (resolveEndMonth), so the window is active THROUGH end.year and a single-year
 *    gift `{start:Y, end:Y}` is a valid one-year window, not an empty span.
 *  - `age` START and END → identical month-precise resolution (owner birth month +
 *    `years*12 + months`) collapsed to the tax year, matching resolveStartMonth /
 *    resolveEndMonth (the age end carries NO +1; resolveEndMonth's age case equals
 *    resolveStartMonth's) — NOT a plain `birthYear + years` (which would drop
 *    months and the birth month).
 *  Returns `undefined` for an `age` anchor with no owner birth year/month and for
 *  null / non-object / unknown-kind / non-finite anchors (the resolver drops the
 *  entry — never throws). */
function qcdAnchorTaxYear(
  anchor: QcdEntry['start'] | QcdEntry['end'],
  boundary: 'start' | 'end',
  birthYear: number | undefined,
  birthMonth0: number | undefined,
): number | undefined {
  // Defensive against malformed import bundles: the static type
  // promises a valid union, but a hostile/corrupt entry can carry `null`,
  // `undefined`, or a garbage `kind`. Narrow via `unknown` so a bad anchor
  // returns undefined (drops the entry) instead of throwing — honouring the
  // resolver's never-throw contract.
  const a = anchor as unknown as
    | { kind?: unknown; year?: unknown; years?: unknown; months?: unknown }
    | null
    | undefined;
  if (!a || typeof a !== 'object') return undefined;
  if (a.kind === 'year') {
    if (typeof a.year !== 'number' || !Number.isFinite(a.year)) return undefined;
    // `year` END is the EXCLUSIVE boundary (year+1), matching resolveEndMonth.
    return boundary === 'end' ? a.year + 1 : a.year;
  }
  if (a.kind === 'age') {
    if (birthYear === undefined || birthMonth0 === undefined) return undefined;
    if (typeof a.years !== 'number' || !Number.isFinite(a.years)) return undefined;
    const months =
      typeof a.months === 'number' && Number.isFinite(a.months) ? a.months : 0;
    // Canonical: month-precise resolution collapsed to the calendar tax year.
    const idx = birthYear * 12 + birthMonth0 + (a.years * 12 + months);
    return Math.floor(idx / 12);
  }
  return undefined; // unknown / garbage kind
}

/**
 * Resolve + HARDEN the Qualified Charitable Distributions for `scenarioId`.
 * Section-level first-ancestor-wins on `qualifiedCharitableDistributions`
 * via the shared `resolveScenario` merge, then defensive sanitisation against the
 * household account + member sets (import bundles are the threat surface;
 * this resolver is the sole engine-side guard):
 *
 *  - amount: reject non-finite; clamp `annualAmountDollars` ≥ 0.
 *  - drop an entry whose `sourceAccountId` is not in the household account set.
 *  - drop unless the source is a `RETIREMENT_IRA` with `PRE_TAX` treatment owned
 *    by `memberId` (equality check `ownerId === memberId`, never truthiness).
 *  - drop a `memberId` that owns no household account (dangling member).
 *  - resolve the window to whole tax years (`age` anchors resolve month-precise
 *    from the owner's birth month — `years*12 + months` — then collapse to the
 *    tax year, matching `schedule-resolution.resolveStartMonth`). The END anchor
 *    resolves to the EXCLUSIVE boundary, matching `resolveEndMonth`: a `year` end
 *    is active THROUGH that calendar year (resolved internally as year+1), so a
 *    single-year gift `{start:Y, end:Y}` is a valid one-year window. Drop an entry
 *    whose resolved start is not strictly before its (exclusive) end.
 *  - clamp the resolved `start` up to the member's 70½ first-eligible tax year;
 * a clamped `year` start is rewritten to that floor year, an `age` start
 *    likewise advanced — the engine never sees a pre-70½ QCD year.
 *
 * The account lookup is a prototype-safe `Map` (CWE-1321). Entries are never
 * mutated in place; a fresh sanitised array is returned.
 */
export function resolveQcdForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  allMembers: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): ResolvedQcd {
  const resolved = resolveScenario(scenarioId, allScenarios);
  // Array.isArray guard: a corrupt import bundle could make this a
  // non-array value (object, string); `.length` / `for...of` on a non-iterable
  // would throw, breaking the never-throw contract. Coerce to an empty array.
  const rawEntries = resolved.qualifiedCharitableDistributions;
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  if (entries.length === 0) return { entries: [] };

  // Prototype-safe Maps (CWE-1321) — id lookup only.
  const accountById = new Map<string, AccountPayload>();
  for (const a of allAccounts) accountById.set(a.id, a.payload);
  const memberBirthdateById = new Map<string, string>();
  for (const m of allMembers) memberBirthdateById.set(m.id, m.payload.birthdate);
  // The QCD member id is the account `ownerId`; the household member set the
  // engine validates against is the set of distinct owners across accounts.
  const ownerMemberIds = new Set<string>();
  for (const a of allAccounts) ownerMemberIds.add(a.payload.ownerId);

  const out: ResolvedQcdEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const amount = e.annualAmountDollars;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    if (!ownerMemberIds.has(e.memberId)) continue; // dangling member
    const sourcePayload = accountById.get(e.sourceAccountId);
    if (!sourcePayload) continue; // dangling / cross-household source id
    // Source must be a traditional IRA (PRE_TAX) owned by THIS member —
    // equality, never truthiness.
    if (sourcePayload.type !== 'RETIREMENT_IRA') continue;
    if (sourcePayload.taxTreatment !== 'PRE_TAX') continue;
    if (sourcePayload.ownerId !== e.memberId) continue;

    // Resolve the window to whole tax years. An `age` anchor needs the owner's
    // birth year + month; a member with a malformed / missing birthdate drops
    // the entry.
    const birthdate = memberBirthdateById.get(e.memberId);
    const birthMatch = birthdate ? /^(\d{4})-(\d{2})-\d{2}$/.exec(birthdate) : null;
    const birthYear = birthMatch ? Number(birthMatch[1]) : undefined;
    const birthMonth0 = birthMatch ? Number(birthMatch[2]) - 1 : undefined;
    const startYear = qcdAnchorTaxYear(e.start, 'start', birthYear, birthMonth0);
    const endYear = qcdAnchorTaxYear(e.end, 'end', birthYear, birthMonth0);
    if (startYear === undefined || endYear === undefined) continue;

    // Clamp the start up to the 70½ first-eligible tax year. A malformed
    // birthdate (no eligible year) drops the entry rather than guessing.
    let floorYear: number;
    try {
      floorYear = qcdFirstEligibleTaxYear(birthdate ?? '');
    } catch {
      continue;
    }
    const clampedStartYear = Math.max(startYear, floorYear);
    // The clamped window must still be non-empty (start strictly before end).
    if (clampedStartYear >= endYear) continue;
    // Rewrite the start to the clamped year (always a `year` anchor — the engine
    // consumes whole tax years and the floor is a calendar-year concept).
    const clampedStart: QcdEntry['start'] = { kind: 'year', year: clampedStartYear };

    out.push({
      memberId: e.memberId,
      sourceAccountId: e.sourceAccountId,
      annualAmountDollars: Math.max(0, amount),
      start: clampedStart,
      end: e.end,
      startYear: clampedStartYear,
      endYear,
    });
  }
  return { entries: out };
}

/**
 * Per-account effective asset mix for `scenarioId`. First-ancestor-wins
 * over `overrides.accountAssetMix.perAccount[accountId]`; falls through
 * to `Account.payload.assetMix` when no scenario in the chain overrides.
 *
 * Affects only the Monte Carlo projection.
 */
export function resolveAccountAssetMixForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): Map<string, AccountPayload['assetMix']> {
  const out = new Map<string, AccountPayload['assetMix']>();
  const chain = scenarioChain(scenarioId, allScenarios);
  for (const acct of allAccounts) {
    let mix: AccountPayload['assetMix'] | undefined;
    for (const sc of chain) {
      const entry = sc.payload.overrides.accountAssetMix?.perAccount?.[acct.id];
      if (entry) {
        mix = entry;
        break;
      }
    }
    out.set(acct.id, mix ?? acct.payload.assetMix);
  }
  return out;
}

/** A resolved per-account floor. `floorDollars` is a
 *  finite, `≥ 0` minimum balance; `hsaMode` is the sanitised HSA floor mode
 *  (`'emergencyOnly'` default | `'strict'`). Only accounts whose chain resolves
 *  a real floor (a finite, non-negative `floorDollars`) appear in the returned
 *  map — an absent entry means "no floor". */
export interface ResolvedAccountFloor {
  readonly floorDollars: number;
  readonly hsaMode: 'emergencyOnly' | 'strict';
}

/**
 * Per-account effective minimum-balance floor for `scenarioId`
 * Per-FIELD first-ancestor-wins — `floorDollars`
 * and `hsaMode` resolve independently down the parent chain (mirrors
 * `resolveContributionGrowth`), so a child overriding the dollar floor never
 * clobbers an ancestor's `hsaMode`, and vice-versa.
 *
 * Resolution + CWE-20 sanitisation at this boundary (the sole engine-side
 * consumer; import bundles are the threat surface):
 *  - `floorDollars`: first ancestor whose entry defines it wins; `null` clears
 *    the inherited value. The resolved value is kept ONLY when it is
 *    finite and `≥ 0`; a non-finite / negative value drops to "no floor".
 *  - `hsaMode`: first ancestor whose entry defines it wins; `null` clears.
 *    Any value not STRICTLY EQUAL to `'strict'` reads as `'emergencyOnly'`
 *    (CWE-20 strict-equality guard).
 *
 * The lookup keys are account ids; a prototype-safe `Map` is returned. ONLY
 * accounts that resolve a real floor (finite `floorDollars ≥ 0`) appear in the
 * map; floor-eligibility by `taxTreatment` is enforced separately at the engine
 * boundary, so this resolver does not type-gate (a stale/ineligible entry
 * resolves harmlessly and is ignored by the engine predicate).
 */
export function resolveAccountFloorsForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
): Map<string, ResolvedAccountFloor> {
  const out = new Map<string, ResolvedAccountFloor>();
  const chain = scenarioChain(scenarioId, allScenarios);
  for (const acct of allAccounts) {
    let floorDollars: number | null | undefined;
    let floorFound = false;
    let hsaMode: 'emergencyOnly' | 'strict' | null | undefined;
    let modeFound = false;
    // Per-FIELD first-ancestor-wins. `null` is a defined value (clears).
    for (const sc of chain) {
      const entry = sc.payload.overrides.accountFloors?.perAccount?.[acct.id];
      if (!entry) continue;
      if (!floorFound && 'floorDollars' in entry) {
        floorDollars = entry.floorDollars;
        floorFound = true;
      }
      if (!modeFound && 'hsaMode' in entry) {
        hsaMode = entry.hsaMode;
        modeFound = true;
      }
      if (floorFound && modeFound) break;
    }
    // CWE-20: keep the floor only when it is a finite, non-negative number.
    // `null` (clear), absent, non-finite, or negative → no floor (no entry).
    if (
      typeof floorDollars !== 'number' ||
      !Number.isFinite(floorDollars) ||
      floorDollars < 0
    ) {
      continue;
    }
    // CWE-20 strict-equality: only `'strict'` reads as strict; everything else
    // (including `null`, absent, a corrupt string) reads as `'emergencyOnly'`.
    out.set(acct.id, {
      floorDollars,
      hsaMode: hsaMode === 'strict' ? 'strict' : 'emergencyOnly',
    });
  }
  return out;
}

/** Result of {@link resolveInflationForScenario}. `ratePct` is the
 *  resolved general inflation rate (percent); `categoryRates` is a
 *  prototype-safe `Map` of per-category effective rate (percent) keyed by
 *  ExpenseCategory id — built only from sanitised finite, in-range entries,
 *  with the Medical default materialised. Engines read
 *  `categoryRates.get(catId) ?? ratePct` for a category's effective rate. */
export interface ResolvedInflation {
  ratePct: number;
  categoryRates: Map<string, number>;
}

/** Drop dangerous keys + non-finite / out-of-`[0,10]` values —
 *  `categoryRates` arrives from plaintext import bundles + corrupt local
 *  payloads, so the resolver hardens its own input. */
function isSafeCategoryRate(key: string, value: number): boolean {
  if (DANGEROUS_CATEGORY_RATE_KEYS.has(key)) return false;
  return Number.isFinite(value) && value >= 0 && value <= 10;
}

/**
 * Resolve the effective inflation for `scenarioId`: the general `ratePct`
 * plus a per-category effective-rate `Map`. Per-key first-ancestor-wins —
 * the general rate and each category rate resolve independently down the
 * parent chain (mirrors `resolveAccountReturnsForScenario`), so a child
 * overriding one category never clobbers the parent's general rate or its
 * other category rates.
 *
 * The returned `Map` is built skipping dangerous keys
 * (`__proto__`/`constructor`/`prototype`) and any value that is non-finite
 * or outside `[0, 10]` (avoids prototype-pollution + `NaN`/`Infinity`
 * propagation into the engine). After the chain merge, the medical default
 * is MATERIALISED for EVERY id in `medicalCategoryIds` the chain never set:
 * `map.has(id) || map.set(id, resolvedRate + spread)`. The set is the
 * flag-derived medical-id set — multiple categories may be medical,
 * and a recreated Medical category with a NEW id gets the +2pp default as
 * long as it carries the `isMedical` flag. The default is UNCAPPED — when
 * `resolvedRate > 8` it may exceed 10, distinct from the `[0, 10]`
 * clamp on explicit `categoryRates`. Materialising it unconditionally is
 * engine-harmless when no expense carries that id.
 *
 * `medicalCategoryIds` defaults to the seeded `cat-medical` id for
 * back-compat: the `.ratePct`-only callers + existing tests that don't supply
 * it keep today's single-Medical behaviour.
 */
export function resolveInflationForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  medicalCategoryIds: ReadonlySet<string> = new Set([
    DEFAULT_EXPENSE_CATEGORY_IDS.Medical,
  ]),
): ResolvedInflation {
  const chain = scenarioChain(scenarioId, allScenarios);
  let ratePct: number | undefined;
  const categoryRates = new Map<string, number>();
  for (const sc of chain) {
    const inflation = sc.payload.overrides.inflation;
    if (!inflation) continue;
    if (ratePct === undefined && typeof inflation.ratePct === 'number') {
      ratePct = inflation.ratePct;
    }
    const rates = inflation.categoryRates;
    if (rates) {
      for (const key of Object.keys(rates)) {
        if (categoryRates.has(key)) continue; // first-ancestor-wins per key
        const value = rates[key];
        if (typeof value !== 'number') continue;
        if (!isSafeCategoryRate(key, value)) continue;
        categoryRates.set(key, value);
      }
    }
  }
  const resolvedRate =
    ratePct !== undefined && Number.isFinite(ratePct)
      ? ratePct
      : DEFAULT_INFLATION_PCT;
  for (const medicalId of medicalCategoryIds) {
    // Defense-in-depth: never let a forbidden id reach the engine Map.
    if (DANGEROUS_CATEGORY_RATE_KEYS.has(medicalId)) continue;
    if (categoryRates.has(medicalId)) continue;
    // Uncapped: the effective domain is separate from the UI clamp.
    categoryRates.set(
      medicalId,
      resolvedRate + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT,
    );
  }
  return { ratePct: resolvedRate, categoryRates };
}

/**
 * Returns the scenarios from `scenarioId` walking parent pointers up
 * to the base. The first element is `scenarioId`'s scenario; the last
 * is the base. Throws on unknown id; warns + truncates on a cycle in
 * the stored data (corrupt state).
 *
 * Public so the per-account resolvers can share the same walk + cycle
 * semantics as `resolveScenario`. Most callers should use
 * `resolveScenario` (or one of the per-section resolvers) instead.
 */
export function scenarioChain(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
): ScenarioAggregate[] {
  const byId = buildIndex(allScenarios);
  const start = byId.get(scenarioId);
  if (!start) {
    throw new Error(`scenarioChain: unknown scenario id ${scenarioId}`);
  }
  const out: ScenarioAggregate[] = [];
  const seen = new Set<string>();
  let current: ScenarioAggregate | undefined = start;
  while (current) {
    if (seen.has(current.id)) {
      console.warn('[scenarios] cycle detected while walking chain', { scenarioId });
      break;
    }
    seen.add(current.id);
    out.push(current);
    if (current.payload.parentScenarioId === null) break;
    current = byId.get(current.payload.parentScenarioId);
  }
  return out;
}

function mergeFirstWins(target: ScenarioOverrides, source: ScenarioOverrides): void {
  for (const key of Object.keys(source) as (keyof ScenarioOverrides)[]) {
    if (target[key] !== undefined) continue;
    const value = source[key];
    if (value === undefined) continue;
    // Type-safe per-key assignment via the union shape requires either
    // a switch or a structural cast. Single cast keeps the helper
    // generic for future sections (socialSecurity, expenses, …) without
    // edits.
    (target as Record<string, unknown>)[key] = value;
  }
}
