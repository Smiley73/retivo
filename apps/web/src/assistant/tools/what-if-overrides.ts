/**
 * What `retivo_run_what_if` lets an agent change, and how a change is built: the allowlist of scenario
 * settings, the editors' bounds applied to each, the merge of a supplied section over what the base
 * scenario resolves to, and the echo of what changed from what. Pure: no React, no storage, nothing written.
 *
 * Every `ScenarioOverrides` key is classified in `WHAT_IF_CLASSIFICATION`, which fails to compile until a new
 * key is. The registry's input schema (`WHAT_IF_OVERRIDES` in the protocol package) is strict, so a setting
 * outside the allowlist never reaches here; this module holds the ranges, which are the scenario editors'
 * (`lib/scenario-input-bounds.ts`) and are enforced by rejecting, never by clamping.
 */
import type { WhatIfOverrides } from '@retirement/assistant-protocol';
import { DEFAULT_DISCRETIONARY_DURATION_YEARS, type RetirementAgePerMember, type ScenarioOverrides } from '../../db/types';
import { isGuardrailConfigValid } from '../../lib/guardrails';
import { ageOnDate, retirementDate } from '../../lib/retirement-date-math';
import {
  ADJUSTMENT_MAX,
  ADJUSTMENT_MIN,
  AGE_MONTHS_MAX,
  BENEFIT_REDUCTION_MAX,
  BENEFIT_REDUCTION_MIN,
  COLA_MAX,
  COLA_MIN,
  DURATION_MAX,
  DURATION_MIN,
  GUARDRAIL_DISCRETIONARY_FLOOR_MAX,
  GUARDRAIL_DISCRETIONARY_FLOOR_MIN,
  GUARDRAIL_LOWER_BAND_MAX,
  GUARDRAIL_LOWER_BAND_MIN,
  GUARDRAIL_MAX_RAISE_MAX,
  GUARDRAIL_MAX_RAISE_MIN,
  GUARDRAIL_STEP_MAX,
  GUARDRAIL_STEP_MIN,
  GUARDRAIL_UPPER_BAND_MAX,
  GUARDRAIL_UPPER_BAND_MIN,
  INFLATION_MAX,
  INFLATION_MIN,
  LIFE_MAX,
  LIFE_MIN,
  PLANNING_RETURN_MAX,
  PLANNING_RETURN_MIN,
  RETIREMENT_AGE_MAX,
  RETIREMENT_AGE_MIN,
  SS_CLAIM_MAX,
  SS_CLAIM_MIN,
} from '../../lib/scenario-input-bounds';
import { sectionContextFor } from './scenario-report';
import { SCENARIO_SECTION_COVERAGE, type SectionContext, type SectionReading } from './scenario-sections';
import { ToolArgsError, type ToolEnv } from './define';

/**
 * Whether an agent may change a setting in a what-if. Compile-enforced, like `SCENARIO_SECTION_COVERAGE`: a new
 * override key fails typecheck until it is classified here. An `allowed` entry ships with its bounds (below) and
 * a pass and a fail test. The expense, income, filing, MAGI, drawdown-order, health, Roth, QCD and per-account
 * contribution, asset-mix and floor sections stay `excluded`: they carry free text, ids or shapes whose
 * absence has its own meaning, and widening is a later decision.
 */
export const WHAT_IF_CLASSIFICATION = {
  retirementAge: 'allowed',
  socialSecurity: 'allowed',
  filingStatus: 'excluded',
  taxFilingPlan: 'excluded',
  contributions: 'allowed',
  lifeExpectancy: 'allowed',
  inflation: 'allowed',
  discretionarySpending: 'allowed',
  downturnGuardrails: 'allowed',
  expenses: 'excluded',
  income: 'excluded',
  withdrawalStrategy: 'allowed',
  customDrawdownOrder: 'excluded',
  magiCap: 'excluded',
  retirementAllocation: 'excluded',
  assumedCostBasisFractionOfTaxableWithdrawal: 'excluded',
  magiBootstrapLookbackMinus2: 'excluded',
  magiBootstrapLookbackMinus1: 'excluded',
  acaPtcBenchmark: 'excluded',
  accountContributions: 'excluded',
  accountReturns: 'allowed',
  accountAssetMix: 'excluded',
  accountFloors: 'excluded',
  hsaQualifiedMedicalExpensePct: 'excluded',
  earlyWithdrawalPenaltyExemptAccountIds: 'excluded',
  acaMarketplaceOptOutMemberIds: 'excluded',
  healthCoverageMonths: 'excluded',
  acaFplRegion: 'excluded',
  preRetirementRothConversions: 'excluded',
  preRetirementRothConversionTaxRatePct: 'excluded',
  preRetirementTaxableIncomeDollars: 'excluded',
  qualifiedCharitableDistributions: 'excluded',
} as const satisfies Record<keyof ScenarioOverrides, 'allowed' | 'excluded'>;

