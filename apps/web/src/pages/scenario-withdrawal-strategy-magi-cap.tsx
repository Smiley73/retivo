/** MAGI-cap window schedule editor: the cap toggle and an ordered list of non-overlapping windows (anchors, ceiling, Fill/Minimize mode, MAGI line, target Roth), with inline overlap and required-ceiling validation (blocks save) and broken-anchor and Fill-no-target notices. */
import React, { useState } from 'react';
import {
  Input,
  Radio,
  RadioGroup,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
} from 'react-aria-components';
import { MoneyInput, parseCurrencyInput } from '../components/MoneyInput';
import { ScheduleAnchorPicker } from '../components/ScheduleAnchorPicker';
import { TAB_CLASS, TAB_PANEL_CLASS } from '../components/tab-chrome';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { Select } from '../components/Select';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { textLinkClass } from '../components/TextLink';
import { IRMAA_TIERS } from '../lib/irmaa-tiers';
import { ACA_PTC_PARAMETERS } from '../lib/aca-ptc-parameters';
import {
  glideAnchorToMagiCapEnd,
  glideAnchorToMagiCapStart,
  magiCapEndToGlideAnchor,
  magiCapStartToGlideAnchor,
} from '../lib/schedule-anchor-bridge';
import type { DraftMagiCapWindow } from './scenario-withdrawal-strategy-shared';
import { defaultMagiCapWindow } from './scenario-withdrawal-strategy-shared';
import {
  magiCapWindowOverlapError,
  magiCapWindowTabLabels,
  magiCapWindowTimeframeError,
  type MagiCapRetirementAnchor,
} from './scenario-withdrawal-strategy-magi-cap-validation';
import type {
  Aggregate,
  HouseholdMemberPayload,
  MagiCapLine,
  MagiCapMode,
} from '../db/types';

// Mirrors MoneyInput's INPUT_CLASS so the unset-state placeholder input looks identical.
const MONEY_INPUT_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-right text-sm font-mono tabular-nums text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';
const GRID_LABEL_CLASS = 'text-sm font-medium text-ink';

const CAP_MODE_CARD_CLASS =
  'flex cursor-pointer items-start gap-3 rounded-md border border-input-line p-3 ' +
  'text-sm text-ink transition-colors hover:border-accent/60 ' +
  'data-[selected]:border-accent data-[selected]:bg-accent-subtle ' +
  'data-[focus-visible]:outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring';

const CAP_MODE_OPTIONS: { value: MagiCapMode; label: string; title: string }[] = [
  {
    value: 'minimize',
    label: 'Keep my income low',
    title: 'Draw from post-tax / Roth first; convert nothing.',
  },
  {
    value: 'fill',
    label: 'Fill the cheap tax room with Roth conversions',
    title: 'Draw pre-tax up to the ceiling, then convert the leftover room into the target Roth.',
  },
];

const CAP_LINE_OPTIONS: { value: MagiCapLine; label: string }[] = [
  { value: 'irmaa', label: 'Medicare (IRMAA) income' },
  { value: 'aca', label: 'ACA marketplace income' },
];

function latestSnapshotYear(values: Readonly<Record<number, unknown>>): number {
  return Math.max(...Object.keys(values).map((y) => Number(y)));
}

/** The cliff threshold (whole dollars) the entered ceiling is compared against, from the live calibration snapshots; null when no table is available. */
export function resolveCliffThreshold(
  line: MagiCapLine,
  memberCount: number,
): number | null {
  if (line === 'irmaa') {
    const year = latestSnapshotYear(IRMAA_TIERS.values);
    const table = IRMAA_TIERS.values[year];
    if (!table) return null;
    const entries = memberCount >= 2 ? table.byMfj : table.bySingle;
    return entries[0].thresholdDollars;
  }
  const year = latestSnapshotYear(ACA_PTC_PARAMETERS.values);
  const table = ACA_PTC_PARAMETERS.values[year];
  if (!table) return null;
  const householdSize = Math.max(1, memberCount);
  const fplAnnual = table.fpl.base + (householdSize - 1) * table.fpl.increment;
  return Math.round(fplAnnual * 4);
}

export interface MagiCapSectionProps {
  enabled: boolean;
  windows: DraftMagiCapWindow[];
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** The same baseline the engine uses, so overlap math is correct for a mixed retirementStart + absolute ladder. */
  retirementAnchor: MagiCapRetirementAnchor;
  rothAccounts: ReadonlyArray<{ id: string; name: string }>;
  inheritedFromName?: string | null;
  onToggle: (v: boolean) => void;
  onWindowsChange: (v: DraftMagiCapWindow[]) => void;
}

