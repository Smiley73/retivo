/**
 * The annual-balance add/edit dialog, extracted from `AccountBalancesPage`
 * so that already-oversized page shrinks rather than grows. Pure
 * presentational shell: all state + the save/close behavior (dirty-guard,
 * `MoneyInput` parsing, `Modal` centering/width/Enter) stays owned by the
 * page and is threaded in via props; the markup uses Tailwind defaults.
 */
import React from 'react';
import { Modal } from '../components/Modal';
import { TextInput } from '../components/TextInput';
import { Alert } from '../components/Alert';
import { MoneyInput } from '../components/MoneyInput';
import { NotesField } from '../components/NotesField';
import { DatePicker } from '../components/DatePicker';
import { btnPrimaryClass, btnSecondaryClass } from './accounts-page-chrome';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';

const FIELD_LABEL_CLASS =
  'mb-1 block text-sm font-medium text-ink';
// Mock `add-year`/`edit-year` `.form-grid`: two equal columns
// (`1fr 1fr`, ~18px row / ~22px col gap). Each field already carries its
// own `mb-3`, so a light `gap-y-1` keeps the row rhythm consistent.
const FIELD_GRID_CLASS =
  'mb-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2';
/** The dated-Roth pairs only. Their labels are long enough that one wraps to two
 *  lines while its partner does not, which left the two inputs sitting at
 *  different heights. Bottom-aligning the row pins the CONTROLS to a common
 *  baseline and lets the taller label grow upward instead. */
const ROTH_FIELD_GRID_CLASS = `${FIELD_GRID_CLASS} sm:items-end`;
/** Totals rail: the three roll-up tiles sit in their own right-hand column on a
 *  wide screen, stacked, instead of a full-width three-across band under the
 *  amount fields — that band was the single biggest contributor to the dialog's
 *  height. Below `lg` the rail falls back to a normal row. */
const TOTALS_SPLIT_CLASS =
  'lg:grid lg:grid-cols-3 lg:items-start lg:gap-x-6';
/** ONE bordered panel of three divided rows, not three separate tiles. Three
 *  floating tiles left an obvious block of dead space beneath them in the rail;
 *  a single block reads as a deliberate summary rather than an unfinished
 *  column. Below `lg` it becomes a normal three-across row under the fields, so
 *  the dividers switch axis with it. */
const TOTALS_RAIL_CLASS =
  'mb-4 grid grid-cols-1 divide-y divide-line rounded-xl border border-line ' +
  'bg-surface-raised sm:grid-cols-3 sm:divide-x sm:divide-y-0 ' +
  'lg:mb-0 lg:mt-6 lg:grid-cols-1 lg:divide-x-0 lg:divide-y';
// `lg:mt-6` above drops the panel by exactly one field-label box so its top edge
// meets the top of the first INPUT on the left rather than the label above it:
// FIELD_LABEL_CLASS is `text-sm` (20px line box) + `mb-1` (4px) = 24px = mt-6.
// Keep the two in sync if that label's type scale ever changes.

const TOTAL_ROW_CLASS = 'px-4 py-3';
const TOTAL_LABEL_CLASS =
  'font-mono text-xs font-semibold uppercase tracking-wide text-muted';
const TOTAL_VALUE_CLASS =
  'mt-1 font-mono text-xl font-bold tabular-nums text-ink';
// Control boundary uses the dedicated `input-line` token — AA-safe
// non-text (1.4.11 ≥ 3.0) in both themes via the `.dark` variable swap;
// the pair is checked in `lib/contrast.ts`.
const INPUT_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

/** Mirror of the page's BalanceFormState (kept structural to avoid a
 *  cross-file type export churn — the page owns the canonical type). */
interface BalanceModalFormState {
  year: number;
  lastUpdated: string;
  startingBalance: number;
  startingBalancePreTax: number;
  startingBalancePostTax: number;
  personalContributions: number;
  companyContributions: number;
  contributionsPreTax: number;
  contributionsPostTax: number;
  companyContributionsPreTax: number;
  companyContributionsPostTax: number;
  rollover: number;
  distributions: number;
  endingBalance: number;
  endingBalancePreTax: number;
  endingBalancePostTax: number;
  comment: string;
  rothConversionTaxable: number;
  rothInPlanRolloverTaxable: number;
  rothConversionNontaxable: number;
  rothInPlanRolloverNontaxable: number;
}

interface BalanceEntryModalProps {
  open: boolean;
  isEdit: boolean;
  isMixed: boolean;
  saving: boolean;
  formError: string | null;
  form: BalanceModalFormState;
  setForm: React.Dispatch<React.SetStateAction<BalanceModalFormState>>;
  yearLocked: boolean;
  /** Roth IRA only — the per-year conversion amounts are tax history for the
   *  §408A ordering rules, so they are offered only where that ordering can
   *  apply. */
  showRothConversion: boolean;
  /** Designated-Roth employer plans only — the per-year IN-PLAN ROLLOVER amounts,
   *  the §402A(c)(4) equivalent of a conversion. Mutually exclusive with
   *  `showRothConversion` in practice: no account type is both. */
  showRothInPlanRollover: boolean;
  onClose: () => void;
  onCancel: () => void;
  onSave: () => void;
  getDefaultLastUpdated: (year: number) => string;
}

