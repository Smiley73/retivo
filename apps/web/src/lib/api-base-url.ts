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
 * First match wins, resolved once at load: (1) non-empty `VITE_API_BASE_URL`, verbatim; (2) dev: `http://${location.hostname}:3001`, tried before 3 because the web port has no API;
 * (3) prod `""`: same-origin behind CloudFront `/api/*`; (4) prod unset: throws. A non-default API port needs an explicit value.
 */
export const API_BASE_URL: string = resolveApiBaseUrl();
