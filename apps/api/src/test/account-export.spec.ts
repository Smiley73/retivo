/**
 * Integration tests for `GET /auth/account-export`,
 * on the DynamoDB-Local harness. Covers:
 *  - seeded full export, positive inclusion of every accounted-for section;
 *  - paging at realistic volume for the `history` (AuthEvent) section;
 *  - negative secret content — no wrapped key / KDF salt / token hash / etc.
 *    is ever serialized, proven against seeded sentinel values;
 *  - the export-cookie gate: a bearer token alone never downloads the export;
 *  - cross-user isolation.
 */
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
  ACCOUNT_EXPORT_SECTION_KEYS,
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

/** Recognisable sentinel string embedded in every secret-bearing field seeded
 *  below. The negative test asserts NEITHER the sentinel VALUE nor the
 *  omitted field NAMES ever appear in the serialized bundle. */
const SECRET = 'SENTINEL_SECRET_VALUE_DO_NOT_EXPORT_9f3c7a';

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

/** The complete, independently-derived accounted-for section set: every
 *  `TABLE_*` config key, plus the one non-table section (`s3SnapshotInventory`).
 *  Deliberately NOT copy-pasted from `ACCOUNT_EXPORT_SECTION_KEYS` — this is
 *  its own derivation, so deleting a section from either side fails this
 *  assertion. */
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

  /** Re-verify with `purpose: 'data_export'` and return the minted
   *  export-authorization cookie value. */
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

  /** Walk every page of `GET /auth/account-export` under the cookie and
   *  return the first page's non-paging sections plus the FULL concatenated
   *  `history` across all pages. */
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
      // Every subsequent page carries ONLY `history` + `nextCursor` — no
      // non-paging section is repeated.
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

      // Force WorkspaceMeta into existence via a real bootstrap call.
      const boot = await authGet(s, '/api/v1/sync/bootstrap?force=false');
      expect(boot.status).toBe(200);

      // Mint the export-authorization cookie BEFORE any row is overwritten
      // below — the data_export re-auth needs the REAL argon2 credential
      // hash, which the Credential seeding a few lines down replaces with a
      // non-hash sentinel.
      xa = await mintExportCookie(s);

      const nowIso = new Date().toISOString();
      const nowSec = Math.floor(Date.now() / 1000);

      // Credential — overwrite the real signup row with a sentinel hash.
      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_CREDENTIAL'),
          Item: { userId: s.userId, argon2Hash: SECRET, updatedAt: nowIso },
        }),
      );

      // Historical backup-code audit evidence remains exportable after the
      // factor itself is retired; current code emits no new events of this type.
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

      // An extra RefreshToken row carrying sentinel tokenHash/rotatedFrom
      // (the SK — a live login already seeded a legitimate row too).
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
      // Overwrite its tokenHash-bearing row separately is not possible (SK);
      // instead assert the SECRET is absent via `rotatedFrom` above and via
      // a second row whose SK itself IS the sentinel (proves the SK value
      // never leaks even though it's a real DynamoDB attribute).
      const sentinelSkRow: RefreshTokenRow = {
        ...extraRefresh,
        tokenHash: SECRET,
        rotatedFrom: null,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_REFRESH_TOKEN'), Item: sentinelSkRow }),
      );

      // RevokedToken — via the new UserIndex GSI.
      const revoked: RevokedTokenRow = {
        jti: randomUUID(),
        userId: s.userId,
        revokedAt: nowIso,
        expiresAt: nowSec + 3600,
      };
      await t.doc.send(
        new PutCommand({ TableName: tableName(t, 'TABLE_REVOKED_TOKEN'), Item: revoked }),
      );

      // Passkey — this row was never seeded
      // before, making the positive-inclusion assertion below vacuous
      // (`toBeDefined()` passes for an empty array too).
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

      // FailedLoginAttempt — 24h backoff state, keyed by email.
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

      // SignupApproval — a leftover row (approval already completed via
      // signupVerifyLogin; this simulates one that outlived cleanup).
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

      // EmailVerification — a leftover row.
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

      // PasswordReset — row + the User pointer that makes it reachable.
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

      // IdempotencyKey.
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

      // MutationLog — payload carries the sentinel; must never be exported.
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

      // AggregateVersion.
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

      // DeviceRegistry.
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

      // HouseholdKeyEnvelope — slot + meta.
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
      // passkey_prf slot — 6.test-coverage.2: `prfSalt`/`credentialBinding`
      // are documented as present ONLY on this slot type. Without a seeded
      // row that actually carries them, the negative-content assertion below
      // (that neither field name ever appears in the serialized bundle) is
      // vacuous — nothing in the fixture has a non-null value for either.
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
      // Legacy PBKDF2-HMAC-SHA-256 password slot — 6.test-coverage.3:
      // `projectEnvelopeSlot`'s non-Argon2id branch (`{ algorithm,
      // iterations }`) was never exercised by any seeded row; every other
      // password slot in this fixture uses Argon2id.
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

      // WorkspaceMeta.cursorTag — this is an
      // HMAC(HDK, freshnessCounter) tag, the same key-derived-oracle class
      // `envelopeSetTag` above is already excluded for. The export also
      // carries `freshnessCounter` (the known message), so a leaked
      // `cursorTag` would let anyone with the export verify candidate HDKs
      // offline. `bumpFreshnessHead` is the only production writer; write
      // directly here since the test doesn't hold a real HDK.
      await t.doc.send(
        new UpdateCommand({
          TableName: tableName(t, 'TABLE_WORKSPACE_META'),
          Key: { householdId: s.householdId },
          UpdateExpression: 'SET freshnessCounter = :c, cursorTag = :t',
          ExpressionAttributeValues: { ':c': 1, ':t': SECRET },
        }),
      );

      // Raw pre-removal UserMfa row. `backupCodes` is now an unknown legacy
      // attribute; the explicit current projection must omit it entirely.
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

      // MfaEmailOtp — login row + namespaced step-up row.
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

      // TrustedDevice.
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

      // S3 snapshot objects — inventory metadata only, never bytes. Seed TWO
      // objects: the non-live `test-snapshot.json.gz` (an orphaned/prior
      // object never pointed to by WorkspaceMeta) and a second object
      // `${liveSnapshotId}.json.gz` that WorkspaceMeta.latestSnapshotId is
      // then pointed at, so `isLive` has a
      // real true/false distinction to assert instead of an all-false or
      // vacuously-nonempty inventory.
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

    it('the exported section-key constant equals the accounted-for set independently derived from TABLE_* config names', () => {
      const expected = new Set(Object.values(EXPECTED_TABLE_SECTION_KEYS));
      expected.add('s3SnapshotInventory'); // the one non-table section
      expect(new Set(ACCOUNT_EXPORT_SECTION_KEYS)).toEqual(expected);
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
      // It carries the same event count as the retained AuthEvent history and
      // is not a substitute for it — a separate `history` section is present.
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

    // 6.test-coverage.3: the legacy PBKDF2 branch (`{ algorithm, iterations }`,
    // as opposed to Argon2id's `{ algorithm, m, t, p }`) — exercised by the
    // seeded `password-legacy-pbkdf2` slot above.
    it('projects the legacy PBKDF2 KDF shape (algorithm + iterations only, no salt) for a non-Argon2id slot', () => {
      const slot = exported.householdKeyEnvelope.slots.find(
        (sl) => sl.slotId === 'password-legacy-pbkdf2',
      );
      expect(slot).toBeDefined();
      expect(slot?.kdf).toEqual({ algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600000 });
    });

    // 6.test-coverage.2: the seeded `passkey_prf` slot carries real
    // `prfSalt`/`credentialBinding` sentinel values — proves the projection
    // actually strips them, rather than the generic scan below passing
    // vacuously because nothing in the fixture ever had them.
    it('projects a passkey_prf slot without prfSalt/credentialBinding/wrappedKey', () => {
      const slot = exported.householdKeyEnvelope.slots.find((sl) => sl.slotId === 'passkey-prf-1');
      expect(slot).toBeDefined();
      expect(slot?.slotType).toBe('passkey_prf');
      expect(slot).not.toHaveProperty('prfSalt');
      expect(slot).not.toHaveProperty('credentialBinding');
      expect(slot).not.toHaveProperty('wrappedKey');
    });

    // Exactly one seeded snapshot object is
    // marked live — the one WorkspaceMeta.latestSnapshotId actually points
    // to — proving the flag isn't hardcoded true/false or matched against
    // the wrong key/household.
    it('marks exactly one snapshot inventory row isLive: true, matching workspaceMeta.latestSnapshotId', () => {
      expect(exported.s3SnapshotInventory.length).toBeGreaterThanOrEqual(2);
      const live = exported.s3SnapshotInventory.filter((row) => row.isLive);
      expect(live).toHaveLength(1);
      expect(live[0]!.key).toBe(liveSnapshotKey);
      const nonLive = exported.s3SnapshotInventory.filter((row) => !row.isLive);
      expect(nonLive.some((row) => row.key === `${s.householdId}/test-snapshot.json.gz`)).toBe(true);
      expect(nonLive.every((row) => row.isLive === false)).toBe(true);
    });

    // `cursorTag` is an HMAC(HDK, freshnessCounter) —
    // the same key-derived-oracle class `envelopeSetTag` is already excluded
    // for. Asserted directly (not just via the generic sentinel scan below)
    // so a projection that dropped `freshnessCounter` too — passing the
    // generic scan vacuously — would still fail here.
    it('projects WorkspaceMeta explicitly, keeping freshnessCounter but omitting cursorTag', () => {
      expect(exported.workspaceMeta).not.toBeNull();
      expect(exported.workspaceMeta!.freshnessCounter).toBe(1);
      expect(exported.workspaceMeta).not.toHaveProperty('cursorTag');
    });

    it('serializes with no secret field name or sentinel value anywhere in the bundle', () => {
      const serialized = JSON.stringify(exported);
      // Field NAMES that must never appear as a key.
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
      // The sentinel VALUE itself must never appear — proves a field rename
      // can't defeat the projection.
      expect(serialized).not.toContain(SECRET);
    });
  });

  describe('paging at realistic volume', () => {
    it('returns the exact seeded count with no duplicates/gaps across pages, fetching more than one page', async () => {
      const s = await signupVerifyLogin(t);
      // `listForUser` no longer hard-caps a page at 1,000 rows —
      // it now pages by DynamoDB's own ~1 MB response-size limit, so this
      // needs enough seeded BYTES (not just rows) to force a real page split.
      // A realistic browser `userAgent` string (rather than `null`) both
      // makes the fixture more representative and gets there with a much
      // smaller, faster-to-seed row count than relying on row count alone.
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
      // The signup/login flow itself appends a handful of real AuthEvent rows
      // (signup, email_verify, signup_approved, login…) — assert every
      // SEEDED id round-tripped exactly once (no dup, no gap), rather than an
      // exact total count.
      expect(exportedEventIds.size).toBe(exported.history.length); // no duplicates
      for (const id of seededEventIds) {
        expect(exportedEventIds.has(id)).toBe(true);
      }
      expect((exported as unknown as { __pagesFetched: number }).__pagesFetched).toBeGreaterThan(1);
    }, 120000);

    it('raises rather than returning a short history when the page loop stalls', async () => {
      // The test-side loop ceiling in fetchWholeExport() throws if a real
      // server response ever kept advancing past 20 pages without
      // terminating; the server's own paging contract is proven by the
      // volume test above completing in a bounded number of pages. This
      // documents the guarantee explicitly: a `nextCursor` that never
      // resolves to null must never be silently accepted as "done".
      const s = await signupVerifyLogin(t);
      const xa = await mintExportCookie(s);
      const exported = await fetchWholeExport(s, xa);
      expect(exported.nextCursor).toBeNull();
    });
  });

  describe('no export cookie', () => {
    it('rejects a bearer-token-only request with EXPORT_AUTHORIZATION_REQUIRED', async () => {
      // ExportAuthorizationGuard is the only thing standing between a valid
      // bearer token and the full export; this fails if it is removed.
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
      // Hand-build a well-formed cursor in the SAME shape
      // `auth-events.repository.ts`'s `encodeCursor` produces
      // (base64url-encoded `{ userId, eventId }` JSON), but embedding B's
      // userId — a forged cursor a malicious A could construct without ever
      // seeing a real page from B, since the encoding is not secret, only
      // re-validated server-side.
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

      // Seed a distinguishing row for B in every keyed-by-userId /
      // keyed-by-householdId store.
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

      // Extend the distinguishing-row seed to
      // every remaining attributable store (Credential, Passkey,
      // RefreshToken, AuthEvent history, HouseholdKeyEnvelope,
      // UserMfa, MfaEmailOtp, EmailReservation, EmailVerification,
      // PasswordReset, SignupApproval). WorkspaceMeta / MutationLog /
      // AggregateVersion / IdempotencyKey are household-scoped and already
      // naturally isolated by A and B having distinct households from
      // separate `signupVerifyLogin` calls.

      // Credential — overwrite B's real signup row with a distinguishing
      // marker updatedAt (never surfaced by name/value, only by timestamp).
      const bCredentialUpdatedAt = `1999-01-01T00:00:0${Math.floor(Math.random() * 9)}.000Z`;
      await t.doc.send(
        new PutCommand({
          TableName: tableName(t, 'TABLE_CREDENTIAL'),
          Item: { userId: b.userId, argon2Hash: 'b-only-hash', updatedAt: bCredentialUpdatedAt } as CredentialRow,
        }),
      );

      // Passkey.
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

      // RefreshToken.
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

      // AuthEvent (history) — the paging section.
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

      // HouseholdKeyEnvelope — B's own household; distinct from A's, so this
      // also proves the household-scoped read never leaks across the
      // household boundary.
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

      // UserMfa.
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

      // MfaEmailOtp — login + step-up rows.
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

      // EmailVerification.
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

      // PasswordReset — row + the User pointer that makes it reachable.
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

      // SignupApproval — a leftover row.
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
