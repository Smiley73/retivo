/**
 * Tax-assumptions sections for the standalone Tax assumptions modal.
 *
 * The modal separates the two concerns into tabs (modelled after the
 * withdrawal-strategy modal), so each control lives in its own section
 * component rendered inside its own tab panel:
 *   1. `HsaQualifiedSection` — a `RangeSlider` for `hsaQualifiedMedicalExpensePct`
 *      (0–100, step 5). Projections now spend your HSA on your modeled medical
 *      costs FIRST (tax-free), and only tap it as an emergency reserve once every
 *      other account is empty. This control governs ONLY those emergency draws:
 *      the share of an emergency HSA withdrawal you can still back with qualified
 *      medical receipts (tax-free). The rest is taxed as regular income plus the
 *      20% under-65 tax. The default is 100 (fully qualified).
 *   2. `PenaltyExemptionsSection` — a per-account `ToggleSwitch` for each
 *      penalty-eligible account, writing `earlyWithdrawalPenaltyExemptAccountIds`.
 *   3. `HealthCoverageSection` — the health editor: a per-MEMBER
 *      `ToggleSwitch` (on Marketplace / other coverage) writing
 *      `acaMarketplaceOptOutMemberIds`, the federal-poverty-level region
 *      (`acaFplRegion`), the per-member/per-year Medicare Part B / Part D and
 *      Marketplace MONTHS (`healthCoverageMonths`), and the per-year benchmark
 *      plan price (`acaPtcBenchmark`) shown beside the rough estimate it
 *      replaces. Used by the standalone Health coverage modal, not the
 *      tax-assumptions tabs.
 *   4. `FilingPlanSection` — the filing editor: joint vs separate returns
 *      while both spouses are alive, the lived-together fact and each spouse's
 *      filing status + tax-household size for separate returns, and the
 *      year-bounded survivor exceptions that override the post-death default.
 *      Writes `taxFilingPlan`.
 *
 * Copy is plain English per the project layman's-terms standard.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit, and three of the health-editor
 * components exceed the 60-line function cap. Why it cannot be split: every
 * section here is a presentational leaf of ONE modal family, each driven
 * entirely by props from `scenario-withdrawal-strategy-draft-hook` and each
 * writing exactly one `ScenarioOverrides` key. Splitting the health editor into
 * a sibling module would export five row/section components plus their prop
 * types across a new boundary purely to move lines, with no shared logic to
 * extract — the row components are JSX-tall (a `Select` per month field with its
 * own `Field` label + helper copy), not logic-dense. Behaviour is covered by
 * `aca-coverage-modal.test.tsx` +
 * `scenario-withdrawal-strategy-save-helpers.test.ts`. Trigger: a change adding
 * 5 or more lines here must either refactor the file back under the limit or
 * re-justify this exception in this note; a new section should extract the
 * health editor first.
 */
import React from 'react';
import { RadioGroup } from 'react-aria-components';
import { RangeSlider } from '../components/RangeSlider';
import { RadioOption } from '../components/RadioOption';
import { ScheduleAnchorPicker } from '../components/ScheduleAnchorPicker';
import { Select } from '../components/Select';
import { Field } from '../components/Field';
import { MoneyInput } from '../components/MoneyInput';
import { Alert } from '../components/Alert';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { Muted } from '../components/Muted';
import type { AccountPayload, Aggregate, HouseholdMemberPayload } from '../db/types';
import { memberDisplayName } from '../lib/income-format';
import {
  glideAnchorToMagiCapEnd,
  magiCapEndToGlideAnchor,
} from '../lib/schedule-anchor-bridge';
import {
  FILING_STATUS_LABELS,
  isOpenEndedStatusWindow,
  openEndedStatusWindow,
  standingFilingStatus,
} from '../lib/filing-status';
import type {
  FilingPlanTaxUnit,
  FilingStatusWindow,
  SeparateFilingPlan,
  TaxFilingPlan,
  TaxUnitFilingStatus,
} from '../lib/filing-status';
import { ROUGH_BENCHMARK_ASSUMPTIONS } from '../lib/aca-ptc';
import type { AcaFplRegion } from '../lib/aca-ptc';
import { btnSecondaryClass } from './scenarios-page-chrome';
import { isPenaltyEligibleAccount } from './scenario-withdrawal-strategy-shared';
import type {
  DraftBenchmarkRow,
  DraftHealthCoverageRow,
} from './scenario-withdrawal-strategy-shared';

export interface HsaQualifiedSectionProps {
  hsaQualifiedPct: number;
  onChangeHsaPct: (v: number) => void;
}

export const HsaQualifiedSection: React.FC<HsaQualifiedSectionProps> = ({
  hsaQualifiedPct,
  onChangeHsaPct,
}) => (
  <div className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">Emergency HSA spending on medical care</h3>
    <RangeSlider
      id="hsa-qualified-pct"
      ariaLabel="Percent of emergency HSA withdrawals still backed by qualified medical care"
      value={hsaQualifiedPct}
      onChange={onChangeHsaPct}
      min={0}
      max={100}
      step={5}
      formatValue={(v) => `${v}%`}
      formatAriaValue={(v) => `${v} percent`}
    />
    <Muted className="text-sm">
      Projections spend your HSA on your modeled medical costs first (always
      tax-free), and only dip into it as an emergency reserve once every other
      account runs dry. This setting applies only to those emergency draws: your
      best estimate of how much of an emergency HSA withdrawal you can still cover
      with qualifying medical receipts (tax-free). Anything left over is taxed as
      regular income, plus an extra 20% tax if you are under 65. Leave at 100% if
      you expect to back it all with medical bills.
    </Muted>
  </div>
);