// An empty React Aria field while null, so the user sees it needs entry rather than "$0.00"; MoneyInput once committed.
const CeilingInput: React.FC<{
  index: number;
  value: number | null;
  onChange: (v: number | null) => void;
}> = ({ index, value, onChange }) => {
  const [nullDraft, setNullDraft] = useState('');
  if (value === null) {
    return (
      <TextField
        value={nullDraft}
        onChange={setNullDraft}
        className="min-w-0"
        onBlur={() => {
          const parsed = parseCurrencyInput(nullDraft);
          if (parsed !== null && parsed >= 0) onChange(parsed);
        }}
      >
        <Input
          id={`magi-cap-dollars-${index}`}
          aria-label={`Annual Max window ${index + 1}`}
          inputMode="decimal"
          pattern="[0-9]*[.,]?[0-9]*"
          className={MONEY_INPUT_CLASS}
        />
      </TextField>
    );
  }
  return (
    <MoneyInput
      variant="cell"
      ariaLabel={`Annual Max window ${index + 1}`}
      value={value}
      onChange={(v) => onChange(v)}
      allowNegative={false}
    />
  );
};

const WindowFields: React.FC<{
  index: number;
  window: DraftMagiCapWindow;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  rothAccounts: ReadonlyArray<{ id: string; name: string }>;
  onChange: (next: DraftMagiCapWindow) => void;
}> = ({ index, window: w, members, rothAccounts, onChange }) => {
  const hasRoth = rothAccounts.length > 0;
  const cliffThreshold = resolveCliffThreshold(w.capMagiLine, members.length);
  const overCliff =
    w.magiCeilingAnnualDollars !== null &&
    cliffThreshold !== null &&
    w.magiCeilingAnnualDollars > cliffThreshold;
  // A Fill window with no eligible target Roth converts $0: match on the eligible list, not on "an id is set", so a window saved against a since-deleted, deactivated or inherited Roth IRA says so (the engine's findTargetRothIndex refuses it).
  const fillNoTarget =
    w.capMode === 'fill' &&
    !rothAccounts.some((a) => a.id === w.targetRothAccountId);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`magi-cap-dollars-${index}`} className={GRID_LABEL_CLASS}>
          Annual Max
        </label>
        <div className="min-w-0 max-w-36">
          <CeilingInput
            index={index}
            value={w.magiCeilingAnnualDollars}
            onChange={(v) => onChange({ ...w, magiCeilingAnnualDollars: v })}
          />
        </div>
        {w.magiCeilingAnnualDollars === null && (
          <Muted className="text-sm">Enter an annual cap to save this scenario.</Muted>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className={GRID_LABEL_CLASS}>What to do with the cap room</span>
        <RadioGroup
          aria-label={`Income-cap behavior mode window ${index + 1}`}
          value={w.capMode}
          onChange={(v) => onChange({ ...w, capMode: v as MagiCapMode })}
          className="flex flex-col gap-2"
        >
          {CAP_MODE_OPTIONS.map((opt) => (
            <Radio key={opt.value} value={opt.value} className={CAP_MODE_CARD_CLASS}>
              {({ isSelected }) => (
                <>
                  <span
                    aria-hidden
                    className={
                      isSelected
                        ? 'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-accent'
                        : 'mt-0.5 size-4 shrink-0 rounded-full border border-input-line'
                    }
                  >
                    {isSelected && <span className="size-2 rounded-full bg-accent-ink" />}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-xs text-muted">{opt.title}</span>
                  </span>
                </>
              )}
            </Radio>
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`magi-cap-line-${index}`} className={GRID_LABEL_CLASS}>
          Which income line to track
        </label>
        <Select
          id={`magi-cap-line-${index}`}
          value={w.capMagiLine}
          onChange={(v) => onChange({ ...w, capMagiLine: v as MagiCapLine })}
          options={CAP_LINE_OPTIONS}
        />
      </div>
      {w.capMode === 'fill' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`magi-cap-target-roth-${index}`} className={GRID_LABEL_CLASS}>
            Roth account to receive conversions
          </label>
          <Select
            id={`magi-cap-target-roth-${index}`}
            ariaLabel={`Roth account to receive conversions window ${index + 1}`}
            value={w.targetRothAccountId ?? ''}
            onChange={(v) =>
              onChange({ ...w, targetRothAccountId: v === '' ? undefined : v })
            }
            options={[
              { value: '', label: hasRoth ? 'Select a Roth account…' : 'No Roth account' },
              ...rothAccounts.map((a) => ({ value: a.id, label: a.name })),
            ]}
            disabled={!hasRoth}
          />
          {fillNoTarget && (
            <Muted className="text-sm">
              {hasRoth
                ? 'Select a Roth account above — until then this window fills the cap with withdrawals only (no conversions).'
                : 'Add a Roth account to your plan, then select it here to enable automatic conversions.'}
            </Muted>
          )}
        </div>
      )}
      {overCliff && cliffThreshold !== null && (
        <Alert tone="warning">
          The cap (${w.magiCeilingAnnualDollars?.toLocaleString()}) sits above the{' '}
          {w.capMagiLine === 'irmaa'
            ? `first Medicare IRMAA surcharge bracket (about $${cliffThreshold.toLocaleString()})`
            : `ACA 400%-of-poverty line (about $${cliffThreshold.toLocaleString()})`}
          , so it may not keep your{' '}
          {w.capMagiLine === 'irmaa' ? 'Medicare premiums' : 'ACA subsidy'} where you
          expect. Lower the cap to stay under that line.
        </Alert>
      )}
    </div>
  );
};