type AllowedSection = {
  [K in keyof typeof WHAT_IF_CLASSIFICATION]: (typeof WHAT_IF_CLASSIFICATION)[K] extends 'allowed' ? K : never;
}[keyof typeof WHAT_IF_CLASSIFICATION];

/** Where a previous value came from: a scenario in the base's chain, or something the engine (or the account) supplies when none does. */
type ValueSource = 'scenario' | 'default';

/** One value an agent set, with what it was before. `path` is relative to the overrides, for example `socialSecurity.primary.ageYears`. */
export interface EchoChange {
  section: AllowedSection;
  path: string;
  accountId?: string;
  previous: unknown;
  previousSource: ValueSource;
  /** Said when the previous value is not from a scenario: the default's basis. */
  basis?: string;
  new: unknown;
  changed: boolean;
  /** Set when the value follows from another one rather than being asked for. */
  derived?: string;
}

/** A value in a section the agent touched that stays as the base has it. */
export interface EchoKept {
  section: AllowedSection;
  path: string;
  accountId?: string;
  value: unknown;
  source: ValueSource;
  basis?: string;
}

export interface WhatIfBuild {
  /** The sections for the throwaway scenario: each supplied section merged over what the base resolves to. */
  overrides: ScenarioOverrides;
  changes: EchoChange[];
  kept: EchoKept[];
  /** Sentences for the result's assumptions. */
  notes: string[];
}

type Path = readonly string[];

interface Leaf {
  path: Path;
  accountId?: string;
  value: unknown;
}

interface Built<K extends AllowedSection> {
  /** The section as the throwaway scenario stores it. */
  section: NonNullable<ScenarioOverrides[K]>;
  /** The values the agent asked for, normalised (a missing month is 0). */
  asked: unknown;
  /** Values the agent did not ask for but that follow, each with its reason. */
  derived?: Array<{ path: Path; value: unknown; reason: string }>;
  notes?: string[];
}

interface HandlerContext {
  env: ToolEnv;
  section: SectionContext;
  /** The base scenario's raw merged settings (`resolveScenario`). */
  resolved: ScenarioOverrides;
}

type Handler<K extends AllowedSection> = (supplied: NonNullable<WhatIfOverrides[K]>, context: HandlerContext) => Built<K>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(value: unknown, path: Path): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: Path, value: unknown): Record<string, unknown> {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    Object.defineProperty(current, key, { value: next, enumerable: true, writable: true, configurable: true });
    current = next;
  }
  Object.defineProperty(current, path[path.length - 1]!, { value, enumerable: true, writable: true, configurable: true });
  return target;
}

/**
 * Every primitive in `value` with its path. A `perAccount` map yields one leaf per account, the account id carried
 * beside the path (`perAccount.planningReturnPct`) rather than inside it. Category rates and survivor claim ages
 * are not the agent's to change, so they are never listed.
 */
function leavesOf(value: unknown, path: Path = [], accountId?: string): Leaf[] {
  if (!isRecord(value)) return value === undefined ? [] : [{ path, value, ...(accountId !== undefined && { accountId }) }];
  const out: Leaf[] = [];
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'categoryRates' || key === 'survivor') continue;
    if (accountId === undefined && path.length === 1 && path[0] === 'perAccount') out.push(...leavesOf(inner, path, key));
    else out.push(...leavesOf(inner, [...path, key], accountId));
  }
  return out;
}

