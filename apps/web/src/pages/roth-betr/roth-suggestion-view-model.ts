/**
 * Roth conversion suggestion panel — view-model. Everything the panel decides
 * that is not React: the leftover-tax-rate default, whether a search can run
 * and why not, the worker input, re-ranking when the rate changes, and the
 * comparison rows.
 *
 * The numbers come from the search (`lib/roth-suggestion`), already in today's
 * dollars: the lifetime totals are deflated per year there with the same
 * December deflator as the horizon figure, so no row mixes a nominal total
 * with a real ending balance. Re-ranking reuses the search's own `rankedOrder`
 * and its `ending - pre-tax * rate` formula; it never projects.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../../db/types';
import { DEFAULT_LIFE_EXPECTANCY_AGE } from '../../db/types';
import { formatCurrency } from '../../lib/format-currency';
import { idVersionSignature } from '../../lib/aggregate-signature';
import { memberLabel } from '../../lib/expense-format';
import { conversionWindow } from '../../lib/roth-suggestion/ladder';
import { rankedOrder } from '../../lib/roth-suggestion/ranking';
import type {
  RothSuggestionDeathAges,
  RothSuggestionUnsupportedReason,
  UnrankedReason,
} from '../../lib/roth-suggestion/types';
import { resolveScenario, type ScenarioAggregate } from '../../lib/scenario-resolution';
import type {
  RothSuggestionWorkerCandidate,
  RothSuggestionWorkerInput,
  RothSuggestionWorkerResult,
} from '../../workers/roth-suggestion.worker';
import type { AccountOption, RothBETRPageData } from './roth-betr-data';

/** Leftover-tax rate, in percent, when the page has no RMD-era rows to take
 *  one from (`workingSummary.T_future` is 0). 22% is the middle ordinary
 *  bracket of the compared targets. */
export const LEFTOVER_TAX_FALLBACK_PCT = 22;

/** Highest rate the input accepts: the search needs a fraction below 1. */
export const LEFTOVER_TAX_MAX_PCT = 99;

/** The page's average RMD-era marginal rate (a fraction) as a whole percent,
 *  or the fallback when it is 0. */
export function defaultLeftoverTaxPct(tFuture: number): number {
  const pct = Math.round(tFuture * 100);
  return pct > 0 ? Math.min(pct, LEFTOVER_TAX_MAX_PCT) : LEFTOVER_TAX_FALLBACK_PCT;
}

export type SuggestionUnavailableReason =
  | 'no-roth-ira'
  | 'no-retirement-window'
  | 'separate-filing';

export type SuggestionAvailability =
  | { readonly kind: 'ready'; readonly targetRoth: AccountOption }
  | { readonly kind: 'unavailable'; readonly reason: SuggestionUnavailableReason };

/** Whether a search can run on this page's data, and why not. Separate filing
 *  is checked first: it cannot be fixed by adding an account. The conversion
 *  window is the search's own (`conversionWindow`), so the page and the search
 *  agree on when it is empty. */
export function suggestionAvailability(pageData: RothBETRPageData): SuggestionAvailability {
  const { ctx } = pageData;
  if (ctx.filingStatus === 'MFS') return { kind: 'unavailable', reason: 'separate-filing' };
  const window = conversionWindow({
    primaryBirthYear: ctx.ownerBirthYear,
    retirementYear: ctx.retirementYear,
    horizonYear: ctx.lifeExpectancyAnchorYear,
    todayYear: ctx.currentCalendarYear,
  });
  if (window === null) return { kind: 'unavailable', reason: 'no-retirement-window' };
  const targetRoth = pageData.rothIraAccounts[0];
  if (targetRoth === undefined) return { kind: 'unavailable', reason: 'no-roth-ira' };
  return { kind: 'ready', targetRoth };
}

