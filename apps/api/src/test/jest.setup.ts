// Per-worker setup: the table/bucket namespace and JWT keypair. The env, emulator endpoints and `JEST_RUN_ID` come from
// jest.config.cjs and are inherited.
import { generateKeyPairSync } from 'node:crypto';

/**
 * Fails loud when `JEST_RUN_ID` (stamped by jest.config.cjs in jest-main) is unset, since namespacing would silently degrade. Not shared
 * with global-teardown.ts: importing it here would pull the `@aws-sdk/client-s3` graph into every worker, whose lazy `import()`
 * jest's CJS VM cannot satisfy.
 * @throws if `JEST_RUN_ID` is unset or empty
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

// Throttler off so happy-path and brute-force suites do not trip per-IP limits; backoff logic still runs.
process.env.DISABLE_THROTTLE = 'true';

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

// RS256 needs PKCS#8 and SPKI PEMs, so each worker mints a keypair instead of trusting the developer's `.env`.
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

process.env.WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

// Every DynamoDB table and the snapshots bucket move to a per-run, per-worker namespace so concurrent jest processes never share state
// or touch `retirement-local-*`. The trailing hyphen lets global-teardown prefix-match exactly this run (run id 123 vs 1234).
// Hard override (`=`, not `??=`): a `.env` pinning the local names for `pnpm dev` must not leak into tests.
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
