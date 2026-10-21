/**
 * Roth conversion comparison page. For the selected scenario, computes
 * Vanguard's break-even tax rate (BETR) across four tax-payment-source variants,
 * shows the working-years bracket headroom + convert/hold verdicts and the
 * per-year retirement BETR table, and lets the user apply a bracket-fill
 * working-years conversion schedule or a pre-RMD MAGI-cap Fill window to the
 * active scenario.
 *
 * Read-only by default; the mutation paths (the taxable-income field, and
 * the two Apply dialogs) write through `saveScenario` / `queueLocalMutation`
 * with `expectedVersion`. Deterministic projection only — no Monte Carlo. The
 * plan-comparison panel runs its own search in a Web Worker, on request, and
 * writes nothing until the user confirms Save on a ranked plan, which goes
 * through the same `persistOverrides`.
 *
 * Subcomponents + the projection/context build live under `./roth-betr/` so
 * this shell stays within the ≤400-line shape cap; it owns state + the React
 * tree only.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Field } from '../components/Field';
import { Select } from '../components/Select';
import { PercentInput } from '../components/PercentInput';
import { Alert } from '../components/Alert';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/Skeleton';
import { btnSecondarySmClass } from '../components/dialog-chrome';
import { saveScenario } from '../lib/scenario-mutations';
import { isEmptyProjectionDataError } from '../lib/projection-empty-data-errors';
import { useBalanceProjectionData } from './use-balance-projection-data';
import { buildRothBETRPageData } from './roth-betr/roth-betr-data';
import { WorkingYearsPanel } from './roth-betr/WorkingYearsPanel';
import { RetirementYearsTable } from './roth-betr/RetirementYearsTable';
import { RothSuggestionPanel } from './roth-betr/RothSuggestionPanel';
import {
  LEFTOVER_TAX_FALLBACK_PCT,
  LEFTOVER_TAX_MAX_PCT,
  defaultLeftoverTaxPct,
} from './roth-betr/roth-suggestion-view-model';
import { BETR_SOURCE_SELECT_OPTIONS } from './roth-betr/betr-presentation-shared';
import { BackdoorRothCallout } from './roth-betr/BackdoorRothCallout';
import { ApplyWorkingYearsDialog } from './roth-betr/ApplyWorkingYearsDialog';
import { ApplyRetirementDialog } from './roth-betr/ApplyRetirementDialog';
import {
  buildWorkingYearsConversionWindow,
  buildRetirementFillWindow,
} from '../lib/roth-betr-apply-helpers';
import { rmdTriggerAge } from '../lib/rmd';
import { TAX_SNAPSHOT_NOTE } from '../lib/disclaimer-fragments';
import type { BETRSource } from '../lib/betr-calculator';
import type { MagiCapLine, ScenarioPayload } from '../db/types';

const PRO_RATA_DISCLAIMER =
  'Assumes 100% pre-tax basis in traditional accounts (IRA pro-rata rule not modeled).';

export const RothBETRPage: React.FC = () => {
  const { householdId } = useAuth();
  const data = useBalanceProjectionData();
  const [scenarioOverride, setScenarioOverride] = useState<string | null>(null);
  const [source, setSource] = useState<BETRSource>('ira');
  const [dragPct, setDragPct] = useState(10);
  // Leftover-tax rate for the plan comparison, in percent. `null` follows the
  // page's own RMD-era rate until the user types; not persisted.
  const [leftoverTaxOverride, setLeftoverTaxOverride] = useState<number | null>(null);
  const [wyDialogOpen, setWyDialogOpen] = useState(false);
  const [retDialogOpen, setRetDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Draft taxable income — edited per keystroke, persisted once on blur so a
  // single edit queues one scenario mutation (not one per character) and never
  // races stale `expectedVersion` saves. `null` follows the persisted
  // scenario value until the user types.
  const [draftIncome, setDraftIncome] = useState<number | null>(null);

  const selectedScenarioId = scenarioOverride ?? data.selectedScenarioId ?? '';
  const selectedScenario = useMemo(
    () => data.scenarios.find((s) => s.id === selectedScenarioId) ?? null,
    [data.scenarios, selectedScenarioId],
  );

  const pageData = useMemo(() => {
    if (!data.ready || selectedScenarioId === '') return null;
    const now = new Date();
    try {
      return buildRothBETRPageData({
        scenarios: data.scenarios,
        selectedScenarioId,
        accounts: data.accounts,
        balances: data.balances,
        members: data.members,
        ssBenefits: data.ssBenefits,
        expenses: data.expenses,
        incomeStreams: data.incomeStreams,
        todayYear: now.getFullYear(),
        todayMonthIndex: now.getMonth(),
      });
    } catch (e) {
      // Known empty-data domain signals collapse to the empty state: an
      // unprojectable tax input, or an incomplete household with no primary
      // member / no resolvable retirement date. Any other error is a real bug
      // and re-throws to ErrorBoundary rather than being silently swallowed.
      if (isEmptyProjectionDataError(e)) return null;
      throw e;
    }
  }, [
    data.ready,
    data.scenarios,
    selectedScenarioId,
    data.accounts,
    data.balances,
    data.members,
    data.ssBenefits,
    data.expenses,
    data.incomeStreams,
  ]);

  // Persist the whole scenario payload with the merged override fragment. One
  // path for the taxable-income field, both Apply dialogs and the plan
  // comparison's save. Resolves true when the scenario was written.
  const persistOverrides = useCallback(
    async (fragment: Partial<ScenarioPayload['overrides']>): Promise<boolean> => {
      if (!householdId || selectedScenario === null) return false;
      const payload: ScenarioPayload = {
        ...selectedScenario.payload,
        overrides: { ...selectedScenario.payload.overrides, ...fragment },
      };
      try {
        // Clear any stale banner from a prior failed save so a later success
        // doesn't leave the error pinned.
        setError(null);
        await saveScenario({ scenario: selectedScenario, payload, householdId });
        return true;
      } catch (e) {
        setError((e as Error).message ?? 'Failed to save.');
        return false;
      }
    },
    [householdId, selectedScenario],
  );

  // Drop the in-progress draft when the user switches scenarios so one
  // scenario's unsaved income can't leak into another.
  useEffect(() => {
    setDraftIncome(null);
    setLeftoverTaxOverride(null);
  }, [selectedScenarioId]);
  const leftoverTaxPct =
    leftoverTaxOverride ??
    (pageData === null
      ? LEFTOVER_TAX_FALLBACK_PCT
      : defaultLeftoverTaxPct(pageData.workingSummary.T_future));

  const onTaxableIncomeChange = useCallback((next: number) => {
    setDraftIncome(Math.max(0, Math.round(next)));
  }, []);

  const onTaxableIncomeCommit = useCallback(() => {
    if (draftIncome === null) return;
    void persistOverrides({ preRetirementTaxableIncomeDollars: draftIncome });
  }, [draftIncome, persistOverrides]);

  const onApplyWorkingYears = useCallback(
    (sourceAccountId: string, targetRothId: string) => {
      if (pageData === null) return;
      try {
        const window = buildWorkingYearsConversionWindow({
          convertTranches: pageData.workingSummary.tranches,
          sourceAccountId,
          targetRothId,
          currentYear: pageData.currentCalendarYear,
          retirementAge: pageData.retirementAge,
        });
        void persistOverrides({ preRetirementRothConversions: [window] });
        setWyDialogOpen(false);
      } catch (e) {
        setError((e as Error).message ?? "Couldn't save to the scenario.");
      }
    },
    [pageData, persistOverrides],
  );

  const onApplyRetirement = useCallback(
    (magiLine: MagiCapLine, targetRothId: string) => {
      if (pageData === null || selectedScenario === null) return;
      try {
        const fragment = buildRetirementFillWindow({
          ownerBirthYear: pageData.ctx.ownerBirthYear,
          retirementYear: pageData.ctx.retirementYear,
          magiLine,
          targetRothId,
          filingStatus: pageData.ctx.filingStatus,
          householdSize: pageData.ctx.householdSize,
          inflationRatePct: pageData.ctx.inflationRatePct,
          localOverrides: selectedScenario.payload.overrides,
          parentCap: pageData.parentCap,
          bundle: pageData.bundle,
        });
        void persistOverrides(fragment);
        setRetDialogOpen(false);
      } catch (e) {
        setError((e as Error).message ?? "Couldn't save to the scenario.");
      }
    },
    [pageData, selectedScenario, persistOverrides],
  );

  const scenarioOptions = data.scenarios.map((s) => ({ value: s.id, label: s.payload.name }));

  return (
    <>
      <PageHeader
        title="Roth conversion comparison"
        subtitle="Break-even tax rate analysis across four tax-payment sources, a per-year retirement table, and controls that save a modeled bracket-fill conversion schedule or a pre-RMD MAGI-cap Fill window to the scenario."
      />
      <Alert tone="info" role="status">
        {PRO_RATA_DISCLAIMER} Federal taxes only; deterministic projection.{' '}
        {TAX_SNAPSHOT_NOTE}
      </Alert>

      {error && <Alert tone="error">{error}</Alert>}

      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <Field htmlFor="betr-scenario" label="Scenario" className="w-64">
            <Select
              id="betr-scenario"
              ariaLabel="Scenario"
              value={selectedScenarioId}
              onChange={setScenarioOverride}
              options={scenarioOptions}
              placeholder="Select a scenario"
            />
          </Field>
          <Field htmlFor="betr-source" label="Pay conversion tax from" className="w-64">
            <Select
              id="betr-source"
              ariaLabel="Tax-payment source"
              value={source}
              onChange={(v) => setSource(v as BETRSource)}
              options={BETR_SOURCE_SELECT_OPTIONS}
            />
          </Field>
          <Field
            htmlFor="betr-drag"
            label="Taxable-account tax drag"
            className="w-64"
            hint="Share of a taxable account's growth lost to tax each year (dividends, interest, realized gains). Only matters for the two taxable-account sources (the lower- and higher-default-tax-drag taxable accounts) — a higher drag means that account was already growing more slowly, so the dollars used to pay the tax give up less future growth, which lowers the modeled break-even rate."
          >
            <PercentInput
              id="betr-drag"
              value={dragPct}
              onChange={setDragPct}
              ariaLabel="Taxable-account tax drag percent"
            />
          </Field>
          <Field
            htmlFor="betr-leftover-tax"
            label="Leftover-tax rate"
            className="w-64"
            hint="Used by the plan comparison. Money still in pre-tax accounts at the end of the projection counts after this rate; Roth and already-taxed balances count in full. Starts at the average rate the break-even uses for the years when required withdrawals begin."
          >
            <PercentInput
              id="betr-leftover-tax"
              value={leftoverTaxPct}
              onChange={setLeftoverTaxOverride}
              max={LEFTOVER_TAX_MAX_PCT}
              ariaLabel="Leftover-tax rate percent"
            />
          </Field>
        </div>
      </Card>

      {!data.ready ? (
        <LoadingState label="Loading scenario…" variant="table" />
      ) : pageData === null ? (
        <EmptyState>
          Select a scenario with a primary member, a resolvable retirement date,
          and projected drawdown years to analyze Roth conversions.
        </EmptyState>
      ) : (
        <>
          {pageData.backdoorRothAvailable && <BackdoorRothCallout />}

          <WorkingYearsPanel
            summary={pageData.workingSummary}
            taxableIncomeDollars={
              draftIncome ?? pageData.ctx.preRetirementTaxableIncomeDollars
            }
            onTaxableIncomeChange={onTaxableIncomeChange}
            onTaxableIncomeCommit={onTaxableIncomeCommit}
            yearsToRetirement={Math.max(
              0,
              pageData.ctx.retirementYear - pageData.currentCalendarYear,
            )}
            source={source}
            dragPct={dragPct}
            iraOwnerBoundary={pageData.iraConversionOwnerBoundary}
          />

          <div className="my-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={btnSecondarySmClass}
              disabled={pageData.workingSummary.convertTotalCents <= 0}
              onClick={() => setWyDialogOpen(true)}
            >
              Save working-years conversions to scenario
            </button>
            <button
              type="button"
              className={btnSecondarySmClass}
              onClick={() => setRetDialogOpen(true)}
            >
              Save retirement Fill window to scenario
            </button>
          </div>
          <p className="-mt-1 mb-3 text-xs text-muted">
            Conversion amount based on the IRA-source analysis. The four
            tax-payment-source comparison results above are informational — they compare
            break-even tax rates under this model&rsquo;s assumptions; they do
            not tell you whether converting is right for you, or how much to
            convert.
          </p>

          <Card>
            <h2 className="mb-3 text-lg font-semibold text-ink">Retirement years</h2>
            <RetirementYearsTable
              rows={pageData.retirementRows}
              source={source}
              dragPct={dragPct}
              iraOwnerBoundary={pageData.iraConversionOwnerBoundary}
            />
          </Card>

          <RothSuggestionPanel
            pageData={pageData}
            data={data}
            selectedScenarioId={selectedScenarioId}
            leftoverTaxPct={leftoverTaxPct}
            persistOverrides={persistOverrides}
            onError={setError}
          />

          <ApplyWorkingYearsDialog
            open={wyDialogOpen}
            onClose={() => setWyDialogOpen(false)}
            amountDollars={pageData.workingSummary.convertTotalCents / 100}
            replacedWindowCount={
              selectedScenario?.payload.overrides.preRetirementRothConversions?.length ?? 0
            }
            sourceAccounts={pageData.sourceAccounts}
            rothIraAccounts={pageData.rothIraAccounts}
            onConfirm={onApplyWorkingYears}
          />
          <ApplyRetirementDialog
            open={retDialogOpen}
            onClose={() => setRetDialogOpen(false)}
            rmdTriggerAge={rmdTriggerAge(pageData.ctx.ownerBirthYear)}
            rothIraAccounts={pageData.rothIraAccounts}
            onConfirm={onApplyRetirement}
          />
        </>
      )}
    </>
  );
};
