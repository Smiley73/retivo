/**
 * Roth conversion comparison — page data adapter.
 *
 * Pure(ish) builders the Roth conversion comparison page consumes: run the deterministic
 * projection once via `runBalanceProjectionForPage`, assemble the
 * `BETRScenarioContext` the math library needs from the scenario aggregate
 * (filing status, owner birth year, SS, members, SLCSP, inflation, horizon),
 * and surface the working-years summary, the per-year retirement rows, the
 * backdoor-Roth signal, and the account picker lists. No React, no I/O — every
 * input is passed in by the page from its reactive aggregate reads.
 */
import {
  isMagiCapDisabled,
  type AccountBalancePayload,
  type AccountPayload,
  type Aggregate,
  type ExpensePayload,
  type HouseholdMemberPayload,
  type IncomeStreamPayload,
  type MagiCapOverride,
  type ScenarioOverrides,
  type SocialSecurityBenefitPayload,
} from '../../db/types';
import {
  resolveScenario,
  type ScenarioAggregate,
} from '../../lib/scenario-resolution';
import { runBalanceProjectionForPage } from '../../lib/balance-projection-runner';
import { growRoughBenchmarkCents } from '../../lib/aca-ptc';
import { carriesTenPercentPenalty } from '../../lib/early-withdrawal-penalty';
import { retirementDate } from '../../lib/retirement-date-math';
import { deriveFilingStatus } from '../../lib/filing-status';
import {
  isConvertibleRothConversionSource,
  isWorkingYearsRothConversionTarget,
} from '../../lib/roth-conversion-eligibility';
import {
  defaultHouseholdSlcspByAge,
  householdMarketplaceCoverageMonths,
  overrideBenchmarkCentsForCoverageMonths,
  readStoredCoverageMonths,
  resolveMemberHealthCoverage,
  storedAcaBenchmarkOverrides,
} from '../../lib/tax-integration-helpers';
import type { TaxMemberInput } from '../../lib/tax-integration';
import {
  DEFAULT_TAX_CALIBRATION_BUNDLE,
  type TaxCalibrationBundle,
} from '../../lib/tax-integration-helpers';
import {
  computeWorkingYearsBETRSummary,
  computeRetirementYearsBETR,
  DEFAULT_IRA_GROWTH_RATE,
  type BETRScenarioContext,
  type WorkingYearsBETRSummary,
  type RetirementYearBETRRow,
} from '../../lib/betr-calculator';
import type { DrawdownYear } from '../../lib/drawdown-engine-types';

const CENTS_FACTOR = 100;

/** One account option for the source / target Roth pickers. */
export interface AccountOption {
  readonly id: string;
  readonly name: string;
  readonly type: AccountPayload['type'];
  /** Owner of the account — the Apply dialog pairs a Roth target only with a
   *  same-owner source (IRC §408A is per-individual; cross-owner pairs are
   *  invalid and silently pruned at save). */
  readonly ownerId: string;
}

/** Everything the Roth conversion comparison page renders for one selected scenario. */
export interface RothBETRPageData {
  readonly ctx: BETRScenarioContext;
  readonly drawdownYears: readonly DrawdownYear[];
  readonly workingSummary: WorkingYearsBETRSummary;
  readonly retirementRows: readonly RetirementYearBETRRow[];
  /** True when the household's aggregated CURRENT (latest stored) pre-tax IRA
   *  balance is already $0 — the backdoor-Roth pathway may be open.
   *  Reads latest stored balances, NOT projected drawdown rows. */
  readonly backdoorRothAvailable: boolean;
  /** Pre-tax accounts a conversion can draw from (Apply working-years source). */
  readonly sourceAccounts: readonly AccountOption[];
  /** Roth IRA accounts (Apply target). Empty → Apply is blocked / errored. */
  readonly rothIraAccounts: readonly AccountOption[];
  readonly currentCalendarYear: number;
  /** The month index (0-11) the projection was run at. */
  readonly todayMonthIndex: number;
  readonly retirementAge: number;
  /** The latest calendar year a penalty-carrying convertible-source owner crosses
   *  59½, plus that owner's first name — drives the from-IRA before/after-59½
   *  break-even split + footnote. `undefined` when no under-59½ owner
   *  of a penalty-carrying, non-exempt convertible source remains (today's exact
   *  behavior — nothing changes). One atomic object so `year`/`firstName` can't
   *  drift into an illegal partial state. */
  readonly iraConversionOwnerBoundary?: { year: number; firstName: string };
  readonly bundle: TaxCalibrationBundle;
  /** Resolved parent-chain MAGI cap (disable sentinel coerced to undefined) —
   *  fed to `buildNextMagiCap` so Apply preserves inheritance correctly. */
  readonly parentCap: MagiCapOverride | undefined;
}

