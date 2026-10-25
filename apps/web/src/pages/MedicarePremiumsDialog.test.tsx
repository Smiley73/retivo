/** MedicarePremiumsDialog: the preview and the write path, read back from the
 *  queued mutations; `queueLocalMutation` is wrapped so a write can fail. */
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, listPendingMutations } from '../db/store';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
} from '../db/types';
import { demoExpenseDefs } from '../lib/demo-data-defs';
import { latestMedicarePremiums } from '../lib/medicare-premiums';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));
vi.mock('../sync/mutation-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync/mutation-queue')>();
  return { ...actual, queueLocalMutation: vi.fn(actual.queueLocalMutation) };
});

import { useSync } from '../sync/SyncContext';
import { queueLocalMutation } from '../sync/mutation-queue';
import { MedicarePremiumsDialog } from './MedicarePremiumsDialog';

const HH = 'hh-test';
const notifyPending = vi.fn();

function aggregate<T extends Record<string, unknown>>(
  id: string,
  type: Aggregate['aggregateType'],
  payload: T,
): Aggregate<T> {
  return {
    id,
    householdId: HH,
    aggregateType: type,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload,
  } as Aggregate<T>;
}

const member = (
  id: string,
  firstName: string,
  isPrimary: boolean,
): Aggregate<HouseholdMemberPayload> =>
  aggregate(id, 'householdMember', {
    isPrimary,
    firstName,
    lastName: 'Doe',
    email: '',
    birthdate: '1960-03-01',
  });

const MEMBERS = [member('m-john', 'John', true), member('m-jane', 'Jane', false)];
const CATEGORIES: Aggregate<ExpenseCategoryPayload>[] = [
  aggregate('cat-medical', 'expenseCategory', { name: 'Medical', isMedical: true }),
  aggregate('cat-insurance', 'expenseCategory', { name: 'Insurance' }),
];
const DEMO_EXPENSES: Aggregate<ExpensePayload>[] = demoExpenseDefs(2026).map((d) =>
  aggregate(d.id, 'expense', d.payload),
);

function renderDialog(
  expenses: ReadonlyArray<Aggregate<ExpensePayload>> = [],
  categories = CATEGORIES,
  onClose = vi.fn(),
): { onClose: ReturnType<typeof vi.fn>; baseElement: HTMLElement } {
  const { baseElement } = render(
    <MemoryRouter>
      <MedicarePremiumsDialog
        householdId={HH}
        members={MEMBERS}
        expenses={expenses}
        categories={categories}
        onClose={onClose}
      />
    </MemoryRouter>,
  );
  return { onClose, baseElement };
}

async function writtenExpenses(): Promise<ExpensePayload[]> {
  const pending = await listPendingMutations();
  return pending
    .filter((m) => m.aggregateType === 'expense' && m.operation === 'create')
    .map((m) => m.payload as ExpensePayload);
}

