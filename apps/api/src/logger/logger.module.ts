/**
 * Structured JSON logger using pino with secret redaction.
 *
 * Redacted paths prevent passwords, tokens, and cookies from appearing in
 * log output, satisfying the CODING_STANDARDS.md "never log secrets" rule.
 */
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import pino, { type DestinationStream } from 'pino';

/**
 * Build the pino log destination: a SonicBoom sink bound to fd 1 with
 * `sync: true`, so every line is written with `fs.writeSync` before the call
 * returns.
 *
 * Under Lambda's freeze-after-return execution model `process.stdout` is a
 * pipe, and Node buffers writes to a pipe in userland (`process.stdout.write`
 * is asynchronous on a pipe). A line logged near the end of an invocation can
 * therefore sit in that JS buffer when the execution environment is frozen and
 * never reach CloudWatch — the production defect this repairs. Pino's own
 * default destination (`pino.destination(1)`) is likewise async. Only an
 * explicitly synchronous destination guarantees the byte is handed to the OS
 * before the handler returns; `sync: true` is the load-bearing flag the unit
 * test asserts.
 */
export function createSyncStdoutDestination(): DestinationStream {
  return pino.destination({ dest: 1, sync: true });
}

// pino redact paths use leading-segment matching: `password` covers the field
// at root, `*.password` covers the field at depth 1. Cover both so values like
// `{ password }` and `{ body: { password } }` are both masked. This is
// leading-segment matching only — NOT arbitrary-depth coverage (pino's
// `redact` does not support a `**` wildcard), so a value nested deeper than
// depth 1 must not be logged in the first place.
//
// Redaction policy: only secrets, tokens, credentials, and the second-factor /
// email families below are masked. Internal opaque identifiers (`userId`,
// `householdId`, correlation IDs) are deliberately NOT redacted — they appear
// as structured log fields today (e.g. refresh-token.service.ts's
// `refresh_token_reuse_detected` warn) and stay visible for incident
// investigation. That is this repo's existing convention, not a decision made
// here.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'refreshToken',
  'accessToken',
  'tokenHash',
  'otp',
  'code',
  'backupCode',
  'backupCodes',
  'totpSecret',
  'secret',
  'csrfToken',
  'deviceTrustToken',
  'email',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.tokenHash',
  '*.otp',
  '*.code',
  '*.backupCode',
  '*.backupCodes',
  '*.totpSecret',
  '*.secret',
  '*.csrfToken',
  '*.deviceTrustToken',
  '*.email',
];

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      // Tuple form `[options, stream]` (nestjs-pino / pino-http): write to an
      // explicitly synchronous fd-1 SonicBoom destination (see
      // `createSyncStdoutDestination`) rather than pino's default async fd-1
      // sink or `process.stdout`. Both of those buffer in userland and can drop
      // or delay a service log written near the end of a Lambda invocation when
      // the runtime freezes the process, which is why `new Logger(...).warn/
      // error` markers never reached CloudWatch in the deployed JSON shape. The
      // synchronous destination delivers each line to the Lambda log pipe
      // before the handler returns.
      pinoHttp: [
        {
          redact: {
            paths: REDACTED_PATHS,
            censor: '[REDACTED]',
          },
          // Structured JSON in all environments.
          // For human-readable local output: pipe to pino-pretty (not installed
          // by default — `pnpm --filter @retirement/api add -D pino-pretty`).
          level: process.env.LOG_LEVEL ?? 'info',
          // Omit the raw req/res objects from the default log line to reduce noise.
          serializers: {
            req(req: { method: string; url: string }) {
              return { method: req.method, url: req.url };
            },
          },
        },
        createSyncStdoutDestination(),
      ],
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
