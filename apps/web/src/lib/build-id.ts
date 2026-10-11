/**
 * Build id propagation for the "new version available" banner.
 *
 * The SPA bakes a build id at compile time (vite.config.ts → `define`
 * substitutes `__BUILD_ID__` from `process.env.VITE_BUILD_ID`). The
 * API echoes its own build id on every response via `X-Build-Id` (set
 * by `BuildIdMiddleware`). The api/client.ts layer feeds every observed
 * server build id through `recordServerBuildId` below.
 *
 * Two-step gate (so the banner doesn't fire while a deploy is mid-flight):
 *
 *   1. **API mismatch** — `X-Build-Id !== CLIENT_BUILD_ID`. The api
 *      Lambda's env var flips first during `pulumi up`; this signal
 *      arrives ~30–90s before the new SPA bundle is actually live on
 *      CloudFront. Acting on this alone caused the "reload → same
 *      banner reappears" loop the user reported.
 *
 *   2. **Bundle live** — verify by fetching `/build-id.json` (a tiny
 *      asset Vite emits into the bundle, served with `no-cache` + an
 *      explicit CF invalidation on every deploy). Only when that file's
 *      `buildId` matches the server's `X-Build-Id` do we surface the
 *      banner — at that point a reload will *actually* fetch the new
 *      bundle.
 *
 * If the verification says the deployed bundle is still the client's
 * own id (CF hasn't caught up yet), we stay quiet and re-check on the
 * next API response. A 5s throttle prevents hammering `/build-id.json`
 * while many requests fan out during a deploy window.
 *
 * Local-dev short-circuit: when either side is `dev` (vite-dev, vitest,
 * or a Lambda without `BUILD_ID` set) we never raise a mismatch — both
 * sides churn independently and a banner would just be noise.
 *
 * Only one stale build id is ever surfaced at a time; the banner shows
 * the *latest* server build id, and `dismissCurrentMismatch()`
 * suppresses re-prompting for that exact id within the session.
 *
 * The surfaced mismatch carries a `reason` (`'build-mismatch'` |
 * `'schema-ahead'`) so `<VersionBanner>` can
 * pick copy that matches what actually happened: a routine deploy vs. a
 * pulled row this bundle's migration registry cannot read yet
 * (`recordSchemaAhead`, called from `SyncContext`'s schema-ahead guard).
 */

declare global {
  /** Injected by Vite at build time via `define` in vite.config.ts. */
  const __BUILD_ID__: string | undefined;
}

export const CLIENT_BUILD_ID: string =
  typeof __BUILD_ID__ === 'string' && __BUILD_ID__.length > 0 ? __BUILD_ID__ : 'dev';

const DISMISS_KEY = 'retivo.versionBanner.dismissedBuildId';
const VERIFY_THROTTLE_MS = 5_000;
const VERIFY_TIMEOUT_MS = 3_000;

/**
 * Why the banner is being raised, so `<VersionBanner>` can pick its copy
 *: a plain deploy vs. a schema-ahead row the
 * current bundle truly cannot read.
 */
export type MismatchReason = 'build-mismatch' | 'schema-ahead';

export interface VersionMismatch {
  buildId: string;
  reason: MismatchReason;
}

type Listener = (mismatch: VersionMismatch | null) => void;

/**
 * Result of a `/build-id.json` lookup against an observed server build id.
 *  - `live`    — deployed bundle matches the server id; safe to prompt.
 *  - `old`     — deployed bundle is still the client's own id; CF behind.
 *  - `unknown` — fetch failed, parsed nothing useful, or some third id;
 *                stay quiet, retry on next API response.
 */
type BundleVerification = 'live' | 'old' | 'unknown';

export type BundleVerifier = (serverBuildId: string) => Promise<BundleVerification>;

