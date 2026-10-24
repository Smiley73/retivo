// Detects a newer deployed build and raises the `<VersionBanner>` update prompt.
// The rules sit on `CLIENT_BUILD_ID`, `recordServerBuildId` and `recordSchemaAhead`.

declare global {
  /** Injected by Vite's `define`. */
  const __BUILD_ID__: string | undefined;
}

/**
 * Build id baked in at compile time. `dev` (vite-dev, vitest, or a Lambda
 * without `BUILD_ID`) never raises a mismatch, so do not rename or special-case
 * it without updating the detector.
 */
export const CLIENT_BUILD_ID: string =
  typeof __BUILD_ID__ === 'string' && __BUILD_ID__.length > 0 ? __BUILD_ID__ : 'dev';

const DISMISS_KEY = 'retivo.versionBanner.dismissedBuildId';
const VERIFY_THROTTLE_MS = 5_000;
const VERIFY_TIMEOUT_MS = 3_000;

/** `schema-ahead` is a synced row this bundle cannot read; `build-mismatch` is a routine deploy. */
export type MismatchReason = 'build-mismatch' | 'schema-ahead';

export interface VersionMismatch {
  buildId: string;
  reason: MismatchReason;
}

type Listener = (mismatch: VersionMismatch | null) => void;

type BundleVerification = 'live' | 'old' | 'unknown';

export type BundleVerifier = (serverBuildId: string) => Promise<BundleVerification>;

let currentMismatch: VersionMismatch | null = null;
let pendingServerBuildId: string | null = null;
let pendingReason: MismatchReason = 'build-mismatch';
let lastSeenServerBuildId: string | null = null;
let lastVerifyAt = 0;
let verifyInFlight = false;
const listeners = new Set<Listener>();
let activeClientId: string = CLIENT_BUILD_ID;

const defaultVerifier: BundleVerifier = async (serverBuildId) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`/build-id.json?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { buildId?: unknown };
    const deployedId = typeof json?.buildId === 'string' ? json.buildId : null;
    if (!deployedId) return 'unknown';
    if (deployedId === serverBuildId) return 'live';
    if (deployedId === activeClientId) return 'old';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
};

let verifier: BundleVerifier = defaultVerifier;

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(id: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, id);
  } catch {
        // Storage may be unavailable; the banner just re-shows.
  }
}

/** Pure comparator; a `dev` id on either side never mismatches. */
export function isMismatch(clientId: string, serverId: string | null | undefined): boolean {
  if (!serverId) return false;
  if (clientId === 'dev' || serverId === 'dev') return false;
  return clientId !== serverId;
}

/**
 * Fed the `X-Build-Id` of every API response. The banner needs two steps, so
 * it does not fire while a deploy is mid-flight:
 * 1. The server id differs from the client id and was not dismissed this
 *    session. The API flips first, so this alone prompts a reload that still
 *    loads the old bundle.
 * 2. `/build-id.json` (emitted into the bundle, served `no-cache`, invalidated
 *    on every deploy) reports the server's id, so a reload fetches the new bundle.
 *
 * Until step 2 passes it stays quiet and retries on the next response, at most
 * every 5s. Listeners are notified only after step 2.
 */
export function recordServerBuildId(serverBuildId: string | null | undefined): void {
  if (typeof serverBuildId === 'string' && serverBuildId.length > 0) {
    lastSeenServerBuildId = serverBuildId;
  }
  if (!isMismatch(activeClientId, serverBuildId)) return;
  const id = serverBuildId as string;
  if (currentMismatch?.buildId === id) return;
  if (readDismissed() === id) return;
  pendingServerBuildId = id;
  pendingReason = 'build-mismatch';
  void runVerification();
}

/**
 * Raises the banner with reason `schema-ahead`: sync met a row newer than this
 * bundle's migration registry and halted, so only a reload helps. Forces the
 * banner back on if it was dismissed for the latest server build id.
 */
export function recordSchemaAhead(): void {
  const id = lastSeenServerBuildId;
  if (!id) {
        // Unreachable in practice (a sync response always carries `X-Build-Id`); logged so a gap is visible.
    console.warn('[build-id] schema-ahead reported before any server build id observed');
    return;
  }
  if (id === activeClientId) return;
  if (readDismissed() === id) {
    try {
      window.sessionStorage.removeItem(DISMISS_KEY);
    } catch {
            // Storage may be unavailable; the banner just won't suppress next round.
    }
  }
  if (currentMismatch?.buildId === id) return;
  pendingServerBuildId = id;
  pendingReason = 'schema-ahead';
  lastVerifyAt = 0;
  void runVerification();
}

async function runVerification(): Promise<void> {
  if (verifyInFlight) return;
  const now = Date.now();
  if (now - lastVerifyAt < VERIFY_THROTTLE_MS) return;
  const id = pendingServerBuildId;
  if (id === null) return;
  if (currentMismatch?.buildId === id) return;
  if (readDismissed() === id) return;

  verifyInFlight = true;
  lastVerifyAt = now;
  try {
    const result = await verifier(id);
    if (result !== 'live') {
            // 'old' or 'unknown': leave pendingServerBuildId set so the next response after the throttle retries.
      return;
    }
        // A newer server id arrived mid-flight: drop this result, the newer id verifies itself.
    if (pendingServerBuildId !== id) return;
    if (readDismissed() === id) {
      pendingServerBuildId = null;
      return;
    }
    pendingServerBuildId = null;
        // Read fresh, so a `recordSchemaAhead` that arrived during verification still wins.
    currentMismatch = { buildId: id, reason: pendingReason };
    for (const l of listeners) l(currentMismatch);
  } finally {
    verifyInFlight = false;
  }
}

export function getCurrentMismatch(): VersionMismatch | null {
  return currentMismatch;
}

export function subscribeToVersionMismatch(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissCurrentMismatch(): void {
  if (currentMismatch === null) return;
  writeDismissed(currentMismatch.buildId);
  currentMismatch = null;
  for (const l of listeners) l(null);
}

/** Test-only: reset module state between cases. */
export function __resetBuildIdState(): void {
  currentMismatch = null;
  pendingServerBuildId = null;
  pendingReason = 'build-mismatch';
  lastSeenServerBuildId = null;
  lastVerifyAt = 0;
  verifyInFlight = false;
  verifier = defaultVerifier;
  listeners.clear();
  activeClientId = CLIENT_BUILD_ID;
  try {
    window.sessionStorage.removeItem(DISMISS_KEY);
  } catch {
    // ignore
  }
}

/** Test-only: override the compile-time client id used in comparisons. */
export function __setClientBuildIdForTest(id: string): void {
  activeClientId = id;
}

/** Test-only: replace the bundle-live verifier with a stub. */
export function __setVerifierForTest(fn: BundleVerifier): void {
  verifier = fn;
}

/** Test-only: clear the verification throttle so back-to-back checks fire. */
export function __resetVerifyThrottleForTest(): void {
  lastVerifyAt = 0;
  verifyInFlight = false;
}
