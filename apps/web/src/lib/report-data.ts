/**
 * Pure synchronous aggregator for the CFP Report page. `buildReportData`
 * assembles every NON-projection, NON-Monte-Carlo slice of household data
 * (overview, accounts, expenses + glide summaries, income, Social
 * Security, scenario metadata + resolved override knobs) into a single
 * `ReportData` shape the page renders.
 *
 * Deliberately pure + synchronous (no async, no IndexedDB, no MC cache):
 * the caller loads aggregates and hands them in. The balance-projection
 * engine run and the read-only Monte Carlo cache lookup are async and
 * live in the component layer (`ReportPage` / `report-page-scenarios`),
 * not here. This mirrors `scenarios-page-metrics`
 * (pure deterministic data here; async projection/MC there).
 *
 * The plain-English discretionary-glide summary generator is new here.
 * It borrows the anchor-label helper `describeGlideAnchor`
 * from `schedule-format` but the sentence builder itself is new.
 */
import type {
  AccountPayload,
  AccountBalancePayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  HouseholdPayload,
  IncomeStreamPayload,
  ScenarioOverrides,
  SocialSecurityBenefitPayload,
} from '../db/types';
import { DANGEROUS_CATEGORY_RATE_KEYS } from '../db/types';
import { summarizeFilingPlan } from './filing-status';
// The single source of truth for the rough age-premium curve.
import { ROUGH_BENCHMARK_ASSUMPTIONS } from './aca-ptc';
// The SAME tax-detail readers the account editor and the accounts list
// use, so the three surfaces cannot disagree about whether a fact is recorded.
import {
  readTaxProfileDraft,
  rmdBlockerMessages,
  taxProfileCompleteness,
} from './account-tax-profile';
import {
  resolveScenario,
  resolveAccountReturnsForScenario,
  resolveAccountContributionsForScenario,
  resolveAccountFloorsForScenario,
  resolveQcdForScenario,
  type ScenarioAggregate,
} from './scenario-resolution';
import { resolveExpensesForScenario } from './expense-resolution';
import { resolveIncomeForScenario } from './income-resolution';
import { currentAgeOfRole } from './age-anchor-bounds';
import { annualizeIncome, formatIncomeSchedule } from './income-format';
import { fraMonthsForBirthdate, monthlyBenefitAtAge } from './ssa-formulas';
import type { AgeYearsMonths } from './format-age';
import {
  buildScenarioSettings,
  fplRegionReportLabel,
  lookupCanonicalName,
  statedCoverageYears,
  type ReportScenarioSettingGroup,
} from './report-scenario-settings';
import { storedAcaBenchmarkOverrides } from './tax-integration-helpers';
import {
  STRESS_CASE_COPY,
  STRESS_CASE_IDS,
  STRESS_MAX_AGE,
} from './market-stress';
// Pure display formatters extracted to report-format.ts so
// this aggregator file stays under the shape limit. `buildGlideSummary`
// and `buildReportTimestamp` are re-exported below to preserve the
// public report API surface (ReportPage + tests import them from here).
import {
  DEFAULT_RETIREMENT_AGE_YEARS,
  DEFAULT_SS_CLAIM_AGE_YEARS,
  annualExpenseAmount,
  buildGlideSummary,
  buildReportTimestamp,
  describeExpenseEndLabel,
  describeGlideAnchorFreeStart,
  memberName,
  resolvedKnobs,
  retirementAges,
  ssClaimAges,
  withdrawalStrategyKind,
  type ReportScenarioKnobs,
} from './report-format';
import {
  resolveMemberRetirementDates,
  type RetirementAgeResolved,
} from './retirement-date-math';
import {
  reportAccountOwnerDisplayName,
  type ReportAccountMetrics,
} from './report-account-metrics';
import { buildExpenseProjectionContext } from './expense-projection';
import { resolveReportExpenseOrderMonths } from './report-table-ordering';
import { buildReportTaxProfileAssumptions } from './report-tax-profile-assumptions';
import {
  buildRothTaxFreeRows,
  type ReportRothTaxFreeRow,
} from './report-roth-tax-free';

export { buildGlideSummary, buildReportTimestamp };

// ---------- Public shape ----------

interface ReportMemberOverview {
  role: 'primary' | 'secondary';
  name: string;
  /** Whole-years current age, or `null` when no usable birthdate. */
  currentAge: number | null;
  /** Resolved retirement age (years + months) for this scenario. */
  retirementAge: AgeYearsMonths;
  /** Calendar year they reach `retirementAge`, or `null` when no birthdate. */
  retirementYear: number | null;
  /** Month (1-indexed) they reach `retirementAge`, or `null` when no birthdate. */
  retirementMonth: number | null;
}

export interface ReportHouseholdOverview {
  householdName: string;
  members: ReportMemberOverview[];
  /** Sum of current balances across all accounts (today's dollars). */
  totalCurrentPortfolio: number;
  /** Sum of planned annual pre-tax + post-tax contributions, scenario-
   *  resolved across every account. The "run rate" the household is
   *  currently saving each year. */
  annualContributionRunRate: number;
  /** Non-timing-gated run-rate estimate: annualised Social Security benefit at
   *  each member's resolved claim age + annualised recurring income streams.
   *  Does NOT gate income by when it starts relative to retirement — it is a
   *  portfolio-income indicator, not a first-year cash-flow model. The precise
   *  year-by-year schedule is the page's async projection job. */
  estimatedAnnualOtherIncome: number;
}

