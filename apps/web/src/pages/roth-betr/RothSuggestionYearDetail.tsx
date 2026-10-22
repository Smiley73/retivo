/** Year-by-year table for one plan of the comparison, in each year's own dollars. */
import React, { useMemo } from 'react';
import { Cell, Column, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { TableScroll } from '../../components/TableScroll';
import type { YearDetailRow } from '../../lib/roth-suggestion/year-detail-types';
import {
  tableClass,
  tdClass,
  tdNumClass,
  thStickyClass,
  thStickyNumClass,
} from '../accounts-page-chrome';
import { toYearDetailView, type YearDetailView } from './roth-suggestion-year-detail-view';

interface RothSuggestionYearDetailProps {
  /** Id the row's toggle points at with `aria-controls`. */
  readonly id: string;
  /** Names the plan, bracket and cliffs included. */
  readonly label: string;
  readonly rows: readonly YearDetailRow[];
  /** Escape inside the detail closes it. */
  readonly onClose: () => void;
}

const DEFINITIONS: readonly (readonly [string, string])[] = [
  ['Converted', 'the amount moved to the Roth IRA that year.'],
  [
    'Stopped by',
    'what held the amount where it was: the bracket top, the Medicare surcharge (IRMAA) ' +
      'line, the health-subsidy (ACA) line, the end of the window, withdrawals that had ' +
      'already reached the ceiling, or no pre-tax money left to convert.',
  ],
  [
    'Bracket, Medicare surcharge and Health-subsidy lines',
    'the three limits on the same income line, in dollars. The plan stays at or under the ' +
      'lowest one that applies to the year; "Not applied" means that line does not limit this plan ' +
      'in this year.',
  ],
  [
    'Income before conversion',
    'the year’s income on that line with no conversion: the projection’s own figure for the ' +
      'same year with the conversion left out.',
  ],
  [
    'Extra Social Security taxed',
    'the Social Security the conversion pulled into taxable income that was not taxed without it.',
  ],
  [
    'Income from paying the tax',
    'taxable income from the extra withdrawals that pay the conversion’s own tax, which the ' +
      'year’s income carries on top of the income before, the conversion and the extra Social Security.',
  ],
  [
    'Kept under the limit',
    'the limit less the income after the conversion, which includes the income from paying the ' +
      'tax. In a year a limit stopped it is the few dollars the search leaves under that limit; ' +
      'in any other year it is the room the plan did not use, and negative where income was ' +
      'already over the limit. The check: limit − income before − extra Social Security taxed − ' +
      'income from paying the tax − kept under the limit = converted.',
  ],
  [
    'Spending withdrawals',
    'whether the ceiling moved spending withdrawals to a later account, or could not be held ' +
      'because no other money was left.',
  ],
  ['Income tax', 'federal income tax for the year.'],
  ['Taxable Social Security', 'the part of Social Security in taxable income, and the tier that set it.'],
  [
    'Surcharge paid and Surcharge it sets',
    'the Medicare surcharge paid that year, and the one the year’s income sets two years later.',
  ],
  [
    'ACA credit',
    'the health-insurance premium credit kept that year. The projection credits it only up to the ' +
      'year’s federal tax plus the Medicare surcharge it offsets, so it can be less than the credit ' +
      'on paper.',
  ],
  [
    'Next dollars over the cliff',
    'on a year a cliff stopped, what converting the extra room the plan without that cliff ' +
      'would have used would have cost. The credit lost is at full value, before that clip, so the ' +
      'row of the plan that crosses can show a smaller loss.',
  ],
];

const YearCells: React.FC<{ view: YearDetailView }> = ({ view }) => (
  <>
    <Cell className={tdClass}>{view.filing}</Cell>
    <Cell className={tdNumClass}>{view.amount}</Cell>
    <Cell className={tdClass}>
      <span>{view.stoppedBy}</span>
      {view.crossing !== null && (
        <span className="mt-1 block text-xs text-muted">
          {view.crossing.intro} {view.crossing.medicare}. {view.crossing.credit}.
        </span>
      )}
    </Cell>
    <Cell className={tdNumClass}>{view.bracketLine}</Cell>
    <Cell className={tdNumClass}>{view.medicareLine}</Cell>
    <Cell className={tdNumClass}>{view.creditLine}</Cell>
    <Cell className={tdNumClass}>{view.limit}</Cell>
    <Cell className={tdNumClass}>{view.incomeBefore}</Cell>
    <Cell className={tdNumClass}>{view.extraSs}</Cell>
    <Cell className={tdNumClass}>{view.taxPaymentIncome}</Cell>
    <Cell className={tdNumClass}>{view.keptUnder}</Cell>
    <Cell className={tdClass}>{view.withdrawals}</Cell>
    <Cell className={tdNumClass}>{view.incomeTax}</Cell>
    <Cell className={tdNumClass}>{view.taxableSs}</Cell>
    <Cell className={tdNumClass}>{view.surchargePaid}</Cell>
    <Cell className={tdNumClass}>{view.surchargeSet}</Cell>
    <Cell className={tdNumClass}>{view.credit}</Cell>
    <Cell className={tdNumClass}>{view.preTaxEnd}</Cell>
  </>
);

export const RothSuggestionYearDetail: React.FC<RothSuggestionYearDetailProps> = ({
  id,
  label,
  rows,
  onClose,
}) => {
  const views = useMemo(() => rows.map(toYearDetailView), [rows]);
  const tableLabel = `Year by year: ${label}`;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="mt-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <h3 id={`${id}-heading`} className="mb-1 text-base font-semibold text-ink">
        {tableLabel}
      </h3>
      <p className="mb-2 mt-0 max-w-prose text-sm text-muted">
        Each year is in that year&rsquo;s own dollars, because the limits and cliffs are fixed
        amounts for the year. The comparison above is in today&rsquo;s dollars, so its totals will
        not match these figures one for one.
      </p>
      <TableScroll label={tableLabel}>
        <Table aria-label={tableLabel} className={tableClass}>
          <TableHeader>
            <Column isRowHeader className={thStickyClass}>Year</Column>
            <Column className={thStickyClass}>Filing</Column>
            <Column className={thStickyNumClass}>Converted</Column>
            <Column className={thStickyClass}>Stopped by</Column>
            <Column className={thStickyNumClass}>Bracket line</Column>
            <Column className={thStickyNumClass}>Medicare surcharge line</Column>
            <Column className={thStickyNumClass}>Health-subsidy line</Column>
            <Column className={thStickyNumClass}>Limit</Column>
            <Column className={thStickyNumClass}>Income before conversion</Column>
            <Column className={thStickyNumClass}>Extra Social Security taxed</Column>
            <Column className={thStickyNumClass}>Income from paying the tax</Column>
            <Column className={thStickyNumClass}>Kept under the limit</Column>
            <Column className={thStickyClass}>Spending withdrawals</Column>
            <Column className={thStickyNumClass}>Income tax</Column>
            <Column className={thStickyNumClass}>Taxable Social Security</Column>
            <Column className={thStickyNumClass}>Surcharge paid</Column>
            <Column className={thStickyNumClass}>Surcharge it sets</Column>
            <Column className={thStickyNumClass}>ACA credit</Column>
            <Column className={thStickyNumClass}>Pre-tax at year end</Column>
          </TableHeader>
          <TableBody>
            {views.map((view) => (
              <Row key={view.year} id={view.year}>
                <Cell className={tdNumClass}>{view.year}</Cell>
                <YearCells view={view} />
              </Row>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      <dl className="mt-3 space-y-1 text-xs text-muted">
        {DEFINITIONS.map(([term, text]) => (
          <div key={term}>
            <dt className="inline font-medium text-ink">{term}</dt>{' '}
            <dd className="inline">— {text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};
