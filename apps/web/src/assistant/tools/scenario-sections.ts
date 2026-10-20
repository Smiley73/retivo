/**
 * How `retivo_get_scenario` reports each scenario setting. The map is typed
 * `satisfies Record<keyof ScenarioOverrides, …>` (the `SCENARIO_SETTING_COVERAGE`
 * pattern in `lib/report-scenario-settings.ts`), so a new override key fails to
 * compile until this file says how the tool reports it.
 *
 * A rule reads the section's EFFECTIVE value the way the engines do: through the
 * hardened per-section resolvers in `lib/scenario-resolution.ts` where one exists
 * (they drop corrupt stored values), through `resolveItemState` for the sparse expense and income
 * sections (a nearer scenario's section does not hide an ancestor's rows or patches), and through
 * the merged chain otherwise. The
 * value stays in the stored shape so the sharing field model projects it; a rule
 * never decides what may be said. Each default is read from the constant the
 * engine imports, and a setting whose default is a literal inside the engine says
 * only that the engine fills it, never a number that could drift.
 */
import {
  DEFAULT_COLA_PCT,
  DEFAULT_DOWNTURN_GUARDRAILS,
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
  DEFAULT_MEDICAL_INFLATION_SPREAD_PCT,
  type PatchWithClears,
  type ScenarioOverrides,
} from '../../db/types';
import { normalizeOverrideId, resolveItemState } from '../../lib/expense-override-resolution';
import { summarizeFilingPlan } from '../../lib/filing-status';
import { DEFAULT_RETIREMENT_AGE, DEFAULT_SOCIAL_SECURITY_CLAIM_AGE } from '../../lib/scenario-bootstrap';
import {
  resolveAccountAssetMixForScenario,
  resolveAccountContributionsForScenario,
  resolveAccountFloorsForScenario,
  resolveAccountReturnsForScenario,
  resolveContributionGrowth,
  resolveDownturnGuardrailsForScenario,
  resolveInflationForScenario,
  resolvePreRetirementRothConversions,
  resolveQcdForScenario,
  type ScenarioAggregate,
} from '../../lib/scenario-resolution';
import type { ProjectionInputs } from '../../lib/projection-inputs';

export interface SectionContext {
  scenarioId: string;
  scenarios: ScenarioAggregate[];
  /** The scenario and its ancestors, nearest first. */
  chain: ScenarioAggregate[];
  /** Section-level first-ancestor-wins merge (`resolveScenario`). */
  merged: ScenarioOverrides;
  members: ProjectionInputs['members'];
  accounts: ProjectionInputs['accounts'];
  /** Ids of the categories flagged medical, from the flag and never from a seeded id. */
  medicalCategoryIds: string[];
  todayYear: number;
}

/** One value the engine filled in, with where it comes from. */
export interface DefaultApplied {
  field: string;
  value: unknown;
  basis: string;
  /** Set when one default covers several accounts. */
  accountIds?: string[];
}

export interface SectionReading {
  /** The effective value in the stored shape, or `undefined` when nothing applies. */
  value?: unknown;
  /** Set when `value` is wholly a default (no scenario in the chain set the section). */
  defaultBasis?: string;
  /** Defaults filled in beside what a scenario did set. */
  fills?: DefaultApplied[];
  /** The effective treatment in words, where the stored shape alone does not say it. */
  effective?: string;
}

export interface SectionRule {
  /** What the engine does when no scenario sets the section and there is no default to report. */
  whenUnset: string;
  read(context: SectionContext): SectionReading;
}

const merged =
  (key: keyof ScenarioOverrides) =>
  (context: SectionContext): SectionReading => ({ value: context.merged[key] });

