/**
 * Per-year income projection — pension annuities, part-time / earned
 * income, and one-off windfalls. Driven by the resolved IncomeStream
 * list for the active scenario.
 *
 * SS is projected separately by ss-projection.ts so the drawdown
 * engine can sum both into a single income series. Keep them apart
 * because the SS math (spousal / survivor / COLA / claim age) is
 * fundamentally different from a pension annuity (J&S / fixed start
 * age / per-stream COLA).
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split:
 * it presents a small public surface — the projection entry points
 * (`projectIncomeByMonth` / `projectIncomeByYear` / `buildIncomeContext` and a
 * few pure helpers) — over a deterministic internal helper hierarchy that all
 * threads the one shared `IncomeContext` (resolved streams, members, COLA /
 * inflation tracking, linked-CBP balance lookup). The per-kind month/year
 * builders read that context pervasively, so a split would re-export the
 * internal context + month-indexing types for no boundary gain. The file is
 * near-zero-churn (the income math is stable), so the marginal maintenance cost
 * of the over-cap shape is low. Trigger: a change adding 5 or more lines here
 * must either refactor the file back under the limit or re-justify this
 * exception in this note.
 */
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';
import type { ResolvedIncomeStream } from './income-resolution';

/** Lookup fn that returns a Cash Balance Pension account's projected
 *  balance at a given (year, month0). Lets income-projection emit the
 *  correct deposit amount for a `payoutType: 'lumpSum'` stream whose
 *  `linkedCbpAccountId` is set — the user-entered `lumpSumAmount` is
 *  forced to 0 on save for those streams (UI hides the field) so the
 *  amount must come from the projection engine instead. Return `null`
 *  to indicate the CBP balance is unknown at that month (e.g. event
 *  falls past the CBP's projection horizon); the helper then drops
 *  the event silently. */
export type LinkedCbpBalanceLookup = (
  cbpAccountId: string,
  year: number,
  month0: number,
) => number | null;

interface IncomeContextMember {
  id: string;
  birthYear: number | null;
  /** 0-indexed calendar month of the member's birthdate (Jan = 0).
   *  Drives age-anchored start/end resolution at month precision in
   *  `projectIncomeByMonth`. `null` when the birthdate is missing or
   *  malformed; `projectIncomeByYear` ignores this field and stays on
   *  the existing year-only resolution. */
  birthMonth0: number | null;
  lifeExpectancyAge: number;
  /** Owner-relative retirement year. `ScheduleStart.kind === 'retirementStart'`
   *  on an income stream anchored to this member resolves here, not the
   *  household-level fallback. Couples retiring at different ages get
   *  different `retirementYear` values per member. Falls back to the
   *  context-level `retirementStartYear` when no per-member date was
   *  provided. */
  retirementYear: number;
  /** 0-indexed calendar month of the member's retirement. Defaults to
   *  0 (Jan) when only year resolution is known. */
  retirementMonth0: number;
  /** Used for partTime start/end resolution when the stream uses an
   *  age-anchor; we re-route to the owner's age (the form stores
   *  memberId='primary' as a placeholder, but the engine should
   *  honour the actual owner). */
  isPrimary: boolean;
}

export interface IncomeContext {
  members: Map<string, IncomeContextMember>;
  /** Calendar year retirement starts (primary's date by convention). */
  retirementStartYear: number;
  /** Calendar year of "today" — the projection's anchor year. Used by
   *  the one-off / lump-sum inflation roll-forward.
   *  When unspecified the engine treats one-offs as nominal-at-event-year
   *  (legacy behaviour);
   *  callers wanting today's-dollar interpretation must supply it. */
  todayYear?: number;
  /** 0-11 month index of "today" within `todayYear`. Defaults to 0
   *  (Jan) when only year resolution is available. */
  todayMonthIndex?: number;
  /** Annual inflation rate, percent. Drives the today-anchored
   *  factor for one-off + pension lump-sum amounts. Defaults to 0
   *  (no inflation applied) when omitted. */
  inflationPct?: number;
  /** Optional projected Cash Balance Pension balance lookup. When a
   *  `payoutType: 'lumpSum'` stream sets `linkedCbpAccountId`, the
   *  deposit amount comes from this lookup (the CBP's projected
   *  balance at the lump-sum's event month), NOT the user-entered
   *  `lumpSumAmount` field (which the UI hides and saves as 0 for
   *  linked elections). Omit (or return `null`) for callers that
   *  don't need linked-CBP routing — the engine then drops linked
   *  lump-sum deposits silently rather than emitting zero-amount
   *  events. */
  linkedCbpBalanceLookup?: LinkedCbpBalanceLookup;
}