export interface ReportAccount {
  id: string;
  name: string;
  ownerDisplayName: string;
  type: AccountPayload['type'];
  taxTreatment: AccountPayload['taxTreatment'];
  assetMix: AccountPayload['assetMix'];
  /** Historical time-weighted return, or `null` with fewer than two
   *  return-bearing balance years. */
  historicalReturnPct: number | null;
  /** Cumulative contributions across every recorded balance row. */
  totalContributions: number;
  /** Cumulative gain/loss across every recorded balance row. */
  totalGains: number;
  currentBalance: number;
  /** Latest balance routed to the pre-tax bucket, or `null` when that bucket
   *  is not applicable to this account's tax treatment. */
  currentBalancePreTax: number | null;
  /** Latest balance routed to the taxable post-tax bucket, or `null` when that
   *  bucket is not applicable to this account's tax treatment. */
  currentBalancePostTax: number | null;
  /** Latest tax-free balance, or `null` when tax-free treatment is not
   *  applicable to this account. */
  currentBalanceTaxFree: number | null;
  plannedContributionPreTax: number;
  plannedContributionPostTax: number;
  /** Scenario-resolved configured annual planning return rate (%). */
  configuredReturnPct: number;
  /** Year the latest balance is recorded for (the "as of" date), or `null`
   *  when the account has no balance history. */
  balanceAsOfYear: number | null;
  /** Calendar date (`YYYY-MM-DD`) the latest balance is "as of" — the
   *  "Balance as of" the user entered, or `null` when no balance history /
   *  no recorded date. Preferred over `balanceAsOfYear` for display. */
  balanceAsOfDate: string | null;
  /**
   * This account's Roth / required-withdrawal tax-detail readiness,
   * so an exported report never presents a cautious default as a modeled fact.
   * `undefined` for account types that carry no such facts.
   */
  taxProfile?: ReportAccountTaxProfile;
}

/** One account's tax-detail readiness for the report. */
interface ReportAccountTaxProfile {
  /** `'complete'` | `'partial'` | `'blocked'` — see `taxProfileCompleteness`. */
  completeness: 'complete' | 'partial' | 'blocked';
  /** Plain-English inputs still missing on an inherited account, which WITHHOLD
   *  its required-withdrawal estimate. Empty unless `completeness === 'blocked'`. */
  blockers: string[];
  /** True for an inherited account whose whole balance is Roth-treated
   *  (`ROTH` / `POST_TAX`), which the shared §325 convention models as a $0
   *  required-withdrawal base on every surface (rmd.ts's
   *  `rmdDeclaredRothPortionCents`) — a real statutory minimum still applies,
   *  this planner just does not compute it. Never true when `blocked`, whose
   *  own "on hold" disclosure already covers the account. */
  inheritedRothZeroRequired: boolean;
}

/** An inherited account whose entire recorded balance is Roth-treated, so the
 *  shared RMD-base convention (`rmd.ts`) nets its required amount to $0 on
 *  every surface — see `ReportAccountTaxProfile.inheritedRothZeroRequired`. */
function isInheritedPureRothAccount(payload: AccountPayload): boolean {
  return (
    payload.rmdInheritedAccount === true &&
    (payload.taxTreatment === 'ROTH' || payload.taxTreatment === 'POST_TAX')
  );
}

export interface ReportExpense {
  id: string;
  name: string;
  categoryName: string;
  classification: ExpensePayload['classification'];
  frequency: ExpensePayload['frequency'];
  /** Amount in today's dollars, normalised to a yearly figure. */
  annualAmount: number;
  /** Absolute inclusive start month used only for deterministic report ordering. */
  effectiveStartMonth: number | null;
  /** Absolute exclusive end month used only for deterministic report ordering. */
  effectiveEndMonth: number | null;
  startLabel: string;
  endLabel: string;
  /** Plain-English glide-path summary, or `null` when this expense has no
   *  active discretionary glide (essential, no glide, or a no-op glide). */
  glideSummary: string | null;
}

export interface ReportIncomeStream {
  id: string;
  name: string;
  kind: IncomeStreamPayload['kind'];
  memberName: string;
  /** PDF ordering rank: primary, secondary, then unresolved owner. */
  ownerSortRank: 0 | 1 | 2;
  annualAmount: number;
  scheduleLabel: string;
  /** Pension/annuity + part-time COLA % when fixed, else `null`. */
  colaPct: number | null;
  /** `true` when this stream grows with scenario inflation instead of a
   *  fixed COLA. */
  tracksInflation: boolean;
}

interface ReportSocialSecurityMember {
  role: 'primary' | 'secondary';
  name: string;
  /** Primary Insurance Amount (monthly, at FRA), or `null` when unset. */
  pia: number | null;
  /** Scenario-resolved claim age (years). */
  claimAgeYears: number;
  /** Estimated monthly benefit at the claim age, or `null` when no PIA. */
  monthlyBenefitAtClaim: number | null;
}

/** Counts + notable names of a scenario's expense overrides. */
interface ReportExpenseOverrideSummary {
  disabledCount: number;
  addedCount: number;
  patchedCount: number;
  /** A short list of notable expense names across the three categories
   *  (added names first, then patched-canonical names), capped. */
  notableNames: string[];
}

/**
 * The filing assumptions a scenario's projections actually used,
 * plus the standing disclosures that belong beside every filing figure. Present
 * for every scenario, so the report can never imply a retained limitation is
 * modeled.
 */
interface ReportFilingAssumptions {
  /** Plain-English description of how the household files while both spouses
   *  are alive (or that a lone member files on their own). */
  whileBothAlive: string;
  /** Plain-English description of the post-death treatment, including any
   *  year-bounded exception windows the user entered. */
  afterADeath: string;
  /**
   * Set when the scenario still carries a legacy filing setting that
   * cannot be converted. Projections keep using it unchanged; the report must
   * say so rather than presenting the plan as authoritative.
   */
  unresolvedLegacyDetail?: string;
  /** Standing approximation / limitation disclosures for the filing figures. */
  disclosures: string[];
}

/**
 * The health-coverage assumptions a scenario's projections
 * actually used, plus the standing disclosures that belong beside every ACA /
 * Medicare figure. Present for every scenario, so an exported report can never
 * imply the rough benchmark is a real exchange quote or that the base Medicare
 * premium is modeled.
 */
