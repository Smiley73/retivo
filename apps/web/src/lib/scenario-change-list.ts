/**
 * "What changed" between two scenarios, for the Compare tab.
 *
 * Only a pair on the same inheritance line has a meaningful list: the settings
 * the descendant's chain sets between itself and the ancestor, the ancestor
 * excluded. The list reports what the user SET (presence, as the scenario
 * detail page counts it), not what moved a result: a child that re-sets
 * `retirementAge` to the inherited values still names it. Entries are the
 * detail page's cards (several keys share one).
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

/** Does this scenario's own overrides carry the key, as the detail page counts it? */
type Counts = (ov: ScenarioOverrides) => boolean;

interface Setting {
  readonly group: GroupTitle;
  readonly card: string;
  readonly counts: Counts;
}

const T = GROUP_TITLES;
const present = (key: keyof ScenarioOverrides): Counts => (ov) => ov[key] !== undefined;
/** Income and expenses count only when something is disabled, patched or added. */
const inventory =
  (key: 'income' | 'expenses'): Counts =>
  (ov) => {
    const section = ov[key];
    return (
      (section?.disabledIds?.length ?? 0) > 0 ||
      nonEmpty(section?.patches) ||
      (section?.added?.length ?? 0) > 0
    );
  };
/** The per-account sections count only when `perAccount` has entries. */
const perAccount =
  (key: 'accountContributions' | 'accountReturns' | 'accountAssetMix' | 'accountFloors'): Counts =>
  (ov) =>
    nonEmpty(ov[key]?.perAccount);
const setting = (group: GroupTitle, card: string, key: keyof ScenarioOverrides): Setting => ({
  group,
  card,
  counts: present(key),
});

/** Group and detail-page card per override key (`lib/` cannot import the page,
 *  so the mapping is restated here and a page test pins the titles); `null`
 *  for a key that reaches no projection. Order within a group is this order. */
export const SCENARIO_CHANGE_SETTINGS = {
  retirementAge: setting(T[0], 'Retirement age', 'retirementAge'),
  socialSecurity: setting(T[0], 'Social Security', 'socialSecurity'),
  lifeExpectancy: setting(T[0], 'Life expectancy', 'lifeExpectancy'),
  income: { group: T[1], card: 'Income', counts: inventory('income') },
  expenses: { group: T[1], card: 'Expenses', counts: inventory('expenses') },
  inflation: setting(T[1], 'Inflation', 'inflation'),
  discretionarySpending: setting(T[1], 'Discretionary adjustment', 'discretionarySpending'),
  downturnGuardrails: setting(T[1], 'Spending guardrails', 'downturnGuardrails'),
  contributions: setting(T[2], 'Future contributions', 'contributions'),
  accountContributions: {
    group: T[2],
    card: 'Account contributions',
    counts: perAccount('accountContributions'),
  },
  accountReturns: { group: T[2], card: 'Planned returns', counts: perAccount('accountReturns') },
  retirementAllocation: setting(T[2], 'Asset allocation', 'retirementAllocation'),
  // Edited on its own route; the detail page has no card for it.
  accountAssetMix: { group: T[2], card: 'Account asset mix', counts: perAccount('accountAssetMix') },
  withdrawalStrategy: setting(T[3], 'Withdrawal strategy', 'withdrawalStrategy'),
  customDrawdownOrder: setting(T[3], 'Withdrawal strategy', 'customDrawdownOrder'),
  magiCap: setting(T[3], 'Withdrawal strategy', 'magiCap'),
  assumedCostBasisFractionOfTaxableWithdrawal: setting(
    T[3],
    'Withdrawal strategy',
    'assumedCostBasisFractionOfTaxableWithdrawal',
  ),
  magiBootstrapLookbackMinus2: setting(T[3], 'Withdrawal strategy', 'magiBootstrapLookbackMinus2'),
  magiBootstrapLookbackMinus1: setting(T[3], 'Withdrawal strategy', 'magiBootstrapLookbackMinus1'),
  hsaQualifiedMedicalExpensePct: setting(T[3], 'Tax assumptions', 'hsaQualifiedMedicalExpensePct'),
  earlyWithdrawalPenaltyExemptAccountIds: setting(
    T[3],
    'Tax assumptions',
    'earlyWithdrawalPenaltyExemptAccountIds',
  ),
  taxFilingPlan: setting(T[3], 'Tax assumptions', 'taxFilingPlan'),
  // The legacy scalar the filing plan supersedes; the card's filing tab resolves it.
  filingStatus: setting(T[3], 'Tax assumptions', 'filingStatus'),
  acaMarketplaceOptOutMemberIds: setting(T[3], 'Health coverage', 'acaMarketplaceOptOutMemberIds'),
  healthCoverageMonths: setting(T[3], 'Health coverage', 'healthCoverageMonths'),
  acaFplRegion: setting(T[3], 'Health coverage', 'acaFplRegion'),
  acaPtcBenchmark: setting(T[3], 'Health coverage', 'acaPtcBenchmark'),
  preRetirementRothConversions: setting(
    T[3],
    'Pre-retirement Roth conversions',
    'preRetirementRothConversions',
  ),
  preRetirementRothConversionTaxRatePct: setting(
    T[3],
    'Pre-retirement Roth conversions',
    'preRetirementRothConversionTaxRatePct',
  ),
  preRetirementTaxableIncomeDollars: null,
  qualifiedCharitableDistributions: setting(
    T[3],
    'Charitable distributions (QCDs)',
    'qualifiedCharitableDistributions',
  ),
  accountFloors: { group: T[3], card: 'Account limits', counts: perAccount('accountFloors') },
} satisfies Record<keyof ScenarioOverrides, Setting | null>;

type SettingKey = keyof typeof SCENARIO_CHANGE_SETTINGS;

interface ScenarioChange {
  /** The detail page card title. */
  readonly card: string;
  /** The override keys of that card the chain sets, in table order. */
  readonly keys: ReadonlyArray<keyof ScenarioOverrides>;
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
  /** Non-empty groups in the detail page's order, one entry per changed card;
   *  empty when unrelated. */
  readonly groups: ReadonlyArray<ScenarioChangeGroup>;
}

function nonEmpty(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

const LISTED_KEYS = (Object.keys(SCENARIO_CHANGE_SETTINGS) as SettingKey[]).filter(
  (key) => SCENARIO_CHANGE_SETTINGS[key] !== null,
);

function settingOf(key: SettingKey): Setting {
  return SCENARIO_CHANGE_SETTINGS[key] as Setting;
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
    for (const key of LISTED_KEYS) {
      if (settingOf(key).counts(scenario.payload.overrides)) set.add(key);
    }
  }
  const groups = GROUP_TITLES.map((title) => {
    const keys = LISTED_KEYS.filter((key) => set.has(key) && settingOf(key).group === title);
    const cards = [...new Set(keys.map((key) => settingOf(key).card))];
    return {
      title,
      changes: cards.map((card) => ({
        card,
        keys: keys.filter((key) => settingOf(key).card === card),
      })),
    };
  }).filter((g) => g.changes.length > 0);
  return { relation: asDescendant ? 'descendant' : 'ancestor', groups };
}
