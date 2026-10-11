/**
 * Scenario-settings builder for the CFP Report / PDF Scenario page — split
 * out of `report-data.ts` to keep that
 * aggregator under the 800-line shape limit. Pure code motion: no logic
 * changes. `report-data.ts` imports `buildScenarioSettings` (and
 * `lookupCanonicalName`, needed by its own `summariseExpenseOverrides`)
 * back from here.
 */
import type {
  AccountPayload,
  Aggregate,
  AssetMix,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioOverrides,
} from '../db/types';
import {
  DEFAULT_COLA_PCT,
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
  DEFAULT_MEDICAL_INFLATION_SPREAD_PCT,
  isMagiCapDisabled,
} from '../db/types';
import { summarizeFilingPlan } from './filing-status';
import { describeStart, describeEnd } from './schedule-format';
import { isFloorEligibleTreatment } from './drawdown-engine-per-account-strategy-helpers';
import { compareReportNameThenId } from './report-table-ordering';
import type { ResolvedAccountFloor, ResolvedQcdEntry } from './scenario-resolution';
import { memberName } from './report-format';
import type { AcaFplRegion } from './aca-ptc';
import {
  storedAcaBenchmarkOverrides,
  storedCoverageMonthEntries,
  type StoredHealthCoverageMonths,
} from './tax-integration-helpers';

/** The exported-settings label for each non-default poverty-guideline
 *  schedule. Keyed by the union so a new region is a compile error. */
const FPL_REGION_SETTING_LABELS: Readonly<Record<Exclude<AcaFplRegion, 'contiguous'>, string>> = {
  alaska: 'Alaska',
  hawaii: 'Hawaii',
};

/**
 * The exported-settings label for a stored NON-DEFAULT region, or
 * `undefined` when the stored value is the default or is not a region at all.
 *
 * Read through `Object.hasOwn` (CWE-1321) exactly like `fplRegionReportLabel`
 * below: the value comes off an envelope-only-validated import, and indexing the
 * map directly returned an inherited FUNCTION for `acaFplRegion: "constructor"`
 * (and `undefined` for any other unknown value), either of which then broke the
 * PDF settings table. An unrecognised region is OMITTED — the projection prices
 * it as the contiguous default, which this page reports by saying nothing.
 */
function fplRegionSettingLabel(region: string | undefined): string | undefined {
  return region !== undefined && Object.hasOwn(FPL_REGION_SETTING_LABELS, region)
    ? FPL_REGION_SETTING_LABELS[region as Exclude<AcaFplRegion, 'contiguous'>]
    : undefined;
}

/**
 * The plain-English names of the three HHS poverty-guideline schedules.
 *
 * Typed by the `AcaFplRegion` union so adding a region is a compile error
 * rather than a silent fallback, and read through `Object.hasOwn` (CWE-1321):
 * the stored value reaches this map straight off an imported
 * aggregate, and import hardening rejects `__proto__` / `constructor` only in
 * KEY position — so `acaFplRegion: "constructor"` would otherwise return an
 * inherited FUNCTION, sail past the `??` fallback, and crash the Report render
 * when React tried to use it as a child.
 */
const FPL_REGION_REPORT_LABELS: Readonly<Record<AcaFplRegion, string>> = {
  contiguous: 'The 48 mainland states and Washington, DC',
  alaska: 'Alaska (higher federal poverty guidelines)',
  hawaii: 'Hawaii (higher federal poverty guidelines)',
};

/** The label for a stored region value, own-property-safe. */
export function fplRegionReportLabel(region: string | undefined): string {
  return region !== undefined && Object.hasOwn(FPL_REGION_REPORT_LABELS, region)
    ? FPL_REGION_REPORT_LABELS[region as AcaFplRegion]
    : FPL_REGION_REPORT_LABELS.contiguous;
}

/**
 * The tax years for which ANY member has stated coverage months, sorted
 * ascending (one implementation shared by both report modules).
 *
 * Walks the map through the shared shape-checking
 * `storedCoverageMonthEntries` reader, so an imported `{ perMember: { id: null } }`
 * reads as "nothing stated" instead of throwing out of the Report render and
 * the PDF settings build.
 */
export function statedCoverageYears(
  override: StoredHealthCoverageMonths | undefined,
): number[] {
  const years = new Set<number>();
  for (const entry of storedCoverageMonthEntries(override)) years.add(entry.taxYear);
  return [...years].sort((a, b) => a - b);
}

import { formatAgeYearsMonths, type AgeYearsMonths } from './format-age';

// ---------- Local types ----------

/** One human-readable scenario setting / change for the PDF's Scenario page:
 *  a label and its detail value. Effective (resolved) settings show their value;
 *  per-account / expense / income overrides show the actual change
 *  ("$0 to $5,000"), so the page describes WHAT the scenario does, not a count.
 *  Values are ASCII-only (jsPDF's standard font lacks glyphs like → / ≤). */
