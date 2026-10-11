/**
 * ExpenseCategoriesPage render + mutation tests. Drives the page
 * through fake-indexeddb so listAggregates + queueLocalMutation run
 * end-to-end. Auth/Sync contexts mocked at the module boundary.
 */
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  listAggregates,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import type { Aggregate, ExpenseCategoryPayload, ExpensePayload } from '../db/types';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ExpenseCategoriesPage } from './ExpenseCategoriesPage';

const HH = 'hh-test';

function setupContexts(): void {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
    hasRole: () => false,
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ExpenseCategoriesPage />
    </MemoryRouter>,
  );
}

async function seedCategory(
  id: string,
  name: string,
  version = 1,
  isMedical = false,
): Promise<void> {
  const row: Aggregate<ExpenseCategoryPayload> = {
    id,
    householdId: HH,
    aggregateType: 'expenseCategory',
    schemaVersion: 2,
    version,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: isMedical ? { name, isMedical: true } : { name },
  };
  await putAggregate('expenseCategory', row);
}

async function seedExpense(id: string, name: string, categoryId: string): Promise<void> {
  const row: Aggregate<ExpensePayload> = {
    id,
    householdId: HH,
    aggregateType: 'expense',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      categoryId,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  };
  await putAggregate('expense', row);
}

describe('ExpenseCategoriesPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders categories alphabetically', async () => {
    await seedCategory('cat-z', 'Zoo');
    await seedCategory('cat-a', 'Apples');
    await seedCategory('cat-m', 'medical');
    renderPage();
    await screen.findByText('Apples');
    const items = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('strong')?.textContent);
    expect(items).toEqual(['Apples', 'medical', 'Zoo']);
  });

  it('Add category modal queues a create mutation with the trimmed name', async () => {
    await seedCategory('cat-1', 'Existing');
    renderPage();
    await screen.findByText('Existing');
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Hobbies  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });
    await waitFor(async () => {
      const cats = (await listAggregates('expenseCategory')) as Aggregate<
        ExpenseCategoryPayload
      >[];
      expect(cats.find((c) => c.payload.name === 'Hobbies')).toBeTruthy();
    });
    const pending = await listPendingMutations();
    const create = pending.find((p) => p.operation === 'create');
    expect(create).toBeTruthy();
    expect((create!.payload as ExpenseCategoryPayload).name).toBe('Hobbies');
  });

  it('Add modal blocks duplicate name (case-folded, trimmed)', async () => {
    await seedCategory('cat-1', 'Insurance');
    renderPage();
    await screen.findByText('Insurance');
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  insurance ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });
    expect(
      await screen.findByText(/A category named "insurance" already exists/),
    ).toBeInTheDocument();
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(0);
  });

  it('Rename queues an update mutation', async () => {
    await seedCategory('cat-1', 'Housing');
    renderPage();
    await screen.findByText('Housing');
    fireEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    const input = screen.getByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Home' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const update = pending.find((p) => p.operation === 'update');
      expect(update).toBeTruthy();
      expect((update!.payload as ExpenseCategoryPayload).name).toBe('Home');
    });
  });

  it('the isMedical control is a ToggleSwitch (role="switch") in the Add modal', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Add category' });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    expect(
      screen.getByRole('switch', { name: 'Medical category' }),
    ).toBeInTheDocument();
  });

  it('Add with the Medical toggle on persists isMedical: true', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Add category' });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Care' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Medical category' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const create = pending.find((p) => p.operation === 'create');
      expect((create?.payload as ExpenseCategoryPayload).isMedical).toBe(true);
    });
  });

  it('Rename preserves the medical flag (regression guard for the {name}-only write)', async () => {
    await seedCategory('cat-medical', 'Medical', 1, true);
    renderPage();
    await screen.findByText('Medical', { selector: 'strong' });
    fireEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    // The toggle reflects the persisted flag.
    expect(screen.getByRole('switch', { name: 'Medical category' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Healthcare' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const update = pending.find((p) => p.operation === 'update');
      expect((update?.payload as ExpenseCategoryPayload).name).toBe('Healthcare');
      expect((update?.payload as ExpenseCategoryPayload).isMedical).toBe(true);
    });
  });

  it('a flag-only edit marks the modal dirty (participates in the unsaved-edits guard)', async () => {
    await seedCategory('cat-1', 'Food', 1, false);
    renderPage();
    await screen.findByText('Food');
    fireEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    // Flip ONLY the toggle (name unchanged). Save becomes visible when dirty.
    fireEvent.click(screen.getByRole('switch', { name: 'Medical category' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const update = pending.find((p) => p.operation === 'update');
      expect((update?.payload as ExpenseCategoryPayload).isMedical).toBe(true);
    });
  });

  it('renders a "Medical" badge on flagged rows only', async () => {
    await seedCategory('cat-medical', 'Medical', 1, true);
    await seedCategory('cat-food', 'Food', 1, false);
    renderPage();
    await screen.findByText('Food');
    const medicalRow = screen
      .getAllByRole('listitem')
      .find((li) => li.querySelector('strong')?.textContent === 'Medical');
    const foodRow = screen
      .getAllByRole('listitem')
      .find((li) => li.querySelector('strong')?.textContent === 'Food');
    expect(medicalRow?.textContent).toContain('Medical');
    expect(within(medicalRow!).getByText('Medical', { selector: 'span' })).toBeInTheDocument();
    expect(within(foodRow!).queryByText('Medical', { selector: 'span' })).toBeNull();
  });

  it('a11y smoke: the Add modal with the switch present has no violations', async () => {
    const { container } = renderPage();
    await screen.findByRole('button', { name: 'Add category' });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await screen.findByRole('switch', { name: 'Medical category' });
    await expectNoA11yViolations(container);
  });

  it('Delete queues a delete mutation when category is unused', async () => {
    await seedCategory('cat-1', 'Misc');
    renderPage();
    await screen.findByText('Misc');
    // Click the row's Delete button to open the in-app confirm modal
    // (replaced window.confirm for consistency with other pages).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
    });
    // The shared confirm (useConfirm) is a React Aria alertdialog;
    // it renders its own Delete button — pick that one.
    const dialog = await screen.findByRole('alertdialog');
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Delete',
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const del = pending.find((p) => p.operation === 'delete');
      expect(del).toBeTruthy();
      expect(del!.aggregateId).toBe('cat-1');
    });
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    renderPage();
    expect(await screen.findByText(/No categories yet/i)).toBeInTheDocument();

    // A single-row write fires only the per-store fine signal — no
    // notifyWorkspaceChanged() — proving the useAggregates subscription wakes.
    await act(async () => {
      await seedCategory('cat-1', 'Housing');
    });

    await waitFor(() =>
      expect(screen.getByText('Housing')).toBeInTheDocument(),
    );
  });
});

