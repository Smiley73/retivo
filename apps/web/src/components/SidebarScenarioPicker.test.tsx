/**
 * SidebarScenarioPicker — select-one behaviour + a11y smoke.
 *
 * Built on the shared React Aria `<Select>`. The public contract (`React.FC`, no
 * props; reads/writes `selectedScenario` in the local IDB store;
 * renders nothing when there are no scenarios; Base scenario sorts
 * first + carries the " (Base)" suffix; selecting an option persists it
 * and notifies). These tests assert that contract through the React
 * Aria select, plus the shared-component axe rule (AGENTS mandate).
 * Interaction goes through `@testing-library/user-event`.
 */
import 'fake-indexeddb/auto';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearSelectedScenario,
  putAggregate,
  readSelectedScenario,
  writeSelectedScenario,
} from '../db/store';
import type { Aggregate, ScenarioPayload } from '../db/types';
import { notifySelectedScenarioChanged } from '../lib/scenario-mutations';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
import { useAuth } from '../auth/AuthContext';
import { SidebarScenarioPicker } from './SidebarScenarioPicker';

const HH = 'hh-test';

async function seedScenario(
  id: string,
  name: string,
  isPrimary: boolean,
  parentScenarioId: string | null = null,
): Promise<void> {
  const a: Aggregate<ScenarioPayload> = {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      description: '',
      parentScenarioId,
      isPrimary,
      notes: '',
      overrides: {},
    },
  };
  await putAggregate('scenario', a);
}

function renderPicker(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <SidebarScenarioPicker />
    </MemoryRouter>,
  );
}

describe('SidebarScenarioPicker', () => {
  beforeEach(() => {
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      householdId: HH,
      isAuthenticated: true,
    });
  });

  afterEach(async () => {
    await clearAllStores();
    // clearAllStores preserves the selectedScenario pointer (production keeps
    // it across a force-bootstrap), so reset it too — otherwise a pointer
    // written in one test leaks the active scenario into the next.
    await clearSelectedScenario();
  });

  it('renders nothing when there are no scenarios', () => {
    const { container } = renderPicker();
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole('button', { name: /Active Scenario/ }),
    ).toBeNull();
  });

  it('shows the Base scenario first with the (Base) suffix as the selection', async () => {
    await seedScenario('alt', 'Aggressive', false);
    await seedScenario('base', 'Base', true);
    renderPicker();
    // React Aria composes the select's accessible name as
    // "<label> <value>" (a screen reader announces "Active Scenario,
    // Base (Base)"); match the stable label fragment.
    const button = await screen.findByRole('button', {
      name: /Active Scenario/,
    });
    expect(button).toHaveTextContent('Base (Base)');
  });

  it('selecting an option persists it and updates the trigger', async () => {
    const user = userEvent.setup();
    await seedScenario('base', 'Base', true);
    await seedScenario('alt', 'Aggressive', false);
    renderPicker();
    const button = await screen.findByRole('button', {
      name: /Active Scenario/,
    });
    await user.click(button);
    await user.click(await screen.findByRole('option', { name: 'Aggressive' }));
    await waitFor(async () => {
      const sel = await readSelectedScenario();
      expect(sel?.scenarioId).toBe('alt');
    });
    expect(button).toHaveTextContent('Aggressive');
  });

  it('has no a11y violations', async () => {
    await seedScenario('base', 'Base', true);
    const { container } = renderPicker();
    await screen.findByRole('button', { name: /Active Scenario/ });
    await expectNoA11yViolations(container);
  });

  it('renders a 3-level Base→A→B chain with depth classes (pl-2/pl-6/pl-10)', async () => {
    // AC — indented-tree depth classes appear on open option rows.
    const user = userEvent.setup();
    await seedScenario('base', 'Base', true);
    await seedScenario('a', 'A', false, 'base');
    await seedScenario('b', 'B', false, 'a');
    renderPicker();
    const button = await screen.findByRole('button', { name: /Active Scenario/ });
    await user.click(button);
    const rows = await screen.findAllByRole('option');
    // Order: Base(Base) depth-0, A depth-1, B depth-2.
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveClass('pl-2');
    expect(rows[1]).toHaveClass('pl-6');
    expect(rows[2]).toHaveClass('pl-10');
  });

  it('updates on WORKSPACE_CHANGED_EVENT after scenarios are seeded (no route change)', async () => {
    // The always-mounted app-shell picker must refresh after the initial
    // sync bootstrap seeds scenarios, without waiting for a navigation.
    const { container } = renderPicker();
    // Empty IDB → the picker renders nothing.
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    // Sync bootstrap / demo bulk fill commits scenarios and dispatches the
    // workspace-change event while the sidebar stays mounted on the same
    // route.
    await seedScenario('base', 'Base', true);
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    const button = await screen.findByRole('button', {
      name: /Active Scenario/,
    });
    expect(button).toHaveTextContent('Base (Base)');
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    const { container } = renderPicker();
    // Empty IDB → the picker renders nothing.
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    // A single-row scenario write fires only the per-store fine signal — no
    // notifyWorkspaceChanged() — proving the useAggregates subscription wakes.
    await act(async () => {
      await seedScenario('base', 'Base', true);
    });

    const button = await screen.findByRole('button', {
      name: /Active Scenario/,
    });
    expect(button).toHaveTextContent('Base (Base)');
  });

  it('follows the active pointer on notifySelectedScenarioChanged', async () => {
    await seedScenario('base', 'Base', true);
    await seedScenario('alt', 'Aggressive', false, 'base');
    renderPicker();
    const button = await screen.findByRole('button', {
      name: /Active Scenario/,
    });
    // Default selection is the base.
    expect(button).toHaveTextContent('Base (Base)');

    // Another mounted picker (or this one elsewhere) switched the active
    // scenario: the pointer is written and SELECTED_SCENARIO_CHANGED_EVENT
    // fires. This picker re-reads the pointer and shows the new selection.
    await writeSelectedScenario({
      scenarioId: 'alt',
      updatedAt: new Date().toISOString(),
    });
    await act(async () => {
      notifySelectedScenarioChanged();
    });

    await waitFor(() => expect(button).toHaveTextContent('Aggressive'));
  });

  it('closed trigger shows bare scenario name (no depth indent on trigger)', async () => {
    // AC — trigger text is the option label only; depth affects open rows only.
    await seedScenario('base', 'Base', true);
    await seedScenario('a', 'A', false, 'base');
    renderPicker();
    // Default selection is the primary (Base (Base)).
    const button = await screen.findByRole('button', { name: /Active Scenario/ });
    expect(button).toHaveTextContent('Base (Base)');
    // The trigger element itself must NOT carry any pl-N depth class —
    // indent is for open listbox rows only.
    expect(button).not.toHaveClass('pl-6');
    expect(button).not.toHaveClass('pl-10');
  });
});
