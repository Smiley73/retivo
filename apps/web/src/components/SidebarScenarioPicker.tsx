/**
 * Per-device "Viewing" picker for the scenario driving consuming pages; the pointer lives in the local-only
 * `selectedScenario` store.
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
  const scenarioQuery = useAggregates('scenario');
  const selectedScenarioRevision = useSelectedScenarioRevision();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Guards the dual-base sweep to once per mount per household: its update mutation re-fires
  // SCENARIOS_CHANGED_EVENT and would loop.
  const sweepAttemptedRef = useRef<string | null>(null);

  const scenarios = scenarioQuery.aggregates as ReadonlyArray<
    Aggregate<ScenarioPayload>
  > as ScenarioAggregate[];

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

  // Defensive sweep for more than one `isPrimary` scenario (cross-tab first-run race, imported
  // bundle); the App-shell pass can miss a dupe introduced after bootstrap.
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