// Characterization net for the BlockOnDeleteDialog extraction.
// These exercise the *existing local* dialog and must stay green
// through the extraction so the refactor is provably byte-identical.
describe('ExpenseCategoriesPage — block-on-delete dialog (characterization)', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('opens the block dialog (count + reference rows + Close) and queues no delete', async () => {
    await seedCategory('cat-housing', 'Housing');
    await seedExpense('exp-rent', 'Rent', 'cat-housing');
    renderPage();
    await screen.findByText('Housing');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cannot delete "Housing"');
    expect(dialog).toHaveTextContent("It's used by 1 expense:");
    expect(dialog).toHaveTextContent('Rent (canonical)');
    expect(dialog).toHaveTextContent('Re-categorise these first, then try again.');
    expect(
      Array.from(dialog.querySelectorAll('button')).some(
        (b) => b.textContent?.trim() === 'Close',
      ),
    ).toBe(true);
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.operation === 'delete')).toBeUndefined();
  });

  it('caps the reference list at 20 and shows "+ N more"', async () => {
    await seedCategory('cat-food', 'Food');
    for (let i = 0; i < 25; i++) {
      await seedExpense(`exp-${i}`, `Meal ${i}`, 'cat-food');
    }
    renderPage();
    await screen.findByText('Food');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("It's used by 25 expenses:");
    expect(dialog.querySelectorAll('ul li')).toHaveLength(21); // 20 rows + residual
    expect(dialog).toHaveTextContent('+ 5 more');
  });

  it('Close dismisses the block dialog', async () => {
    await seedCategory('cat-medical', 'Medical');
    await seedExpense('exp-rx', 'Prescriptions', 'cat-medical');
    renderPage();
    await screen.findByText('Medical');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
    });
    const dialog = await screen.findByRole('dialog');
    const closeBtn = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Close',
    );
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(closeBtn!);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