interface ReportScenarioSetting {
  label: string;
  value: string;
}

/** A titled group of related scenario settings — rendered as its own small
 *  table on the PDF's Scenario page so no single table is overloaded. */
export interface ReportScenarioSettingGroup {
  title: string;
  rows: ReportScenarioSetting[];
}

// ---------- Canonical-id / name helpers (shared with `report-data.ts`'s
// `summariseExpenseOverrides`, imported back from there) ----------

/** Resolve a prefixed/raw override id to a canonical expense name. Only
 *  `aggregate:<uuid>` / raw ids map to a canonical expense; `local:` ids
 *  are scenario-only adds (named via the `added` payload, handled
 *  separately). */
export function lookupCanonicalName(
  rawId: string,
  expenseNameById: ReadonlyMap<string, string>,
): string | undefined {
  if (rawId.startsWith('local:')) return undefined;
  const id = rawId.startsWith('aggregate:') ? rawId.slice('aggregate:'.length) : rawId;
  return expenseNameById.get(id);
}

/** Strip the override-id prefix to the canonical aggregate id, or `undefined`
 *  for a `local:` (scenario-only) id that has no canonical aggregate. */
function canonicalId(rawId: string): string | undefined {
  if (rawId.startsWith('local:')) return undefined;
  return rawId.startsWith('aggregate:') ? rawId.slice('aggregate:'.length) : rawId;
}

// ---------- Scenario settings (for the PDF Scenario page) ----------

/** Display labels for the resolved withdrawal-strategy kind. */
const WITHDRAWAL_STRATEGY_LABELS: Record<string, string> = {
  taxEfficient: 'Tax-efficient',
  proportional: 'Proportional',
  rothFirst: 'Roth first',
  customOrder: 'Custom order',
};

/** Plain-English, one-line explanation of what each withdrawal strategy does —
 *  surfaced on the Scenario page so a reader (e.g. a financial planner) need
 *  not guess what "Tax-efficient" means. Layman's terms (no jargon). */
const WITHDRAWAL_STRATEGY_DESCRIPTIONS: Record<string, string> = {
  taxEfficient:
    'Draws taxable accounts first, then tax-deferred, then Roth last — an order that tends to carry lower lifetime tax drag, though the actual result depends on your brackets and account mix.',
  proportional:
    'Draws from your non-HSA accounts at the same time, in proportion to each balance, keeping the account mix roughly steady — though the tax impact can still vary year to year rather than staying fixed. HSA money is handled separately.',
  rothFirst: 'Spends Roth (tax-free) accounts first, leaving taxable and tax-deferred accounts for later.',
  customOrder: 'Draws accounts in the custom order set on this scenario (see the tiers below).',
};

/** Default fraction of a taxable (non-Roth) withdrawal treated as long-term
 *  gain / qualified dividend when no scenario in the chain overrides it (see
 *  db/types — `assumedCostBasisFractionOfTaxableWithdrawal` defaults to 0.5). */
const DEFAULT_TAXABLE_LTCG_FRACTION = 0.5;

/** Default share of EMERGENCY HSA withdrawals assumed to be qualified
 *  (tax-free) medical spending when unset — modeled medical-qualified
 *  withdrawals are always 100% qualified (engine default — `tax-integration`
 *  uses 100). */
const DEFAULT_HSA_QUALIFIED_PCT = 100;

/** Whole-dollar formatter for scenario-setting values. */
function settingMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Summarise an expense patch into "what changed" — scalar fields show
 *  old → new (old from the canonical expense when available); schedule /
 *  category changes are noted generically. ASCII-only. */
function describeExpensePatch(
  patch: Record<string, unknown>,
  base: ExpensePayload | undefined,
): string {
  const parts: string[] = [];
  if (typeof patch.name === 'string') parts.push(`renamed to "${patch.name}"`);
  if (typeof patch.amount === 'number') {
    parts.push(
      base ? `amount ${settingMoney(base.amount)} to ${settingMoney(patch.amount)}` : `amount ${settingMoney(patch.amount)}`,
    );
  }
  if (typeof patch.frequency === 'string') {
    parts.push(base ? `frequency ${base.frequency} to ${patch.frequency}` : `frequency ${patch.frequency}`);
  }
  if (typeof patch.classification === 'string') {
    parts.push(base ? `${base.classification} to ${patch.classification}` : String(patch.classification));
  }
  if ('start' in patch || 'end' in patch || 'discretionaryGlide' in patch) parts.push('timing changed');
  if ('categoryId' in patch) parts.push('category changed');
  return parts.join(', ') || 'modified';
}

