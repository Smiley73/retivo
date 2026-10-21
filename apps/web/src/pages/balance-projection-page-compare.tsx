/**
 * Balance Projection page — the "Compare" tab panel body.
 *
 * Compares the scenario being viewed with one other scenario. Renders only:
 * the selection and the second projection come from
 * `useBalanceProjectionCompare`, and every figure and difference string from
 * `buildCompareData` / `formatSignedDifference`, so nothing here computes,
 * deflates or signs a number. Compare is always the Planned projection in
 * today's dollars, so unlike the sibling tabs the heading carries no
 * `resolvedBasisLabel` suffix and the panel says the header Basis and
 * Today's/Future dollars controls do not apply.
 *
 * Structure (the success-rate block appends below): heading, "Compare with"
 * selector, basis sentence, then one of the states — pick a scenario, nothing
 * to compare with, projecting, cannot be projected, error — or the headline
 * table with the Drivers table under it, or, when the Planned projections are
 * identical, the identical-results sentence in place of both.
 */
import React, { useMemo } from 'react';
import { Link } from 'react-router';
import { Cell, Column, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { Alert } from '../components/Alert';
import { EmptyState } from '../components/EmptyState';
import { Select } from '../components/Select';
import { formatCurrencyShort } from '../lib/format-currency';
import { formatSignedDifference } from '../lib/signed-difference';
import { buildCompareData } from './balance-projection-compare-data';
import {
  CompareDriversSection,
  CompareIdentitySection,
} from './balance-projection-page-compare-drivers';
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

/** The one-sentence basis statement; the header controls do not reach this tab. */
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
  UseBalanceProjectionCompareInput
> = (props) => {
  const { data } = props;
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
  const compare = useMemo(
    () =>
      comparison
        ? buildCompareData({
            viewed: data,
            comparison,
            stressCacheKeys: { viewed: null, comparison: null },
          })
        : null,
    [data, comparison],
  );
  const name = comparisonName ?? 'the other scenario';
  // Queued while another tab is showing is not "projecting": the run starts
  // when the tab is selected, and a hidden panel announces nothing.
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
          {/* Identical Planned results swap the headline and the Drivers table
              for one sentence; anything appended below (the success-rate row)
              sits outside this choice and stays in both states. */}
          {compare &&
            (compare.identity.planned ? (
              <CompareIdentitySection
                viewedName={viewedName}
                comparisonName={name}
                changes={compare.changes}
              />
            ) : (
              <div className="flex flex-col gap-6">
                <HeadlineTable
                  viewedName={viewedName}
                  comparisonName={name}
                  compare={compare}
                />
                <CompareDriversSection
                  viewedName={viewedName}
                  comparisonName={name}
                  compare={compare}
                />
              </div>
            ))}
        </div>
      )}
    </section>
  );
};
