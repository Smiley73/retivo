/** VersionBanner: hidden until a real mismatch, Dismiss and Reload, both description variants, and re-arming an open toast. */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';

const BUILD_MISMATCH_DESCRIPTION =
  'A newer version of the app is ready. Reload to pick it up. Your local data stays intact.';
const SCHEMA_AHEAD_DESCRIPTION =
  'A newer version of the app is required to read the latest changes — reload to update.';

let deployedBuildId = 'server-2';
let banner: {
  VersionBanner: typeof import('./VersionBanner').VersionBanner;
  AppToastRegion: typeof import('./AppToastRegion').AppToastRegion;
  recordServerBuildId: typeof import('../lib/build-id').recordServerBuildId;
  recordSchemaAhead: typeof import('../lib/build-id').recordSchemaAhead;
};

// Renders both halves, as App.tsx mounts them: the subscriber (no DOM) and the shared toast region.
function renderVersionBanner() {
  const { VersionBanner, AppToastRegion } = banner;
  return render(
    <>
      <VersionBanner />
      <AppToastRegion />
    </>,
  );
}

// Drives the async path the real fetch verifier takes, then flushes microtasks so the listener fires.
async function recordVerifiedMismatch(serverId: string): Promise<void> {
  await act(async () => {
    banner.recordServerBuildId(serverId);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Both reasons fire for the same fresh id before its verification resolves; the stronger reason wins.
async function recordVerifiedSchemaAhead(serverId: string): Promise<void> {
  await act(async () => {
    banner.recordServerBuildId(serverId);
    banner.recordSchemaAhead();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function expectReloadAndDismissButtons(): void {
  expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
}

describe('VersionBanner', () => {
  // Fresh build-id module state per case; the first import is slow on a cold transform cache.
  beforeEach(async () => {
    window.sessionStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    deployedBuildId = 'server-2';
    vi.resetModules();
    vi.stubGlobal('__BUILD_ID__', 'client-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ buildId: deployedBuildId }) })),
    );
    const [{ VersionBanner }, { AppToastRegion }, { recordSchemaAhead, recordServerBuildId }] =
      await Promise.all([
        import('./VersionBanner'),
        import('./AppToastRegion'),
        import('../lib/build-id'),
      ]);
    banner = { VersionBanner, AppToastRegion, recordSchemaAhead, recordServerBuildId };
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    deployedBuildId = 'server-3';
    vi.advanceTimersByTime(5_000);
    await act(async () => {
      banner.recordServerBuildId('server-3');
      banner.recordSchemaAhead();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getAllByTestId('version-banner')).toHaveLength(1);
    expect(screen.getByText(SCHEMA_AHEAD_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(BUILD_MISMATCH_DESCRIPTION)).not.toBeInTheDocument();
    expectReloadAndDismissButtons();
  });

  it('stays hidden when the deployed bundle is still the client build', async () => {
    deployedBuildId = 'client-1';
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
    // jsdom's `window.location` is non-configurable, so replace `reload` via Object.defineProperty.
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
