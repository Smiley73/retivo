/**
 * Cross-card shared constants + helpers for the decomposed settings pages
 * (the Preferences / Security / Workspace pages + their per-card components).
 * These live in their own module so the cards and external importers
 * (`LoginPage`) can use them without importing a page component.
 *
 * The two `*_NOTICE_KEY` constants are the canonical home for those keys —
 * `LoginPage`, the Workspace tools card, and the Security delete-account flow
 * import them directly from here.
 */
import { clearSelectedScenario } from '../db/store';
import { clearMonteCarloCache } from '../db/monte-carlo-cache';

export const DELETED_NOTICE_KEY = 'retivo.auth.deletedNotice';

/**
 * One-shot success message stashed before a workspace flow's hard reload
 * (load demo / reload from server) and shown once on the next mount. Without
 * this the SuccessNotice renders into a page that immediately reloads, so the
 * user never sees it. Same pattern as {@link DELETED_NOTICE_KEY}.
 */
export const WORKSPACE_NOTICE_KEY = 'retivo.profile.workspaceNotice';

/**
 * Post-reload latch set by the Delete-workspace-data flow when the server
 * cleared the workspace (a 2xx) but could NOT erase the S3 backup history
 * (`historyErased: false`). Because the clear DID commit, the client still
 * wipes local residue and hard-reloads to converge; this flag survives that
 * reload so the Workspace page can show the honest "couldn't erase backups /
 * Try again" banner once, then consume the key. Set alongside
 * `suppressDemoModal`; read-and-removed on the next mount.
 */
export const WORKSPACE_HISTORY_NOT_ERASED_KEY =
  'retivo.profile.workspaceHistoryNotErased';

/** Device-type → human label, used wherever a passkey row is summarised. */
export const deviceTypeLabel: Record<string, string> = {
  singleDevice: 'Device-bound',
  multiDevice: 'Synced passkey',
};

/** Authenticator transport → human label. */
export const transportLabel: Record<string, string> = {
  internal: 'Built-in',
  usb: 'USB',
  nfc: 'NFC',
  ble: 'Bluetooth',
  hybrid: 'Cross-device',
  'smart-card': 'Smart card',
};

/**
 * Best-effort post-reseed cleanup for the Workspace "Reload from server"
 * success path. `forceRefresh` leaves these two local-only caches alone, but a
 * full reseed makes them stale (the Monte Carlo results are keyed off
 * aggregate input hashes; the selected scenario pointer may reference a
 * scenario the reseed dropped). The reseed already succeeded and both
 * caches self-heal, so a failure here is logged, not surfaced — never an
 * empty catch.
 */
export async function clearReloadFromServerLocalCaches(): Promise<void> {
  try {
    await clearMonteCarloCache();
    await clearSelectedScenario();
  } catch (err) {
    console.warn('[profile] Reload from server: post-reseed cache clear failed', err);
  }
}
