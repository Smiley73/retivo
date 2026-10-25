/** Shared class strings and small components for the accounts, balances and contributions pages. */
import React from 'react';
import { Column, TableHeader } from 'react-aria-components';
import { inputClass } from '../components/dialog-chrome';
import { Field } from '../components/Field';
import { CheckIcon } from '../components/icons';
import { Muted } from '../components/Muted';
import { formatPercent } from '../components/PercentInput';
import { TextInput } from '../components/TextInput';
import type { AccountBucket } from '../lib/account-bucket';

export {
  btnPrimaryClass,
  btnSecondaryClass,
  btnDangerClass,
  btnSecondarySmClass,
  inputClass,
} from '../components/dialog-chrome';
export {
  SolidPencilIcon as PencilIcon,
  SolidTrashIcon as TrashIcon,
  SolidEyeIcon as EyeIcon,
} from '../components/icons';

/**
 * Standalone class string (not concatenated with a size class) so a toolbar button matches the 34px height of an adjacent
 * `<SegmentedRadioGroup>`. Tailwind v4 emits same-specificity utilities in source order, so a concatenated `px-3 py-1`
 * loses to `px-4 py-2` whatever the className order. See "Buttons and destructive actions" in docs/ui-conventions.md.
 */
export const btnPrimaryToolbarClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-transparent bg-accent px-3 py-2 text-xs text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const btnDangerToolbarClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-transparent bg-negative px-3 py-2 text-xs text-surface shadow-sm ' +
  'transition-colors hover:bg-negative/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const btnPrimarySmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-accent px-2.5 py-1 text-xs text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const btnDangerSmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-negative px-2.5 py-1 text-xs text-surface shadow-sm ' +
  'transition-colors hover:bg-negative/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const inputNumericClass = `${inputClass} font-mono tabular-nums`;

export const tableClass =
  'w-full border-collapse text-left text-sm text-ink';

export const thClass =
  'border-b border-line px-3 py-2 font-mono text-xs font-medium ' +
  'uppercase tracking-wide text-muted';

export const tdClass = 'border-b border-line px-3 py-2';

export const tdNumClass = `${tdClass} text-right font-mono tabular-nums`;

export const thNumClass = `${thClass} text-right`;

export const bandSectionH2Class =
  'm-0 text-base font-semibold text-ink';

export const thStickyClass = `${thClass} sticky top-0 z-10 bg-surface-sunken`;
export const thStickyNumClass = `${thNumClass} sticky top-0 z-10 bg-surface-sunken`;
export const rowStickyBottomClass = 'sticky bottom-0 z-10 bg-surface-raised';

export const rowTotalsClass = 'bg-surface-sunken font-semibold';

export const inactiveRowCellClass = 'text-muted';

const stripeRowClass = 'bg-surface-sunken';

export const stripeRowFor = (index: number): string =>
  index % 2 === 1 ? stripeRowClass : 'bg-surface-raised';

export const valuePositiveClass = 'text-positive';

export const valueNegativeClass = 'text-negative';

export const breadcrumbNavClass =
  'mb-1 text-sm text-muted ' +
  '[&_a]:text-accent-link [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:no-underline ' +
  '[&_a]:rounded-sm [&_a]:focus-visible:outline-none [&_a]:focus-visible:ring-2 ' +
  '[&_a]:focus-visible:ring-ring [&_a]:focus-visible:ring-offset-2';

const BUCKET_BAR_BG: Record<AccountBucket, string> = {
  pretax: 'bg-pretax',
  roth: 'bg-roth',
  taxable: 'bg-taxable',
  cash: 'bg-cash',
  tax_free: 'bg-tax_free',
};

