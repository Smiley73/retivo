// POST /auth/encrypted-workspace-reset wipes household sync rows, snapshots and key envelopes while preserving User, Credential, EmailReservation, revoked
// RefreshTokens and the audit trail; a wrong phrase or password is rejected and a repeat reset is idempotent.
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { ConfigService } from '@nestjs/config';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  bootstrapTestApp,
  decodeAccessClaims,
  freshDeviceId,
  parseSetCookies,
  scanAll,
  signupVerifyLogin,
  STRONG_PASSWORD,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME } from '../auth/cookie-config.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import { ENVELOPE_META_SLOT_ID } from '../dynamo/types.js';
import type {
  AuthEventRow,
  CredentialRow,
  DeviceRegistryRow,
  HouseholdEnvelopeMetaRow,
  HouseholdKeyEnvelopeRow,
  MutationLogRow,
  RefreshTokenRow,
  UserRow,
} from '../dynamo/types.js';

const RESET_PHRASE = 'DELETE';

// A plaintext push 403s, so reset-sweep tests seed the row they expect the reset to purge.
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
        payload: JSON.stringify({ name: 'Unreadable', currency: 'USD' }),
        version: 1,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
}

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

function reset(
  t: TestApp,
  s: Session,
  confirmation: string,
  currentPassword: string = STRONG_PASSWORD,
): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/encrypted-workspace-reset')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    // The password re-verify is required alongside the phrase; this suite runs with AUTH_MFA_ENFORCED off, so the floor is phrase plus password.
    .send({ confirmation, currentPassword });
}