interface ReportHealthAssumptions {
  /** Plain-English description of who is modeled on a Marketplace plan. */
  marketplaceCoverage: string;
  /** Which federal poverty guidelines size the subsidy. */
  povertyGuidelines: string;
  /** The benchmark plan price actually used: the rough estimate, or the years
   *  the user entered a price for. */
  benchmarkPrice: string;
  /** Plain-English description of the Medicare / Marketplace coverage months
   *  the user stated, or that the projection's own timing was used. */
  coverageMonths: string;
  /** Standing approximation / limitation disclosures for the health figures. */
  disclosures: string[];
}

/**
 * The market-stress assumptions an exported report must
 * restate: the named sensitivities the Balance Projection page can compare
 * against, and the standing approximation / no-forecast disclosures.
 */
interface ReportMarketStressAssumptions {
  /** One entry per named sensitivity: its name and the assumption it changes. */
  cases: ReadonlyArray<{ name: string; changed: string }>;
  /** Standing approximation / limitation disclosures for the stress figures. */
  disclosures: string[];
}

/**
 * Restate the market-stress assumptions for the report.
 *
 * The named sensitivities and their magnitudes come from the single
 * `STRESS_CASE_COPY` map in `lib/market-stress.ts` — the same one the on-screen
 * comparison table reads, so a printed report can never describe a stress
 * differently from the screen it was printed from.
 */
function buildMarketStressAssumptions(): ReportMarketStressAssumptions {
  return {
    cases: STRESS_CASE_IDS.map((caseId) => ({
      name: STRESS_CASE_COPY[caseId].name,
      changed: STRESS_CASE_COPY[caseId].changed,
    })),
    disclosures: [
      'Each comparison re-runs the plan with only that assumption changed, against the same simulated market histories, so the difference is the assumption and not luck.',
      `The longer-life comparison matches the base run only up to the original end of the plan. The added years — up to age ${STRESS_MAX_AGE} — use fresh market draws.`,
      'In those added years Social Security and other income repeat their last dollar amount with no further cost-of-living increase, so their buying power falls, and the plan keeps whichever tax return it was already filing rather than working out a new one. Together these make the added years an estimate rather than an exact re-run: the repeated income buys less over time, while keeping the earlier tax return and drawing fresh market years can each move the result in either direction.',
      'Simulated market histories are illustrations, not forecasts. Past performance does not predict what your accounts will earn.',
      'Medical costs grow faster than general inflation in every path, but never move independently of it, so the worst outcomes for a medical-heavy household are understated.',
      'The side-by-side stress comparison runs on the Balance Projection page; this report states the assumptions it uses.',
    ],
  };
}

interface ReportScenario {
  id: string;
  name: string;
  description: string;
  /** Multi-line free-form scenario notes (empty string when unset). */
  notes: string;
  isPrimary: boolean;
  /** Resolved retirement ages (years + months) per member. */
  retirementAge: { primary: AgeYearsMonths; secondary?: AgeYearsMonths };
  /** Resolved SS claim ages (years) per member — always present
   *  (inherited / default-filled), so the page shows the effective value
   *  even when the scenario does not explicitly override it. */
  ssClaimAgeYears: { primary: number; secondary?: number };
  /** Resolved withdrawal-strategy kind. */
  withdrawalStrategyKind: string;
  /** Actual first names of household members, used in place of
   *  "Primary"/"Secondary" role strings in the report. */
  memberNames: { primary: string; secondary?: string };
  /** Ordered withdrawal tiers when `withdrawalStrategyKind === 'customOrder'`,
   *  each tier being a list of resolved account names; `null` otherwise. */
  customWithdrawalTiers: string[][] | null;
  knobs: ReportScenarioKnobs;
  expenseOverrides: ReportExpenseOverrideSummary;
  /** Filing treatment + its standing disclosures. */
  filingAssumptions: ReportFilingAssumptions;
  /** Health coverage assumptions + their standing disclosures. */
  healthAssumptions: ReportHealthAssumptions;
  /** Market-stress assumptions + their standing disclosures. */
  marketStressAssumptions: ReportMarketStressAssumptions;
  /** Grouped settings/changes for the PDF Scenario page (one table per group). */
  settingGroups: ReportScenarioSettingGroup[];
}

export interface ReportData {
  overview: ReportHouseholdOverview;
  accounts: ReportAccount[];
  /** Standing Roth / required-withdrawal disclosures, including which
   *  accounts fell back to a cautious default and which have a withheld estimate. */
  taxProfileDisclosures: string[];
  /** One row per person's own Roth-IRA §408A pool, then one row per
   *  employer designated-Roth plan, resolved by the SAME engine call as the
   *  projections (`buildRothTaxFreeRows`). PDF-only (see `report-roth-tax-free.ts`). */
  rothTaxFreeAmounts: ReportRothTaxFreeRow[];
  expenses: ReportExpense[];
  incomeStreams: ReportIncomeStream[];
  socialSecurity: ReportSocialSecurityMember[];
  scenarios: ReportScenario[];
}

/** Inputs to the pure aggregator — exactly the aggregate slices the
 *  caller has already loaded from IndexedDB. */
