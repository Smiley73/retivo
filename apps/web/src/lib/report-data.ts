/**
 * Pure synchronous aggregator for the CFP Report page: assembles every non-projection, non-Monte-Carlo slice of household data into one `ReportData`.
 * The balance-projection run and the Monte Carlo cache lookup are async and live in the component layer.
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
import { ROUGH_BENCHMARK_ASSUMPTIONS } from './aca-ptc';
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
import {
  DEFAULT_RETIREMENT_AGE_YEARS,
  DEFAULT_SS_CLAIM_AGE_YEARS,
  annualExpenseAmount,
  buildGlideSummary,
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
  /** Planned annual pre-tax + post-tax contributions, scenario-resolved across every account. */
  annualContributionRunRate: number;
  /**
   * Run-rate estimate of annualised Social Security at each member's resolved claim age plus
   * annualised recurring income; not gated by start date, so it is an indicator, not a first-year
   * cash-flow model.
   */
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
  /**
   * Latest balance routed to the pre-tax bucket, or `null` when not applicable to this tax
   * treatment.
   */
  currentBalancePreTax: number | null;
  /** Latest balance routed to the taxable post-tax bucket, or `null` when not applicable. */
  currentBalancePostTax: number | null;
  /** Latest tax-free balance, or `null` when not applicable. */
  currentBalanceTaxFree: number | null;
  plannedContributionPreTax: number;
  plannedContributionPostTax: number;
  /** Scenario-resolved configured annual planning return rate (%). */
  configuredReturnPct: number;
  /** Year of the latest balance (the "as of" year), or `null` with no balance history. */
  balanceAsOfYear: number | null;
  /**
   * Calendar date (`YYYY-MM-DD`) of the latest balance, preferred over `balanceAsOfYear` for
   * display; `null` when not recorded.
   */
  balanceAsOfDate: string | null;
  /**
   * Roth / required-withdrawal tax-detail readiness, so an exported report never presents a
   * cautious default as a modeled fact; undefined for account types without such facts.
   */
  taxProfile?: ReportAccountTaxProfile;
}

interface ReportAccountTaxProfile {
  completeness: 'complete' | 'partial' | 'blocked';
  blockers: string[];
  // Inherited, wholly Roth-treated accounts net to a $0 required-withdrawal base under the shared
  // §325 convention (`rmdDeclaredRothPortionCents` in rmd.ts) though a real minimum still applies;
  // never true when `blocked`.
  inheritedRothZeroRequired: boolean;
}

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
  /** Plain-English glide-path summary, or `null` when there is no active discretionary glide. */
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
  /** `true` when the stream grows with scenario inflation instead of a fixed COLA. */
  tracksInflation: boolean;
}

interface ReportSocialSecurityMember {
  role: 'primary' | 'secondary';
  name: string;
  pia: number | null;
  claimAgeYears: number;
  monthlyBenefitAtClaim: number | null;
}

interface ReportExpenseOverrideSummary {
  disabledCount: number;
  addedCount: number;
  patchedCount: number;
  notableNames: string[];
}

// Present for every scenario, so the report never implies a retained limitation is modeled.
interface ReportFilingAssumptions {
  whileBothAlive: string;
  afterADeath: string;
  // Set when the scenario carries a legacy filing setting that cannot be converted; projections
  // keep using it, and the report must say so.
  unresolvedLegacyDetail?: string;
  disclosures: string[];
}

// Present for every scenario, so an exported report never implies the rough benchmark is a real
// exchange quote or that the base Medicare premium is modeled.
interface ReportHealthAssumptions {
  marketplaceCoverage: string;
  povertyGuidelines: string;
  benchmarkPrice: string;
  coverageMonths: string;
  disclosures: string[];
}

interface ReportMarketStressAssumptions {
  cases: ReadonlyArray<{ name: string; changed: string }>;
  disclosures: string[];
}

// Names and magnitudes come from `STRESS_CASE_COPY`, the map the on-screen comparison reads, so
// print and screen cannot differ.
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
  notes: string;
  isPrimary: boolean;
  retirementAge: { primary: AgeYearsMonths; secondary?: AgeYearsMonths };
  // Always present (inherited or default-filled), so the page shows the effective value.
  ssClaimAgeYears: { primary: number; secondary?: number };
  withdrawalStrategyKind: string;
  memberNames: { primary: string; secondary?: string };
  customWithdrawalTiers: string[][] | null;
  knobs: ReportScenarioKnobs;
  expenseOverrides: ReportExpenseOverrideSummary;
  filingAssumptions: ReportFilingAssumptions;
  healthAssumptions: ReportHealthAssumptions;
  marketStressAssumptions: ReportMarketStressAssumptions;
  settingGroups: ReportScenarioSettingGroup[];
}

