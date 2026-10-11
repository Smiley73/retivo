/**
 * UnsyncedMutationList tests. Label resolution is mocked so rows are
 * deterministic; the reason→"why" mapping, status pills, and the race guard
 * are asserted directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PendingMutation } from '../db/types';
import {
  REASON_LABEL,
  UnsyncedEditsWarningList,
  UnsyncedMutationList,
} from './UnsyncedMutationList';
import { expectNoA11yViolations } from '../test/a11y.js';

vi.mock('./mutation-label', async () => {
  const actual = await vi.importActual<typeof import('./mutation-label')>('./mutation-label');
  return { ...actual, resolveMutationLabel: vi.fn() };
});

import { resolveMutationLabel } from './mutation-label';

const resolveMock = resolveMutationLabel as unknown as ReturnType<typeof vi.fn>;

function mutation(over: Partial<PendingMutation> = {}): PendingMutation {
  return {
    id: over.id ?? `mut-${Math.random().toString(36).slice(2)}`,
    aggregateId: over.aggregateId ?? 'agg-1',
    aggregateType: over.aggregateType ?? 'scenario',
    operation: over.operation ?? 'update',
    expectedVersion: over.expectedVersion ?? 13,
    schemaVersion: over.schemaVersion ?? 1,
    payload: over.payload ?? {},
    timestamp: over.timestamp ?? Date.now(),
    deviceId: over.deviceId ?? 'dev-1',
    status: over.status ?? 'failed-conflict',
    reason: over.reason,
    currentVersion: over.currentVersion,
    currentUpdatedAt: over.currentUpdatedAt,
  };
}

describe('UnsyncedMutationList', () => {
  beforeEach(() => {
    resolveMock.mockReset();
    resolveMock.mockResolvedValue({ typeLabel: 'Scenario', name: 'Base scenario' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing for empty input', () => {
    const { container } = render(
      <UnsyncedMutationList pending={[]} conflicts={[]} failedErrors={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['CONFLICT', 'Conflict', 'Someone changed this elsewhere — refresh to get the latest'],
    ['NOT_FOUND', 'Deleted', 'This was removed on another device'],
    ['SCHEMA_MISMATCH', 'Update needed', 'Reload the app to keep syncing'],
  ] as const)(
    'renders a conflict row for reason %s with reason-accurate pill + why + name, no operation/version tokens',
    async (reason, pillLabel, why) => {
      render(
        <UnsyncedMutationList
          pending={[]}
          conflicts={[mutation({ reason, operation: 'update', expectedVersion: 13 })]}
          failedErrors={[]}
        />,
      );
      const pill = screen.getByText(pillLabel);
      expect(pill).toBeInTheDocument();
      if (reason !== 'CONFLICT') {
        // NOT_FOUND / SCHEMA_MISMATCH still keep the amber `modified` Badge
        // tone (`text-warning` is unique to that tone in TONE_CLASS).
        expect(pill.className).toContain('text-warning');
      }
      expect(screen.getByText(why)).toBeInTheDocument();
      // The raw operation + expectedVersion tokens no longer render.
      expect(screen.queryByText('update')).toBeNull();
      expect(screen.queryByText(/^v\d+$/)).toBeNull();
      // Name resolves asynchronously.
      expect(await screen.findByText('Base scenario')).toBeInTheDocument();
    },
  );

  it('shows the queued relative time with a title carrying the exact local time', async () => {
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: 'CONFLICT', timestamp: Date.now() - 5 * 60_000 })]}
        failedErrors={[]}
      />,
    );
    const queued = screen.getByText('queued 5m ago');
    expect(queued).toBeInTheDocument();
    expect(queued).toHaveAttribute('title');
    expect(queued.getAttribute('title')).not.toBe('');
    await screen.findByText('Base scenario');
  });

  it('a pending row shows the Pending pill, the queued time, and no explanation line', () => {
    render(
      <UnsyncedMutationList
        pending={[mutation({ status: 'pending', operation: 'create' })]}
        conflicts={[]}
        failedErrors={[]}
      />,
    );
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/^queued /)).toBeInTheDocument();
    expect(screen.queryByText('Someone changed this elsewhere — refresh to get the latest')).toBeNull();
    expect(screen.queryByText('This was removed on another device')).toBeNull();
    expect(screen.queryByText('Reload the app to keep syncing')).toBeNull();
  });

  it('a failed-error row shows the Error pill', () => {
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[]}
        failedErrors={[mutation({ status: 'failed-error' })]}
      />,
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('a conflict with no persisted reason shows the Conflict pill but no "why" line', async () => {
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: undefined })]}
        failedErrors={[]}
      />,
    );
    expect(screen.getByText('Conflict')).toBeInTheDocument();
    // Name still resolves; no explanation line renders for a reasonless conflict.
    expect(await screen.findByText('Base scenario')).toBeInTheDocument();
    expect(
      screen.queryByText('Someone changed this elsewhere — refresh to get the latest'),
    ).toBeNull();
    expect(screen.queryByText('This was removed on another device')).toBeNull();
    expect(screen.queryByText('Reload the app to keep syncing')).toBeNull();
  });

  it('renders the resolved label detail as secondary text (· detail)', async () => {
    resolveMock.mockResolvedValue({
      typeLabel: 'Account balance',
      name: 'John 401(k)',
      detail: '2026',
    });
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ aggregateType: 'accountBalance', reason: 'CONFLICT' })]}
        failedErrors={[]}
      />,
    );
    expect(await screen.findByText('John 401(k)')).toBeInTheDocument();
    const detail = screen.getByText('2026');
    expect(detail.textContent).toBe('2026');
    // The middot separator is decorative-only (aria-hidden), matching the
    // row-2 "why" separator — a screen reader announces "2026", not "· 2026".
    const separator = detail.previousElementSibling;
    expect(separator).toHaveAttribute('aria-hidden', 'true');
    expect(separator?.textContent).toBe('·');
  });

  it('paints the native :focus-visible ring on the keyboard-focusable region', async () => {
    // Regression: the region used the React-Aria-only `data-[focus-visible]`
    // variant, which a plain focusable <div> never receives — so keyboard
    // focus had NO visible indicator (WCAG 2.2 AA). The native
    // `focus-visible:` variant DOES apply to a focusable div.
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: 'CONFLICT' })]}
        failedErrors={[]}
      />,
    );
    const region = screen.getByRole('region', { name: 'Unsynced items' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toContain('focus-visible:ring-2');
    expect(region.className).toContain('focus-visible:ring-ring');
    expect(region.className).not.toContain('data-[focus-visible]');
    // Flush the async label resolution so its setState lands inside act().
    await screen.findByText('Base scenario');
  });

  it('prunes the label for a row removed on rerender, leaving the survivor intact', async () => {
    resolveMock.mockImplementation(
      async (m: PendingMutation): Promise<{ typeLabel: string; name: string }> => ({
        typeLabel: 'Scenario',
        name: m.id === 'keep' ? 'Keep me' : 'Drop me',
      }),
    );
    const keep = mutation({ id: 'keep', reason: 'CONFLICT' });
    const drop = mutation({ id: 'drop', reason: 'CONFLICT' });
    const { rerender } = render(
      <UnsyncedMutationList pending={[]} conflicts={[keep, drop]} failedErrors={[]} />,
    );
    expect(await screen.findByText('Keep me')).toBeInTheDocument();
    expect(await screen.findByText('Drop me')).toBeInTheDocument();

    rerender(<UnsyncedMutationList pending={[]} conflicts={[keep]} failedErrors={[]} />);
    await waitFor(() => expect(screen.queryByText('Drop me')).toBeNull());
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });

  it('does not write state after unmounting mid-resolution (race guard)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let settle: (value: { typeLabel: string; name: string }) => void = () => {};
    resolveMock.mockReturnValue(
      new Promise<{ typeLabel: string; name: string }>((resolve) => {
        settle = resolve;
      }),
    );
    const { unmount } = render(
      <UnsyncedMutationList pending={[mutation()]} conflicts={[]} failedErrors={[]} />,
    );
    unmount();
    // Settle after unmount — the cancellation flag must gate the setState.
    await act(async () => {
      settle({ typeLabel: 'Scenario', name: 'Late name' });
      await Promise.resolve();
    });
    // A post-unmount state write would log React's act/unmounted-update warning.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('orders conflicts first, then failed-errors, then pending', async () => {
    resolveMock.mockImplementation(
      async (m: PendingMutation): Promise<{ typeLabel: string; name: string }> => ({
        typeLabel: 'Scenario',
        name: m.id,
      }),
    );
    render(
      <UnsyncedMutationList
        pending={[mutation({ id: 'p1', status: 'pending' })]}
        conflicts={[mutation({ id: 'c1', reason: 'CONFLICT' })]}
        failedErrors={[mutation({ id: 'e1', status: 'failed-error' })]}
      />,
    );
    await waitFor(() => expect(screen.getByText('c1')).toBeInTheDocument());
    const names = screen.getAllByText(/^[cpe]1$/).map((el) => el.textContent);
    expect(names).toEqual(['c1', 'e1', 'p1']);
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: 'CONFLICT' })]}
        failedErrors={[]}
      />,
    );
    await screen.findByText('Base scenario');
    await expectNoA11yViolations(container);
  });

  // ── Resolve control (injected callback) ──────────────────────────

  it('renders no Resolve control when no resolveConflict callback is injected', async () => {
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: 'CONFLICT', currentVersion: 14 })]}
        failedErrors={[]}
      />,
    );
    await screen.findByText('Base scenario');
    expect(screen.queryByRole('button', { name: 'Keep mine' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('renders Keep mine / Discard on a conflict row and keep calls resolveConflict(mutation, "keep")', async () => {
    const user = userEvent.setup();
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const conflict = mutation({ reason: 'CONFLICT', currentVersion: 14 });
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[conflict]}
        failedErrors={[]}
        resolveConflict={resolveConflict}
      />,
    );
    await screen.findByText('Base scenario');
    await user.click(screen.getByRole('button', { name: /^Keep mine/ }));
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    expect(resolveConflict).toHaveBeenCalledWith(conflict, 'keep');
  });

  it('composes each Resolve button accessible name from the row resolved item so screen readers tell rows apart', async () => {
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: 'CONFLICT', currentVersion: 14 })]}
        failedErrors={[]}
        resolveConflict={vi.fn()}
      />,
    );
    // Wait for the async label to resolve so the accessible name carries the
    // resolved type + name, not the raw-id fallback.
    await screen.findByText('Base scenario');
    // The accessible NAME disambiguates the row (verb + resolved type + name)…
    expect(
      screen.getByRole('button', { name: 'Keep mine — Scenario Base scenario' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Discard — Scenario Base scenario' }),
    ).toBeInTheDocument();
    // …while the visible button TEXT stays the short generic verb.
    expect(screen.getByText('Keep mine')).toBeInTheDocument();
    expect(screen.getByText('Discard')).toBeInTheDocument();
  });

  it('a legacy conflict (no persisted server version) disables keep/discard with a host-agnostic Check & repair hint', async () => {
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: 'CONFLICT', currentVersion: undefined })]}
        failedErrors={[]}
        resolveConflict={vi.fn()}
      />,
    );
    await screen.findByText('Base scenario');
    expect(screen.getByRole('button', { name: /^Keep mine/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Discard —/ })).toBeDisabled();
    // Host-agnostic: names where Check & repair lives (correct on the badge
    // popover, which has no Check & repair button of its own).
    expect(
      screen.getByText('Use Check & repair (Settings → Workspace) to enable'),
    ).toBeInTheDocument();
  });

  it('discard opens a confirm dialog naming the exact edit, then calls resolveConflict(mutation, "discard")', async () => {
    const user = userEvent.setup();
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const conflict = mutation({ reason: 'CONFLICT', currentVersion: 14 });
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[conflict]}
        failedErrors={[]}
        resolveConflict={resolveConflict}
      />,
    );
    await screen.findByText('Base scenario');
    await user.click(screen.getByRole('button', { name: /^Discard —/ }));
    // Warn-before-discard names the item (resolved label) + the REASON_LABEL phrase.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Scenario Base scenario');
    expect(dialog).toHaveTextContent(REASON_LABEL.CONFLICT);
    // The discard has NOT run until the user confirms.
    expect(resolveConflict).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard my change' }));
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith(conflict, 'discard'));
  });

  it('surfaces a recovery hint when a discard leaves the conflict unresolved (the wedge)', async () => {
    const user = userEvent.setup();
    // resolveConflict resolves void without removing the row (wedge / did not
    // converge), so the conflict persists and the row surfaces the hint.
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const conflict = mutation({ reason: 'CONFLICT', currentVersion: 14 });
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[conflict]}
        failedErrors={[]}
        resolveConflict={resolveConflict}
      />,
    );
    await screen.findByText('Base scenario');
    await user.click(screen.getByRole('button', { name: /^Discard —/ }));
    await user.click(await screen.findByRole('button', { name: 'Discard my change' }));
    expect(
      await screen.findByText(/Couldn't discard — keep your change, or use Reload from server\./),
    ).toBeInTheDocument();
  });

  it('renders the keep-error row message when resolveConflict rejects on keep', async () => {
    const user = userEvent.setup();
    const resolveConflict = vi.fn().mockRejectedValue(new Error('keep boom'));
    const conflict = mutation({ reason: 'CONFLICT', currentVersion: 14 });
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[conflict]}
        failedErrors={[]}
        resolveConflict={resolveConflict}
      />,
    );
    await screen.findByText('Base scenario');
    await user.click(screen.getByRole('button', { name: /^Keep mine/ }));
    expect(
      await screen.findByText("Couldn't keep your change. Please try again."),
    ).toBeInTheDocument();
  });

  it('renders the discard-error row message when resolveConflict rejects on discard', async () => {
    const user = userEvent.setup();
    const resolveConflict = vi.fn().mockRejectedValue(new Error('discard boom'));
    const conflict = mutation({ reason: 'CONFLICT', currentVersion: 14 });
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[conflict]}
        failedErrors={[]}
        resolveConflict={resolveConflict}
      />,
    );
    await screen.findByText('Base scenario');
    await user.click(screen.getByRole('button', { name: /^Discard —/ }));
    await user.click(await screen.findByRole('button', { name: 'Discard my change' }));
    expect(
      await screen.findByText("Couldn't discard your change. Please try again."),
    ).toBeInTheDocument();
  });

  it('has no a11y violations with the Resolve control and the warn dialog open', async () => {
    const user = userEvent.setup();
    render(
      <UnsyncedMutationList
        pending={[]}
        conflicts={[mutation({ reason: 'CONFLICT', currentVersion: 14 })]}
        failedErrors={[]}
        resolveConflict={vi.fn()}
      />,
    );
    await screen.findByText('Base scenario');
    await user.click(screen.getByRole('button', { name: /^Discard —/ }));
    const dialog = await screen.findByRole('alertdialog');
    await expectNoA11yViolations(dialog);
  });
});

describe('UnsyncedEditsWarningList', () => {
  beforeEach(() => {
    resolveMock.mockReset();
    resolveMock.mockResolvedValue({ typeLabel: 'Scenario', name: 'Base scenario' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing for an empty list (zero-unsynced dialog reads as before)', () => {
    const { container } = render(<UnsyncedEditsWarningList mutations={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each un-synced edit with its resolved label and a plain-English status', async () => {
    render(
      <UnsyncedEditsWarningList
        mutations={[
          mutation({ id: 'c', reason: 'CONFLICT' }),
          mutation({ id: 'p', status: 'pending', reason: undefined }),
        ]}
      />,
    );
    // Two rows, both resolving to the mocked name.
    await waitFor(() => expect(screen.getAllByText('Base scenario')).toHaveLength(2));
    // A conflict names its reason; a plain pending edit reads "not yet synced".
    expect(screen.getByText(new RegExp(REASON_LABEL.CONFLICT))).toBeInTheDocument();
    expect(screen.getByText(/not yet synced/)).toBeInTheDocument();
  });

  it('caps a long list in a named, keyboard-focusable region with no a11y violations', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      mutation({ id: `edit-${i}`, reason: 'CONFLICT' }),
    );
    const { container } = render(<UnsyncedEditsWarningList mutations={many} />);
    await waitFor(() => expect(screen.getAllByText('Base scenario')).toHaveLength(12));
    // The height-capped scroll region is a named landmark and keyboard-focusable
    // (WCAG 2.1.1 keyboard + 4.1.2 name/role), with the native focus-visible ring.
    const region = screen.getByRole('region', {
      name: 'Unsynced edits that will be discarded',
    });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toContain('overflow-y-auto');
    expect(region.className).toContain('focus-visible:ring-2');
    expect(region.className).toContain('focus-visible:ring-ring');
    await expectNoA11yViolations(container);
  });
});