export interface BuildReportDataInput {
  household: Aggregate<HouseholdPayload> | undefined;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  /** Annual rows used to derive unstored Roth start-year assumptions. */
  balances?: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  /** Canonical per-account report metrics derived from full balance history.
   *  Optional only for legacy direct callers; ReportPage always supplies it. */
  accountMetricsById?: ReadonlyMap<string, ReportAccountMetrics>;
  /** Legacy direct-caller fallback when `accountMetricsById` is absent. */
  currentBalanceByAccountId?: ReadonlyMap<string, number>;
  /** Legacy direct-caller pre-tax fallback. */
  currentBalancePreTaxById?: ReadonlyMap<string, number | null>;
  /** Legacy direct-caller post-tax fallback. */
  currentBalancePostTaxById?: ReadonlyMap<string, number | null>;
  /** Year of the latest balance row per account id (the balance "as of" year).
   *  Optional — absent → every account's `balanceAsOfYear` is `null`. */
  currentBalanceAsOfYearById?: ReadonlyMap<string, number>;
  /** Calendar date (`YYYY-MM-DD`) of the latest balance row per account id —
   *  the "Balance as of" date the user entered. Optional — absent → every
   *  account's `balanceAsOfDate` is `null`. */
  currentBalanceAsOfDateById?: ReadonlyMap<string, string>;
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  expenseCategoryNameById: ReadonlyMap<string, string>;
  /** Flag-derived medical category ids. The caller (`ReportPage`, which
   *  holds the full `categories`) computes this via `medicalCategoryIdsFrom`
   *  — `expenseCategoryNameById` is a name map and cannot derive `isMedical`.
   *  Each id renders a `general + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT` row
   *  (unless explicitly overridden) and is excluded from the generic
   *  remaining-rates loop. Absent ⇒ the seeded `cat-medical` legacy default. */
  medicalCategoryIds?: ReadonlyArray<string>;
  incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  socialSecurity: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  scenarios: ReadonlyArray<ScenarioAggregate>;
  /** Scenario whose resolved values drive the overview / account return
   *  rates / SS claim ages (the page's selected scenario, or the base). */
  activeScenarioId: string;
}

// The report's legal disclaimer (`REPORT_DISCLAIMER`) moved to
// `disclaimer-fragments.ts` (the shared point-of-use disclaimer home) and was
// rewritten for its true third-party-reader audience (E-4). Import it there.

// ---------- Scenario override summaries ----------

/** Notable-name cap so the summary stays scannable in print. */
const NOTABLE_NAME_LIMIT = 4;

/**
 * Count + name a scenario's OWN expense overrides (not the resolved
 * chain) — the scenario's `overrides.expenses` section. `added` carries
 * full payloads (names available directly); `disabledIds` / `patches`
 * reference canonical ids, so canonical names are looked up from
 * `expenseNameById`. Unknown ids are skipped from the name list but still
 * counted.
 */
function summariseExpenseOverrides(
  overrides: ScenarioOverrides,
  expenseNameById: ReadonlyMap<string, string>,
): ReportExpenseOverrideSummary {
  const section = overrides.expenses;
  const disabledCount = section?.disabledIds?.length ?? 0;
  const addedCount = section?.added?.length ?? 0;
  const patchedCount = section?.patches ? Object.keys(section.patches).length : 0;

  const names: string[] = [];
  for (const a of section?.added ?? []) {
    if (a.name) names.push(a.name);
  }
  for (const rawId of Object.keys(section?.patches ?? {})) {
    const name = lookupCanonicalName(rawId, expenseNameById);
    if (name) names.push(name);
  }
  return {
    disabledCount,
    addedCount,
    patchedCount,
    notableNames: names.slice(0, NOTABLE_NAME_LIMIT),
  };
}

// ---------- SS benefit estimate ----------

/** Monthly benefit at the resolved claim age for one member, or `null`
 *  when no PIA or no usable birthdate. Pure — reuses the SSA formulas. */
function monthlyBenefitEstimate(
  member: Aggregate<HouseholdMemberPayload> | undefined,
  pia: number | null,
  claimAgeYears: number,
  benefitReductionPct = 0,
): number | null {
  if (member === undefined || pia === null) return null;
  const birthdate = member.payload.birthdate?.trim();
  if (!birthdate) return null;
  try {
    const fraMonths = fraMonthsForBirthdate(birthdate);
    const raw = monthlyBenefitAtAge(pia, fraMonths, claimAgeYears * 12);
    return benefitReductionPct > 0 ? raw * (1 - benefitReductionPct / 100) : raw;
  } catch {
    // Birth year outside the supported FRA table — skip the estimate
    // rather than throw (the aggregator must never blow up the page).
    return null;
  }
}

// ---------- Scenario settings (for the PDF Scenario page) ----------
// The settings builder itself (`buildScenarioSettings`) lives in
// `report-scenario-settings.ts`; imported
// back below. Only the absent-input fallback used by `buildReportData`
// itself stays here.

/** Legacy seeded "Medical" category id, used ONLY as the absent-input
 *  fallback (back-compat) when no flag-derived `medicalCategoryIds` array is
 *  supplied. Inlined as a literal so this pure aggregator does not import the
 *  store-backed bootstrap module. `ReportPage` always supplies the resolved
 *  array, so this fallback is defensive. */
const DEFAULT_REPORT_MEDICAL_CATEGORY_ID = 'cat-medical';

/**
 * One account's tax-detail readiness for the report, derived from the
 * SAME `taxProfileCompleteness` / blocker helpers the editor and the accounts list
 * use, so the three surfaces cannot disagree about whether a fact is recorded.
 *
 * Returns a spreadable fragment: `{}` for a type that carries no Roth /
 * required-withdrawal facts, so those accounts' report rows are unchanged.
 */
function buildReportAccountTaxProfile(
  payload: AccountPayload,
  householdBeneficiaryBirthdate?: string,
): { taxProfile?: ReportAccountTaxProfile } {
  const completeness = taxProfileCompleteness(payload, householdBeneficiaryBirthdate);
  if (completeness === 'notApplicable') return {};
  return {
    taxProfile: {
      completeness,
      blockers:
        completeness === 'blocked'
          ? [
              ...rmdBlockerMessages(
                readTaxProfileDraft(payload),
                payload.type,
                householdBeneficiaryBirthdate,
              ),
            ]
          : [],
      inheritedRothZeroRequired:
        completeness !== 'blocked' && isInheritedPureRothAccount(payload),
    },
  };
}

/**
 * The standing Roth / required-withdrawal disclosures that belong
 * beside every such figure in an exported report. Always present, so a retained
 * limitation or a conservative default is never presented as a modeled fact.
 */
