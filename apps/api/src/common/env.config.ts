// Environment validation; fails fast at startup. The JWT key maps are `{ kid: pem }` and must share the same kids; deployed stacks
// load them from SSM, and the env vars are the local-dev fallback.
import { z } from 'zod';

// Normalizes one allowed-origin entry to `scheme://host[:port]`: trims, strips one trailing slash, and returns null
// for anything with a path, query or hash, so a malformed entry fails loud instead of silently mis-matching.
function normalizeAllowedOrigin(entry: string): string | null {
  const trimmed = entry.trim().replace(/\/$/, '');
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // A path, query or hash means the entry is not a bare origin and exact-match would never succeed.
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

// Pulumi placeholder for a not-yet-rotated `edge/shared-secret` SSM parameter (infrastructure/src/ssm.ts). A
// placeholder is published in this repository, so the deployed-stack guard treats it as absent. A literal copy, not
// an import: the api bundle cannot depend on `infrastructure/src`;
// `scripts/test/edge-secret-placeholder-contract.test.mjs` guards against drift.
const EDGE_SHARED_SECRET_PLACEHOLDER =
  'phase-1-placeholder-replace-via-aws-ssm-put-parameter-overwrite';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  AWS_REGION: z.string().default('us-east-1'),

  API_PORT: z.coerce.number().int().positive().default(3001),
  // Default `127.0.0.1` so a local dev API (seeded credentials, dev token shortcuts) is not reachable from the LAN;
  // `0.0.0.0` opts in. No format regex: Node `listen()` owns bind-host validation and a custom pattern could reject
  // valid binds.
  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Browser origins allowed to call state-changing endpoints: the single source for Nest CORS, the preflight handler
  // and OriginCheckMiddleware. Unset defaults to WEB_ORIGIN in the superRefine below (a Zod default cannot reference
  // a sibling); the normalized list is `WEB_ALLOWED_ORIGINS_PARSED`.
  WEB_ALLOWED_ORIGINS: z.string().optional(),

  // Set only for local emulators; unset in AWS so the SDK uses regional defaults.
  DYNAMODB_ENDPOINT: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  SES_ENDPOINT: z.string().optional(),

  // In Lambda these come from Pulumi env vars; locally the defaults match the stack=local name prefix.
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
  // Single-use WebAuthn challenge storage; the ~5-minute window is enforced by the reader, not this table TTL.
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
  // MFA tables: user-mfa (TOTP state), mfa-email-otp (live code hash, ~10-min TTL), trusted-device (~30-day TTL).
  TABLE_USER_MFA: z.string().default('retirement-local-user-mfa'),
  TABLE_MFA_EMAIL_OTP: z.string().default('retirement-local-mfa-email-otp'),
  TABLE_TRUSTED_DEVICE: z.string().default('retirement-local-trusted-device'),
  SNAPSHOTS_BUCKET: z.string().default('retirement-local-snapshots'),

  // Two maps keyed by the same `kid` set: PKCS#8 PEMs to sign, SPKI PEMs to verify and serve at
  // `/auth/.well-known/jwks.json`. The current signing key is `AUTH_JWT_CURRENT_KID`, else the first key.
  AUTH_JWT_PRIVATE_KEYS: jwtPrivateKeyMapSchema,
  AUTH_JWT_PUBLIC_KEYS: jwtPublicKeyMapSchema,
  AUTH_JWT_CURRENT_KID: z.string().optional(),
  // Registered `iss` and `aud` claims for every RS256 token this key store signs (access, MFA challenge, export
  // authorization), strictly verified so shared key material cannot be replayed across a token-confusion boundary.
  // `infrastructure/src/lambda.ts` sets them per stack; the local defaults keep `pnpm dev` working.
  AUTH_JWT_ISSUER: z.string().trim().min(1).default('retivo-api/local'),
  AUTH_JWT_AUDIENCE: z.string().trim().min(1).default('retivo-web/local'),
  // Short on purpose: it forces a /auth/refresh round trip, the only way the server slides the refresh idle window.
  // Consumers multiply by 60 for seconds.
  AUTH_ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(5),
  // Doubles as the idle timeout: each rotate resets the cookie and row expiry to now + this; idle past it signs the
  // user out.
  AUTH_REFRESH_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(30),

  // MFA master switch: when true, a password login on an untrusted device returns an MFA challenge. The code default
  // is false so local `pnpm dev` is password-only; deployed stacks default true via `retivo:authMfaEnforced`. Setting
  // false is the operational kill-switch.
  AUTH_MFA_ENFORCED: z.enum(['true', 'false']).default('false'),

  // Required in production; dev can use a placeholder, since the local SES endpoint accepts anything.
  SES_FROM_ADDRESS: z.string().email().default('no-reply@example.invalid'),

  // Owner inbox for signup-approval mail when somebody else signs up; unset copies SES_FROM_ADDRESS in the validator
  // below.
  APPROVER_EMAIL: z.string().email().optional(),

  // Pulumi stack name, set on every deployed Lambda and absent locally. Gates dev conveniences such as returning the
  // verificationToken in the signup response; NODE_ENV is production on every deployed stack, so it is the wrong
  // knob.
  STACK: z.string().optional(),

  // Opt-out for integration tests firing many requests. Refused in production builds, since a stray
  // DISABLE_THROTTLE=true in a Lambda env would disable every rate limit.
  DISABLE_THROTTLE: z
    .enum(['true', 'false'])
    .default('false')
    .refine(
      (val) => !(val === 'true' && process.env.NODE_ENV === 'production'),
      { message: 'DISABLE_THROTTLE=true is not allowed when NODE_ENV=production' },
    ),

  // Edge-to-origin shared secret: CloudFront sends it as `X-Origin-Verify` and EdgeAuthMiddleware rejects a mismatch,
  // locking direct API Gateway access. `_PREVIOUS` accepts the prior secret during a rotation overlap. Both unset
  // disables edge-auth for local dev; on a deployed stack (STACK set) the refine below requires a real,
  // non-placeholder value.
  EDGE_SHARED_SECRET: z.string().optional(),
  EDGE_SHARED_SECRET_PREVIOUS: z.string().optional(),

  // Name of the snapshot-purge Lambda that `DELETE /auth/account` invokes synchronously (the api role has no
  // bucket-wide s3:DeleteObject). Unset locally, where AccountSnapshotPurgeService purges in process; the refine
  // below makes it required on a deployed stack.
  SNAPSHOT_PURGE_FUNCTION_NAME: z.string().optional(),

  // Dev shortcut: when true, /auth/signup and /auth/resend-verification return the raw `verificationToken` so
  // SignupPage can offer a verify-now link. Local development only: the default is conditional (NODE_ENV=production
  // gives false, local gives true), so an unset env on a deployed stack fails closed, and an explicit true there is
  // refused by the refine below. `infrastructure/src/lambda.ts` sets false on every stack.
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
  // Cross-validate the JWT key maps so a misaligned rotation fails boot rather than issue tokens no one can
  // verify.
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
  // A deployed stack must purge snapshots through the dedicated Lambda, so fail boot rather than leave orphaned
  // snapshots.
  if (env.STACK !== undefined && (env.SNAPSHOT_PURGE_FUNCTION_NAME ?? '').length === 0) {
    ctx.addIssue({
      code: 'custom',
      message:
        'SNAPSHOT_PURGE_FUNCTION_NAME is required on a deployed stack (STACK set) so account deletion can purge snapshots via the dedicated Lambda',
      path: ['SNAPSHOT_PURGE_FUNCTION_NAME'],
    });
  }
  // On a deployed stack the shared secret must be real and rotated: the last defense against a raw API Gateway
  // hit. Blank, whitespace-only and the Pulumi placeholder count as absent, so a never-rotated stack fails boot
  // instead of leaving EdgeAuthMiddleware a pass-through.
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
  // WEB_ORIGIN seeds the allowlist when WEB_ALLOWED_ORIGINS is blank. `z.string().url()` accepts a path, which
  // `normalizeAllowedOrigin` rejects, leaving an empty list that rejects every state-changing request; validate
  // it the same way so it fails boot.
  if (normalizeAllowedOrigin(env.WEB_ORIGIN) === null) {
    ctx.addIssue({
      code: 'custom',
      message: `WEB_ORIGIN "${env.WEB_ORIGIN}" is not a valid origin (scheme://host[:port], no path/query/hash)`,
      path: ['WEB_ORIGIN'],
    });
  }
  // Validate allowlist entries here so a malformed one fails boot; blank defaults to the already-validated
  // WEB_ORIGIN.
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
  // Materialize the normalized list so consumers share one parsed source; the WEB_ORIGIN fallback lives here
  // because a Zod default cannot reference it.
  const rawAllowed = (env.WEB_ALLOWED_ORIGINS ?? '').trim();
  const source =
    rawAllowed.length > 0 ? rawAllowed.split(',') : [env.WEB_ORIGIN];
  const parsed = source
    .map((entry) => normalizeAllowedOrigin(entry))
    .filter((origin): origin is string => origin !== null);
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
 * Loaded into ConfigModule at the root so `ConfigService.get` returns the zod-validated value with its schema
 * default.
 */
export const envConfigProvider = (): EnvConfig => validateEnv();
