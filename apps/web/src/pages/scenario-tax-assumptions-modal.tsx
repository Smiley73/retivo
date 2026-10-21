/**
 * Tax-assumptions configure modal — standalone editor for the scenario's
 * tax-treatment overrides (the emergency-HSA qualified-medical percentage —
 * which governs only EMERGENCY HSA withdrawals; modeled medical-qualified
 * withdrawals are always 100% qualified — per-account early-withdrawal
 * penalty exemptions, and the household's filing plan).
 *
 * Decoupled from the withdrawal-strategy modal (which owns the *mechanics* of
 * drawdown: strategy kind, custom order, MAGI cap, cost basis). Opened from its
 * own "Tax assumptions" card on the Scenario Detail page. The concerns are
 * separated into React Aria Tabs — modelled after the withdrawal-strategy modal
 * for consistency (shared `TAB_CLASS` / `TAB_PANEL_CLASS`). Draft
 * state + dirty-tracking come from `useTaxAssumptionsDraft`; Save writes only
 * the tax override keys (via `buildNextTaxAssumptions`, which prunes ids of
 * deleted accounts) and leaves every other override untouched.
 *
 * Filing-plan save path. The modal persists a COMPLETE overrides
 * object, so resolving the legacy scalar is a plain key omission: `nextOverrides`
 * is rebuilt with `taxFilingPlan` added and the legacy `filingStatus` key OMITTED
 * entirely. There is deliberately NO `PatchWithClears` null sentinel here —
 * that sentinel belongs to the nested expense/income patch shapes,
 * not to top-level override keys, and storing `filingStatus: null` would leave a
 * dead key on every synced device.
 */
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

/**
 * The filing plan the editor opens on.
 *
 * 1. A stored `taxFilingPlan` the engines can actually project on (resolved
 *    through the parent chain, exactly as they read it) wins.
 * 2. Else a legacy scalar that CONVERTS CLEANLY is materialized into the
 *    equivalent plan, following the scalar × household-cardinality matrix:
 *    one-member `Single` → an
 *    individual plan; one-member `HoH` → an individual plan with an OPEN-ENDED
 *    HoH window (seeding a bare individual plan here silently downgraded
 *    a head-of-household filer to Single, a real tax increase, on the next
 *    save); two-member `MFJ` → a joint plan.
 * 3. Else (an AMBIGUOUS scalar — a two-member `Single`/`HoH`, a one-member
 *    `MFJ`, an unknown value) the editor opens on the composition default AND
 *    shows the resolution prompt. Nothing is guessed into storage: the save
 *    path only writes a plan once the user actually uses these controls.
 *
 * An UNUSABLE stored plan (a corrupt `separate` payload from sync or
 * IndexedDB, or a one-person plan on a household that has since added a spouse)
 * takes branch 3 too. `taxFilingPlan` has no runtime schema behind it and the
 * separate-returns controls index `units[0]`/`units[1]` directly, so handing the
 * stored value straight to the editor would throw during render — on the one
 * surface the resolution prompt deep-links to for repairing exactly that data. The same
 * `isWellFormedFilingPlan` predicate the resolver uses decides this, so the
 * editor can never open on a plan the engines refuse (or refuse one they use).
 */
function initialFilingPlan(
  effective: ScenarioOverrides,
  hasSpouse: boolean,
): TaxFilingPlan {
  const stored = effective.taxFilingPlan;
  if (isWellFormedFilingPlan(stored, hasSpouse)) return stored;
  // An unusable stored plan opens on the composition default; the resolution
  // prompt above the controls explains that the saved choice could not be used.
  if (stored !== undefined) return hasSpouse ? { kind: 'joint' } : { kind: 'individual' };
  const scalar = effective.filingStatus;
  if (scalar === 'HoH' && !hasSpouse) {
    return { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] };
  }
  // Remaining clean conversions (one-member `Single`, two-member `MFJ`) and the
  // no-override composition rule agree with the composition default below.
  return hasSpouse ? { kind: 'joint' } : { kind: 'individual' };
}

