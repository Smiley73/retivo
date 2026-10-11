/**
 * Projected withdrawals page — turns the deterministic per-account drawdown
 * projection into a plain-language view of the withdrawals projected from each
 * account this year for the sidebar-selected scenario.
 *
 * Surface: a selected-year hero card (year stepper + "jump to current year")
 * showing per-account projected withdrawals, the required minimum by legal
 * aggregation group, the year's income tax + Medicare and after-tax
 * spendable, plus an expandable full year-by-year per-account schedule and
 * a standing "not financial advice" disclaimer + a keep-balances-current
 * nudge.
 *
 * READ-ONLY: every figure derives from the deterministic
 * `runBalanceProjectionForPage` output — the same engine the Balance Projection
 * page uses, so this page can't silently disagree with it. The per-account
 * RMD reuses the deterministic `DrawdownYear.perAccountRmdCents` field; nothing
 * here touches the Monte Carlo path.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { InlineDisclaimerCard } from '../components/InlineDisclaimerCard';
import { Muted } from '../components/Muted';
import { StatGrid, Stat } from '../components/StatGrid';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { btnSecondarySmClass, valueNegativeClass } from './accounts-page-chrome';
import { formatCurrency } from '../lib/format-currency';
import { runBalanceProjectionForPage } from '../lib/balance-projection-runner';
import { isEmptyProjectionDataError } from '../lib/projection-empty-data-errors';
import type { ProjectionMethod } from '../components/ProjectionChart';
import type { DisplayMode } from '../lib/view-deflator';
import { realDeflatorAt } from '../lib/projection-context';
import { useBalanceProjectionData } from './use-balance-projection-data';
import type {
  RmdAggregationGroup,
} from '../lib/rmd-aggregation-groups';
import {
  buildGuidanceYearRows,
  indexForYear,
  type GuidanceAccountMeta,
  type GuidanceAccountRow,
  type GuidanceYearRow,
} from './withdrawal-guidance-data';
import { WithdrawalGuidanceSchedule } from './withdrawal-guidance-schedule';
import { aggregationTypeLabel } from './withdrawal-guidance-labels';
import {
  PROJECTION_METHOD_LABELS,
  TWR_METHOD_LABEL,
} from '../lib/projection-method-labels';

const METHOD_OPTIONS: ReadonlyArray<{ value: ProjectionMethod; label: string }> =
  [
    { value: 'planned', label: PROJECTION_METHOD_LABELS.planned },
    { value: 'twr', label: TWR_METHOD_LABEL },
  ];

const BASIS_OPTIONS: ReadonlyArray<{
  value: DisplayMode;
  label: string;
  title: string;
}> = [
  {
    value: 'future',
    label: 'Future dollars',
    title: 'The actual amounts a statement will show, with inflation included.',
  },
  {
    value: 'today',
    label: "Today's dollars",
    title: "What today's prices would buy, with inflation already pulled out.",
  },
];

/**
 * Plain-language note under an HSA account line: HSA dollars appear only
 * for modeled medical costs (tax-free) or as a last-resort emergency reserve.
 * Renders nothing for non-HSA accounts or when the HSA had no withdrawal.
 * Exported for the focused render + a11y test.
 */
export function HsaSplitNote({
  acc,
  format,
}: {
  readonly acc: GuidanceAccountRow;
  readonly format: (dollars: number) => string;
}): React.ReactElement | null {
  const medical = acc.hsaMedicalQualifiedDollars;
  const emergency = acc.hsaEmergencyReserveDollars;
  if (medical === undefined || emergency === undefined) return null;
  if (medical <= 0 && emergency <= 0) return null;
  const parts: string[] = [];
  if (medical > 0) parts.push(`${format(medical)} for medical costs (tax-free)`);
  if (emergency > 0) parts.push(`${format(emergency)} as an emergency reserve`);
  return (
    <Muted as="span" className="text-xs">
      {parts.join(' · ')}
    </Muted>
  );
}

/**
 * Plain-language note under a MIXED account line: shows how much of the
 * projected withdrawal comes from the pre-tax sub-account and how much from the
 * Roth (or after-tax) sub-account. Renders nothing for non-MIXED accounts or when
 * no per-sub-account split data is available. Exported for the focused render +
 * a11y test.
 */
