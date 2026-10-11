/**
 * Scenario-level per-account minimum-balance floor editor at
 * /scenarios/:id/floors. Mirrors the
 * Returns / Contributions per-account override sub-screens.
 *
 * Only floor-eligible accounts are listed — the engine predicate is
 * `taxTreatment ∈ {POST_TAX, HSA}`; the presentational gate keeps
 * the row set in sync (BROKERAGE / SAVINGS / MONEY_MARKET / CD / OTHER /
 * HSA all resolve to POST_TAX or HSA). Pre-tax / Roth accounts never
 * appear.
 *
 * Each row carries a dollar floor (a `<MoneyInput>`; "no floor" is the
 * unset state, surfaced as a "No floor" (set-one) affordance — `null`
 * clears an inherited floor). HSA rows additionally carry a
 * `emergencyOnly` / `strict` mode toggle; POST_TAX accounts ignore
 * the mode and show no toggle.
 *
 * Floors are stored in NOMINAL dollars — they do not inflation-
 * adjust, so a static disclosure note states the real value erodes over
 * long horizons.
 *
 * Trim on save: a row whose draft equals the inherited baseline on BOTH
 * fields is dropped from the override map; the whole `accountFloors` key
 * is removed when no account carries an override (one `saveScenario`
 * mutation). Mount-only load (no reactive `useAggregates` seed read), so a mid-edit workspace change cannot remount the editor and drop the draft;
 * dirty edits are protected by page-level
 * `useUnsavedChangesGuard`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { useAuth } from '../auth/AuthContext';
import { textLinkClass } from '../components/TextLink';
import { MoneyInput } from '../components/MoneyInput';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { TableScroll } from '../components/TableScroll';
import { Alert } from '../components/Alert';
import { Badge, badgeToneForBucket } from '../components/Badge';
import { Card } from '../components/Card';
import { Muted } from '../components/Muted';
import { RefreshIcon, CheckIcon, XIcon } from '../components/icons';
import {
  btnDangerSmClass,
  tableClass,
  thStickyClass,
  thStickyNumClass,
  tdClass,
  tdNumClass,
  breadcrumbNavClass,
  footNoteClass,
  noteClass,
} from './scenarios-page-chrome';
import { BucketBar } from './accounts-page-chrome';
import { accountBucket } from '../lib/account-bucket';
import { ACCOUNT_TYPE_LABELS } from '../api/types';
import { listAggregates } from '../db/store';
import { saveScenario } from '../lib/scenario-mutations';
import {
  resolveAccountFloorsForScenario,
  scenarioChain,
  type ResolvedAccountFloor,
  type ScenarioAggregate,
} from '../lib/scenario-resolution';
import { useSync } from '../sync/SyncContext';
import type {
  AccountPayload,
  AccountTaxTreatment,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

type HsaMode = 'emergencyOnly' | 'strict';

/**
 * Engine floor-eligibility predicate: a floor only applies to an
 * account whose `taxTreatment` is POST_TAX or HSA. The presentational
 * account-type gate (BROKERAGE / SAVINGS / MONEY_MARKET / CD / OTHER /
 * HSA) is a consequence of this — the tax treatment is the source of
 * truth, so a stray POST_TAX BROKERAGE still appears and a PRE_TAX
 * BROKERAGE never does.
 */
function isFloorEligibleTreatment(t: AccountTaxTreatment): boolean {
  return t === 'POST_TAX' || t === 'HSA';
}

/** A row draft: `floorDollars === null` means "no floor". `hsaMode` is
 *  only meaningful for HSA accounts; POST_TAX rows ignore it. */
interface FloorDraft {
  floorDollars: number | null;
  hsaMode: HsaMode;
}

/** A row with no floor and the default HSA mode (the fallback when an
 *  account has no draft yet). */
const EMPTY_DRAFT: FloorDraft = { floorDollars: null, hsaMode: 'emergencyOnly' };

/** Resolve an account's own override entry into the stored effective draft,
 *  falling through to the inherited baseline per field. A locally-overridden
 *  field wins: `null` clears (so "no floor" regardless of an inherited floor),
 *  a finite `≥ 0` number overrides, and anything else falls back to inherited;
 *  an absent field inherits. */
