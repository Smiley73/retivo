/**
 * Per-worker setup. Runs once per Jest worker before the test framework
 * is installed.
 *
 * The repo-root `.env`, the emulator endpoint/credential defaults, and
 * the per-run `JEST_RUN_ID` are all bootstrapped in `jest.config.cjs`
 * (jest-main, pre-fork) — workers inherit them via the fork-time env
 * snapshot. This file only adds the per-*worker* table/bucket namespace
 * and the per-worker JWT keypair.
 */
import { generateKeyPairSync } from 'node:crypto';

/**
 * Fail loud: jest.config.cjs stamps `JEST_RUN_ID` in the jest-main
 * process before the worker pool forks. If it is missing the worker is
 * running with a misconfigured runner — namespacing would silently
 * degrade and global-teardown could not match this run's tables, so
 * refuse to start.
 *
 * Kept independent of `global-teardown.ts`'s twin guard on purpose:
 * this module is a per-worker `setupFiles` entry, so importing
 * global-teardown (which pulls the `@aws-sdk/client-s3` graph) into
 * every worker triggers an SDK lazy `import()` jest's CJS VM cannot
 * satisfy. The two five-line guards are a deliberate, low-cost
 * duplication; both are exported + unit-tested for the unset → throw
 * path in test-isolation.spec.ts.
 *
 * @returns the resolved `JEST_RUN_ID`
 * @throws if `process.env.JEST_RUN_ID` is unset/empty
 */
export function assertJestRunId(): string {
  const runId = process.env.JEST_RUN_ID;
  if (!runId) {
    throw new Error(
      'JEST_RUN_ID is not set — jest.config.cjs must run before workers fork. ' +
        'Run the API suite via `pnpm --filter @retirement/api test` (jest.config.cjs).',
    );
  }
  return runId;
}

assertJestRunId();

// Throttler off so happy-path + brute-force suites don't trip per-IP
// limits at higher-than-real velocity. Backoff logic still runs (tests
// that exercise it manage their own backoff state).
process.env.DISABLE_THROTTLE = 'true';

// Silence pino-http per-request lines unless a test explicitly asks
// for them via LOG_LEVEL=info.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

// Belt-and-suspenders: a missing/placeholder JWT key would fail boot;
// we don't trust the developer's `.env` to be filled in for tests.
// Each Jest worker mints a fresh RSA-2048 keypair (sub-100 ms) — RS256
// needs PKCS#8 + SPKI PEMs, which can't be
// hard-coded in source the way the old HS256 secret could.
if (
  !process.env.AUTH_JWT_PRIVATE_KEYS ||
  process.env.AUTH_JWT_PRIVATE_KEYS.includes('replace-with')
) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'test-key': privateKey });
  process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'test-key': publicKey });
  process.env.AUTH_JWT_CURRENT_KID = 'test-key';
}

// Origin-check middleware demands a parseable WEB_ORIGIN.
process.env.WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

// Test-isolation: redirect every DynamoDB table + the snapshots S3
// bucket to a per-process, per-worker namespace so the integration
// suite never touches the dev workspace's `retirement-local-*` tables
// AND two concurrent jest processes (e.g. two worktrees)
// never share state. `JEST_RUN_ID` is the jest-main pid (set in
// jest.config.cjs); `JEST_WORKER_ID` is jest's per-worker id. The
// trailing hyphen anchors the prefix so `global-teardown.ts` can
// prefix-match exactly this run's tables/buckets (a run id that is a
// numeric prefix of another, e.g. 123 vs 1234, cannot cross-match).
// `local-bootstrap.ts` provisions whatever names the env declares, so
// these are auto-created on first use. Hard override (`=`, not `??=`) —
// even when the developer's `.env` pins the *-local- names for
// `pnpm dev`, tests must use the namespaced set.
const NS = `retirement-test-${process.env.JEST_RUN_ID}-${process.env.JEST_WORKER_ID}-`;
process.env.TABLE_WORKSPACE_META = `${NS}workspace-meta`;
process.env.TABLE_MUTATION_LOG = `${NS}mutation-log`;
process.env.TABLE_AGGREGATE_VERSION = `${NS}aggregate-version`;
process.env.TABLE_IDEMPOTENCY_KEY = `${NS}idempotency-key`;
process.env.TABLE_DEVICE_REGISTRY = `${NS}device-registry`;
process.env.TABLE_USER = `${NS}user`;
process.env.TABLE_EMAIL_RESERVATION = `${NS}email-reservation`;
process.env.TABLE_EMAIL_VERIFICATION = `${NS}email-verification`;
process.env.TABLE_PASSWORD_RESET = `${NS}password-reset`;
process.env.TABLE_CREDENTIAL = `${NS}credential`;
process.env.TABLE_PASSKEY = `${NS}passkey`;
process.env.TABLE_REFRESH_TOKEN = `${NS}refresh-token`;
process.env.TABLE_REVOKED_TOKEN = `${NS}revoked-token`;
process.env.TABLE_FAILED_LOGIN_ATTEMPT = `${NS}failed-login-attempt`;
process.env.TABLE_AUTH_EVENT = `${NS}auth-event`;
process.env.TABLE_SIGNUP_APPROVAL = `${NS}signup-approval`;
process.env.TABLE_HOUSEHOLD_KEY_ENVELOPE = `${NS}household-key-envelope`;
process.env.TABLE_USER_MFA = `${NS}user-mfa`;
process.env.TABLE_MFA_EMAIL_OTP = `${NS}mfa-email-otp`;
process.env.TABLE_TRUSTED_DEVICE = `${NS}trusted-device`;
process.env.TABLE_PASSKEY_CHALLENGE = `${NS}passkey-challenge`;
process.env.SNAPSHOTS_BUCKET = `${NS}snapshots`;
