/**
 * Shared data-export primitives for the Workspace "Data" card and the
 * within-delete "Export my data" interstitial (the one carve-out where export
 * silently reuses the password the user typed on the immediately preceding
 * delete step rather than prompting again).
 *
 * Both callers share the same two atomic operations so the export
 * implementation is not duplicated:
 *   - `verifyForExport(password)` — the audited re-auth (`verifyPassword` with
 *     `purpose: 'data_export'`, so the audit event always fires AND the server
 *     issues the five-minute export-authorization cookie the bootstrap/pull read
 *     below rides on; a full household download is never silent). Returns the
 *     exact access token used to mint that cookie, which the caller must pass
 *     straight through to `downloadExport` below.
 *   - `downloadExport(householdId, accessToken)` — the SERVER-AUTHORITATIVE
 *     export: it fetches + decrypts
 *     current server state under that cookie (using the SAME `accessToken`
 *     `verifyForExport` returned, never a re-read of the current token), overlays
 *     only retained unsynced local intent, preserves both variants in
 *     `unresolvedLocalChanges`, and triggers the download. Returns the count of
 *     unresolved local-change records so the completion UI can report it.
 *     Read-only — no push, no background sync, no workspace/queue write. Any
 *     failure (bad/expired cookie, network, malformed local intent) throws so
 *     the UI shows it instead of a stale/local-only file.
 *
 * They are kept separate because the two callers surface verify-vs-export
 * failures on different UI: the standalone Data-card gate tears its password
 * modal down between the two and routes an export failure to a page-level
 * notice, while the delete flow runs both in one step and routes either
 * failure to the offer-modal inline error.
 */
import { useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getCurrentAccessToken } from '../api/client';
import { API_BASE_URL } from '../lib/api-base-url';
import { exportServerData, type ExportFileFormat } from '../lib/server-data-export';
import { createExportSyncTransport } from '../sync/sync-client';
import { getRegisteredDeviceId } from '../sync/device-id';
import { fetchAccountExport } from '../lib/account-export-client';
import { decodeJwt } from '../auth/token-utils';

/**
 * Only refresh the captured access token before minting the export cookie
 * when it is within this many seconds of expiring. The export-authorization
 * cookie's own lifetime (data-export-authorization.service.ts,
 * `EXPORT_AUTHORIZATION_TTL_SEC`) matches the access-token TTL (5 min,
 * `AUTH_ACCESS_TOKEN_TTL_MIN`) by design. Refreshing unconditionally on
 * every export — regardless of how much life the current token already had
 * — created a cross-tab race: another tab's concurrent
 * `/auth/refresh` can win the rotating-refresh-cookie race and hand this
 * refresh a definitive 401, which `AuthContext` treats as a logout, even
 * though the token this tab already held was perfectly usable.
 *
 * The buffer must cover the WHOLE export, not just `verifyPassword`'s own
 * round trip: `downloadExport`'s transport deliberately never refreshes
 * mid-export (a mid-export refresh would rotate the jti and orphan the
 * already-minted export-authorization cookie), so the captured token's
 * remaining life at mint time is the effective window the export has to
 * finish in — workspace retrieval, throttling backoff, and the paged
 * `history` fetch can all add real wall-clock time. A 60s buffer only
 * covered `verifyPassword`'s own round trip and left a token with, say, 61s
 * remaining untouched even though the export could easily outlive it. 180s
 * comfortably covers a realistic export while still skipping the refresh (and
 * the cross-tab race) for a token that already has most of its life left.
 */
const EXPORT_TOKEN_REFRESH_THRESHOLD_SEC = 180;

