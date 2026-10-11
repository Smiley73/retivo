/**
 * Thin HTTP client for the sync API. Talks JSON, attaches CSRF header
 * + bearer token, throws structured errors on non-2xx responses.
 *
 * The mock-sync provider satisfies the same interface so Scenario 1
 * (browser-only) can develop without a backend (see mock-sync.ts).
 */
import type {
  BootstrapResponseBody,
  PullResponseBody,
  PushResponseBody,
  SnapshotListItem,
} from './types.js';
import {
  bootstrapResponseSchema,
  pullResponseSchema,
} from '@retirement/contracts';
import type { ZodType } from 'zod';
import type { PendingMutation } from '../db/types.js';
import { recordServerBuildId } from '../lib/build-id.js';
import { encryptPayload, decryptPayload, PayloadCryptoError } from '../crypto/payload-crypto.js';
import {
  computeCursorTag,
  verifyCursorTag,
  bumpCounter,
  isRollback,
  FreshnessError,
} from '../crypto/freshness.js';
import { isStrictEncryptedEnvelope } from '../crypto/key-wrapping.js';
import type { EncryptedPayloadEnvelope } from '../crypto/encryption-types.js';
import { UnauthenticatedPayloadError } from './pull-apply.js';
import { retryAfterMs } from '../lib/retry-backoff.js';

/**
 * Per-call fetch timeout for `POST /sync/workspace/clear`. The clear runs SYNCHRONOUSLY inside one API-Gateway request —
 * password re-verify + 5-repo household sweep + empty-snapshot write + repoint +
 * optional S3 purge — whose worst case sits just under the ~29s API-Gateway
 * integration ceiling. Give the client a slightly higher budget so a normal
 * (even slow) clear is never false-aborted, while a truly hung request still
 * fails instead of hanging forever. Deliberately far above api/client.ts
 * `REQUEST_TIMEOUT_MS` (10s), which would abort mid-clear and surface a false
 * failure while the server actually clears. Other sync calls keep the file's
 * existing no-explicit-timeout behavior.
 */
const CLEAR_WORKSPACE_TIMEOUT_MS = 35_000;

/**
 * 401 error codes that signal an expired/invalid ACCESS TOKEN — the only 401s
 * worth a token refresh + one retry. These are the `JwtAuthGuard`'s codes
 * (apps/api/src/auth/jwt-auth.guard.ts): `UNAUTHENTICATED` (missing / malformed
 * / invalid / expired bearer, or a non-session token) and `ACCESS_TOKEN_REVOKED`
 * (logout denylist hit). A business-logic 401 an endpoint raises for its OWN
 * reasons — e.g. `INVALID_CREDENTIALS` from the `POST /sync/workspace/clear`
 * password re-verify (a wrong password, not an expired token) — is NOT a
 * token-expiry signal and must never be replayed: refreshing + re-sending would
 * fire the destructive clear TWICE, double-counting the server's per-account
 * backoff + audit trail.
 */
const ACCESS_TOKEN_EXPIRY_CODES: ReadonlySet<string> = new Set([
  'UNAUTHENTICATED',
  'ACCESS_TOKEN_REVOKED',
]);

/**
 * True when a 401 response body carries an access-token-expiry error code (see
 * {@link ACCESS_TOKEN_EXPIRY_CODES}). A non-JSON or code-less body returns
 * `false` — the safe default, since replaying a request on an unrecognised 401
 * risks firing a destructive endpoint twice.
 */
function isAccessTokenExpiry(bodyText: string): boolean {
  let code: unknown;
  try {
    code = (JSON.parse(bodyText) as { error?: { code?: unknown } } | null)?.error
      ?.code;
  } catch {
    return false;
  }
  return typeof code === 'string' && ACCESS_TOKEN_EXPIRY_CODES.has(code);
}

