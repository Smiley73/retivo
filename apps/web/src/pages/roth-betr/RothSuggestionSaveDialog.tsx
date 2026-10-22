/**
 * Confirm dialog for saving a ranked conversion plan to the scenario; Confirm is
 * blocked when the target is not an eligible Roth IRA of this scenario.
 */
import React from 'react';
import { Alert } from '../../components/Alert';
import { Modal } from '../../components/Modal';
import { btnPrimaryClass, btnSecondaryClass } from '../../components/dialog-chrome';
import type { ReplacedCap, SavePlanSummary } from './roth-suggestion-save-view';

interface RothSuggestionSaveDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly scenarioName: string;
  /** The plan being saved; null while closed. */
  readonly summary: SavePlanSummary | null;
  readonly replaced: ReplacedCap;
  /** Name of the Roth IRA the plan converts into; null when it is not an
   *  eligible target of this scenario. */
  readonly targetName: string | null;
  /** The assumed death age(s), as the panel's disclaimer names them. */
  readonly deathAges: string;
  /** A save is in flight: Confirm waits. */
  readonly saving: boolean;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function replacedText(replaced: ReplacedCap, scenarioName: string): string {
  if (replaced.count === 0) {
    return `${scenarioName} has no income cap windows today, so nothing is replaced.`;
  }
  const windows = plural(replaced.count, 'income cap window');
  return replaced.inheritedFrom === null
    ? `This replaces the ${windows} ${scenarioName} has today.`
    : `This replaces the ${windows} ${scenarioName} inherits from ${replaced.inheritedFrom}. ` +
        `${replaced.inheritedFrom} is not changed; the saved plan applies to ${scenarioName} only.`;
}

export const RothSuggestionSaveDialog: React.FC<RothSuggestionSaveDialogProps> = ({
  open,
  onClose,
  onConfirm,
  scenarioName,
  summary,
  replaced,
  targetName,
  deathAges,
  saving,
}) => {
  if (summary === null) return null;
  const years = summary.reroutedYears.join(', ');
  return (
    <Modal open={open} onClose={onClose} title="Save plan to scenario" size="lg">
      <p className="mb-3 text-sm text-muted">
        This saves <strong className="text-ink">{summary.label}</strong> to{' '}
        <strong className="text-ink">{scenarioName}</strong> as one Fill window for each year from{' '}
        {summary.firstYear} to {summary.lastYear} ({plural(summary.windowCount, 'window')}), each
        with the fixed dollar income ceiling the comparison worked out for that year. In this
        model the plan converts in {plural(summary.yearsConverted, 'year')}, {summary.totalConverted}{' '}
        in total in today&rsquo;s dollars. Nothing else on the scenario changes.
      </p>

      <Alert tone={replaced.count > 0 ? 'warning' : 'info'}>
        {replacedText(replaced, scenarioName)}
      </Alert>

      {targetName === null ? (
        <Alert tone="error">
          The Roth IRA this plan converts into is not an active Roth IRA of your own on this
          scenario, so the plan cannot be saved. Add one on the Accounts page and compare plans
          again.
        </Alert>
      ) : (
        <p className="mb-3 text-sm text-muted">
          Conversions go into <strong className="text-ink">{targetName}</strong>, the account the
          comparison used. It cannot be changed here.
        </p>
      )}

      <p className="mb-3 text-sm text-muted">
        A Fill window is a cap on pre-tax income, not an instruction to convert. In a year when
        spending needs more pre-tax money than the ceiling allows, the projection draws on
        taxable or Roth accounts instead, and records that the cap could not be met when none are
        left.{' '}
        {summary.reroutedYears.length > 0
          ? `In this plan that happens in ${years}.`
          : 'In this plan that does not happen in any year.'}{' '}
        The ceilings are fixed dollar amounts and do not rise with inflation.
      </p>

      <p className="mb-3 text-xs text-muted">
        This is a limited search at one assumed death age ({deathAges}), using federal tax only. It
        shows what the plan would do in this model; it is not advice.
      </p>

      <div className="mt-4 flex justify-start gap-3">
        <button
          type="button"
          className={btnPrimaryClass}
          disabled={targetName === null || saving}
          onClick={onConfirm}
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
