/**
 * Cold-start SSM secret loader for the Lambda runtime.
 *
 * The api Lambda IAM role grants `ssm:GetParameter` on a narrow set of
 * `/retivo/<stack>/...` ARNs. At cold start we fetch the secret
 * values and copy them into `process.env` before Nest's
 * `validateEnv()` runs — so the same Zod schema that validates the
 * local-dev `.env` also validates the production secrets.
 *
 * Local dev (Scenarios 1–3) skips this entirely: when `STACK` is unset
 * or `DYNAMODB_ENDPOINT` is set, we read everything from `.env`.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const PARAMETER_TO_ENV: ReadonlyArray<{
  path: (base: string) => string;
  envVar: string;
  decrypt: boolean;
  required: boolean;
}> = [
  {
    path: (base) => `${base}/auth/jwt-private-keys`,
    envVar: 'AUTH_JWT_PRIVATE_KEYS',
    decrypt: true,
    required: true,
  },
  {
    // Public counterpart to AUTH_JWT_PRIVATE_KEYS. Stored as SecureString
    // for uniformity (the public key is technically not secret) so the
    // SSM IAM grant + decrypt-via-aws/ssm condition cover both lookups
    // identically.
    path: (base) => `${base}/auth/jwt-public-keys`,
    envVar: 'AUTH_JWT_PUBLIC_KEYS',
    decrypt: true,
    required: true,
  },
  {
    path: (base) => `${base}/auth/refresh-secret`,
    envVar: 'AUTH_REFRESH_SECRET',
    decrypt: true,
    required: false,
  },
  {
    path: (base) => `${base}/ses/from-address`,
    envVar: 'SES_FROM_ADDRESS',
    decrypt: false,
    required: false,
  },
  {
    // Shared secret CloudFront sets as `X-Origin-Verify` on every
    // request it forwards to API Gateway. EdgeAuthMiddleware enforces it —
    // and, per env.config.ts's deployed-stack superRefine, refuses to boot
    // without it. Required: a throttled/denied/absent GetParameter
    // must fail this cold start loudly, not degrade EdgeAuthMiddleware to a
    // pass-through for the life of the warm Lambda. Only reached when
    // STACK is set and DYNAMODB_ENDPOINT is unset (see the module doc
    // above) — local dev and the emulator suite never hit this loader.
    path: (base) => `${base}/edge/shared-secret`,
    envVar: 'EDGE_SHARED_SECRET',
    decrypt: true,
    required: true,
  },
];

export async function loadSecretsFromSsm(): Promise<void> {
  const stack = process.env.STACK;
  // Local emulator runs and `pnpm dev` set DYNAMODB_ENDPOINT; in those
  // environments we honor the .env-supplied secrets and skip SSM.
  if (!stack || process.env.DYNAMODB_ENDPOINT) return;

  const region = process.env.AWS_REGION ?? 'us-east-1';
  const ssm = new SSMClient({ region });
  const base = `/retivo/${stack}`;

  for (const entry of PARAMETER_TO_ENV) {
    try {
      const result = await ssm.send(
        new GetParameterCommand({
          Name: entry.path(base),
          WithDecryption: entry.decrypt,
        }),
      );
      const value = result.Parameter?.Value;
      if (value) process.env[entry.envVar] = value;
      else if (entry.required) {
        throw new Error(`SSM parameter ${entry.path(base)} returned no value`);
      }
    } catch (err) {
      if (entry.required) throw err;
      // Best-effort for optional parameters — log via console so the
      // failure is captured even before Nest's logger is alive.
      console.warn(
        `[ssm-bootstrap] optional parameter ${entry.path(base)} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
