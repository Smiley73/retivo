/**
 * Turns a candidate's projection into the numbers the comparison shows:
 * lifetime totals and the after-tax ending balance in today's dollars, the
 * rerouted and breached years, and the deltas against the reference.
 */
import type { MagiCapWindow } from '../../db/types';
import type { DrawdownYear } from '../drawdown-engine-types';
import { realDeflatorAt } from '../projection-context';
import type { CandidateSpec } from './candidate-grid';
import type { PlannedProjection } from './projection';
import type { YearDetailRow } from './year-detail-types';
import { preTaxDollarsAtRowEnd, type AccountsById } from './year-records';
import type {
  CandidateAfterTax,
  CandidateTotals,
  RothCandidate,
  UnrankedReason,
  YearRecord,
} from './types';

const CENTS_PER_DOLLAR = 100;
/** Month index December, where every year is deflated to today's dollars. */
const DECEMBER = 11;

/** Everything about a candidate that does not depend on the other candidates. */
export interface CandidateDraft {
  readonly spec: CandidateSpec;
  readonly ladder: readonly MagiCapWindow[];
  readonly plan: PlannedProjection;
  readonly years: readonly YearRecord[];
  readonly yearDetail: readonly YearDetailRow[];
  readonly unranked: readonly UnrankedReason[];
  readonly passes: number;
  readonly converged: boolean;
}

/** Lifetime totals, each year's nominal cents deflated to today's dollars. */
function computeTotals(plan: PlannedProjection): CandidateTotals {
  let yearsConverted = 0;
  let converted = 0;
  let incomeTax = 0;
  let irmaa = 0;
  let acaCredit = 0;
  for (const row of plan.years) {
    const deflator = realDeflatorAt(plan.projCtx, row.year, DECEMBER) / CENTS_PER_DOLLAR;
    const convertedCents = row.rothConvertedCents ?? 0;
    if (convertedCents > 0) yearsConverted += 1;
    converted += convertedCents * deflator;
    incomeTax += (row.federalTaxCents ?? 0) * deflator;
    irmaa += (row.irmaaSurchargeCents ?? 0) * deflator;
    acaCredit += (row.acaPtcSubsidyCents ?? 0) * deflator;
  }
  return {
    yearsConverted,
    totalConvertedTodayDollars: converted,
    incomeTaxTodayDollars: incomeTax,
    irmaaTodayDollars: irmaa,
    acaCreditTodayDollars: acaCredit,
  };
}

/** Ending balance less the tax still owed on what is left in pre-tax
 *  accounts, both in today's dollars. `deltaVsReferenceTodayDollars` is filled
 *  once the reference is known. */
function computeAfterTax(
  plan: PlannedProjection,
  accounts: AccountsById,
  leftoverTaxRate: number,
): CandidateAfterTax {
  const last = plan.years[plan.years.length - 1];
  const deflator = realDeflatorAt(plan.projCtx, plan.horizonYear, DECEMBER);
  const endingTodayDollars = last.balance * deflator;
  const preTaxTodayDollars = preTaxDollarsAtRowEnd(last, accounts) * deflator;
  return {
    endingTodayDollars,
    preTaxTodayDollars,
    afterTaxTodayDollars: endingTodayDollars - preTaxTodayDollars * leftoverTaxRate,
    deltaVsReferenceTodayDollars: 0,
  };
}

function yearsWhere(rows: readonly DrawdownYear[], pick: (row: DrawdownYear) => number | undefined): number[] {
  return rows.filter((row) => (pick(row) ?? 0) > 0).map((row) => row.year);
}

/** Years the cap moved spending withdrawals to a later taxable tier. */
function reroutedYearsOf(rows: readonly DrawdownYear[]): number[] {
  return yearsWhere(rows, (row) => row.magiCapTierOverrideDollars);
}

/** Years the engine could not honour the ceiling. */
export function breachYearsOf(rows: readonly DrawdownYear[]): number[] {
  return yearsWhere(rows, (row) => row.magiCapBreachDollars);
}

function subtractTotals(a: CandidateTotals, b: CandidateTotals): CandidateTotals {
  return {
    yearsConverted: a.yearsConverted - b.yearsConverted,
    totalConvertedTodayDollars: a.totalConvertedTodayDollars - b.totalConvertedTodayDollars,
    incomeTaxTodayDollars: a.incomeTaxTodayDollars - b.incomeTaxTodayDollars,
    irmaaTodayDollars: a.irmaaTodayDollars - b.irmaaTodayDollars,
    acaCreditTodayDollars: a.acaCreditTodayDollars - b.acaCreditTodayDollars,
  };
}

/** The numbers ranking needs, computed once per candidate. */
export interface MeasuredCandidate {
  readonly draft: CandidateDraft;
  readonly totals: CandidateTotals;
  readonly afterTax: CandidateAfterTax;
}

export function measureDraft(
  draft: CandidateDraft,
  accounts: AccountsById,
  leftoverTaxRate: number,
): MeasuredCandidate {
  return {
    draft,
    totals: computeTotals(draft.plan),
    afterTax: computeAfterTax(draft.plan, accounts, leftoverTaxRate),
  };
}

/** Complete a measured candidate once the reference and its rank are known. */
export function finalizeCandidate(
  measured: MeasuredCandidate,
  reference: MeasuredCandidate,
  rank: number | null,
): RothCandidate {
  const { draft, totals, afterTax } = measured;
  return {
    id: draft.spec.id,
    isReference: draft.spec.isReference,
    bracketRate: draft.spec.bracketRate,
    guarded: draft.spec.guarded,
    ladder: draft.ladder,
    drawdownYears: draft.plan.years,
    years: draft.years,
    yearDetail: draft.yearDetail,
    totals,
    deltaVsReference: subtractTotals(totals, reference.totals),
    afterTax: {
      ...afterTax,
      deltaVsReferenceTodayDollars:
        afterTax.afterTaxTodayDollars - reference.afterTax.afterTaxTodayDollars,
    },
    rank,
    unranked: draft.unranked,
    reroutedYears: reroutedYearsOf(draft.plan.years),
    passes: draft.passes,
    converged: draft.converged,
  };
}