/**
 * Resolve the effective COLA rate for an income stream payload.
 *
 * When `payload.tracksInflation === true`, the stream grows at the
 * scenario's inflation rate (`scenarioInflationPct`). Otherwise uses the
 * stream's own `colaPct` (defaults to 0 when absent). This is the
 * single canonical read point for stream COLA — all engine paths that
 * apply growth to pension annuity / part-time income call this helper.
 *
 * Note: the MC kernel receives pre-computed year-by-year nominal income
 * arrays, so CPI sampling in the MC paths does NOT re-apply COLA
 * on top of these arrays — the arrays already embed the per-stream growth
 * rate decided here.
 */
export function resolveIncomeColaPct(
  payload: Pick<IncomeStreamPayload, 'tracksInflation' | 'colaPct'>,
  scenarioInflationPct: number,
): number {
  return payload.tracksInflation === true ? scenarioInflationPct : (payload.colaPct ?? 0);
}

/**
 * Build a month-precise inflation-factor lookup anchored at the
 * context's `asOfMonth = todayYear*12 + (todayMonthIndex ?? 0)`.
 * Returns the identity factor 1 when no anchor or no rate is set.
 *
 * Used by `oneOffForYear` (annual) and the monthly one-off /
 * lump-sum code path inside `projectIncomeByMonth`.
 */
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
 * Annual income output, split into two disjoint buckets:
 *
 *   `spendable` — income that offsets ordinary expenses in the
 *     drawdown engine's net-need calculation. Pension annuity,
 *     part-time, and **untargeted** one-off windfalls (no
 *     `targetAccountId`).
 *
 *   `deposits` — lump-sum inflows that **add to the portfolio** and
 *     therefore must NOT also reduce net-need. **Targeted** one-off
 *     windfalls (`targetAccountId` set) and pension lump-sum payouts.
 *     Tagged `bySource` so the chart can show the user where each
 *     dollar came from.
 *
 * The classification is by data model — a one-off carries
 * `targetAccountId` iff it lands in a specific account — not inferred
 * by the consumer. Pre-fix the page sometimes double-counted targeted
 * one-offs (added to the portfolio AND offset net-need); separating
 * the buckets at the engine layer makes the double-count
 * unrepresentable.
 *
 * Existing surfaces that previously read `oneOffIncome` /
 * `depositsByAccount` consume `spendable.oneOff` and `deposits.byAccount`
 * (and the new `deposits.bySource.{oneOff, pensionLumpSum}`) instead.
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
    /** Per-account totals — keyed by `Account.id`. The drawdown engine
     *  injects each into the targeted account's pre-drawdown balance
     *  in that year. */
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
 * Month-resolution variant for the chart-band visualisation. Values
 * are annualized run-rates in $/yr at that month. Continuous streams
 * (pension annuity, part-time) emit a flat rate while active, zero
 * outside. One-offs render at their **literal amount** for exactly one
 * month — directly readable against the y-axis. This intentionally
 * diverges from the annual-rollup invariant in event years (the
 * chart's integral over the spike month is `amount/12`, while
 * `projectIncomeByYear` sums the full `amount` into the annual total).
 * The year-by-year table on the Balance Projection page (which uses
 * the annual fn) stays the source of truth for headline math.
 *
 * Pension annuity / lump-sum starts carry `startAge.years` only in
 * the data model — the engine resolves them on the owner's birthday
 * month (e.g. age 65 for a March birthday → March of birthYear + 65).
 * Year-anchored windfalls have no month signal in the payload at all
 * and default to January of the receipt year. Part-time starts use
 * the same `ScheduleStart` vocabulary as expenses so age-anchored
 * starts already carry years + months explicitly.
 *
 * Annual-rollup invariant: mean of the 12 monthly rates per year
 * equals the corresponding `projectIncomeByYear` total. The pension annuity
 * J&S survivor switch lines up too: both paths pay the full benefit through
 * the pensioner's death year and switch to the J&S percentage in January of
 * the following year. The drawdown engine + year-table stay on the annual
 * path.
 */