/** Inputs the page hands the builder — its reactive aggregate reads. */
export interface RothBETRDataInput {
  readonly scenarios: readonly ScenarioAggregate[];
  readonly selectedScenarioId: string;
  readonly accounts: readonly Aggregate<AccountPayload>[];
  readonly balances: readonly Aggregate<AccountBalancePayload>[];
  readonly members: readonly Aggregate<HouseholdMemberPayload>[];
  readonly ssBenefits: readonly Aggregate<SocialSecurityBenefitPayload>[];
  readonly expenses: readonly Aggregate<ExpensePayload>[];
  readonly incomeStreams: readonly Aggregate<IncomeStreamPayload>[];
  readonly todayYear: number;
  readonly todayMonthIndex: number;
  /** Test seam — defaults to the production bundle. */
  readonly bundle?: TaxCalibrationBundle;
}

/** Whole-balance pre-tax IRA aggregate (latest year per account), cents.
 *  RETIREMENT_IRA with a PRE_TAX or MIXED treatment carries the pre-tax basis
 *  that IRC §408(d)(2) aggregates for the backdoor-Roth pro-rata test. */
function pretaxIraBalanceCents(
  accounts: readonly Aggregate<AccountPayload>[],
  balances: readonly Aggregate<AccountBalancePayload>[],
): number {
  const latestByAccount = new Map<string, AccountBalancePayload>();
  for (const b of balances) {
    const prev = latestByAccount.get(b.payload.accountId);
    if (prev === undefined || b.payload.year > prev.year) {
      latestByAccount.set(b.payload.accountId, b.payload);
    }
  }
  let cents = 0;
  for (const acc of accounts) {
    if (acc.payload.type !== 'RETIREMENT_IRA') continue;
    if (acc.payload.taxTreatment !== 'PRE_TAX' && acc.payload.taxTreatment !== 'MIXED') {
      continue;
    }
    const latest = latestByAccount.get(acc.id);
    if (latest === undefined) continue;
    const dollars =
      acc.payload.taxTreatment === 'MIXED'
        ? latest.endingBalance - (latest.endingBalancePostTax ?? 0)
        : latest.endingBalance;
    cents += Math.round(dollars * CENTS_FACTOR);
  }
  return cents;
}

/** Annual GROSS Social Security across the household, integer cents.
 *  PIA is a monthly figure, so ×12 (representative — claim age / COLA-from-62 /
 *  spousal / survivor / earnings-test detail is NOT threaded, a documented
 *  simplification).
 *  TODO: use per-year gross SS from the projection once `DrawdownYear` stamps a
 *  `grossSsCents` field (it currently exposes only `taxableSsCents`); a flat
 *  PIA×12 over-/under-states §86 provisional income + ACA add-back in claim-
 *  delayed or survivor years. */
function grossSsAnnualCents(
  ssBenefits: readonly Aggregate<SocialSecurityBenefitPayload>[],
): number {
  let cents = 0;
  for (const b of ssBenefits) {
    const pia = b.payload.pia ?? 0;
    cents += Math.round(pia * 12 * CENTS_FACTOR);
  }
  return cents;
}

/** Count of members age 65+ by the retirement year (representative deduction
 *  add-on count for the proxy; the calculator caps at 1/2 per filing). */
function age65PlusByYear(
  members: readonly Aggregate<HouseholdMemberPayload>[],
  year: number,
): number {
  let count = 0;
  for (const m of members) {
    const birthYear = Number((m.payload.birthdate ?? '').slice(0, 4));
    if (Number.isFinite(birthYear) && year - birthYear >= 65) count += 1;
  }
  return count;
}

function accountOption(acc: Aggregate<AccountPayload>): AccountOption {
  return {
    id: acc.id,
    name: acc.payload.name,
    type: acc.payload.type,
    ownerId: acc.payload.ownerId,
  };
}

