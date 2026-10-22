/**
 * The year-by-year table behind a plan, read off its records and engine rows in
 * nominal dollars, so that a person can check
 *   amount = limit - income before - extra taxable SS - income from paying the tax - kept under.
 */
import type { AccountsById } from './year-records';
import { preTaxDollarsAtRowEnd } from './year-records';
import type { DrawdownYear } from '../drawdown-engine-types';
import { computeAllInConversionCost } from '../conversion-cost-calculator';
import { computeSsTaxation } from '../ss-taxation';
import {
  householdMarketplaceCoverageMonths,
  type TaxCalibrationBundle,
} from '../tax-integration-helpers';
import type { AcaFplRegion } from '../aca-ptc';
import type { LookbackFacts, YearFacts } from './year-facts';
import type { LimitKind, YearLimits, YearRecord } from './types';
import type {
  YearCrossingNote,
  YearDetailLines,
  YearDetailRow,
  YearLimitKind,
} from './year-detail-types';

const CENTS_PER_DOLLAR = 100;
/** The probe converts at least this many dollars past the cliff. */
const MIN_PROBE_DOLLARS = 1;

/** What a window year's detail reads that no plan changes. */
export interface DetailYearInput {
  readonly facts: YearFacts;
  readonly lookback: LookbackFacts;
  /** The year's gross Social Security, from the same monthly rows the tax pass uses. */
  readonly grossSsDollars: number;
  readonly benchmarkSlcspCents: number;
}

export interface YearDetailEnvironment {
  readonly bundle: TaxCalibrationBundle;
  readonly inflationPct: number;
  readonly acaFplRegion: AcaFplRegion | undefined;
  /** Zero in the projection today; carried so the rule stays the engine's. */
  readonly taxExemptInterestCents: number;
}

interface YearDetailArgs {
  readonly records: readonly YearRecord[];
  readonly rows: readonly DrawdownYear[];
  readonly years: ReadonlyMap<number, DetailYearInput>;
  readonly accounts: AccountsById;
  readonly env: YearDetailEnvironment;
}

interface IncomeFlow {
  readonly beforeCents: number;
  readonly afterCents: number;
  readonly extraTaxableSsCents: number;
}

function cents(value: number): number {
  return Math.round(value * CENTS_PER_DOLLAR);
}

function dollars(valueCents: number): number {
  return valueCents / CENTS_PER_DOLLAR;
}

/** Income on the limit's line before and after the conversion. A converted row
 *  carries the engine's own zero-conversion figures; otherwise the conversion
 *  is backed out with the engine's Social Security rule. */
function incomeFlow(
  record: YearRecord,
  row: DrawdownYear,
  input: DetailYearInput,
  env: YearDetailEnvironment,
): IncomeFlow {
  const { rothZeroConversionMagiCents: zeroMagiCents, rothZeroConversionTaxableSsCents: zeroSsCents } = row;
  if (zeroMagiCents !== undefined && zeroSsCents !== undefined) {
    return {
      beforeCents: zeroMagiCents,
      afterCents: record.magiCents,
      extraTaxableSsCents: record.taxableSsCents - zeroSsCents,
    };
  }
  const exempt = env.taxExemptInterestCents;
  const otherBefore = Math.max(
    0,
    record.magiCents - record.taxableSsCents - exempt - record.convertedCents,
  );
  const { taxableSsCents: ssBefore } = computeSsTaxation(
    {
      grossSsCents: cents(input.grossSsDollars),
      otherAgiCents: otherBefore,
      taxExemptInterestCents: exempt,
      filingStatus: input.facts.filingStatus,
      taxYear: input.facts.year,
    },
    env.bundle.ssTax,
  );
  return {
    beforeCents: otherBefore + exempt + ssBefore,
    afterCents: record.magiCents,
    extraTaxableSsCents: record.taxableSsCents - ssBefore,
  };
}

function linesOf(limits: YearLimits): YearDetailLines {
  return {
    bracketDollars: limits.bracket.valueDollars,
    irmaaDollars: limits.irmaa.applies ? limits.irmaa.valueDollars : null,
    acaDollars: limits.aca.applies ? limits.aca.valueDollars : null,
  };
}

/** The limit that stopped the year, from the record's stop (the current plan,
 *  which has none, is read off the row). */
function limitKindOf(record: YearRecord, preTaxEndDollars: number): YearLimitKind {
  switch (record.stop) {
    case 'limit':
      return record.binding ?? 'bracket';
    case 'withdrawals-at-ceiling':
    case 'breach':
      return 'already-over';
    case 'pre-tax-exhausted':
      return 'pre-tax-ran-out';
    case 'window-ended':
      return 'outside-window';
    case 'no-target':
      return 'no-target';
    case 'unused-headroom':
      return 'under-ceiling';
    case null:
      break;
  }
  if (record.breachedDollars > 0) return 'already-over';
  return preTaxEndDollars < 1 && record.convertedCents > 0 ? 'pre-tax-ran-out' : 'plan-setting';
}

