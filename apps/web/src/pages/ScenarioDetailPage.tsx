/** Scenario detail page: header form (name, description, notes, parent) behind the unsaved-edits guard, plus summary cards whose Configure buttons open per-subsection modals or pages.
* Promote, Delete and Reset-all act on the whole scenario and are hidden or disabled for the base. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { PageHeader } from '../components/PageHeader';
import { Select } from '../components/Select';
import { TextInput } from '../components/TextInput';
import { NotesField } from '../components/NotesField';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { listAggregates } from '../db/store';
import {
  deleteScenarioCascade,
  promoteScenario,
  saveScenario,
} from '../lib/scenario-mutations';
import {
  descendantIds,
  resetAllOverrides,
  resetField,
  resolveScenario,
  wouldCreateCycle,
} from '../lib/scenario-resolution';
import { buildScenarioTreeOptions } from '../lib/scenario-tree-options';
import { useSync } from '../sync/SyncContext';
import type {
  AccountPayload,
  Aggregate,
  ContributionsOverride,
  HouseholdMemberPayload,
  ScenarioOverrides,
  ScenarioPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  DiscretionaryAdjustmentCard,
  DiscretionaryAdjustmentModal,
  DownturnGuardrailsCard,
  DownturnGuardrailsModal,
  InflationCard,
  LifeExpectancyCard,
  LifeExpectancyModal,
} from './ScenarioExpenseSubsectionCards';
import {
  AssetAllocationCard,
  AssetAllocationModal,
} from './ScenarioAssetAllocationCard';
import {
  WithdrawalStrategyCard,
  TaxAssumptionsCard,
  TaxAssumptionsModal,
  AcaCoverageCard,
  AcaCoverageModal,
} from './ScenarioWithdrawalStrategyCards';
import { RetirementAgeModal } from './RetirementAgeModal';
import { SocialSecurityModal } from './SocialSecurityModal';
import {
  RefreshIcon,
  CheckIcon,
  TrashIcon,
  StarIcon,
  XIcon,
  ClockIcon,
  WalletIcon,
  TrendingUpIcon,
  ScaleIcon,
} from '../components/icons';
import { btnSecondarySmClass } from '../components/dialog-chrome';
import {
  inputClass,
  breadcrumbNavClass,
  btnSecondaryClass,
  ScenarioCardGroup,
} from './scenarios-page-chrome';
import { unresolvedFilingDetail } from '../lib/filing-status';
import { ExpenseOverridesSummaryCard } from '../components/scenario/ExpenseOverridesSummary';
import { IncomeOverridesSummaryCard } from '../components/scenario/IncomeOverridesSummary';
import {
  RothConversionsSummaryCard,
  hasRothConversionOverride,
  ROTH_CONVERSION_OVERRIDE_KEYS,
} from '../components/scenario/RothConversionsSummary';
import { QcdSummaryCard, hasQcdOverride } from '../components/scenario/QcdSummary';
import {
  AccountContributionsOverridesSummaryCard,
  AccountReturnsOverridesSummaryCard,
  AccountFloorsOverridesSummaryCard,
} from '../components/scenario/AccountOverridesSummary';
import {
  RetirementAgeSummaryCard,
  SocialSecuritySummaryCard,
} from '../components/scenario/SummaryCard';
import { FutureContributionsCard } from '../components/scenario/FutureContributionsCard';

const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;
const MAX_NOTES = 2000;

interface HeaderDraft {
  name: string;
  description: string;
  parentScenarioId: string | null;
  notes: string;
}

function headerDraftFrom(payload: ScenarioPayload): HeaderDraft {
  return {
    name: payload.name,
    description: payload.description,
    parentScenarioId: payload.parentScenarioId,
    notes: payload.notes,
  };
}

function headerDraftEquals(draft: HeaderDraft, payload: ScenarioPayload): boolean {
  return (
    draft.name === payload.name &&
    draft.description === payload.description &&
    draft.parentScenarioId === payload.parentScenarioId &&
    draft.notes === payload.notes
  );
}

export const ScenarioDetailPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();

  const [scenarios, setScenarios] = useState<ScenarioAggregate[]>([]);
  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [benefitsByMemberId, setBenefitsByMemberId] = useState<
    Record<string, { pia: number | null }>
  >({});
  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [draft, setDraft] = useState<HeaderDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingPromote, setPendingPromote] = useState(false);
  const [retirementAgeModalOpen, setRetirementAgeModalOpen] = useState(false);
  const [lifeExpectancyModalOpen, setLifeExpectancyModalOpen] = useState(false);
  const [discretionaryModalOpen, setDiscretionaryModalOpen] = useState(false);
  const [guardrailsModalOpen, setGuardrailsModalOpen] = useState(false);
  const [socialSecurityModalOpen, setSocialSecurityModalOpen] = useState(false);
  const [assetAllocationModalOpen, setAssetAllocationModalOpen] = useState(false);
  const [taxAssumptionsModalOpen, setTaxAssumptionsModalOpen] = useState(false);
  const [taxAssumptionsInitialTab, setTaxAssumptionsInitialTab] =
    useState<'hsa' | 'penalties' | 'filing'>('hsa');
  const [acaCoverageModalOpen, setAcaCoverageModalOpen] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);

  const reload = useCallback(async () => {
    const [allScenarios, allMembers, allAccounts, allSsBenefits] =
      await Promise.all([
        listAggregates('scenario'),
        listAggregates('householdMember'),
        listAggregates('account'),
        listAggregates('socialSecurityBenefit'),
      ]);
    const scenarioRows = allScenarios as ScenarioAggregate[];
    setScenarios(scenarioRows);
    setMembers(allMembers as Aggregate<HouseholdMemberPayload>[]);
    setAccounts(allAccounts as Aggregate<AccountPayload>[]);
    const ssMap: Record<string, { pia: number | null }> = {};
    for (const agg of allSsBenefits as Aggregate<SocialSecurityBenefitPayload>[]) {
      ssMap[agg.payload.householdMemberId] = { pia: agg.payload.pia };
    }
    setBenefitsByMemberId(ssMap);
    const found = scenarioRows.find((s) => s.id === id) ?? null;
    setScenario(found);
    setDraft(found ? headerDraftFrom(found.payload) : null);
  }, [id]);

  const activeAccountCount = useMemo(
    () => accounts.filter((a) => a.payload.active).length,
    [accounts],
  );

  useEffect(() => {
    let active = true;
    reload()
      .catch(() => {
        if (active) setError('Failed to load scenario.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);

  const isDirty = useMemo(() => {
    if (!scenario || !draft) return false;
    return !headerDraftEquals(draft, scenario.payload);
  }, [scenario, draft]);
  const { pendingNavModal, navigateUnguarded } = useUnsavedChangesGuard(isDirty);

  const primaryMember = members.find((m) => m.payload.isPrimary) ?? null;
  const secondaryMember = members.find((m) => !m.payload.isPrimary) ?? null;
  const otherScenarioCount = scenarios.length - 1;

  // Ask the production resolver whether the stored filing facts convert cleanly (resolved through the parent chain as the engines read them); a non-undefined detail means projections still run on the legacy scalar.
  const unresolvedFilingPrompt = useMemo(() => {
    if (!scenario) return undefined;
    const effective = (() => {
      if (!scenario.payload.parentScenarioId) return scenario.payload.overrides;
      try {
        return resolveScenario(scenario.id, scenarios);
      } catch (error) {
        console.warn('[scenario-detail] resolveScenario failed', {
          scenarioId: scenario.id,
          error,
        });
        return scenario.payload.overrides;
      }
    })();
    return unresolvedFilingDetail({
      taxFilingPlan: effective.taxFilingPlan,
      filingStatusOverride: effective.filingStatus,
      hasSecondaryMember: secondaryMember !== null,
    });
  }, [scenario, scenarios, secondaryMember]);

  const trimmedName = (draft?.name ?? '').trim();
  const nameCollides = useMemo(() => {
    if (!scenario || !draft) return false;
    const lower = trimmedName.toLocaleLowerCase();
    if (lower.length === 0) return false;
    return scenarios.some(
      (s) =>
        s.id !== scenario.id &&
        s.payload.name.trim().toLocaleLowerCase() === lower,
    );
  }, [scenarios, scenario, trimmedName, draft]);

  const onSave = async () => {
    if (!scenario || !draft || !householdId) return;
    if (trimmedName.length === 0) {
      setError('Name is required.');
      return;
    }
    if (nameCollides) {
      setError('A scenario with that name already exists.');
      return;
    }
    if (draft.description.length > MAX_DESCRIPTION) {
      setError(`Description is too long (max ${MAX_DESCRIPTION}).`);
      return;
    }
    if (
      !scenario.payload.isPrimary &&
      draft.parentScenarioId !== null &&
      wouldCreateCycle(scenario.id, draft.parentScenarioId, scenarios)
    ) {
      setError('That parent would create a cycle.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const payload: ScenarioPayload = {
        ...scenario.payload,
        name: trimmedName,
        description: draft.description.slice(0, MAX_DESCRIPTION),
        parentScenarioId: scenario.payload.isPrimary ? null : draft.parentScenarioId,
        isPrimary: scenario.payload.isPrimary,
        notes: draft.notes.slice(0, MAX_NOTES),
        overrides: scenario.payload.overrides,
      };
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = () => {
    if (!scenario) return;
    setDraft(headerDraftFrom(scenario.payload));
    setError(null);
  };

  const onResetAll = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const ok = await confirm(
      'Reset all overrides',
      <>
        Clear every override on <strong>{scenario.payload.name}</strong>? Every
        field will inherit from its parent again. This cannot be undone.
      </>,
      { confirmLabel: 'Reset' },
    );
    if (!ok) return;
    try {
      const payload = resetAllOverrides(scenario.payload);
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    }
  };

  const onPromote = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const oldBase = scenarios.find((s) => s.payload.isPrimary);
    const stage1 = await confirm(
      `Promote "${scenario.payload.name}" to base scenario?`,
      <>
        The current base{' '}
        <strong>{oldBase?.payload.name ?? ''}</strong> will be deleted.{' '}
        <strong>{scenario.payload.name}</strong>'s current values become the
        new base's values. This cannot be undone.
      </>,
      { confirmLabel: 'Promote' },
    );
    if (!stage1) return;
    if (otherScenarioCount >= 2) {
      const stage2 = await confirm(
        'Other scenarios will be re-parented',
        <>
          {otherScenarioCount - 1} other scenario
          {otherScenarioCount - 1 === 1 ? '' : 's'} will be re-parented to{' '}
          <strong>{scenario.payload.name}</strong>. Their stored overrides won't
          change, but because they'll be diffs against a different baseline,
          their projected numbers may shift.
        </>,
        { confirmLabel: 'Continue' },
      );
      if (!stage2) return;
    }
    setPendingPromote(true);
    try {
      await promoteScenario(scenario.id, scenarios, householdId);
      notifyPending();
      navigateUnguarded(`/scenarios/${scenario.id}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Promotion failed.');
    } finally {
      setPendingPromote(false);
    }
  };

  const onDelete = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const descendantCount = descendantIds(scenario.id, scenarios).size - 1;
    const ok = await confirm(
      `Delete "${scenario.payload.name}"?`,
      descendantCount === 0 ? (
        <>
          This cannot be undone.
        </>
      ) : (
        <>
          <strong>{scenario.payload.name}</strong> and its{' '}
          {descendantCount} child scenario
          {descendantCount === 1 ? '' : 's'} will be permanently deleted. This
          cannot be undone.
        </>
      ),
      { confirmLabel: 'Delete' },
    );
    if (!ok) return;
    try {
      await deleteScenarioCascade(scenario.id, scenarios, householdId);
      notifyPending();
      navigateUnguarded('/scenarios');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed.');
    }
  };

  const resetSection = async (
    sectionKey: keyof ScenarioOverrides,
    sectionLabel: string,
  ) => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const ok = await confirm(
      `Reset ${sectionLabel}?`,
      `Clear the ${sectionLabel} override?`,
      { confirmLabel: 'Reset' },
    );
    if (!ok) return;
    try {
      const payload = resetField(scenario.payload, sectionKey);
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    }
  };

  const onResetRetirementAge = () => resetSection('retirementAge', 'retirement age');
  const onResetSocialSecurity = () =>
    resetSection('socialSecurity', 'Social Security claim age');
  const onResetContributions = () =>
    resetSection('contributions', 'future contributions');
  const onResetLifeExpectancy = () =>
    resetSection('lifeExpectancy', 'life expectancy');
  const onResetInflation = () => resetSection('inflation', 'inflation');
  const onResetDiscretionary = () =>
    resetSection('discretionarySpending', 'discretionary adjustment');
  const onResetGuardrails = () =>
    resetSection('downturnGuardrails', 'spending guardrails');
  const onResetAssetAllocation = () =>
    resetSection('retirementAllocation', 'asset allocation');
  const onResetWithdrawalStrategy = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const ok = await confirm(
      'Reset withdrawal strategy?',
      'Clear the withdrawal strategy override?',
      { confirmLabel: 'Reset' },
    );
    if (!ok) return;
    try {
      // The MAGI bootstrap is two split lookback fields; reset both.
      let payload = resetField(scenario.payload, 'withdrawalStrategy');
      payload = resetField(payload, 'assumedCostBasisFractionOfTaxableWithdrawal');
      payload = resetField(payload, 'magiBootstrapLookbackMinus2');
      payload = resetField(payload, 'magiBootstrapLookbackMinus1');
      payload = resetField(payload, 'customDrawdownOrder');
      payload = resetField(payload, 'magiCap');
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    }
  };
  const onResetTaxAssumptions = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const ok = await confirm(
      'Reset tax assumptions?',
      'Clear the filing plan, HSA, and penalty-exemption overrides?',
      { confirmLabel: 'Reset' },
    );
    if (!ok) return;
    try {
      // taxFilingPlan counts toward this group's "customized" badge, so the reset must clear it too or the group stays flagged with no control able to clear it.
      let payload = resetField(scenario.payload, 'hsaQualifiedMedicalExpensePct');
      payload = resetField(payload, 'earlyWithdrawalPenaltyExemptAccountIds');
      payload = resetField(payload, 'taxFilingPlan');
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    }
  };
  const onResetRothConversions = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const ok = await confirm(
      'Reset Roth conversions?',
      'Clear the working-years Roth conversion overrides?',
      { confirmLabel: 'Reset' },
    );
    if (!ok) return;
    try {
      let payload = scenario.payload;
      for (const k of ROTH_CONVERSION_OVERRIDE_KEYS) {
        payload = resetField(payload, k);
      }
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    }
  };
  const onResetQcd = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const ok = await confirm(
      'Reset charitable distributions?',
      'Clear the Qualified Charitable Distribution overrides?',
      { confirmLabel: 'Reset' },
    );
    if (!ok) return;
    try {
      const payload = resetField(
        scenario.payload,
        'qualifiedCharitableDistributions',
      );
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    }
  };
  const onResetAcaCoverage = async () => {
    if (!scenario || !householdId || scenario.payload.isPrimary) return;
    const ok = await confirm(
      'Reset health coverage?',
      'Clear this scenario’s Marketplace opt-out, coverage months, poverty-guideline region, and benchmark prices?',
      { confirmLabel: 'Reset' },
    );
    if (!ok) return;
    try {
      let payload = resetField(scenario.payload, 'acaMarketplaceOptOutMemberIds');
      payload = resetField(payload, 'healthCoverageMonths');
      payload = resetField(payload, 'acaFplRegion');
      payload = resetField(payload, 'acaPtcBenchmark');
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    }
  };
  const onResetExpenses = () => resetSection('expenses', 'expense overrides');
  const onResetIncome = () => resetSection('income', 'income overrides');
  const onResetAccountContributions = () =>
    resetSection('accountContributions', 'account contribution overrides');
  const onResetAccountReturns = () =>
    resetSection('accountReturns', 'planned-return overrides');
  const onResetAccountFloors = () =>
    resetSection('accountFloors', 'account floor overrides');

  const onToggleStopContributions = async (next: boolean) => {
    if (!scenario || !householdId) return;
    const override: ContributionsOverride = { stopContributionsToday: next };
    const payload: ScenarioPayload = {
      ...scenario.payload,
      overrides: { ...scenario.payload.overrides, contributions: override },
    };
    try {
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    }
  };

  if (loading) return <Muted as="p">Loading scenario…</Muted>;
  if (!scenario || !draft) {
    return (
      <>
        <Alert tone="error">Scenario not found.</Alert>
        <Link to="/scenarios" className={textLinkClass}>
          Back to scenarios
        </Link>
      </>
    );
  }

  const headerSecondaryActions: NonNullable<
    React.ComponentProps<typeof PageHeader>['secondaryActions']
  > = [];
  if (!scenario.payload.isPrimary) {
    headerSecondaryActions.push(
      {
        key: 'reset-all',
        label: 'Reset all overrides',
        icon: <RefreshIcon />,
        onClick: onResetAll,
        disabled: submitting,
        tone: 'neutral',
      },
      {
        key: 'promote',
        label: pendingPromote ? 'Promoting…' : 'Promote to base',
        icon: <StarIcon />,
        onClick: onPromote,
        disabled: submitting || pendingPromote,
        ariaLabel: `Promote ${scenario.payload.name} to base scenario`,
        tone: 'neutral',
      },
      {
        key: 'delete',
        label: 'Delete',
        icon: <TrashIcon />,
        onClick: onDelete,
        disabled: submitting,
        tone: 'danger',
      },
    );
  }
  if (isDirty) {
    headerSecondaryActions.push({
      key: 'cancel',
      label: 'Cancel',
      icon: <XIcon />,
      onClick: onCancel,
      disabled: submitting,
      tone: 'neutral',
    });
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to="/scenarios">← Scenarios</Link>
      </nav>
      <PageHeader
        title={scenario.payload.isPrimary ? 'Base scenario' : 'Scenario'}
        action={
          isDirty
            ? {
                label: submitting ? 'Saving…' : 'Save',
                onClick: onSave,
                disabled: submitting,
              }
            : undefined
        }
        actionIcon={<CheckIcon />}
        secondaryActions={headerSecondaryActions}
      />

      {error && <Alert tone="error">{error}</Alert>}

      <section
        className="mb-2 flex flex-col gap-2 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
        aria-labelledby="scenario-header-heading"
      >
        <h2 id="scenario-header-heading" className="sr-only">
          {scenario.payload.name}
        </h2>
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
          <label
            className={`mb-3 flex min-w-0 flex-col gap-1 ${
              scenario.payload.isPrimary ? 'sm:col-span-3' : 'sm:col-span-2'
            }`}
          >
            <span className="text-sm font-medium text-ink">Name</span>
            <TextInput
              type="text"
              value={draft.name}
              maxLength={MAX_NAME}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className={inputClass}
            />
          </label>
          {!scenario.payload.isPrimary && (
            <label className="mb-3 flex min-w-0 flex-col gap-1 sm:col-span-1">
              <span className="text-sm font-medium text-ink">Parent scenario</span>
              <Select
                ariaLabel="Parent scenario"
                value={draft.parentScenarioId ?? ''}
                onChange={(v) => setDraft({ ...draft, parentScenarioId: v })}
                options={(() => {
                  const blocked = descendantIds(scenario.id, scenarios);
                  return buildScenarioTreeOptions(scenarios)
                    .filter(({ scenario: s }) => !blocked.has(s.id))
                    .map(({ scenario: s, depth }) => ({
                      value: s.id,
                      label: s.payload.name,
                      depth,
                    }));
                })()}
              />
            </label>
          )}
        </div>
        <label className="mb-3 flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-ink">Description</span>
          <TextInput
            type="text"
            value={draft.description}
            maxLength={MAX_DESCRIPTION}
            placeholder="Single-line summary of this scenario's intent"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            className={inputClass}
          />
        </label>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={`self-start ${btnSecondarySmClass}`}
            aria-expanded={notesExpanded}
            aria-controls="scenario-notes"
            onClick={() => setNotesExpanded((v) => !v)}
          >
            {notesExpanded
              ? 'Hide notes'
              : draft.notes.trim().length > 0
                ? 'Show notes'
                : 'Add notes'}
          </button>
          {notesExpanded && (
            <NotesField
              id="scenario-notes"
              label="Notes"
              rows={12}
              maxLength={MAX_NOTES}
              placeholder="Describe this scenario's intent: assumptions, motivation, anything you want to remember."
              value={draft.notes}
              onChange={(v) => setDraft({ ...draft, notes: v })}
            />
          )}
        </div>
      </section>

      {/* The outer wrapper keeps data-testid="scenario-overrides-row" for existing tests. */}
      <div className="mt-4 space-y-8" data-testid="scenario-overrides-row">
        {(() => {
          const isPrimary = scenario.payload.isPrimary;
          const ov = scenario.payload.overrides;
          const count = isPrimary ? 0 : [
            ov.retirementAge !== undefined,
            ov.socialSecurity !== undefined,
            ov.lifeExpectancy !== undefined,
          ].filter(Boolean).length;
          return (
            <ScenarioCardGroup title="Timing & longevity" id="timing" customizedCount={count} icon={<ClockIcon />}>
              <RetirementAgeSummaryCard
                scenario={scenario}
                scenarios={scenarios}
                primaryMember={primaryMember}
                secondaryMember={secondaryMember}
                onConfigure={() => setRetirementAgeModalOpen(true)}
                onResetToInherited={onResetRetirementAge}
              />
              <SocialSecuritySummaryCard
                scenario={scenario}
                scenarios={scenarios}
                primaryMember={primaryMember}
                secondaryMember={secondaryMember}
                onConfigure={() => setSocialSecurityModalOpen(true)}
                onResetToInherited={onResetSocialSecurity}
              />
              <LifeExpectancyCard
                scenario={scenario}
                scenarios={scenarios}
                primaryMember={primaryMember}
                secondaryMember={secondaryMember}
                onConfigure={() => setLifeExpectancyModalOpen(true)}
                onResetToInherited={onResetLifeExpectancy}
              />
            </ScenarioCardGroup>
          );
        })()}

        {(() => {
          const isPrimary = scenario.payload.isPrimary;
          const ov = scenario.payload.overrides;
          const inc = ov.income;
          const exp = ov.expenses;
          const incTotal = (inc?.disabledIds?.length ?? 0) + Object.keys(inc?.patches ?? {}).length + (inc?.added?.length ?? 0);
          const expTotal = (exp?.disabledIds?.length ?? 0) + Object.keys(exp?.patches ?? {}).length + (exp?.added?.length ?? 0);
          const count = isPrimary ? 0 : [
            incTotal > 0,
            expTotal > 0,
            ov.inflation !== undefined,
            ov.discretionarySpending !== undefined,
            ov.downturnGuardrails !== undefined,
          ].filter(Boolean).length;
          return (
            <ScenarioCardGroup title="Income & expenses" id="income" customizedCount={count} icon={<WalletIcon />}>
              <IncomeOverridesSummaryCard
                scenarioId={id}
                scenario={scenario}
                onResetToInherited={onResetIncome}
              />
              <ExpenseOverridesSummaryCard
                scenarioId={id}
                scenario={scenario}
                onResetToInherited={onResetExpenses}
              />
              <InflationCard
                scenario={scenario}
                scenarios={scenarios}
                onConfigure={() => navigate(`/scenarios/${id}/inflation`)}
                onResetToInherited={onResetInflation}
              />
              <DiscretionaryAdjustmentCard
                scenario={scenario}
                scenarios={scenarios}
                onConfigure={() => setDiscretionaryModalOpen(true)}
                onResetToInherited={onResetDiscretionary}
              />
              <DownturnGuardrailsCard
                scenario={scenario}
                scenarios={scenarios}
                onConfigure={() => setGuardrailsModalOpen(true)}
                onResetToInherited={onResetGuardrails}
              />
            </ScenarioCardGroup>
          );
        })()}

        {(() => {
          const isPrimary = scenario.payload.isPrimary;
          const ov = scenario.payload.overrides;
          const count = isPrimary ? 0 : [
            ov.contributions !== undefined,
            Object.keys(ov.accountContributions?.perAccount ?? {}).length > 0,
            Object.keys(ov.accountReturns?.perAccount ?? {}).length > 0,
            ov.retirementAllocation !== undefined,
          ].filter(Boolean).length;
          return (
            <ScenarioCardGroup title="Savings & investments" id="savings" customizedCount={count} icon={<TrendingUpIcon />}>
              <FutureContributionsCard
                scenario={scenario}
                scenarios={scenarios}
                onToggle={onToggleStopContributions}
                onResetToInherited={onResetContributions}
              />
              <AccountContributionsOverridesSummaryCard
                scenarioId={id}
                scenario={scenario}
                activeAccountCount={activeAccountCount}
                onResetToInherited={onResetAccountContributions}
              />
              <AccountReturnsOverridesSummaryCard
                scenarioId={id}
                scenario={scenario}
                activeAccountCount={activeAccountCount}
                onResetToInherited={onResetAccountReturns}
              />
              <AssetAllocationCard
                scenario={scenario}
                scenarios={scenarios}
                primaryMember={primaryMember}
                onConfigure={() => setAssetAllocationModalOpen(true)}
                onResetToInherited={onResetAssetAllocation}
              />
            </ScenarioCardGroup>
          );
        })()}

        {(() => {
          const isPrimary = scenario.payload.isPrimary;
          const ov = scenario.payload.overrides;
          const count = isPrimary ? 0 : [
            ov.withdrawalStrategy !== undefined || ov.assumedCostBasisFractionOfTaxableWithdrawal !== undefined || ov.magiBootstrapLookbackMinus2 !== undefined || ov.magiBootstrapLookbackMinus1 !== undefined || ov.customDrawdownOrder !== undefined || ov.magiCap !== undefined,
            ov.hsaQualifiedMedicalExpensePct !== undefined || ov.earlyWithdrawalPenaltyExemptAccountIds !== undefined || ov.taxFilingPlan !== undefined,
            ov.acaMarketplaceOptOutMemberIds !== undefined ||
              ov.healthCoverageMonths !== undefined ||
              ov.acaFplRegion !== undefined ||
              ov.acaPtcBenchmark !== undefined,
            hasRothConversionOverride(ov),
            hasQcdOverride(ov),
            Object.keys(ov.accountFloors?.perAccount ?? {}).length > 0,
          ].filter(Boolean).length;
          return (
            <ScenarioCardGroup title="Withdrawals & taxes" id="withdrawals" customizedCount={count} icon={<ScaleIcon />}>
              {/* Unreadable filing facts keep driving projections unchanged until resolved here; nothing is dropped, so this is a prompt, not a blocker. */}
              {unresolvedFilingPrompt !== undefined && (
                <Alert tone="warning">
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      We cannot read this scenario&rsquo;s filing choice for both
                      of you, so projections keep filing exactly as they did
                      before. Choose how your household files to switch over.
                    </span>
                    <button
                      type="button"
                      className={btnSecondaryClass}
                      onClick={() => {
                        setTaxAssumptionsInitialTab('filing');
                        setTaxAssumptionsModalOpen(true);
                      }}
                    >
                      Choose how you file
                    </button>
                  </span>
                </Alert>
              )}
              <WithdrawalStrategyCard
                scenario={scenario}
                scenarios={scenarios}
                onConfigure={() => navigate(`/scenarios/${id}/withdrawal-strategy`)}
                onResetToInherited={onResetWithdrawalStrategy}
              />
              <TaxAssumptionsCard
                scenario={scenario}
                scenarios={scenarios}
                onConfigure={() => {
                  setTaxAssumptionsInitialTab('hsa');
                  setTaxAssumptionsModalOpen(true);
                }}
                onResetToInherited={onResetTaxAssumptions}
              />
              <AcaCoverageCard
                scenario={scenario}
                scenarios={scenarios}
                members={members}
                onConfigure={() => setAcaCoverageModalOpen(true)}
                onResetToInherited={onResetAcaCoverage}
              />
              <RothConversionsSummaryCard
                scenarioId={id}
                scenario={scenario}
                scenarios={scenarios}
                members={members}
                onResetToInherited={onResetRothConversions}
              />
              <QcdSummaryCard
                scenarioId={id}
                scenario={scenario}
                scenarios={scenarios}
                accounts={accounts}
                members={members}
                onResetToInherited={onResetQcd}
              />
              <AccountFloorsOverridesSummaryCard
                scenarioId={id}
                scenario={scenario}
                scenarios={scenarios}
                accounts={accounts}
                onResetToInherited={onResetAccountFloors}
              />
            </ScenarioCardGroup>
          );
        })()}
      </div>

      {retirementAgeModalOpen && householdId && (
        <RetirementAgeModal
          open
          scenario={scenario}
          scenarios={scenarios}
          primaryMember={primaryMember}
          secondaryMember={secondaryMember}
          householdId={householdId}
          onClose={async (saved) => {
            setRetirementAgeModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {socialSecurityModalOpen && householdId && (
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={scenarios}
          primaryMember={primaryMember}
          secondaryMember={secondaryMember}
          benefitsByMemberId={benefitsByMemberId}
          householdId={householdId}
          onClose={async (saved) => {
            setSocialSecurityModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {lifeExpectancyModalOpen && householdId && (
        <LifeExpectancyModal
          scenario={scenario}
          primaryMember={primaryMember}
          secondaryMember={secondaryMember}
          householdId={householdId}
          onClose={async (saved) => {
            setLifeExpectancyModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {discretionaryModalOpen && householdId && (
        <DiscretionaryAdjustmentModal
          scenario={scenario}
          householdId={householdId}
          onClose={async (saved) => {
            setDiscretionaryModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {guardrailsModalOpen && householdId && (
        <DownturnGuardrailsModal
          scenario={scenario}
          householdId={householdId}
          onClose={async (saved) => {
            setGuardrailsModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {assetAllocationModalOpen && householdId && (
        <AssetAllocationModal
          scenario={scenario}
          scenarios={scenarios}
          primaryMember={primaryMember}
          householdId={householdId}
          onClose={async (saved) => {
            setAssetAllocationModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {taxAssumptionsModalOpen && householdId && (
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={scenarios}
          householdId={householdId}
          accounts={accounts}
          members={members}
          initialTab={taxAssumptionsInitialTab}
          onClose={async (saved) => {
            setTaxAssumptionsModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {acaCoverageModalOpen && householdId && (
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={scenarios}
          householdId={householdId}
          members={members}
          onClose={async (saved) => {
            setAcaCoverageModalOpen(false);
            if (saved) {
              notifyPending();
              await reload();
            }
          }}
        />
      )}

      {pendingNavModal}
      {dialog}
    </>
  );
};
