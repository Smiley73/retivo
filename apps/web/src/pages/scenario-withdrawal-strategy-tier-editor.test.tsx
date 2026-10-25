// TierEditor and TierList: tier labels, account names, Add/Remove tier (a removed tier's accounts go to tier 0), the excluded list, the empty state and cross-tier moves.
import 'fake-indexeddb/auto';
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DragAndDropOptions } from 'react-aria-components';
import { TierEditor } from './scenario-withdrawal-strategy-tier-editor';
import { expectNoA11yViolations } from '../test/a11y';
import type { AccountPayload, Aggregate } from '../db/types';

// React Aria DnD does not function in jsdom, so the hook's options are captured and the drop handlers driven directly.
const dndOptions = vi.hoisted(() => [] as DragAndDropOptions[]);
vi.mock('react-aria-components', async () => {
  const actual = await vi.importActual<typeof import('react-aria-components')>('react-aria-components');
  return {
    ...actual,
    useDragAndDrop: (options: DragAndDropOptions) => {
      dndOptions.push(options);
      return actual.useDragAndDrop(options);
    },
  };
});

function makeAccount(id: string, name: string): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'hh',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    payload: {
      name,
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'member-1',
      institution: '',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 80, bondsPct: 20, cashPct: 0 },
    },
  };
}

const ACCOUNTS = [
  makeAccount('a1', 'Traditional IRA'),
  makeAccount('a2', 'Brokerage'),
];

// Restore mocks and spies after each test so React Aria's drag-and-drop global listeners (installed by useDragAndDrop) don't bleed into concurrent test files in the same worker pool.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('TierEditor — render', () => {
  it('renders tier labels for each tier', () => {
    render(
      <TierEditor
        tiers={[['a1'], ['a2']]}
        excludedAccountIds={[]}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={vi.fn()}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    // Both the header span and the GridList label match, so getAllByText asserts at least one element.
    expect(screen.getAllByText(/Tier 1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Tier 2/).length).toBeGreaterThan(0);
  });

  it('renders account names inside their respective tiers', () => {
    render(
      <TierEditor
        tiers={[['a1'], ['a2']]}
        excludedAccountIds={[]}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={vi.fn()}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    expect(screen.getByText('Traditional IRA')).toBeTruthy();
    expect(screen.getByText('Brokerage')).toBeTruthy();
  });

  it('renders excluded accounts section', () => {
    render(
      <TierEditor
        tiers={[['a1']]}
        excludedAccountIds={['a2']}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={vi.fn()}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    // Both the header span and the GridList label match /excluded/i.
    expect(screen.getAllByText(/excluded/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Brokerage')).toBeTruthy();
  });

  it('shows empty-state text when a tier has no accounts', () => {
    // excludedAccountIds is non-empty, so only tier 0 produces the empty-state text; avoids a multiple-elements error.
    render(
      <TierEditor
        tiers={[[], ['a1']]}
        excludedAccountIds={['a2']}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={vi.fn()}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    expect(screen.getByText(/no accounts/i)).toBeTruthy();
  });
});

describe('TierEditor — Add tier', () => {
  it('fires onChange with an additional empty tier when Add tier clicked', () => {
    const onChange = vi.fn();
    render(
      <TierEditor
        tiers={[['a1']]}
        excludedAccountIds={[]}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={onChange}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add tier/i }));
    expect(onChange).toHaveBeenCalledOnce();
    const [nextTiers] = onChange.mock.calls[0] as [string[][], string[]];
    expect(nextTiers).toHaveLength(2);
    expect(nextTiers[1]).toEqual([]);
  });
});

describe('TierEditor — Remove tier', () => {
  it('fires onChange with tier removed and its accounts moved to tier 0', () => {
    const onChange = vi.fn();
    render(
      <TierEditor
        tiers={[['a1'], ['a2']]}
        excludedAccountIds={[]}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={onChange}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove tier 2/i }));
    expect(onChange).toHaveBeenCalledOnce();
    const [nextTiers] = onChange.mock.calls[0] as [string[][], string[]];
    expect(nextTiers).toHaveLength(1);
    expect(nextTiers[0]).toContain('a2');
  });
});

describe('TierEditor — cross-tier move logic', () => {
  const dragItem = (id: string) => ({
    kind: 'text',
    types: new Set(['application/x-tier-account-id']),
    getText: async () => id,
  }) as never;

  function renderTiers(tiers: string[][], onChange: (tiers: string[][], excluded: string[]) => void) {
    dndOptions.length = 0;
    render(
      <TierEditor
        tiers={tiers}
        excludedAccountIds={[]}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={onChange}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    // One option set per TierList on the first render: tier-0..tier-N, then Excluded.
    return dndOptions.slice(0, tiers.length + 1);
  }

  it('moving account from tier 1 to tier 2 produces correct tier arrays', async () => {
    const onChange = vi.fn();
    const [tier0] = renderTiers([['a1'], ['a2']], onChange);
    await tier0.onInsert!({
      items: [dragItem('a2')],
      target: { type: 'item', key: 'a1', dropPosition: 'before' },
    } as never);
    expect(onChange).toHaveBeenCalledWith([['a2', 'a1'], []], []);
  });

  it('moving account to Excluded removes it from tiers', async () => {
    const onChange = vi.fn();
    const [, excluded] = renderTiers([['a1', 'a2']], onChange);
    await excluded.onRootDrop!({ items: [dragItem('a1')] } as never);
    expect(onChange).toHaveBeenCalledWith([['a2']], ['a1']);
  });

  it('moving account to end of a tier (no beforeId) appends correctly', async () => {
    const onChange = vi.fn();
    const [, tier1] = renderTiers([['a1', 'a2'], []], onChange);
    await tier1.onRootDrop!({ items: [dragItem('a1')] } as never);
    expect(onChange).toHaveBeenCalledWith([['a2'], ['a1']], []);
  });
});

describe('TierList — showOrder drain position numbers', () => {
  it('shows 1-based position prefix for each account in a drawdown tier', () => {
    // TierEditor passes showOrder to the drawdown TierLists: a single-tier scenario with two accounts renders "1." and "2." aria-hidden prefixes before the names.
    render(
      <TierEditor
        tiers={[['a1', 'a2']]}
        excludedAccountIds={[]}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={vi.fn()}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    // getByText matches substrings; the prefix span is aria-hidden but still in the DOM.
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
  });

  it('does NOT show position prefix for excluded accounts', () => {
    render(
      <TierEditor
        tiers={[[]]}
        excludedAccountIds={['a1', 'a2']}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={vi.fn()}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    expect(screen.queryByText('1.')).toBeNull();
    expect(screen.queryByText('2.')).toBeNull();
  });
});

describe('TierEditor — a11y smoke', () => {
  it('passes expectNoA11yViolations', async () => {
    const { container } = render(
      <TierEditor
        tiers={[['a1'], ['a2']]}
        excludedAccountIds={[]}
        accounts={ACCOUNTS}
        cbpInfoRows={[]}
        onChange={vi.fn()}
        onElectPayout={vi.fn()}
        onReviewPensions={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
