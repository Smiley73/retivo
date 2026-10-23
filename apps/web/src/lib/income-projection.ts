/**
 * Per-year and per-month income projection for pension annuities, part-time income and one-off windfalls, driven by the active scenario's resolved streams.
 * Social Security is projected separately by `ss-projection.ts` because its math (spousal, survivor, COLA, claim age) differs from a pension's.
 */
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';
import type { ResolvedIncomeStream } from './income-resolution';

/**
 * Projected balance of a Cash Balance Pension account at (year, month0). A linked `lumpSum`
 * stream's `lumpSumAmount` is forced to 0 on save, so its amount comes from here; `null` (balance
 * unknown, e.g. past the CBP's horizon) drops the event silently.
 */
export type LinkedCbpBalanceLookup = (
  cbpAccountId: string,
  year: number,
  month0: number,
) => number | null;

interface IncomeContextMember {
  id: string;
  birthYear: number | null;
  birthMonth0: number | null;
  lifeExpectancyAge: number;
  // Owner-relative: `retirementStart` anchors resolve here, falling back to the context-level
  // `retirementStartYear`.
  retirementYear: number;
  retirementMonth0: number;
  // The form stores memberId='primary' as a placeholder; age anchors route to the actual owner.
  isPrimary: boolean;
}

export interface IncomeContext {
  members: Map<string, IncomeContextMember>;
  retirementStartYear: number;
  /**
   * Calendar year of "today", the anchor for the one-off / lump-sum inflation roll-forward; when
   * unspecified one-offs are nominal at the event year.
   */
  todayYear?: number;
  /** 0-11 month of "today" within `todayYear`; default 0. */
  todayMonthIndex?: number;
  /**
   * Annual inflation rate (percent) for the today-anchored one-off and lump-sum factor; default 0.
   */
  inflationPct?: number;
  /**
   * Projected CBP balance lookup: a linked `lumpSum` stream's deposit amount comes from it, not the
   * hidden `lumpSumAmount`. Omit it (or return `null`) and linked lump-sum deposits are dropped
   * rather than emitted as zero.
   */
  linkedCbpBalanceLookup?: LinkedCbpBalanceLookup;
}

/**
 * Effective COLA rate (percent) for an income stream: the scenario inflation rate when
 * `tracksInflation`, else the stream's `colaPct` (default 0). The MC kernel receives arrays with
 * this growth already embedded, so CPI sampling must not re-apply COLA.
 */
export function resolveIncomeColaPct(
  payload: Pick<IncomeStreamPayload, 'tracksInflation' | 'colaPct'>,
  scenarioInflationPct: number,
): number {
  return payload.tracksInflation === true ? scenarioInflationPct : (payload.colaPct ?? 0);
}

function buildInflationFactorAt(
  ctx: IncomeContext,
): (year: number, monthIndex: number) => number {
  const rate = ctx.inflationPct ?? 0;
  if (rate === 0 || ctx.todayYear === undefined) return () => 1;
  const asOfMonth = ctx.todayYear * 12 + (ctx.todayMonthIndex ?? 0);
  const base = 1 + rate / 100;
  return (year, monthIndex) =>
    Math.pow(base, (year * 12 + monthIndex - asOfMonth) / 12);
}

/**
 * Annual income output in two disjoint buckets: `spendable` (offsets expenses in net need: pension,
 * part-time, untargeted one-offs) and `deposits` (lump sums that add to the portfolio and must not
 * also reduce net need: targeted one-offs and pension lump-sums, tagged `bySource`). The split
 * follows the data model (`targetAccountId` set or not), so a targeted one-off cannot be counted
 * twice.
 */
export interface IncomeYearOutput {
  year: number;
  /** Income amounts that offset net-need in the drawdown engine. */
  spendable: {
    pension: number;
    partTime: number;
    /** Sum of one-off windfalls without a `targetAccountId`. */
    oneOff: number;
    total: number;
  };
  /** Lump-sum inflows that feed the portfolio directly. */
  deposits: {
    /**
     * Per-account totals keyed by `Account.id`, injected into the account's pre-drawdown balance
     * that year.
     */
    byAccount: Map<string, number>;
    /** Split of the same dollars by event origin, for chart labelling. */
    bySource: {
      /** Targeted one-off windfalls. */
      oneOff: number;
      /** Pension lump-sum payouts. */
      pensionLumpSum: number;
    };
    /** Sum across `byAccount` (`= bySource.oneOff + bySource.pensionLumpSum`). */
    total: number;
  };
}

