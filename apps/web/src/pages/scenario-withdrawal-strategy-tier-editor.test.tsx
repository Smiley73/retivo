// TierEditor and TierList: tier labels, account names, Add/Remove tier (a removed tier's accounts go to tier 0), the excluded list, the empty state and cross-tier moves.
import 'fake-indexeddb/auto';
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TierEditor, moveAccountAcrossTiers } from './scenario-withdrawal-strategy-tier-editor';
import { expectNoA11yViolations } from '../test/a11y';
import type { AccountPayload, Aggregate } from '../db/types';

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

// React Aria DnD (useDragAndDrop) does not function in jsdom, so the exported `moveAccountAcrossTiers` pure function (the logic the DnD handlers call) is tested directly.

describe('TierEditor — cross-tier move logic', () => {
  it('moving account from tier 1 to tier 2 produces correct tier arrays', () => {
    const { tiers: nextTiers, excludedAccountIds: nextExcluded } =
      moveAccountAcrossTiers([['a1'], ['a2']], [], 'a2', 'tier-0', 'a1');
    expect(nextTiers[0]).toEqual(['a2', 'a1']);
    expect(nextTiers[1]).toEqual([]);
    expect(nextExcluded).toEqual([]);
  });

  it('moving account to Excluded removes it from tiers', () => {
    const { tiers: nextTiers, excludedAccountIds: nextExcluded } =
      moveAccountAcrossTiers([['a1', 'a2']], [], 'a1', 'excluded');
    expect(nextTiers[0]).toEqual(['a2']);
    expect(nextExcluded).toEqual(['a1']);
  });

  it('moving account to end of a tier (no beforeId) appends correctly', () => {
    const { tiers: nextTiers } =
      moveAccountAcrossTiers([['a1', 'a2'], []], [], 'a1', 'tier-1');
    expect(nextTiers[0]).toEqual(['a2']);
    expect(nextTiers[1]).toEqual(['a1']);
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
