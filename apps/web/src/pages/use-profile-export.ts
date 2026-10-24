/** Verify-and-download primitives shared by the Workspace Data card and the delete flow's export step. */
import { useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getCurrentAccessToken } from '../api/client';
import { API_BASE_URL } from '../lib/api-base-url';
import { exportServerData, type ExportFileFormat } from '../lib/server-data-export';
import { createExportSyncTransport } from '../sync/sync-client';
import { getRegisteredDeviceId } from '../sync/device-id';
import { fetchAccountExport } from '../lib/account-export-client';
import { decodeJwt } from '../auth/token-utils';

// Refresh only a near-expiry token: an unconditional refresh can lose the rotating refresh-cookie race to another tab,
// whose 401 logs this tab out. 180s covers the whole export, not just verifyPassword.
const EXPORT_TOKEN_REFRESH_THRESHOLD_SEC = 180;

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
      const current = getCurrentAccessToken();
      const claims = current ? decodeJwt(current) : null;
      const remainingSec = claims?.exp !== undefined ? claims.exp - Date.now() / 1000 : 0;
      if (!current || remainingSec < EXPORT_TOKEN_REFRESH_THRESHOLD_SEC) {
        await refreshAccessToken();
      }
      await verifyPassword(password, { purpose: 'data_export' });
      // Read the token after verifyPassword settles and pass this exact string to downloadExport: it minted the export cookie.
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
      // No refresh callback: the export cookie is bound to this token's jti, and a mid-export refresh would orphan it.
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
      // Compute one absolute deadline from the token's exp before the workspace fetch, so a slow fetch counts against it.
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