/**
 * Month-resolution variant for the chart band: annualized run-rates ($/yr). Continuous streams are
 * flat while active; a one-off renders at its literal amount for one month, so the chart integral
 * differs from the annual rollup in event years and `projectIncomeByYear` stays the source of truth
 * for headline math. Pension starts resolve on the owner's birthday month (`startAge.years` only)
 * and year-anchored windfalls default to January. The mean of the 12 monthly rates equals the
 * annual total, including the J&S switch (full benefit through the death year, the J&S percentage
 * from the next January).
 */
export interface IncomeMonthOutput {
  fractionalYear: number;
  year: number;
  month0: number;
  /** Pension annuity run-rate at this month, $/yr. */
  pensionIncome: number;
  /** Part-time run-rate at this month, $/yr. */
  partTimeIncome: number;
  /**
   * Spendable one-off income this month (untargeted windfalls); targeted one-offs and pension
   * lump-sums go on `depositInflow`.
   */
  oneOffIncome: number;
  /**
   * Lump-sum portfolio addition this month (targeted one-offs and pension lump-sums); per-account
   * routing lives on `IncomeYearOutput.deposits.byAccount`.
   */
  depositInflow: number;
  /** Sum of spendable + deposit at this month, $/yr. */
  total: number;
}

export interface IncomeMonthlyContext extends IncomeContext {
  /** 0-indexed retirement month for `retirementStart` part-time anchors; default 0. */
  retirementMonth0?: number;
}

export interface MonthIndexed {
  year: number;
  month0: number;
}

const monthIdxIncome = (year: number, month0: number): number => year * 12 + month0;

function birthYearMonth(ctx: IncomeContext, memberId: string): MonthIndexed | null {
  const m = ctx.members.get(memberId);
  if (!m?.birthYear) return null;
  return { year: m.birthYear, month0: m.birthMonth0 ?? 0 };
}

function resolveIncomeStart(
  start: NonNullable<IncomeStreamPayload['start']>,
  memberId: string,
  ctx: IncomeContext,
): MonthIndexed | null {
  switch (start.kind) {
    case 'age': {
      const b = birthYearMonth(ctx, memberId);
      if (!b) return null;
      const total = b.month0 + start.years * 12 + start.months;
      return {
        year: b.year + Math.floor(total / 12),
        month0: ((total % 12) + 12) % 12,
      };
    }
    case 'year':
      return { year: start.year, month0: 0 };
    case 'retirementStart': {
      const member = ctx.members.get(memberId);
      if (member) {
        return { year: member.retirementYear, month0: member.retirementMonth0 };
      }
      return {
        year: ctx.retirementStartYear,
        month0: (ctx as IncomeMonthlyContext).retirementMonth0 ?? 0,
      };
    }
  }
}

function pensionStartMonth(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
): MonthIndexed | null {
  if (p.kind !== 'pension' || p.payoutType !== 'annuity' || !p.start) return null;
  return resolveIncomeStart(p.start, p.memberId, ctx);
}

// Exclusive end-of-life boundary: death is Dec 31 of `deathYear`, so the full benefit is paid
// through that December and J&S starts the next January, matching the annual
// `pensionerDeathYear()`.
function pensionerDeathMonth(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
): MonthIndexed | null {
  if (p.kind !== 'pension') return null;
  const m = ctx.members.get(p.memberId);
  if (!m?.birthYear) return null;
  const b = birthYearMonth(ctx, p.memberId);
  if (!b) return null;
  const deathYear = b.year + m.lifeExpectancyAge;
  return { year: deathYear + 1, month0: 0 };
}

function partTimeStartMonth(
  p: IncomeStreamPayload,
  ctx: IncomeMonthlyContext,
): MonthIndexed | null {
  if (p.kind !== 'partTime' || !p.start) return null;
  return resolveIncomeStart(p.start, p.memberId, ctx);
}

function ownerRetirementYear(ctx: IncomeContext, memberId: string): number {
  const member = ctx.members.get(memberId);
  return member?.retirementYear ?? ctx.retirementStartYear;
}