/** The first finite number a chain sets at `pick`, as the inflation resolver reads it. */
function firstNumber(chain: ScenarioAggregate[], pick: (overrides: ScenarioOverrides) => unknown): number | undefined {
  for (const scenario of chain) {
    const value = pick(scenario.payload.overrides);
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function perAccount<T>(accounts: SectionContext['accounts'], pick: (id: string) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const account of accounts) {
    const value = pick(account.id);
    if (value !== undefined) out[account.id] = value;
  }
  return out;
}

/** Said beside every per-account section: a scenario that names some accounts leaves the rest as they are. */
const PER_ACCOUNT_EFFECTIVE =
  'Resolved per account: the first scenario in the chain that sets an account wins, and an account no scenario mentions keeps its own recorded setting.';

/**
 * The effective `expenses` or `income` section: what the engines resolve through
 * `resolveItemState`, not the nearest scenario's section. Every scenario in the chain
 * adds its rows; an id is disabled when the nearest scenario that disables or re-enables
 * it disables it (a re-enable shows as the id's absence from `disabledIds`); and an id's
 * patch merges per key, the nearest scenario winning. Ids keep the spelling a scenario
 * stored them with.
 */
/** The shape `ExpensesOverride` and `IncomeOverride` share. */
interface SparseSection<TPayload> {
  disabledIds?: string[];
  added?: Array<TPayload & { _localId: string }>;
  patches?: Record<string, PatchWithClears<TPayload>>;
  reEnabledIds?: string[];
}

function readSparseItems<TPayload>(
  chain: ScenarioAggregate[],
  pick: (overrides: ScenarioOverrides) => SparseSection<TPayload> | undefined,
): SparseSection<TPayload> {
  const sections = chain.map((scenario) => pick(scenario.payload.overrides));
  const spellings = new Map<string, string>();
  const note = (raw: string): string => {
    const id = normalizeOverrideId(raw);
    if (!spellings.has(id)) spellings.set(id, raw);
    return id;
  };
  const ids = new Set<string>();
  for (const section of sections) {
    for (const raw of section?.disabledIds ?? []) ids.add(note(raw));
    for (const raw of section?.reEnabledIds ?? []) ids.add(note(raw));
    for (const raw of Object.keys(section?.patches ?? {})) ids.add(note(raw));
  }
  const disabledIds: string[] = [];
  const patches: Record<string, PatchWithClears<TPayload>> = {};
  for (const id of ids) {
    const { disabled, patch } = resolveItemState<TPayload>(id, sections);
    const raw = spellings.get(id) ?? id;
    if (disabled) disabledIds.push(raw);
    if (patch !== undefined) patches[raw] = patch;
  }
  const added = sections.flatMap((section) => section?.added ?? []);
  return {
    ...(disabledIds.length > 0 && { disabledIds }),
    ...(added.length > 0 && { added }),
    ...(Object.keys(patches).length > 0 && { patches }),
  };
}

const hasSecondary = (context: SectionContext): boolean => context.members.some((member) => !member.payload.isPrimary);

function filingEffective(context: SectionContext): string {
  return summarizeFilingPlan({
    taxFilingPlan: context.merged.taxFilingPlan,
    filingStatusOverride: context.merged.filingStatus,
    hasSecondaryMember: hasSecondary(context),
    taxYear: context.todayYear,
  }).headline;
}

const FILING_UNSET =
  'No filing setting is stored. The engines file jointly while both spouses are alive and as Single otherwise.';

function readInflation(context: SectionContext): SectionReading {
  const medical = new Set(context.medicalCategoryIds);
  const resolved = resolveInflationForScenario(context.scenarioId, context.scenarios, medical);
  // The same resolution with no medical ids keeps only what a scenario set, so the rest were defaults.
  const explicit = resolveInflationForScenario(context.scenarioId, context.scenarios, new Set());
  const fills: DefaultApplied[] = [];
  const setRate = firstNumber(context.chain, (overrides) => overrides.inflation?.ratePct);
  if (setRate === undefined) {
    fills.push({
      field: 'ratePct',
      value: DEFAULT_INFLATION_PCT,
      basis: `General inflation when no scenario sets it (DEFAULT_INFLATION_PCT, ${DEFAULT_INFLATION_PCT}%).`,
    });
  }
  for (const id of context.medicalCategoryIds) {
    if (explicit.categoryRates.has(id)) continue;
    fills.push({
      field: `categoryRates.${id}`,
      value: resolved.categoryRates.get(id),
      basis:
        `A category flagged medical inflates ${DEFAULT_MEDICAL_INFLATION_SPREAD_PCT} percentage points above general inflation ` +
        'unless a scenario sets its rate (DEFAULT_MEDICAL_INFLATION_SPREAD_PCT).',
    });
  }
  return {
    value: { ratePct: resolved.ratePct, categoryRates: Object.fromEntries(resolved.categoryRates) },
    fills,
    ...(setRate === undefined && { defaultBasis: `General inflation ${DEFAULT_INFLATION_PCT}% (DEFAULT_INFLATION_PCT); no scenario in the chain sets it.` }),
  };
}

function readAccountContributions(context: SectionContext): SectionReading {
  const amounts = resolveAccountContributionsForScenario(context.scenarioId, context.scenarios, context.accounts);
  const growth = resolveContributionGrowth(context.scenarioId, context.scenarios, context.accounts);
  const tracking: string[] = [];
  const value = {
    perAccount: perAccount(context.accounts, (id) => {
      const amount = amounts.get(id);
      const rate = growth.get(id);
      if (amount === undefined || rate === undefined) return undefined;
      if (rate.mode === 'tracks-inflation') tracking.push(id);
      return { ...amount, ...(rate.mode === 'fixed' && { contributionGrowthPct: rate.ratePct }) };
    }),
  };
  const inflation = resolveInflationForScenario(context.scenarioId, context.scenarios).ratePct;
  return {
    value,
    defaultBasis: "Each account's own recorded contributions; no scenario in the chain changes them.",
    effective: PER_ACCOUNT_EFFECTIVE,
    fills:
      tracking.length === 0
        ? []
        : [
            {
              field: 'contributionGrowthPct',
              value: inflation,
              basis: 'An account with no fixed growth rate grows its contributions with general inflation.',
              accountIds: tracking,
            },
          ],
  };
}

export const SCENARIO_SECTION_COVERAGE = {
  retirementAge: {
    whenUnset: 'No retirement age is set, so the projection cannot run.',
    read: (context) => ({
      value: context.merged.retirementAge ?? DEFAULT_RETIREMENT_AGE,
      ...(context.merged.retirementAge === undefined && {
        defaultBasis:
          'The age Retivo gives a new base scenario (DEFAULT_RETIREMENT_AGE); no scenario in the chain sets one.',
      }),
    }),
  },
  socialSecurity: {
    whenUnset: 'No claim age is set.',
    read: (context) => {
      const set = context.merged.socialSecurity;
      const fills: DefaultApplied[] = [];
      if (set?.benefitReductionPct === undefined) {
        fills.push({ field: 'benefitReductionPct', value: 0, basis: 'No benefit cut is assumed unless a scenario sets one.' });
      }
      if (set?.colaTracksInflation === false) {
        if (set.colaPct === undefined) {
          fills.push({ field: 'colaPct', value: DEFAULT_COLA_PCT, basis: `A fixed cost-of-living adjustment defaults to ${DEFAULT_COLA_PCT}% (DEFAULT_COLA_PCT).` });
        }
      } else {
        fills.push({ field: 'colaTracksInflation', value: true, basis: 'Benefits are adjusted with inflation unless a scenario fixes the rate.' });
      }
      return {
        value: set ?? DEFAULT_SOCIAL_SECURITY_CLAIM_AGE,
        fills,
        ...(set === undefined && {
          defaultBasis:
            'The claim age Retivo gives a new base scenario (DEFAULT_SOCIAL_SECURITY_CLAIM_AGE, full retirement age for anyone born in 1960 or later); no scenario in the chain sets one.',
        }),
      };
    },
  },
  filingStatus: { whenUnset: FILING_UNSET, read: (context) => ({ value: context.merged.filingStatus, effective: filingEffective(context) }) },
  taxFilingPlan: { whenUnset: FILING_UNSET, read: (context) => ({ value: context.merged.taxFilingPlan, effective: filingEffective(context) }) },
  contributions: {
    whenUnset: 'Contributions continue as each account plans them.',
    read: merged('contributions'),
  },
  lifeExpectancy: {
    whenUnset: `Every member plans to age ${DEFAULT_LIFE_EXPECTANCY_AGE} (DEFAULT_LIFE_EXPECTANCY_AGE).`,
    read: (context) => {
      const set = context.merged.lifeExpectancy;
      const roles = hasSecondary(context) ? (['primary', 'secondary'] as const) : (['primary'] as const);
      // Whole-section defaults are named once by `defaultBasis`; per-member fills are for a section a scenario set in part.
      const fills: DefaultApplied[] = roles
        .filter((role) => set !== undefined && typeof set[role] !== 'number')
        .map((role) => ({
          field: role,
          value: DEFAULT_LIFE_EXPECTANCY_AGE,
          basis: `Planning age when none is set (DEFAULT_LIFE_EXPECTANCY_AGE, ${DEFAULT_LIFE_EXPECTANCY_AGE}).`,
        }));
      return {
        value: Object.fromEntries(roles.map((role) => [role, typeof set?.[role] === 'number' ? set[role] : DEFAULT_LIFE_EXPECTANCY_AGE])),
        fills,
        ...(set === undefined && { defaultBasis: `Every member plans to age ${DEFAULT_LIFE_EXPECTANCY_AGE} (DEFAULT_LIFE_EXPECTANCY_AGE).` }),
      };
    },
  },
  inflation: { whenUnset: 'General inflation applies.', read: readInflation },
  discretionarySpending: {
    whenUnset: 'Discretionary spending is not adjusted.',
    read: merged('discretionarySpending'),
  },
  downturnGuardrails: {
    whenUnset: 'Spending guardrails are off.',
    read: (context) => {
      const resolved = resolveDownturnGuardrailsForScenario(context.scenarioId, context.scenarios);
      return {
        value: resolved ?? { ...DEFAULT_DOWNTURN_GUARDRAILS },
        ...(resolved === undefined && {
          defaultBasis:
            'Guardrails are off unless a scenario turns them on; these are the bands a newly enabled guardrail starts with (DEFAULT_DOWNTURN_GUARDRAILS).',
        }),
      };
    },
  },
  expenses: {
    whenUnset: 'No expense is added, turned off or changed.',
    read: (context) => ({ value: readSparseItems(context.chain, (overrides) => overrides.expenses) }),
  },
  income: {
    whenUnset: 'No income stream is added, turned off or changed.',
    read: (context) => ({ value: readSparseItems(context.chain, (overrides) => overrides.income) }),
  },
  withdrawalStrategy: {
    whenUnset: 'The engines draw accounts in the tax-efficient order.',
    read: merged('withdrawalStrategy'),
  },
  customDrawdownOrder: { whenUnset: 'No custom drawdown order is set.', read: merged('customDrawdownOrder') },
  magiCap: { whenUnset: 'No income cap is applied to withdrawals.', read: merged('magiCap') },
  retirementAllocation: {
    whenUnset: "Accounts keep their own asset mix; no retirement glide is applied.",
    read: merged('retirementAllocation'),
  },
  assumedCostBasisFractionOfTaxableWithdrawal: {
    whenUnset: 'The engine applies its built-in share of a taxable withdrawal that counts as gain.',
    read: merged('assumedCostBasisFractionOfTaxableWithdrawal'),
  },
  magiBootstrapLookbackMinus2: {
    whenUnset: 'No figure is given for income two years before retirement.',
    read: merged('magiBootstrapLookbackMinus2'),
  },
  magiBootstrapLookbackMinus1: {
    whenUnset: 'No figure is given for income one year before retirement.',
    read: merged('magiBootstrapLookbackMinus1'),
  },
  acaPtcBenchmark: {
    whenUnset: 'The engine uses its own rough Marketplace benchmark premium for every year.',
    read: merged('acaPtcBenchmark'),
  },
  accountContributions: { whenUnset: 'Each account keeps its own recorded contributions.', read: readAccountContributions },
  accountReturns: {
    whenUnset: 'Each account keeps its own planning return.',
    read: (context) => {
      const rates = resolveAccountReturnsForScenario(context.scenarioId, context.scenarios, context.accounts);
      return {
        value: { perAccount: perAccount(context.accounts, (id) => (rates.has(id) ? { planningReturnPct: rates.get(id) } : undefined)) },
        defaultBasis: "Each account's own planning return; no scenario in the chain changes it.",
        effective: PER_ACCOUNT_EFFECTIVE,
      };
    },
  },
  accountAssetMix: {
    whenUnset: 'Each account keeps its own asset mix.',
    read: (context) => {
      const mixes = resolveAccountAssetMixForScenario(context.scenarioId, context.scenarios, context.accounts);
      return {
        value: { perAccount: perAccount(context.accounts, (id) => mixes.get(id)) },
        defaultBasis: "Each account's own asset mix; no scenario in the chain changes it.",
        effective: PER_ACCOUNT_EFFECTIVE,
      };
    },
  },
  accountFloors: {
    whenUnset: 'No account has a minimum balance floor.',
    read: (context) => {
      const floors = resolveAccountFloorsForScenario(context.scenarioId, context.scenarios, context.accounts);
      return { value: { perAccount: perAccount(context.accounts, (id) => floors.get(id)) } };
    },
  },
  hsaQualifiedMedicalExpensePct: {
    whenUnset: 'The engine treats emergency health savings withdrawals as qualified at its built-in share.',
    read: merged('hsaQualifiedMedicalExpensePct'),
  },
  earlyWithdrawalPenaltyExemptAccountIds: {
    whenUnset: 'No account is exempt from the early-withdrawal penalty.',
    read: merged('earlyWithdrawalPenaltyExemptAccountIds'),
  },
  acaMarketplaceOptOutMemberIds: {
    whenUnset: 'No member is treated as having other coverage.',
    read: merged('acaMarketplaceOptOutMemberIds'),
  },
  healthCoverageMonths: {
    whenUnset: 'Coverage months follow the engine’s age-based defaults.',
    read: merged('healthCoverageMonths'),
  },
  acaFplRegion: {
    whenUnset: 'The Marketplace calculation uses the poverty guidelines for the 48 mainland states and Washington, DC.',
    read: merged('acaFplRegion'),
  },
  preRetirementRothConversions: {
    whenUnset: 'No working-years Roth conversion is planned.',
    read: (context) => {
      const resolved = resolvePreRetirementRothConversions(context.scenarioId, context.scenarios, context.accounts);
      return { value: resolved.conversions };
    },
  },
  preRetirementRothConversionTaxRatePct: {
    whenUnset: 'No tax rate is assumed on working-years conversions (0%).',
    read: (context) => ({
      value: resolvePreRetirementRothConversions(context.scenarioId, context.scenarios, context.accounts).taxRatePct,
    }),
  },
  preRetirementTaxableIncomeDollars: {
    whenUnset: 'No working-years taxable income is given.',
    read: merged('preRetirementTaxableIncomeDollars'),
  },
  qualifiedCharitableDistributions: {
    whenUnset: 'No charitable distribution is planned.',
    read: (context) => {
      const resolved = resolveQcdForScenario(context.scenarioId, context.scenarios, context.accounts, context.members);
      return { value: resolved.entries };
    },
  },
} satisfies Record<keyof ScenarioOverrides, SectionRule>;

export const SCENARIO_SECTION_KEYS = Object.keys(SCENARIO_SECTION_COVERAGE) as Array<keyof ScenarioOverrides>;