export function MixedSplitNote({
  acc,
  format,
}: {
  readonly acc: GuidanceAccountRow;
  readonly format: (dollars: number) => string;
}): React.ReactElement | null {
  if (!acc.isMixed) return null;
  if (acc.preTaxWithdrawnDollars === undefined) return null;
  const preLabel = `${format(acc.preTaxWithdrawnDollars)} from pre-tax`;
  const postLabel = `${format(acc.postWithdrawnDollars ?? 0)} from ${acc.postLabel ?? 'post-tax'}`;
  return (
    <Muted as="span" className="text-xs">
      {preLabel} · {postLabel}
    </Muted>
  );
}

/** Render one RMD aggregation group as a plain-language projected-amount line. */
function RmdGroupLine({
  group,
  ownerLabel,
  formatDollars,
}: {
  readonly group: RmdAggregationGroup;
  readonly ownerLabel: string;
  readonly formatDollars: (dollars: number) => string;
}): React.ReactElement {
  const amount = formatDollars(group.requiredCents / 100);
  const typeLabel = aggregationTypeLabel(group.accountType);
  if (group.kind === 'aggregatable') {
    const names = group.accounts.map((a) => a.name).join(', ');
    return (
      <li>
        <strong>{amount}</strong> projected from any of {ownerLabel}&rsquo;s{' '}
        {typeLabel} ({names}).
      </li>
    );
  }
  const name = group.accounts[0]?.name ?? typeLabel;
  return (
    <li>
      <strong>{amount}</strong> projected from {ownerLabel}&rsquo;s {name} (
      {typeLabel} — required minimum must come from this account).
    </li>
  );
}