export const BalanceEntryModal: React.FC<BalanceEntryModalProps> = ({
  open,
  isEdit,
  isMixed,
  saving,
  formError,
  form,
  setForm,
  yearLocked,
  showRothConversion,
  showRothInPlanRollover,
  onClose,
  onCancel,
  onSave,
  getDefaultLastUpdated,
}) => {
  // The three roll-up totals, resolved once. The MIXED layout sums its split
  // pre/post-tax pairs; every other type reads the single-column fields. They
  // used to be computed inline in each branch beside an identical StatGrid.
  const totalStarting = isMixed
    ? form.startingBalancePreTax + form.startingBalancePostTax
    : form.startingBalance;
  const totalContributions = isMixed
    ? form.contributionsPreTax +
      form.contributionsPostTax +
      form.companyContributionsPreTax +
      form.companyContributionsPostTax
    : form.personalContributions + form.companyContributions;
  const totalEnding = isMixed
    ? form.endingBalancePreTax + form.endingBalancePostTax
    : form.endingBalance;
  return (
  // Panel width: the totals now sit in their own right-hand rail, so the panel
  // has to carry that column on top of the field grid. The wider step is for the
  // MIXED split columns and the dated-Roth pairs, whose labels are long.
  <Modal
    open={open}
    onClose={onClose}
    title={`${isEdit ? 'Edit' : 'Add'} Balance Entry`}
    size={isMixed || showRothConversion || showRothInPlanRollover ? '4xl' : '3xl'}
    onEnter={() => !saving && onSave()}
  >
    {formError && <Alert tone="error">{formError}</Alert>}
    <div className={TOTALS_SPLIT_CLASS}>
    <div className="min-w-0 lg:col-span-2">
    <div className={FIELD_GRID_CLASS}>
      <div className="mb-3 min-w-0">
        <label htmlFor="balance-year" className={FIELD_LABEL_CLASS}>
          Year
        </label>
        <TextInput
          id="balance-year"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={String(form.year)}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '');
            if (digits === '') return;
            const year = parseInt(digits, 10);
            setForm((f) => ({
              ...f,
              year,
              lastUpdated: f.lastUpdated || getDefaultLastUpdated(year),
            }));
          }}
          disabled={yearLocked}
          className={INPUT_CLASS}
        />
      </div>
      <div className="mb-3 min-w-0">
        <label htmlFor="balance-last-updated" className={FIELD_LABEL_CLASS}>
          Balance as of
        </label>
        <DatePicker
          id="balance-last-updated"
          ariaLabel="Balance as of"
          max={new Date().toISOString().slice(0, 10)}
          value={form.lastUpdated ? form.lastUpdated.slice(0, 10) : ''}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              lastUpdated: v ? `${v}T23:59:59Z` : '',
            }))
          }
        />
      </div>
    </div>

    {isMixed ? (
      <div className="mb-3">
        <div className={FIELD_GRID_CLASS}>
          <MoneyInput
            id="balance-starting-pre"
            label="Starting Balance (Pre-Tax)"
            value={form.startingBalancePreTax}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                startingBalancePreTax: v,
                startingBalance: v + f.startingBalancePostTax,
              }))
            }
          />
          <MoneyInput
            id="balance-starting-post"
            label="Starting Balance (Post-Tax)"
            value={form.startingBalancePostTax}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                startingBalancePostTax: v,
                startingBalance: f.startingBalancePreTax + v,
              }))
            }
          />
          <MoneyInput
            id="balance-contributions-pre"
            label="Contributions (Pre-Tax)"
            value={form.contributionsPreTax}
            onChange={(v) => setForm((f) => ({ ...f, contributionsPreTax: v }))}
          />
          <MoneyInput
            id="balance-contributions-post"
            label="Contributions (Post-Tax)"
            value={form.contributionsPostTax}
            onChange={(v) => setForm((f) => ({ ...f, contributionsPostTax: v }))}
          />
          <MoneyInput
            id="balance-company-contributions-pre"
            label="Company Contributions (Pre-Tax)"
            value={form.companyContributionsPreTax}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                companyContributionsPreTax: v,
                companyContributions: v + f.companyContributionsPostTax,
              }))
            }
          />
          <MoneyInput
            id="balance-company-contributions-post"
            label="Company Contributions (Post-Tax)"
            value={form.companyContributionsPostTax}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                companyContributionsPostTax: v,
                companyContributions: f.companyContributionsPreTax + v,
              }))
            }
          />
          <MoneyInput
            id="balance-ending-pre"
            label="Ending Balance (Pre-Tax)"
            value={form.endingBalancePreTax}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                endingBalancePreTax: v,
                endingBalance: v + f.endingBalancePostTax,
              }))
            }
          />
          <MoneyInput
            id="balance-ending-post"
            label="Ending Balance (Post-Tax)"
            value={form.endingBalancePostTax}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                endingBalancePostTax: v,
                endingBalance: f.endingBalancePreTax + v,
              }))
            }
          />
          <MoneyInput
            id="balance-rollover"
            label="Rollover"
            value={form.rollover}
            onChange={(v) => setForm((f) => ({ ...f, rollover: v }))}
          />
          <MoneyInput
            id="balance-distributions"
            label="Distributions"
            value={form.distributions}
            onChange={(v) =>
              setForm((f) => ({ ...f, distributions: Math.max(0, v) }))
            }
          />
        </div>
      </div>
    ) : (
      <>
        <div className={FIELD_GRID_CLASS}>
          <MoneyInput
            id="balance-starting"
            label="Starting Balance"
            value={form.startingBalance}
            onChange={(v) => setForm((f) => ({ ...f, startingBalance: v }))}
          />
          <MoneyInput
            id="balance-personal-contributions"
            label="Personal Contributions"
            value={form.personalContributions}
            onChange={(v) =>
              setForm((f) => ({ ...f, personalContributions: v }))
            }
          />
          <MoneyInput
            id="balance-company-contributions"
            label="Company Contributions"
            value={form.companyContributions}
            onChange={(v) =>
              setForm((f) => ({ ...f, companyContributions: v }))
            }
          />
          <MoneyInput
            id="balance-ending"
            label="Ending Balance"
            value={form.endingBalance}
            onChange={(v) => setForm((f) => ({ ...f, endingBalance: v }))}
          />
          <MoneyInput
            id="balance-rollover"
            label="Rollover"
            value={form.rollover}
            onChange={(v) => setForm((f) => ({ ...f, rollover: v }))}
          />
          <MoneyInput
            id="balance-distributions"
            label="Distributions"
            value={form.distributions}
            onChange={(v) =>
              setForm((f) => ({ ...f, distributions: Math.max(0, v) }))
            }
          />
        </div>
      </>
    )}

    {showRothInPlanRollover && (
      <div className={ROTH_FIELD_GRID_CLASS}>
        <MoneyInput
          id="balance-roth-rollover-taxable"
          label="Roth Conversion (taxable)"
          allowNegative={false}
          value={form.rothInPlanRolloverTaxable}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              rothInPlanRolloverTaxable: Math.max(0, v),
            }))
          }
        />
        <MoneyInput
          id="balance-roth-rollover-nontaxable"
          label="Roth Conversion (after-tax)"
          allowNegative={false}
          value={form.rothInPlanRolloverNontaxable}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              rothInPlanRolloverNontaxable: Math.max(0, v),
            }))
          }
        />
      </div>
    )}

    {showRothConversion && (
      <div className={ROTH_FIELD_GRID_CLASS}>
          <MoneyInput
            id="balance-roth-conversion-taxable"
            label="Roth Conversion (taxable)"
            allowNegative={false}
            value={form.rothConversionTaxable}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                rothConversionTaxable: Math.max(0, v),
              }))
            }
          />
          <MoneyInput
            id="balance-roth-conversion-nontaxable"
            label="Roth Conversion (after-tax)"
            allowNegative={false}
            value={form.rothConversionNontaxable}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                rothConversionNontaxable: Math.max(0, v),
              }))
            }
          />
      </div>
    )}

    </div>

    <aside className={TOTALS_RAIL_CLASS} aria-label="Totals for this year">
      <div className={TOTAL_ROW_CLASS}>
        <div className={TOTAL_LABEL_CLASS}>Total Starting</div>
        <div className={TOTAL_VALUE_CLASS}>
          {formatCurrencyShort(totalStarting)}
        </div>
      </div>
      <div className={TOTAL_ROW_CLASS}>
        <div className={TOTAL_LABEL_CLASS}>Total Contributions</div>
        <div className={TOTAL_VALUE_CLASS}>
          {formatCurrency(totalContributions)}
        </div>
      </div>
      <div className={TOTAL_ROW_CLASS}>
        <div className={TOTAL_LABEL_CLASS}>Total Ending</div>
        <div className={TOTAL_VALUE_CLASS}>
          {formatCurrencyShort(totalEnding)}
        </div>
      </div>
    </aside>
    </div>

    <div className="mt-3">
      <NotesField
        id="balance-comment"
        label="Comment (optional)"
        value={form.comment}
        onChange={(v) => setForm((f) => ({ ...f, comment: v }))}
        rows={3}
        placeholder="Notes about this year's balance, e.g. one-time events, reconciliation details"
      />
    </div>

    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={btnPrimaryClass}
        onClick={onSave}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        className={btnSecondaryClass}
        onClick={onCancel}
        disabled={saving}
      >
        Cancel
      </button>
    </div>
  </Modal>
  );
};