/** Summarise an income-stream patch into "what changed". ASCII-only. */
function describeIncomePatch(
  patch: Record<string, unknown>,
  base: IncomeStreamPayload | undefined,
): string {
  const parts: string[] = [];
  if (typeof patch.name === 'string') parts.push(`renamed to "${patch.name}"`);
  if (typeof patch.annualAmount === 'number') {
    parts.push(
      base?.annualAmount != null
        ? `annual ${settingMoney(base.annualAmount)} to ${settingMoney(patch.annualAmount)}`
        : `annual ${settingMoney(patch.annualAmount)}`,
    );
  }
  if (typeof patch.monthlyBenefit === 'number') parts.push(`monthly ${settingMoney(patch.monthlyBenefit)}`);
  if (typeof patch.lumpSumAmount === 'number') parts.push(`lump sum ${settingMoney(patch.lumpSumAmount)}`);
  if (typeof patch.kind === 'string') parts.push(base ? `kind ${base.kind} to ${patch.kind}` : `kind ${patch.kind}`);
  if (typeof patch.payoutType === 'string') parts.push(`payout ${patch.payoutType}`);
  if ('start' in patch || 'end' in patch) parts.push('timing changed');
  return parts.join(', ') || 'modified';
}

/**
 * Coverage ledger for the PDF Scenario page. The `satisfies` clause makes
 * `tsc` FAIL the moment a key is added to `ScenarioOverrides` without a
 * decision here — so every future scenario setting is forced into the report
 * (`true` = surfaced by `buildScenarioSettings`; flip to `false` ONLY with a
 * deliberate "intentionally omitted because …" reason). Keep this in lockstep
 * with the `ScenarioOverrides` shape in `db/types.ts`.
 */
export const SCENARIO_SETTING_COVERAGE = {
  retirementAge: true,
  socialSecurity: true,
  filingStatus: true,
  // Tax filing plan — surfaced in the
  // PDF Taxes group: the plan's treatment drives the Filing status row(s), the
  // per-spouse separate-return rows, the lived-together fact, and one row per
  // year-bounded exception window.
  taxFilingPlan: true,
  contributions: true,
  lifeExpectancy: true,
  inflation: true,
  discretionarySpending: true,
  downturnGuardrails: true,
  expenses: true,
  income: true,
  withdrawalStrategy: true,
  customDrawdownOrder: true,
  magiCap: true,
  retirementAllocation: true,
  assumedCostBasisFractionOfTaxableWithdrawal: true,
  magiBootstrapLookbackMinus2: true,
  magiBootstrapLookbackMinus1: true,
  acaPtcBenchmark: true,
  accountContributions: true,
  accountReturns: true,
  accountAssetMix: true,
  // Rendered as the "Account limits" group — the
  // resolved effective floors constrain the drawdown engine (it never takes a
  // discretionary withdrawal below a floor), so a reader of the exported
  // report must see them.
  accountFloors: true,
  hsaQualifiedMedicalExpensePct: true,
  earlyWithdrawalPenaltyExemptAccountIds: true,
  acaMarketplaceOptOutMemberIds: true,
  // per-member/year Medicare/Marketplace coverage months + FPL region.
  // Rendered in the Withdrawals & taxes group below (non-default values only).
  healthCoverageMonths: true,
  acaFplRegion: true,
  preRetirementRothConversions: true,
  preRetirementRothConversionTaxRatePct: true,
  // Roth conversion comparison working-years taxable-income input — used only by
  // that page's bracket-headroom math, not surfaced in the PDF scenario-settings
  // page. Registered here only to satisfy the `Record<keyof ScenarioOverrides,
  // true>` compile guard.
  preRetirementTaxableIncomeDollars: true, // not shown in PDF — BETR-page-only setting
  qualifiedCharitableDistributions: true,
} satisfies Record<keyof ScenarioOverrides, true>;

interface ScenarioSettingsInput {
  /** Fully resolved overrides for this scenario (own + inherited chain). Drives
   *  the EFFECTIVE scenario-level setting values. */
  resolved: ScenarioOverrides;
  /** This scenario's OWN override section — drives the per-account / expense /
   *  income "what actually changed" rows. */
  ownOverrides: ScenarioOverrides;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  hasSecondary: boolean;
  memberNames: { primary: string; secondary?: string };
  retire: { primary: AgeYearsMonths; secondary?: AgeYearsMonths };
  claim: { primary: number; secondary?: number };
  kind: string;
  customTiers: string[][] | null;
  accountById: ReadonlyMap<string, AccountPayload>;
  accountNameById: ReadonlyMap<string, string>;
  expenseNameById: ReadonlyMap<string, string>;
  expenseById: ReadonlyMap<string, ExpensePayload>;
  incomeNameById: ReadonlyMap<string, string>;
  incomeById: ReadonlyMap<string, IncomeStreamPayload>;
  /** Hardened QCD entries for this scenario (resolveQcdForScenario output) —
   *  the report summarizes only VALID resolved QCDs, never raw overrides. */
  qcdEntries: ReadonlyArray<ResolvedQcdEntry>;
  /** Resolved effective per-account minimum-balance floors for this scenario
   *  (resolveAccountFloorsForScenario output) — resolved, not own-only, so a
   *  child scenario inheriting a floor from an ancestor still reports the
   *  constraint its projection actually ran under. */
  accountFloors: ReadonlyMap<string, ResolvedAccountFloor>;
  categoryNameById: ReadonlyMap<string, string>;
  /** Flag-derived medical category ids — each renders its own
   *  `general + spread` (uncapped) default row and is excluded from the
   *  generic remaining-rates loop. */
  medicalCategoryIds: ReadonlySet<string>;
}