export const WithdrawalGuidancePage: React.FC = () => {
  const data = useBalanceProjectionData();
  const [method, setMethod] = useState<ProjectionMethod>('planned');
  const [basis, setBasis] = useState<DisplayMode>('future');
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);

  const scenarioName =
    data.scenarios.find((s) => s.id === data.selectedScenarioId)?.payload.name ??
    null;

  // Owner-id → display name + a per-account metadata map for the aggregation
  // grouping. Members carry `firstName`; accounts carry `ownerId` + `type`.
  const ownerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const member of data.members) {
      m.set(member.id, member.payload.firstName || 'Owner');
    }
    return m;
  }, [data.members]);

  const accountsById = useMemo(() => {
    const m = new Map<string, GuidanceAccountMeta>();
    for (const acc of data.accounts) {
      m.set(acc.id, {
        id: acc.id,
        name: acc.payload.name,
        type: acc.payload.type,
        ownerId: acc.payload.ownerId,
        taxTreatment: acc.payload.taxTreatment,
        // An inherited account never aggregates with the beneficiary's own
        // accounts, so it is shown as its own required-withdrawal group.
        ...(acc.payload.rmdInheritedAccount === true ? { inherited: true } : {}),
      });
    }
    return m;
  }, [data.accounts]);

  // Run the deterministic projection for the selected scenario. Mirrors the
  // Balance Projection page's arg assembly. `null` when the scenario
  // can't be projected (no primary / unresolved retirement / config error).
  const projection = useMemo(() => {
    if (!data.ready || !data.selectedScenarioId) return null;
    if (!data.scenarios.some((s) => s.id === data.selectedScenarioId)) {
      return null;
    }
    const now = new Date();
    try {
      return runBalanceProjectionForPage({
        scenarioId: data.selectedScenarioId,
        scenarios: [...data.scenarios],
        accounts: [...data.accounts],
        balances: [...data.balances],
        members: [...data.members],
        ssBenefits: [...data.ssBenefits],
        expenses: [...data.expenses],
        incomeStreams: [...data.incomeStreams],
        todayYear: now.getFullYear(),
        todayMonthIndex: now.getMonth(),
        method: 'planned',
      });
    } catch (e) {
      // Empty/incomplete household (no primary member or no resolvable
      // retirement date) is not a bug — collapse to the empty-plan state
      // instead of crashing to ErrorBoundary. Any other error still re-throws.
      if (isEmptyProjectionDataError(e)) return null;
      throw e;
    }
  }, [
    data.ready,
    data.selectedScenarioId,
    data.scenarios,
    data.accounts,
    data.balances,
    data.members,
    data.ssBenefits,
    data.expenses,
    data.incomeStreams,
  ]);

  // Historical is offered only when the projection produced a TWR method;
  // otherwise the toggle falls back to Planned with a visible note.
  const twrAvailable =
    projection !== null &&
    projection.sharedCtx.methodAvailable &&
    projection.twr !== null;
  const effectiveMethod: ProjectionMethod =
    method === 'twr' && !twrAvailable ? 'planned' : method;

  const methodResult =
    projection === null
      ? null
      : effectiveMethod === 'twr'
        ? projection.twr
        : projection.planned;

  const rows: ReadonlyArray<GuidanceYearRow> = useMemo(() => {
    if (methodResult === null) return [];
    return buildGuidanceYearRows(methodResult.years, accountsById);
  }, [methodResult, accountsById]);

  // Deflator: today's-dollars view divides each nominal figure by the
  // inflation factor at its year; actual-dollars view is the identity.
  const ctx = projection?.sharedCtx.ctx ?? null;
  const formatAt = useMemo(() => {
    return (dollars: number, year: number): string => {
      if (basis === 'today' && ctx) {
        return formatCurrency(dollars * realDeflatorAt(ctx, year, 11));
      }
      return formatCurrency(dollars);
    };
  }, [basis, ctx]);

  const firstYear = rows.length > 0 ? rows[0].year : null;
  const lastYear = rows.length > 0 ? rows[rows.length - 1].year : null;

  // The page opens on the current calendar year, but the first projected
  // drawdown row can start later (e.g. retirement is a few years out). Snap to
  // the first row when firstYear first becomes available, so the hero shows the
  // earliest actionable guidance year instead of a pre-range slot.
  //
  // Uses a functional updater so `selectedYear` is NOT in the dep array — the
  // effect fires only when `firstYear` changes (e.g. projection loads), not on
  // every user navigation, so clicking "Jump to current year" doesn't get
  // immediately overridden by the clamp.
  useEffect(() => {
    if (firstYear !== null) {
      setSelectedYear((prev) => (prev < firstYear ? firstYear : prev));
    }
  }, [firstYear]); // intentionally omits selectedYear — see comment above

  const selectedIndex = indexForYear(rows, selectedYear);
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;

  // Last year for which a real (non-seed) balance exists — drives the
  // keep-current nudge. The runner re-anchors off the latest entered balance.
  const lastBalanceYear = useMemo(() => {
    let max: number | null = null;
    for (const b of data.balances) {
      const y = b.payload.year;
      if (max === null || y > max) max = y;
    }
    return max;
  }, [data.balances]);

  const formatDollarsAtSelected = (dollars: number): string =>
    formatAt(dollars, selectedRow?.year ?? selectedYear);

  const ownerLabelFor = (group: RmdAggregationGroup): string =>
    ownerNameById.get(group.ownerId) ?? 'this owner';

  const canStepPrev = firstYear !== null && selectedYear > firstYear;
  const canStepNext = lastYear !== null && selectedYear < lastYear;

  return (
    <section>
      <PageHeader
        title="Projected withdrawals"
        subtitle={
          scenarioName
            ? `Projected withdrawals from each account — scenario: ${scenarioName}.`
            : 'Projected withdrawals from each account each year.'
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <SegmentedRadioGroup
          ariaLabel="Return method"
          options={[...METHOD_OPTIONS]}
          value={effectiveMethod}
          onChange={setMethod}
        />
        <SegmentedRadioGroup
          ariaLabel="Dollar basis"
          options={[...BASIS_OPTIONS]}
          value={basis}
          onChange={setBasis}
        />
      </div>

      {method === 'twr' && !twrAvailable && (
        <Muted as="p" className="mb-3 text-xs">
          {TWR_METHOD_LABEL} returns aren&rsquo;t available for this scenario
          yet (no account has enough balance history), so these figures use
          your Planned returns.
        </Muted>
      )}

      {!data.ready ? (
        <Card>
          <Muted>Loading your projection…</Muted>
        </Card>
      ) : projection === null || rows.length === 0 ? (
        <Card>
          <p className="m-0 text-sm text-ink">
            There&rsquo;s no withdrawal plan to show yet. Add your household,
            accounts with balances, and a retirement age to the selected
            scenario, then come back here.
          </p>
          <Muted as="p" className="mt-2 text-sm">
            <Link to="/account-balances" className="underline">
              Go to Account Balances
            </Link>
          </Muted>
        </Card>
      ) : (
        <>
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="m-0 text-lg font-semibold text-ink">
                {selectedRow?.year ?? selectedYear}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={btnSecondarySmClass}
                  onClick={() => setSelectedYear((y) => y - 1)}
                  disabled={!canStepPrev}
                  aria-label="Previous year"
                >
                  ← Previous
                </button>
                <button
                  type="button"
                  className={btnSecondarySmClass}
                  onClick={() => setSelectedYear((y) => y + 1)}
                  disabled={!canStepNext}
                  aria-label="Next year"
                >
                  Next →
                </button>
                <button
                  type="button"
                  className={btnSecondarySmClass}
                  onClick={() => setSelectedYear(currentYear)}
                  disabled={selectedYear === currentYear}
                >
                  Jump to current year
                </button>
              </div>
            </div>

            {selectedRow === null || !selectedRow.hasWithdrawal ? (
              <p className="m-0 text-sm text-ink">
                No portfolio withdrawal needed this year — your income covers
                this year&rsquo;s expenses.
                {firstYear !== null &&
                  selectedRow === null &&
                  selectedYear < firstYear && (
                    <> Your plan starts drawing down in {firstYear}.</>
                  )}
              </p>
            ) : (
              <>
                <StatGrid cols="three" className="mb-4">
                  <Stat
                    label="Total projected withdrawal"
                    value={formatDollarsAtSelected(
                      selectedRow.totalWithdrawnDollars,
                    )}
                  />
                  <Stat
                    label="Income tax + Medicare"
                    value={formatDollarsAtSelected(
                      selectedRow.taxAndMedicareDollars,
                    )}
                  />
                  <Stat
                    label="Spendable after tax"
                    value={formatDollarsAtSelected(selectedRow.spendableDollars)}
                  />
                </StatGrid>

                <h3 className="mb-2 text-sm font-semibold text-ink">
                  Projected withdrawals by account
                </h3>
                <ul className="m-0 mb-4 list-none space-y-1 p-0 text-sm text-ink">
                  {selectedRow.accounts.map((acc) => (
                    <li key={acc.accountId} className="flex flex-col">
                      <span className="flex justify-between gap-4">
                        <span>{acc.accountName}</span>
                        <span className="font-mono tabular-nums">
                          {formatDollarsAtSelected(acc.withdrawnDollars)}
                        </span>
                      </span>
                      <HsaSplitNote acc={acc} format={formatDollarsAtSelected} />
                      <MixedSplitNote acc={acc} format={formatDollarsAtSelected} />
                    </li>
                  ))}
                </ul>

                {selectedRow.rmdGroups.length > 0 && (
                  <div className="mb-2">
                    <h3 className="mb-2 text-sm font-semibold text-ink">
                      Required minimum distributions
                    </h3>
                    <ul className="m-0 list-disc space-y-1 pl-5 text-sm text-ink">
                      {selectedRow.rmdGroups.map((group) => (
                        <RmdGroupLine
                          key={group.key}
                          group={group}
                          ownerLabel={ownerLabelFor(group)}
                          formatDollars={formatDollarsAtSelected}
                        />
                      ))}
                    </ul>
                  </div>
                )}

                {selectedRow.hasRmdShortfall && (
                  <p className={`m-0 mt-2 text-sm ${valueNegativeClass}`}>
                    One or more accounts can&rsquo;t cover their full required
                    minimum distribution this year — the remaining amount has to
                    come from outside the portfolio.
                  </p>
                )}

                {/* The engine's own required-withdrawal disclosures
                    for this year: which accounts are on hold for missing
                    inherited details, which are deferred while still working,
                    and when two required withdrawals land in one year. */}
                {selectedRow.rmdDisclosures.length > 0 && (
                  <ul className="m-0 mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                    {selectedRow.rmdDisclosures.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>

          {/* Standing disclaimer, ABOVE the schedule (before the numbers a
              reader would act on) — the point-of-use reliance defense. */}
          <InlineDisclaimerCard
            ariaLabel="Projected withdrawals disclaimer"
            className="my-3"
          >
            These figures are estimates produced by your plan&rsquo;s
            assumptions — they are only as good as the balances and assumptions
            behind them, so keep your account balances current and expect the
            real numbers to differ. They are not transaction, filing,
            required-minimum-distribution, Medicare, or ACA instructions;
            required minimum distributions, taxes, Medicare, and ACA amounts are
            simplified estimates, not filings.
          </InlineDisclaimerCard>

          <WithdrawalGuidanceSchedule
            rows={rows}
            selectedYear={selectedRow?.year ?? selectedYear}
            open={scheduleOpen}
            onToggle={() => setScheduleOpen((o) => !o)}
            formatAt={formatAt}
          />

          <Muted as="p" className="mt-3 text-sm">
            {lastBalanceYear !== null
              ? `These figures re-anchor off your latest entered balances (${lastBalanceYear}). Keep them current — record this year's real balances and any withdrawals on the `
              : 'These figures depend on current balances. Record your real balances and any withdrawals on the '}
            <Link to="/account-balances" className="underline">
              Account Balances
            </Link>{' '}
            page so next year&rsquo;s projection stays accurate.
          </Muted>
        </>
      )}
    </section>
  );
};
