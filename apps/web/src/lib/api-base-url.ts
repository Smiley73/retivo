/**
 * Single source of truth for the API base URL.
 *
 * Resolved at module load from `VITE_API_BASE_URL`. Valid shapes:
 *   - `"http://host:port"`  explicit cross-origin base (wins everywhere)
 *   - `""`  blank / unset
 *
 * Resolution (first match wins):
 *   1. A non-empty `VITE_API_BASE_URL` is used verbatim (explicit wins).
 *   2. Dev (`import.meta.env.DEV`) + blank/missing → derive
 *      `http://${window.location.hostname}:3001`. A localhost browser
 *      derives `localhost:3001`; a LAN browser derives `<lan-ip>:3001`, so
 *      each device talks to the host it loaded from with no static config.
 *   3. Prod (`import.meta.env.PROD`) + blank (`""`) → same-origin `""`
 *      (AWS deploys behind CloudFront `/api/*`).
 *   4. Prod + missing (`undefined`) → throw (fail-loud): a misconfigured
 *      build must fail visibly rather than route requests somewhere
 *      unintended.
 *
 * The env var is loaded by Vite from the repo-root `.env` (configured via
 * `envDir` in vite.config.ts) and overridden at AWS build time by
 * `bootstrap-stack.sh`. The derivation port is hardcoded to the API default
 * `3001`; anyone on a non-default API port sets `VITE_API_BASE_URL`
 * explicitly, which short-circuits derivation entirely.
 */
const API_DEFAULT_PORT = 3001;

function resolveApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL;

  // 1. Explicit value wins in every mode.
  if (typeof raw === 'string' && raw !== '') return raw;

  // 2. Dev + blank/missing: derive from the browser host so localhost and
  //    LAN devices each reach the API on the host they loaded from. Branch
  //    on dev BEFORE the same-origin/throw logic so the blank dev default
  //    doesn't slip through to same-origin (the web port has no API).
  if (import.meta.env.DEV) {
    return `http://${window.location.hostname}:${API_DEFAULT_PORT}`;
  }

  // 3. Prod + blank: same-origin (CloudFront `/api/*`).
  if (typeof raw === 'string') return raw;

  // 4. Prod + missing: configuration bug → fail loud.
  throw new Error(
    'VITE_API_BASE_URL is not set. ' +
      'Leave it blank for local dev (the app derives the API host from the ' +
      'browser) or set "" for same-origin production deploys.',
  );
}

export const API_BASE_URL: string = resolveApiBaseUrl();