/**
 * Build the grouped scenario-settings for the PDF's Scenario page. Scenario-
 * level knobs show their EFFECTIVE (resolved) value; per-account / expense /
 * income overrides show the ACTUAL change made on this scenario ("$0 to
 * $5,000", "Travel removed") rather than a count, and unchanged inventory is
 * omitted so the page carries detail, not noise. Account floors are the one
 * per-account exception: they render RESOLVED-effective (like scenario-level
 * knobs), because an inherited floor still constrains this scenario's
 * projection and the reader must see it. Settings are split into small
 * titled groups (one table each) so no single table is overloaded. Values are
 * ASCII-only — jsPDF's standard font has no glyph for → / ≤, so " to " /
 * "up to " are used. Every key the report knows about is registered in
 * `SCENARIO_SETTING_COVERAGE` (a compile-time guard that forces future
 * override fields into this builder).
 */
export function buildScenarioSettings(input: ScenarioSettingsInput): ReportScenarioSettingGroup[] {
  const {
    resolved,
    ownOverrides,
    members,
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
    categoryNameById,
    medicalCategoryIds,
    qcdEntries,
    accountFloors,
  } = input;

  const accountName = (id: string): string => accountNameById.get(id) ?? id;
  const longevity: ReportScenarioSetting[] = [];
  const taxes: ReportScenarioSetting[] = [];
  const inflationSpending: ReportScenarioSetting[] = [];
  const withdrawal: ReportScenarioSetting[] = [];
  const magiCapRows: ReportScenarioSetting[] = [];
  const rothConversionRows: ReportScenarioSetting[] = [];
  const qcdRows: ReportScenarioSetting[] = [];
  const accountChanges: ReportScenarioSetting[] = [];
  const inventoryChanges: ReportScenarioSetting[] = [];

  // ----- Retirement & longevity -----
  longevity.push({ label: `Retirement age — ${memberNames.primary}`, value: formatAgeYearsMonths(retire.primary) });
  if (hasSecondary && retire.secondary) {
    longevity.push({ label: `Retirement age — ${memberNames.secondary}`, value: formatAgeYearsMonths(retire.secondary) });
  }
  longevity.push({ label: `Social Security claim age — ${memberNames.primary}`, value: `age ${claim.primary}` });
  if (hasSecondary && claim.secondary !== undefined) {
    longevity.push({ label: `Social Security claim age — ${memberNames.secondary}`, value: `age ${claim.secondary}` });
  }
  const ss = resolved.socialSecurity;
  // Always-show effective values (even when inherited / at their default), so a
  // reader sees the full Social Security assumption set, not just overrides.
  const benefitCut = ss?.benefitReductionPct ?? 0;
  longevity.push({
    label: 'Social Security benefit cut',
    value: benefitCut > 0 ? `${benefitCut}%` : 'None (full benefits)',
  });
  longevity.push({
    label: 'Social Security COLA',
    value:
      ss?.colaTracksInflation === false
        ? `${ss.colaPct ?? DEFAULT_COLA_PCT}% fixed (not inflation-linked)`
        : 'Tracks inflation (CPI-indexed)',
  });
  longevity.push({
    label: `Life expectancy — ${memberNames.primary}`,
    value: `age ${resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE}`,
  });
  if (hasSecondary) {
    longevity.push({
      label: `Life expectancy — ${memberNames.secondary}`,
      value: `age ${resolved.lifeExpectancy?.secondary ?? DEFAULT_LIFE_EXPECTANCY_AGE}`,
    });
  }

  // ----- Taxes & filing -----
  // Every filing surface reads the SAME resolver-backed summary
  // (`summarizeFilingPlan`), so the PDF, the on-screen report card, and the
  // engines can never disagree about which return the projection actually
  // filed — including the case where an un-convertible legacy setting is
  // still in force.
  const filingSummary = summarizeFilingPlan({
    taxFilingPlan: resolved.taxFilingPlan,
    filingStatusOverride: resolved.filingStatus,
    hasSecondaryMember: hasSecondary,
  });
  taxes.push({ label: 'Filing status', value: filingSummary.headline });
  for (const unit of filingSummary.units) {
    const who =
      unit.memberId === 'primary' ? memberNames.primary : (memberNames.secondary ?? 'Spouse');
    taxes.push({
      label: `Filing status — ${who}`,
      value: `${unit.statusLabel}, ${unit.householdSize} on the return`,
    });
  }
  if (filingSummary.livedTogether !== undefined) {
    taxes.push({
      label: 'Spouses lived together during the year',
      value: filingSummary.livedTogether ? 'Yes' : 'No',
    });
  }
  if (filingSummary.units.length > 1) {
    // Disclose the residual even-split approximation right where the
    // separate-return settings are presented.
    taxes.push({
      label: 'Separate-return estimate',
      value:
        'Withdrawals, interest, and Social Security are reported on their owner\u2019s return; ' +
        'anything with no single owner is divided evenly',
    });
  }
  if (filingSummary.afterADeath !== undefined) {
    // A separate plan does NOT collapse to a joint return in the death
    // year; the summary states whichever is true for this plan.
    taxes.push({ label: 'After a spouse dies', value: filingSummary.afterADeath });
  }
  if (filingSummary.unresolvedLegacyDetail !== undefined) {
    taxes.push({
      label: 'Older filing setting kept',
      value: filingSummary.unresolvedLegacyDetail,
    });
  }
  for (const w of filingSummary.windows) {
    taxes.push({ label: 'Filing exception years', value: w });
  }
  taxes.push({
    label: 'Taxable-withdrawal LTCG fraction',
    value: `${Math.round((resolved.assumedCostBasisFractionOfTaxableWithdrawal ?? DEFAULT_TAXABLE_LTCG_FRACTION) * 100)}%`,
  });
  taxes.push({
    label: 'Emergency HSA withdrawals treated as qualified',
    value: `${resolved.hsaQualifiedMedicalExpensePct ?? DEFAULT_HSA_QUALIFIED_PCT}%`,
  });
  if (resolved.magiBootstrapLookbackMinus2 != null) {
    taxes.push({ label: 'MAGI bootstrap (2 yrs pre-retirement)', value: settingMoney(resolved.magiBootstrapLookbackMinus2) });
  }
  if (resolved.magiBootstrapLookbackMinus1 != null) {
    taxes.push({ label: 'MAGI bootstrap (1 yr pre-retirement)', value: settingMoney(resolved.magiBootstrapLookbackMinus1) });
  }
  // Walked through the ONE shared shape-checking enumerator: the array
  // arrives from an envelope-only-validated import, so a non-array payload used
  // to throw out of the whole PDF settings build.
  // The row states the proration contract (the entered figure is a
  // whole-year price charged pro rata to the Marketplace coverage months), which
  // a bare `$…/yr` did not. Values stay ASCII-only for jsPDF's standard font.
  for (const b of storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark)) {
    taxes.push({
      label: `ACA benchmark (SLCSP) ${b.taxYear}`,
      value: `${settingMoney(b.annualSlcspDollars)}/yr, prorated to Marketplace coverage months`,
    });
  }

  // ----- Inflation & spending -----
  const generalInflation = resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  const categoryRates = resolved.inflation?.categoryRates ?? {};
  inflationSpending.push({ label: 'Inflation rate', value: `${generalInflation}%` });
  // Medical inflation: always show each `isMedical` category's effective
  // rate (a medical category runs at general + a default spread unless
  // explicitly overridden), even when inherited / defaulted. Multiple medical
  // categories are allowed; a flag-derived id the chain never rate-set is
  // absent from `categoryRates`, so render it with the uncapped default.
  for (const catId of medicalCategoryIds) {
    const medicalRate =
      categoryRates[catId] ?? generalInflation + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT;
    inflationSpending.push({
      label: `Inflation — ${categoryNameById.get(catId) ?? 'Medical'}`,
      value: `${medicalRate}%`,
    });
  }
  for (const [catId, rate] of Object.entries(categoryRates)) {
    if (medicalCategoryIds.has(catId)) continue; // medical ids shown above
    inflationSpending.push({ label: `Inflation — ${categoryNameById.get(catId) ?? 'category'}`, value: `${rate}%` });
  }
  if (resolved.discretionarySpending) {
    const { bumpPct, durationYears } = resolved.discretionarySpending;
    const durLabel =
      durationYears == null ? 'whole retirement' : `first ${durationYears} year${durationYears === 1 ? '' : 's'}`;
    inflationSpending.push({ label: 'Discretionary spending', value: `${bumpPct >= 0 ? '+' : ''}${bumpPct}% (${durLabel})` });
  }
  if (resolved.downturnGuardrails?.enabled === true) {
    const { lowerBandPct, upperBandPct, stepPct, maxRaisePct, discretionaryFloorPct } =
      resolved.downturnGuardrails;
    inflationSpending.push({
      label: 'Spending guardrails',
      value: `On — cut below ${lowerBandPct}%, raise above ${upperBandPct}%, step ${stepPct}%, raise cap ${maxRaisePct}%, keep ${discretionaryFloorPct ?? 50}% discretionary`,
    });
  }
  if (resolved.contributions?.stopContributionsToday) {
    inflationSpending.push({ label: 'Future contributions', value: 'Stopped today (coast on growth)' });
  }

  // ----- Withdrawal strategy + drawdown order + allocation -----
  withdrawal.push({ label: 'Withdrawal strategy', value: WITHDRAWAL_STRATEGY_LABELS[kind] ?? kind });
  if (WITHDRAWAL_STRATEGY_DESCRIPTIONS[kind]) {
    withdrawal.push({ label: 'How it works', value: WITHDRAWAL_STRATEGY_DESCRIPTIONS[kind] });
  }
  if (kind === 'customOrder' && customTiers) {
    customTiers.forEach((tier, i) => withdrawal.push({ label: `Drawdown tier ${i + 1}`, value: tier.join(', then ') }));
    const excluded = resolved.customDrawdownOrder?.excludedAccountIds ?? [];
    if (excluded.length) withdrawal.push({ label: 'Drawdown — never drawn', value: excluded.map(accountName).join(', ') });
  }
  const ra = resolved.retirementAllocation;
  if (ra) {
    const glide =
      ra.endGrowthPct == null || ra.endYear == null
        ? `${ra.startGrowthPct}% growth (flat)`
        : `${ra.startGrowthPct}% to ${ra.endGrowthPct}% growth by ${ra.endYear}`;
    withdrawal.push({
      label: 'Asset-allocation glide',
      value: `${glide}; growth ${ra.growthRatePct}% / income ${ra.incomeRatePct}%`,
    });
  }
  const exempt = resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [];
  if (exempt.length) {
    withdrawal.push({ label: 'Early-withdrawal-penalty exempt', value: exempt.map(accountName).join(', ') });
  }
  // ACA Marketplace opt-out: resolve each opted-out member id to its display
  // name, label-guarding any id with no matching live member (member deletion
  // is a live flow — a dangling id is skipped, never rendered blank).
  const optedOutNames = (resolved.acaMarketplaceOptOutMemberIds ?? [])
    .map((mid) => members.find((m) => m.id === mid))
    .filter((m): m is Aggregate<HouseholdMemberPayload> => m !== undefined)
    .map((m) => memberName(m, 'Member'));
  if (optedOutNames.length) {
    taxes.push({ label: 'ACA Marketplace — other coverage', value: optedOutNames.join(', ') });
  }
  // The health-coverage assumptions that actually drive the projection.
  // Only non-default values are listed, matching the rest of this page.
  // A lookup keyed by the `AcaFplRegion` union, not a magic-string ternary
  // that rendered any future non-Alaska region as "Hawaii".
  // Read through the own-property-safe helper, so an imported
  // `acaFplRegion: "constructor"` is omitted rather than emitting an inherited
  // function as a PDF cell value.
  const fplRegionLabel = fplRegionSettingLabel(resolved.acaFplRegion);
  if (fplRegionLabel !== undefined) {
    taxes.push({ label: 'Federal poverty guidelines', value: fplRegionLabel });
  }
  const coverageYears = statedCoverageYears(resolved.healthCoverageMonths);
  if (coverageYears.length > 0) {
    taxes.push({
      label: 'Coverage months entered for',
      value: coverageYears.join(', '),
    });
  }
  // The per-year `ACA benchmark (SLCSP) <year>` rows above are the
  // ONE representation of a benchmark override in this group. A second combined
  // "Benchmark plan price" row listed every override again, so an exported PDF
  // repeated the same setting under two labels.

  // ----- Account limits (per-account minimum-balance floors) -----
  // Only floors the engine actually applies are reported: the resolver does
  // not type-gate (eligibility is enforced at the engine boundary), so a floor on an
  // ineligible-treatment or inactive account — or a $0 floor, which the
  // engine's single read point (`floorEligibleDollars`) treats as no floor —
  // is filtered here exactly like the engine ignores it. Rows order by the
  // shared report collator + id tie-break, matching the account tables.
  const floorRows: ReportScenarioSetting[] = [];
  const eligibleFloors = [...accountFloors]
    .filter(([id, floor]) => {
      const acct = accountById.get(id);
      return (
        acct !== undefined &&
        acct.active &&
        isFloorEligibleTreatment(acct.taxTreatment) &&
        floor.floorDollars > 0
      );
    })
    .sort(([aId], [bId]) =>
      compareReportNameThenId(
        { id: aId, name: accountName(aId) },
        { id: bId, name: accountName(bId) },
      ),
    );
  for (const [id, floor] of eligibleFloors) {
    const isHsa = accountById.get(id)?.taxTreatment === 'HSA';
    const hsaNote = isHsa
      ? floor.hsaMode === 'strict'
        ? '; blocks all draws, including medical'
        : '; blocks emergency draws only'
      : '';
    floorRows.push({
      label: `Minimum balance — ${accountName(id)}`,
      value: `${settingMoney(floor.floorDollars)}${hsaNote}`,
    });
  }
  if (floorRows.length) {
    // One shared caveat row: the fixed-dollar warning the Account limits
    // screen carries, plus the reserve semantics (projection-floor-reserve-
    // depletion) — a floor is not an absolute hard stop; the engine drains
    // it as a last resort once every other funding path is exhausted.
    floorRows.push({
      label: 'Floor amounts',
      value:
        'Fixed dollar amounts, not adjusted for inflation. Protected for ' +
        'everyday spending; drawn only as a last resort',
    });
  }

  // ----- MAGI cap ladder (own group: values are long) -----
  const cap = resolved.magiCap;
  if (cap) {
    if (isMagiCapDisabled(cap)) {
      magiCapRows.push({ label: 'MAGI cap', value: 'Disabled (inherited cap turned off)' });
    } else {
      cap.windows.forEach((w, i) => {
        // Label by the active period (years), like the rest of the page; fall
        // back to "Window N" only if the anchors yield no readable period.
        const period = `${describeStart(w.start, members, 'lowercase')} to ${describeEnd(w.end, members)}`.trim();
        const mode = w.capMode === 'fill' ? 'fill to Roth' : 'minimize';
        const line = w.capMagiLine === 'aca' ? 'ACA-PTC' : 'IRMAA';
        const roth = w.targetRothAccountId ? `, target ${accountName(w.targetRothAccountId)}` : '';
        magiCapRows.push({
          label: period || `Window ${i + 1}`,
          value: `up to ${settingMoney(w.magiCeilingAnnualDollars)}/yr; ${mode}; ${line}${roth}`,
        });
      });
    }
  }

  // ----- Working-years Roth conversions (own group: values are long) -----
  // Each entry: source pre-tax -> target Roth account, annual amount + working-year
  // window. The displayed additional tax burden uses the assumed rate and is
  // NOT deducted from the projection. Account ids resolve to display
  // names; an orphan/dangling id falls back to the raw id (never blank).
  // Same-account in-plan conversions (sourceAccountId === targetRothAccountId)
  // render as "within <Account name> (in-plan Roth conversion)".
  const conversions = resolved.preRetirementRothConversions ?? [];
  if (conversions.length) {
    const ratePct = resolved.preRetirementRothConversionTaxRatePct ?? 0;
    conversions.forEach((c, i) => {
      const period =
        `${describeStart(c.start, members, 'lowercase')} to ${describeEnd(c.end, members)}`.trim();
      // Same-account in-plan Roth conversion — id equality check, no
      // eligibility helper import (keeps the display layer dependency-free).
      const isSameAccount = c.sourceAccountId === c.targetRothAccountId;
      const transferDesc = isSameAccount
        ? `within ${accountName(c.sourceAccountId)} (in-plan Roth conversion)`
        : `${accountName(c.sourceAccountId)} to ${accountName(c.targetRothAccountId)}`;
      rothConversionRows.push({
        label: period || `Conversion ${i + 1}`,
        value: `${settingMoney(c.annualAmountDollars)}/yr; ${transferDesc}`,
      });
    });
    // One shared burden/disclosure row — the assumed rate applies to every
    // entry and the shown burden is informational only (not deducted).
    rothConversionRows.push({
      label: 'Assumed tax rate (shown, not deducted)',
      value: `${ratePct}%`,
    });
  }

  // ----- Qualified Charitable Distributions (own group: values are long) -----
  // Each entry: a fixed REAL annual gift directly from a designated traditional
  // IRA over a window. The QCD counts toward the owner's RMD and drops out of
  // taxable income / MAGI (both engines apply it). `qcdEntries` is
  // the HARDENED resolveQcdForScenario output —
  // orphan / non-IRA / cross-owner / pre-70½ entries are already dropped, so the
  // report never renders an invalid QCD. Account ids resolve to display names.
  if (qcdEntries.length) {
    qcdEntries.forEach((q, i) => {
      const period =
        `${describeStart(q.start, members, 'lowercase')} to ${describeEnd(q.end, members)}`.trim();
      qcdRows.push({
        label: period || `QCD ${i + 1}`,
        value: `${settingMoney(q.annualAmountDollars)}/yr from ${accountName(q.sourceAccountId)}`,
      });
    });
  }

  // ----- Per-account overrides set on THIS scenario (the actual change) -----
  for (const [id, ov] of Object.entries(ownOverrides.accountReturns?.perAccount ?? {})) {
    if (ov.planningReturnPct == null) continue;
    const base = accountById.get(id)?.planningReturnPct;
    accountChanges.push({
      label: `Return — ${accountName(id)}`,
      value: base != null ? `${base}% to ${ov.planningReturnPct}%` : `${ov.planningReturnPct}%`,
    });
  }
  for (const [id, ov] of Object.entries(ownOverrides.accountContributions?.perAccount ?? {})) {
    const base = accountById.get(id);
    const parts: string[] = [];
    if (ov.plannedContributionPreTax != null) {
      parts.push(`pre-tax ${settingMoney(base?.plannedContributionPreTax ?? 0)} to ${settingMoney(ov.plannedContributionPreTax)}`);
    }
    if (ov.plannedContributionPostTax != null) {
      parts.push(`post-tax ${settingMoney(base?.plannedContributionPostTax ?? 0)} to ${settingMoney(ov.plannedContributionPostTax)}`);
    }
    if (parts.length) accountChanges.push({ label: `Contributions — ${accountName(id)}`, value: parts.join(', ') });
  }
  const fmtMix = (m: AssetMix): string => `${m.stocksPct}/${m.bondsPct}/${m.cashPct}`;
  for (const [id, mix] of Object.entries(ownOverrides.accountAssetMix?.perAccount ?? {})) {
    const base = accountById.get(id)?.assetMix;
    accountChanges.push({
      label: `Asset mix — ${accountName(id)}`,
      value: base ? `${fmtMix(base)} to ${fmtMix(mix)}` : fmtMix(mix),
    });
  }

  // ----- Expense + income overrides set on THIS scenario -----
  const ex = ownOverrides.expenses;
  if (ex) {
    for (const a of ex.added ?? []) {
      inventoryChanges.push({ label: `Expense added — ${a.name}`, value: `${settingMoney(a.amount)}/${a.frequency}, ${a.classification}` });
    }
    for (const rawId of ex.disabledIds ?? []) {
      inventoryChanges.push({ label: 'Expense removed', value: lookupCanonicalName(rawId, expenseNameById) ?? '(scenario expense)' });
    }
    for (const [rawId, patch] of Object.entries(ex.patches ?? {})) {
      const name = lookupCanonicalName(rawId, expenseNameById) ?? '(scenario expense)';
      const id = canonicalId(rawId);
      const base = id ? expenseById.get(id) : undefined;
      inventoryChanges.push({
        label: `Expense changed — ${name}`,
        value: describeExpensePatch(patch as Record<string, unknown>, base),
      });
    }
    for (const rawId of ex.reEnabledIds ?? []) {
      inventoryChanges.push({ label: 'Expense re-enabled', value: lookupCanonicalName(rawId, expenseNameById) ?? '(scenario expense)' });
    }
  }
  const inc = ownOverrides.income;
  if (inc) {
    for (const a of inc.added ?? []) {
      const amt = a.annualAmount != null ? ` (${settingMoney(a.annualAmount)}/yr)` : '';
      inventoryChanges.push({ label: `Income added — ${a.name}`, value: `${a.kind}${amt}` });
    }
    for (const rawId of inc.disabledIds ?? []) {
      inventoryChanges.push({ label: 'Income removed', value: lookupCanonicalName(rawId, incomeNameById) ?? '(scenario income)' });
    }
    for (const [rawId, patch] of Object.entries(inc.patches ?? {})) {
      const name = lookupCanonicalName(rawId, incomeNameById) ?? '(scenario income)';
      const id = canonicalId(rawId);
      const base = id ? incomeById.get(id) : undefined;
      inventoryChanges.push({
        label: `Income changed — ${name}`,
        value: describeIncomePatch(patch as Record<string, unknown>, base),
      });
    }
    for (const rawId of inc.reEnabledIds ?? []) {
      inventoryChanges.push({ label: 'Income re-enabled', value: lookupCanonicalName(rawId, incomeNameById) ?? '(scenario income)' });
    }
  }

  const groups: ReportScenarioSettingGroup[] = [];
  const addGroup = (title: string, rows: ReportScenarioSetting[]): void => {
    if (rows.length) groups.push({ title, rows });
  };
  addGroup('Retirement & longevity', longevity);
  addGroup('Taxes', taxes);
  addGroup('Inflation & spending', inflationSpending);
  addGroup('Withdrawal strategy', withdrawal);
  addGroup('Account limits', floorRows);
  addGroup('MAGI cap', magiCapRows);
  addGroup('Working-years Roth conversions', rothConversionRows);
  addGroup('Qualified Charitable Distributions', qcdRows);
  addGroup('Account changes', accountChanges);
  addGroup('Expense & income changes', inventoryChanges);
  return groups;
}
