/** SidebarScenarioPicker: select-one behaviour on the shared Select, persisted in the local store. */
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
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
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
    // clearAllStores preserves the selectedScenario pointer, so reset it or one test leaks the active scenario into the next.
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
    // React Aria composes the name as "<label> <value>"; match the stable label fragment.
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
    const user = userEvent.setup();
    await seedScenario('base', 'Base', true);
    await seedScenario('a', 'A', false, 'base');
    await seedScenario('b', 'B', false, 'a');
    renderPicker();
    const button = await screen.findByRole('button', { name: /Active Scenario/ });
    await user.click(button);
    const rows = await screen.findAllByRole('option');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveClass('pl-2');
    expect(rows[1]).toHaveClass('pl-6');
    expect(rows[2]).toHaveClass('pl-10');
  });

  it('updates on WORKSPACE_CHANGED_EVENT after scenarios are seeded (no route change)', async () => {
    const { container } = renderPicker();
    await waitFor(() => expect(container).toBeEmptyDOMElement());

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
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    await act(async () => {
      await seedScenario('base', 'Base', true);
    });

    const button = await screen.findByRole('button', {
      name: /Active Scenario/,
    });
    expect(button).toHaveTextContent('Base (Base)');
  });

  it('follows the active pointer on SELECTED_SCENARIO_CHANGED_EVENT', async () => {
    await seedScenario('base', 'Base', true);
    await seedScenario('alt', 'Aggressive', false, 'base');
    renderPicker();
    const button = await screen.findByRole('button', {
      name: /Active Scenario/,
    });
    expect(button).toHaveTextContent('Base (Base)');

    await writeSelectedScenario({
      scenarioId: 'alt',
      updatedAt: new Date().toISOString(),
    });
    await act(async () => {
      window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
    });

    await waitFor(() => expect(button).toHaveTextContent('Aggressive'));
  });

  it('closed trigger shows bare scenario name (no depth indent on trigger)', async () => {
    await seedScenario('base', 'Base', true);
    await seedScenario('a', 'A', false, 'base');
    renderPicker();
    const button = await screen.findByRole('button', { name: /Active Scenario/ });
    expect(button).toHaveTextContent('Base (Base)');
    expect(button).not.toHaveClass('pl-6');
    expect(button).not.toHaveClass('pl-10');
  });
});