async function seedEncryptedState(t: TestApp, s: Session): Promise<void> {
  const keyTable = tableName(t, 'TABLE_HOUSEHOLD_KEY_ENVELOPE');
  const now = new Date().toISOString();
  const slot: HouseholdKeyEnvelopeRow = {
    householdId: s.householdId,
    slotId: 'password',
    slotType: 'password',
    wrappedKey: 'd3RhcA',
    kdf: { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600_000, salt: 'c2FsdA' },
    encryptionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const meta: HouseholdEnvelopeMetaRow = {
    householdId: s.householdId,
    slotId: ENVELOPE_META_SLOT_ID,
    envelopeSetVersion: 1,
    envelopeSetTag: 'dGFn',
    updatedAt: now,
  };
  await t.doc.send(new PutCommand({ TableName: keyTable, Item: slot }));
  await t.doc.send(new PutCommand({ TableName: keyTable, Item: meta }));

  const device: DeviceRegistryRow = {
    householdId: s.householdId,
    deviceId: s.deviceId,
    displayName: 'Test device',
    userProvidedName: false,
    lastSeenAt: now,
    syncCursor: null,
    osType: null,
    userAgent: null,
  };
  await t.doc.send(
    new PutCommand({ TableName: tableName(t, 'TABLE_DEVICE_REGISTRY'), Item: device }),
  );
}

describe('encrypted-workspace reset', () => {
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

  it('wipes household sync rows + snapshots + key envelopes, preserves auth rows + audit trail', async () => {
    const s = await signupVerifyLogin(t);
    await seedHouseholdMutation(t, s);
    await seedEncryptedState(t, s);
    await s3.send(
      new PutObjectCommand({
        Bucket: snapshotsBucket,
        Key: `${s.householdId}/seed.json.gz`,
        Body: Buffer.from('seed'),
      }),
    );

    const res = await reset(t, s, RESET_PHRASE);
    expect(res.status).toBe(204);

    // The response clears the refresh and CSRF cookies so the SPA's reload to /login cannot replay a revoked refresh cookie; Express clears a cookie by re-emitting it with an empty value and a past Expires.
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    const clearedCookies = Array.isArray(setCookie) ? setCookie : [];
    const isCleared = (name: string): boolean =>
      clearedCookies.some(
        (line) =>
          line.startsWith(`${name}=;`) &&
          /expires=Thu, 01 Jan 1970/i.test(line),
      );
    expect(isCleared(REFRESH_COOKIE_NAME)).toBe(true);
    expect(isCleared(CSRF_COOKIE_NAME)).toBe(true);

    const muts = (await scanAll<MutationLogRow>(
      t.doc,
      tableName(t, 'TABLE_MUTATION_LOG'),
    )).filter((r) => r.householdId === s.householdId);
    expect(muts).toHaveLength(0);

    const devices = (await scanAll<DeviceRegistryRow>(
      t.doc,
      tableName(t, 'TABLE_DEVICE_REGISTRY'),
    )).filter((r) => r.householdId === s.householdId);
    expect(devices).toHaveLength(0);

    const keyRows = (await scanAll<HouseholdKeyEnvelopeRow>(
      t.doc,
      tableName(t, 'TABLE_HOUSEHOLD_KEY_ENVELOPE'),
    )).filter((r) => r.householdId === s.householdId);
    expect(keyRows).toHaveLength(0);

    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: snapshotsBucket,
        Prefix: `${s.householdId}/`,
      }),
    );
    expect(list.KeyCount ?? 0).toBe(0);

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

    const refresh = (await scanAll<RefreshTokenRow>(
      t.doc,
      tableName(t, 'TABLE_REFRESH_TOKEN'),
    )).filter((r) => r.userId === s.userId);
    expect(refresh.length).toBeGreaterThan(0);
    expect(refresh.every((r) => r.revokedAt !== null)).toBe(true);

    const stale = await request(t.app.getHttpServer())
      .get('/api/v1/auth/passkey/list')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(stale.status).toBe(401);

    const events = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId);
    expect(events.some((e) => e.eventType === 'encrypted_workspace_reset_started')).toBe(true);
    expect(events.some((e) => e.eventType === 'encrypted_workspace_reset_completed')).toBe(true);

    const reLogin = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: s.email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
    expect(reLogin.status).toBe(200);
  });

  it('rejects a wrong confirmation phrase with 400 and changes nothing', async () => {
    const s = await signupVerifyLogin(t);
    await seedHouseholdMutation(t, s);

    const res = await reset(t, s, 'wrong phrase');
    expect(res.status).toBe(400);

    const muts = (await scanAll<MutationLogRow>(
      t.doc,
      tableName(t, 'TABLE_MUTATION_LOG'),
    )).filter((r) => r.householdId === s.householdId);
    expect(muts.length).toBeGreaterThan(0);
  });

  it('rejects a wrong currentPassword with INVALID_CREDENTIALS and changes nothing', async () => {
    const s = await signupVerifyLogin(t);
    await seedHouseholdMutation(t, s);

    const res = await reset(t, s, RESET_PHRASE, 'WrongPassw0rd!');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    // The gate fails closed before the sweep.
    const muts = (await scanAll<MutationLogRow>(
      t.doc,
      tableName(t, 'TABLE_MUTATION_LOG'),
    )).filter((r) => r.householdId === s.householdId);
    expect(muts.length).toBeGreaterThan(0);
  });

  it('applies the shared per-account backoff after repeated wrong passwords', async () => {
    const s = await signupVerifyLogin(t);
    // The first 4 wrong-password attempts pass through the grace window; the 5th is throttled.
    for (let i = 0; i < 4; i += 1) {
      const r = await reset(t, s, RESET_PHRASE, 'WrongPassw0rd!');
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const fifth = await reset(t, s, RESET_PHRASE, 'WrongPassw0rd!');
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('LOGIN_BACKOFF');
  });

  it('is idempotent — a repeat reset on an already-empty household still 204s', async () => {
    const s = await signupVerifyLogin(t);
    await seedHouseholdMutation(t, s);
    await seedEncryptedState(t, s);

    const first = await reset(t, s, RESET_PHRASE);
    expect(first.status).toBe(204);

    const reLogin = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: s.email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
    const cookies = parseSetCookies(reLogin.headers['set-cookie']);
    const claims = decodeAccessClaims(reLogin.body.accessToken);
    const s2: Session = {
      accessToken: reLogin.body.accessToken,
      refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
      csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
      csrfValue: cookies[CSRF_COOKIE_NAME],
      deviceId: freshDeviceId(),
      householdId: claims.householdId,
      userId: claims.userId,
      email: s.email,
    };
    const second = await reset(t, s2, RESET_PHRASE);
    expect(second.status).toBe(204);
  });
});
