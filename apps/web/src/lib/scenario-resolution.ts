/**
 * Scenario resolution: each scenario stores only the fields it overrides, and the resolved view walks the parent chain to the base, the first ancestor's value winning per section.
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
 * Merge `overrides` along `scenarioId`'s parent chain, the first ancestor with a defined value
 * winning per section (the scenario itself counts first). Throws on an unknown id; warns and bails
 * on a stored-data cycle rather than looping.
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

/** Copy of `payload` without the named `overrides` section ("Reset to inherited"). */
export function resetField(
  payload: ScenarioPayload,
  sectionKey: keyof ScenarioOverrides,
): ScenarioPayload {
  const next: ScenarioOverrides = { ...payload.overrides };
  delete next[sectionKey];
  return { ...payload, overrides: next };
}

/** Copy of `payload` with `overrides` cleared; notes are untouched. */
export function resetAllOverrides(payload: ScenarioPayload): ScenarioPayload {
  return { ...payload, overrides: {} };
}

/**
 * True iff making `candidateParentId` the parent of `scenarioId` would form a cycle, including a
 * self-loop. A cycle already in the stored data returns `false`: only cycles this change would
 * introduce are reported.
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
 * `scenarioId` plus every transitive descendant, for excluding them from the parent picker (UI
 * mirror of `wouldCreateCycle`).
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
 * Per-account effective contribution amounts. Unlike the section-level `resolveScenario`, this
 * walks the chain per account and per side (preTax / postTax), so a child overriding one account
 * keeps the parent's overrides on others; undefined sides fall to the account's baseline. Every
 * account has an entry.
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
 * Per-account effective planning return, first-ancestor-wins per account like the contributions
 * resolver, falling to `Account.payload.planningReturnPct`. Affects only the Planned method, never
 * TWR.
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

/**
 * Resolved contribution-growth mode: `tracks-inflation` (no explicit rate in the chain) grows at
 * the scenario's general inflation rate in the deterministic engine, while MC scales by each path's
 * cumulative CPI so its `ratePct` is informational there; `fixed` (an explicit
 * `contributionGrowthPct`, including `0`) grows at `ratePct` in both engines. `ratePct` is always
 * finite.
 */
export interface ResolvedContributionGrowth {
  mode: 'tracks-inflation' | 'fixed';
  ratePct: number;
}

/**
 * Per-account contribution-growth rate and mode, first-ancestor-wins and resolved independently of
 * the contribution amount (override → baseline → absent) so overriding one never clobbers the
 * other. A non-finite or out-of-band value (corrupt import) falls back to tracks-inflation at the
 * scenario's general inflation rate, not a per-category rate; `0` is preserved as an explicit
 * `fixed` mode. Every account has an entry.
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
    if (!found && acct.payload.contributionGrowthPct !== undefined) {
      resolved = acct.payload.contributionGrowthPct;
      found = true;
    }
    // A non-finite or out-of-band value degrades to tracks-inflation, as does an absent one.
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

interface ResolvedRothConversion {
  readonly sourceAccountId: string;
  readonly targetRothAccountId: string;
  readonly annualAmountDollars: number;
  readonly start: NonNullable<ScenarioOverrides['preRetirementRothConversions']>[number]['start'];
  readonly end: NonNullable<ScenarioOverrides['preRetirementRothConversions']>[number]['end'];
}

/**
 * Resolved working-years Roth-conversion config (deterministic only); malformed, orphan,
 * cross-household and wrong-type entries are dropped.
 */
export interface ResolvedPreRetirementRothConversions {
  /** Validated entries in stored order; empty when nothing resolves. */
  readonly conversions: ReadonlyArray<ResolvedRothConversion>;
  /**
   * Assumed marginal rate (percent) for the displayed burden only, clamped to [0, 100]; absent or
   * non-finite is 0.
   */
  readonly taxRatePct: number;
}

/**
 * Resolve the working-years Roth conversions: section-level first-ancestor-wins, then sanitise
 * (non-finite amounts rejected, amount clamped ≥ 0, rate clamped to [0, 100]). An entry is dropped
 * when an account is missing from the household or the pair fails
 * `isValidWorkingYearsRothConversionPair`, the §408A guard: an active PRE_TAX or MIXED non-CBP
 * source, an active non-inherited Roth IRA target (or the same-account MIXED in-plan case), and the
 * same owner. Import-bundle data is the threat surface; this is the sole engine-side guard.
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
  // Prototype-safe Map (CWE-1321): id lookup only.
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
 * Resolve the downturn-guardrail config, first-ancestor-wins on the whole section; `undefined`
 * means no guardrail. A present but invalid config (inverted or out-of-range bands, which only a
 * corrupt import can carry) is coerced to disabled with the default bands, so it can never drive
 * the engine with a NaN or inverted rule.
 */
export function resolveDownturnGuardrailsForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
): DownturnGuardrailsOverride | undefined {
  const resolved = resolveScenario(scenarioId, allScenarios);
  const cfg = resolved.downturnGuardrails;
  // A corrupt import can carry `null` or a primitive here (no per-payload zod runs on `overrides`),
  // and `isGuardrailConfigValid` would throw on it; narrow first.
  if (cfg === undefined || cfg === null || typeof cfg !== 'object') return undefined;
  if (!isGuardrailConfigValid(cfg)) {
    return { ...DEFAULT_DOWNTURN_GUARDRAILS };
  }
  return {
    enabled: cfg.enabled === true,
    lowerBandPct: cfg.lowerBandPct,
    upperBandPct: cfg.upperBandPct,
    stepPct: cfg.stepPct,
    maxRaisePct: cfg.maxRaisePct,
    // Materialize the product default (keep 50% of discretionary) here so the editor, report,
    // engine and `mcCacheKey` agree; `isGuardrailConfigValid` already rejected a present
    // out-of-range value.
    discretionaryFloorPct: cfg.discretionaryFloorPct ?? 50,
  };
}

/** One validated QCD entry; `start` is clamped up to the member's 70½ first-eligible tax year. */
export interface ResolvedQcdEntry {
  readonly memberId: string;
  readonly sourceAccountId: string;
  readonly annualAmountDollars: number;
  readonly start: QcdEntry['start'];
  readonly end: QcdEntry['end'];
  /** First active tax year (inclusive), clamped up to the 70½ first-eligible year. */
  readonly startYear: number;
  /**
   * Exclusive end tax year: the window is active through `endYear − 1`, matching `resolveEndMonth`.
   */
  readonly endYear: number;
}

/**
 * Resolved QCD config; malformed, orphan, cross-owner, non-PRE_TAX-IRA and invalid-window entries
 * are dropped.
 */
export interface ResolvedQcd {
  readonly entries: ReadonlyArray<ResolvedQcdEntry>;
}

// A `year` start is inclusive and a `year` end exclusive (year + 1, as `resolveEndMonth`), so a
// single-year gift `{start:Y, end:Y}` is valid. `age` anchors resolve month-precise from the
// owner's birth month, collapsed to the tax year; an unusable anchor returns `undefined` and the
// entry is dropped.
function qcdAnchorTaxYear(
  anchor: QcdEntry['start'] | QcdEntry['end'],
  boundary: 'start' | 'end',
  birthYear: number | undefined,
  birthMonth0: number | undefined,
): number | undefined {
  // A corrupt import entry can carry a null or garbage anchor; return undefined rather than throw.
  const a = anchor as unknown as
    | { kind?: unknown; year?: unknown; years?: unknown; months?: unknown }
    | null
    | undefined;
  if (!a || typeof a !== 'object') return undefined;
  if (a.kind === 'year') {
    if (typeof a.year !== 'number' || !Number.isFinite(a.year)) return undefined;
    return boundary === 'end' ? a.year + 1 : a.year;
  }
  if (a.kind === 'age') {
    if (birthYear === undefined || birthMonth0 === undefined) return undefined;
    if (typeof a.years !== 'number' || !Number.isFinite(a.years)) return undefined;
    const months =
      typeof a.months === 'number' && Number.isFinite(a.months) ? a.months : 0;
    const idx = birthYear * 12 + birthMonth0 + (a.years * 12 + months);
    return Math.floor(idx / 12);
  }
  return undefined; // unknown / garbage kind
}

/**
 * Resolve the Qualified Charitable Distributions: section-level first-ancestor-wins, then sanitise
 * against the household accounts and members (import bundles are the threat surface; this is the
 * sole engine-side guard). Drops non-finite amounts, sources that are missing or not a PRE_TAX
 * `RETIREMENT_IRA` owned by `memberId` (equality, never truthiness), dangling members, and windows
 * whose resolved start is not before the exclusive end. `start` is clamped up to the member's 70½
 * first-eligible tax year, so the engine never sees a pre-70½ year.
 */
