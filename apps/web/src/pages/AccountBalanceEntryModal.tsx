/** The annual-balance add/edit dialog: a presentational shell whose state, save and close behavior (dirty guard, MoneyInput parsing) the page owns and threads in via props. */
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
const FIELD_GRID_CLASS =
  'mb-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2';
// Bottom-aligns the dated-Roth pairs: one label wraps to two lines while its partner does not, so a common control baseline lets the taller label grow upward.
const ROTH_FIELD_GRID_CLASS = `${FIELD_GRID_CLASS} sm:items-end`;
const TOTALS_SPLIT_CLASS =
  'lg:grid lg:grid-cols-3 lg:items-start lg:gap-x-6';
const TOTALS_RAIL_CLASS =
  'mb-4 grid grid-cols-1 divide-y divide-line rounded-xl border border-line ' +
  'bg-surface-raised sm:grid-cols-3 sm:divide-x sm:divide-y-0 ' +
  'lg:mb-0 lg:mt-6 lg:grid-cols-1 lg:divide-x-0 lg:divide-y';
// lg:mt-6 drops the panel by one field-label box (text-sm 20px + mb-1 4px = 24px) so its top edge meets the first input; keep in sync if the label's type scale changes.

const TOTAL_ROW_CLASS = 'px-4 py-3';
const TOTAL_LABEL_CLASS =
  'font-mono text-xs font-semibold uppercase tracking-wide text-muted';
const TOTAL_VALUE_CLASS =
  'mt-1 font-mono text-xl font-bold tabular-nums text-ink';
// The input-line token clears the WCAG 1.4.11 non-text contrast gate in both themes (pair checked in lib/contrast.ts).
const INPUT_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

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
  /** Roth IRA only: per-year conversion amounts are §408A ordering history. */
  showRothConversion: boolean;
  /** Designated-Roth employer plans only: per-year in-plan rollover amounts (§402A(c)(4)); never both with showRothConversion. */
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
