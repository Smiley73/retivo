/** Tax assumptions modal: the emergency-HSA qualified %, per-account early-withdrawal penalty exemptions and the filing plan, in tabs. Save writes only the tax override keys.
* The filing save omits the legacy `filingStatus` key entirely: a null sentinel belongs to the nested patch shapes and would leave a dead key on every synced device. */
import React, { useMemo, useState } from 'react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { Modal } from '../components/Modal';
import { Alert } from '../components/Alert';
import { TextLink } from '../components/TextLink';
import {
  useDirtyDiscardAction,
  useDirtyModalClose,
} from '../components/UnsavedChangesGuard';
import { saveScenario } from '../lib/scenario-mutations';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioOverrides,
} from '../db/types';
import {
  isWellFormedFilingPlan,
  openEndedStatusWindow,
  unresolvedFilingDetail,
  type TaxFilingPlan,
} from '../lib/filing-status';
import {
  btnPrimaryClass,
  btnSecondaryClass,
} from './scenarios-page-chrome';
import { TAB_CLASS, TAB_PANEL_CLASS } from '../components/tab-chrome';
import { healthCoverageBlockReason } from './scenario-withdrawal-strategy-shared';
import {
  FilingPlanSection,
  HealthCoverageSection,
  HsaQualifiedSection,
  PenaltyExemptionsSection,
} from './scenario-tax-assumptions-sections';
import { MEDICARE_PREMIUMS_URL } from './medicare-premium-helper';
import {
  useAcaCoverageDraft,
  useTaxAssumptionsDraft,
} from './scenario-withdrawal-strategy-draft-hook';
import {
  buildNextAcaCoverage,
  buildNextHealthCoverage,
  buildNextTaxAssumptions,
} from './scenario-withdrawal-strategy-save-helpers';

// Opens on a stored plan the engines can project on, else a cleanly convertible legacy scalar (one-member HoH keeps an open-ended HoH window, since a bare individual plan would silently downgrade a head-of-household filer to Single).
// An ambiguous scalar or an unusable stored plan opens on the composition default with the resolution prompt: the separate-returns controls index units[0]/units[1], so a corrupt payload would throw.
// isWellFormedFilingPlan is the resolver's own predicate, so the editor never opens on a plan the engines refuse.
function initialFilingPlan(
  effective: ScenarioOverrides,
  hasSpouse: boolean,
): TaxFilingPlan {
  const stored = effective.taxFilingPlan;
  if (isWellFormedFilingPlan(stored, hasSpouse)) return stored;
  if (stored !== undefined) return hasSpouse ? { kind: 'joint' } : { kind: 'individual' };
  const scalar = effective.filingStatus;
  if (scalar === 'HoH' && !hasSpouse) {
    return { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] };
  }
  return hasSpouse ? { kind: 'joint' } : { kind: 'individual' };
}

export interface TaxAssumptionsModalProps {
  open: boolean;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  householdId: string;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Defaults to `hsa`; the Scenario Detail filing prompt opens straight on `filing`. */
  initialTab?: 'hsa' | 'penalties' | 'filing';
  onClose: (saved: boolean) => void;
}

