// Scenario-settings builder for the report / PDF Scenario page.

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

const FPL_REGION_SETTING_LABELS: Readonly<Record<Exclude<AcaFplRegion, 'contiguous'>, string>> = {
  alaska: 'Alaska',
  hawaii: 'Hawaii',
};

// Own-property lookup: an imported `acaFplRegion: "constructor"` would index an inherited function and break the PDF
// table. An unrecognised or default region is omitted; the projection prices it as contiguous.
function fplRegionSettingLabel(region: string | undefined): string | undefined {
  return region !== undefined && Object.hasOwn(FPL_REGION_SETTING_LABELS, region)
    ? FPL_REGION_SETTING_LABELS[region as Exclude<AcaFplRegion, 'contiguous'>]
    : undefined;
}

// Read through `Object.hasOwn`: import hardening rejects `constructor` only in key position, so an imported
// `acaFplRegion: "constructor"` would return an inherited function and crash the Report render.
const FPL_REGION_REPORT_LABELS: Readonly<Record<AcaFplRegion, string>> = {
  contiguous: 'The 48 mainland states and Washington, DC',
  alaska: 'Alaska (higher federal poverty guidelines)',
  hawaii: 'Hawaii (higher federal poverty guidelines)',
};

export function fplRegionReportLabel(region: string | undefined): string {
  return region !== undefined && Object.hasOwn(FPL_REGION_REPORT_LABELS, region)
    ? FPL_REGION_REPORT_LABELS[region as AcaFplRegion]
    : FPL_REGION_REPORT_LABELS.contiguous;
}

/** Tax years with stated coverage months for any member, ascending; shared by both report modules. */
export function statedCoverageYears(
  override: StoredHealthCoverageMonths | undefined,
): number[] {
  const years = new Set<number>();
  for (const entry of storedCoverageMonthEntries(override)) years.add(entry.taxYear);
  return [...years].sort((a, b) => a - b);
}

import { formatAgeYearsMonths, type AgeYearsMonths } from './format-age';

/** One scenario setting or change: a label and its detail value. Values are ASCII-only (jsPDF's standard font lacks → and ≤). */
interface ReportScenarioSetting {
  label: string;
  value: string;
}

export interface ReportScenarioSettingGroup {
  title: string;
  rows: ReportScenarioSetting[];
}

/** Resolves an override id to a canonical expense name; `local:` ids are scenario-only adds, named via the `added` payload. */
export function lookupCanonicalName(
  rawId: string,
  expenseNameById: ReadonlyMap<string, string>,
): string | undefined {
  if (rawId.startsWith('local:')) return undefined;
  const id = rawId.startsWith('aggregate:') ? rawId.slice('aggregate:'.length) : rawId;
  return expenseNameById.get(id);
}

function canonicalId(rawId: string): string | undefined {
  if (rawId.startsWith('local:')) return undefined;
  return rawId.startsWith('aggregate:') ? rawId.slice('aggregate:'.length) : rawId;
}

const WITHDRAWAL_STRATEGY_LABELS: Record<string, string> = {
  taxEfficient: 'Tax-efficient',
  proportional: 'Proportional',
  rothFirst: 'Roth first',
  customOrder: 'Custom order',
};

const WITHDRAWAL_STRATEGY_DESCRIPTIONS: Record<string, string> = {
  taxEfficient:
    'Draws taxable accounts first, then tax-deferred, then Roth last — an order that tends to carry lower lifetime tax drag, though the actual result depends on your brackets and account mix.',
  proportional:
    'Draws from your non-HSA accounts at the same time, in proportion to each balance, keeping the account mix roughly steady — though the tax impact can still vary year to year rather than staying fixed. HSA money is handled separately.',
  rothFirst: 'Spends Roth (tax-free) accounts first, leaving taxable and tax-deferred accounts for later.',
  customOrder: 'Draws accounts in the custom order set on this scenario (see the tiers below).',
};

const DEFAULT_TAXABLE_LTCG_FRACTION = 0.5;

// Modeled medical-qualified withdrawals are always 100% qualified.
const DEFAULT_HSA_QUALIFIED_PCT = 100;

function settingMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

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
 * Coverage ledger: the `satisfies` clause fails `tsc` when a key is added to
 * `ScenarioOverrides` without a decision here. `true` means surfaced by
 * `buildScenarioSettings`; flip to `false` only with a stated reason it is omitted.
 */
export const SCENARIO_SETTING_COVERAGE = {
  retirementAge: true,
  socialSecurity: true,
  filingStatus: true,
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
  accountFloors: true,
  hsaQualifiedMedicalExpensePct: true,
  earlyWithdrawalPenaltyExemptAccountIds: true,
  acaMarketplaceOptOutMemberIds: true,
  healthCoverageMonths: true,
  acaFplRegion: true,
  preRetirementRothConversions: true,
  preRetirementRothConversionTaxRatePct: true,
  // Used only by the Roth conversion page's bracket-headroom math, not shown in the PDF.
  preRetirementTaxableIncomeDollars: true, // not shown in PDF — BETR-page-only setting
  qualifiedCharitableDistributions: true,
} satisfies Record<keyof ScenarioOverrides, true>;