function partTimeEndMonth(
  p: IncomeStreamPayload,
  ctx: IncomeMonthlyContext,
  startMonth: MonthIndexed,
): MonthIndexed | null {
  if (p.kind !== 'partTime' || !p.end) return null;
  const owner = ctx.members.get(p.memberId);
  switch (p.end.kind) {
    case 'age': {
      const b = birthYearMonth(ctx, p.memberId);
      if (!b) return null;
      const total = b.month0 + p.end.years * 12 + p.end.months;
      return {
        year: b.year + Math.floor(total / 12),
        month0: ((total % 12) + 12) % 12,
      };
    }
    case 'year':
      return { year: p.end.year + 1, month0: 0 };
    case 'lifetime': {
      if (!owner?.birthYear) return null;
      const b = birthYearMonth(ctx, p.memberId);
      if (!b) return null;
      // Death is Dec 31 of `deathYear`; the exclusive end is Jan 1 of the next year, matching the
      // annual `partTimeEndYear()`.
      const deathYear = b.year + owner.lifeExpectancyAge;
      return { year: deathYear + 1, month0: 0 };
    }
    case 'endOfRetirementYear':
      return {
        year: ownerRetirementYear(ctx, p.memberId) + p.end.offsetYears + 1,
        month0: 0,
      };
    case 'durationFromStart': {
      const total = startMonth.month0 + p.end.months;
      return {
        year: startMonth.year + Math.floor(total / 12),
        month0: ((total % 12) + 12) % 12,
      };
    }
    default:
      return null;
  }
}

/**
 * Calendar (year, month0) of a one-off or pension lump-sum receipt; exported so the Income overview
 * page can project the linked CBP balance to the same event month.
 */
export function oneOffMonth(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
): MonthIndexed | null {
  if (p.kind === 'oneOff' && p.start) {
    return resolveIncomeStart(p.start, p.memberId, ctx);
  }
  if (p.kind === 'pension' && p.payoutType === 'lumpSum' && p.start) {
    return resolveIncomeStart(p.start, p.memberId, ctx);
  }
  return null;
}

export function projectIncomeByMonth(
  resolvedIncome: ResolvedIncomeStream[],
  ctx: IncomeMonthlyContext,
  yearRange: { from: number; to: number },
): IncomeMonthOutput[] {
  const out: IncomeMonthOutput[] = [];
  const inflationFactorAt = buildInflationFactorAt(ctx);
  for (let y = yearRange.from; y <= yearRange.to; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      const idx = monthIdxIncome(y, m);
      let pensionTotal = 0;
      let partTimeTotal = 0;
      let spendableOneOff = 0;
      let depositInflow = 0;

      for (const item of resolvedIncome) {
        const p = item.payload;

        if (p.kind === 'pension' && p.payoutType === 'annuity') {
          const start = pensionStartMonth(p, ctx);
          if (!start || idx < monthIdxIncome(start.year, start.month0)) continue;
          const yearsSinceStart = Math.max(0, y - start.year);
          const colaFactor = 1 + resolveIncomeColaPct(p, ctx.inflationPct ?? 0) / 100;
          let benefit = (p.monthlyBenefit ?? 0) * 12 * Math.pow(colaFactor, yearsSinceStart);
          // Survivor: post-pensioner death, J&S percent kicks in.
          const death = pensionerDeathMonth(p, ctx);
          if (death && idx >= monthIdxIncome(death.year, death.month0)) {
            const jns = (p.jointAndSurvivorPct ?? 0) / 100;
            benefit *= jns;
          }
          pensionTotal += benefit;
          continue;
        }

        if (p.kind === 'partTime') {
          const start = partTimeStartMonth(p, ctx);
          if (!start) continue;
          const end = partTimeEndMonth(p, ctx, start);
          if (!end) continue;
          if (
            idx < monthIdxIncome(start.year, start.month0) ||
            idx >= monthIdxIncome(end.year, end.month0)
          ) {
            continue;
          }
          const yearsSinceStart = Math.max(0, y - start.year);
          const colaFactor = 1 + resolveIncomeColaPct(p, ctx.inflationPct ?? 0) / 100;
          partTimeTotal += (p.annualAmount ?? 0) * Math.pow(colaFactor, yearsSinceStart);
          continue;
        }

        // One-offs (windfall and pension lump-sum) are today's dollars inflated to the event month;
        // a `targetAccountId` makes one a portfolio deposit, otherwise spendable income, never
        // both.
        const eventMonth = oneOffMonth(p, ctx);
        if (!eventMonth || eventMonth.year !== y || eventMonth.month0 !== m) continue;
        const amount = resolveOneOffAmount(
          p,
          ctx,
          eventMonth.year,
          eventMonth.month0,
          inflationFactorAt,
        );
        if (amount === 0) continue;
        if (oneOffTargetAccount(p)) {
          depositInflow += amount;
        } else {
          spendableOneOff += amount;
        }
      }

      const total =
        pensionTotal + partTimeTotal + spendableOneOff + depositInflow;
      out.push({
        fractionalYear: y + m / 12,
        year: y,
        month0: m,
        pensionIncome: pensionTotal,
        partTimeIncome: partTimeTotal,
        oneOffIncome: spendableOneOff,
        depositInflow,
        total,
      });
    }
  }
  return out;
}