function buildTaxProfileDisclosures(
  accounts: readonly ReportAccount[],
  accountAssumptions: readonly string[],
): string[] {
  const disclosures = [
    'Roth withdrawals follow the legal ordering rules: a Roth IRA you opened yourself draws your contributions first, then each conversion in the order it happened, then growth; withdrawals from an inherited Roth IRA are treated as entirely tax-free; an employer Roth plan draws contributions and growth in proportion instead.',
    "An owner's own Roth IRAs share their earliest supported start year. Within each account, a recorded year takes priority over qualifying balance history, and with no support anywhere in the applicable pool the five-year holding rule is treated as unmet. These cautious defaults can overstate tax and penalty, never understate them.",
    'Required withdrawals use the IRS life-expectancy tables for the situation each account records. These are planning estimates, not tax advice or instructions for a specific withdrawal.',
    ...accountAssumptions,
  ];
  const inheritedRoth = accounts.filter((a) => a.taxProfile?.inheritedRothZeroRequired === true);
  if (inheritedRoth.length > 0) {
    disclosures.push(
      `These inherited accounts are entirely Roth, so the projection models no required-withdrawal amount for them (a Roth distribution is not taxed, and this planner does not track how much of it would count toward the yearly requirement): ${inheritedRoth
        .map((a) => a.name)
        .join(
          ', ',
        )}. IRS rules may still require a withdrawal from these accounts each year.`,
    );
  }
  return disclosures;
}

/**
 * The filing assumptions the projections used for one
 * scenario, plus the standing disclosures.
 *
 * Derived from `summarizeFilingPlan`, the ONE resolver-backed description every
 * filing surface shares (the editor, this card, and the PDF settings table).
 * The on-screen card and the PDF used to build the same prose independently and
 * already disagreed: for an unresolved two-member legacy `Single` scalar this
 * card claimed "one joint return while both spouses are alive" while the engine
 * — and the PDF — filed `Single`.
 */
function buildFilingAssumptions(
  resolved: ScenarioOverrides,
  hasSecondary: boolean,
): ReportFilingAssumptions {
  const summary = summarizeFilingPlan({
    taxFilingPlan: resolved.taxFilingPlan,
    filingStatusOverride: resolved.filingStatus,
    hasSecondaryMember: hasSecondary,
  });

  const disclosures = [
    'Federal income tax only. State and local income tax are not modeled.',
    'The standard deduction is used every year, including the age-65 add-on and the senior bonus deduction. Itemized deductions, the alternative minimum tax, and the qualified-business-income deduction are not modeled, so a household that itemizes may owe less than shown.',
    'Filing treatment is an estimate based on the choices entered here, not tax advice or a filing recommendation.',
  ];
  if (summary.units.length > 1) {
    // Separate returns split the household's money between two returns.
    // Everything the projection can trace to an owner (each account's
    // withdrawals and interest, each spouse's own Social Security) goes on that
    // owner's return; anything it cannot trace to one owner is divided evenly.
    disclosures.push(
      'With separate returns, money the projection can trace to an owner — each account\u2019s withdrawals and interest, and each spouse\u2019s own Social Security — is reported on that spouse\u2019s return. Anything it cannot trace to one owner is divided evenly between the two returns, so a return\u2019s individual figures are an estimate even though the household totals are exact.',
    );
  }
  if (summary.unresolvedLegacyDetail !== undefined) {
    disclosures.push(
      'This scenario still uses an older filing setting that could not be read for both spouses, so the projections kept using it unchanged.',
    );
  }
  return {
    whileBothAlive: summary.whileBothAlive,
    afterADeath: summary.afterADeath ?? 'Not applicable \u2014 no spouse in this plan.',
    ...(summary.unresolvedLegacyDetail !== undefined
      ? { unresolvedLegacyDetail: summary.unresolvedLegacyDetail }
      : {}),
    disclosures,
  };
}

/**
 * The health-coverage assumptions the projections used for
 * one scenario, plus the standing disclosures. Derived from the SAME resolved
 * overrides the engines read, so the report cannot describe a setting the
 * projection did not use.
 */
