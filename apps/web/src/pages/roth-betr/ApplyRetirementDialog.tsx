/**
 * Apply retirement Fill-window dialog. Shows the proposed pre-RMD
 * window (`retirement → age:rmdTriggerAge`), a MAGI-line picker (IRMAA / ACA),
 * and a target-Roth picker. Confirm writes one Fill window via the page's
 * `onConfirm`. Disabled with an error state when no Roth IRA exists.
 */
import React, { useState } from 'react';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { Alert } from '../../components/Alert';
import { btnPrimaryClass, btnSecondaryClass } from '../../components/dialog-chrome';
import type { MagiCapLine } from '../../db/types';
import type { AccountOption } from './roth-betr-data';

interface ApplyRetirementDialogProps {
  open: boolean;
  onClose: () => void;
  /** RMD trigger age the window ends at (73 or 75). */
  rmdTriggerAge: number;
  rothIraAccounts: readonly AccountOption[];
  onConfirm: (magiLine: MagiCapLine, targetRothId: string) => void;
}

const MAGI_LINE_OPTIONS = [
  { value: 'irmaa', label: 'IRMAA (Medicare surcharge) threshold' },
  { value: 'aca', label: 'ACA subsidy (400% FPL) threshold' },
];

export const ApplyRetirementDialog: React.FC<ApplyRetirementDialogProps> = ({
  open,
  onClose,
  rmdTriggerAge,
  rothIraAccounts,
  onConfirm,
}) => {
  const [magiLine, setMagiLine] = useState<MagiCapLine>('irmaa');
  const [targetId, setTargetId] = useState('');

  const noRoth = rothIraAccounts.length === 0;
  const canApply = !noRoth && targetId !== '';

  return (
    <Modal open={open} onClose={onClose} title="Save retirement Fill window to scenario" size="lg">
      <p className="mb-4 text-sm text-muted">
        This creates a MAGI-cap Fill window from retirement through age{' '}
        <strong className="text-ink">{rmdTriggerAge}</strong> (when required
        minimum distributions begin), auto-converting leftover headroom into your
        Roth IRA.
      </p>

      {noRoth ? (
        <Alert tone="error">
          No Roth IRA account exists in this scenario. Add a Roth IRA to save a
          Fill window.
        </Alert>
      ) : (
        <>
          <Field htmlFor="apply-ret-line" label="Fill up to which threshold">
            <Select
              id="apply-ret-line"
              ariaLabel="MAGI line"
              value={magiLine}
              onChange={(v) => setMagiLine(v as MagiCapLine)}
              options={MAGI_LINE_OPTIONS}
            />
          </Field>
          <Field htmlFor="apply-ret-target" label="Convert to (Roth IRA)">
            <Select
              id="apply-ret-target"
              ariaLabel="Target Roth IRA"
              value={targetId}
              onChange={setTargetId}
              placeholder="Select a Roth IRA"
              options={rothIraAccounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
        </>
      )}

      <div className="mt-4 flex justify-start gap-3">
        <button
          type="button"
          className={btnPrimaryClass}
          disabled={!canApply}
          onClick={() => onConfirm(magiLine, targetId)}
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