const annualizePension = (p: IncomeStreamPayload): number =>
  (p.monthlyBenefit ?? 0) * 12;

function pensionStartYear(p: IncomeStreamPayload, ctx: IncomeContext): number | null {
  if (p.kind !== 'pension' || p.payoutType !== 'annuity' || !p.start) return null;
  return resolveStartYear(p.start, p.memberId, ctx);
}

function resolveStartYear(
  start: NonNullable<IncomeStreamPayload['start']>,
  memberId: string,
  ctx: IncomeContext,
): number | null {
  switch (start.kind) {
    case 'age': {
      const member = ctx.members.get(memberId);
      if (!member?.birthYear) return null;
      return member.birthYear + start.years;
    }
    case 'year':
      return start.year;
    case 'retirementStart': {
      const member = ctx.members.get(memberId);
      return member?.retirementYear ?? ctx.retirementStartYear;
    }
  }
}

function pensionerDeathYear(p: IncomeStreamPayload, ctx: IncomeContext): number | null {
  if (p.kind !== 'pension') return null;
  const member = ctx.members.get(p.memberId);
  if (!member?.birthYear) return null;
  return member.birthYear + member.lifeExpectancyAge;
}

function pensionAnnuityForYear(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
  year: number,
): number {
  if (p.kind !== 'pension' || p.payoutType !== 'annuity') return 0;
  const start = pensionStartYear(p, ctx);
  if (start === null || year < start) return 0;

  const colaFactor = 1 + resolveIncomeColaPct(p, ctx.inflationPct ?? 0) / 100;
  const yearsSinceStart = year - start;
  const baseAnnual = annualizePension(p);
  let benefit = baseAnnual * Math.pow(colaFactor, yearsSinceStart);

  // After the pensioner's death year (alive through Dec 31) the survivor gets the J&S %.
  const death = pensionerDeathYear(p, ctx);
  if (death !== null && year > death) {
    const jns = (p.jointAndSurvivorPct ?? 0) / 100;
    benefit = benefit * jns;
  }
  return benefit;
}

function partTimeStartYear(p: IncomeStreamPayload, ctx: IncomeContext): number | null {
  if (p.kind !== 'partTime' || !p.start) return null;
  return resolveStartYear(p.start, p.memberId, ctx);
}

function partTimeEndYear(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
  startYear: number,
): number | null {
  if (p.kind !== 'partTime' || !p.end) return null;
  const owner = ctx.members.get(p.memberId);
  switch (p.end.kind) {
    case 'age':
      return owner?.birthYear ? owner.birthYear + p.end.years : null;
    case 'year':
      return p.end.year + 1;
    case 'lifetime':
      if (!owner?.birthYear) return null;
      return owner.birthYear + owner.lifeExpectancyAge + 1;
    case 'endOfRetirementYear':
      return ownerRetirementYear(ctx, p.memberId) + p.end.offsetYears + 1;
    case 'durationFromStart':
      return startYear + Math.ceil(p.end.months / 12);
    default:
      return null;
  }
}

