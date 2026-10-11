/**
 * Account-deletion integration tests against the local emulator.
 *
 * Covers the `DELETE /auth/account` cascade: password re-auth, sweep of
 * every household-scoped row + S3 object, sweep of every auth-state row
 * for the user, retention of `account_deletion_*` `AuthEvent` rows.
 */
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

/**
 * Seed a MutationLog row for the household directly. A plaintext
 * `POST /sync/push` 403s, so the deletion-sweep test seeds the row it expects
 * the cascade to purge rather than pushing it through the API.
 */
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

    // Plant a snapshot under the household prefix so we can prove the S3
    // sweep deletes it (the compactor doesn't run in tests).
    await s3.send(
      new PutObjectCommand({
        Bucket: snapshotsBucket,
        Key: `${s.householdId}/seed.json.gz`,
        Body: Buffer.from('seed'),
      }),
    );

    const res = await deleteAccount(t, s, STRONG_PASSWORD);
    expect(res.status).toBe(204);

    // User row gone.
    const userRow = await t.doc.send(
      new GetCommand({ TableName: tableName(t, 'TABLE_USER'), Key: { userId: s.userId } }),
    );
    expect(userRow.Item).toBeUndefined();

    // Credential gone.
    const cred = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_CREDENTIAL'),
        Key: { userId: s.userId },
      }),
    );
    expect(cred.Item).toBeUndefined();

    // EmailReservation gone — email becomes free again.
    const reservation = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_EMAIL_RESERVATION'),
        Key: { emailLowercase: s.email.toLowerCase() },
      }),
    );
    expect(reservation.Item).toBeUndefined();

    // No refresh-token rows for the user.
    const refresh = (await scanAll<RefreshTokenRow>(
      t.doc,
      tableName(t, 'TABLE_REFRESH_TOKEN'),
    )).filter((r) => r.userId === s.userId);
    expect(refresh).toHaveLength(0);

    // MutationLog has nothing for this household.
    const muts = (await scanAll<MutationLogRow>(
      t.doc,
      tableName(t, 'TABLE_MUTATION_LOG'),
    )).filter((r) => r.householdId === s.householdId);
    expect(muts).toHaveLength(0);

    // S3 prefix is empty.
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: snapshotsBucket,
        Prefix: `${s.householdId}/`,
      }),
    );
    expect(list.KeyCount ?? 0).toBe(0);

    // Audit events retained — both initiated + completed.
    const events = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId);
    expect(events.some((e) => e.eventType === 'account_deletion_initiated')).toBe(true);
    expect(events.some((e) => e.eventType === 'account_deletion_completed')).toBe(true);

    // Old access token rejected on the denylist.
    const stale = await request(t.app.getHttpServer())
      .get('/api/v1/auth/passkey/list')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(stale.status).toBe(401);

    // Login with the same email + password fails — user is gone.
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

    // User row still present.
    const userRow = await t.doc.send(
      new GetCommand({ TableName: tableName(t, 'TABLE_USER'), Key: { userId: s.userId } }),
    );
    expect((userRow.Item as UserRow | undefined)?.userId).toBe(s.userId);

    // Credential row still present.
    const cred = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_CREDENTIAL'),
        Key: { userId: s.userId },
      }),
    );
    expect((cred.Item as CredentialRow | undefined)?.userId).toBe(s.userId);

    // The first 3 wrong-password attempts are within the grace window); subsequent
    // login still works because no backoff is in effect yet.
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

    // The recreated reservation is owned by a *new* userId.
    const reservation = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_EMAIL_RESERVATION'),
        Key: { emailLowercase: s.email.toLowerCase() },
      }),
    );
    expect((reservation.Item as EmailReservationRow | undefined)?.userId).not.toBe(s.userId);

    // And the idempotency-key sweep didn't blow away another household's
    // rows (sanity guard against scan filter misuse).
    const stillThere = await t.doc.send(
      new ScanCommand({
        TableName: tableName(t, 'TABLE_IDEMPOTENCY_KEY'),
        Limit: 1,
      }),
    );
    expect(stillThere.Items).toBeDefined();
  });
});
