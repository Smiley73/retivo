/**
 * Roth conversion plan comparison panel. For the selected scenario it runs the
 * suggestion search (`lib/roth-suggestion`) in a Web Worker on request, shows
 * a determinate progress bar with Cancel, and lists each candidate plan next to
 * the scenario's current one. It sends nothing to the server and writes no
 * scenario field until the user confirms Save on a ranked row (the page's own
 * save path), after which a marker names the saved plan.
 *
 * Never auto-runs: a run costs seconds and the user asks for it. A result is
 * tagged with the aggregate signature it ran on and marked out of date when the
 * data changes under it; a leftover-tax-rate change re-ranks the shown result
 * from its stored per-bucket balances without a second run.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Alert } from '../../components/Alert';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { InlineDisclaimerCard } from '../../components/InlineDisclaimerCard';
import { btnDangerToolbarClass, btnPrimaryToolbarClass } from '../accounts-page-chrome';
import { RothSavedPlanMarker } from './RothSavedPlanMarker';
import { RothSuggestionProgressBar } from './RothSuggestionProgressBar';
import { RothSuggestionSaveDialog } from './RothSuggestionSaveDialog';
import { RothSuggestionTable } from './RothSuggestionTable';
import type { ScenarioPayload } from '../../db/types';
import type { RothBETRPageData } from './roth-betr-data';
import {
  SEARCH_UNSUPPORTED_MESSAGES,
  UNAVAILABLE_MESSAGES,
  buildSuggestionTable,
  buildSuggestionWorkerInput,
  describeDeathAges,
  leftoverTaxFraction,
  resolveAssumedDeathAges,
  suggestionAvailability,
  suggestionDataSignature,
  type RothSuggestionData,
} from './roth-suggestion-view-model';
import { useRothSuggestion } from './use-roth-suggestion';
import { useRothSuggestionSave } from './use-roth-suggestion-save';

interface RothSuggestionPanelProps {
  readonly pageData: RothBETRPageData;
  /** The aggregate sets `pageData` was projected from. */
  readonly data: RothSuggestionData;
  readonly selectedScenarioId: string;
  /** Leftover-tax rate in percent: the rate on money still in pre-tax accounts. */
  readonly leftoverTaxPct: number;
  /** The page's save path: writes the override fragment, resolves true when the
   *  scenario was written (a failure is on the page's error banner). */
  readonly persistOverrides: (fragment: Partial<ScenarioPayload['overrides']>) => Promise<boolean>;
  /** The page's error banner. */
  readonly onError: (message: string) => void;
}

const NO_ROOM_MESSAGE =
  'No bracket had room in the conversion window: every plan, the current one included, ' +
  'converts $0, so there is nothing to compare.';

const RothSuggestionDisclaimer: React.FC<{ deathAges: string }> = ({ deathAges }) => (
  <InlineDisclaimerCard ariaLabel="Roth conversion plan comparison disclaimer" className="my-3">
    This tries a fixed set of bracket targets, each with and without staying under the
    Medicare surcharge and health-subsidy lines, and ranks them by the after-tax balance left
    at one assumed death age ({deathAges}), on the planned basis and with federal tax only. It
    shows what each plan would do in this model; it does not say which one to pick, and the
    top row is a search result over those targets, not a proven optimum.
  </InlineDisclaimerCard>
);