export const UNAVAILABLE_MESSAGES: Record<SuggestionUnavailableReason, string> = {
  'no-roth-ira':
    'Conversions in this comparison go into a Roth IRA you own, next to a pre-tax account. ' +
    'Add an active Roth IRA (not an inherited one) on the Accounts page to compare plans.',
  'no-retirement-window':
    'There is no retirement year before required minimum distributions begin, so there is ' +
    'no window to convert in. The comparison covers the years from retirement up to the ' +
    'age when required withdrawals start.',
  'separate-filing':
    'The comparison is not available when this scenario files married filing separately: ' +
    'the health-insurance premium credit is never available on separate returns, so the ' +
    'limits it compares cannot be set.',
};

/** What a finished search that could not run says, by the search's own reason. */
export const SEARCH_UNSUPPORTED_MESSAGES: Record<RothSuggestionUnsupportedReason, string> = {
  'no-primary-retirement':
    'Set a retirement age for the primary member on this scenario to compare plans.',
  'cbp-unconfigured':
    'Finish the cash-balance pension election on this scenario before comparing plans.',
  'no-roth-ira': UNAVAILABLE_MESSAGES['no-roth-ira'],
  'no-retirement-window': UNAVAILABLE_MESSAGES['no-retirement-window'],
  'separate-filing-plan':
    'The comparison is not available for a plan that files separate returns.',
  'filing-unresolved':
    'The comparison could not work out the filing status for every year in the window.',
  'member-birthdate-missing':
    'Every household member needs a birthdate before plans can be compared.',
  'no-projection': 'This scenario has no projected years to compare plans on.',
};

/** The aggregate sets the page projects from. */
export interface RothSuggestionData {
  readonly scenarios: readonly ScenarioAggregate[];
  readonly accounts: readonly Aggregate<AccountPayload>[];
  readonly balances: readonly Aggregate<AccountBalancePayload>[];
  readonly members: readonly Aggregate<HouseholdMemberPayload>[];
  readonly ssBenefits: readonly Aggregate<SocialSecurityBenefitPayload>[];
  readonly expenses: readonly Aggregate<ExpensePayload>[];
  readonly incomeStreams: readonly Aggregate<IncomeStreamPayload>[];
}

/** Content signature of the aggregate sets a result was computed from. */
export function suggestionDataSignature(data: RothSuggestionData): string {
  return [
    idVersionSignature(data.scenarios),
    idVersionSignature(data.members),
    idVersionSignature(data.accounts),
    idVersionSignature(data.balances),
    idVersionSignature(data.ssBenefits),
    idVersionSignature(data.expenses),
    idVersionSignature(data.incomeStreams),
  ].join('|');
}

/** The scenario's resolved life expectancies, the ages the page's own
 *  projection ends at. A partner age the scenario does not store stays unset,
 *  so the search reads the gap exactly as the page's projection does. */
export function resolveAssumedDeathAges(
  scenarios: readonly ScenarioAggregate[],
  scenarioId: string,
  members: readonly Aggregate<HouseholdMemberPayload>[],
): RothSuggestionDeathAges {
  const life = resolveScenario(scenarioId, [...scenarios]).lifeExpectancy;
  const primary = life?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  if (!members.some((m) => !m.payload.isPrimary) || life?.secondary === undefined) return { primary };
  return { primary, secondary: life.secondary };
}

/** The disclaimer's naming of the assumed death age(s). */
export function describeDeathAges(
  ages: RothSuggestionDeathAges,
  members: readonly Aggregate<HouseholdMemberPayload>[],
): string {
  const primary = members.find((m) => m.payload.isPrimary);
  const secondary = members.find((m) => !m.payload.isPrimary);
  if (ages.secondary === undefined) {
    if (secondary === undefined) return `age ${ages.primary}`;
    return (
      `age ${ages.primary} for ${memberLabel(primary, members, 'primary')} and the age your ` +
      `projection assumes for ${memberLabel(secondary, members, 'secondary')}`
    );
  }
  return (
    `age ${ages.primary} for ${memberLabel(primary, members, 'primary')} and ` +
    `${ages.secondary} for ${memberLabel(secondary, members, 'secondary')}`
  );
}

/** The worker input: the exact aggregate set and today the page's own
 *  projection used, so the reference row equals the page. */