function partTimeForYear(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
  year: number,
): number {
  if (p.kind !== 'partTime') return 0;
  const start = partTimeStartYear(p, ctx);
  if (start === null) return 0;
  const end = partTimeEndYear(p, ctx, start);
  if (end === null) return 0;
  if (year < start || year >= end) return 0;
  const colaFactor = 1 + resolveIncomeColaPct(p, ctx.inflationPct ?? 0) / 100;
  const yearsSinceStart = year - start;
  return (p.annualAmount ?? 0) * Math.pow(colaFactor, yearsSinceStart);
}

function oneOffForYear(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
  year: number,
  inflationFactorAt: (year: number, monthIndex: number) => number,
): number {
  // One-off and lump-sum amounts are today's dollars inflated to the receipt month; year-resolution
  // receipts read the factor at the resolved spike month so mid-year events line up with the
  // monthly chart.
  if (!p.start) return 0;
  if (p.kind !== 'oneOff' && !(p.kind === 'pension' && p.payoutType === 'lumpSum')) {
    return 0;
  }
  const receiptYear = resolveStartYear(p.start, p.memberId, ctx);
  if (receiptYear === null || year !== receiptYear) return 0;
  const event = resolveIncomeStart(p.start, p.memberId, ctx);
  const monthIdx = event?.month0 ?? 0;
  return resolveOneOffAmount(p, ctx, year, monthIdx, inflationFactorAt);
}

function oneOffTargetAccount(p: IncomeStreamPayload): string | undefined {
  if (p.kind === 'oneOff') return p.targetAccountId;
  if (p.kind === 'pension' && p.payoutType === 'lumpSum') {
    return p.targetAccountId;
  }
  return undefined;
}

/**
 * A targeted deposit event resolved to its calendar event month in event-month dollars, so the page
 * can route pre-retirement deposits to accumulation and post-retirement ones to the drawdown
 * engine.
 */
export interface TargetedDepositEvent {
  targetAccountId: string;
  /**
   * Owning member of the source stream, so post-retirement plain pension lump-sums resolve their
   * owner downstream; undefined only if the stream carries no `memberId`.
   */
  memberId?: string;
  year: number;
  month0: number;
  /** Event-month dollars (inflation roll-forward already applied). */
  amount: number;
  /**
   * Set for a `lumpSum` pension stream with `linkedCbpAccountId`; the page subtracts that CBP's
   * at-primary balance from `portfolioAtRetirement` so the transferred dollars are not counted
   * twice.
   */
  linkedCbpAccountId?: string;
}

/**
 * Dollar amount a one-off or pension lump-sum contributes at its event month: a linked-CBP lump-sum
 * reads `ctx.linkedCbpBalanceLookup` (0 on a miss, `null` or non-positive, and the caller drops the
 * event); an untargeted one-off or plain lump-sum inflation-rolls `oneOffAmount` / `lumpSumAmount`
 * from today.
 */
function resolveOneOffAmount(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
  eventYear: number,
  eventMonth0: number,
  inflationFactorAt: (year: number, monthIndex: number) => number,
): number {
  const isLinkedCbpLumpSum =
    p.kind === 'pension' &&
    p.payoutType === 'lumpSum' &&
    typeof p.linkedCbpAccountId === 'string' &&
    p.linkedCbpAccountId.length > 0;
  if (isLinkedCbpLumpSum) {
    const lookup = ctx.linkedCbpBalanceLookup;
    if (!lookup) return 0;
    const cbpBalance = lookup(
      (p as { linkedCbpAccountId: string }).linkedCbpAccountId,
      eventYear,
      eventMonth0,
    );
    // The CBP balance is already in event-month nominal dollars; no inflation factor.
    return cbpBalance === null || cbpBalance <= 0 ? 0 : cbpBalance;
  }
  const factor = inflationFactorAt(eventYear, eventMonth0);
  if (p.kind === 'oneOff') return (p.oneOffAmount ?? 0) * factor;
  if (p.kind === 'pension' && p.payoutType === 'lumpSum') {
    return (p.lumpSumAmount ?? 0) * factor;
  }
  return 0;
}

/**
 * Targeted one-offs and pension lump-sums resolved to (year, month0, amount); untargeted one-offs
 * feed net need, not the portfolio. A linked-CBP lump-sum whose lookup is omitted or returns `null`
 * is dropped (e.g. post-primary-retirement, where the CBP balance is already pooled into the
 * drawdown engine).
 */