/**
 * SLCSP benchmark for the retirement year, integer cents: a user per-year
 * override, else the household default — the SUM over covered members of
 * that member's own age-priced monthly premium × their Marketplace coverage
 * MONTHS.
 *
 * Coverage is resolved through the SAME `resolveMemberHealthCoverage` both
 * production engines use, so the probe prices the household position
 * the projection actually models: the birthday-month Medicare onset, the stored
 * per-member/per-year months, the ACA opt-out, and the §36B(c)(2)(B) overlap
 * clamp. That also supplies the missing-birthdate guard — a member with an
 * unparseable birthdate resolves to zero Marketplace months instead of reaching
 * the age curve and throwing `AcaPtcInvalidInputError` out of this unguarded
 * caller.
 *
 * A user override is a WHOLE-YEAR price, so it is prorated to
 * `coverageMonths` through the same helper the live integration layer uses.
 * `computeAcaPtc` prorates the expected contribution by that month count, so an
 * un-prorated benchmark would make the probe report a larger "lost credit" than
 * the projection could ever lose.
 */
function deriveBenchmarkSlcspCents(
  resolved: ScenarioOverrides,
  memberInputs: readonly TaxMemberInput[],
  retirementYear: number,
  coverageMonths: number,
  medicalInflationRatePct: number,
): number {
  // Read through the ONE shared shape-checking enumerator, so an
  // envelope-only-validated import cannot throw out of the probe at `.find` or
  // price the probe off a malformed row.
  const override = storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark).find(
    (o) => o.taxYear === retirementYear,
  );
  if (override !== undefined) {
    return overrideBenchmarkCentsForCoverageMonths(override.annualSlcspDollars, coverageMonths);
  }
  return growRoughBenchmarkCents(
    Math.round(defaultHouseholdSlcspByAge(memberInputs, retirementYear) * CENTS_FACTOR),
    retirementYear,
    medicalInflationRatePct,
  );
}

/** The retirement year's `TaxMemberInput` set for the BETR probe, built
 *  through the one shared health-coverage resolver. */
function betrMemberInputs(
  resolved: ScenarioOverrides,
  members: readonly Aggregate<HouseholdMemberPayload>[],
  retirementYear: number,
): TaxMemberInput[] {
  const optedOut = new Set(resolved.acaMarketplaceOptOutMemberIds ?? []);
  return members.map((m) => {
    const isoBirthdate = m.payload.birthdate ?? '1970-01-01';
    return {
      memberId: m.id,
      isoBirthdate,
      ...resolveMemberHealthCoverage({
        isoBirthdate,
        taxYear: retirementYear,
        retired: true,
        optedOut: optedOut.has(m.id),
        stored: readStoredCoverageMonths(resolved.healthCoverageMonths, m.id, retirementYear),
      }),
    };
  });
}


/** Partition the accounts into the Apply pickers' pair-valid option lists
 * : convertible sources (active, PRE_TAX/MIXED, NOT a cash-
 *  balance pension), and active Roth IRA targets whose owner matches at least
 *  one eligible source (IRC §408A is per-individual — cross-owner pairs invalid). */
function partitionPickerAccounts(accounts: readonly Aggregate<AccountPayload>[]): {
  sourceAccounts: AccountOption[];
  rothIraAccounts: AccountOption[];
} {
  const eligibleSources = accounts.filter((a) => isConvertibleRothConversionSource(a.payload));
  const sourceOwnerIds = new Set(eligibleSources.map((a) => a.payload.ownerId));
  return {
    sourceAccounts: eligibleSources.map(accountOption),
    rothIraAccounts: accounts
      .filter(
        (a) =>
          isWorkingYearsRothConversionTarget(a.payload) && sourceOwnerIds.has(a.payload.ownerId),
      )
      .map(accountOption),
  };
}

/**
 * Derive the from-IRA before/after-59½ break-even boundary.
 *
 * From the already-partitioned convertible `sourceAccounts` (each carries
 * `id`/`type`/`ownerId`, so there is no second `input.accounts` pass), keep only
 * sources whose type actually carries the §72(t) penalty AND are not on the
 * scenario's `earlyWithdrawalPenaltyExemptAccountIds` list (excludes
 * type-exempt 457(b) and user-flagged-exempt accounts). Join each kept source's
 * owner to its member, skip owners whose member is missing or whose birthdate is
 * empty/unparseable (silent defensive skip, never throws), and return the
 * LATEST 59½-crossing year among owners still penalty-exposed "now" (their 59½
 * year `>= currentCalendarYear`, the crossing year inclusive). `undefined`
 * when no such owner remains.
 */