/**
 * Validate a served pull / bootstrap body against its shared wire schema and
 * DEGRADE — never throw. This is the one genuine behavior change of the
 * contracts package: the boundary now parses the envelope, but with
 * warn-and-apply semantics, not throw-and-abort. The client is offline-first,
 * so a known-type field drift (a missing / extra / retyped field) or an
 * unrecognised `aggregateType` (SyncContext already warn-and-skips those) must
 * NOT abort a pull / bootstrap cycle. `safeParse` gates only a diagnostic
 * warning; the ORIGINAL body is always returned, so the applied data is
 * byte-identical to the pre-schema `JSON.parse` behaviour on every valid
 * response and a drifted response still applies. See "The wire contract and
 * drift" in docs/architecture.md.
 *
 * This degrade is scoped to known-type field DRIFT only. Payload *shape and
 * authentication* — whether a row is the strict encrypted envelope an HDK
 * requires — is a different question, enforced separately (and strictly) by
 * `decryptServedPayload` below; this function never
 * degrades that.
 */
function validateServedBody(
  schema: ZodType,
  raw: unknown,
  phase: 'pull' | 'bootstrap',
): unknown {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      `[sync] ${phase} response failed wire-schema validation; applying it anyway ` +
        `(field-permissive degrade — known-type field drift must not abort the sync cycle).`,
      parsed.error.issues,
    );
  }
  return raw;
}

/**
 * Identity of one row a `bootstrap()` call quarantined, surfaced on the result itself — not only through the fire-and-forget
 * `reportDecryptOutcome` side channel — so a `clearFirst` applier can carry
 * that aggregate's last readable local copy across its wipe. Never the ciphertext.
 */
export interface BootstrapQuarantinedRow {
  aggregateId: string;
  aggregateType: string;
}

export interface SyncTransport {
  push(args: { householdId: string; deviceId: string; mutations: PendingMutation[] }): Promise<PushResponseBody>;
  pull(args: { since: string }): Promise<PullResponseBody>;
  bootstrap(args: {
    force: boolean;
  }): Promise<BootstrapResponseBody & { quarantined?: readonly BootstrapQuarantinedRow[] }>;
  /** List the household's available snapshots (newest-first). */
  listSnapshots(): Promise<SnapshotListItem[]>;
  /** Restore the household's server sync state to a chosen snapshot. */
  restore(snapshotId: string): Promise<{ ok: boolean }>;
  /**
   * Server-authoritative "Delete workspace data" clear. Re-verifies `currentPassword` server-side then sweeps the household
   * workspace to empty. `eraseHistory` opts into purging the S3 backup history
   * after the clear; `purgeHistoryOnly` is the erase-history RETRY (purge-only,
   * no sweep — the "Try erasing backups again" affordance). Returns the server's
   * `{ ok, historyErased }` outcome; throws `SyncApiError` on any non-2xx.
   */
  clearWorkspace(args: {
    currentPassword: string;
    eraseHistory: boolean;
    purgeHistoryOnly?: boolean;
  }): Promise<{ ok: boolean; historyErased: boolean }>;
}

/** One row a pull/bootstrap decrypt loop failed to decrypt. Never
 *  carries the ciphertext — only aggregate identity + the row's version. Not
 *  exported past this module — `SyncClientDeps.reportDecryptOutcome` callers
 *  get the shape structurally. */
interface SyncDecryptQuarantineEntry {
  aggregateId: string;
  aggregateType: string;
  version: number;
}

