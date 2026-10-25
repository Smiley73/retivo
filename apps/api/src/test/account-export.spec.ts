// Integration tests for GET /auth/account-export: every accounted-for section, history paging, no secret content, the export-cookie gate and cross-user isolation.
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ConfigService } from '@nestjs/config';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import KSUID from 'ksuid';
import {
  bootstrapTestApp,
  signupVerifyLogin,
  STRONG_PASSWORD,
  parseSetCookies,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { EXPORT_AUTHORIZATION_COOKIE_NAME } from '../auth/cookie-config.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import {
  type AccountExportFirstPage,
  type AccountExportNextPage,
} from '../auth/account-export.service.js';
import { ENVELOPE_META_SLOT_ID } from '../dynamo/types.js';
import type {
  CredentialRow,
  DeviceRegistryRow,
  EmailVerificationRow,
  HouseholdEnvelopeMetaRow,
  HouseholdKeyEnvelopeRow,
  IdempotencyKeyRow,
  MfaEmailOtpRow,
  MutationLogRow,
  PasskeyRow,
  PasswordResetRow,
  RefreshTokenRow,
  RevokedTokenRow,
  SignupApprovalRow,
  TrustedDeviceRow,
  UserMfaRow,
} from '../dynamo/types.js';

// Embedded in every secret-bearing field seeded below; the negative test asserts neither the value nor the omitted field names appear in the bundle.
const SECRET = 'SENTINEL_SECRET_VALUE_DO_NOT_EXPORT_9f3c7a';

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

// Every TABLE_* config key plus the one non-table section, derived independently of the service so deleting a section fails the assertion.
const EXPECTED_TABLE_SECTION_KEYS: Record<string, string> = {
  TABLE_WORKSPACE_META: 'workspaceMeta',
  TABLE_MUTATION_LOG: 'mutationLog',
  TABLE_AGGREGATE_VERSION: 'aggregateVersion',
  TABLE_IDEMPOTENCY_KEY: 'idempotencyKey',
  TABLE_DEVICE_REGISTRY: 'deviceRegistry',
  TABLE_USER: 'user',
  TABLE_EMAIL_RESERVATION: 'emailReservations',
  TABLE_EMAIL_VERIFICATION: 'emailVerifications',
  TABLE_PASSWORD_RESET: 'passwordReset',
  TABLE_SIGNUP_APPROVAL: 'signupApprovals',
  TABLE_CREDENTIAL: 'credential',
  TABLE_PASSKEY: 'passkeys',
  TABLE_REFRESH_TOKEN: 'refreshTokens',
  TABLE_REVOKED_TOKEN: 'revokedTokens',
  TABLE_FAILED_LOGIN_ATTEMPT: 'failedLoginAttempt',
  TABLE_AUTH_EVENT: 'history',
  TABLE_HOUSEHOLD_KEY_ENVELOPE: 'householdKeyEnvelope',
  TABLE_USER_MFA: 'userMfa',
  TABLE_MFA_EMAIL_OTP: 'mfaEmailOtp',
  TABLE_TRUSTED_DEVICE: 'trustedDevices',
};