let currentMismatch: VersionMismatch | null = null;
let pendingServerBuildId: string | null = null;
// The reason tag for `pendingServerBuildId`'s in-flight verification.
// Read fresh (not captured at call time) when a verification resolves,
// so a `recordSchemaAhead` that arrives while a `recordServerBuildId`
// verification is already in flight still tags the eventual mismatch
// with the stronger 'schema-ahead' reason.
let pendingReason: MismatchReason = 'build-mismatch';
let lastSeenServerBuildId: string | null = null;
let lastVerifyAt = 0;
let verifyInFlight = false;
const listeners = new Set<Listener>();
// Test override for the compile-time client id. Production code goes
// through `recordServerBuildId`, which uses CLIENT_BUILD_ID; tests can
// flip this via `__setClientBuildIdForTest` to exercise the mismatch
// path without rebuilding the module.
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
    // Storage may be unavailable (private mode, quota); banner just
    // re-shows next time, which is acceptable.
  }
}

/**
 * Pure comparator. Exported for tests so the banner logic can be
 * verified without touching window state.
 */
export function isMismatch(clientId: string, serverId: string | null | undefined): boolean {
  if (!serverId) return false;
  if (clientId === 'dev' || serverId === 'dev') return false;
  return clientId !== serverId;
}

/**
 * Called by the API client on every response. Compares the server's
 * build id against the compile-time client id; on a real mismatch
 * (and not the one the user already dismissed) records it as pending
 * and kicks off a bundle-live verification. Listeners are notified
 * only after verification confirms the new bundle is fetchable.
 */
export function recordServerBuildId(serverBuildId: string | null | undefined): void {
  if (typeof serverBuildId === 'string' && serverBuildId.length > 0) {
    lastSeenServerBuildId = serverBuildId;
  }
  if (!isMismatch(activeClientId, serverBuildId)) return;
  // Safe non-null after isMismatch.
  const id = serverBuildId as string;
  if (currentMismatch?.buildId === id) return;
  if (readDismissed() === id) return;
  pendingServerBuildId = id;
  pendingReason = 'build-mismatch';
  void runVerification();
}

/**
 * Called by the sync layer when an apply step encounters a payload at a
 * `schemaVersion` higher than the local migration registry can handle.
 * The current bundle truly cannot read the row — sync has already been
 * halted (no IDB write, no cursor advance) — and the user needs to
 * reload to pick up the newer bundle that ships the migration.
 *
 * Reuses the same VersionBanner surface as a normal build-id mismatch:
 * the response that delivered the schema-ahead row carried `X-Build-Id`
 * which `recordServerBuildId` already captured into `lastSeenServerBuildId`.
 * A previously-dismissed banner for that id is forced back on, since the
 * user may have suppressed an "update available" prompt before this
 * stronger signal arrived.
 */
export function recordSchemaAhead(): void {
  const id = lastSeenServerBuildId;
  if (!id) {
    // Should be unreachable: schema-ahead is only detected on apply of
    // a sync response, which always carries `X-Build-Id`. Log so the
    // gap is observable rather than silent.
    console.warn('[build-id] schema-ahead reported before any server build id observed');
    return;
  }
  if (id === activeClientId) return;
  if (readDismissed() === id) {
    try {
      window.sessionStorage.removeItem(DISMISS_KEY);
    } catch {
      // Storage may be unavailable; banner just won't suppress on the
      // next round, which is fine.
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
  // Re-check guards — state may have shifted between caller invocation
  // and this microtask running.
  if (currentMismatch?.buildId === id) return;
  if (readDismissed() === id) return;

  verifyInFlight = true;
  lastVerifyAt = now;
  try {
    const result = await verifier(id);
    if (result !== 'live') {
      // 'old' (CF still serving the previous bundle) or 'unknown'
      // (fetch failed / unexpected payload) — leave pendingServerBuildId
      // set so the next recordServerBuildId after the throttle window
      // re-runs verification.
      return;
    }
    // Verification was for `id`. If a newer server build id arrived
    // mid-flight, discard this result; the newer id will trigger its
    // own verification.
    if (pendingServerBuildId !== id) return;
    if (readDismissed() === id) {
      pendingServerBuildId = null;
      return;
    }
    pendingServerBuildId = null;
    // Read `pendingReason` fresh (not captured at the top of this
    // function) so a `recordSchemaAhead` that arrived after this
    // verification started still wins.
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