interface ScenarioSettingsInput {
  /** Own plus inherited chain; drives the effective setting values. */
  resolved: ScenarioOverrides;
  /** This scenario's own overrides; drive the per-account, expense and income change rows. */
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
  /** Output of `resolveQcdForScenario`: only valid QCDs are summarized, never raw overrides. */
  qcdEntries: ReadonlyArray<ResolvedQcdEntry>;
  /** Resolved, not own-only, so a child inheriting an ancestor's floor reports the constraint its projection ran under. */
  accountFloors: ReadonlyMap<string, ResolvedAccountFloor>;
  categoryNameById: ReadonlyMap<string, string>;
  /** Each renders its own uncapped `general + spread` default row and is excluded from the generic category loop. */
  medicalCategoryIds: ReadonlySet<string>;
}

/**
 * Builds the grouped settings for the Scenario page. Scenario-level knobs and
 * account floors show their effective value (an inherited floor still constrains
 * the projection); account, expense and income overrides show the actual change
 * made on this scenario, and unchanged inventory is omitted.
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

  longevity.push({ label: `Retirement age — ${memberNames.primary}`, value: formatAgeYearsMonths(retire.primary) });
  if (hasSecondary && retire.secondary) {
    longevity.push({ label: `Retirement age — ${memberNames.secondary}`, value: formatAgeYearsMonths(retire.secondary) });
  }
  longevity.push({ label: `Social Security claim age — ${memberNames.primary}`, value: `age ${claim.primary}` });
  if (hasSecondary && claim.secondary !== undefined) {
    longevity.push({ label: `Social Security claim age — ${memberNames.secondary}`, value: `age ${claim.secondary}` });
  }
  const ss = resolved.socialSecurity;
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

  // Every filing surface reads `summarizeFilingPlan`, so the PDF, the report card and the engines agree on the filed return.
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
    taxes.push({
      label: 'Separate-return estimate',
      value:
        'Withdrawals, interest, and Social Security are reported on their owner\u2019s return; ' +
        'anything with no single owner is divided evenly',
    });
  }
  if (filingSummary.afterADeath !== undefined) {
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
  // Walked through the shape-checking enumerator: an imported non-array used to throw out of the whole PDF build.
  // The row states that the whole-year price is prorated to the Marketplace coverage months.
  for (const b of storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark)) {
    taxes.push({
      label: `ACA benchmark (SLCSP) ${b.taxYear}`,
      value: `${settingMoney(b.annualSlcspDollars)}/yr, prorated to Marketplace coverage months`,
    });
  }

  const generalInflation = resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  const categoryRates = resolved.inflation?.categoryRates ?? {};
  inflationSpending.push({ label: 'Inflation rate', value: `${generalInflation}%` });
  // Each medical category shows its effective rate; a flag-derived id the chain never rate-set renders the uncapped default.
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
  // A dangling opted-out id (the member was deleted) is skipped, not rendered blank.
  const optedOutNames = (resolved.acaMarketplaceOptOutMemberIds ?? [])
    .map((mid) => members.find((m) => m.id === mid))
    .filter((m): m is Aggregate<HouseholdMemberPayload> => m !== undefined)
    .map((m) => memberName(m, 'Member'));
  if (optedOutNames.length) {
    taxes.push({ label: 'ACA Marketplace — other coverage', value: optedOutNames.join(', ') });
  }
  // Non-default values only, read through the own-property-safe helper.
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
  // Only floors the engine applies: it ignores ineligible-treatment or inactive accounts and a $0
  // floor, so they are filtered here too. Ordered like the account tables.
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
    // A floor is not a hard stop: the engine drains it as a last resort once every other funding path is exhausted.
    floorRows.push({
      label: 'Floor amounts',
      value:
        'Fixed dollar amounts, not adjusted for inflation. Protected for ' +
        'everyday spending; drawn only as a last resort',
    });
  }

  const cap = resolved.magiCap;
  if (cap) {
    if (isMagiCapDisabled(cap)) {
      magiCapRows.push({ label: 'MAGI cap', value: 'Disabled (inherited cap turned off)' });
    } else {
      cap.windows.forEach((w, i) => {
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

  // Same-account in-plan conversions render as "within <Account>". The assumed rate is shown only, not deducted from the projection.
  const conversions = resolved.preRetirementRothConversions ?? [];
  if (conversions.length) {
    const ratePct = resolved.preRetirementRothConversionTaxRatePct ?? 0;
    conversions.forEach((c, i) => {
      const period =
        `${describeStart(c.start, members, 'lowercase')} to ${describeEnd(c.end, members)}`.trim();
      const isSameAccount = c.sourceAccountId === c.targetRothAccountId;
      const transferDesc = isSameAccount
        ? `within ${accountName(c.sourceAccountId)} (in-plan Roth conversion)`
        : `${accountName(c.sourceAccountId)} to ${accountName(c.targetRothAccountId)}`;
      rothConversionRows.push({
        label: period || `Conversion ${i + 1}`,
        value: `${settingMoney(c.annualAmountDollars)}/yr; ${transferDesc}`,
      });
    });
    rothConversionRows.push({
      label: 'Assumed tax rate (shown, not deducted)',
      value: `${ratePct}%`,
    });
  }

  // `qcdEntries` is the hardened resolver output: orphan, non-IRA, cross-owner and pre-70½ entries are already dropped.
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