export function buildHealthAssumptions(
  resolved: ScenarioOverrides,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): ReportHealthAssumptions {
  const optedOut = new Set(resolved.acaMarketplaceOptOutMemberIds ?? []);
  const onMarketplace = members.filter((m) => !optedOut.has(m.id)).map((m) => memberName(m, 'Primary'));
  const otherCoverage = members
    .filter((m) => optedOut.has(m.id))
    .map((m) => memberName(m, 'Spouse'));
  const coverageParts: string[] = [];
  if (onMarketplace.length > 0) {
    coverageParts.push(
      `Modeled on a Marketplace plan before Medicare: ${onMarketplace.join(', ')}`,
    );
  }
  if (otherCoverage.length > 0) {
    coverageParts.push(
      `Modeled with other coverage (no subsidy estimated): ${otherCoverage.join(', ')}`,
    );
  }

  // The stored array arrives from an envelope-only-validated import, so
  // it is walked through the ONE shared shape-checking enumerator rather than
  // spread directly (a non-array payload threw out of the whole Report build).
  const benchmarkYears = storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark).map(
    (o) => o.taxYear,
  );
  // State the proration contract the modal and the input
  // contract both carry: the entered figure is a WHOLE-YEAR price, and a year
  // with part-year Marketplace coverage is charged the matching share of it.
  // Saying only that the price "is used" left the one surface the user checks
  // their entry against silent on what the projection actually charges.
  const benchmarkPrice =
    benchmarkYears.length > 0
      ? `Your own benchmark plan price is used for ${benchmarkYears.join(', ')}. It is a whole-year price, so a year with only part-year Marketplace coverage is charged the matching share of it. Every other year uses the rough estimate.`
      : 'The rough estimate is used every year — no benchmark plan price was entered.';

  const statedYears = statedCoverageYears(resolved.healthCoverageMonths);
  const coverageMonths =
    statedYears.length > 0
      ? `Coverage months were entered for ${statedYears.join(', ')}. Every other year uses the projection’s own timing.`
      : 'No coverage months were entered — Medicare Part B and Part D are assumed to start in the month you turn 65 (the month before, if your birthday is the first of a month), and anyone retired before then is assumed to be on a Marketplace plan for the rest of the year.'

  return {
    marketplaceCoverage:
      coverageParts.join('. ') || 'No household members are modeled on a Marketplace plan.',
    povertyGuidelines: fplRegionReportLabel(resolved.acaFplRegion),
    benchmarkPrice,
    coverageMonths,
    disclosures: [
      // The price, reference age, growth rate and base year are interpolated from
      // `ROUGH_BENCHMARK_ASSUMPTIONS`, the single source of truth the engine
      // prices from, so a recalibration can never leave this disclosure quoting
      // a number the projection no longer charges.
      `The Marketplace subsidy is a rough estimate. Unless you entered a benchmark plan price, the projection prices a benchmark plan at $${ROUGH_BENCHMARK_ASSUMPTIONS.baseMonthlyDollars.toLocaleString('en-US')} a month for a ${ROUGH_BENCHMARK_ASSUMPTIONS.baseAge}-year-old, rising ${Math.round(ROUGH_BENCHMARK_ASSUMPTIONS.ageGrowthRate * 100)}% for each year of age, counted for each covered person and only for the months they are covered. From ${ROUGH_BENCHMARK_ASSUMPTIONS.baseYear}, the estimate grows every year at the scenario\u2019s medical inflation rate. A benchmark plan price you entered is used exactly as entered. It is not a quote from an exchange.`,
      'Only the Medicare income-related monthly adjustment amount (IRMAA) is estimated. The base Medicare premium and any Medigap, Medicare Advantage, or drug-plan premiums must be entered as Medical expenses (the Expenses page can add the standard Part B and Part D amounts for you, and your actual Part D plan price, Medigap and Medicare Advantage premiums stay yours to enter); if they are missing, this plan understates your health costs.',
      'Health coverage figures are planning estimates, not an eligibility determination or an offer of coverage.',
    ],
  };
}

// ---------- Main aggregator ----------

