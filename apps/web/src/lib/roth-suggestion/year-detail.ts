/**
 * The year-by-year table behind a plan. Everything is read off the plan's
 * records and engine rows. The two figures that need the year without its
 * conversion, the income on the limit's line before the conversion and the
 * Social Security the conversion pulled into tax, are the engine's own: the
 * tax pass prices every year the Fill step converts a second time with no
 * conversion and none of the draws that paid its tax, and stamps the result on
 * the row. So a person can check
 *
 *   amount = limit - income before - extra taxable SS - income from paying the
 *            tax - kept under
 *
 * where `income from paying the tax` is what the row's income carries beyond
 * the zero point, the conversion and the extra Social Security (taxable income
 * from the withdrawals that paid the conversion's tax), and `kept under` is the
 * limit less the income after the conversion. A row without the engine's
 * figures (the current plan, which converts nothing) has no conversion to take
 * out, so its income before is its income after. Nominal dollars throughout:
 * the limits are nominal for the year.
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
  /** The projection models tax-exempt interest as zero; carried so the rule
   *  here stays the engine's if it ever stops. */
  readonly taxExemptInterestCents: number;
}

export interface YearDetailArgs {
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

/** Income on the limit's line before and after the conversion, and the Social
 *  Security the conversion pulled into taxable income. A converted year reads
 *  the "before" side from the engine's zero-conversion figures on the row. A
 *  row without them converted nothing (or is not a projected year), so the
 *  conversion is backed out of its income with the engine's Social Security
 *  rule, which there changes nothing. */
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

/** What converting the room the unguarded sibling would have taken would have
 *  cost: the bracket-top line less the cliff line, in the year's own filing
 *  status, with the Medicare enrolment months of year Y+2 and the Marketplace
 *  months of Y. */
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

/**
 * One display row per record: every window year (a year that converted $0
 * included) and the year after the window, which says why conversions stopped.
 * A record with no engine row is skipped; `buildYearRecords` never emits one.
 */
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
