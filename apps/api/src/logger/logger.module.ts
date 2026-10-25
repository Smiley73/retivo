// Structured pino JSON logger with secret redaction, satisfying the CODING_STANDARDS "never log secrets" rule.
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import pino, { type DestinationStream } from 'pino';

// A SonicBoom sink on fd 1 with `sync: true`: under Lambda freeze a pipe write is buffered in userland (including pino
// default `pino.destination(1)`), so a line logged near the end of an invocation could never reach CloudWatch.
function createSyncStdoutDestination(): DestinationStream {
  return pino.destination({ dest: 1, sync: true });
}

// pino redact matches leading segments only: `password` covers the root and `*.password` depth 1, with no `**`
// wildcard, so a value nested deeper must not be logged. Only secrets, tokens, credentials and the second-factor
// and email families are masked; opaque ids (userId, householdId, correlation ids) stay visible for incident
// investigation, by existing convention.
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
      // Tuple form `[options, stream]` with the synchronous fd-1 destination; pino default and `process.stdout` buffer
      // in userland, which is why service log markers never reached CloudWatch.
      pinoHttp: [
        {
          redact: {
            paths: REDACTED_PATHS,
            censor: '[REDACTED]',
          },
          // Pipe to pino-pretty for human-readable local output (not installed by default).
          level: process.env.LOG_LEVEL ?? 'info',
          // Omit the raw req and res objects to reduce noise.
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