export const TaxAssumptionsModal: React.FC<TaxAssumptionsModalProps> = ({
  open,
  scenario,
  scenarios,
  householdId,
  accounts,
  members,
  initialTab = 'hsa',
  onClose,
}) => {
  const {
    draft: { hsaQualifiedPct, penaltyExemptIds },
    localOverrides,
    effective,
    setHsaQualifiedPct,
    togglePenaltyExempt,
    isDirty: taxAssumptionsDirty,
  } = useTaxAssumptionsDraft(scenario, scenarios);

  const hasSpouse = members.some((m) => !m.payload.isPrimary);
  const filingBaseline = useMemo(
    () => JSON.stringify(initialFilingPlan(effective, hasSpouse)),
    [], // frozen at mount
  );
  const [filingPlan, setFilingPlan] = useState<TaxFilingPlan>(() =>
    initialFilingPlan(effective, hasSpouse),
  );
  // Set only by the Filing tab's controls: converting the legacy scalar is an explicit user act, or an unrelated save (an HSA nudge) would delete filingStatus and persist a guessed plan.
  const [filingControlsTouched, setFilingControlsTouched] = useState(false);
  const onChangeFilingPlan = (next: TaxFilingPlan): void => {
    setFilingControlsTouched(true);
    setFilingPlan(next);
  };
  const unresolvedLegacyDetail = useMemo(
    () =>
      unresolvedFilingDetail({
        taxFilingPlan: effective.taxFilingPlan,
        filingStatusOverride: effective.filingStatus,
        hasSecondaryMember: hasSpouse,
      }),
    [effective, hasSpouse],
  );
  // The editor opened on a safe default for a stored plan the engines refuse, so the prompt says so rather than blaming an older filing setting.
  const storedPlanUsable = isWellFormedFilingPlan(effective.taxFilingPlan, hasSpouse);
  const unresolvedFromStoredPlan = effective.taxFilingPlan !== undefined && !storedPlanUsable;
  const filingDirty =
    filingControlsTouched &&
    (JSON.stringify(filingPlan) !== filingBaseline ||
      !storedPlanUsable);
  const isDirty = taxAssumptionsDirty || filingDirty;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(
    isDirty,
    () => onClose(false),
  );

  const onSave = async (): Promise<void> => {
    if (!isDirty) return;
    setSubmitting(true);
    setError(null);
    try {
      // Resolving the legacy conversion is a key omission, never a stored null, and happens only when the user used the filing controls.
      const overridesWithoutLegacy: ScenarioOverrides = { ...localOverrides };
      delete overridesWithoutLegacy.filingStatus;
      const filingKeys: Pick<ScenarioOverrides, 'taxFilingPlan'> = filingDirty
        ? { taxFilingPlan: filingPlan }
        : {};
      const nextOverrides: ScenarioOverrides = {
        ...(filingDirty ? overridesWithoutLegacy : localOverrides),
        ...buildNextTaxAssumptions({
          hsaQualifiedPct,
          penaltyExemptIds,
          effective,
          localOverrides,
          accounts,
        }),
        ...filingKeys,
      };
      await saveScenario({
        scenario,
        payload: { ...scenario.payload, overrides: nextOverrides },
        householdId,
      });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Tax assumptions"
      onClose={guardedClose}
      size="3xl"
      scrollBodyLabel="Tax assumptions form"
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm">
          Tell the projection how your withdrawals are taxed: which tax return
          your household files each year, how much of your health-savings money
          goes to medical bills, and which accounts skip the extra tax for
          taking money out before age 59 and a half. These choices change your
          yearly tax bill in retirement.
        </p>
        <Tabs defaultSelectedKey={initialTab}>
          <TabList
            aria-label="Tax assumptions sections"
            className="flex border-b border-line"
          >
            <Tab id="hsa" className={TAB_CLASS}>
              HSA
            </Tab>
            <Tab id="penalties" className={TAB_CLASS}>
              Penalty exemptions
            </Tab>
            <Tab id="filing" className={TAB_CLASS}>
              Filing
            </Tab>
          </TabList>

          <TabPanel id="hsa" className={TAB_PANEL_CLASS}>
            <HsaQualifiedSection
              hsaQualifiedPct={hsaQualifiedPct}
              onChangeHsaPct={setHsaQualifiedPct}
            />
          </TabPanel>

          <TabPanel id="penalties" className={TAB_PANEL_CLASS}>
            <PenaltyExemptionsSection
              penaltyExemptIds={penaltyExemptIds}
              accounts={accounts}
              onTogglePenaltyExempt={togglePenaltyExempt}
            />
          </TabPanel>

          <TabPanel id="filing" className={TAB_PANEL_CLASS}>
            <FilingPlanSection
              members={members}
              plan={filingPlan}
              onChangePlan={onChangeFilingPlan}
              unresolvedLegacyDetail={unresolvedLegacyDetail}
              unresolvedFromStoredPlan={unresolvedFromStoredPlan}
            />
          </TabPanel>
        </Tabs>

        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-start gap-2">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={onSave}
            disabled={submitting || !isDirty}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={btnSecondaryClass} onClick={immediateClose}>
            Cancel
          </button>
        </div>
      </div>
      {confirmModal}
    </Modal>
  );
};

export interface AcaCoverageModalProps {
  open: boolean;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  householdId: string;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  onClose: (saved: boolean) => void;
}

/** Health coverage modal: edits the Medicare surcharge and ACA subsidy facts; Save writes only those keys, sparse and pruned against live member ids. */
export const AcaCoverageModal: React.FC<AcaCoverageModalProps> = ({
  open,
  scenario,
  scenarios,
  householdId,
  members,
  onClose,
}) => {
  const {
    draft: { acaOptOutMemberIds, fplRegion, coverageRows, benchmarkRows },
    localOverrides,
    effective,
    toggleAcaOptOut,
    setFplRegion,
    setCoverageRows,
    setBenchmarkRows,
    isDirty,
  } = useAcaCoverageDraft(scenario, scenarios);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(
    isDirty,
    () => onClose(false),
  );
  // The Medicare premiums link leaves this page, so it asks first while the draft has unsaved changes.
  const navigate = useNavigate();
  const { runGuarded, confirmModal: leaveConfirmModal } =
    useDirtyDiscardAction(isDirty);

  const blockReason = healthCoverageBlockReason(coverageRows, benchmarkRows);

  const onSave = async (): Promise<void> => {
    if (!isDirty || blockReason !== null) return;
    setSubmitting(true);
    setError(null);
    try {
      const nextOverrides = {
        ...localOverrides,
        ...buildNextAcaCoverage({
          acaOptOutMemberIds,
          effective,
          localOverrides,
          members,
        }),
        ...buildNextHealthCoverage({
          fplRegion,
          coverageRows,
          benchmarkRows,
          effective,
          localOverrides,
          members,
        }),
      };
      await saveScenario({
        scenario,
        payload: { ...scenario.payload, overrides: nextOverrides },
        householdId,
      });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Health coverage"
      onClose={guardedClose}
      size="3xl"
      scrollBodyLabel="Health coverage form"
    >
      <div className="flex flex-col gap-4">
        <HealthCoverageSection
          acaOptOutMemberIds={acaOptOutMemberIds}
          members={members}
          onToggleAcaOptOut={toggleAcaOptOut}
          fplRegion={fplRegion}
          onChangeFplRegion={setFplRegion}
          coverageRows={coverageRows}
          onChangeCoverageRows={(next) => setCoverageRows([...next])}
          benchmarkRows={benchmarkRows}
          onChangeBenchmarkRows={(next) => setBenchmarkRows([...next])}
        />
        <p className="m-0 text-sm text-muted">
          The base Medicare premium is yours to enter as a Medical expense.{' '}
          <TextLink
            to={MEDICARE_PREMIUMS_URL}
            onClick={(e) => {
              // Let a new-tab click through; only an in-place navigation discards the draft.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              runGuarded(() => navigate(MEDICARE_PREMIUMS_URL));
            }}
          >
            Add Part B and Part D premiums
          </TextLink>{' '}
          from the Expenses page.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        {blockReason !== null && isDirty ? (
          <Alert tone="warning">{blockReason}</Alert>
        ) : null}
        <div className="flex justify-start gap-2">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={onSave}
            disabled={submitting || !isDirty || blockReason !== null}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={btnSecondaryClass} onClick={immediateClose}>
            Cancel
          </button>
        </div>
      </div>
      {confirmModal}
      {leaveConfirmModal}
    </Modal>
  );
};
