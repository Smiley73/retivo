/**
 * Per-device "Viewing" picker for the scenario currently driving any
 * consuming page. The scenario list re-reads reactively via
 * `useAggregates('scenario')` (any scenario add/edit/delete, the initial sync
 * bootstrap, demo bulk fill); the active-scenario *pointer* is read from the
 * local-only `selectedScenario` IDB store on mount and whenever the sidebar
 * selection changes (`useSelectedScenarioRevision()`), defaulting to the base
 * when no selection exists.
 *
 * A dedicated effect retains the guarded `reconcileScenarios()` sweep:
 * a check-and-mutate write cannot live in a pure derivation, so the
 * dual-base demotion stays in its own effect with the per-mount-per-household
 * `sweepAttemptedRef` guard.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Select } from './Select';
import { useAuth } from '../auth/AuthContext';
import { listAggregates, readSelectedScenario } from '../db/store';
import {
  reconcileScenarios,
  switchSelectedScenario,
} from '../lib/scenario-mutations';
import { useAggregates } from '../lib/use-aggregates';
import { useSelectedScenarioRevision } from '../lib/use-selected-scenario-revision';
import { buildScenarioTreeOptions, scenarioOptionLabel } from '../lib/scenario-tree-options';
import type { Aggregate, ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

export const SidebarScenarioPicker: React.FC = () => {
  const { householdId } = useAuth();
  // Reactive scenario list: re-reads on any `scenario`-store write (add/edit/
  // delete, the reconcile sweep's demotions, sync bootstrap, demo bulk fill).
  const scenarioQuery = useAggregates('scenario');
  // Selected-scenario pointer channel: re-read the local pointer when the user
  // switches the active scenario from this (or another mounted) picker.
  const selectedScenarioRevision = useSelectedScenarioRevision();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Guards the defensive dual-base sweep so it only fires once per mount
  // per household — the sweep itself queues an update mutation which
  // re-fires SCENARIOS_CHANGED_EVENT and would otherwise loop.
  const sweepAttemptedRef = useRef<string | null>(null);

  const scenarios = scenarioQuery.aggregates as ReadonlyArray<
    Aggregate<ScenarioPayload>
  > as ScenarioAggregate[];

  // Resolve the active selection: the stored pointer if it still names a live
  // scenario, else the base. Re-runs on a scenario-list change and on a
  // selected-scenario pointer switch.
  useEffect(() => {
    let active = true;
    void (async () => {
      const selected = await readSelectedScenario();
      if (!active) return;
      const base = scenarios.find((s) => s.payload.isPrimary);
      const validId =
        selected && scenarios.some((s) => s.id === selected.scenarioId)
          ? selected.scenarioId
          : (base?.id ?? null);
      setSelectedId(validId);
    })();
    return () => {
      active = false;
    };
  }, [scenarios, selectedScenarioRevision]);

  // Defensive sweep (a check-and-mutate write can't live in a
  // pure derivation). If more than one `isPrimary` scenario sneaks through
  // (cross-tab first-run race, an imported bundle that already carried dupes),
  // kick `reconcileScenarios` once per mount per household to demote losers.
  // The App-shell bootstrap pass already does this, but only on first mount
  // after sync settles — that gate has been observed to miss races that
  // introduce the dupe after bootstrap has already run. The reconcile's
  // batched fine `scenario` flush wakes the reactive query, so the picker
  // reflects the demoted state without a manual re-read here.
  useEffect(() => {
    if (!householdId) return;
    if (!scenarioQuery.ready) return;
    const primaries = scenarios.filter((s) => s.payload.isPrimary);
    if (primaries.length <= 1) return;
    if (sweepAttemptedRef.current === householdId) return;
    sweepAttemptedRef.current = householdId;
    void (async () => {
      try {
        const rows = (await listAggregates('scenario')) as ScenarioAggregate[];
        await reconcileScenarios(rows, householdId);
      } catch (e) {
        console.warn('[scenarios] picker-side reconciliation failed', e);
      }
    })();
  }, [householdId, scenarios, scenarioQuery.ready]);

  const onChange = async (next: string) => {
    setSelectedId(next);
    await switchSelectedScenario(next);
  };

  if (scenarios.length === 0 || selectedId === null) return null;

  // Indented-tree order via the two-phase algorithm; isPrimary roots
  // first (carry "(Base)" suffix), depth wired to <Select> option rows.
  const treeOptions = buildScenarioTreeOptions(scenarios).map(
    ({ scenario: s, depth }) => ({
      value: s.id,
      label: scenarioOptionLabel(s),
      depth,
    }),
  );

  return (
    <div>
      {/* eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.pick-l` micro-label mock (11px / .16em tracking) */}
      <span className="mb-1 block font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
        Active Scenario
      </span>
      <Select
        ariaLabel="Active Scenario"
        value={selectedId}
        onChange={(next) => void onChange(next)}
        options={treeOptions}
      />
    </div>
  );
};