export interface TaxAssumptionsModalProps {
  open: boolean;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  householdId: string;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  /** Every household member — drives the filing editor's spouse labels. */
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Which tab to open on. Defaults to `hsa`; the Scenario Detail page's
   *  filing prompt opens straight on `filing`. */
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
  // Frozen at mount, mirroring the sibling drafts' baseline convention.
  const filingBaseline = useMemo(
    () => JSON.stringify(initialFilingPlan(effective, hasSpouse)),
    [], // frozen at mount
  );
  const [filingPlan, setFilingPlan] = useState<TaxFilingPlan>(() =>
    initialFilingPlan(effective, hasSpouse),
  );
  // Set ONLY by the Filing tab's own controls. Converting the legacy
  // scalar to a stored plan is a data-model decision that belongs to an explicit
  // user act: deriving "the filing editor changed something" from the mere
  // PRESENCE of an unresolved scalar made every unrelated save (an HSA
  // percentage nudge on a tab the user never left) delete `filingStatus` and
  // persist a guessed plan default.
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
  // A stored plan the engines refuse (corrupt payload, or written for a
  // household composition that no longer exists). The editor opened on a safe
  // default in that case, so the prompt says so instead of blaming an older
  // filing setting the scenario may not even carry.
  const storedPlanUsable = isWellFormedFilingPlan(effective.taxFilingPlan, hasSpouse);
  const unresolvedFromStoredPlan = effective.taxFilingPlan !== undefined && !storedPlanUsable;
  const filingDirty =
    filingControlsTouched &&
    (JSON.stringify(filingPlan) !== filingBaseline ||
      // No USABLE plan is stored yet, so ADOPTING the shown plan is itself the
      // change — this is how a legacy scalar gets converted, how an unusable
      // stored plan gets repaired, and how the "use the choice shown"
      // affordance on the resolution prompt works. Still gated on the user having
      // actually used the filing controls.
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
      // Resolving the legacy conversion is a key OMISSION, never a stored
      // null: `filingStatus` is destructured out and simply not persisted.
      // Both halves happen ONLY when the user actually USED the filing controls
      // (an HSA-only save neither invents a stored plan default
      // nor quietly discards an untouched legacy setting).
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
        {/* Left-aligned, primary action first — AGENTS modal-action rule. */}
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
  /** Every household member — the modal lists all of them. */
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  onClose: (saved: boolean) => void;
}

/**
 * Standalone health-coverage modal — edits every fact that drives the
 * Medicare surcharge and the ACA premium subsidy: the per-member Marketplace
 * opt-out (`acaMarketplaceOptOutMemberIds`), the per-member/per-year Medicare
 * Part B / Part D and Marketplace MONTHS (`healthCoverageMonths`), the
 * federal-poverty-level region (`acaFplRegion`), and the per-year benchmark plan
 * price (`acaPtcBenchmark`). Decoupled from the tax-assumptions modal so it owns
 * its own card in the Withdrawals & taxes group. Save writes only those keys
 * (each sparse — omitted when the draft matches the inherited value and the
 * scenario had no local override; prune-on-save against the live member-id set)
 * and leaves every other override untouched.
 */
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
  // The Medicare premiums link leaves this page, so it asks first while the
  // draft has unsaved changes (the close guard above covers only X / Esc / scrim).
  const navigate = useNavigate();
  const { runGuarded, confirmModal: leaveConfirmModal } =
    useDirtyDiscardAction(isDirty);

  // A row that states nothing is dropped on save; block instead of
  // silently discarding it, so the user is told rather than surprised.
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
              // Let a new-tab click through; only an in-place navigation
              // discards the draft.
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
        {/* Left-aligned, primary action first — AGENTS modal-action rule. */}
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