/** Read the non-HttpOnly csrf-token cookie the sync POST retries echo. */
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|; )csrf-token=([^;]*)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function useProfileExport(): {
  verifyForExport: (password: string) => Promise<string>;
  downloadExport: (
    householdId: string,
    accessToken: string,
    format?: ExportFileFormat,
  ) => Promise<{ unresolvedCount: number }>;
} {
  const { verifyPassword, getHdk, refreshAccessToken } = useAuth();
  const verifyForExport = useCallback(
    async (password: string): Promise<string> => {
      // Refresh BEFORE re-verifying the password, but ONLY when the token
      // `downloadExport` will later be handed is actually close to expiring.
      // Without any check, a verification that lands seconds before the
      // token's natural expiry would mint the export cookie for a jti that
      // is already (or about to be) expired — and since the export
      // transport deliberately never refreshes mid-export (see the comment
      // in `downloadExport` below), that expired token then fails every
      // subsequent workspace read with no recovery. But refreshing
      // UNCONDITIONALLY (regardless of remaining TTL) opens a cross-tab
      // race: if another tab is concurrently rotating the shared refresh
      // cookie, this refresh can lose and receive a definitive 401, which
      // logs this tab out even though its already-held token was perfectly
      // usable. Checking the token's own `exp` claim first keeps
      // the freshness guarantee for the case that actually needs it while
      // skipping the refresh — and the race — otherwise. A failed/transient
      // refresh here is not fatal: it leaves the existing token untouched,
      // so `verifyPassword` still runs against whatever token was valid
      // before — no worse than not refreshing at all.
      const current = getCurrentAccessToken();
      const claims = current ? decodeJwt(current) : null;
      const remainingSec = claims?.exp !== undefined ? claims.exp - Date.now() / 1000 : 0;
      if (!current || remainingSec < EXPORT_TOKEN_REFRESH_THRESHOLD_SEC) {
        await refreshAccessToken();
      }
      await verifyPassword(password, { purpose: 'data_export' });
      // Read the access token AFTER verifyPassword (and any refresh above)
      // has settled, and hand this exact string back to the caller so it can
      // pass it straight to `downloadExport` — the same token that minted
      // the export-authorization cookie, atomically, with no second
      // independent `getCurrentAccessToken()` read in between that a
      // same-tab background refresh could have raced.
      const verified = getCurrentAccessToken();
      if (!verified) {
        throw new Error('Cannot export account data: no active session.');
      }
      return verified;
    },
    [refreshAccessToken, verifyPassword],
  );
  const downloadExport = useCallback(
    async (
      householdId: string,
      accessToken: string,
      format: ExportFileFormat = 'gzip',
    ): Promise<{ unresolvedCount: number }> => {
      const deviceId = getRegisteredDeviceId() ?? 'unknown';
      // The caller hands in the EXACT token `verifyForExport` used to mint
      // the export-authorization cookie (rather than this hook independently
      // re-reading `getCurrentAccessToken()`), so every export call —
      // workspace transport included — rides the same jti the cookie is
      // bound to even if a same-tab background refresh landed in between.
      // No refresh callback: the export-authorization cookie is bound to
      // THIS access token's jti (data-export-authorization.service.ts); a
      // mid-export refresh/replay would rotate to a new jti, orphaning the
      // cookie and breaking the later account-record fetch, which is bound
      // to this captured token. Freshness is ensured before minting the
      // cookie (verifyForExport), never during the export itself.
      if (!accessToken) {
        throw new Error('Cannot export account data: no active session.');
      }
      const transport = createExportSyncTransport({
        apiBaseUrl: API_BASE_URL,
        getAccessToken: () => accessToken,
        getCsrfToken: readCsrfToken,
        getHdk,
        householdId,
      });
      // Derive ONE absolute authorization deadline
      // from this access token's own `exp` claim — the export-authorization
      // cookie's TTL is designed to match the access-token TTL exactly (see
      // `EXPORT_TOKEN_REFRESH_THRESHOLD_SEC` above) — and thread it through
      // to the account export. Computed here, before the workspace fetch
      // (`downloadExport`'s caller in `server-data-export.ts` runs it first),
      // so a slow workspace round trip's elapsed wall-clock time is
      // correctly reflected instead of the account fetch restarting a fresh
      // window against its own start time.
      const claims = decodeJwt(accessToken);
      const deadlineAt = claims?.exp !== undefined ? claims.exp * 1000 : undefined;
      return exportServerData(
        {
          transport,
          householdId,
          deviceId,
          fetchAccount: () =>
            fetchAccountExport({ apiBaseUrl: API_BASE_URL, accessToken, deadlineAt }),
        },
        format,
      );
    },
    [getHdk],
  );
  return { verifyForExport, downloadExport };
}