export interface IncomeMonthOutput {
  fractionalYear: number;
  year: number;
  month0: number;
  /** Pension annuity run-rate at this month, $/yr. */
  pensionIncome: number;
  /** Part-time run-rate at this month, $/yr. */
  partTimeIncome: number;
  /** **Spendable** one-off income at this month (untargeted windfalls
   *  only). Drives the income-breakdown chart's "One-off" stripe.
   *  Targeted one-offs and pension lump-sums go on `depositInflow`
   *  instead.  */
  oneOffIncome: number;
  /** Lump-sum **portfolio addition** at this month — the spike value
   *  for targeted oneOff windfalls and pension lump-sum payouts. Drives
   *  the income-breakdown chart's new "Portfolio additions" stripe.
   *  Per-account routing lives on `IncomeYearOutput.deposits.byAccount`
   *  (the chart only needs the aggregate spike). */
  depositInflow: number;
  /** Sum of spendable + deposit at this month, $/yr. */
  total: number;
}

export interface IncomeMonthlyContext extends IncomeContext {
  /** 0-indexed retirement month (Jan = 0) for `retirementStart`-kind
   *  part-time anchors. Defaults 0 when callers only carry year. */
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

/** Resolve a `ScheduleStart` to a calendar (year, month0) using the
 *  stream owner's birthdate and the household retirement year. Returns
 *  null when an age-anchor's owner has no birthdate. Owner-implicit:
 *  `start.memberId` is ignored on income (the stream's `memberId` UUID
 *  declares the owner). */
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
      // Owner-relative: anchor to the stream owner's retirement date,
      // not the household-level retirement year.
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

/** Calendar (year, month0) the pension annuity starts paying. */
function pensionStartMonth(
  p: IncomeStreamPayload,
  ctx: IncomeContext,
): MonthIndexed | null {
  if (p.kind !== 'pension' || p.payoutType !== 'annuity' || !p.start) return null;
  return resolveIncomeStart(p.start, p.memberId, ctx);
}

/** Exclusive end-of-life boundary for the pensioner — J&S survivor
 *  kicks in at this month onward (while spouse is alive).
 *
 *  Death is modelled as Dec 31 of `deathYear`
 *  (`deathYear = birthYear + lifeExpectancyAge`); the pensioner is alive
 *  through all of `deathYear`, so the exclusive boundary is Jan 1 of
 *  `deathYear + 1` — the full benefit is paid through December of the
 *  death year and the J&S reduction kicks in the following January. This
 *  now matches the annual `pensionerDeathYear()` (`year > deathYear`). */
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

/** Calendar (year, month0) the partTime stream starts. Honors all
 *  three start kinds; `retirementStart` resolves to the OWNER's
 *  retirement date (owner-relative — same as the other income kinds). */
function partTimeStartMonth(
  p: IncomeStreamPayload,
  ctx: IncomeMonthlyContext,
): MonthIndexed | null {
  if (p.kind !== 'partTime' || !p.start) return null;
  return resolveIncomeStart(p.start, p.memberId, ctx);
}

/** Resolve the calendar year for `endOfRetirementYear` end anchors —
 *  owner-relative same as `retirementStart` on the start side. */
function ownerRetirementYear(ctx: IncomeContext, memberId: string): number {
  const member = ctx.members.get(memberId);
  return member?.retirementYear ?? ctx.retirementStartYear;
}

/** Exclusive end boundary for the partTime stream. Owner-relative
 *  `endOfRetirementYear` (asymmetric vs expense's household-level).  */
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
      // Death = Dec 31 of `deathYear`; the stream is active through all of
      // `deathYear`, so the exclusive end boundary is Jan 1 of
      // `deathYear + 1`. Matches the annual `partTimeEndYear()`.
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

/** Calendar (year, month0) of a one-off receipt. Both oneOff windfalls
 *  and pension lump sums share the unified `start: ScheduleStart`
 *  field — kind/payoutType drive whether this fn is called.
 *  Exported so non-engine callers (e.g. the Income overview page,
 *  which needs the event month to project the linked CBP's balance
 *  forward) can reuse the same resolution logic the engine uses. */
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

        // One-offs (windfall + pension lump-sum) — entered as today's
        // dollars, inflated to the event month before
        // landing on the y-axis. Classification by data model:
        // a `targetAccountId` ⇒ portfolio
        // deposit; absent ⇒ spendable income. Same one-off can't be
        // both — the buckets are disjoint at the engine layer.
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

/** Year a pension annuity starts paying. Returns null when the anchor
 *  can't be resolved (missing birthdate on an age-anchor, etc.). */
function pensionStartYear(p: IncomeStreamPayload, ctx: IncomeContext): number | null {
  if (p.kind !== 'pension' || p.payoutType !== 'annuity' || !p.start) return null;
  return resolveStartYear(p.start, p.memberId, ctx);
}

/** Year axis resolver for an income `ScheduleStart`. Drops sub-year
 *  precision; callers that need month resolution use the month-indexed
 *  resolver instead. `retirementStart` resolves to the OWNER's
 *  retirement year (owner-relative). */
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

/** Year-by-year pension annuity benefit, with COLA + J&S survivor
 *  reduction after the pensioner dies. */
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