function resolveStoredDraft(
  ownEntry: { floorDollars?: number | null; hsaMode?: HsaMode | null } | undefined,
  inherited: FloorDraft,
): FloorDraft {
  const floorDollars =
    ownEntry && 'floorDollars' in ownEntry
      ? typeof ownEntry.floorDollars === 'number' &&
        Number.isFinite(ownEntry.floorDollars) &&
        ownEntry.floorDollars >= 0
        ? ownEntry.floorDollars
        : null
      : inherited.floorDollars;
  const hsaMode: HsaMode =
    ownEntry && 'hsaMode' in ownEntry
      ? ownEntry.hsaMode === 'strict'
        ? 'strict'
        : 'emergencyOnly'
      : inherited.hsaMode;
  return { floorDollars, hsaMode };
}

/** The inherited (parent-chain) floor for each eligible account: the
 *  baseline a row falls back to on Reset. `null` floorDollars = no
 *  inherited floor. */
function buildInheritedFloors(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: Aggregate<AccountPayload>[],
): Map<string, FloorDraft> {
  const out = new Map<string, FloorDraft>();
  // The inherited baseline is the parent chain's resolved floor (an
  // ancestor floor still applies to a child that does not override it).
  // The base scenario has no parent → no inherited floor anywhere.
  const parentId = scenario.payload.parentScenarioId;
  const resolved: Map<string, ResolvedAccountFloor> =
    parentId === null
      ? new Map()
      : resolveAccountFloorsForScenario(parentId, scenarios, accounts);
  // `resolveAccountFloorsForScenario` drops accounts with no numeric floor, so
  // a parent entry that sets ONLY `hsaMode` (no floorDollars) never appears in
  // its map. Resolve hsaMode independently by walking the parent chain for the
  // first ancestor entry that defines a mode (regardless of its floor), so an
  // inherited mode-only override is not lost.
  const parentChain =
    parentId === null ? [] : scenarioChain(parentId, scenarios);
  for (const a of accounts) {
    const r = resolved.get(a.id);
    let inheritedMode: HsaMode = r ? r.hsaMode : 'emergencyOnly';
    if (!r) {
      for (const sc of parentChain) {
        const entry = sc.payload.overrides.accountFloors?.perAccount?.[a.id];
        if (entry && 'hsaMode' in entry) {
          inheritedMode = entry.hsaMode === 'strict' ? 'strict' : 'emergencyOnly';
          break;
        }
      }
    }
    out.set(a.id, {
      floorDollars: r ? r.floorDollars : null,
      hsaMode: inheritedMode,
    });
  }
  return out;
}

/** This scenario's own (local) override entry resolved into a draft,
 *  falling through to the inherited baseline per field when the local
 *  entry omits a field. */
function buildInitialDrafts(
  scenario: ScenarioAggregate,
  inherited: Map<string, FloorDraft>,
): Map<string, FloorDraft> {
  const own = scenario.payload.overrides.accountFloors?.perAccount ?? {};
  const out = new Map<string, FloorDraft>();
  for (const [id, inh] of inherited) {
    out.set(id, resolveStoredDraft(own[id], inh));
  }
  return out;
}

function memberDisplay(m: HouseholdMemberPayload | undefined): string {
  if (!m) return '—';
  return m.firstName?.trim() || 'Member';
}

const HSA_MODE_OPTIONS: { value: HsaMode; label: string; title: string }[] = [
  {
    value: 'emergencyOnly',
    label: 'Emergency only',
    title:
      'The floor blocks only the emergency-reserve draw; medical-qualified draws may still go below it.',
  },
  {
    value: 'strict',
    label: 'Strict',
    title: 'The floor blocks all draws, including medical-qualified ones.',
  },
];

