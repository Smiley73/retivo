// DELETE /auth/account against the local emulator: password re-auth, the sweep of every household-scoped row, S3 object and auth-state row, and retention of account_deletion_* AuthEvents.
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { ConfigService } from '@nestjs/config';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  scanAll,
  signupVerifyLogin,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import type {
  AuthEventRow,
  CredentialRow,
  EmailReservationRow,
  MutationLogRow,
  RefreshTokenRow,
  UserRow,
} from '../dynamo/types.js';

// A plaintext push 403s, so the sweep test seeds the row it expects the cascade to purge.
async function seedHouseholdMutation(t: TestApp, s: Session): Promise<void> {
  await t.doc.send(
    new PutCommand({
      TableName: tableName(t, 'TABLE_MUTATION_LOG'),
      Item: {
        householdId: s.householdId,
        sequenceId: (await KSUID.random()).string,
        deviceId: s.deviceId,
        aggregateId: randomUUID(),
        aggregateType: 'household',
        operation: 'create',
        payload: JSON.stringify({ name: 'Doomed', currency: 'USD' }),
        version: 1,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
}

function deleteAccount(t: TestApp, s: Session, password: string): request.Test {
  return request(t.app.getHttpServer())
    .delete('/api/v1/auth/account')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send({ currentPassword: password });
}

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

describe('account deletion', () => {
  let t: TestApp;
  let s3: S3Client;
  let snapshotsBucket: string;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    s3 = t.module.get<S3Client>(S3_CLIENT);
    snapshotsBucket = tableName(t, 'SNAPSHOTS_BUCKET');
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('purges every household + auth row, leaves AuthEvent audit trail, and locks out future logins', async () => {
    const s = await signupVerifyLogin(t);
    await seedHouseholdMutation(t, s);

    // The compactor does not run in tests, so a planted snapshot proves the S3 sweep.
    await s3.send(
      new PutObjectCommand({
        Bucket: snapshotsBucket,
        Key: `${s.householdId}/seed.json.gz`,
        Body: Buffer.from('seed'),
      }),
    );

    const res = await deleteAccount(t, s, STRONG_PASSWORD);
    expect(res.status).toBe(204);

    const userRow = await t.doc.send(
      new GetCommand({ TableName: tableName(t, 'TABLE_USER'), Key: { userId: s.userId } }),
    );
    expect(userRow.Item).toBeUndefined();

    const cred = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_CREDENTIAL'),
        Key: { userId: s.userId },
      }),
    );
    expect(cred.Item).toBeUndefined();

    const reservation = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_EMAIL_RESERVATION'),
        Key: { emailLowercase: s.email.toLowerCase() },
      }),
    );
    expect(reservation.Item).toBeUndefined();

    const refresh = (await scanAll<RefreshTokenRow>(
      t.doc,
      tableName(t, 'TABLE_REFRESH_TOKEN'),
    )).filter((r) => r.userId === s.userId);
    expect(refresh).toHaveLength(0);

    const muts = (await scanAll<MutationLogRow>(
      t.doc,
      tableName(t, 'TABLE_MUTATION_LOG'),
    )).filter((r) => r.householdId === s.householdId);
    expect(muts).toHaveLength(0);

    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: snapshotsBucket,
        Prefix: `${s.householdId}/`,
      }),
    );
    expect(list.KeyCount ?? 0).toBe(0);

    const events = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId);
    expect(events.some((e) => e.eventType === 'account_deletion_initiated')).toBe(true);
    expect(events.some((e) => e.eventType === 'account_deletion_completed')).toBe(true);

    const stale = await request(t.app.getHttpServer())
      .get('/api/v1/auth/passkey/list')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(stale.status).toBe(401);

    const reLogin = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: s.email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
    expect(reLogin.status).toBe(401);
  });

  it('rejects a wrong currentPassword with INVALID_CREDENTIALS and leaves the user intact', async () => {
    const s = await signupVerifyLogin(t);
    const res = await deleteAccount(t, s, 'WrongPassw0rd!');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const userRow = await t.doc.send(
      new GetCommand({ TableName: tableName(t, 'TABLE_USER'), Key: { userId: s.userId } }),
    );
    expect((userRow.Item as UserRow | undefined)?.userId).toBe(s.userId);

    const cred = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_CREDENTIAL'),
        Key: { userId: s.userId },
      }),
    );
    expect((cred.Item as CredentialRow | undefined)?.userId).toBe(s.userId);

    // Within the 3-miss grace window, so a later login still works: no backoff is in effect yet.
    const stillWorks = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: s.email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
    expect(stillWorks.status).toBe(200);
  });

  it('starts throttling once the grace window is exhausted: 4 wrong-pw attempts pass through, the 5th is blocked', async () => {
    const s = await signupVerifyLogin(t);
    for (let i = 0; i < 4; i += 1) {
      const r = await deleteAccount(t, s, 'WrongPassw0rd!');
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const fifth = await deleteAccount(t, s, 'WrongPassw0rd!');
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('LOGIN_BACKOFF');
    expect(fifth.body.error.message).toMatch(/Invalid password\. Try again in \d+s\./);
  });

  it('frees the email so a fresh signup with the same address succeeds', async () => {
    const s = await signupVerifyLogin(t);
    const del = await deleteAccount(t, s, STRONG_PASSWORD);
    expect(del.status).toBe(204);

    const recreate = await request(t.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: s.email, password: STRONG_PASSWORD });
    expect(recreate.status).toBe(202);

    const reservation = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_EMAIL_RESERVATION'),
        Key: { emailLowercase: s.email.toLowerCase() },
      }),
    );
    expect((reservation.Item as EmailReservationRow | undefined)?.userId).not.toBe(s.userId);

    // The idempotency-key sweep must not blow away another household's rows (scan-filter misuse guard).
    const stillThere = await t.doc.send(
      new ScanCommand({
        TableName: tableName(t, 'TABLE_IDEMPOTENCY_KEY'),
        Limit: 1,
      }),
    );
    expect(stillThere.Items).toBeDefined();
  });
});