function deriveIraConversionOwnerBoundary(
  sourceAccounts: readonly AccountOption[],
  members: readonly Aggregate<HouseholdMemberPayload>[],
  currentCalendarYear: number,
  exemptAccountIds: readonly string[],
): { year: number; firstName: string } | undefined {
  const exemptSet = new Set(exemptAccountIds);
  const memberById = new Map(members.map((m) => [m.id, m.payload]));
  let boundary: { year: number; firstName: string } | undefined;
  for (const opt of sourceAccounts) {
    if (!carriesTenPercentPenalty(opt.type) || exemptSet.has(opt.id)) continue;
    const member = memberById.get(opt.ownerId);
    if (member === undefined) continue;
    const birthdate = member.birthdate ?? '';
    if (birthdate === '') continue;
    let crossingYear: number;
    try {
      crossingYear = Number(retirementDate(birthdate, { ageYears: 59, ageMonths: 6 }).slice(0, 4));
    } catch {
      continue; // unparseable birthdate → skip this owner
    }
    if (!Number.isFinite(crossingYear)) continue;
    // Penalty-exposed "now" iff the 59½ year is this year or later. An owner
    // who reached 59½ in a prior year contributes no boundary.
    if (crossingYear < currentCalendarYear) continue;
    if (boundary === undefined || crossingYear > boundary.year) {
      boundary = { year: crossingYear, firstName: member.firstName };
    }
  }
  return boundary;
}

/** Year/horizon anchors the projection yields, threaded into the context build. */
interface BETRContextAnchors {
  readonly ownerBirthYear: number;
  readonly retirementYear: number;
  readonly lifeExpectancyAnchorYear: number;
  readonly currentCalendarYear: number;
  readonly inflationRatePct: number;
  readonly medicalInflationRatePct: number;
}

/**
 * Assemble the `BETRScenarioContext` from the resolved scenario + members + SS.
 *
 * The tax context (filing status, age-65 count, Medicare-beneficiary count,
 * household size, SLCSP) is resolved ONCE at the retirement year and reused for
 * every retirement row, rather than re-derived per tax year as the engine's
 * `balance-projection-runner-tax` does. Survivor years, Medicare-onset years, and
 * ACA-coverage-change years therefore price against the retirement-year context.
 * This is a deliberate simplification.
 */
function buildBETRContext(
  resolved: ScenarioOverrides,
  members: readonly Aggregate<HouseholdMemberPayload>[],
  ssBenefits: readonly Aggregate<SocialSecurityBenefitPayload>[],
  anchors: BETRContextAnchors,
): BETRScenarioContext {
  const { retirementYear } = anchors;
  const aliveMembers = members.filter((m) => (m.payload.birthdate ?? '') !== '');
  const filingStatus = deriveFilingStatus({
    primaryAlive: true,
    secondaryAlive: aliveMembers.length > 1,
    filingStatusOverride: resolved.filingStatus,
  });
  // Existing flat working-years conversion already configured (sum of the
  // resolved windows' annual amounts) — subtracted from the bracket headroom so
  // the page doesn't double-count room the user already filled.
  const existingAnnualConversionDollars = (resolved.preRetirementRothConversions ?? []).reduce(
    (sum, w) => sum + (w.annualAmountDollars ?? 0),
    0,
  );
  const medicareBeneficiaries = Math.min(
    2,
    members.filter((m) => age65PlusByYear([m], retirementYear) > 0).length,
  ) as 0 | 1 | 2;
  // Resolve the retirement year's health coverage ONCE: the household's
  // Marketplace month count and the benchmark it is priced over must describe
  // the same month range (§36B(b)(2)).
  const healthMemberInputs = betrMemberInputs(resolved, members, retirementYear);
  const acaCoverageMonths = householdMarketplaceCoverageMonths(healthMemberInputs);
  return {
    filingStatus,
    ownerBirthYear: anchors.ownerBirthYear,
    taxpayersAge65Plus: age65PlusByYear(members, retirementYear),
    lifeExpectancyAnchorYear: anchors.lifeExpectancyAnchorYear,
    currentCalendarYear: anchors.currentCalendarYear,
    retirementYear,
    preRetirementTaxableIncomeDollars: resolved.preRetirementTaxableIncomeDollars,
    existingAnnualConversionDollars,
    rIra: DEFAULT_IRA_GROWTH_RATE,
    grossSsAnnualCents: grossSsAnnualCents(ssBenefits),
    beneficiariesOnMedicareCount: medicareBeneficiaries,
    householdSize: members.length,
    benchmarkAnnualSlcspCents: deriveBenchmarkSlcspCents(
      resolved,
      healthMemberInputs,
      retirementYear,
      acaCoverageMonths,
      anchors.medicalInflationRatePct,
    ),
    // The probe prices the household's OWN poverty-guideline
    // schedule and its actual Marketplace coverage months, so its "lost premium
    // tax credit" matches what the projection would really lose.
    ...(resolved.acaFplRegion !== undefined ? { acaFplRegion: resolved.acaFplRegion } : {}),
    acaCoverageMonths,
    inflationRatePct: anchors.inflationRatePct,
    taxExemptInterestCents: 0,
  };
}