export function buildSuggestionWorkerInput(args: {
  readonly data: RothSuggestionData;
  readonly pageData: RothBETRPageData;
  readonly selectedScenarioId: string;
  readonly targetRothAccountId: string;
  readonly leftoverTaxPct: number;
}): RothSuggestionWorkerInput {
  const { data, pageData, selectedScenarioId } = args;
  return {
    projection: {
      scenarios: data.scenarios,
      selectedScenarioId,
      accounts: data.accounts,
      balances: data.balances,
      members: data.members,
      ssBenefits: data.ssBenefits,
      expenses: data.expenses,
      incomeStreams: data.incomeStreams,
      todayYear: pageData.currentCalendarYear,
      todayMonthIndex: pageData.todayMonthIndex,
    },
    targetRothAccountId: args.targetRothAccountId,
    leftoverTaxRate: leftoverTaxFraction(args.leftoverTaxPct),
    deathAges: resolveAssumedDeathAges(data.scenarios, selectedScenarioId, data.members),
  };
}

/** Percent from the input as the fraction the search takes, clamped to [0, 0.99]. */
export function leftoverTaxFraction(pct: number): number {
  const clamped = Math.min(LEFTOVER_TAX_MAX_PCT, Math.max(0, Number.isFinite(pct) ? pct : 0));
  return clamped / 100;
}

/**
 * The result re-ranked at another leftover-tax rate, from the per-bucket
 * ending balances the search returned: `ending - pre-tax * rate`, then the
 * search's own tie-break order. No projection runs.
 */
export function rerankResult(
  result: RothSuggestionWorkerResult,
  leftoverTaxRate: number,
): RothSuggestionWorkerResult {
  const afterTax = result.candidates.map(
    (c) => c.afterTax.endingTodayDollars - c.afterTax.preTaxTodayDollars * leftoverTaxRate,
  );
  const referenceAfterTax = afterTax[result.candidates.findIndex((c) => c.isReference)] ?? 0;
  const order = rankedOrder(
    result.candidates.map((c, i) => ({
      id: c.id,
      ranked: c.unranked.length === 0,
      afterTaxTodayDollars: afterTax[i],
      totalConvertedTodayDollars: c.totals.totalConvertedTodayDollars,
      bracketRate: c.bracketRate,
    })),
  );
  return {
    ...result,
    leftoverTaxRate,
    rankedIds: order,
    candidates: result.candidates.map((c, i) => {
      const position = order.indexOf(c.id);
      return {
        ...c,
        rank: position < 0 ? null : position + 1,
        afterTax: {
          ...c.afterTax,
          afterTaxTodayDollars: afterTax[i],
          deltaVsReferenceTodayDollars: afterTax[i] - referenceAfterTax,
        },
      };
    }),
  };
}

/** Whole-dollar amount with an explicit sign; a zero (to the dollar) has none. */
export function formatSignedDollars(dollars: number): string {
  const rounded = Math.round(dollars);
  if (rounded === 0) return formatCurrency(0);
  return `${rounded > 0 ? '+' : '−'}${formatCurrency(Math.abs(rounded))}`;
}

