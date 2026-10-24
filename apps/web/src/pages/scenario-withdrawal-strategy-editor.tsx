/** Withdrawal strategy editor page body: tabs (strategy, custom order, MAGI cap, advanced), validation, Save and the page-level unsaved-changes guard. Tax assumptions are a separate modal. */
import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from 'react-aria-components';
import { MoneyInput } from '../components/MoneyInput';
import { RangeSlider } from '../components/RangeSlider';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { incomeAddPath } from '../lib/cbp-resolution';
import { saveScenario } from '../lib/scenario-mutations';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';
import {
  btnPrimaryClass,
  btnSecondaryClass,
} from './scenarios-page-chrome';
import { TierEditor } from './scenario-withdrawal-strategy-tier-editor';
import { MagiCapSection } from './scenario-withdrawal-strategy-magi-cap';
import {
  magiCapWindowsSaveError,
  resolveScenarioRetirementAnchor,
} from './scenario-withdrawal-strategy-magi-cap-validation';
import {
  TAB_CLASS as SHARED_TAB_CLASS,
  TAB_PANEL_CLASS as SHARED_TAB_PANEL_CLASS,
} from '../components/tab-chrome';
import {
  STRATEGY_DESCRIPTIONS,
  STRATEGY_OPTIONS,
  buildCbpInfoRows,
  rothConversionTargets,
} from './scenario-withdrawal-strategy-shared';
import type { StrategyKind } from './scenario-withdrawal-strategy-shared';
import { useWithdrawalStrategyDraft } from './scenario-withdrawal-strategy-draft-hook';
import {
  buildNextStrategy,
  buildNextCostBasis,
  buildNextMagiBootstrap,
  buildNextCustomOrder,
  buildNextMagiCap,
} from './scenario-withdrawal-strategy-save-helpers';

const TAB_CLASS = SHARED_TAB_CLASS;
const TAB_PANEL_CLASS = SHARED_TAB_PANEL_CLASS;

interface StrategyKindPickerProps {
  value: StrategyKind;
  onChange: (v: StrategyKind) => void;
}

const StrategyKindPicker: React.FC<StrategyKindPickerProps> = ({ value, onChange }) => (
  <SegmentedRadioGroup<StrategyKind>
    ariaLabel="Withdrawal strategy"
    options={STRATEGY_OPTIONS}
    value={value}
    onChange={onChange}
  />
);

interface CostBasisFieldProps {
  value: number;
  onChange: (v: number) => void;
}

const CostBasisField: React.FC<CostBasisFieldProps> = ({ value, onChange }) => (
  <div className="flex flex-col gap-2">
    <label htmlFor="cost-basis-pct" className="text-sm font-medium">
      Return of principal (taxable accounts)
    </label>
    <RangeSlider
      id="cost-basis-pct"
      ariaLabel="Return of principal (taxable accounts)"
      min={0}
      max={100}
      step={5}
      value={value}
      onChange={onChange}
      formatValue={(v) => `${v}%`}
      formatAriaValue={(v) => `${v} percent`}
    />
    <Muted className="text-sm">
      When you sell investments in a taxable brokerage account, part of each withdrawal is the
      money you originally invested (return of principal, not taxed) and part is growth (taxed as
      long-term capital gains). This estimates the split. 50% suits a typical mature account;
      higher = more recent contributions, lower = mostly old appreciated holdings.
    </Muted>
  </div>
);

interface MagiBootstrapFieldProps {
  useEngineDefault: boolean;
  magiDraft: number;
  onToggle: (v: boolean) => void;
  onChangeMagi: (v: number) => void;
}

const MagiBootstrapField: React.FC<MagiBootstrapFieldProps> = ({
  useEngineDefault,
  magiDraft,
  onToggle,
  onChangeMagi,
}) => (
  <div className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">Pre-retirement income (Medicare surcharge lookback)</h3>
    <ToggleSwitch label="Use engine default" checked={useEngineDefault} onChange={onToggle} />
    {!useEngineDefault && (
      <label className="flex items-center gap-3">
        <span className="flex-1 text-sm">
          Gross annual income from your last working year
        </span>
        <div className="w-1/5 min-w-0">
          <MoneyInput
            variant="cell"
            ariaLabel="Gross annual income from your last working year"
            value={magiDraft}
            onChange={onChangeMagi}
            allowNegative={false}
          />
        </div>
      </label>
    )}
    <Muted className="text-sm">
      Medicare&apos;s IRMAA premium surcharge is set by looking at your tax return from 2 years
      prior. For the first two retirement years the projection needs a stand-in for that
      pre-retirement income. Toggle on (default) lets the engine estimate, which works for most
      users. Toggle off to enter your gross annual income from your last working year. Only
      matters if you&apos;ll be on Medicare in the first two retirement years.
    </Muted>
  </div>
);

export interface WithdrawalStrategyEditorProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  householdId: string;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  /** Route to return to (the scenario detail page). Cancel navigates here unguarded. */
  backPath: string;
  /** Persist succeeded — the page re-fetches the version-bumped scenario. */
  onSaved: () => Promise<void>;
}

export const WithdrawalStrategyEditor: React.FC<WithdrawalStrategyEditorProps> = ({
  scenario,
  scenarios,
  householdId,
  accounts,
  members,
  incomeStreams,
  backPath,
  onSaved,
}) => {
  const {
    draft: {
      strategyKind, costBasisPct, useEngineDefault, magiDraft,
      tiers, excludedAccountIds,
      magiCapEnabled, magiCapWindows,
    },
    localOverrides,
    effective,
    magiCapInheritedFromName,
    parentCap,
    setStrategyKind,
    setCostBasisPct,
    handleToggleEngineDefault,
    setMagiDraft,
    setTierState,
    setMagiCapEnabled,
    setMagiCapWindows,
    isDirty,
  } = useWithdrawalStrategyDraft(scenario, scenarios, accounts);

  const rothAccounts = useMemo(
    () =>
      rothConversionTargets(accounts).map((a) => ({
        id: a.id,
        name: a.payload.name,
      })),
    [accounts],
  );

  // The scenario's real primary retirement year/month, so a ladder mixing retirementStart and absolute windows resolves overlap against the engine's baseline.
  const retirementAnchor = useMemo(
    () => resolveScenarioRetirementAnchor(scenario, scenarios, members),
    [scenario, scenarios, members],
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cbpInfoRows = useMemo(
    () => buildCbpInfoRows(scenario, scenarios, accounts, incomeStreams),
    [scenario, scenarios, accounts, incomeStreams],
  );

  // The global pushState/replaceState patch also intercepts the page's breadcrumb <Link>.
  const { pendingNavModal, navigateUnguarded } = useUnsavedChangesGuard(isDirty);

  // Navigating away while dirty is intercepted by the guard's pushState patch and surfaces the Stay/Leave prompt.
  const navigate = useNavigate();
  const handleElectPayout = useCallback(
    (account: Aggregate<AccountPayload>) => {
      navigate(incomeAddPath(account));
    },
    [navigate],
  );
  // Duplicate-stream remediation reviews existing pensions on the Income page; adding another stream would deepen the duplication.
  const handleReviewPensions = useCallback(() => {
    navigate('/income');
  }, [navigate]);

  // CBP accounts are never orderable: an all-CBP household has nothing unplaced and falls through to the empty-tier message.
  const validationError = useMemo((): string | null => {
    if (strategyKind !== 'customOrder') return null;
    const allActiveAccounts = accounts.filter((a) => a.payload.active);
    if (allActiveAccounts.length === 0) {
      return 'Add at least one account before configuring custom order.';
    }
    const placeableAccounts = allActiveAccounts.filter(
      (a) => a.payload.type !== 'RETIREMENT_CASH_BALANCE',
    );
    const placed = new Set<string>();
    for (const tier of tiers) for (const id of tier) placed.add(id);
    for (const id of excludedAccountIds) placed.add(id);
    const unplaced = placeableAccounts.filter((a) => !placed.has(a.id));
    if (unplaced.length > 0) {
      return 'Place every account into a tier or the Excluded section before saving.';
    }
    if (tiers.every((t) => t.length === 0)) {
      return 'Place at least one account in a drawdown tier. Accounts in Excluded are never drawn from.';
    }
    const tierFlat = tiers.flat();
    const seen = new Set<string>();
    for (const id of tierFlat) {
      if (seen.has(id)) return 'Each account may appear in only one tier.';
      seen.add(id);
    }
    for (const id of excludedAccountIds) {
      if (seen.has(id)) return 'An account cannot be both in a tier and Excluded.';
    }
    return null;
  }, [strategyKind, accounts, tiers, excludedAccountIds]);

  const magiCapDollarsError = useMemo((): string | null => {
    if (!magiCapEnabled) return null;
    return magiCapWindowsSaveError(magiCapWindows, members, retirementAnchor);
  }, [magiCapEnabled, magiCapWindows, members, retirementAnchor]);

  const canSave = isDirty && !validationError && !magiCapDollarsError;

  const onSave = async (): Promise<void> => {
    if (!isDirty) return;
    if (validationError || magiCapDollarsError) {
      setError(validationError ?? magiCapDollarsError);
      return;
    }
    setSubmitting(true);
    setError(null);
    // Save, notify and reload under one `submitting`; a reload-only failure (save already durable) gets a distinct message and never re-routes into the save-failed path.
    let savedOk = false;
    try {
      // Strip both split lookback keys first so a "Use engine default" save deletes them.
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: binding exists only to strip the key from restOverrides
        magiBootstrapLookbackMinus2: _omitMagi2,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: binding exists only to strip the key from restOverrides
        magiBootstrapLookbackMinus1: _omitMagi1,
        ...restOverrides
      } = localOverrides;
      const nextOverrides = {
        ...restOverrides,
        ...buildNextStrategy({ strategyKind, effective, localOverrides }),
        ...buildNextCostBasis({ costBasisPct, effective, localOverrides }),
        ...buildNextMagiBootstrap({ useEngineDefault, magiDraft }),
        ...buildNextCustomOrder({
          strategyKind,
          tiers,
          excludedAccountIds,
          effective,
          localOverrides,
          accounts,
        }),
        ...buildNextMagiCap({
          magiCapEnabled,
          magiCapWindows,
          localOverrides,
          parentCap,
        }),
      };
      await saveScenario({
        scenario,
        payload: { ...scenario.payload, overrides: nextOverrides },
        householdId,
      });
      savedOk = true;
      await onSaved();
    } catch (e) {
      setError(
        savedOk
          ? 'Saved, but refreshing failed — your change is safe.'
          : e instanceof Error
            ? e.message
            : 'Failed to save.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultSelectedKey="strategy">
        <TabList aria-label="Withdrawal strategy sections" className="flex border-b border-line">
          <Tab id="strategy" className={TAB_CLASS}>
            Strategy
          </Tab>
          <Tab
            id="custom"
            className={TAB_CLASS}
            isDisabled={strategyKind !== 'customOrder'}
          >
            Custom order
          </Tab>
          <Tab id="cap" className={TAB_CLASS}>
            MAGI cap
          </Tab>
          <Tab id="advanced" className={TAB_CLASS}>
            Advanced
          </Tab>
        </TabList>

        <TabPanel id="strategy" className={TAB_PANEL_CLASS}>
          <div className="flex flex-col gap-2">
            <StrategyKindPicker value={strategyKind} onChange={setStrategyKind} />
            <Muted as="p" className="text-sm">
              {STRATEGY_DESCRIPTIONS[strategyKind]}
            </Muted>
          </div>
        </TabPanel>

        <TabPanel id="custom" className={TAB_PANEL_CLASS}>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Custom drawdown order</h3>
            <TierEditor
              tiers={tiers}
              excludedAccountIds={excludedAccountIds}
              accounts={accounts}
              cbpInfoRows={cbpInfoRows}
              onChange={setTierState}
              onElectPayout={handleElectPayout}
              onReviewPensions={handleReviewPensions}
            />
          </div>
        </TabPanel>

        <TabPanel id="cap" className={TAB_PANEL_CLASS}>
          <MagiCapSection
            enabled={magiCapEnabled}
            windows={magiCapWindows}
            members={members}
            retirementAnchor={retirementAnchor}
            rothAccounts={rothAccounts}
            inheritedFromName={magiCapInheritedFromName}
            onToggle={setMagiCapEnabled}
            onWindowsChange={setMagiCapWindows}
          />
        </TabPanel>

        <TabPanel id="advanced" className={TAB_PANEL_CLASS}>
          <CostBasisField value={costBasisPct} onChange={setCostBasisPct} />
          <MagiBootstrapField
            useEngineDefault={useEngineDefault}
            magiDraft={magiDraft}
            onToggle={handleToggleEngineDefault}
            onChangeMagi={setMagiDraft}
          />
        </TabPanel>
      </Tabs>

      {(validationError || magiCapDollarsError || error) && (
        <Alert tone="error">{validationError ?? magiCapDollarsError ?? error}</Alert>
      )}
      <div className="flex justify-start gap-2">
        <button
          type="button"
          className={btnPrimaryClass}
          onClick={onSave}
          disabled={submitting || !canSave}
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className={btnSecondaryClass}
          onClick={() => navigateUnguarded(backPath)}
        >
          Cancel
        </button>
      </div>
      {pendingNavModal}
    </div>
  );
};