export function collectTargetedDepositEvents(
  resolvedIncome: ResolvedIncomeStream[],
  ctx: IncomeMonthlyContext,
): TargetedDepositEvent[] {
  const inflationFactorAt = buildInflationFactorAt(ctx);
  const out: TargetedDepositEvent[] = [];
  for (const item of resolvedIncome) {
    const p = item.payload;
    const target = oneOffTargetAccount(p);
    if (!target) continue;
    const eventMonth = oneOffMonth(p, ctx);
    if (!eventMonth) continue;
    const amount = resolveOneOffAmount(
      p,
      ctx,
      eventMonth.year,
      eventMonth.month0,
      inflationFactorAt,
    );
    if (amount === 0) continue;
    const linkedCbpAccountId =
      p.kind === 'pension' &&
      p.payoutType === 'lumpSum' &&
      typeof p.linkedCbpAccountId === 'string' &&
      p.linkedCbpAccountId.length > 0
        ? p.linkedCbpAccountId
        : undefined;
    out.push({
      targetAccountId: target,
      ...(p.memberId !== undefined ? { memberId: p.memberId } : {}),
      year: eventMonth.year,
      month0: eventMonth.month0,
      amount,
      ...(linkedCbpAccountId !== undefined ? { linkedCbpAccountId } : {}),
    });
  }
  return out;
}

/**
 * A post-retirement plain (non-linked-CBP) pension lump-sum event, classified per event so both
 * engines can place it in its target account. Linked-CBP lump-sums route through the CBP seam and
 * one-off windfalls stay on the household-pool `depositInflow` spread. Sourced from
 * `collectTargetedDepositEvents`, which keeps `targetAccountId` and `memberId`, so same-month
 * events stay disaggregated.
 */
export interface PlainPensionPlacementEvent {
  /** Target account the lump-sum lands in (= `targetAccountId`). */
  readonly accountId: string;
  /** Owning member of the source stream; empty string when it carried no `memberId`. */
  readonly memberId: string;
  /** Event-month dollars (inflation roll-forward already applied). */
  readonly amount: number;
  /** Absolute step month `year * 12 + month0`. */
  readonly month0: number;
}

/**
 * Post-retirement plain pension lump-sum placements from the targeted-deposit producer: only events
 * at or after `primaryRetirementAbsMonth` (earlier ones are placed per account in accumulation),
 * excluding linked-CBP lump-sums, which have their own RMD-aware seam.
 */
export function collectPostRetirementPlainPensionPlacements(
  resolvedIncome: ResolvedIncomeStream[],
  ctx: IncomeMonthlyContext,
  primaryRetirementAbsMonth: number,
): PlainPensionPlacementEvent[] {
  const inflationFactorAt = buildInflationFactorAt(ctx);
  const out: PlainPensionPlacementEvent[] = [];
  for (const item of resolvedIncome) {
    const p = item.payload;
    if (p.kind !== 'pension' || p.payoutType !== 'lumpSum') continue;
    const isLinkedCbp =
      typeof p.linkedCbpAccountId === 'string' && p.linkedCbpAccountId.length > 0;
    if (isLinkedCbp) continue;
    const target = p.targetAccountId;
    if (!target) continue;
    const eventMonth = oneOffMonth(p, ctx);
    if (!eventMonth) continue;
    const abs = eventMonth.year * 12 + eventMonth.month0;
    if (abs < primaryRetirementAbsMonth) continue;
    const amount = resolveOneOffAmount(
      p,
      ctx,
      eventMonth.year,
      eventMonth.month0,
      inflationFactorAt,
    );
    if (amount <= 0) continue;
    out.push({
      accountId: target,
      memberId: p.memberId,
      amount,
      month0: abs,
    });
  }
  return out;
}