describe('GET /auth/account-export', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  function authGet(s: Session, path: string): request.Test {
    return request(t.app.getHttpServer())
      .get(path)
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`);
  }

  async function mintExportCookie(s: Session): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/v1/auth/verify-password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .send({ currentPassword: STRONG_PASSWORD, purpose: 'data_export' });
    expect(res.status).toBe(204);
    const cookies = parseSetCookies(res.headers['set-cookie']);
    const xa = cookies[EXPORT_AUTHORIZATION_COOKIE_NAME];
    expect(xa).toBeTruthy();
    return xa!;
  }

  async function fetchWholeExport(
    s: Session,
    xa: string,
  ): Promise<AccountExportFirstPage> {
    const first = await request(t.app.getHttpServer())
      .get('/api/v1/auth/account-export')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('Cookie', `${EXPORT_AUTHORIZATION_COOKIE_NAME}=${encodeURIComponent(xa)}`);
    expect(first.status).toBe(200);
    const page = first.body as AccountExportFirstPage;
    const history = [...page.history];
    let cursor = page.nextCursor;
    let pages = 1;
    const seenIds = new Set(history.map((h: { eventId: string }) => h.eventId));
    while (cursor) {
      pages += 1;
      if (pages > 20) {
        throw new Error('Test-side page-loop ceiling exceeded — a stalled loop, not a real volume.');
      }
      const next = await request(t.app.getHttpServer())
        .get(`/api/v1/auth/account-export?cursor=${encodeURIComponent(cursor)}`)
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('Cookie', `${EXPORT_AUTHORIZATION_COOKIE_NAME}=${encodeURIComponent(xa)}`);
      expect(next.status).toBe(200);
      const nextPage = next.body as AccountExportNextPage;
      // Later pages carry only `history` and `nextCursor`; no non-paging section is repeated.
      expect(Object.keys(nextPage).sort()).toEqual(['history', 'nextCursor']);
      for (const row of nextPage.history as { eventId: string }[]) {
        expect(seenIds.has(row.eventId)).toBe(false); // no duplicates across pages
        seenIds.add(row.eventId);
      }
      history.push(...nextPage.history);
      cursor = nextPage.nextCursor;
    }
    (page as unknown as { __pagesFetched: number }).__pagesFetched = pages;
    return { ...page, history };
  }

  describe('seeded full export', () => {
    let s: Session;
    let xa: string;
    let exported: AccountExportFirstPage;
    let passkeyCredentialId: string;
    let liveSnapshotId: string;
    let liveSnapshotKey: string;

    beforeAll(async () => {
      s = await signupVerifyLogin(t);

      const boot = await authGet(s, '/api/v1/sync/bootstrap?force=false');
      expect(boot.status).toBe(200);

      // Mint the export-authorization cookie before the Credential seeding below replaces the real argon2 hash the data_export re-auth needs.
      xa = await mintExportCookie(s);

      const nowIso = new Date().toISOString();
      const nowSec = Math.floor(Date.now() / 1000);

      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_CREDENTIAL'),
          Item: { userId: s.userId, argon2Hash: SECRET, updatedAt: nowIso },
        }),
      );

      // Historical backup-code audit events stay exportable after the factor was retired.
      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_AUTH_EVENT'),
          Item: {
            userId: s.userId,
            eventId: (await KSUID.random()).string,
            eventType: 'mfa_backup_code_used',
            ip: null,
            userAgent: null,
            metadata: { historical: true },
            createdAt: nowIso,
            expiresAt: nowSec + 31536000,
          },
        }),
      );

      const extraRefresh: RefreshTokenRow = {
        userId: s.userId,
        tokenHash: `extra-${randomUUID()}`,
        tokenFamilyId: randomUUID(),
        expiresAt: nowSec + 3600,
        revokedAt: null,
        rotatedFrom: SECRET,
        userAgent: 'test-agent',
        ip: '203.0.113.7',
        jti: randomUUID(),
        deviceId: s.deviceId,
        householdId: s.householdId,
        createdAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_REFRESH_TOKEN'), Item: extraRefresh }),
      );
      // A second row whose sort key is itself the sentinel proves the SK value never leaks.
      const sentinelSkRow: RefreshTokenRow = {
        ...extraRefresh,
        tokenHash: SECRET,
        rotatedFrom: null,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_REFRESH_TOKEN'), Item: sentinelSkRow }),
      );

      const revoked: RevokedTokenRow = {
        jti: randomUUID(),
        userId: s.userId,
        revokedAt: nowIso,
        expiresAt: nowSec + 3600,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_REVOKED_TOKEN'), Item: revoked }),
      );

      // Without a seeded passkey the positive-inclusion assertion below is vacuous (`toBeDefined()` passes for an empty array).
      const passkey: PasskeyRow = {
        userId: s.userId,
        credentialId: `passkey-${randomUUID()}`,
        publicKey: 'base64url-public-key-bytes',
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        transports: ['internal'],
        createdAt: nowIso,
        lastUsedAt: null,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_PASSKEY'), Item: passkey }),
      );
      passkeyCredentialId = passkey.credentialId;

      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_FAILED_LOGIN_ATTEMPT'),
          Item: {
            emailLowercase: s.email.toLowerCase(),
            consecutiveFailures: 2,
            lastFailedAt: nowIso,
            expiresAt: nowSec + 86400,
          },
        }),
      );

      const approval: SignupApprovalRow = {
        approvalToken: SECRET,
        userId: s.userId,
        email: s.email,
        createdAt: nowIso,
        expiresAt: nowSec + 604800,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_SIGNUP_APPROVAL'), Item: approval }),
      );

      const verification: EmailVerificationRow = {
        verificationToken: SECRET,
        userId: s.userId,
        email: s.email,
        createdAt: nowIso,
        expiresAt: nowSec + 86400,
        purpose: 'verify_email',
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_EMAIL_VERIFICATION'), Item: verification }),
      );

      const reset: PasswordResetRow = {
        resetToken: SECRET,
        userId: s.userId,
        email: s.email,
        createdAt: nowIso,
        expiresAt: nowSec + 900,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_PASSWORD_RESET'), Item: reset }),
      );
      await t.doc.send(
        new UpdateCommand({
          TableName: tableName(t, 'TABLE_USER'),
          Key: { userId: s.userId },
          UpdateExpression: 'SET currentResetToken = :tok',
          ExpressionAttributeValues: { ':tok': SECRET },
        }),
      );

      const idem: IdempotencyKeyRow = {
        key: `${s.householdId}#${s.deviceId}#${randomUUID()}`,
        response: {
          status: 'applied',
          mutationId: randomUUID(),
          aggregateId: randomUUID(),
          newVersion: 1,
          newUpdatedAt: nowIso,
        },
        createdAt: nowIso,
        expiresAt: nowSec + 604800,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_IDEMPOTENCY_KEY'), Item: idem }),
      );

      const aggregateId = randomUUID();
      const mutation: MutationLogRow = {
        householdId: s.householdId,
        sequenceId: (await KSUID.random()).string,
        deviceId: s.deviceId,
        aggregateId,
        aggregateType: 'household',
        operation: 'create',
        payload: JSON.stringify({ secret: SECRET }),
        version: 1,
        timestamp: Date.now(),
        schemaVersion: 1,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_MUTATION_LOG'), Item: mutation }),
      );

      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_AGGREGATE_VERSION'),
          Item: {
            householdId: s.householdId,
            aggregateId,
            aggregateType: 'household',
            version: 1,
            updatedAt: nowIso,
            deletedAt: null,
          },
        }),
      );

      const device: DeviceRegistryRow = {
        householdId: s.householdId,
        deviceId: s.deviceId,
        displayName: 'Test Device',
        userProvidedName: false,
        lastSeenAt: nowIso,
        syncCursor: null,
        osType: null,
        userAgent: null,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_DEVICE_REGISTRY'), Item: device }),
      );

      const slot: HouseholdKeyEnvelopeRow = {
        householdId: s.householdId,
        slotId: 'password',
        slotType: 'password',
        kdf: { algorithm: 'Argon2id', m: 65536, t: 3, p: 4, salt: SECRET },
        wrappedKey: SECRET,
        encryptionVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_HOUSEHOLD_KEY_ENVELOPE'), Item: slot }),
      );
      // `prfSalt` and `credentialBinding` exist only on this slot type; without a seeded row carrying them the negative-content assertion is vacuous.
      const passkeyPrfSlot: HouseholdKeyEnvelopeRow = {
        householdId: s.householdId,
        slotId: 'passkey-prf-1',
        slotType: 'passkey_prf',
        prfSalt: SECRET,
        credentialBinding: SECRET,
        wrappedKey: SECRET,
        encryptionVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_HOUSEHOLD_KEY_ENVELOPE'), Item: passkeyPrfSlot }),
      );
      // Exercises `projectEnvelopeSlot`'s non-Argon2id branch; every other password slot here uses Argon2id.
      const pbkdf2Slot: HouseholdKeyEnvelopeRow = {
        householdId: s.householdId,
        slotId: 'password-legacy-pbkdf2',
        slotType: 'password',
        kdf: { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600000, salt: SECRET },
        wrappedKey: SECRET,
        encryptionVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_HOUSEHOLD_KEY_ENVELOPE'), Item: pbkdf2Slot }),
      );
      const meta: HouseholdEnvelopeMetaRow = {
        householdId: s.householdId,
        slotId: ENVELOPE_META_SLOT_ID,
        envelopeSetVersion: 1,
        envelopeSetTag: SECRET,
        updatedAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_HOUSEHOLD_KEY_ENVELOPE'), Item: meta }),
      );

      // `cursorTag` is an HMAC(HDK, freshnessCounter), the same key-derived-oracle class as `envelopeSetTag`; with `freshnessCounter` in the export
      // a leaked tag would let anyone verify candidate HDKs offline. `bumpFreshnessHead` is the only production writer, but this test holds no HDK.
      await t.doc.send(
        new UpdateCommand({
          TableName: tableName(t, 'TABLE_WORKSPACE_META'),
          Key: { householdId: s.householdId },
          UpdateExpression: 'SET freshnessCounter = :c, cursorTag = :t',
          ExpressionAttributeValues: { ':c': 1, ':t': SECRET },
        }),
      );

      // Raw pre-removal UserMfa row: `backupCodes` is an unknown legacy attribute the projection must omit.
      const userMfa = {
        userId: s.userId,
        totpEnabled: true,
        totpSecret: SECRET,
        pendingTotpSecret: SECRET,
        backupCodes: [{ hash: SECRET, usedAt: nowIso }, { hash: SECRET }],
        enrolledAt: nowIso,
        lastVerifiedAt: nowIso,
        updatedAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_USER_MFA'), Item: userMfa }),
      );

      const otpLogin: MfaEmailOtpRow = {
        userId: s.userId,
        codeHash: SECRET,
        expiresAt: nowSec + 600,
        sentAt: nowIso,
        attempts: 1,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_MFA_EMAIL_OTP'), Item: otpLogin }),
      );
      const otpStepUp: MfaEmailOtpRow = {
        userId: `${s.userId}#stepup`,
        codeHash: SECRET,
        expiresAt: nowSec + 600,
        sentAt: nowIso,
        attempts: 0,
        purpose: 'delete_account',
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_MFA_EMAIL_OTP'), Item: otpStepUp }),
      );

      const trusted: TrustedDeviceRow = {
        userId: s.userId,
        deviceId: randomUUID(),
        tokenHash: SECRET,
        createdAt: nowIso,
        expiresAt: nowSec + 2592000,
        lastUsedAt: nowIso,
        ip: '203.0.113.9',
        userAgent: 'test-agent-2',
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_TRUSTED_DEVICE'), Item: trusted }),
      );

      // Two S3 objects: a non-live one never pointed to by WorkspaceMeta, and `${liveSnapshotId}.json.gz` that latestSnapshotId targets, so
      // `isLive` has a real true/false distinction to assert.
      const s3 = t.module.get<S3Client>(S3_CLIENT);
      const bucket = t.module.get(ConfigService).get('SNAPSHOTS_BUCKET', { infer: true } as never) as unknown as string;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${s.householdId}/test-snapshot.json.gz`,
          Body: gzipSync(Buffer.from(JSON.stringify({ aggregates: [] }))),
          ContentType: 'application/json',
          ContentEncoding: 'gzip',
        }),
      );
      liveSnapshotId = `live-${randomUUID()}`;
      liveSnapshotKey = `${s.householdId}/${liveSnapshotId}.json.gz`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: liveSnapshotKey,
          Body: gzipSync(Buffer.from(JSON.stringify({ aggregates: [] }))),
          ContentType: 'application/json',
          ContentEncoding: 'gzip',
        }),
      );
      await t.doc.send(
        new UpdateCommand({
          TableName: tableName(t, 'TABLE_WORKSPACE_META'),
          Key: { householdId: s.householdId },
          UpdateExpression: 'SET latestSnapshotId = :id',
          ExpressionAttributeValues: { ':id': liveSnapshotId },
        }),
      );

      exported = await fetchWholeExport(s, xa);
    }, 30000);

    it('the export carries every section accounted for by the TABLE_* config names', () => {
      const expected = new Set(Object.values(EXPECTED_TABLE_SECTION_KEYS));
      expected.add('s3SnapshotInventory'); // the one non-table section
      expect(Object.keys(exported)).toEqual(expect.arrayContaining([...expected]));
    });

    it('includes a projected row for every accounted-for section', () => {
      expect(exported.workspaceMeta).not.toBeNull();
      expect(exported.mutationLog.length).toBeGreaterThan(0);
      expect(exported.aggregateVersion.length).toBeGreaterThan(0);
      expect(exported.idempotencyKey.length).toBeGreaterThan(0);
      expect(exported.deviceRegistry.length).toBeGreaterThan(0);
      expect(exported.user.userId).toBe(s.userId);
      expect(exported.emailReservations.length).toBeGreaterThan(0);
      expect(exported.emailVerifications.length).toBeGreaterThan(0);
      expect(exported.passwordReset).not.toBeNull();
      expect(exported.signupApprovals.length).toBeGreaterThan(0);
      expect(exported.credential).not.toBeNull();
      expect(exported.passkeys.length).toBeGreaterThan(0);
      expect(exported.passkeys.some((p) => p.credentialId === passkeyCredentialId)).toBe(true);
      expect(exported.refreshTokens.length).toBeGreaterThan(0);
      expect(exported.revokedTokens.length).toBeGreaterThan(0);
      expect(exported.failedLoginAttempt).not.toBeNull();
      expect(exported.history.length).toBeGreaterThan(0);
      expect(
        exported.history.some((row) => row.eventType === 'mfa_backup_code_used'),
      ).toBe(true);
      expect(exported.householdKeyEnvelope.slots.length).toBeGreaterThan(0);
      expect(exported.householdKeyEnvelope.meta).not.toBeNull();
      expect(exported.userMfa).not.toBeNull();
      expect(exported.mfaEmailOtp.login).not.toBeNull();
      expect(exported.mfaEmailOtp.stepUp).not.toBeNull();
      expect(exported.trustedDevices.length).toBeGreaterThan(0);
      expect(exported.s3SnapshotInventory.length).toBeGreaterThan(0);
    });

    it('the failed-login-attempt row is labelled as backoff state, not the retained history', () => {
      expect(exported.failedLoginAttempt!.note).toMatch(/24-hour sign-in backoff state/i);
      expect(exported.history.length).toBeGreaterThan(0);
    });

    it('the KDF algorithm and cost parameters are present for both the credential and the envelope slot', () => {
      expect(exported.credential!.kdf).toEqual({
        algorithm: 'Argon2id',
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });
      const slot = exported.householdKeyEnvelope.slots.find((sl) => sl.slotId === 'password');
      expect(slot?.kdf).toMatchObject({ algorithm: 'Argon2id', m: 65536, t: 3, p: 4 });
    });

    it('projects the legacy PBKDF2 KDF shape (algorithm + iterations only, no salt) for a non-Argon2id slot', () => {
      const slot = exported.householdKeyEnvelope.slots.find(
        (sl) => sl.slotId === 'password-legacy-pbkdf2',
      );
      expect(slot).toBeDefined();
      expect(slot?.kdf).toEqual({ algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600000 });
    });

    it('projects a passkey_prf slot without prfSalt/credentialBinding/wrappedKey', () => {
      const slot = exported.householdKeyEnvelope.slots.find((sl) => sl.slotId === 'passkey-prf-1');
      expect(slot).toBeDefined();
      expect(slot?.slotType).toBe('passkey_prf');
      expect(slot).not.toHaveProperty('prfSalt');
      expect(slot).not.toHaveProperty('credentialBinding');
      expect(slot).not.toHaveProperty('wrappedKey');
    });

    // Exactly the object WorkspaceMeta.latestSnapshotId points to is live, so the flag is not hardcoded or matched against the wrong key.
    it('marks exactly one snapshot inventory row isLive: true, matching workspaceMeta.latestSnapshotId', () => {
      expect(exported.s3SnapshotInventory.length).toBeGreaterThanOrEqual(2);
      const live = exported.s3SnapshotInventory.filter((row) => row.isLive);
      expect(live).toHaveLength(1);
      expect(live[0]!.key).toBe(liveSnapshotKey);
      const nonLive = exported.s3SnapshotInventory.filter((row) => !row.isLive);
      expect(nonLive.some((row) => row.key === `${s.householdId}/test-snapshot.json.gz`)).toBe(true);
      expect(nonLive.every((row) => row.isLive === false)).toBe(true);
    });

    // Asserted directly, not only via the sentinel scan, so a projection that also dropped `freshnessCounter` still fails.
    it('projects WorkspaceMeta explicitly, keeping freshnessCounter but omitting cursorTag', () => {
      expect(exported.workspaceMeta).not.toBeNull();
      expect(exported.workspaceMeta!.freshnessCounter).toBe(1);
      expect(exported.workspaceMeta).not.toHaveProperty('cursorTag');
    });

    it('serializes with no secret field name or sentinel value anywhere in the bundle', () => {
      const serialized = JSON.stringify(exported);
      for (const name of [
        'wrappedKey',
        '"salt"',
        'prfSalt',
        'credentialBinding',
        'envelopeSetTag',
        'cursorTag',
        'argon2Hash',
        '"tokenHash"',
        'rotatedFrom',
        'totpSecret',
        'pendingTotpSecret',
        'backupCodes',
        'backupCodeCount',
        '"hash"',
        'codeHash',
        'verificationToken',
        'resetToken',
        'approvalToken',
        'payload',
      ]) {
        expect(serialized).not.toContain(name);
      }
      // The sentinel value itself must never appear, so a field rename cannot defeat the projection.
      expect(serialized).not.toContain(SECRET);
    });
  });

  describe('paging at realistic volume', () => {
    it('returns the exact seeded count with no duplicates/gaps across pages, fetching more than one page', async () => {
      const s = await signupVerifyLogin(t);
      // `listForUser` pages by DynamoDB's ~1 MB response limit, so forcing a page split needs enough bytes, not rows; a realistic userAgent gets there with fewer rows.
      const COUNT = 3000;
      const REALISTIC_USER_AGENT =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0 '.repeat(3);
      const nowMs = Date.now();
      const rows = await Promise.all(
        Array.from({ length: COUNT }, async (_, i) => {
          const eventId = (await KSUID.random()).string;
          return {
            userId: s.userId,
            eventId,
            eventType: 'login' as const,
            ip: '203.0.113.42',
            userAgent: REALISTIC_USER_AGENT,
            metadata: null,
            createdAt: new Date(nowMs + i).toISOString(),
            expiresAt: Math.floor(nowMs / 1000) + 31536000,
          };
        }),
      );
      const CONCURRENCY = 40;
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const batch = rows.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map((row) =>
            t.doc.send(
              new PutCommand({ TableName: tableName(t, 'TABLE_AUTH_EVENT'), Item: row }),
            ),
          ),
        );
      }

      const xa = await mintExportCookie(s);
      const exported = await fetchWholeExport(s, xa);
      const seededEventIds = new Set(rows.map((r) => r.eventId));
      const exportedEventIds = new Set(
        (exported.history as { eventId: string }[]).map((h) => h.eventId),
      );
      // The signup/login flow appends a few real AuthEvent rows, so assert every seeded id appears exactly once instead of an exact total.
      expect(exportedEventIds.size).toBe(exported.history.length); // no duplicates
      for (const id of seededEventIds) {
        expect(exportedEventIds.has(id)).toBe(true);
      }
      expect((exported as unknown as { __pagesFetched: number }).__pagesFetched).toBeGreaterThan(1);
    }, 120000);

    it('raises rather than returning a short history when the page loop stalls', async () => {
      const s = await signupVerifyLogin(t);
      const xa = await mintExportCookie(s);
      const exported = await fetchWholeExport(s, xa);
      expect(exported.nextCursor).toBeNull();
    });
  });

  describe('no export cookie', () => {
    it('rejects a bearer-token-only request with EXPORT_AUTHORIZATION_REQUIRED', async () => {
      // ExportAuthorizationGuard is all that stands between a valid bearer token and the full export.
      const s = await signupVerifyLogin(t);
      const res = await authGet(s, '/api/v1/auth/account-export');
      expect([401, 403]).toContain(res.status);
      expect(res.body?.code ?? res.body?.error?.code).toBe('EXPORT_AUTHORIZATION_REQUIRED');
    });

    it('succeeds once the same caller mints the export cookie', async () => {
      const s = await signupVerifyLogin(t);
      const xa = await mintExportCookie(s);
      const exported = await fetchWholeExport(s, xa);
      expect(exported.user.userId).toBe(s.userId);
    });
  });

  describe('cursor forgery / foreign-user validation', () => {
    it('rejects a malformed cursor with 400 INVALID_EXPORT_CURSOR', async () => {
      const s = await signupVerifyLogin(t);
      const xa = await mintExportCookie(s);
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/account-export?cursor=not-valid-base64url-json!!!')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('Cookie', `${EXPORT_AUTHORIZATION_COOKIE_NAME}=${encodeURIComponent(xa)}`);
      expect(res.status).toBe(400);
      expect(res.body?.error?.code ?? res.body?.code).toBe('INVALID_EXPORT_CURSOR');
    });

    it("rejects a well-formed cursor whose embedded userId belongs to a different user with 400 INVALID_EXPORT_CURSOR", async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);
      // A forged cursor in the shape `encodeCursor` produces but with B's userId: the encoding is not secret, only re-validated server-side.
      const forgedCursor = Buffer.from(
        JSON.stringify({ userId: b.userId, eventId: (await KSUID.random()).string }),
        'utf8',
      ).toString('base64url');

      const aXa = await mintExportCookie(a);
      const res = await request(t.app.getHttpServer())
        .get(`/api/v1/auth/account-export?cursor=${encodeURIComponent(forgedCursor)}`)
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('Cookie', `${EXPORT_AUTHORIZATION_COOKIE_NAME}=${encodeURIComponent(aXa)}`);
      expect(res.status).toBe(400);
      expect(res.body?.error?.code ?? res.body?.code).toBe('INVALID_EXPORT_CURSOR');
    });
  });

  describe('cross-user isolation', () => {
    it("never returns another user's rows in any store", async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);
      const nowIso = new Date().toISOString();
      const nowSec = Math.floor(Date.now() / 1000);

      const bRevoked: RevokedTokenRow = {
        jti: `b-only-${randomUUID()}`,
        userId: b.userId,
        revokedAt: nowIso,
        expiresAt: nowSec + 3600,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_REVOKED_TOKEN'), Item: bRevoked }),
      );
      const bDevice: DeviceRegistryRow = {
        householdId: b.householdId,
        deviceId: `b-only-${randomUUID()}`,
        displayName: 'B Device',
        userProvidedName: false,
        lastSeenAt: nowIso,
        syncCursor: null,
        osType: null,
        userAgent: null,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_DEVICE_REGISTRY'), Item: bDevice }),
      );
      const bTrusted: TrustedDeviceRow = {
        userId: b.userId,
        deviceId: `b-only-${randomUUID()}`,
        tokenHash: 'b-hash',
        createdAt: nowIso,
        expiresAt: nowSec + 2592000,
        lastUsedAt: nowIso,
        ip: null,
        userAgent: null,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_TRUSTED_DEVICE'), Item: bTrusted }),
      );

      // Distinguishing rows for the remaining attributable stores; household-scoped sections are already isolated by the separate households.

      const bCredentialUpdatedAt = `1999-01-01T00:00:0${Math.floor(Math.random() * 9)}.000Z`;
      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_CREDENTIAL'),
          Item: { userId: b.userId, argon2Hash: 'b-only-hash', updatedAt: bCredentialUpdatedAt } as CredentialRow,
        }),
      );

      const bPasskey: PasskeyRow = {
        userId: b.userId,
        credentialId: `b-only-${randomUUID()}`,
        publicKey: 'b-only-public-key-bytes',
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        transports: null,
        createdAt: nowIso,
        lastUsedAt: null,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_PASSKEY'), Item: bPasskey }),
      );

      const bRefresh: RefreshTokenRow = {
        userId: b.userId,
        tokenHash: `b-only-${randomUUID()}`,
        tokenFamilyId: randomUUID(),
        expiresAt: nowSec + 3600,
        revokedAt: null,
        rotatedFrom: null,
        userAgent: null,
        ip: null,
        jti: `b-only-${randomUUID()}`,
        deviceId: b.deviceId,
        householdId: b.householdId,
        createdAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_REFRESH_TOKEN'), Item: bRefresh }),
      );

      const bEventId = (await KSUID.random()).string;
      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_AUTH_EVENT'),
          Item: {
            userId: b.userId,
            eventId: bEventId,
            eventType: 'login',
            ip: null,
            userAgent: null,
            metadata: null,
            createdAt: nowIso,
            expiresAt: nowSec + 31536000,
          },
        }),
      );

      const bSlot: HouseholdKeyEnvelopeRow = {
        householdId: b.householdId,
        slotId: `b-only-${randomUUID()}`,
        slotType: 'password',
        kdf: { algorithm: 'Argon2id', m: 65536, t: 3, p: 4, salt: 'b-only-salt' },
        wrappedKey: 'b-only-wrapped-key',
        encryptionVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_HOUSEHOLD_KEY_ENVELOPE'), Item: bSlot }),
      );

      const bUserMfa: UserMfaRow = {
        userId: b.userId,
        totpEnabled: true,
        totpSecret: 'b-only-totp-secret',
        enrolledAt: nowIso,
        updatedAt: nowIso,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_USER_MFA'), Item: bUserMfa }),
      );

      const bOtpLogin: MfaEmailOtpRow = {
        userId: b.userId,
        codeHash: 'b-only-code-hash',
        expiresAt: nowSec + 600,
        sentAt: nowIso,
        attempts: 0,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_MFA_EMAIL_OTP'), Item: bOtpLogin }),
      );
      const bOtpStepUp: MfaEmailOtpRow = {
        userId: `${b.userId}#stepup`,
        codeHash: 'b-only-code-hash',
        expiresAt: nowSec + 600,
        sentAt: nowIso,
        attempts: 0,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_MFA_EMAIL_OTP'), Item: bOtpStepUp }),
      );

      const bVerification: EmailVerificationRow = {
        verificationToken: `b-only-${randomUUID()}`,
        userId: b.userId,
        email: b.email,
        createdAt: nowIso,
        expiresAt: nowSec + 86400,
        purpose: 'verify_email',
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_EMAIL_VERIFICATION'), Item: bVerification }),
      );

      const bReset: PasswordResetRow = {
        resetToken: `b-only-${randomUUID()}`,
        userId: b.userId,
        email: b.email,
        createdAt: nowIso,
        expiresAt: nowSec + 900,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_PASSWORD_RESET'), Item: bReset }),
      );
      await t.doc.send(
        new UpdateCommand({
          TableName: tableName(t, 'TABLE_USER'),
          Key: { userId: b.userId },
          UpdateExpression: 'SET currentResetToken = :tok',
          ExpressionAttributeValues: { ':tok': bReset.resetToken },
        }),
      );

      const bApproval: SignupApprovalRow = {
        approvalToken: `b-only-${randomUUID()}`,
        userId: b.userId,
        email: b.email,
        createdAt: nowIso,
        expiresAt: nowSec + 604800,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_SIGNUP_APPROVAL'), Item: bApproval }),
      );

      const xa = await mintExportCookie(a);
      const exported = await fetchWholeExport(a, xa);

      expect(exported.user.userId).toBe(a.userId);
      expect(exported.user.userId).not.toBe(b.userId);
      expect(exported.revokedTokens.some((r) => r.jti === bRevoked.jti)).toBe(false);
      expect(exported.deviceRegistry.some((d) => d.deviceId === bDevice.deviceId)).toBe(false);
      expect(exported.trustedDevices.some((d) => d.deviceId === bTrusted.deviceId)).toBe(false);
      expect(exported.credential?.updatedAt).not.toBe(bCredentialUpdatedAt);
      expect(exported.passkeys.some((p) => p.credentialId === bPasskey.credentialId)).toBe(false);
      expect(exported.refreshTokens.some((r) => r.jti === bRefresh.jti)).toBe(false);
      expect((exported.history as { eventId: string }[]).some((h) => h.eventId === bEventId)).toBe(
        false,
      );
      expect(exported.householdKeyEnvelope.slots.some((sl) => sl.slotId === bSlot.slotId)).toBe(
        false,
      );
      expect(exported.userMfa).toBeNull();
      expect(exported.mfaEmailOtp.login).toBeNull();
      expect(exported.mfaEmailOtp.stepUp).toBeNull();
      expect(exported.emailReservations.some((r) => r.emailLowercase === b.email.toLowerCase())).toBe(
        false,
      );
      expect(exported.emailVerifications.some((v) => v.userId === b.userId)).toBe(false);
      expect(exported.passwordReset).toBeNull();
      expect(exported.signupApprovals.some((sa) => sa.email === b.email)).toBe(false);
    });
  });
});
