/**
 * "What changed" between two scenarios, for the Compare tab.
 *
 * Only a pair on the same inheritance line has a meaningful list: the settings
 * the descendant's chain sets between itself and the ancestor, the ancestor
 * excluded. The list reports what the user SET (presence, as the scenario
 * detail page counts it), not what moved a result: a child that re-sets
 * `retirementAge` to the inherited values still names it.
 *
 * Every `ScenarioOverrides` key is registered below with `satisfies`, so a
 * future override key fails typecheck instead of silently vanishing from the
 * list (the same guard as `SCENARIO_SETTING_COVERAGE` in report-scenario-settings).
 */
import type { ScenarioOverrides } from '../db/types';
import { scenarioChain, type ScenarioAggregate } from './scenario-resolution';

/** The detail page's four group titles, in its order. */
const GROUP_TITLES = [
  'Timing & longevity',
  'Income & expenses',
  'Savings & investments',
  'Withdrawals & taxes',
] as const;
type GroupTitle = (typeof GROUP_TITLES)[number];

const T = GROUP_TITLES;
/** Group + display label per override key; the label is the detail card's title
 *  where one exists. Order within a group is the order listed here. */
const SETTINGS = {
  retirementAge: { group: T[0], label: 'Retirement age' },
  socialSecurity: { group: T[0], label: 'Social Security' },
  lifeExpectancy: { group: T[0], label: 'Life expectancy' },
  income: { group: T[1], label: 'Income' },
  expenses: { group: T[1], label: 'Expenses' },
  inflation: { group: T[1], label: 'Inflation' },
  discretionarySpending: { group: T[1], label: 'Discretionary spending' },
  downturnGuardrails: { group: T[1], label: 'Spending guardrails' },
  contributions: { group: T[2], label: 'Future contributions' },
  accountContributions: { group: T[2], label: 'Account contributions' },
  accountReturns: { group: T[2], label: 'Planned returns' },
  retirementAllocation: { group: T[2], label: 'Asset allocation' },
  // Edited on its own route; the detail page has no card for it.
  accountAssetMix: { group: T[2], label: 'Account asset mix' },
  withdrawalStrategy: { group: T[3], label: 'Withdrawal strategy' },
  customDrawdownOrder: { group: T[3], label: 'Custom drawdown order' },
  magiCap: { group: T[3], label: 'MAGI cap' },
  assumedCostBasisFractionOfTaxableWithdrawal: { group: T[3], label: 'Taxable withdrawal cost basis' },
  magiBootstrapLookbackMinus2: { group: T[3], label: 'MAGI two years before retirement' },
  magiBootstrapLookbackMinus1: { group: T[3], label: 'MAGI one year before retirement' },
  hsaQualifiedMedicalExpensePct: { group: T[3], label: 'HSA qualified medical share' },
  earlyWithdrawalPenaltyExemptAccountIds: { group: T[3], label: 'Early-withdrawal penalty exemptions' },
  taxFilingPlan: { group: T[3], label: 'Tax filing plan' },
  filingStatus: { group: T[3], label: 'Filing status' },
  acaMarketplaceOptOutMemberIds: { group: T[3], label: 'ACA Marketplace opt-outs' },
  healthCoverageMonths: { group: T[3], label: 'Medicare and Marketplace months' },
  acaFplRegion: { group: T[3], label: 'ACA poverty-guideline region' },
  acaPtcBenchmark: { group: T[3], label: 'ACA benchmark plan cost' },
  preRetirementRothConversions: { group: T[3], label: 'Pre-retirement Roth conversions' },
  preRetirementRothConversionTaxRatePct: { group: T[3], label: 'Roth conversion tax rate' },
  preRetirementTaxableIncomeDollars: { group: T[3], label: 'Working-years taxable income' },
  qualifiedCharitableDistributions: { group: T[3], label: 'Charitable distributions (QCDs)' },
  accountFloors: { group: T[3], label: 'Account limits' },
} satisfies Record<keyof ScenarioOverrides, { group: GroupTitle; label: string }>;

type SettingKey = keyof typeof SETTINGS;

interface ScenarioChange {
  readonly key: keyof ScenarioOverrides;
  readonly label: string;
}

interface ScenarioChangeGroup {
  readonly title: GroupTitle;
  readonly changes: ReadonlyArray<ScenarioChange>;
}

/** How the viewed scenario relates to the other one. */
type ScenarioRelation = 'ancestor' | 'descendant' | 'unrelated';

export interface ScenarioChangeList {
  /** `descendant` = the viewed scenario inherits from the other one. */
  readonly relation: ScenarioRelation;
  /** Non-empty groups in the detail page's order; empty when unrelated. */
  readonly groups: ReadonlyArray<ScenarioChangeGroup>;
}

function nonEmpty(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

/** Does this scenario's own override section set `key`, as the detail page
 *  would count it? Presence for most keys; the sparse sections only when they
 *  carry something. */
function isSet(ov: ScenarioOverrides, key: SettingKey): boolean {
  if (key === 'income' || key === 'expenses') {
    const section = ov[key];
    return (
      (section?.disabledIds?.length ?? 0) > 0 ||
      nonEmpty(section?.patches) ||
      (section?.added?.length ?? 0) > 0
    );
  }
  if (
    key === 'accountContributions' ||
    key === 'accountReturns' ||
    key === 'accountAssetMix' ||
    key === 'accountFloors'
  ) {
    return nonEmpty(ov[key]?.perAccount);
  }
  return ov[key] !== undefined;
}

/** Walk `fromId`'s chain up to, excluding, `stopId`. `null` when `stopId` is
 *  not on it. */
function chainBelow(
  fromId: string,
  stopId: string,
  scenarios: ScenarioAggregate[],
): ScenarioAggregate[] | null {
  const chain = scenarioChain(fromId, scenarios);
  const at = chain.findIndex((s) => s.id === stopId);
  return at === -1 ? null : chain.slice(0, at);
}

export function buildScenarioChangeList(
  viewedId: string,
  otherId: string,
  scenarios: ScenarioAggregate[],
): ScenarioChangeList {
  const asDescendant = chainBelow(viewedId, otherId, scenarios);
  const asAncestor = asDescendant ? null : chainBelow(otherId, viewedId, scenarios);
  const between = asDescendant ?? asAncestor;
  if (!between) return { relation: 'unrelated', groups: [] };
  const set = new Set<SettingKey>();
  for (const scenario of between) {
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      if (isSet(scenario.payload.overrides, key)) set.add(key);
    }
  }
  const groups = GROUP_TITLES.map((title) => ({
    title,
    changes: (Object.keys(SETTINGS) as SettingKey[])
      .filter((key) => set.has(key) && SETTINGS[key].group === title)
      .map((key) => ({ key, label: SETTINGS[key].label })),
  })).filter((g) => g.changes.length > 0);
  return { relation: asDescendant ? 'descendant' : 'ancestor', groups };
}
