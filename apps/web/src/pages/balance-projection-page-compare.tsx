/**
 * Balance Projection page — the "Compare" tab panel: heading, "Compare with"
 * selector, basis sentence, then a state (pick one, nothing to compare with,
 * projecting, cannot be projected, error) or the headline table, the Plan
 * success row and the Drivers table. Identical Planned projections swap the
 * headline and Drivers for one sentence; the Plan success row stays unless the
 * stress-test inputs match too. Renders only: selection and the second
 * projection come from `useBalanceProjectionCompare`, every figure and
 * difference from `buildCompareData` / `formatSignedDifference`.
 */
import React, { useMemo } from 'react';
import { Link } from 'react-router';
import { Cell, Column, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { Alert } from '../components/Alert';
import { EmptyState } from '../components/EmptyState';
import { Select } from '../components/Select';
import { formatCurrencyShort } from '../lib/format-currency';
import { formatSignedDifference } from '../lib/signed-difference';
import type { ScenarioMcInputs } from '../lib/monte-carlo-scenario-input';
import { useCompareStress, type CompareStressViewed } from '../monte-carlo/use-compare-stress';
import { buildCompareData } from './balance-projection-compare-data';
import {
  CompareDriversSection,
  CompareIdentitySection,
} from './balance-projection-page-compare-drivers';
import { CompareStressRow } from './balance-projection-page-compare-stress';
import {
  CARD_SECTION_CLASS,
  SECTION_H2_CLASS,
} from './balance-projection-page-constants';
import {
  tableClass,
  tdClass,
  tdNumClass,
  thClass,
  thNumClass,
} from './accounts-page-chrome';
import {
  useBalanceProjectionCompare,
  type UseBalanceProjectionCompareInput,
} from './use-balance-projection-compare';

const HEADING_ID = 'balance-projection-compare-heading';
const SELECT_ID = 'balance-projection-compare-with';

const BASIS_SENTENCE =
  "Compare always uses the Planned projection (your entered growth rates, with " +
  "no market ups and downs) in today's dollars, so the Basis and Today's/Future " +
  'dollars controls above do not apply here.';

const HeadlineHeader: React.FC<{ name: string; horizonYear: number | null }> = ({
  name,
  horizonYear,
}) => (
  <>
    <span className="block normal-case tracking-normal">{name}</span>
    {horizonYear !== null && <span className="block">Horizon {horizonYear}</span>}
  </>
);

const HeadlineTable: React.FC<{
  readonly viewedName: string;
  readonly comparisonName: string;
  readonly compare: ReturnType<typeof buildCompareData>;
}> = ({ viewedName, comparisonName, compare }) => {
  const { viewed, comparison } = compare;
  const money = (value: number | null): string =>
    value === null ? '—' : formatCurrencyShort(value);
  const runOut = (year: number | null): string => (year === null ? 'Never' : String(year));
  return (
    <>
      <Table
        className={tableClass}
        aria-label={`Headline comparison of ${viewedName} and ${comparisonName}`}
      >
        <TableHeader>
          <Column isRowHeader className={thClass}>
            Measure
          </Column>
          <Column className={thNumClass}>
            <HeadlineHeader name={viewedName} horizonYear={viewed.horizonYear} />
          </Column>
          <Column className={thNumClass}>
            <HeadlineHeader name={comparisonName} horizonYear={comparison.horizonYear} />
          </Column>
          <Column className={thNumClass}>Difference</Column>
        </TableHeader>
        <TableBody>
          <Row id="ending-balance">
            <Cell className={tdClass}>Ending balance at the horizon</Cell>
            <Cell className={tdNumClass}>{money(viewed.endingBalance)}</Cell>
            <Cell className={tdNumClass}>{money(comparison.endingBalance)}</Cell>
            <Cell className={tdNumClass}>
              {formatSignedDifference('money', viewed.endingBalance, comparison.endingBalance)}
            </Cell>
          </Row>
          <Row id="run-out-year">
            <Cell className={tdClass}>Year money runs out</Cell>
            <Cell className={tdNumClass}>{runOut(viewed.runOutYear)}</Cell>
            <Cell className={tdNumClass}>{runOut(comparison.runOutYear)}</Cell>
            <Cell className={tdNumClass}>
              {formatSignedDifference('runOutYear', viewed.runOutYear, comparison.runOutYear)}
            </Cell>
          </Row>
        </TableBody>
      </Table>
      <p className="m-0 text-sm text-muted">
        Each scenario&rsquo;s ending balance is measured at its own horizon, the
        last year of its plan. The difference is {viewedName} minus {comparisonName}.
      </p>
    </>
  );
};

export const BalanceProjectionCompareSection: React.FC<
  UseBalanceProjectionCompareInput & {
    /** The page's own stress-test view model: the viewed side's result. */
    readonly stressVm: CompareStressViewed;
  }
> = ({ stressVm, ...props }) => {
  const { data, dataLoad } = props;
  const {
    options,
    comparisonId,
    comparisonName,
    status,
    comparison,
    errorMessage,
    choose,
  } = useBalanceProjectionCompare(props);
  const viewedName =
    data.scenarios.find((s) => s.id === data.selectedScenarioId)?.payload.name ??
    'this scenario';
  const {
    scenarios,
    members,
    accounts,
    balances,
    expenses,
    expenseCategories,
    incomeStreams,
    ssBenefits,
  } = dataLoad;
  // Categories included, or the cache key differs from the one the page writes.
  const mcInputs = useMemo<ScenarioMcInputs>(
    () => ({
      members,
      accounts,
      balances,
      expenses,
      incomeStreams,
      ssBenefits,
      categories: expenseCategories,
    }),
    [members, accounts, balances, expenses, incomeStreams, ssBenefits, expenseCategories],
  );
  const stress = useCompareStress({
    viewed: stressVm,
    viewedScenarioId: data.selectedScenarioId,
    comparisonId,
    scenarios,
    inputs: mcInputs,
    nowYear: props.nowYear,
    nowMonthIndex: props.nowMonthIndex,
    isActive: props.isActive,
  });
  const compare = useMemo(
    () =>
      comparison
        ? buildCompareData({
            viewed: data,
            comparison,
            stressCacheKeys: stress.cacheKeys ?? { viewed: null, comparison: null },
          })
        : null,
    [data, comparison, stress.cacheKeys],
  );
  const name = comparisonName ?? 'the other scenario';
  // A hidden panel announces nothing: the run starts when the tab is selected.
  const busy = status === 'pending' && props.isActive;

  let body: React.ReactNode = null;
  if (options.length === 0) {
    body = (
      <EmptyState
        bare
        action={
          <Link to="/scenarios" className="underline">
            Go to Scenarios
          </Link>
        }
      >
        There&rsquo;s nothing to compare with yet. This is your only scenario;
        add another to see how the two differ.
      </EmptyState>
    );
  } else if (status === 'none') {
    body = (
      <p className="m-0 text-muted">
        Choose a scenario above to compare with {viewedName}.
      </p>
    );
  } else if (status === 'unprojectable') {
    body = (
      <EmptyState
        bare
        action={
          <Link to={`/scenarios/${comparisonId}`} className="underline">
            Configure {name}
          </Link>
        }
      >
        {name} can&rsquo;t be projected yet because it has no retirement age to
        project from. Configure it, then come back to compare.
      </EmptyState>
    );
  } else if (status === 'unavailable') {
    body = (
      <EmptyState
        bare
        action={
          <Link to={`/scenarios/${comparisonId}`} className="underline">
            Review {name}
          </Link>
        }
      >
        There&rsquo;s no Planned projection to compare for {viewedName} and {name}{' '}
        with their current settings, for example because a pension election
        isn&rsquo;t set up yet. Check both scenarios&rsquo; settings, then come
        back to compare.
      </EmptyState>
    );
  } else if (status === 'error') {
    body = (
      <Alert tone="error" className="mb-0">
        Couldn&rsquo;t project {name} to compare. {errorMessage}
      </Alert>
    );
  }

  return (
    <section aria-labelledby={HEADING_ID} className={CARD_SECTION_CLASS}>
      <h2 id={HEADING_ID} className={SECTION_H2_CLASS}>
        Compare scenarios
      </h2>
      {options.length > 0 && (
        <div className="flex items-center gap-2">
          <label htmlFor={SELECT_ID} className="text-sm text-muted">
            Compare with
          </label>
          <Select
            id={SELECT_ID}
            className="w-auto min-w-56"
            value={comparisonId ?? ''}
            onChange={choose}
            options={[...options]}
            placeholder="Choose a scenario"
          />
        </div>
      )}
      <p className="m-0 text-sm text-muted">{BASIS_SENTENCE}</p>
      {body}
      {(busy || status === 'ready') && (
        <div aria-busy={busy ? true : undefined}>
          {busy && (
            <p role="status" className="m-0 text-muted">
              Projecting {name}&hellip;
            </p>
          )}
          {compare && (
            <div className="flex flex-col gap-6">
              {compare.identity.planned ? (
                <CompareIdentitySection
                  viewedName={viewedName}
                  comparisonName={name}
                  changes={compare.changes}
                  stressMatches={compare.identity.stress === true}
                />
              ) : (
                <HeadlineTable
                  viewedName={viewedName}
                  comparisonName={name}
                  compare={compare}
                />
              )}
              {/* Hidden until the keys are known, so a fully identical pair never flashes the row. */}
              {stress.cacheKeys !== null &&
                !(compare.identity.planned && compare.identity.stress === true) && (
                <CompareStressRow
                  viewedName={viewedName}
                  comparisonName={name}
                  stress={stress}
                />
              )}
              {!compare.identity.planned && (
                <CompareDriversSection
                  viewedName={viewedName}
                  comparisonName={name}
                  compare={compare}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
