/**
 * Environment validation. Fails fast at startup if required vars are
 * missing or invalid.
 *
 * AUTH_JWT_PRIVATE_KEYS is a JSON map `{ kid: pkcs8PrivateKeyPem }` and
 * AUTH_JWT_PUBLIC_KEYS its public-key counterpart `{ kid: spkiPublicKeyPem }`
 * (RS256 signing).
 * Both maps must carry the same set of `kid`s. In production these are
 * loaded from SSM Parameter Store at boot via the AWS module; the env vars
 * here are the local-dev fallback.
 */
import { z } from 'zod';

/**
 * Normalize one allowed-origin entry to its canonical origin
 * (`scheme://host[:port]`). Trims surrounding whitespace, strips a single
 * trailing slash, then requires a successful URL parse with no path, query,
 * or hash — anything carrying one is a malformed allowlist entry and fails
 * loud rather than silently mis-matching. Returns `null` on rejection so the
 * caller can attach a Zod issue.
 */
function normalizeAllowedOrigin(entry: string): string | null {
  const trimmed = entry.trim().replace(/\/$/, '');
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Reject anything beyond `scheme://host[:port]` — a path/query/hash means
  // the entry is not a bare origin and exact-match would never succeed.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

function pemKeyMapSchema(opts: {
  envName: string;
  marker: string;
  role: string;
}) {
  const { envName, marker, role } = opts;
  return z.string().transform((raw, ctx) => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const map: Record<string, string> = {};
      for (const [kid, value] of Object.entries(parsed)) {
        if (typeof value !== 'string' || !value.includes(marker)) {
          ctx.addIssue({
            code: 'custom',
            message: `JWT ${role} key '${kid}' must be a PEM string containing '${marker}'`,
          });
          return z.NEVER;
        }
        map[kid] = value;
      }
      if (Object.keys(map).length === 0) {
        ctx.addIssue({ code: 'custom', message: `${envName} map is empty` });
        return z.NEVER;
      }
      return map;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `${envName} must be valid JSON`,
      });
      return z.NEVER;
    }
  });
}

const jwtPrivateKeyMapSchema = pemKeyMapSchema({
  envName: 'AUTH_JWT_PRIVATE_KEYS',
  marker: '-----BEGIN PRIVATE KEY-----',
  role: 'private',
});

const jwtPublicKeyMapSchema = pemKeyMapSchema({
  envName: 'AUTH_JWT_PUBLIC_KEYS',
  marker: '-----BEGIN PUBLIC KEY-----',
  role: 'public',
});

/**
 * Pulumi's placeholder value for a not-yet-rotated `edge/shared-secret` SSM
 * parameter (infrastructure/src/ssm.ts's `PLACEHOLDER`). A present-but-
 * placeholder secret is a value published in this repository, so it is not
 * a secret at all — the deployed-stack guard below treats it as absent.
 * Kept as a literal copy rather than an import: the api bundle
 * cannot depend on `infrastructure/src` (a separate Pulumi-only package).
 * Guarded against drift by
 * `scripts/test/edge-secret-placeholder-contract.test.mjs`.
 */