beforeEach(async () => {
  await clearAllStores();
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ notifyPending });
});
afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe('MedicarePremiumsDialog', () => {
  it('names the CMS year in the copy and lists a Part B and Part D row per member', async () => {
    const { baseElement } = renderDialog();
    const latest = latestMedicarePremiums();
    const dialog = await screen.findByRole('dialog', { name: 'Add Medicare premiums' });
    expect(dialog).toHaveTextContent(`${latest.year} figures`);
    for (const name of [
      'John Medicare Part B',
      'John Medicare Part D',
      'Jane Medicare Part B',
      'Jane Medicare Part D',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeChecked();
    }
    expect(screen.getByRole('textbox', { name: 'John Medicare Part B monthly amount' })).toHaveValue(
      latest.partBStandardMonthly.toFixed(2),
    );
    expect(screen.getByRole('textbox', { name: 'Jane Medicare Part D monthly amount' })).toHaveValue(
      latest.partDNationalBaseMonthly.toFixed(2),
    );
    expect(dialog).toHaveTextContent(/Medigap and Medicare Advantage premiums/);
    await expectNoA11yViolations(baseElement);
  });

  it('labels each reference amount as the standard Part B or national base Part D premium', async () => {
    renderDialog();
    const latest = latestMedicarePremiums();
    const dialog = await screen.findByRole('dialog', { name: 'Add Medicare premiums' });
    const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    expect(dialog).toHaveTextContent(
      `Standard ${latest.year} premium: ${money(latest.partBStandardMonthly)} a month.`,
    );
    expect(dialog).toHaveTextContent(
      `National base ${latest.year} premium: ${money(latest.partDNationalBaseMonthly)} a month.`,
    );
    expect(dialog).not.toHaveTextContent(/built-in/i);
  });

  it('tells the person the Part D amount is a benchmark, not their plan price, and says nothing of the kind for Part B', async () => {
    renderDialog();
    await screen.findByRole('dialog', { name: 'Add Medicare premiums' });
    const benchmark = /Your plan sets its own price; this is Medicare.s national benchmark\./;
    const partD = screen.getAllByText(/National base \d{4} premium/);
    const partB = screen.getAllByText(/Standard \d{4} premium/);
    expect(partD).toHaveLength(2);
    expect(partB).toHaveLength(2);
    for (const el of partD) expect(el).toHaveTextContent(benchmark);
    for (const el of partB) expect(el).not.toHaveTextContent(benchmark);
  });

  it('writes nothing on Cancel', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await writtenExpenses()).toEqual([]);
    expect(notifyPending).not.toHaveBeenCalled();
  });

  it('writes exactly the included rows, with an edited amount, then notifies once and closes', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(await screen.findByRole('switch', { name: 'Jane Medicare Part B' }));
    const amount = screen.getByRole('textbox', { name: 'John Medicare Part D monthly amount' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '45.5');
    await userEvent.click(screen.getByRole('button', { name: 'Add 3 premiums' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const written = await writtenExpenses();
    expect(written.map((p) => p.name).sort()).toEqual([
      'Jane Medicare Part D',
      'John Medicare Part B',
      'John Medicare Part D',
    ]);
    expect(written.find((p) => p.name === 'John Medicare Part D')).toMatchObject({
      amount: 45.5,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-medical',
      hsaQualified: true,
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
    });
    expect(notifyPending).toHaveBeenCalledTimes(1);
  });

  it('disables a row\'s amount field while its switch is off and enables it again when on', async () => {
    renderDialog();
    const toggle = await screen.findByRole('switch', { name: 'Jane Medicare Part B' });
    const amount = screen.getByRole('textbox', { name: 'Jane Medicare Part B monthly amount' });
    expect(amount).toBeEnabled();

    await userEvent.click(toggle);
    expect(amount).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'John Medicare Part B monthly amount' })).toBeEnabled();

    await userEvent.click(toggle);
    expect(amount).toBeEnabled();
  });

  it('keeps a blocked row\'s amount field disabled', async () => {
    renderDialog(DEMO_EXPENSES);
    const blocked = await screen.findAllByText('Cannot be added.');
    expect(blocked.length).toBeGreaterThan(0);
    for (const input of screen.getAllByRole('textbox', { name: /monthly amount$/ })) {
      const row = input.closest('li');
      if (row?.textContent?.includes('Cannot be added.')) expect(input).toBeDisabled();
    }
  });

  it('shows already-entered Part B rows as unchecked and blocked on the demo household', async () => {
    const { onClose } = renderDialog(DEMO_EXPENSES);
    const johnB = await screen.findByRole('switch', { name: 'John Medicare Part B' });
    expect(johnB).not.toBeChecked();
    expect(johnB).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Jane Medicare Part B' })).toBeDisabled();
    expect(screen.getAllByText(/Looks already entered/).length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(/"John Medicare Part B" in Medical/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Cannot be added/).length).toBe(2);
    expect(screen.getByRole('switch', { name: 'John Medicare Part D' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Jane Medicare Part D' })).toBeChecked();

    await userEvent.click(screen.getByRole('switch', { name: 'John Medicare Part D' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add 2 premiums' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((await writtenExpenses()).map((p) => p.name).sort()).toEqual([
      'Jane Medicare Part D',
      'John Medicare Part D',
    ]);
  });

  it('disables Confirm when nothing is included', async () => {
    renderDialog(DEMO_EXPENSES);
    await userEvent.click(await screen.findByRole('switch', { name: 'Jane Medicare Part D' }));
    expect(screen.getByRole('button', { name: 'Add 0 premiums' })).toBeDisabled();
  });

  it('says so and offers no rows when there is no Medical category', async () => {
    renderDialog([], [aggregate('cat-x', 'expenseCategory', { name: 'Medical' })]);
    expect(await screen.findByText(/no Medical expense category/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add 0 premiums' })).toBeDisabled();
  });

  it('shows an error and stays open when a write fails', async () => {
    (queueLocalMutation as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('disk full'),
    );
    const { onClose } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Add 4 premiums' }));
    expect(await screen.findByText('Failed to add the premiums.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(notifyPending).not.toHaveBeenCalled();
    expect(await writtenExpenses()).toEqual([]);
  });

  it('reports rows written before a later write fails', async () => {
    const real = (await vi.importActual<typeof import('../sync/mutation-queue')>(
      '../sync/mutation-queue',
    )).queueLocalMutation;
    const mocked = queueLocalMutation as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementationOnce(real).mockRejectedValueOnce(new Error('disk full'));
    const { onClose } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Add 4 premiums' }));
    expect(await screen.findByText(/Added 1 of 4 premiums/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(notifyPending).toHaveBeenCalledTimes(1);
  });

  it('explains instead of offering rows for a member without a birthdate', async () => {
    const noBirthday = aggregate('m-jane', 'householdMember', {
      isPrimary: false,
      firstName: 'Jane',
      lastName: 'Doe',
      email: '',
      birthdate: '',
    }) as Aggregate<HouseholdMemberPayload>;
    render(
      <MemoryRouter>
        <MedicarePremiumsDialog
          householdId={HH}
          members={[MEMBERS[0], noBirthday]}
          expenses={[]}
          categories={CATEGORIES}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Add a birthdate for Jane/)).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });
});
