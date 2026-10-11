/**
 * MobileNavDrawer — React Aria overlay drawer behaviour + a11y smoke.
 *
 * The drawer is a React Aria `ModalOverlay`/`Modal`, so its behavior —
 * focus-trap / Esc / scrim / scroll-lock / focus-restore — is asserted
 * here rather than left to visual parity. Asserts: hidden when closed, traps
 * focus (Tab stays inside the dialog) + restores it to the opener on
 * close, Esc closes, a scrim press closes, body scroll is locked while
 * open, route-change auto-close (the caller flips `isOpen`), and — the
 * regression guard — that at the desktop breakpoint the drawer is NOT an
 * active trapping modal, plus the shared-component axe rule.
 * Interaction goes through `@testing-library/user-event`.
 */
import React, { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileNavDrawer } from './MobileNavDrawer';
import { expectNoA11yViolations } from '../test/a11y';

// Drive the `(min-width: 1024px)` desktop media query. `false` =
// mobile (drawer mounts as an active RA modal); `true` = desktop
// (drawer must render nothing). The matchMedia stub installed in
// test/setup.ts is non-matching by default; override it per test.
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

// A controllable MediaQueryList: lets a test flip `matches` and fire a
// real `change` event so the component's `addEventListener('change')`
// path (the resize-while-open regression) is exercised, not just the
// initial-render branch the static `setViewport` stub covers.
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
    // React Aria's overlay locks scroll by setting overflow:hidden on
    // the document element while a modal is open (the scroll-lock the
    // hand-rolled drawer lacked).
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
    // React Aria restores focus to the element that opened the drawer
    // (the trigger), not merely leaves it enabled — the headline
    // focus-restore a11y win the prior hand-rolled scrim lacked.
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
    // Tab cycles within the drawer's focusable children and never
    // escapes to background content (React Aria focus trap).
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(accounts).toHaveFocus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Wrapped back to the first focusable — focus stayed trapped.
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
    // At >=lg the static desktop sidebar is shown; the drawer must NOT
    // mount an RA modal (no hidden focus trap / scroll lock over the
    // visible desktop UI) and asks the caller to drop its open state.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.documentElement.style.overflow).not.toBe('hidden');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('unmounts the trap and asks to close when resized mobile→desktop while open', async () => {
    // The regression: drawer opened at mobile width, viewport then
    // grows past lg. The component must drop the active RA modal
    // (releasing focus trap + scroll lock over the now-visible desktop
    // sidebar) and ask the caller to close — driven through the
    // `change` listener, not just the initial-render branch.
    const media = installControllableMatchMedia(false);
    const onClose = vi.fn();
    render(
      <MobileNavDrawer isOpen onClose={onClose}>
        <nav aria-label="Primary navigation">
          <button type="button">Dashboard</button>
        </nav>
      </MobileNavDrawer>,
    );
    // Mobile width: the drawer is a mounted, scroll-locking RA modal.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(onClose).not.toHaveBeenCalled();

    // Cross into desktop and fire the media `change` event.
    await act(async () => {
      media.setDesktop(true);
    });

    // Trap + scroll lock released, caller asked to close.
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
    // The App shell flips `isOpen` to false on a route change
    // (location.pathname effect); the drawer must unmount. Drive that
    // by re-rendering with isOpen=false, exactly as the shell does.
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