export interface PenaltyExemptionsSectionProps {
  penaltyExemptIds: string[];
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  onTogglePenaltyExempt: (accountId: string, exempt: boolean) => void;
}

export const PenaltyExemptionsSection: React.FC<PenaltyExemptionsSectionProps> = ({
  penaltyExemptIds,
  accounts,
  onTogglePenaltyExempt,
}) => {
  // Only penalty-eligible accounts can be marked exempt — those whose
  // withdrawals can trigger the 10% early-withdrawal penalty before age 59½.
  // This now includes Roth IRAs: a Roth IRA's contributions always come out
  // penalty-free, but once you reach its earnings (above what you put in) before
  // 59½, that earnings portion carries the 10% penalty. 457(b) / brokerage /
  // savings / HSA carry no 59½ penalty (or a different rule), so a toggle there
  // would mean nothing.
  const penaltyAccounts = accounts.filter(
    (a) => a.payload.active && isPenaltyEligibleAccount(a),
  );
  const exemptSet = new Set(penaltyExemptIds);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Early-withdrawal penalty exemptions</h3>
      <Muted className="text-sm">
        Taking money out of a retirement account before age 59½ normally adds a
        10% penalty tax. For a Roth IRA this applies only once you dip into its
        earnings — your own contributions always come out penalty-free, and the
        regular income tax on those earnings still applies even when you switch
        the account on here. Some situations are exempt (for example, certain
        disability or 72(t) payment plans). The app does not check those
        eligibility rules for you — switch an account on if you know it
        qualifies, and its withdrawals will skip the penalty.
      </Muted>
      {penaltyAccounts.length === 0 ? (
        <Muted as="p" className="m-0 text-sm">
          No accounts subject to the early-withdrawal penalty.
        </Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {penaltyAccounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-sm">
                {a.payload.name}
              </span>
              <ToggleSwitch
                ariaLabel={`Exempt ${a.payload.name} from the early-withdrawal penalty`}
                checked={exemptSet.has(a.id)}
                onChange={(next) => onTogglePenaltyExempt(a.id, next)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export interface HealthCoverageSectionProps {
  /** Member ids the user has marked as NOT on the ACA Marketplace. */
  acaOptOutMemberIds: string[];
  /** Every household member (the opt-out is a blanket per-member flag). */
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Flip one member to "on Marketplace" (false) / "other coverage" (true). */
  onToggleAcaOptOut: (memberId: string, optOut: boolean) => void;
  /** Which federal poverty guidelines price the subsidy. */
  fplRegion: AcaFplRegion;
  onChangeFplRegion: (next: AcaFplRegion) => void;
  /** Per-member, per-year coverage months. */
  coverageRows: readonly DraftHealthCoverageRow[];
  onChangeCoverageRows: (next: readonly DraftHealthCoverageRow[]) => void;
  /** Per-year benchmark-premium overrides. */
  benchmarkRows: readonly DraftBenchmarkRow[];
  onChangeBenchmarkRows: (next: readonly DraftBenchmarkRow[]) => void;
}

/** The three HHS poverty-guideline schedules, in plain English. */
const FPL_REGION_OPTIONS: ReadonlyArray<{ value: AcaFplRegion; label: string }> = [
  { value: 'contiguous', label: 'One of the 48 mainland states or Washington, DC' },
  { value: 'alaska', label: 'Alaska' },
  { value: 'hawaii', label: 'Hawaii' },
];

/** How many years ahead the year pickers offer. Long enough to cover a full
 *  retirement horizon without turning the list into a scroll marathon. */
const COVERAGE_YEAR_HORIZON = 45;

/** "Automatic" (leave it to the projection's own timing) vs a stated count. */
const AUTOMATIC_MONTHS = '';

/** Year options: this year through the horizon, plus any year already stored so
 *  an older saved row still shows its own value. */
function coverageYearOptions(
  extraYears: readonly number[],
): ReadonlyArray<{ value: string; label: string }> {
  const first = new Date().getFullYear();
  const years = new Set<number>(extraYears);
  for (let y = first; y <= first + COVERAGE_YEAR_HORIZON; y += 1) years.add(y);
  return [...years]
    .sort((a, b) => a - b)
    .map((y) => ({ value: String(y), label: String(y) }));
}

/** 0–12 plus the "Automatic" default. */
const MONTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: AUTOMATIC_MONTHS, label: 'Automatic' },
  ...Array.from({ length: 13 }, (_, i) => ({
    value: String(i),
    label: i === 1 ? '1 month' : `${i} months`,
  })),
];

/** One removable coverage-months row: whose year it is, and the three
 *  independent month counts. */
const CoverageMonthsRow: React.FC<{
  rowId: string;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  yearOptions: ReadonlyArray<{ value: string; label: string }>;
  row: DraftHealthCoverageRow;
  onPatch: (patch: Partial<DraftHealthCoverageRow>) => void;
  onRemove: () => void;
}> = ({ rowId, members, yearOptions, row, onPatch, onRemove }) => {
  const monthField = (
    key: 'partBMonths' | 'partDMonths' | 'marketplaceMonths',
    label: string,
  ): React.ReactNode => (
    <Field htmlFor={`${rowId}-${key}`} label={label} className="mb-0 flex-1">
      <Select
        id={`${rowId}-${key}`}
        value={row[key] === null ? AUTOMATIC_MONTHS : String(row[key])}
        onChange={(v) => onPatch({ [key]: v === AUTOMATIC_MONTHS ? null : Number(v) })}
        options={[...MONTH_OPTIONS]}
      />
    </Field>
  );
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap gap-3">
        <Field htmlFor={`${rowId}-member`} label="Who" className="mb-0 flex-1">
          <Select
            id={`${rowId}-member`}
            value={row.memberId}
            onChange={(v) => onPatch({ memberId: v })}
            options={members.map((m) => ({ value: m.id, label: memberDisplayName(m) }))}
          />
        </Field>
        <Field htmlFor={`${rowId}-year`} label="Year" className="mb-0 flex-1">
          <Select
            id={`${rowId}-year`}
            value={String(row.taxYear)}
            onChange={(v) => onPatch({ taxYear: Number(v) })}
            options={[...yearOptions]}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        {monthField('partBMonths', 'Months on Medicare Part B')}
        {monthField('partDMonths', 'Months on Medicare Part D')}
        {monthField('marketplaceMonths', 'Months on a Marketplace plan')}
      </div>
      <div className="flex justify-start">
        <button type="button" className={btnSecondaryClass} onClick={onRemove}>
          Remove this year
        </button>
      </div>
    </li>
  );
};

/** The per-member / per-year coverage-months table. */
const CoverageMonthsEditor: React.FC<{
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  rows: readonly DraftHealthCoverageRow[];
  onChangeRows: (next: readonly DraftHealthCoverageRow[]) => void;
}> = ({ members, rows, onChangeRows }) => {
  const rowIds = useStableRowIds(rows.length, 'health-coverage');
  const yearOptions = coverageYearOptions(rows.map((r) => r.taxYear));
  const firstMemberId = members[0]?.id;
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-ink">Months of coverage by year</span>
      <Muted className="text-sm">
        By default the projection assumes Medicare Part B and Part D both start in
        the first month you are eligible, and that anyone retired before 65 is on
        a Marketplace plan for the whole year. Add a year here to say what
        actually happens — for example the year you turn 65 and switch from a
        Marketplace plan to Medicare partway through, or a year you take Part B
        but not Part D. Anything you leave on &ldquo;Automatic&rdquo; keeps the
        default timing. Months you enter change the Medicare surcharge and the
        Marketplace subsidy for that year.
      </Muted>
      {rows.length === 0 ? (
        <Muted as="p" className="m-0 text-sm">
          No years entered — the projection uses its own timing throughout.
        </Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row, i) => (
            <CoverageMonthsRow
              key={rowIds.ids[i]}
              rowId={rowIds.ids[i]}
              members={members}
              yearOptions={yearOptions}
              row={row}
              onPatch={(patch) =>
                onChangeRows(rows.map((entry, j) => (j === i ? { ...entry, ...patch } : entry)))
              }
              onRemove={() => {
                rowIds.onRemove(i);
                onChangeRows(rows.filter((_, j) => j !== i));
              }}
            />
          ))}
        </ul>
      )}
      {firstMemberId !== undefined && (
        <div className="flex justify-start">
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={() => {
              rowIds.onAdd();
              onChangeRows([
                ...rows,
                {
                  memberId: firstMemberId,
                  taxYear: new Date().getFullYear(),
                  partBMonths: null,
                  partDMonths: null,
                  marketplaceMonths: null,
                },
              ]);
            }}
          >
            Add a coverage year
          </button>
        </div>
      )}
    </div>
  );
};

