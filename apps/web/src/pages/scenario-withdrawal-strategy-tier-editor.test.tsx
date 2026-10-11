/**
 * Unit tests for TierEditor and TierList components.
 *
 * Covers: renders tier labels; renders account names; Add tier fires onChange
 * with new empty tier; Remove tier fires onChange with tier removed and
 * accounts redistributed to tier 0; excluded list renders; empty list
 * empty-state text; a11y smoke.
 */
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

// Restore all vi mocks + spies after each test so React Aria's drag-and-drop
// global event listeners (installed by useDragAndDrop) don't bleed into
// concurrent test files running in the same vitest worker pool.
afterEach(() => {
  vi.restoreAllMocks();
});

// ——— Render ————————————————————————————————————————————————

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
    // Both the header span ("Tier 1 (drained first)") and the GridList label
    // ("Tier 1") match — getAllByText asserts ≥ 1 element exists.
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
    // Both the header span ("Excluded (never drawn from)") and the GridList
    // label ("Excluded accounts") match /excluded/i — getAllByText handles it.
    expect(screen.getAllByText(/excluded/i).length).toBeGreaterThan(0);
    // a2 appears inside the excluded list
    expect(screen.getByText('Brokerage')).toBeTruthy();
  });

  it('shows empty-state text when a tier has no accounts', () => {
    // excludedAccountIds is non-empty so only tier 0 produces the empty-state
    // text — avoids a getByText "multiple elements" error.
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

// ——— Add tier ——————————————————————————————————————————————

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

// ——— Remove tier ————————————————————————————————————————————

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
    // Remove button only appears when tiers.length > 1.
    fireEvent.click(screen.getByRole('button', { name: /remove tier 2/i }));
    expect(onChange).toHaveBeenCalledOnce();
    const [nextTiers] = onChange.mock.calls[0] as [string[][], string[]];
    expect(nextTiers).toHaveLength(1);
    // a2 from removed tier 2 moved to tier 0.
    expect(nextTiers[0]).toContain('a2');
  });
});

// ——— Cross-tier move ——————————————————————————————
// React Aria DnD (useDragAndDrop) does not function in jsdom — test the
// exported `moveAccountAcrossTiers` pure function directly. This is the same
// logic the DnD handlers call; testing it directly avoids jsdom DnD
// limitations AND tests the production function (not a duplicate helper).

describe('TierEditor — cross-tier move logic', () => {
  it('moving account from tier 1 to tier 2 produces correct tier arrays', () => {
    // Move a2 from tier 1 → tier 0 (before a1).
    const { tiers: nextTiers, excludedAccountIds: nextExcluded } =
      moveAccountAcrossTiers([['a1'], ['a2']], [], 'a2', 'tier-0', 'a1');
    // After move: tier 0 = [a2, a1], tier 1 = [].
    expect(nextTiers[0]).toEqual(['a2', 'a1']);
    expect(nextTiers[1]).toEqual([]);
    expect(nextExcluded).toEqual([]);
  });

  it('moving account to Excluded removes it from tiers', () => {
    // Move a1 from tier 0 → Excluded.
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

// ——— showOrder — within-tier drain position numbers ——————————————————

describe('TierList — showOrder drain position numbers', () => {
  it('shows 1-based position prefix for each account in a drawdown tier', () => {
    // TierEditor passes showOrder to drawdown TierList components; a
    // single-tier scenario with two accounts should render "1." and "2."
    // aria-hidden prefixes before the account names.
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
    // getByText uses substring matching; the span is aria-hidden but still
    // in the DOM — getByText finds it.
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
    // No position numbers on the excluded list.
    expect(screen.queryByText('1.')).toBeNull();
    expect(screen.queryByText('2.')).toBeNull();
  });
});

// ——— A11y smoke ——————————————————————————————————————————

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
