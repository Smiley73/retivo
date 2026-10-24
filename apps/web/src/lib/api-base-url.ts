// Single source of truth for the API base URL; the rule is on `API_BASE_URL`.

const API_DEFAULT_PORT = 3001;

function resolveApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL;

  if (typeof raw === 'string' && raw !== '') return raw;

  if (import.meta.env.DEV) {
    return `http://${window.location.hostname}:${API_DEFAULT_PORT}`;
  }

  if (typeof raw === 'string') return raw;

  throw new Error(
    'VITE_API_BASE_URL is not set. ' +
      'Leave it blank for local dev (the app derives the API host from the ' +
      'browser) or set "" for same-origin production deploys.',
  );
}

/**
 * API base URL, resolved once at module load; the first match wins:
 * 1. A non-empty `VITE_API_BASE_URL` is used verbatim.
 * 2. Dev with a blank or missing value derives `http://${location.hostname}:3001`,
 *    so a localhost browser and a LAN device each reach the API on the host
 *    they loaded from. This branch must run before the same-origin one: the
 *    web port has no API behind it.
 * 3. Prod with a blank value (`""`) is same-origin, behind CloudFront `/api/*`.
 * 4. Prod with a missing value throws, so a misconfigured build fails visibly.
 *
 * A non-default API port needs an explicit `VITE_API_BASE_URL`.
 */
export const API_BASE_URL: string = resolveApiBaseUrl();