/** The per-year benchmark-premium override table + the rough-estimate
 *  disclosure the estimate is otherwise built from. */
const BenchmarkOverrideEditor: React.FC<{
  rows: readonly DraftBenchmarkRow[];
  onChangeRows: (next: readonly DraftBenchmarkRow[]) => void;
}> = ({ rows, onChangeRows }) => {
  const rowIds = useStableRowIds(rows.length, 'health-benchmark');
  const yearOptions = coverageYearOptions(rows.map((r) => r.taxYear));
  const { baseMonthlyDollars, baseAge, ageGrowthRate } = ROUGH_BENCHMARK_ASSUMPTIONS;
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-ink">Benchmark plan price</span>
      <Muted className="text-sm">
        The subsidy is worked out from a &ldquo;benchmark&rdquo; plan price. This
        app does not look up real plans, so unless you enter a price it estimates
        one: ${baseMonthlyDollars} a month for a {baseAge}-year-old, rising{' '}
        {Math.round(ageGrowthRate * 100)}% for each year of age, counted
        separately for each covered person and only for the months they are
        covered. That is a rough estimate, not a real quote. If you have a real
        benchmark price from your exchange, enter the full-year cost below for
        that year and it replaces the estimate. In a year you are only covered
        for part of the year, the matching share of it is used.
      </Muted>
      {rows.length === 0 ? (
        <Muted as="p" className="m-0 text-sm">
          No prices entered — the rough estimate above is used every year.
        </Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row, i) => (
            <li
              key={rowIds.ids[i]}
              className="flex flex-col gap-2 rounded-md border border-line p-3"
            >
              <div className="flex flex-wrap items-start gap-3">
                <Field
                  htmlFor={`${rowIds.ids[i]}-year`}
                  label="Year"
                  className="mb-0 flex-1"
                >
                  <Select
                    id={`${rowIds.ids[i]}-year`}
                    value={String(row.taxYear)}
                    onChange={(v) =>
                      onChangeRows(
                        rows.map((entry, j) =>
                          j === i ? { ...entry, taxYear: Number(v) } : entry,
                        ),
                      )
                    }
                    options={[...yearOptions]}
                  />
                </Field>
                <MoneyInput
                  id={`${rowIds.ids[i]}-amount`}
                  label="Benchmark plan cost for the year"
                  value={row.annualSlcspDollars}
                  decimals={0}
                  onChange={(v) =>
                    onChangeRows(
                      rows.map((entry, j) =>
                        j === i ? { ...entry, annualSlcspDollars: v } : entry,
                      ),
                    )
                  }
                />
              </div>
              <div className="flex justify-start">
                <button
                  type="button"
                  className={btnSecondaryClass}
                  onClick={() => {
                    rowIds.onRemove(i);
                    onChangeRows(rows.filter((_, j) => j !== i));
                  }}
                >
                  Remove this price
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-start">
        <button
          type="button"
          className={btnSecondaryClass}
          onClick={() => {
            rowIds.onAdd();
            onChangeRows([
              ...rows,
              { taxYear: new Date().getFullYear(), annualSlcspDollars: 0 },
            ]);
          }}
        >
          Add a benchmark price
        </button>
      </div>
    </div>
  );
};

/**
 * Health coverage editor. Four concerns in one section:
 *  1. Per-member Marketplace opt-out. ON = buying a Marketplace plan in early
 *     retirement (the default — a premium subsidy is estimated for their pre-65
 *     years); OFF = "other coverage" (retiree / COBRA / spousal plan), so no
 *     subsidy is credited. Lists ALL members: opting out a member who
 *     never retires before 65 is a harmless no-op.
 *  2. The federal poverty guidelines used to size the subsidy (Alaska and
 *     Hawaii have their own, higher, schedules).
 *  3. Per-member, per-year Medicare Part B / Part D and Marketplace MONTHS.
 *  4. The per-year benchmark-plan price override, shown beside the rough
 *     estimate it replaces (the approximation is never presented as a
 *     real exchange quote).
 * Copy is plain English per the project layman's-terms standard.
 */
export const HealthCoverageSection: React.FC<HealthCoverageSectionProps> = ({
  acaOptOutMemberIds,
  members,
  onToggleAcaOptOut,
  fplRegion,
  onChangeFplRegion,
  coverageRows,
  onChangeCoverageRows,
  benchmarkRows,
  onChangeBenchmarkRows,
}) => {
  const optOutSet = new Set(acaOptOutMemberIds);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Who is on a Marketplace plan</h3>
        <Muted className="text-sm">
          Before Medicare starts at 65, the projection assumes a retired member buys
          a health plan on the ACA Marketplace and estimates the premium subsidy they
          would get. Switch a member to &ldquo;other coverage&rdquo; if they will not
          be on a Marketplace plan in early retirement — for example they have
          retiree coverage, COBRA, or are on a spouse&rsquo;s employer plan. No
          subsidy is then estimated for them.
        </Muted>
        <Muted className="text-sm">
          The subsidy is sized from a benchmark plan and credited separately from
          what you pay, so enter the FULL (unsubsidized) premium as your Medical
          expense — the projection applies the estimated subsidy on top. Each
          covered person is priced at their own age, for the months they are
          covered.
        </Muted>
        {members.length === 0 ? (
          <Muted as="p" className="m-0 text-sm">
            No household members.
          </Muted>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {members.map((m) => {
              const name = memberDisplayName(m);
              return (
                <li key={m.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                  <ToggleSwitch
                    ariaLabel={`${name} is on the ACA Marketplace`}
                    checked={!optOutSet.has(m.id)}
                    onChange={(onMarketplace) => onToggleAcaOptOut(m.id, !onMarketplace)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Field
        htmlFor="health-fpl-region"
        label="Where you live"
        hint="Alaska and Hawaii use higher federal poverty guidelines, which usually means a larger subsidy on the same income."
      >
        <Select
          id="health-fpl-region"
          value={fplRegion}
          onChange={(v) => onChangeFplRegion(v as AcaFplRegion)}
          options={FPL_REGION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </Field>

      <CoverageMonthsEditor
        members={members}
        rows={coverageRows}
        onChangeRows={onChangeCoverageRows}
      />

      <BenchmarkOverrideEditor rows={benchmarkRows} onChangeRows={onChangeBenchmarkRows} />
    </div>
  );
};

// ——— Filing plan ————————————————————————————————————

/** Statuses a spouse may pick for their OWN return while both are alive. A
 *  married person filing apart is either MFS or — when they maintain a home
 *  for a dependent and lived apart the last half of the year — Head of
 *  household. `Single`, `MFJ`, and `QSS` are not reachable here. */
const SEPARATE_UNIT_STATUSES: readonly TaxUnitFilingStatus[] = ['MFS', 'HoH'];

/** Statuses a one-person household can file every year: the `Single` default,
 *  or `HoH` when they maintain a home for a dependent (without this
 *  control an individual plan could not express a standing head-of-household
 *  filer at all, so converting the legacy `HoH` setting silently downgraded
 *  them to Single). */
const INDIVIDUAL_STANDING_STATUSES: readonly TaxUnitFilingStatus[] = ['Single', 'HoH'];

/** Statuses a year-bounded exception window may set. Both override the
 *  post-death `Single` default; neither is available while both spouses are
 *  alive. */
const WINDOW_STATUSES: readonly TaxUnitFilingStatus[] = ['QSS', 'HoH'];

/** §2(a) — qualifying surviving spouse is available for at most the TWO tax
 *  years FOLLOWING the year of death. A longer window is surfaced as a warning
 *  rather than blocked: the projection's death year is a model assumption the
 *  user may be planning around. */
const MAX_QSS_WINDOW_YEARS = 2;

/** Tax-household sizes offered for one spouse's separate return. */
const HOUSEHOLD_SIZE_OPTIONS = [1, 2, 3, 4, 5, 6] as const;

const DEFAULT_SEPARATE_UNITS: readonly [FilingPlanTaxUnit, FilingPlanTaxUnit] = [
  { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
  { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
];

/**
 * Neutral local names for the shared static-anchor bridge. The exported
 * helpers are named for their FIRST consumer (a MAGI cap window's END anchor),
 * but the conversion is generic over the `age | year` static anchor subset,
 * which is exactly what a filing window's START and END both use. Aliased here
 * rather than renamed repo-wide.
 */
const toAnchorPickerValue = magiCapEndToGlideAnchor;
const fromAnchorPickerValue = glideAnchorToMagiCapEnd;

/** A fresh exception window: the two calendar years starting next year. The
 *  user re-anchors both ends; this only avoids an "enabled but empty" row. */
function defaultFilingStatusWindow(): FilingStatusWindow {
  const nextYear = new Date().getFullYear() + 1;
  return {
    status: 'QSS',
    start: { kind: 'year', year: nextYear },
    end: { kind: 'year', year: nextYear + MAX_QSS_WINDOW_YEARS },
  };
}

/** The plan's YEAR-BOUNDED exception windows — the standing open-ended window
 *  (an individual plan's `HoH`) is edited by its own control, not listed here. */
function exceptionWindowsOf(plan: TaxFilingPlan): readonly FilingStatusWindow[] {
  return (plan.statusWindows ?? []).filter((w) => !isOpenEndedStatusWindow(w));
}

/** The plan's standing (open-ended) filing status, or `Single` when none. Reads
 *  it through the SHARED resolver helper, so the editor's controls and copy name
 *  the same standing status the engines and the report sentence do. */
function standingStatusOf(plan: TaxFilingPlan): TaxUnitFilingStatus {
  return standingFilingStatus(plan.statusWindows);
}

/** Mid-sentence label for a filing status ("files as head of household"). */
function statusLabelLower(status: TaxUnitFilingStatus): string {
  return FILING_STATUS_LABELS[status].toLowerCase();
}

/** Write `statusWindows` sparse-optionally: an empty list is stored as an
 *  ABSENT key, never `[]`. */
function planWithWindows(
  plan: TaxFilingPlan,
  windows: readonly FilingStatusWindow[],
): TaxFilingPlan {
  if (windows.length === 0) {
    const withoutWindows = { ...plan };
    delete withoutWindows.statusWindows;
    return withoutWindows;
  }
  return { ...plan, statusWindows: windows };
}

/** The statutory problems with a window, in plain English. Empty when
 *  the window is fine. */
function windowWarnings(w: FilingStatusWindow): string[] {
  const problems: string[] = [];
  if (w.status !== 'QSS') return problems;
  if (w.start.kind === 'year' && w.end.kind === 'year') {
    const span = w.end.year - w.start.year;
    if (span > MAX_QSS_WINDOW_YEARS) {
      problems.push(
        `Qualifying surviving spouse lasts at most ${MAX_QSS_WINDOW_YEARS} tax years after the year your spouse dies. This window covers ${span} years, so the later years may be filed at a lower-tax status than the law allows.`,
      );
    }
  }
  return problems;
}

/** The standing filing status for a ONE-PERSON household. */
const IndividualStatusPicker: React.FC<{
  plan: TaxFilingPlan;
  onChangePlan: (next: TaxFilingPlan) => void;
}> = ({ plan, onChangePlan }) => {
  const standing = standingStatusOf(plan);
  return (
    <div className="flex flex-col gap-2">
      <Muted as="p" className="m-0 text-sm">
        You are the only person in this plan, so every year is filed on your own
        return.
      </Muted>
      <Field
        htmlFor="filing-individual-status"
        label="Files as"
        hint="Choose head of household only if you pay more than half the cost of a home for a dependent."
      >
        <Select
          id="filing-individual-status"
          value={standing}
          onChange={(v) => {
            const next = v as TaxUnitFilingStatus;
            const windows = exceptionWindowsOf(plan);
            // The standing window is stored LAST, behind the year-bounded
            // exceptions it is the fallback for, so the stored array reads in the
            // same priority order the resolver applies.
            onChangePlan(
              planWithWindows(
                plan,
                next === 'Single' ? windows : [...windows, openEndedStatusWindow(next)],
              ),
            );
          }}
          options={INDIVIDUAL_STANDING_STATUSES.map((s) => ({
            value: s,
            label: FILING_STATUS_LABELS[s],
          }))}
        />
      </Field>
    </div>
  );
};

/** Joint vs separate returns while both spouses are alive. A plan whose kind is
 *  neither (a one-person plan that outlived its household) leaves BOTH
 *  options unselected, so the couple makes an explicit choice rather than
 *  inheriting a silent default. */
const FilingPlanKindPicker: React.FC<{
  plan: TaxFilingPlan;
  onChangePlan: (next: TaxFilingPlan) => void;
}> = ({ plan, onChangePlan }) => {
  // Carry ONLY the year-bounded exception windows across. A couple's plan
  // has no standing (open-ended) status of its own: the one-person **Files as**
  // control is the only thing that writes one, so an open-ended entry here can
  // only be a leftover from a spell when the spouse was removed. Copying it into
  // the new plan would keep the survivor filing that old standing status forever
  // after a later death, with no control on this screen able to show or clear it.
  const windows = exceptionWindowsOf(plan);
  return (
    <div className="min-w-0">
      <span id="filing-plan-kind-label" className="mb-1 block text-sm font-medium text-ink">
        While you are both alive
      </span>
      <RadioGroup
        aria-labelledby="filing-plan-kind-label"
        value={plan.kind}
        onChange={(v) =>
          onChangePlan(
            v === 'separate'
              ? {
                  kind: 'separate',
                  units: DEFAULT_SEPARATE_UNITS,
                  ...(windows.length ? { statusWindows: windows } : {}),
                }
              : { kind: 'joint', ...(windows.length ? { statusWindows: windows } : {}) },
          )
        }
        className="flex min-h-10 flex-col gap-2"
      >
        <RadioOption value="joint">
          File together on one return (married filing jointly)
        </RadioOption>
        <RadioOption value="separate">
          File apart on two returns (married filing separately)
        </RadioOption>
      </RadioGroup>
    </div>
  );
};

/** One spouse's separate return: status + tax-household size. */
const SeparateUnitEditor: React.FC<{
  unit: FilingPlanTaxUnit;
  label: string;
  onChangeUnit: (patch: Partial<FilingPlanTaxUnit>) => void;
}> = ({ unit, label, onChangeUnit }) => (
  <div className="flex flex-col gap-2 rounded-md border border-line p-3">
    <span className="text-sm font-medium text-ink">{label}&rsquo;s return</span>
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      <Field htmlFor={`filing-unit-status-${unit.memberId}`} label="Files as">
        <Select
          id={`filing-unit-status-${unit.memberId}`}
          value={unit.filingStatus}
          onChange={(v) => onChangeUnit({ filingStatus: v as TaxUnitFilingStatus })}
          options={SEPARATE_UNIT_STATUSES.map((s) => ({
            value: s,
            label: FILING_STATUS_LABELS[s],
          }))}
        />
      </Field>
      <Field
        htmlFor={`filing-unit-size-${unit.memberId}`}
        label="People counted on this return"
        hint="Include this spouse plus any dependents they claim, like an adult child or a parent they support — this app does not track dependents anywhere else."
      >
        <Select
          id={`filing-unit-size-${unit.memberId}`}
          value={String(unit.householdSize)}
          onChange={(v) => onChangeUnit({ householdSize: Number(v) })}
          options={HOUSEHOLD_SIZE_OPTIONS.map((n) => ({
            value: String(n),
            label: String(n),
          }))}
        />
      </Field>
    </div>
  </div>
);

/** Drop the sparse-optional `livedTogether` key entirely: absent means
 *  "lived apart", so an explicit `false` would only leave a dead key on every
 *  synced device. */
function withoutLivedTogether(plan: SeparateFilingPlan): SeparateFilingPlan {
  const { livedTogether: _dropped, ...rest } = plan;
  void _dropped;
  return rest;
}

/** The separate-returns editor: the lived-together fact plus each spouse's own
 *  return. Indexes `units[0]`/`units[1]` directly, so the caller must hand it a
 *  plan that passed `isWellFormedFilingPlan` — the tax-assumptions modal
 *  validates the stored payload before the draft ever reaches these controls, which is what keeps
 *  a corrupt `separate` payload from throwing during
 *  render on the very tab that exists to repair it. */
const SeparateReturnsEditor: React.FC<{
  plan: SeparateFilingPlan;
  nameFor: (role: 'primary' | 'secondary') => string;
  onChangePlan: (next: TaxFilingPlan) => void;
}> = ({ plan, nameFor, onChangePlan }) => {
  // §2(c)/§7703(b): head of household requires being "considered unmarried" —
  // the spouse must NOT have been a member of the household for the last six
  // months of the year. So HoH and "lived together at some point" are mutually
  // exclusive; selecting HoH clears the lived-together fact, and the
  // toggle is unavailable while an HoH return is selected.
  const anyHoH = plan.units.some((u) => u.filingStatus === 'HoH');
  const setLivedTogether = (next: boolean): void => {
    if (!next) {
      onChangePlan(withoutLivedTogether(plan));
      return;
    }
    onChangePlan({ ...plan, livedTogether: true });
  };
  const updateUnit = (index: 0 | 1, patch: Partial<FilingPlanTaxUnit>): void => {
    const next: [FilingPlanTaxUnit, FilingPlanTaxUnit] = [plan.units[0], plan.units[1]];
    next[index] = { ...next[index], ...patch };
    const nextPlan: SeparateFilingPlan = { ...plan, units: next };
    // HoH requires being "considered unmarried" (§2(c)/§7703(b)), so
    // selecting it auto-clears an already-set lived-together fact instead of
    // saving a statutorily contradictory plan.
    onChangePlan(
      next.some((u) => u.filingStatus === 'HoH') ? withoutLivedTogether(nextPlan) : nextPlan,
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <Muted className="text-sm">
        Filing apart usually costs more tax than filing together: the income
        bands are half as wide, and the extra deduction for people 65 and older
        is smaller. A spouse who files as married filing separately also cannot
        claim a Marketplace health-plan subsidy (a spouse who qualifies as head
        of household still can). Choose it only if you know you will file that
        way.
      </Muted>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 text-sm">
          You lived together at some point during the year
        </span>
        <ToggleSwitch
          ariaLabel="You lived together at some point during the year"
          checked={plan.livedTogether === true}
          disabled={anyHoH}
          onChange={setLivedTogether}
        />
      </div>
      <Muted className="text-sm">
        {anyHoH
          ? 'Head of household requires living apart from your spouse for the last six months of the year, so this is off while either return is head of household.'
          : 'If you lived together at any time in the year, a spouse filing separately is taxed on their Social Security from the first dollar (up to the usual 85% cap) and Medicare uses the higher surcharge table. Leave this off only if you lived apart for the whole year.'}
      </Muted>
      {([0, 1] as const).map((index) => (
        <SeparateUnitEditor
          key={plan.units[index].memberId}
          unit={plan.units[index]}
          label={nameFor(plan.units[index].memberId)}
          onChangeUnit={(patch) => updateUnit(index, patch)}
        />
      ))}
    </div>
  );
};

/** Stable per-row keys for the removable exception rows: array indexes
 *  re-key every survivor when an earlier row is deleted, so the Select /
 *  anchor-picker state of row N+1 can follow row N. */
function useStableRowIds(
  count: number,
  prefix = 'filing-window',
): {
  ids: readonly string[];
  onAdd: () => void;
  onRemove: (index: number) => void;
} {
  const nextId = React.useRef(0);
  const mint = (): string => `${prefix}-${nextId.current++}`;
  const [ids, setIds] = React.useState<string[]>(() =>
    Array.from({ length: count }, mint),
  );
  // Re-sync when the row count changed OUTSIDE this component (e.g. switching
  // plan kind carries the windows across). Appends / truncates at the end only;
  // the add / remove handlers below keep identity exact for user edits.
  if (ids.length !== count) {
    const next = ids.slice(0, count);
    while (next.length < count) next.push(mint());
    setIds(next);
  }
  return {
    ids,
    onAdd: () => setIds((prev) => [...prev, mint()]),
    onRemove: (index) => setIds((prev) => prev.filter((_, j) => j !== index)),
  };
}

/** One removable exception-window row. */
const FilingExceptionWindowRow: React.FC<{
  rowId: string;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  window: FilingStatusWindow;
  onPatch: (patch: Partial<FilingStatusWindow>) => void;
  onRemove: () => void;
}> = ({ rowId, members, window: w, onPatch, onRemove }) => (
  <li className="flex flex-col gap-2 rounded-md border border-line p-3">
    <Field htmlFor={`filing-window-status-${rowId}`} label="Files as">
      <Select
        id={`filing-window-status-${rowId}`}
        value={w.status}
        onChange={(v) => onPatch({ status: v as TaxUnitFilingStatus })}
        options={WINDOW_STATUSES.map((s) => ({ value: s, label: FILING_STATUS_LABELS[s] }))}
      />
    </Field>
    <ScheduleAnchorPicker
      label="Starts"
      hideRetirementStart
      members={[...members]}
      value={toAnchorPickerValue(w.start)}
      onChange={(a) => onPatch({ start: fromAnchorPickerValue(a) })}
    />
    <ScheduleAnchorPicker
      label="Ends (this year is not included)"
      hideRetirementStart
      members={[...members]}
      value={toAnchorPickerValue(w.end)}
      onChange={(a) => onPatch({ end: fromAnchorPickerValue(a) })}
    />
    {windowWarnings(w).map((warning) => (
      <Alert key={warning} tone="warning">
        {warning}
      </Alert>
    ))}
    <div className="flex justify-start">
      <button type="button" className={btnSecondaryClass} onClick={onRemove}>
        Remove this exception
      </button>
    </div>
  </li>
);

/** The year-bounded survivor exception windows. */
const FilingExceptionWindowsEditor: React.FC<{
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  windows: readonly FilingStatusWindow[];
  /** The status these exceptions are exceptions TO: the plan's standing
   *  status, which is `Single` unless the one-person **Files as** control set
   *  something else. Named rather than assumed, so the copy cannot promise a
   *  fallback the engines do not file. */
  standingStatus: TaxUnitFilingStatus;
  onChangeWindows: (next: readonly FilingStatusWindow[]) => void;
}> = ({ members, windows, standingStatus, onChangeWindows }) => {
  const rows = useStableRowIds(windows.length);
  const standing = statusLabelLower(standingStatus);
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-ink">
        Exception years after a spouse dies
      </span>
      <Muted className="text-sm">
        After a spouse dies the projection files {standing}. If you qualify for a
        different status for a stretch of years — for example qualifying
        surviving spouse while you still support a dependent child, which lasts
        at most the two tax years after the year of death, or head of household
        later — add it here and those years are filed that way instead. Leave
        this empty if none applies.
      </Muted>
      {windows.length === 0 ? (
        <Muted as="p" className="m-0 text-sm">
          No exception years — every year after a death is filed {standing}.
        </Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {windows.map((w, i) => (
            <FilingExceptionWindowRow
              key={rows.ids[i]}
              rowId={rows.ids[i]}
              members={members}
              window={w}
              onPatch={(patch) =>
                onChangeWindows(
                  windows.map((entry, j) => (j === i ? { ...entry, ...patch } : entry)),
                )
              }
              onRemove={() => {
                rows.onRemove(i);
                onChangeWindows(windows.filter((_, j) => j !== i));
              }}
            />
          ))}
        </ul>
      )}
      <div className="flex justify-start">
        <button
          type="button"
          className={btnSecondaryClass}
          onClick={() => {
            rows.onAdd();
            onChangeWindows([...windows, defaultFilingStatusWindow()]);
          }}
        >
          Add an exception
        </button>
      </div>
    </div>
  );
};

export interface FilingPlanSectionProps {
  /** Every household member — drives the spouse labels and the picker's
   *  age-anchor member select. */
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** The draft plan being edited. */
  plan: TaxFilingPlan;
  onChangePlan: (next: TaxFilingPlan) => void;
  /**
   * Set when this scenario's stored filing facts cannot be converted
   * automatically: a legacy scalar filing status that does not say how both
   * spouses file (a two-member `Single`/`HoH`, a one-member `MFJ`, or an
   * unrecognised value), or an unusable stored plan (see
   * `unresolvedFromStoredPlan`). Projections keep filing exactly as before until
   * the user saves a plan here; nothing is dropped.
   */
  unresolvedLegacyDetail?: string;
  /**
   * True when `unresolvedLegacyDetail` describes a stored PLAN that could
   * not be used (a corrupt payload, or one written before a spouse joined the
   * household) rather than an older scalar setting. The editor has opened on a
   * safe default, so the prompt says the saved choice was reset instead of
   * telling the user about a setting they may not have.
   */
  unresolvedFromStoredPlan?: boolean;
}

/**
 * Filing editor. Lets a household say how it files each year: together on one
 * return or separately on two while both spouses are alive, and which
 * year-bounded exception (if any) applies after a spouse dies.
 *
 * The stored plan is transition-safe by construction — a joint plan still files
 * jointly the year a spouse dies, a separate plan still files two returns that
 * year, and later years fall back to the plan's standing status (`Single` unless
 * a standing open-ended window says otherwise) except in the years a bounded
 * exception window covers — so it cannot freeze a stale "married filing jointly"
 * the way the old single filing-status setting could.
 */
export const FilingPlanSection: React.FC<FilingPlanSectionProps> = ({
  members,
  plan,
  onChangePlan,
  unresolvedLegacyDetail,
  unresolvedFromStoredPlan,
}) => {
  const primary = members.find((m) => m.payload.isPrimary);
  const secondary = members.find((m) => !m.payload.isPrimary);
  // What the projection files in a year no exception covers. `Single` for
  // almost every plan, but a standing head-of-household window makes it that
  // instead, and the copy below says whichever is true rather than hardcoding
  // "single" (the same standing status the report sentence names).
  const standingStatus = standingStatusOf(plan);
  const standing = statusLabelLower(standingStatus);
  const nameFor = (role: 'primary' | 'secondary'): string => {
    const member = role === 'primary' ? primary : secondary;
    return member ? memberDisplayName(member) : role === 'primary' ? 'You' : 'Your spouse';
  };
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium">How your household files</h3>
      {unresolvedLegacyDetail && (
        <Alert tone="warning">
          <div className="flex flex-col items-start gap-2">
            {unresolvedFromStoredPlan ? (
              <span>
                We could not use the filing choice saved for this scenario:{' '}
                {unresolvedLegacyDetail} Your projections keep filing the way
                they did before — nothing was dropped. We have filled in the
                usual choice below; check it and save to switch over.
              </span>
            ) : (
              <span>
                This scenario still uses an older filing setting that we cannot
                read for both of you: {unresolvedLegacyDetail} Your projections
                keep using that older setting exactly as before — nothing has
                changed and nothing was dropped. Choose below how you file, then
                save to switch over.
              </span>
            )}
            {/* Switching over is an EXPLICIT act. Saving any other tax
                assumption no longer converts the older setting behind the
                user's back, so this button exists for the case where the
                choice already shown is the one they want. */}
            <button
              type="button"
              className={btnSecondaryClass}
              onClick={() => onChangePlan({ ...plan })}
            >
              Use the choice shown below
            </button>
          </div>
        </Alert>
      )}
      <Muted className="text-sm">
        Tell the projection which tax return (or returns) your household files
        each year.{' '}
        {/* The spouse-death sentence only makes sense for a household
            that HAS a spouse. A scenario whose stored plan still says `joint` /
            `separate` after the spouse was removed used to keep this copy. */}
        {secondary === undefined
          ? 'You are the only person in this plan, so every year is filed on one return.'
          : plan.kind === 'separate'
            ? `The year a spouse dies is still filed on two separate returns, and later years fall back to filing ${standing} unless you add an exception below.`
            : `The year a spouse dies is still filed together, and later years fall back to filing ${standing} unless you add an exception below.`}
      </Muted>

      {/* Which picker shows follows the household that exists NOW, not
          the kind the stored plan happens to carry. Gating on `plan.kind` left a
          couple whose scenario still held a one-person plan (saved before the
          spouse was added) with no joint/separate control at all — the one
          screen that can repair it. */}
      {secondary === undefined ? (
        <IndividualStatusPicker plan={plan} onChangePlan={onChangePlan} />
      ) : (
        <FilingPlanKindPicker plan={plan} onChangePlan={onChangePlan} />
      )}

      {/* Every kind-specific control follows CURRENT membership too, not
          just the picker above. A stored `separate` plan on a household whose
          spouse has since been removed used to render the two-return editor
          (two "Files as" selects, a lived-together toggle) directly beneath the
          one-person picker: two controls contradicting each other, describing a
          spouse who is no longer in the plan. The resolver already files that
          household's single surviving return, so the two-return editor has
          nothing to edit until a spouse is added back. */}
      {plan.kind === 'separate' && secondary !== undefined && (
        <SeparateReturnsEditor plan={plan} nameFor={nameFor} onChangePlan={onChangePlan} />
      )}

      <FilingExceptionWindowsEditor
        members={members}
        windows={exceptionWindowsOf(plan)}
        standingStatus={standingStatus}
        onChangeWindows={(next) =>
          // Exceptions first, the plan's standing (open-ended) window last:
          // the standing window covers every year, so storing it ahead of an
          // exception used to leave that exception inert (the row rendered, the
          // resolver never reached it). Stored in priority order, the array reads
          // the way the resolver applies it.
          onChangePlan(
            planWithWindows(plan, [
              ...next,
              ...(plan.statusWindows ?? []).filter(isOpenEndedStatusWindow),
            ]),
          )
        }
      />
    </div>
  );
};