export function projectIncomeByYear(
  resolvedIncome: ResolvedIncomeStream[],
  ctx: IncomeContext,
  yearRange: { from: number; to: number },
): IncomeYearOutput[] {
  const out: IncomeYearOutput[] = [];
  const inflationFactorAt = buildInflationFactorAt(ctx);
  for (let y = yearRange.from; y <= yearRange.to; y += 1) {
    let pensionAnnuity = 0;
    let partTime = 0;
    let spendableOneOff = 0;
    let depositOneOff = 0;
    let depositPensionLumpSum = 0;
    const byAccount = new Map<string, number>();
    for (const item of resolvedIncome) {
      const p = item.payload;
      if (p.kind === 'pension' && p.payoutType === 'annuity') {
        pensionAnnuity += pensionAnnuityForYear(p, ctx, y);
        continue;
      }
      if (p.kind === 'partTime') {
        partTime += partTimeForYear(p, ctx, y);
        continue;
      }
      // A `targetAccountId` makes it a deposit, otherwise spendable; the drawdown engine must not
      // see one dollar as both.
      const amount = oneOffForYear(p, ctx, y, inflationFactorAt);
      if (amount <= 0) continue;
      const target = oneOffTargetAccount(p);
      if (target) {
        byAccount.set(target, (byAccount.get(target) ?? 0) + amount);
        if (p.kind === 'pension' && p.payoutType === 'lumpSum') {
          depositPensionLumpSum += amount;
        } else {
          depositOneOff += amount;
        }
      } else {
        // Untargeted windfall; a lump-sum without a target is also treated as spendable (defensive,
        // never hit in practice).
        spendableOneOff += amount;
      }
    }
    const spendableTotal = pensionAnnuity + partTime + spendableOneOff;
    const depositsTotal = depositOneOff + depositPensionLumpSum;
    out.push({
      year: y,
      spendable: {
        pension: pensionAnnuity,
        partTime,
        oneOff: spendableOneOff,
        total: spendableTotal,
      },
      deposits: {
        byAccount,
        bySource: {
          oneOff: depositOneOff,
          pensionLumpSum: depositPensionLumpSum,
        },
        total: depositsTotal,
      },
    });
  }
  return out;
}

/**
 * Build an `IncomeContext` from member aggregates plus scenario-resolved life expectancy and
 * retirement-start year. `retirementDateByMember` lets owner-relative `retirementStart` /
 * `endOfRetirementYear` anchors resolve to each owner's date, falling back to
 * `retirementStartYear`.
 */
export function buildIncomeContext(
  members: Aggregate<HouseholdMemberPayload>[],
  scenarioInputs: {
    retirementStartYear: number;
    lifeExpectancyPrimary: number;
    lifeExpectancySecondary?: number;
    retirementDateByMember?: Map<string, { year: number; month0?: number }>;
    /**
     * Today-anchor and inflation rate for the today's-dollar one-off roll-forward; omit for literal
     * amounts.
     */
    todayYear?: number;
    todayMonthIndex?: number;
    inflationPct?: number;
    /** Optional CBP balance lookup — see `IncomeContext.linkedCbpBalanceLookup`. */
    linkedCbpBalanceLookup?: LinkedCbpBalanceLookup;
  },
): IncomeContext {
  const map = new Map<string, IncomeContextMember>();
  for (const m of members) {
    const birthYear = Number(m.payload.birthdate?.slice(0, 4));
    const birthMonth = Number(m.payload.birthdate?.slice(5, 7));
    const birthMonth0 =
      Number.isFinite(birthMonth) && birthMonth >= 1 && birthMonth <= 12
        ? birthMonth - 1
        : null;
    const memberRet = scenarioInputs.retirementDateByMember?.get(m.id);
    map.set(m.id, {
      id: m.id,
      birthYear: Number.isFinite(birthYear) ? birthYear : null,
      birthMonth0,
      lifeExpectancyAge: m.payload.isPrimary
        ? scenarioInputs.lifeExpectancyPrimary
        : scenarioInputs.lifeExpectancySecondary ?? scenarioInputs.lifeExpectancyPrimary,
      retirementYear: memberRet?.year ?? scenarioInputs.retirementStartYear,
      retirementMonth0: memberRet?.month0 ?? 0,
      isPrimary: m.payload.isPrimary,
    });
  }
  return {
    members: map,
    retirementStartYear: scenarioInputs.retirementStartYear,
    todayYear: scenarioInputs.todayYear,
    todayMonthIndex: scenarioInputs.todayMonthIndex,
    inflationPct: scenarioInputs.inflationPct,
    linkedCbpBalanceLookup: scenarioInputs.linkedCbpBalanceLookup,
  };
}