export interface SyncClientDeps {
  apiBaseUrl: string;
  /** Returns the current access token (or null when logged out). */
  getAccessToken: () => string | null;
  /** Returns the current CSRF token from cookie storage. */
  getCsrfToken: () => string | null;
  /** Attempt to refresh the access token. Returns the new token or null if session expired. */
  refreshAccessToken?: () => Promise<string | null>;
  /** Returns the active household data key, or null when not yet unlocked. */
  getHdk?: () => CryptoKey | null;
  /** Returns the locally pinned freshness counter (0 = no pin / TOFU). Absent = no freshness enforced. */
  getPinnedFreshnessCounter?: () => number;
  /** Returns the authenticated household ID for binding into decrypt AAD. */
  getHouseholdId?: () => string;
  /**
   * Reports a pull/bootstrap decrypt outcome:
   * `quarantined` rows failed to decrypt (`PayloadCryptoError`) and were
   * dropped from the returned result, never applied; `resolved` rows
   * decrypted fine for an aggregate a caller may have previously
   * quarantined. Called at most once per `pull`/`bootstrap` call, only when
   * either list is non-empty. Optional — omitted for `mock-sync.ts` and the
   * export transport, which track no quarantine state.
   */
  reportDecryptOutcome?: (outcome: {
    quarantined: SyncDecryptQuarantineEntry[];
    resolved: { aggregateId: string; aggregateType: string }[];
  }) => void;
}

/**
 * Thrown when a sync response is rejected on the zero-knowledge freshness
 * check: either the served counter is below this device's
 * pin (a genuine rollback), or the cursor tag failed MAC verification (a
 * tampered head). Callers catch this single type to surface
 * `rollback-detected`; the throw happens before any local write, giving
 * the reject-before-write guarantee.
 */
export class FreshnessRollbackError extends Error {
  constructor(
    public readonly servedCounter: number,
    public readonly pinnedCounter: number,
  ) {
    super(
      `Freshness rollback detected: served counter ${servedCounter} < pinned ${pinnedCounter}`,
    );
    this.name = 'FreshnessRollbackError';
  }
}

export class HttpSyncClient implements SyncTransport {
  constructor(private readonly deps: SyncClientDeps) {}