export const RothSuggestionPanel: React.FC<RothSuggestionPanelProps> = ({
  pageData,
  data,
  selectedScenarioId,
  leftoverTaxPct,
  persistOverrides,
  onError,
}) => {
  const { scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams } = data;
  const signature = useMemo(
    () =>
      suggestionDataSignature({
        scenarios,
        accounts,
        balances,
        members,
        ssBenefits,
        expenses,
        incomeStreams,
      }),
    [scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams],
  );
  const availability = useMemo(
    () => suggestionAvailability(pageData, { scenarios, members }, selectedScenarioId),
    [pageData, scenarios, members, selectedScenarioId],
  );
  const deathAges = useMemo(
    () => describeDeathAges(resolveAssumedDeathAges(scenarios, selectedScenarioId, members), members),
    [scenarios, selectedScenarioId, members],
  );
  const { state, run, cancel } = useRothSuggestion(selectedScenarioId, signature);
  // The results were computed on data that has since changed; their ladders
  // must not be saved as if they fit the data now.
  const resultsStale = state.phase === 'done' && state.signature !== signature;
  const save = useRothSuggestionSave({
    pageData,
    data,
    selectedScenarioId,
    resultsStale,
    persistOverrides,
    onError,
  });

  const rate = leftoverTaxFraction(leftoverTaxPct);
  const table = useMemo(
    () =>
      state.phase === 'done' && state.outcome.kind === 'result'
        ? buildSuggestionTable(state.outcome.result, rate)
        : null,
    [state, rate],
  );

  // The action and Cancel swap places as a run starts and ends. A swap would
  // drop keyboard focus to the page, so hand it to the button that replaces the
  // one that held it (focus elsewhere, such as in the table, is left alone).
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const running = state.phase === 'running';
  const wasRunning = useRef(false);
  useEffect(() => {
    const before = wasRunning.current;
    wasRunning.current = running;
    if (before === running) return;
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    (running ? cancelRef : actionRef).current?.focus();
  }, [running]);

  const onRun = (): void => {
    if (availability.kind !== 'ready') return;
    run(
      buildSuggestionWorkerInput({
        data,
        pageData,
        selectedScenarioId,
        targetRothAccountId: availability.targetRoth.id,
        leftoverTaxPct,
      }),
    );
  };

  return (
    <>
      <Card>
        <h2 className="mb-1 text-lg font-semibold text-ink">Compare conversion plans</h2>
        <p className="mb-3 mt-0 max-w-prose text-sm text-muted">
          Tries filling up to each of several tax brackets every year from retirement until
          required withdrawals begin, with and without staying under the Medicare surcharge
          and health-subsidy lines, and lists the results next to your current plan.
          {availability.kind === 'ready' &&
            ` Conversions go into ${availability.targetRoth.name}.`}
        </p>
        <RothSavedPlanMarker status={save.status} />
        {availability.kind === 'unavailable' ? (
          <EmptyState bare>{UNAVAILABLE_MESSAGES[availability.reason]}</EmptyState>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              {running ? (
                <>
                  <button
                    ref={cancelRef}
                    type="button"
                    className={btnDangerToolbarClass}
                    onClick={cancel}
                  >
                    Cancel
                  </button>
                  <RothSuggestionProgressBar done={state.done} total={state.total} />
                </>
              ) : (
                <button
                  ref={actionRef}
                  type="button"
                  className={btnPrimaryToolbarClass}
                  onClick={onRun}
                >
                  Compare conversion plans
                </button>
              )}
            </div>
            {state.phase === 'cancelled' && (
              <Alert tone="info" role="status">
                Comparison cancelled. Nothing was changed.
              </Alert>
            )}
            {state.phase === 'error' && (
              <Alert tone="error" role="status">
                The comparison could not finish: {state.message}
              </Alert>
            )}
            {resultsStale && (
              <Alert tone="warning" role="status">
                Your data changed after this comparison ran, so the rows below may be out of
                date. Press &ldquo;Compare conversion plans&rdquo; to run it again.
              </Alert>
            )}
            {state.phase === 'done' && state.outcome.kind === 'empty' && (
              <Alert tone="info" role="status">
                {SEARCH_UNSUPPORTED_MESSAGES[state.outcome.reason]}
              </Alert>
            )}
            {table?.kind === 'no-room' && (
              <Alert tone="info" role="status">
                {NO_ROOM_MESSAGE}
              </Alert>
            )}
            {table?.kind === 'rows' && (
              <RothSuggestionTable
                rows={table.rows}
                leftoverTaxPct={leftoverTaxPct}
                onSave={resultsStale ? undefined : save.openFor}
              />
            )}
            {/* Always mounted so a screen reader hears the text arrive; the other
                outcomes carry their own Alerts. */}
            <div aria-live="polite" className="sr-only">
              {table?.kind === 'rows' &&
                `Comparison finished: ${table.rows.length} ${
                  table.rows.length === 1 ? 'plan' : 'plans'
                } listed below.`}
            </div>
          </>
        )}
      </Card>
      <RothSuggestionSaveDialog
        {...save.dialog}
        onClose={save.close}
        onConfirm={save.confirm}
        deathAges={deathAges}
      />
      <RothSuggestionDisclaimer deathAges={deathAges} />
    </>
  );
};