export interface ReportData {
  overview: ReportHouseholdOverview;
  accounts: ReportAccount[];
  /**
   * Standing Roth / required-withdrawal disclosures, including accounts on a cautious default or
   * with a withheld estimate.
   */
  taxProfileDisclosures: string[];
  /**
   * One row per person's own Roth-IRA §408A pool, then per employer designated-Roth plan, from the
   * same engine call as the projections (`buildRothTaxFreeRows`); PDF-only.
   */
  rothTaxFreeAmounts: ReportRothTaxFreeRow[];
  expenses: ReportExpense[];
  incomeStreams: ReportIncomeStream[];
  socialSecurity: ReportSocialSecurityMember[];
  scenarios: ReportScenario[];
}

/** Aggregate slices the caller has already loaded from IndexedDB. */
export interface BuildReportDataInput {
  household: Aggregate<HouseholdPayload> | undefined;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  /** Annual rows used to derive unstored Roth start-year assumptions. */
  balances?: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  /**
   * Canonical per-account report metrics from full balance history; optional only for legacy direct
   * callers.
   */
  accountMetricsById?: ReadonlyMap<string, ReportAccountMetrics>;
  /** Legacy direct-caller fallback when `accountMetricsById` is absent. */
  currentBalanceByAccountId?: ReadonlyMap<string, number>;
  /** Legacy direct-caller pre-tax fallback. */
  currentBalancePreTaxById?: ReadonlyMap<string, number | null>;
  /** Legacy direct-caller post-tax fallback. */
  currentBalancePostTaxById?: ReadonlyMap<string, number | null>;
  /** Year of the latest balance row per account id; absent means `balanceAsOfYear` is `null`. */
  currentBalanceAsOfYearById?: ReadonlyMap<string, number>;
  /**
   * Date (`YYYY-MM-DD`) of the latest balance row per account id; absent means `balanceAsOfDate` is
   * `null`.
   */
  currentBalanceAsOfDateById?: ReadonlyMap<string, string>;
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  expenseCategoryNameById: ReadonlyMap<string, string>;
  /**
   * Flag-derived medical category ids from `medicalCategoryIdsFrom` (a name map cannot derive
   * `isMedical`); each renders a `general + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT` row unless
   * overridden. Absent means the seeded `cat-medical`.
   */
  medicalCategoryIds?: ReadonlyArray<string>;
  incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  socialSecurity: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  scenarios: ReadonlyArray<ScenarioAggregate>;
  /** Scenario whose resolved values drive the overview, account returns and SS claim ages. */
  activeScenarioId: string;
}

// ---------- Scenario override summaries ----------

const NOTABLE_NAME_LIMIT = 4;

// Counts the scenario's own overrides, not the resolved chain; unknown ids are counted but skipped
// from the name list.
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
    // A birth year outside the FRA table skips the estimate; the aggregator must never blow up the
    // page.
    return null;
  }
}

// Fallback when no flag-derived `medicalCategoryIds` is supplied (ReportPage always supplies it); a
// literal, so this pure module imports nothing store-backed.
const DEFAULT_REPORT_MEDICAL_CATEGORY_ID = 'cat-medical';

// Uses the same `taxProfileCompleteness` and blocker helpers as the editor and accounts list, so
// the surfaces cannot disagree; `{}` for types without Roth / required-withdrawal facts.
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

// Derived from `summarizeFilingPlan`, the one resolver-backed description every filing surface
// shares, so the card and the PDF cannot describe filing differently.
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
    // With separate returns, money traceable to an owner goes on that owner's return and the rest
    // is split evenly.
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
 * Health-coverage assumptions the projections used for one scenario, from the same resolved
 * overrides the engines read, plus the standing disclosures.
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

  // Imported data is only envelope-validated, so read the array through the shared shape-checking
  // enumerator (a non-array must not throw).
  const benchmarkYears = storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark).map(
    (o) => o.taxYear,
  );
  // The entered figure is a whole-year price, and a year with part-year Marketplace coverage is
  // charged the matching share; say so.
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
      // Interpolated from `ROUGH_BENCHMARK_ASSUMPTIONS`, the engine's pricing source, so a
      // recalibration cannot leave this quoting a stale number.
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
  // Absent means the seeded `cat-medical`; forbidden ids are dropped (CWE-1321: `categoryRates` is
  // indexed as a plain object below).
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
  // Resolve dates through the shared snap helper so a "same-date" scenario lands both members in
  // the same month (see the same-date precision rule in `retirement-date-math.ts`).
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
    // Empty when no household name is set; ReportPage renders the fallback heading.
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