/**
 * Build the Roth conversion comparison page data for the selected scenario, or `null` when the
 * scenario cannot be projected (no primary / unresolved retirement / no
 * drawdown). The page renders its empty state from a `null` return.
 */
export function buildRothBETRPageData(input: RothBETRDataInput): RothBETRPageData | null {
  const { selectedScenarioId } = input;
  if (!input.scenarios.some((s) => s.id === selectedScenarioId)) return null;
  const scenarios = [...input.scenarios];
  const resolved: ScenarioOverrides = resolveScenario(selectedScenarioId, scenarios);
  const bundle = input.bundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE;

  const page = runBalanceProjectionForPage({
    scenarioId: selectedScenarioId,
    scenarios,
    accounts: [...input.accounts],
    balances: [...input.balances],
    members: [...input.members],
    ssBenefits: [...input.ssBenefits],
    expenses: [...input.expenses],
    incomeStreams: [...input.incomeStreams],
    todayYear: input.todayYear,
    todayMonthIndex: input.todayMonthIndex,
    method: 'planned',
    taxBundle: bundle,
  });
  const method = page.planned;
  if (method === null) return null;
  const drawdownYears = method.years;

  const primary = input.members.find((m) => m.payload.isPrimary) ?? null;
  if (primary === null) return null;
  const ownerBirthYear = Number((primary.payload.birthdate ?? '').slice(0, 4));
  if (!Number.isFinite(ownerBirthYear)) return null;

  const retirementYear = page.sharedCtx.retirementYear;
  const currentCalendarYear = input.todayYear;

  const ctx = buildBETRContext(resolved, input.members, input.ssBenefits, {
    ownerBirthYear,
    retirementYear,
    lifeExpectancyAnchorYear: page.sharedCtx.horizonYear,
    currentCalendarYear,
    inflationRatePct: page.sharedCtx.ctx.inflationPct,
    medicalInflationRatePct: page.sharedCtx.medicalInflationRatePct,
  });

  const workingSummary = computeWorkingYearsBETRSummary(ctx, drawdownYears, bundle);
  const retirementRows = computeRetirementYearsBETR(drawdownYears, ctx, bundle);

  const { sourceAccounts, rothIraAccounts } = partitionPickerAccounts(input.accounts);

  return {
    ctx,
    drawdownYears,
    workingSummary,
    retirementRows,
    backdoorRothAvailable: pretaxIraBalanceCents(input.accounts, input.balances) === 0,
    sourceAccounts,
    rothIraAccounts,
    currentCalendarYear,
    todayMonthIndex: input.todayMonthIndex,
    retirementAge: Math.max(0, retirementYear - ownerBirthYear),
    iraConversionOwnerBoundary: deriveIraConversionOwnerBoundary(
      sourceAccounts,
      input.members,
      currentCalendarYear,
      resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [],
    ),
    bundle,
    parentCap: isMagiCapDisabled(resolved.magiCap) ? undefined : resolved.magiCap,
  };
}
