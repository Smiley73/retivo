// Prefills the seeded local-dev credentials on a dev build at a local host (localhost, 127.0.0.1 or an RFC1918 IPv4).
// Mirrors `LOCAL_DEV_EMAIL` / `LOCAL_DEV_PASSWORD` in `apps/api/src/aws/local-dev-user-seed.ts`: keep both in sync.

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

function shouldPrefillDevCredentials(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return isPrivateIpv4(host);
}

// Two guards keep this off production. The host check is the runtime guarantee: a real deploy is never served from localhost
// or a private IP. The `import.meta.env.DEV &&` gate must sit on this expression, ahead of the literal-bearing ternaries, so a
// `NODE_ENV=production` build folds the credentials out of the bundle; a bare `vite build` keeps them, inert behind the host
// check. The credentials are committed and non-secret, and the seeded user exists in no production database.
const prefill = import.meta.env.DEV && shouldPrefillDevCredentials();

export const DEV_DEFAULT_EMAIL = prefill ? 'dev@local.test' : '';
export const DEV_DEFAULT_PASSWORD = prefill ? 'LocalDevPass1!' : '';