const EDGE_SHARED_SECRET_PLACEHOLDER =
  'phase-1-placeholder-replace-via-aws-ssm-put-parameter-overwrite';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  AWS_REGION: z.string().default('us-east-1'),

  API_PORT: z.coerce.number().int().positive().default(3001),
  // Local Nest bootstrap bind host (main.ts). Default `127.0.0.1` (loopback
  // only) so a local dev API — which can expose seeded credentials / dev token
  // shortcuts — is not reachable from the LAN by default;
  // set `API_HOST=0.0.0.0` to opt IN to
  // LAN exposure. No format regex — Node/Nest `listen()` owns real bind-host
  // validation and accepts platform-specific forms (IPv4, IPv6 `::`,
  // hostnames); a custom pattern risks rejecting valid binds.
  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Comma-separated list of browser origins allowed to call state-changing
  // endpoints. Single source for every browser-origin allow decision (Nest
  // CORS + custom preflight + OriginCheckMiddleware) — replaces the removed
  // API_CORS_ORIGIN. Unset ⇒ defaults to WEB_ORIGIN in the superRefine
  // below (Zod `.default()` can't reference a sibling field). The parsed,
  // normalized origin list is exposed as `WEB_ALLOWED_ORIGINS_PARSED` so
  // consumers don't each re-split.
  WEB_ALLOWED_ORIGINS: z.string().optional(),

  // AWS endpoints — only set in local Scenarios 2/3 to point at Docker
  // emulators. Unset in real AWS so the SDK uses regional defaults.
  DYNAMODB_ENDPOINT: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  SES_ENDPOINT: z.string().optional(),

  // Resource names. In Lambda these come from env vars set by Pulumi
  // (TABLE_*). For local dev we provide sensible defaults that match
  // the namePrefix from infrastructure/src/config.ts when stack=local.
  TABLE_WORKSPACE_META: z.string().default('retirement-local-workspace-meta'),
  TABLE_MUTATION_LOG: z.string().default('retirement-local-mutation-log'),
  TABLE_AGGREGATE_VERSION: z.string().default('retirement-local-aggregate-version'),
  TABLE_IDEMPOTENCY_KEY: z.string().default('retirement-local-idempotency-key'),
  TABLE_DEVICE_REGISTRY: z.string().default('retirement-local-device-registry'),
  TABLE_USER: z.string().default('retirement-local-user'),
  TABLE_EMAIL_RESERVATION: z.string().default('retirement-local-email-reservation'),
  TABLE_EMAIL_VERIFICATION: z.string().default('retirement-local-email-verification'),
  TABLE_PASSWORD_RESET: z.string().default('retirement-local-password-reset'),
  TABLE_CREDENTIAL: z.string().default('retirement-local-credential'),
  TABLE_PASSKEY: z.string().default('retirement-local-passkey'),
  // Shared, single-use WebAuthn challenge storage. PK `key` — the caller's own namespaced string
  // (see PasskeyChallengeStore); ~5-min TTL on `expiresAt`, enforced by the
  // reader, not this table's DynamoDB TTL.
  TABLE_PASSKEY_CHALLENGE: z
    .string()
    .default('retirement-local-passkey-challenge'),
  TABLE_REFRESH_TOKEN: z.string().default('retirement-local-refresh-token'),
  TABLE_REVOKED_TOKEN: z.string().default('retirement-local-revoked-token'),
  TABLE_FAILED_LOGIN_ATTEMPT: z
    .string()
    .default('retirement-local-failed-login-attempt'),
  TABLE_AUTH_EVENT: z.string().default('retirement-local-auth-event'),
  TABLE_SIGNUP_APPROVAL: z.string().default('retirement-local-signup-approval'),
  TABLE_HOUSEHOLD_KEY_ENVELOPE: z
    .string()
    .default('retirement-local-household-key-envelope'),
  // Enforced second-factor (MFA) tables. user-mfa: TOTP enrollment
  // state (PK userId). mfa-email-otp: live Email-OTP code hash
  // (PK userId, ~10-min TTL on expiresAt). trusted-device: per-device trust
  // (PK userId, SK deviceId, ~30-day TTL on expiresAt).
  TABLE_USER_MFA: z.string().default('retirement-local-user-mfa'),
  TABLE_MFA_EMAIL_OTP: z.string().default('retirement-local-mfa-email-otp'),
  TABLE_TRUSTED_DEVICE: z.string().default('retirement-local-trusted-device'),
  SNAPSHOTS_BUCKET: z.string().default('retirement-local-snapshots'),

  // JWT signing keys (RS256). Two maps keyed by
  // the same `kid` set: AUTH_JWT_PRIVATE_KEYS holds PKCS#8 PEMs the api
  // uses to sign access tokens; AUTH_JWT_PUBLIC_KEYS holds the matching
  // SPKI PEMs used to verify and to serve `GET /auth/.well-known/jwks.json`.
  // The "current" key for new tokens is configured via AUTH_JWT_CURRENT_KID
  // (or the first key in iteration order if unset). See cross-validation
  // in `superRefine` below.
  AUTH_JWT_PRIVATE_KEYS: jwtPrivateKeyMapSchema,
  AUTH_JWT_PUBLIC_KEYS: jwtPublicKeyMapSchema,
  AUTH_JWT_CURRENT_KID: z.string().optional(),
  // JWT token-domain claims. Every
  // RS256 token this key store signs — access, MFA challenge, and data-export
  // authorization — embeds these as the registered `iss`/`aud` claims and
  // strictly verifies them, so key material shared across environments or future
  // services cannot be replayed across a token-confusion boundary.
  // `infrastructure/src/lambda.ts` sets `retivo-api/<stack>` /
  // `retivo-web/<stack>` per deployed stack; the local-dev defaults below
  // keep `pnpm dev` and the emulator suite working without extra config.
  // Enforced with no transitional acceptance, so every access/MFA/export-authorization
  // JWT issued before these claims existed (it carries neither) fails verification
  // and its holder re-authenticates.
  AUTH_JWT_ISSUER: z.string().trim().min(1).default('retivo-api/local'),
  AUTH_JWT_AUDIENCE: z.string().trim().min(1).default('retivo-web/local'),
  // Access-token TTL in minutes. Intentionally short: it forces a
  // /auth/refresh round-trip within this window of any authenticated
  // activity, which is the only way the server slides the refresh-token
  // (idle) window.
  // Consumers multiply by 60
  // for the seconds value JWT / cookies expect.
  AUTH_ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(5),
  // Refresh-token TTL in minutes. Doubles as the idle-timeout window:
  // each successful rotate resets cookie maxAge + DB row expiresAt to
  // now + this value; idle past the window → next rotate fails → user
  // signed out.
  AUTH_REFRESH_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(30),

  // Enforced second-factor (MFA) master switch. When 'true', a
  // successful password login on an untrusted device returns an MFA challenge
  // instead of a session; the client completes POST /auth/mfa/verify. The code
  // default stays 'false' so local `pnpm dev` without the var is password-only;
  // the deployed dev + prod stacks set AUTH_MFA_ENFORCED via the
  // `retivo:authMfaEnforced` stack config key (lambda.ts), default true.
  // Setting 'false' is the permanent operational
  // kill-switch (no code redeploy needed): login behaves exactly as before
  // (issueSession directly).
  AUTH_MFA_ENFORCED: z.enum(['true', 'false']).default('false'),

  // SES sender for signup verification mail. Required in production; for
  // dev it can be a placeholder (the local SES endpoint accepts anything).
  SES_FROM_ADDRESS: z.string().email().default('no-reply@example.invalid'),

  // Owner inbox that receives a signup-approval mail when somebody other
  // than the owner signs up. Distinct concept from SES_FROM_ADDRESS (the
  // SMTP "From" header — typically a no-reply@). Optional: when unset,
  // the validator below copies SES_FROM_ADDRESS into it so a single-var
  // config still works.
  APPROVER_EMAIL: z.string().email().optional(),

  // Pulumi stack name (e.g. "dev" / "prod"). Set on every Lambda by
  // infrastructure/src/lambda.ts; absent on local emulator runs.
  // Used to gate dev-only conveniences like returning the
  // verificationToken in the signup response (when SES sandbox can't
  // actually deliver mail). The Lambda's NODE_ENV is "production" on
  // every deployed stack, so it's the wrong knob for that decision.
  STACK: z.string().optional(),

  // Process-wide opt-out for integration tests that fire many requests
  // in quick succession. Refused in production builds — a stray
  // DISABLE_THROTTLE=true copied from a test .env into a Lambda env
  // would silently disable every rate limit.
  DISABLE_THROTTLE: z
    .enum(['true', 'false'])
    .default('false')
    .refine(
      (val) => !(val === 'true' && process.env.NODE_ENV === 'production'),
      { message: 'DISABLE_THROTTLE=true is not allowed when NODE_ENV=production' },
    ),

  // Edge → origin shared secret. CloudFront attaches the primary value
  // as `X-Origin-Verify` on every request it forwards to API Gateway.
  // EdgeAuthMiddleware enforces it and rejects requests that don't
  // present a matching value, locking direct APIGW access. The
  // *_PREVIOUS slot accepts the prior secret during a rotation
  // overlap so warm Lambdas don't reject in-flight CF traffic for the
  // few minutes between SSM rotation and CloudFront origin update.
  // Both unset means edge-auth is disabled — local dev / emulator, where
  // STACK is also unset. On a deployed stack (STACK set) the base field
  // stays optional here so the schema shape is uniform, but the refine
  // below requires a real, non-placeholder EDGE_SHARED_SECRET —
  // EDGE_SHARED_SECRET_PREVIOUS stays optional everywhere; it exists only
  // for the rotation overlap window.
  EDGE_SHARED_SECRET: z.string().optional(),
  EDGE_SHARED_SECRET_PREVIOUS: z.string().optional(),

  // Name of the dedicated snapshot-purge Lambda the `DELETE /auth/account`
  // cascade invokes synchronously to delete a household's S3 snapshots
  // (removes bucket-wide s3:DeleteObject from the
  // api role). Set on the api Lambda by infrastructure/src/lambda.ts.
  // Unset in local/emulator runtime: AccountSnapshotPurgeService falls
  // back to an in-process S3 purge so `pnpm dev` + the emulator test
  // suite don't require a deployed Lambda. On a deployed stack the
  // service requires it (fail-loud) — the refine below enforces that a
  // production-like runtime cannot silently skip the purge.
  SNAPSHOT_PURGE_FUNCTION_NAME: z.string().optional(),

  // Operator-opt-in trapdoor for the dev
  // shortcut: when 'true', /auth/signup and /auth/resend-verification
  // include the raw `verificationToken` in the response so SignupPage
  // can render a "Dev shortcut: verify now" link without waiting on
  // SES delivery.
  //
  // The shortcut is LOCAL-DEVELOPMENT ONLY. Every deployed stack runs
  // NODE_ENV=production (see STACK above), so that is the knob that
  // decides it — dev and prod Lambdas alike boot with the shortcut off.
  // Default is conditional:
  //   NODE_ENV=production (any deployed stack) → 'false'.
  //   local `pnpm dev` / tests                 → 'true'.
  // The conditional default means an unset env on a deployed stack
  // fails closed. Explicit 'true' on a deployed stack is hard-refused
  // by the refine below as belt-and-suspenders (mirroring
  // DISABLE_THROTTLE above). `infrastructure/src/lambda.ts` sets an
  // explicit 'false' on every stack so the boundary is also visible in
  // code review — the schema default fires only on misconfiguration.
  EXPOSE_VERIFICATION_TOKEN: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) =>
      val ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true'),
    )
    .refine(
      (val) =>
        !(
          val === 'true' &&
          (process.env.NODE_ENV === 'production' || process.env.STACK === 'prod')
        ),
      {
        message:
          'EXPOSE_VERIFICATION_TOKEN=true is not allowed on a deployed stack ' +
          '(NODE_ENV=production or STACK=prod)',
      },
    ),
}).superRefine((env, ctx) => {
  // Cross-validate the JWT key maps so a misaligned rotation (private
  // rotated, public not) fails boot rather than silently issuing tokens
  // no one can verify.
  const privKids = Object.keys(env.AUTH_JWT_PRIVATE_KEYS);
  const pubKids = new Set(Object.keys(env.AUTH_JWT_PUBLIC_KEYS));
  const missingPub = privKids.filter((k) => !pubKids.has(k));
  if (missingPub.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `AUTH_JWT_PUBLIC_KEYS missing kid(s) present in AUTH_JWT_PRIVATE_KEYS: ${missingPub.join(', ')}`,
      path: ['AUTH_JWT_PUBLIC_KEYS'],
    });
  }
  const extraPub = [...pubKids].filter((k) => !privKids.includes(k));
  if (extraPub.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `AUTH_JWT_PUBLIC_KEYS has kid(s) absent from AUTH_JWT_PRIVATE_KEYS: ${extraPub.join(', ')}`,
      path: ['AUTH_JWT_PUBLIC_KEYS'],
    });
  }
  if (env.AUTH_JWT_CURRENT_KID && !privKids.includes(env.AUTH_JWT_CURRENT_KID)) {
    ctx.addIssue({
      code: 'custom',
      message: `AUTH_JWT_CURRENT_KID="${env.AUTH_JWT_CURRENT_KID}" is not in AUTH_JWT_PRIVATE_KEYS`,
      path: ['AUTH_JWT_CURRENT_KID'],
    });
  }
  // On a deployed stack (STACK set), account deletion must purge
  // snapshots via the dedicated Lambda — fail boot loud if the function
  // name is missing rather than silently leaving orphaned snapshots.
  // Local / emulator runs leave STACK unset and use the in-process
  // fallback in AccountSnapshotPurgeService.
  if (env.STACK !== undefined && (env.SNAPSHOT_PURGE_FUNCTION_NAME ?? '').length === 0) {
    ctx.addIssue({
      code: 'custom',
      message:
        'SNAPSHOT_PURGE_FUNCTION_NAME is required on a deployed stack (STACK set) so account deletion can purge snapshots via the dedicated Lambda',
      path: ['SNAPSHOT_PURGE_FUNCTION_NAME'],
    });
  }
  // On a deployed stack (STACK set), CloudFront's shared secret must be a
  // real, rotated value — the last line of defense against a raw API
  // Gateway origin hit. Blank, whitespace-only, and the not-yet-
  // rotated Pulumi placeholder all count as absent, so a brand-new or
  // never-rotated stack fails boot loud instead of quietly leaving
  // EdgeAuthMiddleware degraded to a pass-through. Local / emulator runs
  // leave STACK unset and are unaffected.
  const trimmedEdgeSecret = (env.EDGE_SHARED_SECRET ?? '').trim();
  if (
    env.STACK !== undefined &&
    (trimmedEdgeSecret.length === 0 ||
      trimmedEdgeSecret === EDGE_SHARED_SECRET_PLACEHOLDER)
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        'EDGE_SHARED_SECRET is required on a deployed stack (STACK set) — set /retivo/<stack>/edge/shared-secret in SSM to a rotated value',
      path: ['EDGE_SHARED_SECRET'],
    });
  }
  // WEB_ORIGIN is the fallback source for the allowlist when
  // WEB_ALLOWED_ORIGINS is unset/blank. `z.string().url()` accepts a URL with
  // a path/query/hash (e.g. `http://localhost:5173/app`), but
  // `normalizeAllowedOrigin` rejects those — left unvalidated it would yield an
  // empty WEB_ALLOWED_ORIGINS_PARSED and reject every state-changing request.
  // Validate it the same way the allowlist entries are validated so a
  // path-carrying WEB_ORIGIN fails boot loud.
  if (normalizeAllowedOrigin(env.WEB_ORIGIN) === null) {
    ctx.addIssue({
      code: 'custom',
      message: `WEB_ORIGIN "${env.WEB_ORIGIN}" is not a valid origin (scheme://host[:port], no path/query/hash)`,
      path: ['WEB_ORIGIN'],
    });
  }
  // Validate WEB_ALLOWED_ORIGINS entries here so a malformed allowlist fails
  // boot. When unset/blank the list defaults to WEB_ORIGIN, validated just
  // above. The canonical parsed list is materialized in the `.transform` below.
  const rawAllowed = (env.WEB_ALLOWED_ORIGINS ?? '').trim();
  if (rawAllowed.length > 0) {
    const entries = rawAllowed.split(',');
    for (const entry of entries) {
      if (normalizeAllowedOrigin(entry) === null) {
        ctx.addIssue({
          code: 'custom',
          message: `WEB_ALLOWED_ORIGINS entry "${entry.trim()}" is not a valid origin (scheme://host[:port], no path/query/hash)`,
          path: ['WEB_ALLOWED_ORIGINS'],
        });
      }
    }
  }
}).transform((env) => {
  // Materialize the canonical, normalized allowed-origin list so every
  // consumer (main.ts CORS, cors-preflight, OriginCheckMiddleware) reads one
  // parsed source instead of re-splitting the raw string. Falls back to
  // WEB_ORIGIN when WEB_ALLOWED_ORIGINS is unset/blank — Zod `.default()`
  // can't reference WEB_ORIGIN, so the derivation lives here post-validation.
  const rawAllowed = (env.WEB_ALLOWED_ORIGINS ?? '').trim();
  const source =
    rawAllowed.length > 0 ? rawAllowed.split(',') : [env.WEB_ORIGIN];
  const parsed = source
    .map((entry) => normalizeAllowedOrigin(entry))
    .filter((origin): origin is string => origin !== null);
  // De-duplicate while preserving first-seen order.
  const WEB_ALLOWED_ORIGINS_PARSED = [...new Set(parsed)];
  return { ...env, WEB_ALLOWED_ORIGINS_PARSED };
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Environment validation failed:\n${issues}\n\nSee .env.example and docs/local-setup.md for required variables.`,
    );
  }
  return result.data;
}

/**
 * Loaded into ConfigModule at the root (no `registerAs` namespace) so
 * `ConfigService<EnvConfig, true>.get('TABLE_USER', { infer: true })`
 * returns the zod-validated value with its schema default — the typing
 * already promised this; the loader now matches.
 */
export const envConfigProvider = (): EnvConfig => validateEnv();