  // Survivor: post-pensioner-death, surviving spouse receives J&S %.
  // `year > death` ⇒ full benefit through `deathYear` (the pensioner is
  // alive through Dec 31), J&S from `deathYear + 1`. Already end-of-year-
  // consistent; the monthly `pensionerDeathMonth()` now matches (returns
  // Jan 1 of `deathYear + 1`).
  const death = pensionerDeathYear(p, ctx);
  if (death !== null && year > death) {
    const jns = (p.jointAndSurvivorPct ?? 0) / 100;
    benefit = benefit * jns;
  }
  return benefit;
}

/** Convert a partTime stream's start anchor to a calendar year using
 *  the OWNER's birth year (the form stores memberId='primary' on the
 *  stream but the engine routes to the actual owner). */
function partTimeStartYear(p: IncomeStreamPayload, ctx: IncomeContext): number | null {
  if (p.kind !== 'partTime' || !p.start) return null;
  return resolveStartYear(p.start, p.memberId, ctx);
}

/** Calendar year (exclusive) the partTime stream ends. Owner-relative
 *  `endOfRetirementYear`. */
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
      // Exclusive end = `deathYear + 1` (alive through Dec 31 of
      // `deathYear`). Already end-of-year-consistent; the monthly
      // `partTimeEndMonth()` 'lifetime' case now matches.
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
  // One-off + pension lump-sum amounts are interpreted as today's
  // dollars and inflated forward to the receipt month.
  // For year-resolution receipts we read the factor at the resolved
  // spike month so
  // mid-year events line up with the monthly chart. Linked-CBP
  // lump-sums route through `resolveOneOffAmount` and read the CBP
  // balance from `ctx.linkedCbpBalanceLookup` instead of the user-
  // entered `lumpSumAmount` (UI hides the field for those streams).
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

/** A single targeted deposit event resolved to its calendar event
 *  month and inflated to event-month dollars. Lets the
 *  Balance Projection page route pre-primary-retirement deposits into
 *  the target account's accumulation phase and post-primary-
 *  retirement deposits into the drawdown engine. */
export interface TargetedDepositEvent {
  targetAccountId: string;
  /** The owning member of the income stream the event originated from
   *  (the stream's `memberId` UUID). Carried so post-retirement plain
   *  pension lump-sums can resolve their owner downstream (per-account
   *  placement). `undefined` only when the source stream carries no
   *  `memberId` (defensive — production streams always set it). */
  memberId?: string;
  year: number;
  month0: number;
  /** Event-month dollars (inflation roll-forward already applied). */
  amount: number;
  /** When the event originated from a `payoutType: 'lumpSum'` pension
   *  stream with `linkedCbpAccountId` set, this carries that CBP
   *  account id. The page uses it to subtract the CBP's at-primary
   *  balance from `portfolioAtRetirement` so the
   *  transferred dollars don't appear in both the CBP and the target
   *  account at primary's retirement date. `undefined` for untargeted
   *  one-offs and for unlinked lump-sums. */
  linkedCbpAccountId?: string;
}

/** Resolve the dollar amount that a one-off / pension-lump-sum stream
 *  contributes at its event month. Centralises the three lookup paths:
 *
 *  1. Linked-CBP lump-sum (`payoutType: 'lumpSum'` + `linkedCbpAccountId`)
 *     — reads from `ctx.linkedCbpBalanceLookup`. The user-entered
 *     `lumpSumAmount` is forced to 0 on save for these streams (UI
 *     hides the field). Lookup miss / `null` / non-positive returns 0
 *     and the caller drops the event.
 *  2. Untargeted spendable one-off — inflation-rolls `oneOffAmount`
 *     from today to the event month.
 *  3. Plain pension lump-sum (no linked CBP) — inflation-rolls
 *     `lumpSumAmount` the same way.
 *
 *  Shared by `projectIncomeByMonth`, `oneOffForYear` (the year-level
 *  driver), and `collectTargetedDepositEvents`. */
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
    // CBP balance from the projection engine is in event-month nominal
    // dollars by construction — no inflation factor applied.
    return cbpBalance === null || cbpBalance <= 0 ? 0 : cbpBalance;
  }
  const factor = inflationFactorAt(eventYear, eventMonth0);
  if (p.kind === 'oneOff') return (p.oneOffAmount ?? 0) * factor;
  if (p.kind === 'pension' && p.payoutType === 'lumpSum') {
    return (p.lumpSumAmount ?? 0) * factor;
  }
  return 0;
}

