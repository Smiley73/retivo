// Cold-start SSM secret loader: copies narrow `/retivo/<stack>/...` parameters into process.env before validateEnv(). Skipped when
// STACK is unset or DYNAMODB_ENDPOINT is set.
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
    // Stored as SecureString like the private keys, so the SSM IAM grant covers both lookups identically.
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
    // Required: a throttled, denied or absent read must fail the cold start loudly, not degrade EdgeAuthMiddleware
    // to a pass-through for the life of the warm Lambda.
    path: (base) => `${base}/edge/shared-secret`,
    envVar: 'EDGE_SHARED_SECRET',
    decrypt: true,
    required: true,
  },
];

export async function loadSecretsFromSsm(): Promise<void> {
  const stack = process.env.STACK;
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
      // Optional parameters are best-effort; log via console so the failure is captured before Nest logger exists.
      console.warn(
        `[ssm-bootstrap] optional parameter ${entry.path(base)} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