function leafKey(leaf: Leaf): string {
  return `${leaf.accountId ?? ''}|${leaf.path.join('.')}`;
}

// ---------- Range checks: the editors' bounds, rejected and never clamped ----------

function rejectRange(path: string, min: number, max: number, unit: string, value: number): never {
  throw new ToolArgsError(`overrides.${path} must be from ${min} to ${max}${unit}; ${value} is outside the range Retivo's editor accepts.`);
}

function requireRange(path: string, value: number, min: number, max: number, unit = ''): void {
  if (!(value >= min && value <= max)) rejectRange(path, min, max, unit, value);
}

function defaulted(age: { ageYears: number; ageMonths?: number }): RetirementAgePerMember {
  return { ageYears: age.ageYears, ageMonths: age.ageMonths ?? 0 };
}

function requireMonths(path: string, age: RetirementAgePerMember): void {
  requireRange(`${path}.ageMonths`, age.ageMonths, 0, AGE_MONTHS_MAX);
}

function requireSecondaryMember(path: string, context: HandlerContext): void {
  if (!context.env.workspace.members.some((member) => !member.payload.isPrimary)) {
    throw new ToolArgsError(`overrides.${path} cannot be set: the household has no secondary member.`);
  }
}

function birthdates(context: HandlerContext): { primary?: string; secondary?: string } {
  const { members } = context.env.workspace;
  const dateOf = (isPrimary: boolean): string | undefined =>
    members.find((member) => member.payload.isPrimary === isPrimary)?.payload.birthdate;
  return { primary: dateOf(true), secondary: dateOf(false) };
}

// ---------- One handler per allowed section ----------