export interface RothSuggestionRow {
  readonly id: string;
  readonly isReference: boolean;
  readonly label: string;
  /** 1-based; null when the cap was not met. */
  readonly rank: number | null;
  /** The ranked row with the highest after-tax ending balance. */
  readonly isTop: boolean;
  readonly bracket: string;
  readonly cliffs: string;
  readonly afterTaxEnding: string;
  readonly yearsConverted: number;
  readonly totalConverted: string;
  /** Signed difference from the current plan; the current plan reads $0. */
  readonly extraIncomeTax: string;
  /** Window total, then its signed difference from the current plan. */
  readonly irmaaSurcharges: string;
  /** Signed difference from the current plan; negative is credit lost. */
  readonly acaCreditChange: string;
  /** Years spending withdrawals were moved to a later taxable account. */
  readonly reroutedYears: readonly number[];
  /** Why the row is not ranked, empty when it is. */
  readonly notRanked: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function lineName(line: 'irmaa' | 'aca'): string {
  return line === 'irmaa' ? 'Medicare surcharge' : 'health-subsidy';
}

function describeUnranked(reason: UnrankedReason): string {
  switch (reason.kind) {
    case 'cap-breached':
      return `cap not met in ${plural(reason.years.length, 'year')}`;
    case 'guard-crossed': {
      const lines = [...new Set(reason.crossings.map((c) => lineName(c.line)))];
      return `crossed the ${lines.join(' and ')} line in ${plural(reason.crossings.length, 'year')}`;
    }
    case 'bracket-exceeded':
      return `bracket exceeded in ${plural(reason.years.length, 'year')}`;
  }
}

/** "Not ranked: cap not met in 2 years", or '' for a ranked candidate. */
function describeNotRanked(unranked: readonly UnrankedReason[]): string {
  return unranked.length === 0
    ? ''
    : `Not ranked: ${unranked.map(describeUnranked).join('; ')}`;
}

function bracketText(candidate: RothSuggestionWorkerCandidate): string {
  return candidate.bracketRate === null
    ? 'Scenario setting'
    : `${Math.round(candidate.bracketRate * 100)}%`;
}

function labelText(candidate: RothSuggestionWorkerCandidate): string {
  return candidate.isReference
    ? 'Current plan'
    : `Fill the ${bracketText(candidate)} bracket`;
}

function cliffsText(candidate: RothSuggestionWorkerCandidate): string {
  if (candidate.isReference) return 'Not assessed';
  if (candidate.unranked.some((u) => u.kind === 'guard-crossed')) return 'Crossed a line';
  return candidate.guarded === true ? 'Kept under both lines' : 'Not limited';
}

function toRow(candidate: RothSuggestionWorkerCandidate): RothSuggestionRow {
  const { totals, deltaVsReference, afterTax } = candidate;
  return {
    id: candidate.id,
    isReference: candidate.isReference,
    label: labelText(candidate),
    rank: candidate.rank,
    isTop: candidate.rank === 1,
    bracket: bracketText(candidate),
    cliffs: cliffsText(candidate),
    afterTaxEnding: formatCurrency(afterTax.afterTaxTodayDollars),
    yearsConverted: totals.yearsConverted,
    totalConverted: formatCurrency(totals.totalConvertedTodayDollars),
    extraIncomeTax: formatSignedDollars(deltaVsReference.incomeTaxTodayDollars),
    irmaaSurcharges:
      `${formatCurrency(totals.irmaaTodayDollars)} ` +
      `(${formatSignedDollars(deltaVsReference.irmaaTodayDollars)})`,
    acaCreditChange: formatSignedDollars(deltaVsReference.acaCreditTodayDollars),
    reroutedYears: candidate.reroutedYears,
    notRanked: describeNotRanked(candidate.unranked),
  };
}

/** True when no candidate, the current plan included, converts a cent. */
function convertsNothing(result: RothSuggestionWorkerResult): boolean {
  return result.candidates.every(
    (c) => Math.round(c.totals.totalConvertedTodayDollars * 100) === 0,
  );
}

export type RothSuggestionTableView =
  | { readonly kind: 'no-room' }
  | { readonly kind: 'rows'; readonly rows: readonly RothSuggestionRow[] };

/**
 * The rows to show for a result at a leftover-tax rate: ranked candidates by
 * after-tax ending balance (the current plan among them, at its rank), then the
 * unranked ones in search order. A search in which nothing converts is one
 * notice, not a table of identical rows.
 */
export function buildSuggestionTable(
  result: RothSuggestionWorkerResult,
  leftoverTaxRate: number,
): RothSuggestionTableView {
  if (convertsNothing(result)) return { kind: 'no-room' };
  const ranked = rerankResult(result, leftoverTaxRate);
  const byId = new Map(ranked.candidates.map((c) => [c.id, c]));
  const rankedRows = ranked.rankedIds.flatMap((id) => {
    const candidate = byId.get(id);
    return candidate === undefined ? [] : [candidate];
  });
  const unrankedRows = ranked.candidates.filter((c) => c.rank === null);
  return { kind: 'rows', rows: [...rankedRows, ...unrankedRows].map(toRow) };
}