/** Decorative bucket bar, `aria-hidden` because the type chip carries the meaning; the host `<Cell>` must be `relative`. */
export const BucketBar: React.FC<{ bucket: AccountBucket }> = ({ bucket }) => (
  <span
    aria-hidden="true"
    // eslint-disable-next-line no-restricted-syntax -- exact mock .bucket-bar geometry (3px bar, 6px inset, pill radius) has no nearest-token equivalent
    className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full ${BUCKET_BAR_BG[bucket]}`}
  />
);

const iactClass =
  'inline-grid size-8 place-items-center rounded-lg ' +
  'border border-line bg-surface ' +
  'transition-colors focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export const iactViewClass = `${iactClass} text-muted hover:border-line-strong hover:bg-surface-sunken hover:text-ink`;

export const iactEditClass = `${iactClass} text-positive hover:border-positive/40 hover:bg-positive/10`;

export const iactDeleteClass = `${iactClass} text-negative hover:border-negative/40 hover:bg-negative/10`;

/** Relabels a negative remaining to "… Overpaid" with its absolute amount. */
export const remainingLabel = (prefix: string, v: number): string =>
  v < 0 ? `${prefix} Overpaid` : `${prefix} Remaining`;

export const remainingText = (
  v: number,
  formatCurrency: (n: number) => string,
): string => (v < 0 ? formatCurrency(Math.abs(v)) : formatCurrency(v));

const stackedHeader = (group: string, leaf: string): React.ReactNode => (
  <>
    <span className="block font-normal">{group}</span>
    {/* Whitespace node keeps the accessible name "Remaining Pre-tax"; adjacent spans would concatenate. */}
    {' '}
    <span className="block">{leaf}</span>
  </>
);

/** Single header row for the Annual Contributions table; the "Remaining" group lives in each leaf's compound accessible name. */
export const ContributionsTableHead: React.FC = () => {
  const head = `${thStickyClass} align-bottom`;
  const headNum = `${thStickyNumClass} align-bottom`;
  const headCentered = `${thStickyClass} align-bottom text-center`;
  return (
    <TableHeader>
      <Column isRowHeader className={head}>
        Name
      </Column>
      <Column className={head}>Owner</Column>
      <Column className={head}>Type</Column>
      <Column className={headCentered}>Pre-Tax</Column>
      <Column className={headCentered}>Post-Tax</Column>
      <Column className={headCentered} textValue="Annual increase">
        {stackedHeader('Annual', 'increase')}
      </Column>
      <Column className={headNum} textValue="Remaining Pre-tax">
        {stackedHeader('Remaining', 'Pre-tax')}
      </Column>
      <Column className={headNum} textValue="Remaining Post-tax">
        {stackedHeader('Remaining', 'Post-tax')}
      </Column>
      <Column className={headNum} textValue="Remaining Total">
        {stackedHeader('Remaining', 'Total')}
      </Column>
    </TableHeader>
  );
};

type MixKey = 'assetMixStocks' | 'assetMixBonds' | 'assetMixCash';
const MIX_FIELDS: ReadonlyArray<{ label: string; key: MixKey }> = [
  { label: 'Stocks', key: 'assetMixStocks' },
  { label: 'Bonds', key: 'assetMixBonds' },
  { label: 'Cash', key: 'assetMixCash' },
];

interface AssetMixFieldGroupProps {
  values: Record<MixKey, string>;
  onFieldChange: (key: MixKey, raw: string) => void;
  onFieldBlur: (key: MixKey) => void;
  mixSum: number;
  isMixValid: boolean;
}

/** The account form's asset-allocation field group: a `role="group"`, not a `<fieldset>`. */
export const AssetMixFieldGroup: React.FC<AssetMixFieldGroupProps> = ({
  values,
  onFieldChange,
  onFieldBlur,
  mixSum,
  isMixValid,
}) => (
  <div
    role="group"
    aria-labelledby="asset-mix-heading"
    className="mb-3 flex flex-col gap-2 rounded-md border border-line bg-surface-sunken p-3"
  >
    <header
      id="asset-mix-heading"
      className="text-sm font-semibold text-ink"
    >
      Asset allocation
    </header>
    <Muted as="p" className="text-sm">
      Drives the Monte Carlo projection. Must sum to 100%.
    </Muted>
    <div className="flex flex-wrap items-start gap-3">
      {MIX_FIELDS.map(({ label, key }) => (
        <Field
          key={label}
          htmlFor={`mix-${label}`}
          label={`${label} %`}
          className="min-w-28"
        >
          <TextInput
            id={`mix-${label}`}
            inputMode="decimal"
            pattern="[0-9]*[.,]?[0-9]*"
            value={values[key]}
            onChange={(e) => onFieldChange(key, e.target.value)}
            onBlur={() => onFieldBlur(key)}
            className={inputNumericClass}
          />
        </Field>
      ))}
    </div>
    <div
      className={
        isMixValid
          ? 'text-sm text-muted'
          : 'text-sm text-negative'
      }
    >
      Total: {formatPercent(mixSum)}{' '}
      {isMixValid ? (
        <span className="inline-flex items-center gap-1 text-positive">
          <CheckIcon />
          Valid
        </span>
      ) : (
        'must equal 100%'
      )}
    </div>
  </div>
);
