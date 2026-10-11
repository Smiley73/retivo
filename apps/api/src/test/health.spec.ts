/**
 * Health endpoint integration tests.
 *
 * Locks the split: public `/api/v1/health` is a
 * shallow secret-free liveness probe with no dependency fields; the
 * dependency probe moves behind authentication at
 * `/api/v1/health/dependencies` (the global JwtAuthGuard protects it).
 */
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { GetBucketLocationCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HealthController } from '../health/health.controller.js';
import type { EnvConfig } from '../common/env.config.js';
import {
  STRONG_PASSWORD,
  approvePendingSignup,
  bootstrapTestApp,
  freshDeviceId,
  freshEmail,
  type TestApp,
} from './test-helpers.js';

async function loginAccessToken(t: TestApp): Promise<string> {
  const email = freshEmail();
  const signup = await request(t.app.getHttpServer())
    .post('/api/v1/auth/signup')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password: STRONG_PASSWORD });
  const verify = await request(t.app.getHttpServer())
    .post('/api/v1/auth/verify-email')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ token: signup.body.verificationToken });
  // The approval token is stored hashed; capture the raw token from
  // the verify-email dev trapdoor and approve with it.
  await approvePendingSignup(t.app, verify.body.approvalToken);
  const login = await request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
  return login.body.accessToken as string;
}

describe('health endpoints', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('GET /api/v1/health (public, shallow)', () => {
    it('returns 200 without authentication', async () => {
      const res = await request(t.app.getHttpServer()).get('/api/v1/health');
      expect(res.status).toBe(200);
    });

    it('returns only { status: "ok" } — no dependency fields, no secrets', async () => {
      const res = await request(t.app.getHttpServer()).get('/api/v1/health');
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.body).not.toHaveProperty('dynamodb');
      expect(res.body).not.toHaveProperty('s3');
    });
  });

  describe('GET /api/v1/health/dependencies (authenticated)', () => {
    it('returns the dependency status for an authenticated user', async () => {
      const accessToken = await loginAccessToken(t);
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/health/dependencies')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dynamodb).toBe('ok');
      expect(res.body.s3).toBe('ok');
    });
  });
});

/**
 * Unit-level coverage of the S3 reachability probe path. Asserts the
 * probe uses GetBucketLocation (a bucket-level metadata read covered by
 * the api role's narrow `s3:GetBucketLocation` grant — no `s3:ListBucket`)
 * and maps a successful response to healthy while ANY thrown error
 * (AccessDenied / network / 5xx) maps to unhealthy. A HeadObject-on-a-
 * missing-key probe would wrongly return 403 here when ListBucket is
 * withheld; GetBucketLocation has no such ambiguity. The bug a
 * Moto-backed test hides because the emulator does not enforce IAM.
 */
describe('HealthController — S3 dependency probe (GetBucketLocation-authorized)', () => {
  function makeController(s3Send: jest.Mock): HealthController {
    const doc = { send: jest.fn().mockResolvedValue({}) };
    const s3 = { send: s3Send };
    const config = {
      get: (key: keyof EnvConfig) =>
        key === 'TABLE_USER' ? 'user-table' : 'snapshots-bucket',
    };
    return new HealthController(
      doc as unknown as DynamoDBDocumentClient,
      s3 as unknown as S3Client,
      config as unknown as ConfigService<EnvConfig, true>,
    );
  }

  it('reports s3 "ok" when GetBucketLocation succeeds (bucket reachable, credentials valid)', async () => {
    const s3Send = jest.fn().mockResolvedValue({ LocationConstraint: 'us-east-1' });
    const controller = makeController(s3Send);

    const result = await controller.dependencies();

    expect(result.s3).toBe('ok');
    // Probe used GetBucketLocation (s3:GetBucketLocation), never
    // HeadBucket / ListBucket and never an object-level HeadObject.
    const sent = s3Send.mock.calls[0][0];
    expect(sent).toBeInstanceOf(GetBucketLocationCommand);
  });

  it('reports s3 "error" (503) when GetBucketLocation is AccessDenied', async () => {
    const s3Send = jest.fn().mockRejectedValue(
      Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const controller = makeController(s3Send);

    await expect(controller.dependencies()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