const HANDLERS: { [K in AllowedSection]: Handler<K> } = {
  retirementAge(supplied, context) {
    const asked: Record<string, unknown> = {};
    const base = context.resolved.retirementAge;
    const merged: Record<string, unknown> = { ...base };
    for (const role of ['primary', 'secondary'] as const) {
      const age = supplied[role];
      if (age === undefined) continue;
      if (role === 'secondary') requireSecondaryMember('retirementAge.secondary', context);
      const normalised = defaulted(age);
      requireRange(`retirementAge.${role}.ageYears`, normalised.ageYears, RETIREMENT_AGE_MIN, RETIREMENT_AGE_MAX, ' years');
      requireMonths(`retirementAge.${role}`, normalised);
      asked[role] = normalised;
      merged[role] = normalised;
    }
    if (supplied.sameDateAnchor !== undefined) {
      asked.sameDateAnchor = supplied.sameDateAnchor;
      merged.sameDateAnchor = supplied.sameDateAnchor;
    }
    const anchor = merged.sameDateAnchor;
    const derived: Array<{ path: Path; value: unknown; reason: string }> = [];
    if (anchor === 'primary' || anchor === 'secondary') {
      // The editor ties the other member's age to the anchor's date; the engines read both ages, so keep them in step.
      const follower = anchor === 'primary' ? 'secondary' : 'primary';
      const dates = birthdates(context);
      const anchorAge = merged[anchor] as RetirementAgePerMember | undefined;
      const anchorBirth = dates[anchor];
      const followerBirth = dates[follower];
      if (anchorAge !== undefined && anchorBirth !== undefined && followerBirth !== undefined) {
        try {
          const followerAge = ageOnDate(followerBirth, retirementDate(anchorBirth, anchorAge));
          const next = { ageYears: followerAge.ageYears, ageMonths: followerAge.ageMonths };
          const asked = supplied[follower];
          if (asked !== undefined) {
            const given = defaulted(asked);
            if (given.ageYears !== next.ageYears || given.ageMonths !== next.ageMonths) {
              throw new ToolArgsError(
                `overrides.retirementAge.${follower} cannot differ from the ${anchor}'s date: both members retire on the same date, which makes the ${follower} ${next.ageYears} years ${next.ageMonths} months old. Set the ${anchor}'s age and the ${follower}'s follows.`,
              );
            }
          } else if (supplied[anchor] !== undefined) {
            merged[follower] = next;
            const reason = `Both members retire on the same date as the ${anchor}.`;
            derived.push({ path: [follower, 'ageYears'], value: next.ageYears, reason }, { path: [follower, 'ageMonths'], value: next.ageMonths, reason });
          }
        } catch (error) {
          if (error instanceof ToolArgsError) throw error;
          // A birth date that cannot be read leaves the other member's age as given or as the base has it.
        }
      }
    }
    if (!isRecord(merged.primary)) {
      throw new ToolArgsError('overrides.retirementAge.primary is required: the base scenario sets no retirement age to start from.');
    }
    return { section: merged as unknown as NonNullable<ScenarioOverrides['retirementAge']>, asked, derived };
  },

  socialSecurity(supplied, context) {
    const reading = SCENARIO_SECTION_COVERAGE.socialSecurity.read(context.section).value as NonNullable<ScenarioOverrides['socialSecurity']>;
    const merged: Record<string, unknown> = { ...reading };
    const asked: Record<string, unknown> = {};
    for (const role of ['primary', 'secondary'] as const) {
      const age = supplied[role];
      if (age === undefined) continue;
      if (role === 'secondary') requireSecondaryMember('socialSecurity.secondary', context);
      const normalised = defaulted(age);
      requireMonths(`socialSecurity.${role}`, normalised);
      const months = normalised.ageYears * 12 + normalised.ageMonths;
      if (months < SS_CLAIM_MIN * 12 || months > SS_CLAIM_MAX * 12) {
        throw new ToolArgsError(
          `overrides.socialSecurity.${role} must be from ${SS_CLAIM_MIN} years 0 months to ${SS_CLAIM_MAX} years 0 months, the Social Security claim window; ${normalised.ageYears} years ${normalised.ageMonths} months is outside it.`,
        );
      }
      asked[role] = normalised;
      merged[role] = normalised;
    }
    if (supplied.benefitReductionPct !== undefined) {
      requireRange('socialSecurity.benefitReductionPct', supplied.benefitReductionPct, BENEFIT_REDUCTION_MIN, BENEFIT_REDUCTION_MAX, ' percent');
      asked.benefitReductionPct = merged.benefitReductionPct = supplied.benefitReductionPct;
    }
    if (supplied.colaTracksInflation !== undefined) asked.colaTracksInflation = merged.colaTracksInflation = supplied.colaTracksInflation;
    if (supplied.colaPct !== undefined) {
      requireRange('socialSecurity.colaPct', supplied.colaPct, COLA_MIN, COLA_MAX, ' percent');
      if (merged.colaTracksInflation !== false) {
        throw new ToolArgsError(
          'overrides.socialSecurity.colaPct has no effect while benefits track inflation. Set colaTracksInflation to false to use a fixed rate.',
        );
      }
      asked.colaPct = merged.colaPct = supplied.colaPct;
    }
    return { section: merged as unknown as NonNullable<ScenarioOverrides['socialSecurity']>, asked };
  },

  lifeExpectancy(supplied, context) {
    const merged: Record<string, unknown> = { ...context.resolved.lifeExpectancy };
    const asked: Record<string, unknown> = {};
    for (const role of ['primary', 'secondary'] as const) {
      const age = supplied[role];
      if (age === undefined) continue;
      if (role === 'secondary') requireSecondaryMember('lifeExpectancy.secondary', context);
      requireRange(`lifeExpectancy.${role}`, age, LIFE_MIN, LIFE_MAX, ' years');
      asked[role] = merged[role] = age;
    }
    return { section: merged as NonNullable<ScenarioOverrides['lifeExpectancy']>, asked };
  },

  inflation(supplied, context) {
    requireRange('inflation.ratePct', supplied.ratePct, INFLATION_MIN, INFLATION_MAX, ' percent');
    // Category rates stay as the base has them; only the general rate is the agent's to change.
    return { section: { ...context.resolved.inflation, ratePct: supplied.ratePct }, asked: { ratePct: supplied.ratePct } };
  },

  discretionarySpending(supplied, context) {
    const base = context.resolved.discretionarySpending;
    const asked: Record<string, unknown> = {};
    if (supplied.bumpPct !== undefined) {
      requireRange('discretionarySpending.bumpPct', supplied.bumpPct, ADJUSTMENT_MIN, ADJUSTMENT_MAX, ' percent');
      asked.bumpPct = supplied.bumpPct;
    }
    if (supplied.durationYears !== undefined) {
      if (supplied.durationYears !== null) requireRange('discretionarySpending.durationYears', supplied.durationYears, DURATION_MIN, DURATION_MAX, ' years');
      asked.durationYears = supplied.durationYears;
    }
    return {
      section: {
        bumpPct: supplied.bumpPct ?? base?.bumpPct ?? 0,
        durationYears: supplied.durationYears !== undefined ? supplied.durationYears : (base?.durationYears ?? DEFAULT_DISCRETIONARY_DURATION_YEARS),
      },
      asked,
    };
  },

  downturnGuardrails(supplied, context) {
    const reading = SCENARIO_SECTION_COVERAGE.downturnGuardrails.read(context.section).value as NonNullable<ScenarioOverrides['downturnGuardrails']>;
    const merged = { ...reading, ...definedOnly(supplied) };
    const bands = [
      ['lowerBandPct', GUARDRAIL_LOWER_BAND_MIN, GUARDRAIL_LOWER_BAND_MAX],
      ['upperBandPct', GUARDRAIL_UPPER_BAND_MIN, GUARDRAIL_UPPER_BAND_MAX],
      ['stepPct', GUARDRAIL_STEP_MIN, GUARDRAIL_STEP_MAX],
      ['maxRaisePct', GUARDRAIL_MAX_RAISE_MIN, GUARDRAIL_MAX_RAISE_MAX],
      ['discretionaryFloorPct', GUARDRAIL_DISCRETIONARY_FLOOR_MIN, GUARDRAIL_DISCRETIONARY_FLOOR_MAX],
    ] as const;
    for (const [field, min, max] of bands) {
      const value = supplied[field];
      if (value !== undefined) requireRange(`downturnGuardrails.${field}`, value, min, max, ' percent');
    }
    if (!isGuardrailConfigValid(merged)) {
      throw new ToolArgsError('overrides.downturnGuardrails is not a valid set of bands: the lower band must be below the upper band, with a step above 0 and a raise cap of at least 100 percent.');
    }
    const notes =
      merged.enabled !== true && Object.keys(supplied).some((key) => key !== 'enabled')
        ? ['Spending guardrails are off in this what-if, so the bands set for them have no effect. Set enabled to true to turn them on.']
        : [];
    return { section: merged, asked: definedOnly(supplied), notes };
  },

  contributions(supplied) {
    return { section: { stopContributionsToday: supplied.stopContributionsToday }, asked: { stopContributionsToday: supplied.stopContributionsToday } };
  },

  accountReturns(supplied, context) {
    const active = new Set(context.env.workspace.accounts.filter((account) => account.payload.active).map((account) => account.id));
    const merged: Record<string, { planningReturnPct?: number }> = { ...context.resolved.accountReturns?.perAccount };
    const asked: Record<string, { planningReturnPct: number }> = {};
    for (const [id, entry] of Object.entries(supplied.perAccount)) {
      if (!active.has(id) || id === '__proto__') {
        throw new ToolArgsError('overrides.accountReturns.perAccount names an id that is not an active account of the household. Use account ids from retivo_get_plan_data.');
      }
      requireRange('accountReturns.perAccount.planningReturnPct', entry.planningReturnPct, PLANNING_RETURN_MIN, PLANNING_RETURN_MAX, ' percent');
      Object.defineProperty(merged, id, { value: { ...merged[id], planningReturnPct: entry.planningReturnPct }, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(asked, id, { value: { planningReturnPct: entry.planningReturnPct }, enumerable: true, writable: true, configurable: true });
    }
    return { section: { perAccount: merged }, asked: { perAccount: asked } };
  },

  withdrawalStrategy(supplied) {
    return { section: { kind: supplied.kind }, asked: { kind: supplied.kind } };
  },
};

function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** The sections in a fixed order, so the echo reads the same on every call. */
const SECTION_ORDER = Object.keys(HANDLERS) as AllowedSection[];

// ---------- Previous values: where each came from ----------

interface Previous {
  value: unknown;
  source: ValueSource;
  basis?: string;
}

/** What `leaf` was in the base scenario, and whether a scenario in its chain or a default gave it. */
function previousOf(section: AllowedSection, leaf: Leaf, context: HandlerContext, reading: SectionReading): Previous {
  const rule = SCENARIO_SECTION_COVERAGE[section];
  const field = leaf.path.join('.');
  if (section === 'accountReturns') {
    const id = leaf.accountId!;
    const set = context.section.chain.some((scenario) => scenario.payload.overrides.accountReturns?.perAccount?.[id]?.planningReturnPct !== undefined);
    const value = getPath(reading.value, ['perAccount', id, 'planningReturnPct']);
    return set
      ? { value, source: 'scenario' }
      : { value, source: 'default', basis: "The account's own recorded planning return; no scenario in the chain changes it." };
  }
  if (reading.defaultBasis !== undefined) return { value: getPath(reading.value, leaf.path) ?? null, source: 'default', basis: reading.defaultBasis };
  const raw = getPath(context.section.merged[section], leaf.path);
  if (raw !== undefined) return { value: raw, source: 'scenario' };
  const fill = reading.fills?.find((candidate) => candidate.field === field);
  if (fill !== undefined) return { value: fill.value, source: 'default', basis: fill.basis };
  const effective = getPath(reading.value, leaf.path);
  if (effective !== undefined) return { value: effective, source: 'default', basis: 'The engine fills this in when no scenario sets it.' };
  return { value: null, source: 'default', basis: rule.whenUnset };
}

/**
 * Builds the throwaway scenario's sections and the echo for the settings the agent supplied, on top of what
 * `baseScenarioId` resolves to. Throws `ToolArgsError` for a value outside the editors' ranges or a setting
 * that cannot apply (an account that is not active, a member the household lacks).
 */
export function buildWhatIf(baseScenarioId: string, supplied: WhatIfOverrides, env: ToolEnv): WhatIfBuild {
  const section = sectionContextFor(baseScenarioId, env);
  const context: HandlerContext = { env, section, resolved: section.merged };
  const overrides: Record<string, unknown> = {};
  const changes: EchoChange[] = [];
  const kept: EchoKept[] = [];
  const notes: string[] = [];

  for (const key of SECTION_ORDER) {
    const value = supplied[key];
    if (value === undefined) continue;
    const handler = HANDLERS[key] as Handler<typeof key>;
    const built = handler(value as never, context);
    overrides[key] = built.section;
    notes.push(...(built.notes ?? []));

    const reading = SCENARIO_SECTION_COVERAGE[key].read(section);
    const askedLeaves = leavesOf(built.asked);
    const handled = new Set(askedLeaves.map(leafKey));
    const record = (leaf: Leaf, derived?: string): void => {
      const previous = previousOf(key, leaf, context, reading);
      changes.push({
        section: key,
        path: leaf.path.join('.'),
        ...(leaf.accountId !== undefined && { accountId: leaf.accountId }),
        previous: previous.value,
        previousSource: previous.source,
        ...(previous.basis !== undefined && { basis: previous.basis }),
        new: leaf.value,
        changed: previous.value !== leaf.value,
        ...(derived !== undefined && { derived }),
      });
    };
    for (const leaf of askedLeaves) record(leaf);
    for (const follow of built.derived ?? []) {
      const leaf = { path: follow.path, value: follow.value };
      record(leaf, follow.reason);
      handled.add(leafKey(leaf));
    }
    for (const leaf of leavesOf(built.section)) {
      if (handled.has(leafKey(leaf))) continue;
      const previous = previousOf(key, leaf, context, reading);
      kept.push({
        section: key,
        path: leaf.path.join('.'),
        ...(leaf.accountId !== undefined && { accountId: leaf.accountId }),
        value: leaf.value,
        source: previous.source,
        ...(previous.basis !== undefined && { basis: previous.basis }),
      });
    }
  }
  return { overrides: overrides as ScenarioOverrides, changes, kept, notes };
}

export { getPath, setPath };
