/**
 * HouseholdReadyBanner — render + the two-key dismiss/demo-load behavior +
 * a11y smoke (AGENTS shared-component axe mandate).
 *
 * Verifies: the "Load demo data" button + dismiss control render; dismiss
 * writes the dismissed key, clears the pending key, and calls onDismiss;
 * "Load demo data" does the same two-key write then calls loadDemoData.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/demo-data-loader', () => ({
  loadDemoData: vi.fn().mockResolvedValue(undefined),
}));

import { HouseholdReadyBanner } from './HouseholdReadyBanner';
import { loadDemoData } from '../lib/demo-data-loader';
import { expectNoA11yViolations } from '../test/a11y';

const loadDemoDataMock = loadDemoData as unknown as ReturnType<typeof vi.fn>;
const PENDING_KEY = 'retivo:household-ready-banner-pending:hh-1';
const DISMISSED_KEY = 'retivo:household-ready-banner-dismissed:hh-1';

function renderBanner(onDismiss = vi.fn()) {
  render(
    <HouseholdReadyBanner
      householdId="hh-1"
      email="me@example.test"
      displayName="Me"
      onDismiss={onDismiss}
    />,
  );
  return onDismiss;
}

describe('HouseholdReadyBanner', () => {
  let originalLocation: Location;

  beforeEach(() => {
    localStorage.setItem(PENDING_KEY, '1');
    // jsdom no-ops reload() and its `window.location` is non-configurable;
    // replace `location` with a mockable copy (idiom from VersionBanner /
    // WorkspacePage tests) so the post-load hard reload is observable.
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: vi.fn() },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('renders the load-demo button and a dismiss control', () => {
    renderBanner();
    expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('dismiss clears the pending key, sets the dismissed key, and calls onDismiss', async () => {
    const user = userEvent.setup();
    const onDismiss = renderBanner();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(loadDemoDataMock).not.toHaveBeenCalled();
  });

  it('load demo data does the two-key write then loads the demo dataset', async () => {
    const user = userEvent.setup();
    const onDismiss = renderBanner();
    await user.click(screen.getByRole('button', { name: 'Load demo data' }));
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
    expect(loadDemoDataMock).toHaveBeenCalledWith({
      householdId: 'hh-1',
      email: 'me@example.test',
      displayName: 'Me',
    });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    // Hard reload fires after a successful load so every page re-reads the
    // demo aggregates.
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload (and surfaces an error) when the demo load fails', async () => {
    loadDemoDataMock.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    const onDismiss = renderBanner();
    await user.click(screen.getByRole('button', { name: 'Load demo data' }));
    await screen.findByRole('alert');
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <HouseholdReadyBanner
        householdId="hh-1"
        email="me@example.test"
        displayName="Me"
        onDismiss={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
