/**
 * Local-dev convenience credentials. Pre-populate auth/password fields
 * with the seeded local-dev user when running against `pnpm dev` so
 * developers don't have to re-type credentials on every workspace
 * reset.
 *
 * Prefill requires a dev build (`import.meta.env.DEV`) AND a local host:
 * `localhost` / `127.0.0.1`, OR an RFC1918 private IPv4 (`10.0.0.0/8`,
 * `172.16.0.0/12`, `192.168.0.0/16`). The widened LAN case lets a phone or
 * second machine at `192.168.x.y` prefill the seeded creds too.
 *
 * Two independent guards keep this off production:
 *  1. Host (load-bearing, runtime): a real AWS deploy is served from a
 *     public CloudFront/custom domain — never localhost or a private IP — so
 *     the prefill never RENDERS on prod regardless of build mode. This is the
 *     guarantee the dev password's safety rests on.
 *  2. Build mode (build-time, defence-in-depth): the `import.meta.env.DEV`
 *     gate sits directly on the literal-bearing ternary so a production build
 *     (`NODE_ENV=production`) constant-folds it to `''` and the seeded-cred
 *     literals are dead-code eliminated from the bundle — verified by grepping
 *     `dist/` after `NODE_ENV=production … vite build`. NOTE: a bare
 *     `vite build` (no `NODE_ENV`) currently emits a DEV bundle where the
 *     literals survive (inert, still blocked by guard 1). The deploy must pin
 *     `NODE_ENV=production` for this strip to take effect.
 *
 * The creds are non-secret (committed in the repo) and the seeded dev user
 * does not exist in any production database, so even the value is inert
 * off local dev.
 *
 * Mirror of `LOCAL_DEV_EMAIL` / `LOCAL_DEV_PASSWORD` in
 * `apps/api/src/aws/local-dev-user-seed.ts` — keep both in sync if
 * you change either side.
 */

/**
 * True when `host` is an RFC1918 private IPv4 address. Plain string/range
 * checks — no library — covering the three reserved private blocks.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

// Host-only predicate: the build-mode (`import.meta.env.DEV`) gate lives on the
// module-level `prefill` expression below, where it must sit directly on the
// literal-bearing ternary for the prod-bundle dead-code strip to work.
function shouldPrefillDevCredentials(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return isPrivateIpv4(host);
}

// `import.meta.env.DEV &&` is repeated inline (not just inside the helper) so
// the minifier folds `false && … ? 'literal' : ''` down to `''` and strips the
// seeded-credential literals from the prod bundle. Folding does not reliably
// reach through the `shouldPrefillDevCredentials()` call, so the static gate
// must sit directly on the literal-bearing ternary.
const prefill = import.meta.env.DEV && shouldPrefillDevCredentials();

export const DEV_DEFAULT_EMAIL = prefill ? 'dev@local.test' : '';
export const DEV_DEFAULT_PASSWORD = prefill ? 'LocalDevPass1!' : '';