/** What converting the room up to the bracket top would have cost, with year
 *  Y+2's Medicare enrolment and year Y's Marketplace months. */
function crossingNote(
  record: YearRecord,
  limits: YearLimits,
  input: DetailYearInput,
  env: YearDetailEnvironment,
  line: LimitKind,
): YearCrossingNote | null {
  if (line === 'bracket') return null;
  const probeDollars = Math.max(MIN_PROBE_DOLLARS, limits.bracket.valueDollars - limits.limitDollars);
  const bracket = limits.bracket;
  const taxableIncomeCents = Math.max(
    0,
    record.magiCents -
      cents(bracket.standardDeductionDollars + bracket.age65AddOnDollars + bracket.seniorBonusDollars),
  );
  const cost = computeAllInConversionCost(
    {
      year: input.facts.year,
      filingStatus: input.facts.filingStatus,
      conversionCents: cents(probeDollars),
      taxableIncomeCents,
      magiCents: record.magiCents,
      taxableSsCents: record.taxableSsCents,
      grossSsAnnualCents: cents(input.grossSsDollars),
      taxExemptInterestCents: env.taxExemptInterestCents,
      beneficiariesOnMedicareCount: input.lookback.medicareBeneficiaries,
      irmaaBeneficiaries: input.lookback.irmaaBeneficiaries,
      householdSize: input.facts.householdSize,
      benchmarkAnnualSlcspCents: input.benchmarkSlcspCents,
      ...(env.acaFplRegion !== undefined ? { acaFplRegion: env.acaFplRegion } : {}),
      acaCoverageMonths: householdMarketplaceCoverageMonths(input.facts.members),
      inflationRatePct: env.inflationPct,
    },
    env.bundle,
  );
  return {
    line,
    extraConvertedDollars: probeDollars,
    medicareSurchargeDollars: dollars(cost.irmaaDeltaCents),
    acaCreditLostDollars: dollars(cost.ptcDeltaCents),
  };
}

function detailRow(
  record: YearRecord,
  row: DrawdownYear,
  input: DetailYearInput | undefined,
  args: YearDetailArgs,
): YearDetailRow {
  const preTaxEndDollars = preTaxDollarsAtRowEnd(row, args.accounts);
  const limitKind = limitKindOf(record, preTaxEndDollars);
  const { limits } = record;
  const flow = record.inWindow && input !== undefined ? incomeFlow(record, row, input, args.env) : null;
  const limitDollars = limits === null ? null : limits.limitDollars;
  return {
    year: record.year,
    inWindow: record.inWindow,
    filingStatus: flow === null || input === undefined ? null : input.facts.filingStatus,
    limitKind,
    amountDollars: dollars(record.convertedCents),
    lines: limits === null ? null : linesOf(limits),
    limitDollars,
    incomeBeforeDollars: flow === null ? null : dollars(flow.beforeCents),
    incomeAfterDollars: flow === null ? null : dollars(flow.afterCents),
    extraTaxableSsDollars: flow === null ? null : dollars(flow.extraTaxableSsCents),
    taxPaymentIncomeDollars:
      flow === null
        ? null
        : dollars(flow.afterCents - flow.beforeCents - record.convertedCents - flow.extraTaxableSsCents),
    keptUnderDollars:
      flow === null || limitDollars === null ? null : limitDollars - dollars(flow.afterCents),
    reroutedDollars: record.reroutedDollars,
    breachedDollars: record.breachedDollars,
    incomeTaxDollars: dollars(record.federalTaxCents),
    taxableSsDollars: dollars(record.taxableSsCents),
    ssTier: record.ssTaxationTier,
    irmaaPaidDollars: dollars(record.irmaaSurchargeCents),
    irmaaSetDollars:
      record.lookbackIrmaaSurchargeCents === null ? null : dollars(record.lookbackIrmaaSurchargeCents),
    acaCreditDollars: dollars(record.acaPtcSubsidyCents),
    marketplaceMonths: input === undefined ? null : householdMarketplaceCoverageMonths(input.facts.members),
    acaTier: record.acaPtcTier,
    preTaxEndDollars,
    crossingNote:
      limits !== null && input !== undefined && (limitKind === 'irmaa' || limitKind === 'aca')
        ? crossingNote(record, limits, input, args.env, limitKind)
        : null,
  };
}

/** One display row per record: every window year, $0 years included, and the
 *  year after the window. */
export function buildYearDetail(args: YearDetailArgs): YearDetailRow[] {
  const rowByYear = new Map(args.rows.map((row) => [row.year, row]));
  const out: YearDetailRow[] = [];
  for (const record of args.records) {
    const row = rowByYear.get(record.year);
    if (row === undefined) continue;
    out.push(detailRow(record, row, args.years.get(record.year), args));
  }
  return out;
}