export function resolveQcdForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  allAccounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  allMembers: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): ResolvedQcd {
  const resolved = resolveScenario(scenarioId, allScenarios);
  // A corrupt import can make this a non-array; coerce so iteration never throws.
  const rawEntries = resolved.qualifiedCharitableDistributions;
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  if (entries.length === 0) return { entries: [] };

  const accountById = new Map<string, AccountPayload>();
  for (const a of allAccounts) accountById.set(a.id, a.payload);
  const memberBirthdateById = new Map<string, string>();
  for (const m of allMembers) memberBirthdateById.set(m.id, m.payload.birthdate);
  // The QCD member id is the account `ownerId`, so the valid members are the distinct account
  // owners.
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
    if (sourcePayload.type !== 'RETIREMENT_IRA') continue;
    if (sourcePayload.taxTreatment !== 'PRE_TAX') continue;
    if (sourcePayload.ownerId !== e.memberId) continue;

    // An age anchor needs the owner's birth year and month; a malformed birthdate drops the entry.
    const birthdate = memberBirthdateById.get(e.memberId);
    const birthMatch = birthdate ? /^(\d{4})-(\d{2})-\d{2}$/.exec(birthdate) : null;
    const birthYear = birthMatch ? Number(birthMatch[1]) : undefined;
    const birthMonth0 = birthMatch ? Number(birthMatch[2]) - 1 : undefined;
    const startYear = qcdAnchorTaxYear(e.start, 'start', birthYear, birthMonth0);
    const endYear = qcdAnchorTaxYear(e.end, 'end', birthYear, birthMonth0);
    if (startYear === undefined || endYear === undefined) continue;

    // A malformed birthdate (no eligible year) drops the entry rather than guessing.
    let floorYear: number;
    try {
      floorYear = qcdFirstEligibleTaxYear(birthdate ?? '');
    } catch {
      continue;
    }
    const clampedStartYear = Math.max(startYear, floorYear);
    if (clampedStartYear >= endYear) continue;
    // Always a `year` anchor: the engine consumes whole tax years.
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
 * Per-account effective asset mix, first-ancestor-wins over `overrides.accountAssetMix.perAccount`;
 * affects only Monte Carlo.
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

/**
 * A resolved per-account floor: `floorDollars` is finite and ≥ 0; `hsaMode` defaults to
 * `'emergencyOnly'`. An account with no real floor is absent from the map.
 */
export interface ResolvedAccountFloor {
  readonly floorDollars: number;
  readonly hsaMode: 'emergencyOnly' | 'strict';
}

/**
 * Per-account minimum-balance floor, with `floorDollars` and `hsaMode` resolved independently
 * first-ancestor-wins (`null` clears) so overriding one never clobbers the other. Only a finite,
 * non-negative floor survives; floor eligibility by `taxTreatment` is enforced at the engine
 * boundary, so a stale entry resolves harmlessly.
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
    // `null` is a defined value (clears).
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
    // CWE-20: keep the floor only when finite and non-negative; null, absent, non-finite or
    // negative means no floor.
    if (
      typeof floorDollars !== 'number' ||
      !Number.isFinite(floorDollars) ||
      floorDollars < 0
    ) {
      continue;
    }
    // Only `'strict'` (strict equality) reads as strict; anything else, including a corrupt string,
    // is `'emergencyOnly'`.
    out.set(acct.id, {
      floorDollars,
      hsaMode: hsaMode === 'strict' ? 'strict' : 'emergencyOnly',
    });
  }
  return out;
}

/**
 * Result of {@link resolveInflationForScenario}: the general rate plus a per-category
 * effective-rate Map of sanitised, in-range entries with the Medical default materialised; engines
 * read `categoryRates.get(catId) ?? ratePct`.
 */
export interface ResolvedInflation {
  ratePct: number;
  categoryRates: Map<string, number>;
}

// `categoryRates` arrives from plaintext imports and corrupt payloads, so drop dangerous keys and
// non-finite or out-of-[0, 10] values.
function isSafeCategoryRate(key: string, value: number): boolean {
  if (DANGEROUS_CATEGORY_RATE_KEYS.has(key)) return false;
  return Number.isFinite(value) && value >= 0 && value <= 10;
}

/**
 * Resolve the general `ratePct` plus per-category effective rates, per-key first-ancestor-wins, so
 * a child overriding one category keeps the parent's general and other category rates. Dangerous
 * keys (`__proto__`, `constructor`, `prototype`) and non-finite or out-of-[0, 10] values are
 * skipped, avoiding prototype pollution and NaN/Infinity propagation. Every id in
 * `medicalCategoryIds` that the chain never set gets `resolvedRate + spread`, uncapped, so a
 * recreated Medical category with a new id still gets it. `medicalCategoryIds` defaults to the
 * seeded `cat-medical`.
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
    // Never let a forbidden id reach the engine Map.
    if (DANGEROUS_CATEGORY_RATE_KEYS.has(medicalId)) continue;
    if (categoryRates.has(medicalId)) continue;
    categoryRates.set(
      medicalId,
      resolvedRate + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT,
    );
  }
  return { ratePct: resolvedRate, categoryRates };
}

/**
 * The scenario's medical inflation rate (percent): the chain's resolved rate for
 * the seeded Medical category, else general + `DEFAULT_MEDICAL_INFLATION_SPREAD_PCT`.
 * Depends on the scenario chain alone, never the household's category list.
 */
export function resolveMedicalInflationPct(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
): number {
  const { ratePct, categoryRates } = resolveInflationForScenario(scenarioId, allScenarios);
  return (
    categoryRates.get(DEFAULT_EXPENSE_CATEGORY_IDS.Medical) ??
    ratePct + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT
  );
}

/**
 * Scenarios from `scenarioId` up to the base (the first element is `scenarioId`'s own); throws on
 * an unknown id, warns and truncates on a stored-data cycle. Shared by the per-account resolvers;
 * most callers should use `resolveScenario`.
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
    // A single cast keeps the helper generic across sections.
    (target as Record<string, unknown>)[key] = value;
  }
}
