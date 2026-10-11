/**
 * Tests for VersionBanner — assert it stays hidden until a real
 * mismatch is recorded, that Dismiss removes it, that Reload triggers a
 * window reload, and that both `descriptionFor` copy variants
 * (build-mismatch / schema-ahead) render, including the re-arm branch
 * that upgrades an already-open toast when a stronger signal arrives.
 *
 * VersionBanner itself renders no DOM (it only subscribes and feeds the
 * shared `appToastQueue`); the toast
 * markup lives in `AppToastRegion`, so every test here renders BOTH,
 * exactly as `App.tsx` mounts them (region in `App`, subscriber in
 * `AppShell`). `AppToastRegion.test.tsx` covers the region's own behaviour
 * (both toast kinds sharing one region, the wait notice) directly.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionBanner } from './VersionBanner';
import { AppToastRegion } from './AppToastRegion';
import {
  __resetBuildIdState,
  __resetVerifyThrottleForTest,
  __setClientBuildIdForTest,
  __setVerifierForTest,
  recordSchemaAhead,
  recordServerBuildId,
} from '../lib/build-id';
import { expectNoA11yViolations } from '../test/a11y';

const BUILD_MISMATCH_DESCRIPTION =
  'A newer version of the app is ready. Reload to pick it up. Your local data stays intact.';
const SCHEMA_AHEAD_DESCRIPTION =
  'A newer version of the app is required to read the latest changes — reload to update.';

/** Render both halves of the relocated toast: the subscriber (no DOM) and
 *  the shared region that actually renders the markup — matching how
 *  App.tsx mounts them (VersionBanner in AppShell, AppToastRegion in App,
 *  above the routes). */
function renderVersionBanner() {
  return render(
    <>
      <VersionBanner />
      <AppToastRegion />
    </>,
  );
}

/** Simulate "API said new version + CF confirms bundle is live" — drive
 *  the same async path the real fetch verifier would, then flush
 *  microtasks so the listener fires before assertions. */
async function recordVerifiedMismatch(serverId: string): Promise<void> {
  await act(async () => {
    recordServerBuildId(serverId);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Simulate the same-response race: the API response's build id and the
 *  sync layer's schema-ahead detection both fire for the same, freshly-
 *  seen id before that id's own verification resolves — `recordSchemaAhead`
 *  reads `pendingReason` fresh at resolution, so the stronger reason wins
 *  even though this is the id's first-ever notification. */
async function recordVerifiedSchemaAhead(serverId: string): Promise<void> {
  await act(async () => {
    recordServerBuildId(serverId);
    recordSchemaAhead();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Assert the shared Reload/Dismiss actions render regardless of which
 *  description copy is showing — the two reasons share one toast shape. */
function expectReloadAndDismissButtons(): void {
  expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
}

describe('VersionBanner', () => {
  beforeEach(() => {
    __resetBuildIdState();
    __setClientBuildIdForTest('client-1');
    __setVerifierForTest(async () => 'live');
  });

  afterEach(() => {
    __resetBuildIdState();
    vi.restoreAllMocks();
  });

  it('renders nothing while the build ids match', () => {
    renderVersionBanner();
    expect(screen.queryByTestId('version-banner')).not.toBeInTheDocument();
  });

  it('appears when a mismatch is recorded and verified live', async () => {
    renderVersionBanner();
    await recordVerifiedMismatch('server-2');
    expect(screen.getByTestId('version-banner')).toBeInTheDocument();
    expect(screen.getByText('New version available')).toBeInTheDocument();
  });

  it('shows the build-mismatch description for a plain version mismatch', async () => {
    renderVersionBanner();
    await recordVerifiedMismatch('server-2');
    expect(screen.getByText(BUILD_MISMATCH_DESCRIPTION)).toBeInTheDocument();
    expectReloadAndDismissButtons();
  });

  it('shows the schema-ahead description when a schema-ahead signal arrives for a freshly-seen id', async () => {
    renderVersionBanner();
    await recordVerifiedSchemaAhead('server-2');
    expect(screen.getByTestId('version-banner')).toBeInTheDocument();
    expect(screen.getByText(SCHEMA_AHEAD_DESCRIPTION)).toBeInTheDocument();
    expectReloadAndDismissButtons();
  });

  it('replaces an open build-mismatch toast with schema-ahead copy when a stronger signal supersedes it', async () => {
    renderVersionBanner();
    await recordVerifiedMismatch('server-2');
    expect(screen.getByText(BUILD_MISMATCH_DESCRIPTION)).toBeInTheDocument();

    // A newer deploy (server-3) arrives while the server-2 toast is still
    // open; before its own build-mismatch verification resolves, the sync
    // layer reports schema-ahead for that same newer id — re-arming the
    // open toast (VersionBanner's `currentReason !== mismatch.reason`
    // branch) instead of leaving the weaker build-mismatch copy showing.
    __resetVerifyThrottleForTest();
    await act(async () => {
      recordServerBuildId('server-3');
      recordSchemaAhead();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getAllByTestId('version-banner')).toHaveLength(1);
    expect(screen.getByText(SCHEMA_AHEAD_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(BUILD_MISMATCH_DESCRIPTION)).not.toBeInTheDocument();
    expectReloadAndDismissButtons();
  });

  it('stays hidden when the deployed bundle is still the client build', async () => {
    __setVerifierForTest(async () => 'old');
    renderVersionBanner();
    await recordVerifiedMismatch('server-2');
    expect(screen.queryByTestId('version-banner')).not.toBeInTheDocument();
  });

  it('disappears when the user clicks Dismiss', async () => {
    const user = userEvent.setup();
    renderVersionBanner();
    await recordVerifiedMismatch('server-2');
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('version-banner')).not.toBeInTheDocument();
  });

  it('has no a11y violations when visible', async () => {
    const { baseElement } = renderVersionBanner();
    await recordVerifiedMismatch('server-2');
    await expectNoA11yViolations(baseElement);
  });

  it('calls window.location.reload when the user clicks Reload', async () => {
    const user = userEvent.setup();
    const reloadSpy = vi.fn();
    // jsdom's `window.location` is non-configurable; replace `reload`
    // via Object.defineProperty so the spy survives strict-mode checks.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
    renderVersionBanner();
    await recordVerifiedMismatch('server-2');
    await user.click(screen.getByRole('button', { name: /reload/i }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