const WindowEditor: React.FC<{
  index: number;
  window: DraftMagiCapWindow;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  rothAccounts: ReadonlyArray<{ id: string; name: string }>;
  onChange: (next: DraftMagiCapWindow) => void;
  onRemove: () => void;
}> = ({ index, window: w, members, rothAccounts, onChange, onRemove }) => (
  <div className="flex flex-col gap-3">
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onRemove}
        className="text-sm font-medium text-negative hover:text-negative/80"
        aria-label={`Remove window ${index + 1}`}
      >
        Remove this window
      </button>
    </div>
    <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
      <div className="min-w-0">
        <WindowFields
          index={index}
          window={w}
          members={members}
          rothAccounts={rothAccounts}
          onChange={onChange}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <ScheduleAnchorPicker
          label="Cap starts"
          members={members}
          value={magiCapStartToGlideAnchor(w.start)}
          onChange={(a) => onChange({ ...w, start: glideAnchorToMagiCapStart(a) })}
        />
        <ScheduleAnchorPicker
          label="Cap ends"
          members={members}
          hideRetirementStart
          value={magiCapEndToGlideAnchor(w.end)}
          onChange={(a) => onChange({ ...w, end: glideAnchorToMagiCapEnd(a) })}
        />
      </div>
    </div>
  </div>
);

export const MagiCapSection: React.FC<MagiCapSectionProps> = ({
  enabled, windows, members, retirementAnchor,
  rothAccounts, inheritedFromName, onToggle, onWindowsChange,
}) => {
  const timeframeError = magiCapWindowTimeframeError(windows, members, retirementAnchor);
  const overlapError = magiCapWindowOverlapError(windows, members, retirementAnchor);
  const tabLabels = magiCapWindowTabLabels(windows, members, retirementAnchor);
  // Clamped on render so an external window reset never leaves a dangling key.
  const [selectedKey, setSelectedKey] = useState('0');
  const activeKey = String(Math.min(Math.max(0, Number(selectedKey)), windows.length - 1));

  const updateWindow = (index: number, next: DraftMagiCapWindow): void => {
    onWindowsChange(windows.map((w, i) => (i === index ? next : w)));
  };
  const removeWindow = (index: number): void => {
    onWindowsChange(windows.filter((_, i) => i !== index));
    setSelectedKey((prev) => {
      const p = Number(prev);
      if (p > index) return String(p - 1);
      if (p === index) return String(Math.max(0, index - 1));
      return prev;
    });
  };
  const addWindow = (): void => {
    onWindowsChange([...windows, defaultMagiCapWindow()]);
    setSelectedKey(String(windows.length)); // focus the freshly added window
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">MAGI cap schedule (pre-tax withdrawal limits)</h3>
      <ToggleSwitch
        label="Limit pre-tax withdrawals with a MAGI cap schedule"
        checked={enabled}
        onChange={onToggle}
      />
      {inheritedFromName && (
        <Muted className="text-sm">
          MAGI cap inherited from {inheritedFromName}. Editing here overrides it
          for this scenario only; turning it off disables the cap for this
          scenario.
        </Muted>
      )}
      {enabled && (
        <div className="flex flex-col gap-3 pl-2">
          {timeframeError && (
            <Alert tone="error" role="alert">
              {timeframeError}
            </Alert>
          )}
          {overlapError && (
            <Alert tone="error" role="alert">
              {overlapError}
            </Alert>
          )}
          <div>
            <button type="button" onClick={addWindow} className={`${textLinkClass} text-sm`}>
              Add another window
            </button>
          </div>
          {windows.length > 0 && (
            <Tabs
              selectedKey={activeKey}
              onSelectionChange={(k) => setSelectedKey(String(k))}
            >
              <TabList aria-label="Cap windows" className="flex flex-wrap gap-1 border-b border-line">
                {windows.map((_w, i) => (
                  <Tab key={i} id={String(i)} className={TAB_CLASS}>
                    {tabLabels[i]}
                  </Tab>
                ))}
              </TabList>
              {windows.map((w, i) => (
                <TabPanel key={i} id={String(i)} className={TAB_PANEL_CLASS}>
                  <WindowEditor
                    index={i}
                    window={w}
                    members={members}
                    rothAccounts={rothAccounts}
                    onChange={(next) => updateWindow(i, next)}
                    onRemove={() => removeWindow(i)}
                  />
                </TabPanel>
              ))}
            </Tabs>
          )}
          <Muted className="text-sm">
            Each window limits your total pre-tax income — pre-tax withdrawals
            plus any Roth conversions — over its own stretch of years. Windows
            must not overlap; gaps between them mean no cap that year.
            &ldquo;Keep my income low&rdquo; draws from taxable and Roth accounts
            first; &ldquo;Fill the cheap tax room&rdquo; uses up the room under
            the cap with Roth conversions to shrink later taxes. A breach warning
            appears on the Balance Projection page if taxable runs dry before a
            window&apos;s cap is met.
          </Muted>
        </div>
      )}
    </div>
  );
};