export function buildReportData(input: BuildReportDataInput, now: Date): ReportData {
  const {
    household,
    members,
    accounts,
    balances = [],
    currentBalanceByAccountId = new Map<string, number>(),
    currentBalancePreTaxById = new Map<string, number | null>(),
    currentBalancePostTaxById = new Map<string, number | null>(),
    expenses,
    expenseCategoryNameById,
    medicalCategoryIds,
    incomeStreams,
    socialSecurity,
    scenarios,
    activeScenarioId,
  } = input;
  // Apply the absent/legacy-default boundary identically to the engine
  // consumers: absent ⇒ seeded `cat-medical`; forbidden ids dropped
  // (CWE-1321 — `categoryRates` is indexed as a plain object below). Inlined
  // (not the `medicalCategoryIdSet` adapter) so this pure aggregator does not
  // import the store-backed bootstrap module; the caller (`ReportPage`)
  // computes the flag-derived array via `medicalCategoryIdsFrom`.
  const medicalIdSet = new Set(
    (medicalCategoryIds ?? [DEFAULT_REPORT_MEDICAL_CATEGORY_ID]).filter(
      (id) => !DANGEROUS_CATEGORY_RATE_KEYS.has(id),
    ),
  );

  const memberList = [...members];
  const liveAccounts = accounts.filter((account) => !account.deletedAt);
  const primary = memberList.find((m) => m.payload.isPrimary);
  const secondary = memberList.find((m) => !m.payload.isPrimary);
  const hasSecondary = secondary !== undefined;

  const resolvedActive = resolveScenario(activeScenarioId, [...scenarios]);
  const activeReturns = resolveAccountReturnsForScenario(
    activeScenarioId,
    [...scenarios],
    liveAccounts.map((a) => ({ id: a.id, payload: a.payload })),
  );
  const resolvedContributions = resolveAccountContributionsForScenario(
    activeScenarioId,
    [...scenarios],
    liveAccounts.map((a) => ({ id: a.id, payload: a.payload })),
  );
  const stopContributions = resolvedActive.contributions?.stopContributionsToday ?? false;
  const benefitReductionPct = resolvedActive.socialSecurity?.benefitReductionPct ?? 0;

  const expenseNameById = new Map<string, string>();
  const expenseById = new Map<string, ExpensePayload>();
  for (const e of expenses) {
    expenseNameById.set(e.id, e.payload.name);
    expenseById.set(e.id, e.payload);
  }

  // Resolve expense and income inventories for the active scenario so
  // scenario-disabled rows are hidden, added rows are visible, and patches
  // (amount, schedule, glide) are applied before building the report slices.
  const resolvedExpenses = resolveExpensesForScenario(activeScenarioId, [...scenarios], [...expenses]);
  const resolvedIncome = resolveIncomeForScenario(activeScenarioId, [...scenarios], [...incomeStreams]);
  const activeRetire = retirementAges(resolvedActive);
  const secondaryRetireAge = activeRetire.secondary ?? {
    years: DEFAULT_RETIREMENT_AGE_YEARS,
    months: 0,
  };
  const snappedRetireDates = resolveMemberRetirementDates(
    {
      primary: {
        ageYears: activeRetire.primary.years,
        ageMonths: activeRetire.primary.months,
      },
      secondary: {
        ageYears: secondaryRetireAge.years,
        ageMonths: secondaryRetireAge.months,
      },
      ...(resolvedActive.retirementAge?.sameDateAnchor
        ? { sameDateAnchor: resolvedActive.retirementAge.sameDateAnchor }
        : {}),
    } satisfies RetirementAgeResolved,
    memberList.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate?.trim() ?? '',
    })),
  );
  const expenseScheduleContext = buildExpenseProjectionContext({
    resolved: resolvedActive,
    primary: primary?.payload ?? null,
    secondary: secondary?.payload ?? null,
    primaryRetirementIso:
      (primary ? snappedRetireDates.get(primary.id) : null) ?? '',
  });

  // ----- Accounts -----
  const reportMemberById = new Map(
    memberList
      .filter((member) => !member.deletedAt)
      .map((member) => [member.id, member.payload]),
  );
  const reportAccounts: ReportAccount[] = liveAccounts.map((a) => {
    const metric = input.accountMetricsById?.get(a.id);
    return {
      id: a.id,
      name: a.payload.name,
      ownerDisplayName:
        metric?.ownerDisplayName ??
        reportAccountOwnerDisplayName(a.payload, reportMemberById),
      type: a.payload.type,
      taxTreatment: a.payload.taxTreatment,
      assetMix: a.payload.assetMix,
      historicalReturnPct: metric?.historicalReturnPct ?? null,
      totalContributions: metric?.totalContributions ?? 0,
      totalGains: metric?.totalGains ?? 0,
      currentBalance:
        metric?.currentBalance ?? currentBalanceByAccountId.get(a.id) ?? 0,
      currentBalancePreTax: metric
        ? metric.currentBalancePreTax
        : (currentBalancePreTaxById.get(a.id) ?? null),
      currentBalancePostTax: metric
        ? metric.currentBalancePostTax
        : (currentBalancePostTaxById.get(a.id) ?? null),
      currentBalanceTaxFree: metric?.currentBalanceTaxFree ?? null,
      plannedContributionPreTax: stopContributions
        ? 0
        : (resolvedContributions.get(a.id)?.plannedContributionPreTax ??
          a.payload.plannedContributionPreTax),
      plannedContributionPostTax: stopContributions
        ? 0
        : (resolvedContributions.get(a.id)?.plannedContributionPostTax ??
          a.payload.plannedContributionPostTax),
      configuredReturnPct: activeReturns.get(a.id) ?? a.payload.planningReturnPct,
      balanceAsOfYear: metric
        ? metric.balanceAsOfYear
        : (input.currentBalanceAsOfYearById?.get(a.id) ?? null),
      balanceAsOfDate: metric
        ? metric.balanceAsOfDate
        : (input.currentBalanceAsOfDateById?.get(a.id) ?? null),
      ...buildReportAccountTaxProfile(
        a.payload,
        reportMemberById.get(a.payload.ownerId)?.birthdate,
      ),
    };
  });
  const taxProfileAssumptions = buildReportTaxProfileAssumptions({
    accounts: liveAccounts,
    balances,
    members: memberList,
  });

  const totalCurrentPortfolio = reportAccounts.reduce(
    (sum, a) => sum + a.currentBalance,
    0,
  );
  const annualContributionRunRate = reportAccounts.reduce(
    (sum, a) => sum + a.plannedContributionPreTax + a.plannedContributionPostTax,
    0,
  );

  // ----- Expenses -----
  // `resolvedExpenses` uses scenario-resolved inventory: disabled rows are
  // excluded, added rows are included, patches are merged into the payload.
  const reportExpenses: ReportExpense[] = resolvedExpenses.map((e) => {
    const orderMonths = resolveReportExpenseOrderMonths(
      e.payload,
      expenseScheduleContext,
    );
    return {
      id: e.id,
      name: e.payload.name,
      categoryName: expenseCategoryNameById.get(e.payload.categoryId) ?? 'Uncategorized',
      classification: e.payload.classification,
      frequency: e.payload.frequency,
      annualAmount: annualExpenseAmount(e.payload),
      ...orderMonths,
      startLabel: describeGlideAnchorFreeStart(e.payload, memberList),
      endLabel: describeExpenseEndLabel(e.payload, memberList),
      glideSummary: buildGlideSummary(e.payload, memberList),
    };
  });

  // ----- Income -----
  // `resolvedIncome` uses scenario-resolved inventory: disabled streams are
  // excluded, added streams are included, patches are merged into the payload.
  const memberById = new Map<string, Aggregate<HouseholdMemberPayload>>();
  for (const m of memberList) memberById.set(m.id, m);
  const reportIncome: ReportIncomeStream[] = resolvedIncome.map((s) => {
    const owner = memberById.get(s.payload.memberId);
    return {
      id: s.id,
      name: s.payload.name,
      kind: s.payload.kind,
      memberName: memberName(owner, '(unknown member)'),
      ownerSortRank: owner ? (owner.payload.isPrimary ? 0 : 1) : 2,
      annualAmount: annualizeIncome(s.payload),
      scheduleLabel: formatIncomeSchedule(s.payload, memberList),
      colaPct: s.payload.tracksInflation ? null : (s.payload.colaPct ?? null),
      tracksInflation: s.payload.tracksInflation === true,
    };
  });

  // ----- Social Security -----
  const activeClaim = ssClaimAges(resolvedActive, hasSecondary);
  const piaByMemberId = new Map<string, number | null>();
  for (const ss of socialSecurity) {
    piaByMemberId.set(ss.payload.householdMemberId, ss.payload.pia ?? null);
  }
  const reportSs: ReportSocialSecurityMember[] = [];
  if (primary) {
    const pia = piaByMemberId.get(primary.id) ?? null;
    reportSs.push({
      role: 'primary',
      name: memberName(primary, 'Primary'),
      pia,
      claimAgeYears: activeClaim.primary,
      monthlyBenefitAtClaim: monthlyBenefitEstimate(primary, pia, activeClaim.primary, benefitReductionPct),
    });
  }
  if (secondary) {
    const pia = piaByMemberId.get(secondary.id) ?? null;
    const claim = activeClaim.secondary ?? DEFAULT_SS_CLAIM_AGE_YEARS;
    reportSs.push({
      role: 'secondary',
      name: memberName(secondary, 'Secondary'),
      pia,
      claimAgeYears: claim,
      monthlyBenefitAtClaim: monthlyBenefitEstimate(secondary, pia, claim, benefitReductionPct),
    });
  }

  // ----- Overview: first-year SS + recurring income estimate -----
  const annualSs = reportSs.reduce(
    (sum, m) => sum + (m.monthlyBenefitAtClaim ?? 0) * 12,
    0,
  );
  const annualRecurringIncome = reportIncome.reduce(
    (sum, s) => sum + s.annualAmount,
    0,
  );
  const overviewMembers: ReportMemberOverview[] = [];
  // Materialise per-member dates through the shared snap helper so a
  // "same-date" scenario (e.g. "both retire at primary") lands both members
  // on the SAME calendar month here — recomputing each member's date
  // independently from their own birthday-of-month would drift them up to
  // ~30 days apart (see the same-date precision rule in `retirement-date-math.ts`).
  const retireYearMonth = (
    id: string,
  ): { year: number | null; month: number | null } => {
    const iso = snappedRetireDates.get(id);
    if (!iso) return { year: null, month: null };
    const [y, mo] = iso.split('-').map(Number);
    return Number.isFinite(y) && Number.isFinite(mo)
      ? { year: y, month: mo }
      : { year: null, month: null };
  };
  if (primary) {
    const rd = retireYearMonth(primary.id);
    overviewMembers.push({
      role: 'primary',
      name: memberName(primary, 'Primary'),
      currentAge: currentAgeOfRole('primary', memberList, now) ?? null,
      retirementAge: activeRetire.primary,
      retirementYear: rd.year,
      retirementMonth: rd.month,
    });
  }
  if (secondary) {
    const rd = retireYearMonth(secondary.id);
    overviewMembers.push({
      role: 'secondary',
      name: memberName(secondary, 'Secondary'),
      currentAge: currentAgeOfRole('secondary', memberList, now) ?? null,
      retirementAge: secondaryRetireAge,
      retirementYear: rd.year,
      retirementMonth: rd.month,
    });
  }

  const overview: ReportHouseholdOverview = {
    // Empty string when no household name is set — the Report page's
    // `householdName ? … : 'Retirement Report'` guard renders the
    // documented fallback heading uniformly for null-data and unnamed
    // households.
    householdName: household?.payload.name?.trim() || '',
    members: overviewMembers,
    totalCurrentPortfolio,
    annualContributionRunRate,
    estimatedAnnualOtherIncome: annualSs + annualRecurringIncome,
  };

  // ----- Scenarios -----
  const accountNameById = new Map<string, string>();
  const accountById = new Map<string, AccountPayload>();
  for (const a of accounts) {
    accountNameById.set(a.id, a.payload.name);
    accountById.set(a.id, a.payload);
  }
  const incomeNameById = new Map<string, string>();
  const incomeById = new Map<string, IncomeStreamPayload>();
  for (const s of incomeStreams) {
    incomeNameById.set(s.id, s.payload.name);
    incomeById.set(s.id, s.payload);
  }

    const reportScenarios: ReportScenario[] = scenarios.map((sc) => {
    const resolved = resolveScenario(sc.id, [...scenarios]);
    const resolvedQcdEntries = resolveQcdForScenario(
      sc.id,
      [...scenarios],
      accounts.map((a) => ({ id: a.id, payload: a.payload })),
      memberList,
    ).entries;
    // Resolved effective floors (own + inherited chain) over LIVE accounts —
    // the builder filters to the accounts the engine actually floors.
    const resolvedFloors = resolveAccountFloorsForScenario(
      sc.id,
      [...scenarios],
      liveAccounts.map((a) => ({ id: a.id, payload: a.payload })),
    );
    const retire = retirementAges(resolved);
    const claim = ssClaimAges(resolved, hasSecondary);
    const kind = withdrawalStrategyKind(resolved);
    const customTiers: string[][] | null =
      kind === 'customOrder' && resolved.customDrawdownOrder
        ? resolved.customDrawdownOrder.tiers.map((tier) =>
            tier.map((id) => accountNameById.get(id) ?? id),
          )
        : null;
    const knobs = resolvedKnobs(resolved);
    const expenseOverrides = summariseExpenseOverrides(sc.payload.overrides, expenseNameById);
    const memberNames = {
      primary: memberName(primary, 'Primary'),
      ...(hasSecondary ? { secondary: memberName(secondary, 'Secondary') } : {}),
    };
    return {
      id: sc.id,
      name: sc.payload.name,
      description: sc.payload.description,
      notes: sc.payload.notes,
      isPrimary: sc.payload.isPrimary,
      retirementAge: retire,
      ssClaimAgeYears: claim,
      withdrawalStrategyKind: kind,
      memberNames,
      customWithdrawalTiers: customTiers,
      knobs,
      expenseOverrides,
      filingAssumptions: buildFilingAssumptions(resolved, hasSecondary),
      healthAssumptions: buildHealthAssumptions(resolved, memberList),
      marketStressAssumptions: buildMarketStressAssumptions(),
      settingGroups: buildScenarioSettings({
        resolved,
        ownOverrides: sc.payload.overrides,
        members: memberList,
        hasSecondary,
        memberNames,
        retire,
        claim,
        kind,
        customTiers,
        accountById,
        accountNameById,
        expenseNameById,
        expenseById,
        incomeNameById,
        incomeById,
        categoryNameById: expenseCategoryNameById,
        medicalCategoryIds: medicalIdSet,
        qcdEntries: resolvedQcdEntries,
        accountFloors: resolvedFloors,
      }),
    };
  });

  return {
    overview,
    accounts: reportAccounts,
    taxProfileDisclosures: buildTaxProfileDisclosures(
      reportAccounts,
      taxProfileAssumptions,
    ),
    rothTaxFreeAmounts: buildRothTaxFreeRows({
      accounts: liveAccounts,
      balances,
      members: memberList,
    }),
    expenses: reportExpenses,
    incomeStreams: reportIncome,
    socialSecurity: reportSs,
    scenarios: reportScenarios,
  };
}