  async push(args: { householdId: string; deviceId: string; mutations: PendingMutation[] }): Promise<PushResponseBody> {
    const hdk = this.deps.getHdk?.() ?? null;
    // Push requires an unlocked HDK. The server unconditionally rejects
    // plaintext payloads — there is no server-side
    // plaintext push path. Callers must ensure the household encryption key is
    // available before flushing mutations; the LoginPage setup gate (needsSetup
    // hold) prevents in-app pushes from reaching this branch.
    if (!hdk) {
      throw new Error(
        'HttpSyncClient.push: HDK is null — push requires an unlocked household encryption key. ' +
          'The server unconditionally rejects plaintext payloads. ' +
          'Suspend push until the household encryption key is available.',
      );
    }
    let freshnessHead: { freshnessCounter: number; cursorTag: string } | undefined;
    if (hdk) {
      const proposedCounter = bumpCounter(
        this.deps.getPinnedFreshnessCounter?.() ?? 0,
      );
      const cursorTag = await computeCursorTag(proposedCounter, hdk);
      freshnessHead = { freshnessCounter: proposedCounter, cursorTag };
    }
    const mutations = await Promise.all(
      args.mutations.map(async (m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        aggregateType: m.aggregateType,
        operation: m.operation,
        version: m.expectedVersion,
        schemaVersion: m.schemaVersion,
        payload: await encryptPayload(
          m.payload,
          {
            householdId: args.householdId,
            aggregateId: m.aggregateId,
            aggregateType: m.aggregateType,
            encryptionVersion: 1,
          },
          hdk,
          // keyId is currently the householdId.
          args.householdId,
        ),
        timestamp: m.timestamp,
        deviceId: m.deviceId,
      })),
    );
    const body = {
      householdId: args.householdId,
      deviceId: args.deviceId,
      mutations,
      ...(freshnessHead ? { freshnessHead } : {}),
    };
    const response = await this.request<PushResponseBody>('POST', '/api/v1/sync/push', body);
    if (hdk) {
      // Push-path verification: the head echo is best-effort and
      // non-atomic with mutation acceptance. A
      // successful commit whose head echo failed (absent/null) must NOT
      // present as a rollback — keep the existing pin and return normally.
      // Pull/bootstrap (the paths that serve state) keep the strict
      // missing-head-with-pin rejection.
      await this.verifyFreshness(response.freshnessHead, hdk, 'push');
    }
    return response;
  }

  async pull(args: { since: string }): Promise<PullResponseBody> {
    const url = `/api/v1/sync/pull?since=${encodeURIComponent(args.since)}`;
    const raw = await this.request<unknown>('GET', url);
    // Validate the envelope against the shared wire schema, but DEGRADE — never
    // throw (see validateServedBody). The original body is returned so a valid
    // response applies byte-identically and a drifted one still applies.
    const result = validateServedBody(
      pullResponseSchema,
      raw,
      'pull',
    ) as PullResponseBody;
    const hdk = this.deps.getHdk?.() ?? null;
    if (!hdk) return result;
    await this.verifyFreshness(result.freshnessHead, hdk);
    // Quarantine: the server holds no household
    // key, so it can only check envelope SHAPE — a garbage `wrappedKey`/
    // ciphertext an attacker pushed is caught only here, at decrypt. A single
    // undecryptable row must cost that device that row, never the whole pull.
    const quarantined: SyncDecryptQuarantineEntry[] = [];
    const resolved: { aggregateId: string; aggregateType: string }[] = [];
    const kept: typeof result.changes = [];
    for (const change of result.changes) {
      // Every row must be a strict envelope — the pull
      // response carries no householdId; bind the authenticated household
      // from deps into the AAD so the GCM tag verifies (the encrypt-side AAD
      // binds the real householdId). A non-envelope row is a protocol
      // violation, not "one bad row" (see decryptServedPayload); a well-formed
      // envelope that fails to decrypt is quarantined below instead of
      // rejecting the whole pull.
      try {
        change.payload = await this.decryptServedPayload(
          change.payload,
          {
            householdId: this.deps.getHouseholdId?.() ?? '',
            aggregateId: change.aggregateId,
            aggregateType: change.aggregateType,
          },
          hdk,
          'pull',
        );
      } catch (err) {
        if (!(err instanceof PayloadCryptoError)) throw err;
        quarantined.push({
          aggregateId: change.aggregateId,
          aggregateType: change.aggregateType,
          version: change.version,
        });
        continue; // Drop this row — never applied, never advances the aggregate's version.
      }
      resolved.push({ aggregateId: change.aggregateId, aggregateType: change.aggregateType });
      kept.push(change);
    }
    if (quarantined.length > 0 || resolved.length > 0) {
      this.deps.reportDecryptOutcome?.({ quarantined, resolved });
    }
    result.changes = kept;
    return result;
  }

  async bootstrap(args: {
    force: boolean;
  }): Promise<BootstrapResponseBody & { quarantined?: readonly BootstrapQuarantinedRow[] }> {
    const url = `/api/v1/sync/bootstrap?force=${args.force ? 'true' : 'false'}`;
    const raw = await this.request<unknown>('GET', url);
    const result = validateServedBody(
      bootstrapResponseSchema,
      raw,
      'bootstrap',
    ) as BootstrapResponseBody;
    const hdk = this.deps.getHdk?.() ?? null;
    if (!hdk) return result;
    await this.verifyFreshness(result.freshnessHead, hdk);
    const householdId = result.workspaceSnapshot.householdId;
    // Quarantine, combined across both loops
    // below (the snapshot aggregates and the post-snapshot mutations) into
    // ONE report — a poisoned snapshot row is otherwise the unrecoverable
    // case: today a single `PayloadCryptoError` rejects the WHOLE bootstrap,
    // which is exactly the wedge described above.
    const quarantined: SyncDecryptQuarantineEntry[] = [];
    const resolved: { aggregateId: string; aggregateType: string }[] = [];
    const keptAggregates: typeof result.workspaceSnapshot.aggregates = [];
    for (const a of result.workspaceSnapshot.aggregates) {
      // Every snapshot aggregate must be a strict envelope;
      // a decrypt failure on a well-formed envelope is quarantined
      // rather than rejecting the whole snapshot.
      try {
        a.payload = await this.decryptServedPayload(
          a.payload,
          { householdId, aggregateId: a.id, aggregateType: a.aggregateType },
          hdk,
          'bootstrap',
        );
      } catch (err) {
        if (!(err instanceof PayloadCryptoError)) throw err;
        quarantined.push({ aggregateId: a.id, aggregateType: a.aggregateType, version: a.version });
        continue; // Drop this row from the snapshot — never applied.
      }
      resolved.push({ aggregateId: a.id, aggregateType: a.aggregateType });
      keptAggregates.push(a);
    }
    result.workspaceSnapshot.aggregates = keptAggregates;
    const keptMutations: typeof result.postSnapshotMutations = [];
    for (const m of result.postSnapshotMutations) {
      // The pull-shaped change carries no householdId of its own; bind the
      // authenticated household (falling back to the snapshot's) into the
      // AAD so the GCM tag verifies. Same strict-envelope requirement as the
      // snapshot half above, and the same quarantine-on-decrypt-failure
      // behavior.
      try {
        m.payload = await this.decryptServedPayload(
          m.payload,
          {
            householdId: this.deps.getHouseholdId?.() ?? householdId,
            aggregateId: m.aggregateId,
            aggregateType: m.aggregateType,
          },
          hdk,
          'bootstrap',
        );
      } catch (err) {
        if (!(err instanceof PayloadCryptoError)) throw err;
        quarantined.push({
          aggregateId: m.aggregateId,
          aggregateType: m.aggregateType,
          version: m.version,
        });
        continue; // Drop this row — never applied, never advances the aggregate's version.
      }
      resolved.push({ aggregateId: m.aggregateId, aggregateType: m.aggregateType });
      keptMutations.push(m);
    }
    result.postSnapshotMutations = keptMutations;
    if (quarantined.length > 0 || resolved.length > 0) {
      this.deps.reportDecryptOutcome?.({ quarantined, resolved });
    }
    // Surfaced to the caller directly
    // — not only through the fire-and-forget `reportDecryptOutcome` side
    // channel — so a `clearFirst` bootstrap applier can carry each dropped
    // row's last readable local copy across its `clearAllStores()` instead of
    // silently refilling without it (or refusing the whole refresh).
    return { ...result, quarantined };
  }

  /**
   * Once an HDK is held, every served pull/bootstrap payload must be a
   * strict encrypted envelope. The server never accepts
   * plaintext for a keyed household on any push (`push.service.ts`
   * `enforceEncryptionForMutation`), so once this client holds
   * a key a non-envelope row is a bug or a compromised server — that case
   * still throws `UnauthenticatedPayloadError(phase, 'not-envelope')` and
   * rejects the WHOLE response before a single row reaches IndexedDB,
   * rather than handing back a partially-decrypted body the caller could
   * half-apply.
   *
   * A well-formed envelope that fails to decrypt is a DIFFERENT case:
   * it is left to throw the raw
   * `PayloadCryptoError` from `decryptPayload` uncaught, so `pull()` /
   * `bootstrap()` can catch it specifically and quarantine just that row
   * (drop it, report it) instead of rejecting the whole response — a single
   * bad/tampered row must not wedge the entire sync cycle. Any other error
   * from `decryptPayload` propagates unchanged.
   */
  private async decryptServedPayload(
    payload: Record<string, unknown> | EncryptedPayloadEnvelope,
    meta: { householdId: string; aggregateId: string; aggregateType: string },
    hdk: CryptoKey,
    phase: 'pull' | 'bootstrap',
  ): Promise<Record<string, unknown>> {
    if (!isStrictEncryptedEnvelope(payload)) {
      throw new UnauthenticatedPayloadError(phase, 'not-envelope');
    }
    return (await decryptPayload(
      payload,
      { ...meta, encryptionVersion: 1 },
      hdk,
    )) as Record<string, unknown>;
  }

  async listSnapshots(): Promise<SnapshotListItem[]> {
    return this.request<SnapshotListItem[]>('GET', '/api/v1/sync/snapshots');
  }

  async restore(snapshotId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('POST', '/api/v1/sync/restore', {
      snapshotId,
    });
  }

  async clearWorkspace(args: {
    currentPassword: string;
    eraseHistory: boolean;
    purgeHistoryOnly?: boolean;
  }): Promise<{ ok: boolean; historyErased: boolean }> {
    // Own timeout ABOVE the server's synchronous worst case: the sweep +
    // snapshot + optional purge can run several seconds, past the 10s
    // api/client.ts default that would false-abort it. `request()` echoes the
    // CSRF header + bearer like every other sync POST.
    return this.request<{ ok: boolean; historyErased: boolean }>(
      'POST',
      '/api/v1/sync/workspace/clear',
      args,
      CLEAR_WORKSPACE_TIMEOUT_MS,
    );
  }

  /**
   * Verify a server-echoed freshness head: reject a
   * counter below this device's pin (genuine rollback) and verify the
   * cursor-tag MAC. A failed MAC (FreshnessError) is normalized into a
   * FreshnessRollbackError so callers handle one error type. A missing
   * head (first sync) is accepted. Throws before any local write.
   *
   * `mode` distinguishes the push path from the state-serving paths:
   * - `'serve'` (pull/bootstrap): a missing head WITH a non-zero pin is a
   *   rollback — these paths hand back state, so an absent head bypasses
   *   protection and must reject.
   * - `'push'`: the head echo is best-effort and non-atomic with mutation
   *   acceptance. A missing head after a successful commit is a
   *   transient echo failure, NOT a rollback — keep the pin, return
   *   normally. This does NOT weaken rollback detection: pull/bootstrap
   *   still reject the missing-head-with-pin case.
   */
  private async verifyFreshness(
    freshnessHead: { freshnessCounter: number; cursorTag: string } | null | undefined,
    hdk: CryptoKey,
    mode: 'serve' | 'push' = 'serve',
  ): Promise<void> {
    const pinned = this.deps.getPinnedFreshnessCounter?.() ?? 0;
    if (!freshnessHead) {
      // Push path: a transient missing echo after a successful commit keeps
      // the existing pin. Only the state-serving paths reject.
      if (mode === 'push') return;
      // Only accept a missing head when pinned === 0 (TOFU first contact).
      // Once a pin exists, an absent head bypasses rollback protection.
      if (pinned > 0) {
        throw new FreshnessRollbackError(-1, pinned);
      }
      return;
    }
    if (isRollback(freshnessHead.freshnessCounter, pinned)) {
      throw new FreshnessRollbackError(freshnessHead.freshnessCounter, pinned);
    }
    try {
      await verifyCursorTag(freshnessHead, hdk);
    } catch (err) {
      if (err instanceof FreshnessError) {
        // A tampered/mismatched tag is treated as a rollback so callers
        // only need to catch one error type. servedCounter carries the
        // suspect counter; pinnedCounter the local pin.
        throw new FreshnessRollbackError(freshnessHead.freshnessCounter, pinned);
      }
      throw err;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    // Optional per-call abort timeout (ms). Omitted for the polling calls
    // (push/pull/bootstrap/restore) which keep the file's existing
    // no-explicit-timeout behavior; `clearWorkspace` passes one above the
    // server's worst-case budget so a hung request eventually fails
    // instead of leaving the promise pending forever.
    timeoutMs?: number,
  ): Promise<T> {
    const controller = timeoutMs !== undefined ? new AbortController() : null;
    const timeoutId =
      controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const doFetch = (accessToken: string | null): Promise<Response> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const csrf = this.deps.getCsrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;
      return fetch(`${this.deps.apiBaseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
        signal: controller?.signal,
      });
    };

    try {
      let res = await doFetch(this.deps.getAccessToken());
      let text = await res.text();

      // Retry once — but ONLY on a genuine expired/invalid ACCESS-TOKEN 401
      // (`isAccessTokenExpiry`). The access token may have expired between
      // polls; refresh + replay recovers that, mirroring api/client.ts so sync
      // 401s trigger the same logout side-effect when the session is truly
      // gone. A 401 an endpoint raises for its OWN business logic — e.g.
      // `INVALID_CREDENTIALS` on `POST /sync/workspace/clear` (a wrong password)
      // — must NOT be replayed: firing the destructive clear twice
      // double-counts the server-side backoff / audit trail. Peek the error
      // code first (reading the body now is safe — it is consumed either way).
      if (
        res.status === 401 &&
        this.deps.refreshAccessToken &&
        isAccessTokenExpiry(text)
      ) {
        const newToken = await this.deps.refreshAccessToken();
        if (newToken) {
          res = await doFetch(newToken);
          text = await res.text();
        }
      }

      // Sync polls fire often → cheapest place to detect a deploy.
      recordServerBuildId(res.headers.get('X-Build-Id'));
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON body (rare; e.g. 504 from the load balancer). Surface as a string.
        parsed = { error: { code: 'UPSTREAM_ERROR', message: text || res.statusText } };
      }
      if (!res.ok) {
        const err = (parsed as {
          error?: { code?: string; message?: string; traceId?: string };
        } | null)?.error;
        throw new SyncApiError(
          err?.code ?? 'UPSTREAM_ERROR',
          err?.message ?? `Request failed: ${res.status}`,
          res.status,
          err?.traceId,
          retryAfterMs(res.headers),
        );
      }
      return parsed as T;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
  }
}

export class SyncApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly traceId?: string,
    /** Parsed `Retry-After` from the response, in ms — `null`/undefined
     *  when the header was absent or unparseable, distinct from a real
     *  zero-length wait (see `retryAfterMs` in `lib/retry-backoff.ts`). */
    public readonly retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = 'SyncApiError';
  }
}

/**
 * Construct a one-shot {@link HttpSyncClient} for the server-authoritative data
 * export. The export runs a forced
 * bootstrap + pull under the five-minute export-authorization cookie, so it
 * does NOT share the running provider's freshness pin. It decrypts served rows with the household key
 * (`getHdk`) exactly like the live client, but pins the freshness counter at 0:
 * the served head's MAC is still verified against the key (tamper detection
 * preserved), while the monotonic-counter check is treated as a first-contact
 * TOFU so a legitimate head is never false-rejected. Nothing is persisted — the
 * export path writes only the download.
 */
export function createExportSyncTransport(deps: {
  apiBaseUrl: string;
  getAccessToken: () => string | null;
  getCsrfToken: () => string | null;
  refreshAccessToken?: () => Promise<string | null>;
  getHdk?: () => CryptoKey | null;
  householdId: string;
}): SyncTransport {
  return new HttpSyncClient({
    apiBaseUrl: deps.apiBaseUrl,
    getAccessToken: deps.getAccessToken,
    getCsrfToken: deps.getCsrfToken,
    refreshAccessToken: deps.refreshAccessToken,
    getHdk: deps.getHdk ?? (() => null),
    getPinnedFreshnessCounter: () => 0,
    getHouseholdId: () => deps.householdId,
    // Fail closed: the export is a portability/
    // compliance artifact, not the live sync path the quarantine-and-
    // continue behaviour was built for. `pull`/`bootstrap` call this
    // SYNCHRONOUSLY, before returning — throwing here propagates straight
    // out of the transport call (no try/catch wraps it there), so the whole
    // export rejects instead of silently downloading a bundle that is
    // quietly missing the rows that failed to decrypt.
    reportDecryptOutcome: (outcome) => {
      if (outcome.quarantined.length > 0) {
        throw new Error(
          `Export blocked: ${outcome.quarantined.length} row(s) could not be decrypted ` +
            'and would otherwise be silently omitted from the export.',
        );
      }
    },
  });
}
