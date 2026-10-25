/** MobileNavDrawer: overlay drawer focus trap, dismissal, scroll lock and the desktop-breakpoint hand-off. */
import React, { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileNavDrawer } from './MobileNavDrawer';
import { expectNoA11yViolations } from '../test/a11y';

// The matchMedia stub in test/setup.ts never matches; override it per test for the (min-width: 1024px) query.
function setViewport(isDesktop: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: isDesktop && query.includes('min-width: 1024px'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function installControllableMatchMedia(initialDesktop: boolean): {
  setDesktop: (next: boolean) => void;
} {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let matches = initialDesktop;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches && query.includes('min-width: 1024px');
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    setDesktop(next: boolean): void {
      matches = next;
      for (const cb of listeners) {
        cb({ matches: next } as MediaQueryListEvent);
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setViewport(false);
});

function Harness({
  startOpen = true,
}: {
  startOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open menu
      </button>
      <MobileNavDrawer isOpen={open} onClose={() => setOpen(false)}>
        <nav aria-label="Primary navigation">
          <button type="button">Dashboard</button>
          <button type="button">Accounts</button>
        </nav>
      </MobileNavDrawer>
    </>
  );
}

describe('MobileNavDrawer', () => {
  it('renders nothing when closed', () => {
    render(<Harness startOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('renders a labelled dialog with the nav content when open', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Primary navigation');
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('locks page scroll while open and releases it on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.documentElement.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(document.documentElement.style.overflow).not.toBe('hidden');
  });

  it('closes on Escape and restores focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness startOpen={false} />);
    const opener = screen.getByRole('button', { name: 'Open menu' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('traps focus inside the dialog while open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    const dashboard = screen.getByRole('button', { name: 'Dashboard' });
    const accounts = screen.getByRole('button', { name: 'Accounts' });
    dashboard.focus();
    expect(dashboard).toHaveFocus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(accounts).toHaveFocus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(dashboard).toHaveFocus();
  });

  it('is not an active trapping modal at the desktop breakpoint', async () => {
    setViewport(true);
    const onClose = vi.fn();
    render(
      <MobileNavDrawer isOpen onClose={onClose}>
        <nav aria-label="Primary navigation">
          <button type="button">Dashboard</button>
        </nav>
      </MobileNavDrawer>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.documentElement.style.overflow).not.toBe('hidden');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('unmounts the trap and asks to close when resized mobile→desktop while open', async () => {
    const media = installControllableMatchMedia(false);
    const onClose = vi.fn();
    render(
      <MobileNavDrawer isOpen onClose={onClose}>
        <nav aria-label="Primary navigation">
          <button type="button">Dashboard</button>
        </nav>
      </MobileNavDrawer>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      media.setDesktop(true);
    });

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(document.documentElement.style.overflow).not.toBe('hidden');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('closes on a scrim press', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    const overlay = dialog.closest('.fixed')!;
    await user.click(overlay);
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('auto-closes when the caller flips isOpen (route-change parity)', async () => {
    const { rerender } = render(
      <MobileNavDrawer isOpen onClose={() => {}}>
        <nav aria-label="Primary navigation">
          <button type="button">Dashboard</button>
        </nav>
      </MobileNavDrawer>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(
      <MobileNavDrawer isOpen={false} onClose={() => {}}>
        <nav aria-label="Primary navigation">
          <button type="button">Dashboard</button>
        </nav>
      </MobileNavDrawer>,
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('has no a11y violations when open', async () => {
    const { baseElement } = render(<Harness />);
    // React Aria portals the overlay outside the render container.
    await expectNoA11yViolations(baseElement);
  });
});
