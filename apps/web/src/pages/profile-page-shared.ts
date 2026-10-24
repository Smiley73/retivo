/** Constants and helpers shared across the Preferences, Security and Workspace cards; LoginPage, the Workspace tools card and the delete-account flow import the *_NOTICE_KEY keys from here. */
import { clearSelectedScenario } from '../db/store';
import { clearMonteCarloCache } from '../db/monte-carlo-cache';

export const DELETED_NOTICE_KEY = 'retivo.auth.deletedNotice';

/** One-shot success message stashed before a workspace flow's hard reload so the notice survives it; shown once on the next mount (as DELETED_NOTICE_KEY). */
export const WORKSPACE_NOTICE_KEY = 'retivo.profile.workspaceNotice';

/** Post-reload latch set when the server cleared the workspace but could not erase the S3 backup history (historyErased: false); the Workspace page shows the "couldn't erase backups / Try again" banner once, then consumes the key. */
export const WORKSPACE_HISTORY_NOT_ERASED_KEY =
  'retivo.profile.workspaceHistoryNotErased';

export const deviceTypeLabel: Record<string, string> = {
  singleDevice: 'Device-bound',
  multiDevice: 'Synced passkey',
};

export const transportLabel: Record<string, string> = {
  internal: 'Built-in',
  usb: 'USB',
  nfc: 'NFC',
  ble: 'Bluetooth',
  hybrid: 'Cross-device',
  'smart-card': 'Smart card',
};

/** Best-effort cleanup after a successful reseed: the Monte Carlo cache and the selected-scenario pointer go stale and self-heal, so a failure is logged, not surfaced. */
export async function clearReloadFromServerLocalCaches(): Promise<void> {
  try {
    await clearMonteCarloCache();
    await clearSelectedScenario();
  } catch (err) {
    console.warn('[profile] Reload from server: post-reseed cache clear failed', err);
  }
}
