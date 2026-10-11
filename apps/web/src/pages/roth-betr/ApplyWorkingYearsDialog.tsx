/**
 * Apply working-years conversions dialog. Lists the existing
 * working-years conversion windows the apply will REPLACE, the snapshot-fill
 * amount disclosure, and source / target-Roth pickers. Confirm writes one flat
 * window via the page's `onConfirm`.
 *
 * Apply is blocked (disabled) when no source account or target Roth is chosen,
 * or when the bracket-fill amount is $0 (no bracket headroom to convert).
 */
import React, { useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { Alert } from '../../components/Alert';
import { btnPrimaryClass, btnSecondaryClass } from '../../components/dialog-chrome';
import { formatCurrency } from '../../lib/format-currency';
import type { AccountOption } from './roth-betr-data';

interface ApplyWorkingYearsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Window amount (whole dollars) — sum of the (IRA-source) bracket-fill Convert
   *  tranches; a single set, independent of the selected tax-payment source. */
  amountDollars: number;
  /** Count of existing working-years windows that Apply will replace. */
  replacedWindowCount: number;
  sourceAccounts: readonly AccountOption[];
  rothIraAccounts: readonly AccountOption[];
  onConfirm: (sourceAccountId: string, targetRothId: string) => void;
}

export const ApplyWorkingYearsDialog: React.FC<ApplyWorkingYearsDialogProps> = ({
  open,
  onClose,
  amountDollars,
  replacedWindowCount,
  sourceAccounts,
  rothIraAccounts,
  onConfirm,
}) => {
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');

  // Pair the Roth target to the SAME owner as the selected source — IRC §408A is
  // per-individual, so a cross-owner pair is invalid and silently pruned at save.
  // Until a source is picked, no target is offered.
  const targetsForSource = useMemo(() => {
    const owner = sourceAccounts.find((a) => a.id === sourceId)?.ownerId;
    if (owner === undefined) return [];
    return rothIraAccounts.filter((a) => a.ownerId === owner);
  }, [sourceAccounts, rothIraAccounts, sourceId]);

  const noRoth = rothIraAccounts.length === 0;
  const targetStillValid = targetsForSource.some((a) => a.id === targetId);
  const canApply =
    amountDollars > 0 && sourceId !== '' && targetId !== '' && targetStillValid && !noRoth;

  return (
    <Modal open={open} onClose={onClose} title="Save working-years conversions to scenario" size="lg">
      <p className="mb-4 text-sm text-muted">
        This creates one flat working-years conversion of{' '}
        <strong className="text-ink">{formatCurrency(amountDollars)}</strong> per
        year from now through retirement.
      </p>

      {replacedWindowCount > 0 && (
        <Alert tone="warning">
          {replacedWindowCount} existing working-years conversion
          {replacedWindowCount === 1 ? '' : 's'} will be replaced.
        </Alert>
      )}

      <Alert tone="info">
        Amount is based on this year&rsquo;s bracket headroom — actual headroom
        will vary as your income and brackets change over time.
      </Alert>

      {noRoth ? (
        <Alert tone="error">
          No Roth IRA account exists in this scenario. Add a Roth IRA to save a
          conversion schedule.
        </Alert>
      ) : (
        <>
          <Field htmlFor="apply-wy-source" label="Convert from">
            <Select
              id="apply-wy-source"
              ariaLabel="Source pre-tax account"
              value={sourceId}
              onChange={(next) => {
                setSourceId(next);
                // Drop a target that doesn't belong to the newly-chosen source's
                // owner so a cross-owner pair can never persist.
                setTargetId('');
              }}
              placeholder="Select a pre-tax account"
              options={sourceAccounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
          <Field htmlFor="apply-wy-target" label="Convert to (Roth IRA)">
            <Select
              id="apply-wy-target"
              ariaLabel="Target Roth IRA"
              value={targetId}
              onChange={setTargetId}
              placeholder={
                sourceId === '' ? 'Select a source account first' : 'Select a Roth IRA'
              }
              options={targetsForSource.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
        </>
      )}

      <div className="mt-4 flex justify-start gap-3">
        <button
          type="button"
          className={btnPrimaryClass}
          disabled={!canApply}
          onClick={() => onConfirm(sourceId, targetId)}
        >
          Save to scenario
        </button>
        <button type="button" className={btnSecondaryClass} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
};