export const ScenarioFloorsPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [drafts, setDrafts] = useState<Map<string, FloorDraft>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const baselineRef = useRef<Map<string, FloorDraft>>(new Map());

  const reload = useCallback(async () => {
    try {
      const [allScenarios, allAccounts, allMembers] = await Promise.all([
        listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
        listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
        listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
      ]);
      // Only floor-eligible accounts (taxTreatment ∈ {POST_TAX, HSA})
      // are editable; ineligible types are filtered out of the row set.
      const eligibleAccounts = allAccounts
        .filter((a) => a.payload.active && isFloorEligibleTreatment(a.payload.taxTreatment))
        .sort((a, b) => a.payload.name.localeCompare(b.payload.name));
      setAccounts(eligibleAccounts);
      setMembers(allMembers);
      const found = allScenarios.find((s) => s.id === id) ?? null;
      setScenario(found);
      if (!found) {
        setError(`Scenario ${id} not found.`);
        return;
      }
      const inherited = buildInheritedFloors(found, allScenarios, eligibleAccounts);
      const initial = buildInitialDrafts(found, inherited);
      baselineRef.current = inherited;
      setDrafts(initial);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A row is dirty when its draft differs from the stored effective value
  // (this scenario's own override falling through to the inherited
  // baseline per field).
  const dirtyAccountIds = useMemo(() => {
    const own = scenario?.payload.overrides.accountFloors?.perAccount ?? {};
    const dirty: string[] = [];
    for (const a of accounts) {
      const d = drafts.get(a.id);
      const inh = baselineRef.current.get(a.id);
      if (!d || !inh) continue;
      const stored = resolveStoredDraft(own[a.id], inh);
      // hsaMode only matters for HSA rows; a POST_TAX row's mode is inert.
      const modeMatters = a.payload.taxTreatment === 'HSA';
      if (
        d.floorDollars !== stored.floorDollars ||
        (modeMatters && d.hsaMode !== stored.hsaMode)
      ) {
        dirty.push(a.id);
      }
    }
    return dirty;
  }, [accounts, drafts, scenario]);

  const isDirty = dirtyAccountIds.length > 0;
  const { pendingNavModal } = useUnsavedChangesGuard(isDirty);

  const setFloor = useCallback((accountId: string, floorDollars: number | null) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      const cur = next.get(accountId) ?? EMPTY_DRAFT;
      next.set(accountId, { ...cur, floorDollars });
      return next;
    });
  }, []);

  const setHsaMode = useCallback((accountId: string, hsaMode: HsaMode) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      const cur = next.get(accountId) ?? EMPTY_DRAFT;
      next.set(accountId, { ...cur, hsaMode });
      return next;
    });
  }, []);

  const resetRow = useCallback(
    (accountId: string) => {
      const inh = baselineRef.current.get(accountId);
      if (!inh) return;
      setDrafts((prev) => {
        const next = new Map(prev);
        next.set(accountId, { ...inh });
        return next;
      });
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!scenario || !householdId) return;
    setSaving(true);
    setError(null);
    try {
      // Rebuild perAccount: an entry is kept only when a field diverges
      // from the inherited baseline. A floor that drops below an inherited
      // floor writes an explicit `null` (clear); a numeric
      // floor writes the number; an unchanged inherited mode is omitted.
      const perAccount: Record<
        string,
        { floorDollars?: number | null; hsaMode?: HsaMode }
      > = {};
      for (const a of accounts) {
        const d = drafts.get(a.id);
        const inh = baselineRef.current.get(a.id);
        if (!d || !inh) continue;
        const entry: { floorDollars?: number | null; hsaMode?: HsaMode } = {};
        if (d.floorDollars !== inh.floorDollars) {
          // Differs from the inherited floor → persist. `null` clears an
          // inherited floor; a number overrides it.
          entry.floorDollars = d.floorDollars;
        }
        // hsaMode only persists for HSA accounts with a real floor (a
        // mode without a floor is inert noise) and only when it differs from
        // the inherited mode (POST_TAX rows never write a mode).
        if (
          a.payload.taxTreatment === 'HSA' &&
          d.floorDollars !== null &&
          d.hsaMode !== inh.hsaMode
        ) {
          entry.hsaMode = d.hsaMode;
        }
        if (Object.keys(entry).length > 0) perAccount[a.id] = entry;
      }
      const nextOverrides = { ...scenario.payload.overrides };
      if (Object.keys(perAccount).length === 0) {
        delete nextOverrides.accountFloors;
      } else {
        nextOverrides.accountFloors = { perAccount };
      }
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: nextOverrides,
      };
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [scenario, householdId, accounts, drafts, notifyPending, reload]);

  const handleResetAll = useCallback(async () => {
    if (!scenario || !householdId) return;
    if (scenario.payload.overrides.accountFloors === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const nextOverrides = { ...scenario.payload.overrides };
      delete nextOverrides.accountFloors;
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: nextOverrides,
      };
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset.');
    } finally {
      setSaving(false);
    }
  }, [scenario, householdId, notifyPending, reload]);

  if (loading) {
    return (
      <section aria-labelledby="scenario-floors-heading">
        <PageHeader title={<span id="scenario-floors-heading">Account limits</span>} />
        <LoadingState label="Loading account limits…" variant="table" />
      </section>
    );
  }

  if (error || !scenario) {
    return (
      <section aria-labelledby="scenario-floors-heading">
        <PageHeader title={<span id="scenario-floors-heading">Account limits</span>} />
        <Alert tone="error">{error ?? 'Scenario not found.'}</Alert>
        <p>
          <Link to="/scenarios" className={textLinkClass}>
            ← All scenarios
          </Link>
        </p>
      </section>
    );
  }

  const memberById = new Map(members.map((m) => [m.id, m.payload]));
  const own = scenario.payload.overrides.accountFloors?.perAccount ?? {};
  const overriddenCount = Object.keys(own).length;

  return (
    <section aria-labelledby="scenario-floors-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={`/scenarios/${id}`}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title={
          <span id="scenario-floors-heading">
            Account limits: {scenario.payload.name}
          </span>
        }
        action={
          isDirty
            ? {
                label: saving ? 'Saving…' : 'Save',
                onClick: handleSave,
                disabled: saving,
              }
            : undefined
        }
        actionIcon={<CheckIcon />}
        secondaryActions={
          isDirty
            ? [
                {
                  label: 'Cancel',
                  icon: <XIcon />,
                  // Revert edits: reload re-reads the saved overrides and
                  // resets the drafts, flipping isDirty back off.
                  onClick: () => {
                    setError(null);
                    void reload();
                  },
                  disabled: saving,
                  tone: 'neutral',
                },
              ]
            : undefined
        }
      />

      {overriddenCount > 0 && (
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            className={`${btnDangerSmClass} gap-1.5`}
            onClick={handleResetAll}
            disabled={saving}
            aria-label="Reset all account floor overrides"
          >
            <RefreshIcon />
            Reset all
          </button>
        </div>
      )}

      <div className={noteClass}>
        <p className="m-0">
          Set a minimum balance to keep in an eligible account — the drawdown
          engine never takes a discretionary withdrawal that would drop it below
          the floor. Leave a row blank for no floor. Floors are stored as a{' '}
          <strong className="font-bold text-ink">fixed dollar amount (not adjusted for inflation)</strong>{' '}
          and do not adjust for inflation, so a fixed floor protects less real
          purchasing power over long horizons.
        </p>
      </div>

      {accounts.length === 0 ? (
        <Card>
          <Muted as="p" className="m-0">
            No eligible accounts. Only taxable and HSA accounts can carry a
            floor. Add one from{' '}
            <Link to="/accounts?new" className={textLinkClass}>
              Accounts
            </Link>{' '}
            first.
          </Muted>
        </Card>
      ) : (
        <TableScroll label="Per-account minimum-balance floors">
          <Table className={tableClass} aria-label="Per-account minimum-balance floors">
            <TableHeader>
              <Column isRowHeader className={thStickyClass}>Account</Column>
              <Column className={thStickyClass}>Owner</Column>
              <Column className={thStickyClass}>Type</Column>
              <Column className={thStickyNumClass}>Minimum balance</Column>
              <Column className={thStickyClass}>HSA floor applies to</Column>
              <Column className={thStickyClass}>
                <span className="sr-only">Actions</span>
              </Column>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => {
                const d = drafts.get(a.id);
                const inh = baselineRef.current.get(a.id);
                if (!d || !inh) return null;
                const owner = memberDisplay(memberById.get(a.payload.ownerId));
                const isLocallyOverridden = own[a.id] !== undefined;
                const bucket = accountBucket(a.payload.type);
                const isHsa = a.payload.taxTreatment === 'HSA';
                return (
                  <Row key={a.id} id={a.id}>
                    {/* The name cell hosts the absolutely-positioned bucket
                        bar, so it must be `relative` (same approach as
                        AccountsPage). */}
                    <Cell className={`${tdClass} relative`}>
                      <BucketBar bucket={bucket} />
                      {a.payload.name}
                      {isLocallyOverridden && (
                        <Badge tone="modified" className="ml-2">
                          Override
                        </Badge>
                      )}
                    </Cell>
                    <Cell className={tdClass}>{a.payload.ownershipType === 'JOINT' ? 'Joint' : owner}</Cell>
                    <Cell className={tdClass}>
                      <Badge tone={badgeToneForBucket(bucket)}>
                        {ACCOUNT_TYPE_LABELS[a.payload.type]}
                      </Badge>
                    </Cell>
                    {/* Floor cell: an unset floor shows a "No floor" (set-one)
                        affordance; an explicit number shows the editable
                        MoneyInput + a clear button (which writes `null` = no
                        floor). This mirrors the contributions page's growth
                        cell so "no floor" is unambiguous (not a `$0.00`). */}
                    <Cell className={tdNumClass}>
                      {d.floorDollars === null ? (
                        <button
                          type="button"
                          className="text-xs text-accent-link underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                          onClick={() => setFloor(a.id, 0)}
                          disabled={saving}
                          aria-label={`${a.payload.name} minimum balance — no floor (set one)`}
                        >
                          No floor
                        </button>
                      ) : (
                        <span className="inline-flex items-center justify-end gap-1.5">
                          <span className="inline-block w-28 text-left">
                            <MoneyInput
                              variant="cell"
                              ariaLabel={`${a.payload.name} minimum balance`}
                              value={d.floorDollars}
                              onChange={(v) => setFloor(a.id, v)}
                              decimals={0}
                            />
                          </span>
                          <button
                            type="button"
                            className={`${btnDangerSmClass} gap-1.5`}
                            onClick={() => setFloor(a.id, null)}
                            disabled={saving}
                            aria-label={`Clear ${a.payload.name} minimum balance`}
                          >
                            <RefreshIcon />
                          </button>
                        </span>
                      )}
                    </Cell>
                    {/* HSA floor mode. Only HSA rows show the toggle;
                        POST_TAX accounts ignore the mode entirely. */}
                    <Cell className={tdClass}>
                      {isHsa ? (
                        <SegmentedRadioGroup
                          ariaLabel={`${a.payload.name} HSA floor mode`}
                          size="sm"
                          options={HSA_MODE_OPTIONS}
                          value={d.hsaMode}
                          onChange={(v) => setHsaMode(a.id, v)}
                          disabled={saving || d.floorDollars === null}
                        />
                      ) : (
                        <Muted as="span" className="text-xs">
                          —
                        </Muted>
                      )}
                    </Cell>
                    <Cell className={tdClass}>
                      {isLocallyOverridden && (
                        <button
                          type="button"
                          className={`${btnDangerSmClass} gap-1.5`}
                          onClick={() => resetRow(a.id)}
                          disabled={saving}
                          aria-label={`Reset ${a.payload.name} floor override`}
                        >
                          <RefreshIcon />
                          Reset
                        </button>
                      )}
                    </Cell>
                  </Row>
                );
              })}
            </TableBody>
          </Table>
        </TableScroll>
      )}

      {accounts.length > 0 && (
        <div className={footNoteClass}>
          {overriddenCount} of {accounts.length} eligible accounts overridden
          here.
        </div>
      )}

      {pendingNavModal}
    </section>
  );
};