/** Walks resolved income for every one-off or pension-lump-sum whose
 *  `targetAccountId` is set, resolving each to (year, month0, amount).
 *  Spendable one-offs (no `targetAccountId`) are excluded — they feed
 *  net-need, not the portfolio.
 *
 *  Linked-CBP lump-sums read their amount from
 *  `ctx.linkedCbpBalanceLookup`; when omitted or returning `null` the
 *  event is silently dropped (matches a CBP whose event month falls
 *  outside the projection horizon, e.g. post-primary-retirement where
 *  the CBP balance is already pooled into the drawdown engine). */
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

/** A post-retirement **plain** (non-linked-CBP) pension lump-sum event,
 *  classified per-event so both engines can place it in its target account
 *  (per-account placement). Linked-CBP lump-sums are NOT emitted here —
 *  they route through the dedicated CBP seam (`collectPostRetirementCbp…`).
 *  One-off windfalls are NOT emitted here either — they stay on the
 *  household-pool `depositInflow` spread (they are not placed per account).
 *
 *  Re-sourced from the identity-preserving `collectTargetedDepositEvents`
 *  (which still holds `targetAccountId` + `memberId`), NOT the household-
 *  aggregated `MonthlyIncomeRow.depositInflow` (which has already summed away
 *  the target + owner). Multiple same-month events stay disaggregated. */
export interface PlainPensionPlacementEvent {
  /** Target account the lump-sum lands in (= `targetAccountId`). */
  readonly accountId: string;
  /** Owning member of the source pension stream (the stream's `memberId`).
   *  Empty string when the source stream carried no `memberId` (defensive). */
  readonly memberId: string;
  /** Event-month dollars (inflation roll-forward already applied). */
  readonly amount: number;
  /** Absolute step month `year * 12 + month0`. */
  readonly month0: number;
}

/**
 * Build the post-retirement **plain** pension lump-sum placement list from
 * the identity-preserving targeted-deposit producer. Only events at/after
 * `primaryRetirementAbsMonth` are returned (pre-retirement plain lump-sums
 * are already placed per-account in the accumulation phase). Linked-CBP
 * lump-sums (`linkedCbpAccountId` set) are excluded — they have their own
 * RMD-aware seam. The returned events carry `accountId` so both engines can
 * place the dollars in the target account, bucketed by treatment.
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
    // Plain (non-linked-CBP) pension lump-sums ONLY. One-off windfalls
    // (kind === 'oneOff') keep flowing through the household-pool
    // `depositInflow` spread (not placed per account); linked-CBP lump-sums route
    // through the dedicated RMD-aware CBP seam.
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
      // One-offs + pension lump-sums. Classification is by data model:
      // a `targetAccountId` ⇒ deposit; absent ⇒
      // spendable. The drawdown engine pools `deposits.byAccount` into
      // the targeted account's pre-drawdown balance — it must NOT also
      // see the same dollar as spendable income (would double-count).
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
        // Untargeted oneOff (windfall used to fund spending directly).
        // Pension lump-sums always carry a target; a
        // lumpSum without one is treated as untargeted oneOff income
        // — defensive coverage, never hit in practice.
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

/** Build an `IncomeContext` from raw HouseholdMember aggregates plus
 *  scenario-resolved life-expectancy + retirement-start year.
 *
 *  `retirementDateByMember` — optional per-member retirement dates so
 *  owner-relative `retirementStart` / `endOfRetirementYear` anchors
 *  resolve to the actual owner's retirement (couples retiring at
 *  different ages). When a member has no entry in the map, falls back
 *  to the context-level `retirementStartYear`. */
export function buildIncomeContext(
  members: Aggregate<HouseholdMemberPayload>[],
  scenarioInputs: {
    retirementStartYear: number;
    lifeExpectancyPrimary: number;
    lifeExpectancySecondary?: number;
    retirementDateByMember?: Map<string, { year: number; month0?: number }>;
    /** Optional today-anchor + inflation rate for the today's-dollar
     *  one-off / lump-sum roll-forward. Omit when the caller wants
     *  legacy literal-amount behaviour. */
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
