/**
 * Deployed-shape integration test for the Nest/Pino service-log contract.
 *
 * Production evidence showed service-level `warn`/`error` markers never reached
 * CloudWatch in the pino JSON shape the metric filters matched on. This test
 * boots the REAL Lambda app via `createApp()` (no SSM), then logs through a
 * `new Logger(name)` instance from `@nestjs/common` — the exact bridge every
 * service uses (`new Logger(ClassName.name)` -> `app.useLogger(app.get(Logger))`)
 * — and asserts the emitted stdout line is Lambda-compatible pino JSON with a
 * string `msg`, a severity, safe context, and the `[REDACTED]` censor applied
 * to every newly-redacted sensitive field family.
 *
 * `LOG_LEVEL` is forced to `info` BEFORE `../lambda.js` is dynamically imported,
 * so `logger.module.ts` is evaluated after the override (a static top-level
 * import would lock in jest.setup.ts's `LOG_LEVEL=silent`).
 */
import 'reflect-metadata';
import fs from 'node:fs';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import {
  DYNAMO_DOC_CLIENT,
  S3_CLIENT,
  SES_CLIENT,
  LAMBDA_CLIENT,
} from '../aws/aws.module.js';

process.env.LOG_LEVEL = 'info';

interface CapturedLog {
  raw: string;
  json: Record<string, unknown>;
}

function captureStdout(): { lines: CapturedLog[]; restore: () => void } {
  const lines: CapturedLog[] = [];
  // The synchronous fd-1 destination writes with `fs.writeSync(1, ...)` (see
  // logger.module.ts `createSyncStdoutDestination`), so it bypasses
  // `process.stdout.write` — capture at the `fs.writeSync` layer for fd 1 and
  // pass every other fd through to the real implementation. Returning the full
  // byte length keeps SonicBoom's write accounting from looping on a perceived
  // partial write.
  const realWriteSync = fs.writeSync.bind(fs);
  const spy = jest.spyOn(fs, 'writeSync').mockImplementation(((
    fd: number,
    data: unknown,
    ...rest: unknown[]
  ): number => {
    if (fd === 1) {
      const raw = String(data);
      try {
        lines.push({ raw, json: JSON.parse(raw) as Record<string, unknown> });
      } catch {
        // Non-JSON stdout line (should not happen for pino) — record raw only.
        lines.push({ raw, json: {} });
      }
      return Buffer.byteLength(raw);
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  }) as unknown as typeof fs.writeSync);
  return { lines, restore: () => spy.mockRestore() };
}

describe('structured logging — deployed Nest/Pino service-log contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Create the emulator tables/bucket the AppModule's onApplicationBootstrap
    // hooks (e.g. legal-document registration) write to — mirrors
    // test-helpers.bootstrapTestApp. Dynamically imported after the LOG_LEVEL
    // override above, alongside lambda.js.
    const { ensureLocalAwsResources } = await import('../aws/local-bootstrap.js');
    const { validateEnv } = await import('../common/env.config.js');
    await ensureLocalAwsResources(validateEnv());
    const { createApp } = await import('../lambda.js');
    app = await createApp();
  }, 60000);

  afterAll(async () => {
    if (!app) return;
    const doc = app.get<DynamoDBDocumentClient>(DYNAMO_DOC_CLIENT);
    const ddb = (
      doc as unknown as { config: { client?: () => DynamoDBClient } }
    ).config.client?.();
    const s3 = app.get<S3Client>(S3_CLIENT);
    const ses = app.get<SESClient>(SES_CLIENT);
    const lambda = app.get<LambdaClient>(LAMBDA_CLIENT);
    await app.close();
    doc.destroy();
    ddb?.destroy();
    s3.destroy();
    ses.destroy();
    lambda.destroy();
  });

  it('emits a Lambda-compatible pino JSON line with msg + severity + context', () => {
    const cap = captureStdout();
    try {
      // Object-first form so structured fields land in the JSON record (a
      // string-first message drops trailing objects as interpolation args).
      new Logger('StructuredLoggingSpec').warn(
        { userId: 'user-visible-id' },
        'security_event_observed',
      );
    } finally {
      cap.restore();
    }
    const line = cap.lines.find(
      (l) => l.json.msg === 'security_event_observed',
    );
    expect(line).toBeDefined();
    // Single JSON object per line (Lambda/CloudWatch splits on newline).
    expect(line!.raw.endsWith('\n')).toBe(true);
    // pino severity: numeric `level` (30 = info, 40 = warn, 50 = error).
    expect(typeof line!.json.level).toBe('number');
    expect(line!.json.level).toBe(40);
    // Context is preserved and unredacted (internal opaque id, not a secret).
    expect(line!.json.context).toBe('StructuredLoggingSpec');
    expect(line!.json.userId).toBe('user-visible-id');
    expect(typeof line!.json.msg).toBe('string');
  });

  it('redacts every newly-redacted sensitive field family at root', () => {
    const cap = captureStdout();
    try {
      new Logger('StructuredLoggingSpec').error(
        {
          otp: '123456',
          code: '654321',
          backupCode: 'ABCDE-FGHJK',
          backupCodes: ['ABCDE-FGHJK'],
          totpSecret: 'JBSWY3DPEHPK3PXP',
          secret: 'top-secret-value',
          csrfToken: 'csrf-abc',
          deviceTrustToken: 'dt-xyz',
          email: 'victim@example.com',
        },
        'sensitive_fields',
      );
    } finally {
      cap.restore();
    }
    const line = cap.lines.find((l) => l.json.msg === 'sensitive_fields');
    expect(line).toBeDefined();
    for (const field of [
      'otp',
      'code',
      'backupCode',
      'backupCodes',
      'totpSecret',
      'secret',
      'csrfToken',
      'deviceTrustToken',
      'email',
    ]) {
      expect(line!.json[field]).toBe('[REDACTED]');
    }
    // Raw secret/PII values must be nowhere in the serialized line.
    expect(line!.raw).not.toContain('victim@example.com');
    expect(line!.raw).not.toContain('JBSWY3DPEHPK3PXP');
    expect(line!.raw).not.toContain('top-secret-value');
  });

  it('redacts the sensitive field families at depth-1 (nested one level)', () => {
    const cap = captureStdout();
    try {
      new Logger('StructuredLoggingSpec').log(
        {
          body: {
            email: 'nested@example.com',
            otp: '000111',
            password: 'hunter2',
            backupCode: 'NESTED-LEGACY',
            backupCodes: ['NESTED-LEGACY'],
          },
        },
        'nested_sensitive_fields',
      );
    } finally {
      cap.restore();
    }
    const line = cap.lines.find(
      (l) => l.json.msg === 'nested_sensitive_fields',
    );
    expect(line).toBeDefined();
    const body = line!.json.body as Record<string, unknown>;
    expect(body.email).toBe('[REDACTED]');
    expect(body.otp).toBe('[REDACTED]');
    expect(body.password).toBe('[REDACTED]');
    expect(body.backupCode).toBe('[REDACTED]');
    expect(body.backupCodes).toBe('[REDACTED]');
    expect(line!.raw).not.toContain('nested@example.com');
    expect(line!.raw).not.toContain('hunter2');
  });
});
