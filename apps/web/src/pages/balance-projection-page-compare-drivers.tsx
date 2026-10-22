/**
 * Balance Projection page — the Compare tab's Drivers table, its note, and the
 * identical-results state. Renders only (`buildCompareData`,
 * `formatSignedDifference`, `buildScenarioChangeList`). No sentence says a row
 * caused or explains the gap, and no difference is coloured: more tax is not
 * a loss, more conversions not a win.
 */
import React from 'react';
import { Cell, Column, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { Muted } from '../components/Muted';
import { TableScroll } from '../components/TableScroll';
import { ACCOUNT_BUCKET_LABEL, type AccountBucket } from '../lib/account-bucket';
import { formatCurrencyShort } from '../lib/format-currency';
import type { ScenarioChangeList } from '../lib/scenario-change-list';
import { formatSignedDifference } from '../lib/signed-difference';
import type { CompareData, CompareDrivers } from './balance-projection-compare-data';
import { tableClass, tdClass, tdNumClass, thClass, thNumClass } from './accounts-page-chrome';

const DRIVERS_NOTE =
  'These are differences between the totals of two complete projections. The ' +
  'model does not apportion the gap among them, and one change usually moves ' +
  'several lines at once, so read each row as a total, not as a share of the gap.';

const BUCKETS = Object.keys(ACCOUNT_BUCKET_LABEL) as AccountBucket[];

interface DriverRow {
  readonly id: string;
  readonly label: string;
  readonly kind: 'money' | 'yearCount';
  readonly viewed: number;
  readonly comparison: number;
  /** Shown even when zero in both scenarios (the Taxes tab's three tiles). */
  readonly always?: boolean;
  /** One-line glossary entry; the years rows share one. */
  readonly define?: string;
}

const YEARS_DEFINITION =
  'a year in which any account of that type withdrew, required minimums and ' +
  'conversion-tax funding included.';

function driverRows(v: CompareDrivers, c: CompareDrivers): DriverRow[] {
  const money = (
    id: keyof Omit<CompareDrivers, 'withdrawalYears'>,
    label: string,
    define: string,
    always = false,
  ): DriverRow => ({ id, label, kind: 'money', viewed: v[id], comparison: c[id], always, define });
  return [
    money(
      'federalTax',
      'Federal income tax',
      'the lifetime total, the same figure as the Taxes tab.',
      true,
    ),
    money(
      'irmaaSurcharge',
      'Medicare surcharges (IRMAA)',
      'the extra Medicare Part B and Part D premiums charged at higher incomes (the income-related monthly adjustment amount).',
      true,
    ),
    money(
      'acaPtcCredit',
      'ACA health credits',
      'the Affordable Care Act premium tax credits received toward Marketplace health insurance, shown as a positive amount.',
      true,
    ),
    money(
      'rothConversions',
      'Roth conversions',
      "money moved from tax-deferred accounts to Roth accounts, in today's dollars. The Taxes tab's Total Roth converted is in each year's own dollars, so the two figures differ.",
    ),
    money(
      'rmds',
      'Required minimum distributions',
      'the yearly amount the IRS requires you to withdraw from tax-deferred accounts once you reach the starting age (RMDs), counted in full.',
    ),
    money(
      'qcds',
      'Qualified charitable distributions (QCD)',
      'gifts sent straight from an IRA to charity (QCDs), which are not taxed and can count toward the RMD.',
    ),
    ...BUCKETS.map((bucket) => ({
      id: `years-${bucket}`,
      label: `Years of withdrawals: ${ACCOUNT_BUCKET_LABEL[bucket]}`,
      kind: 'yearCount' as const,
      viewed: v.withdrawalYears[bucket],
      comparison: c.withdrawalYears[bucket],
    })),
  ];
}

const isZero = (n: number): boolean => Math.round(n) === 0;

/** The sentence naming the longer-running scenario; null when the horizons match. */
function horizonSentence(
  viewed: { name: string; horizonYear: number | null },
  comparison: { name: string; horizonYear: number | null },
): string | null {
  const v = viewed.horizonYear;
  const c = comparison.horizonYear;
  if (v === null || c === null || v === c) return null;
  const [longer, shorter] = v > c ? [viewed, comparison] : [comparison, viewed];
  return (
    `${longer.name} runs longer than ${shorter.name}, to ${longer.horizonYear} ` +
    `instead of ${shorter.horizonYear}, so its lifetime totals cover those extra years.`
  );
}

export const CompareDriversSection: React.FC<{
  readonly viewedName: string;
  readonly comparisonName: string;
  readonly compare: CompareData;
}> = ({ viewedName, comparisonName, compare }) => {
  const { viewed, comparison } = compare;
  if (!viewed.drivers || !comparison.drivers) return null;
  const rows = driverRows(viewed.drivers, comparison.drivers).filter(
    (r) => r.always || !(isZero(r.viewed) && isZero(r.comparison)),
  );
  const glossary = rows.filter((r) => r.define);
  const showYears = rows.some((r) => r.kind === 'yearCount');
  const horizon = horizonSentence(
    { name: viewedName, horizonYear: viewed.horizonYear },
    { name: comparisonName, horizonYear: comparison.horizonYear },
  );
  const label = `Driver totals for ${viewedName} and ${comparisonName}`;
  return (
    <section aria-labelledby="balance-projection-compare-drivers-heading" className="flex flex-col gap-3">
      <h3
        id="balance-projection-compare-drivers-heading"
        className="m-0 text-base font-semibold text-ink"
      >
        Drivers
      </h3>
      <Muted as="p" className="m-0 text-sm">
        Lifetime totals through the last life-expectancy year, in today&rsquo;s
        dollars. Each scenario uses its own inflation rate.
      </Muted>
      <TableScroll label={label}>
        <Table aria-label={label} className={tableClass}>
          <TableHeader>
            <Column isRowHeader className={thClass}>
              Driver
            </Column>
            <Column className={thNumClass}>{viewedName}</Column>
            <Column className={thNumClass}>{comparisonName}</Column>
            <Column className={thNumClass}>Difference</Column>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <Row key={r.id} id={r.id}>
                <Cell className={tdClass}>{r.label}</Cell>
                <Cell className={tdNumClass}>{formatDriver(r.kind, r.viewed)}</Cell>
                <Cell className={tdNumClass}>{formatDriver(r.kind, r.comparison)}</Cell>
                <Cell className={tdNumClass}>
                  {formatSignedDifference(r.kind, r.viewed, r.comparison)}
                </Cell>
              </Row>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      <dl className="m-0 space-y-1 text-xs text-muted">
        {glossary.map((r) => (
          <div key={r.id}>
            <dt className="inline font-medium text-ink">{r.label}</dt>{' '}
            <dd className="inline">&mdash; {r.define}</dd>
          </div>
        ))}
        {showYears && (
          <div>
            <dt className="inline font-medium text-ink">Years of withdrawals</dt>{' '}
            <dd className="inline">&mdash; for each account type, {YEARS_DEFINITION}</dd>
          </div>
        )}
      </dl>
      <Muted as="p" className="m-0 text-sm">
        {DRIVERS_NOTE}
      </Muted>
      {horizon && (
        <Muted as="p" className="m-0 text-sm">
          {horizon}
        </Muted>
      )}
    </section>
  );
};

function formatDriver(kind: DriverRow['kind'], value: number): string {
  return kind === 'money' ? formatCurrencyShort(value) : String(value);
}

/** Replaces the headline and Drivers when the two Planned projections are identical. */
export const CompareIdentitySection: React.FC<{
  readonly viewedName: string;
  readonly comparisonName: string;
  readonly changes: ScenarioChangeList;
  /** The two stress-test inputs are identical as well. */
  readonly stressMatches: boolean;
}> = ({ viewedName, comparisonName, changes, stressMatches }) => {
  const [descendant, ancestor] =
    changes.relation === 'descendant'
      ? [viewedName, comparisonName]
      : [comparisonName, viewedName];
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0">
        The Planned projections of {viewedName} and {comparisonName} are
        identical: every year of both comes out the same, so there is no
        difference to show.{' '}
        {stressMatches
          ? 'Their stress tests use the same inputs too, so they would give the same result.'
          : 'The stress test is checked separately and can still differ.'}
      </p>
      {changes.relation !== 'unrelated' &&
        (changes.groups.length === 0 ? (
          <p className="m-0">
            {descendant} changes nothing from {ancestor}.
          </p>
        ) : (
          <>
            <p className="m-0">
              What {descendant} changes from {ancestor}:
            </p>
            <ul className="m-0 pl-5">
              {changes.groups.map((g) => (
                <li key={g.title}>
                  <span className="font-medium text-ink">{g.title}</span>:{' '}
                  {g.changes.map((c) => c.card).join(', ')}
                </li>
              ))}
            </ul>
          </>
        ))}
    </div>
  );
};
