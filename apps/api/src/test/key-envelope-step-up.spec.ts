// Step-up gate and archive coverage for PUT/DELETE /auth/key-envelopes/:slotId and POST .../activate under AUTH_MFA_ENFORCED=true,
// plus the passkey_prf password floor with the flag off.
import request from 'supertest';
import { generateSync } from 'otplib';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  decodeAccessClaims,
  freshDeviceId,
  freshEmail,
  parseSetCookies,
  signupVerifyLogin,
  type TestApp,
  recoverEmailOtp,
  sendAndRecoverStepUpOtp,
  enrollTotp,
  authSet,
} from './test-helpers.js';
import { REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME } from '../auth/cookie-config.js';
import { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';

const ORIGIN = () => process.env.WEB_ORIGIN!;

interface Session {
  accessToken: string;
  refreshCookie: string;
  csrfCookie: string;
  csrfValue: string;
  householdId: string;
  userId: string;
  email: string;
}

function recoveryBody(
  householdId: string,
  envelopeSetVersion: number,
  envelopeSetTag: string,
  wrappedKey = 'cmVjb3Zlcnk',
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    slot: {
      householdId,
      slotId: 'recovery',
      slotType: 'recovery',
      wrappedKey,
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    envelopeSetVersion,
    expectedEnvelopeSetVersion: envelopeSetVersion - 1,
    envelopeSetTag,
  };
}

function passwordSlotBody(
  householdId: string,
  envelopeSetVersion: number,
  envelopeSetTag: string,
  wrappedKey = 'd3JhcHBlZA',
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    slot: {
      householdId,
      slotId: 'password',
      slotType: 'password',
      kdf: { algorithm: 'Argon2id', m: 65_536, t: 3, p: 4, salt: 'c2FsdA' },
      wrappedKey,
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    envelopeSetVersion,
    expectedEnvelopeSetVersion: envelopeSetVersion - 1,
    envelopeSetTag,
  };
}

function newPasskeyPrfBody(
  householdId: string,
  envelopeSetVersion: number,
  envelopeSetTag: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    slot: {
      householdId,
      slotId: 'passkey_prf',
      slotType: 'passkey_prf',
      prfSalt: 'cHJmU2FsdA',
      wrappedKey: 'cHJmd3JhcA',
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    envelopeSetVersion,
    expectedEnvelopeSetVersion: envelopeSetVersion - 1,
    envelopeSetTag,
  };
}

describe('key-envelope step-up gate + archive', () => {
  let t: TestApp;
  let priorEnforced: string | undefined;

  beforeAll(async () => {
    priorEnforced = process.env.AUTH_MFA_ENFORCED;
    process.env.AUTH_MFA_ENFORCED = 'true';
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
    if (priorEnforced === undefined) delete process.env.AUTH_MFA_ENFORCED;
    else process.env.AUTH_MFA_ENFORCED = priorEnforced;
  });

  // Logs in an existing user through the MFA challenge, so a test can re-authenticate under a new password after a reset. Pass `totpSecret`
  // for a second login in one test: Email-OTP send has a 60s per-user cooldown shared across purposes, so a second send silently no-ops.
  async function loginMfa(
    email: string,
    password: string,
    userId: string,
    totpSecret?: string,
  ): Promise<Session> {
    const deviceId = freshDeviceId();
    const login = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN())
      .send({ email, password, deviceId });
    const challengeToken = login.body.challengeToken as string;
    const verifyBody = totpSecret
      ? { challengeToken, method: 'totp', code: generateSync({ secret: totpSecret }), deviceId }
      : await (async () => {
          await request(t.app.getHttpServer())
            .post('/api/v1/auth/mfa/email/send')
            .set('Origin', ORIGIN())
            .send({ challengeToken })
            .expect(202);
          const code = await recoverEmailOtp(t, userId);
          return { challengeToken, method: 'email_otp', code, deviceId };
        })();
    const verify = await request(t.app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', ORIGIN())
      .send(verifyBody);
    const cookies = parseSetCookies(verify.headers['set-cookie']);
    const { householdId } = decodeAccessClaims(verify.body.accessToken as string);
    return {
      accessToken: verify.body.accessToken,
      refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
      csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
      csrfValue: cookies[CSRF_COOKIE_NAME],
      householdId,
      userId,
      email,
    };
  }

  async function signupAndLoginMfa(): Promise<Session> {
    const email = freshEmail();
    const signup = await request(t.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', ORIGIN())
      .send({ email, password: STRONG_PASSWORD });
    const userId = signup.body.userId as string;
    const verifyRes = await request(t.app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .set('Origin', ORIGIN())
      .send({ token: signup.body.verificationToken })
      .expect(200);
    await request(t.app.getHttpServer())
      .post('/api/v1/auth/approve-signup')
      .set('Origin', ORIGIN())
      .send({ token: verifyRes.body.approvalToken })
      .expect(200);

    return loginMfa(email, STRONG_PASSWORD, userId);
  }

  function putRecovery(s: Session, body: Record<string, unknown>): request.Test {
    return authSet(s)(request(t.app.getHttpServer()).put('/api/v1/auth/key-envelopes/recovery')).send(
      body,
    );
  }

  function deleteRecovery(s: Session, body: Record<string, unknown>): request.Test {
    return authSet(s)(
      request(t.app.getHttpServer()).delete('/api/v1/auth/key-envelopes/recovery'),
    ).send(body);
  }

  function putPasswordSlot(s: Session, body: Record<string, unknown>): request.Test {
    return authSet(s)(
      request(t.app.getHttpServer()).put('/api/v1/auth/key-envelopes/password'),
    ).send(body);
  }

  function activate(s: Session, body: Record<string, unknown>): request.Test {
    return authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/key-envelopes/activate'),
    ).send(body);
  }

  async function keyEnvelopeRows(
    householdId: string,
    slotIdPrefix?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const raw = await t.doc.send(
      new QueryCommand({
        TableName: process.env.TABLE_HOUSEHOLD_KEY_ENVELOPE,
        KeyConditionExpression: slotIdPrefix
          ? 'householdId = :h AND begins_with(slotId, :p)'
          : 'householdId = :h',
        ExpressionAttributeValues: slotIdPrefix
          ? { ':h': householdId, ':p': slotIdPrefix }
          : { ':h': householdId },
      }),
    );
    return (raw.Items ?? []) as Array<Record<string, unknown>>;
  }

  // The archived meta row carries the slot-id membership at the displaced version, the manifest the restore runbook keys off.
  async function expectFirstVersionArchived(householdId: string, slotIds: string[]): Promise<void> {
    const archived = await keyEnvelopeRows(householdId, 'ARCHIVE#');
    expect(archived.some((r) => r.wrappedKey === 'b3JpZ2luYWw')).toBe(true);
    expect(archived.some((r) => r.envelopeSetTag === 'dGFnMQ')).toBe(true);
    expect(archived.every((r) => typeof r.expiresAt === 'number')).toBe(true);
    expect(archived.find((r) => r.slotId === 'ARCHIVE#1#ENVELOPE_META')?.slotIds).toEqual(slotIds);
  }

  it('first activation (no slot rows) stays proofless even with MFA enforced', async () => {
    const s = await signupAndLoginMfa();
    const res = await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ'));
    expect(res.status).toBe(204);
  });

  it('creating a brand-new slot id on a household that already holds a slot now REQUIRES a proof', async () => {
    // A PUT creating a new slot id on a household that already holds one needs a proof: otherwise a stolen bearer session could mint a new
    // unlock path (e.g. a first `passkey_prf` slot) with no proof, any time. The password floor applies too, since the slot is `passkey_prf`.
    const s = await signupAndLoginMfa();
    await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);

    const refused = await authSet(s)(
      request(t.app.getHttpServer()).put('/api/v1/auth/key-envelopes/passkey_prf'),
    ).send(newPasskeyPrfBody(s.householdId, 2, 'dGFnMg'));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('STEP_UP_PROOF_MISSING');

    const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
    const ok = await authSet(s)(
      request(t.app.getHttpServer()).put('/api/v1/auth/key-envelopes/passkey_prf'),
    ).send({
      ...newPasskeyPrfBody(s.householdId, 2, 'dGFnMg'),
      method: 'email_otp',
      code,
      currentPassword: STRONG_PASSWORD,
    });
    expect(ok.status).toBe(204);
  });

  describe('a replacing PUT', () => {
    it('with no proof is refused and leaves the stored slot + meta byte-identical', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const before = await repo.getStableEnvelopeSet(s.householdId);

      const res = await putRecovery(
        s,
        recoveryBody(s.householdId, 2, 'dGFnMg', 'cmVwbGFjZWQ'),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('STEP_UP_PROOF_MISSING');

      const after = await repo.getStableEnvelopeSet(s.householdId);
      expect(after).toEqual(before);
    });

    it('succeeds with a valid proof, and the same proof cannot be replayed', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);

      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
      const ok = await putRecovery(s, {
        ...recoveryBody(s.householdId, 2, 'dGFnMg', 'cmVwbGFjZWQ'),
        method: 'email_otp',
        code,
      });
      expect(ok.status).toBe(204);

      // The consumed code is rejected when replayed on a third replace.
      const replay = await putRecovery(s, {
        ...recoveryBody(s.householdId, 3, 'dGFnMw', 'cmVwbGFjZWQyfQ'),
        method: 'email_otp',
        code,
      });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('MFA_CODE_INVALID');
    });
  });

  describe('DELETE', () => {
    it('with no proof is refused and leaves the stored slot + meta byte-identical', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const before = await repo.getStableEnvelopeSet(s.householdId);

      const res = await deleteRecovery(s, {
        envelopeSetVersion: 2,
        expectedEnvelopeSetVersion: 1,
        envelopeSetTag: 'dGFnMg',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('STEP_UP_PROOF_MISSING');

      const after = await repo.getStableEnvelopeSet(s.householdId);
      expect(after).toEqual(before);
    });

    it('succeeds with a valid proof', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);
      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_delete');
      const res = await deleteRecovery(s, {
        envelopeSetVersion: 2,
        expectedEnvelopeSetVersion: 1,
        envelopeSetTag: 'dGFnMg',
        method: 'email_otp',
        code,
      });
      expect(res.status).toBe(204);
    });
  });

  describe('the post-reset re-wrap exemption', () => {
    it('a password-slot PUT succeeds proofless while the re-wrap is owed, and is refused once the slot is repaired', async () => {
      const s = await signupAndLoginMfa();
      // Enrolling TOTP lets the second login after the reset verify without a second Email-OTP send, which would hit the 60s cooldown.
      const totpSecret = await enrollTotp(t, s);

      await putPasswordSlot(s, passwordSlotBody(s.householdId, 1, 'dGFnMQ')).expect(204);

      // A password reset mints a new credentialRevision without touching the password slot (the user lacks the old password to re-wrap it): the
      // state `isCanonicalPasswordRewrapOwed` detects.
      const reqReset = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .set('Origin', ORIGIN())
        .send({ email: s.email });
      expect(reqReset.status).toBe(202);
      const resetToken = reqReset.body.resetToken as string;
      const NEW_PASSWORD = 'PostResetPassw0rd!New';
      const consume = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', ORIGIN())
        .send({ token: resetToken, newPassword: NEW_PASSWORD });
      expect(consume.status).toBe(204);

      const s2 = await loginMfa(s.email, NEW_PASSWORD, s.userId, totpSecret);

      // Owed: the controller's revision compare, not only the predicate, must derive true here for the write to pass with no proof.
      const proofless = await putPasswordSlot(
        s2,
        passwordSlotBody(s2.householdId, 2, 'dGFnMg', 'cmV3cmFwcGVk'),
      );
      expect(proofless.status).toBe(204);

      // Repaired: the slot carries the current revision, so the exemption closes and the next password-slot write is refused, leaving slot and meta byte-identical.
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const before = await repo.getStableEnvelopeSet(s2.householdId);

      const refused = await putPasswordSlot(
        s2,
        passwordSlotBody(s2.householdId, 3, 'dGFnMw', 'YWdhaW4='),
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('STEP_UP_PROOF_MISSING');

      const after = await repo.getStableEnvelopeSet(s2.householdId);
      expect(after).toEqual(before);
    });
  });

  describe('archive', () => {
    it('a replace leaves the prior slot + meta readable as archive rows, invisible to GET / listSlots', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ', 'b3JpZ2luYWw')).expect(204);
      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
      await putRecovery(s, {
        ...recoveryBody(s.householdId, 2, 'dGFnMg', 'cmVwbGFjZWQ'),
        method: 'email_otp',
        code,
      }).expect(204);

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const { slots } = await repo.getStableEnvelopeSet(s.householdId);
      expect(slots).toHaveLength(1);
      expect(slots[0]!.wrappedKey).toBe('cmVwbGFjZWQ');

      await expectFirstVersionArchived(s.householdId, ['recovery']);

      const get = await authSet(s)(
        request(t.app.getHttpServer()).get('/api/v1/auth/key-envelopes'),
      );
      expect((get.body.slots as Array<{ wrappedKey: string }>).map((x) => x.wrappedKey)).toEqual([
        'cmVwbGFjZWQ',
      ]);
    });

    it('a DELETE leaves the prior slot + meta readable as archive rows, invisible to GET / listSlots', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ', 'b3JpZ2luYWw')).expect(204);
      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_delete');
      await deleteRecovery(s, {
        envelopeSetVersion: 2,
        expectedEnvelopeSetVersion: 1,
        envelopeSetTag: 'dGFnMg',
        method: 'email_otp',
        code,
      }).expect(204);

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const { slots } = await repo.getStableEnvelopeSet(s.householdId);
      expect(slots).toHaveLength(0);

      await expectFirstVersionArchived(s.householdId, ['recovery']);

      const get = await authSet(s)(
        request(t.app.getHttpServer()).get('/api/v1/auth/key-envelopes'),
      );
      expect(get.body.slots).toEqual([]);
    });

    it('a change-password re-wrap of the password slot leaves the prior slot + meta readable as archive rows', async () => {
      const s = await signupAndLoginMfa();
      await putPasswordSlot(s, passwordSlotBody(s.householdId, 1, 'dGFnMQ', 'b3JpZ2luYWw')).expect(204);

      const code = await sendAndRecoverStepUpOtp(t, s, 'change_password');
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-password'),
      ).send({
        currentPassword: STRONG_PASSWORD,
        newPassword: 'ChangePwStep0nly!New',
        slot: passwordSlotBody(s.householdId, 2, 'dGFnMg', 'cmV3cmFwcGVk').slot,
        envelopeSetVersion: 2,
        expectedEnvelopeSetVersion: 1,
        envelopeSetTag: 'dGFnMg',
        method: 'email_otp',
        code,
      });
      expect(res.status).toBe(200);

      await expectFirstVersionArchived(s.householdId, ['password']);
    });

    it('an account deletion removes archive rows too (anti-resurrection)', async () => {
      const s = await signupAndLoginMfa();
      // enrollTotp() spends one Email-OTP step-up proof; sendAndRecoverStepUpOtp clears the 60s cooldown before each send, and the delete step
      // uses TOTP instead of a third Email-OTP send.
      const secret = await enrollTotp(t, s);
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);
      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
      await putRecovery(s, {
        ...recoveryBody(s.householdId, 2, 'dGFnMg', 'cmVwbGFjZWQ'),
        method: 'email_otp',
        code,
      }).expect(204);

      await authSet(s)(request(t.app.getHttpServer()).delete('/api/v1/auth/account'))
        .send({ currentPassword: STRONG_PASSWORD, method: 'totp', code: generateSync({ secret }) })
        .expect(204);

      expect(await keyEnvelopeRows(s.householdId)).toEqual([]);
    });

    it('an encrypted-workspace reset removes archive rows too', async () => {
      const s = await signupAndLoginMfa();
      const secret = await enrollTotp(t, s);
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);
      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
      await putRecovery(s, {
        ...recoveryBody(s.householdId, 2, 'dGFnMg', 'cmVwbGFjZWQ'),
        method: 'email_otp',
        code,
      }).expect(204);

      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/encrypted-workspace-reset'),
      )
        .send({
          confirmation: 'DELETE',
          currentPassword: STRONG_PASSWORD,
          method: 'totp',
          code: generateSync({ secret }),
        })
        .expect(204);

      expect(await keyEnvelopeRows(s.householdId)).toEqual([]);
    });
  });

  describe('POST /auth/key-envelopes/activate', () => {
    it('writes every slot in one transaction at one version bump, with no proof, and reads back the expected version + tag', async () => {
      const s = await signupAndLoginMfa();
      const res = await activate(s, {
        slots: [
          passwordSlotBody(s.householdId, 1, 'ignored').slot,
          recoveryBody(s.householdId, 1, 'ignored').slot,
        ],
        envelopeSetVersion: 1,
        expectedEnvelopeSetVersion: 0,
        envelopeSetTag: 'dGFnMQ',
      });
      expect(res.status).toBe(204);

      const get = await authSet(s)(
        request(t.app.getHttpServer()).get('/api/v1/auth/key-envelopes'),
      );
      expect(get.body.envelopeSetVersion).toBe(1);
      expect(get.body.envelopeSetTag).toBe('dGFnMQ');
      expect(get.body.slots).toHaveLength(2);
    });

    it('is refused with a distinct code into a set that already holds a slot, writing nothing', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const before = await repo.getStableEnvelopeSet(s.householdId);

      const res = await activate(s, {
        slots: [passwordSlotBody(s.householdId, 1, 'ignored').slot],
        envelopeSetVersion: 2,
        expectedEnvelopeSetVersion: 1,
        envelopeSetTag: 'dGFnMg',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ENVELOPE_SET_NOT_EMPTY');
      expect(res.body.error.code).not.toBe('STALE_ENVELOPE_VERSION');

      const after = await repo.getStableEnvelopeSet(s.householdId);
      expect(after).toEqual(before);
    });

    it('two concurrent activations cannot both win: the loser fails and leaves no partial slot behind', async () => {
      const s = await signupAndLoginMfa();
      // The racers propose different final slot sets (`bodyA` writes only `password`, `bodyB` also `recovery`), so a stray row from the loser is
      // visible. Identical single-slot bodies would pass `slots.toHaveLength(1)` even for a non-atomic implementation that never rolled back.
      const bodyA = () => ({
        slots: [passwordSlotBody(s.householdId, 1, 'ignored').slot],
        envelopeSetVersion: 1,
        expectedEnvelopeSetVersion: 0,
        envelopeSetTag: 'dGFnMQ',
      });
      const bodyB = () => ({
        slots: [
          passwordSlotBody(s.householdId, 1, 'ignored').slot,
          recoveryBody(s.householdId, 1, 'ignored').slot,
        ],
        envelopeSetVersion: 1,
        expectedEnvelopeSetVersion: 0,
        envelopeSetTag: 'dGFnMQ',
      });
      const [a, b] = await Promise.all([activate(s, bodyA()), activate(s, bodyB())]);
      const attempts = [
        { res: a, slotIds: ['password'] },
        { res: b, slotIds: ['password', 'recovery'] },
      ];
      const winners = attempts.filter((x) => x.res.status === 204);
      const losers = attempts.filter((x) => x.res.status !== 204);
      expect(winners).toHaveLength(1);
      // A ConditionalCheckFailed on the meta item (409) is expected; a transient transaction-conflict mapping (503) is also acceptable. Never a partial write.
      expect([409, 503]).toContain(losers[0]!.res.status);

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const { slots, meta } = await repo.getStableEnvelopeSet(s.householdId);
      expect(meta?.envelopeSetVersion).toBe(1);
      // The live slot set must be exactly the winner's proposed set, with no stray row from the loser's transaction.
      expect(slots.map((sl) => sl.slotId).sort()).toEqual(
        winners[0]!.slotIds.slice().sort(),
      );
    });

    it('activates into meta-only residue (slots: [], version N > 0) at N + 1 — a version-derived emptiness check would silently break this', async () => {
      const s = await signupAndLoginMfa();
      await activate(s, {
        slots: [passwordSlotBody(s.householdId, 1, 'ignored').slot],
        envelopeSetVersion: 1,
        expectedEnvelopeSetVersion: 0,
        envelopeSetTag: 'dGFnMQ',
      }).expect(204);
      // Meta-only residue, as a failed prior attempt leaves it: the slot row is gone but the meta row is still at version 1.
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      await repo.deleteSlot(s.householdId, 'password');

      const res = await activate(s, {
        slots: [recoveryBody(s.householdId, 1, 'ignored').slot],
        envelopeSetVersion: 2,
        expectedEnvelopeSetVersion: 1,
        envelopeSetTag: 'dGFnMg',
      });
      expect(res.status).toBe(204);

      const { slots, meta } = await repo.getStableEnvelopeSet(s.householdId);
      expect(slots).toHaveLength(1);
      expect(meta?.envelopeSetVersion).toBe(2);
    });

    it('rejects a body that names one slot id twice at the boundary (400 INVALID_SLOT_ID), writing nothing', async () => {
      const s = await signupAndLoginMfa();
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const before = await repo.getStableEnvelopeSet(s.householdId);

      // Two `password`-type slots each pass the canonical-id pin; only a check across elements catches the pair. Without it both build a Put on
      // the same item in one transaction, which DynamoDB refuses with an unmapped ValidationException: a 500 for a client-controlled body.
      const res = await activate(s, {
        slots: [
          passwordSlotBody(s.householdId, 1, 'ignored').slot,
          passwordSlotBody(s.householdId, 1, 'ignored').slot,
        ],
        envelopeSetVersion: 1,
        expectedEnvelopeSetVersion: 0,
        envelopeSetTag: 'dGFnMQ',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SLOT_ID');

      const after = await repo.getStableEnvelopeSet(s.householdId);
      expect(after).toEqual(before);
      expect(after.slots).toEqual([]);
    });
  });

  describe('stranded household repair', () => {
    it('a password-slot-only household PUTting the missing recovery slot is refused proofless, and succeeds with a valid key_envelope_replace proof on Email-OTP alone', async () => {
      // Email-OTP is this account's only factor; enrolling another first would not prove a repair works once the setup session is gone.
      const s = await signupAndLoginMfa();
      await putPasswordSlot(s, passwordSlotBody(s.householdId, 1, 'dGFnMQ')).expect(204);

      const refused = await putRecovery(s, recoveryBody(s.householdId, 2, 'dGFnMg'));
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('STEP_UP_PROOF_MISSING');

      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
      const ok = await putRecovery(s, {
        ...recoveryBody(s.householdId, 2, 'dGFnMg', 'cmVjb3Zlcnky'),
        method: 'email_otp',
        code,
      });
      expect(ok.status).toBe(204);
    });
  });

  describe('the passkey_prf password floor (AUTH_MFA_ENFORCED on)', () => {
    it('a missing password is refused before any factor work, leaving no slot row and no version bump', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const before = await repo.getStableEnvelopeSet(s.householdId);

      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
      const res = await authSet(s)(
        request(t.app.getHttpServer()).put('/api/v1/auth/key-envelopes/passkey_prf'),
      ).send({ ...newPasskeyPrfBody(s.householdId, 2, 'dGFnMg'), method: 'email_otp', code });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

      const after = await repo.getStableEnvelopeSet(s.householdId);
      expect(after).toEqual(before);
    });

    it('a wrong password is refused before any factor work (the code stays unconsumed); the correct password plus the same proof succeeds in one request', async () => {
      const s = await signupAndLoginMfa();
      await putRecovery(s, recoveryBody(s.householdId, 1, 'dGFnMQ')).expect(204);
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const before = await repo.getStableEnvelopeSet(s.householdId);

      const code = await sendAndRecoverStepUpOtp(t, s, 'key_envelope_replace');
      const wrong = await authSet(s)(
        request(t.app.getHttpServer()).put('/api/v1/auth/key-envelopes/passkey_prf'),
      ).send({
        ...newPasskeyPrfBody(s.householdId, 2, 'dGFnMg'),
        method: 'email_otp',
        code,
        currentPassword: 'WrongPassw0rd!Zzz',
      });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

      const afterWrong = await repo.getStableEnvelopeSet(s.householdId);
      expect(afterWrong).toEqual(before);

      // The wrong password failed before the factor was checked, so the same Email-OTP code is still unconsumed.
      const ok = await authSet(s)(
        request(t.app.getHttpServer()).put('/api/v1/auth/key-envelopes/passkey_prf'),
      ).send({
        ...newPasskeyPrfBody(s.householdId, 2, 'dGFnMg'),
        method: 'email_otp',
        code,
        currentPassword: STRONG_PASSWORD,
      });
      expect(ok.status).toBe(204);
    });
  });
});

// Boots a separate app with the flag unset (read at controller construction): without the password floor, a proof-required envelope write would degrade to the bare session with nothing checked.
describe('key-envelope password floor — flag-off degrade floor', () => {
  let t2: TestApp;
  let priorEnforced: string | undefined;

  beforeAll(async () => {
    priorEnforced = process.env.AUTH_MFA_ENFORCED;
    delete process.env.AUTH_MFA_ENFORCED;
    t2 = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t2.app.close();
    if (priorEnforced === undefined) delete process.env.AUTH_MFA_ENFORCED;
    else process.env.AUTH_MFA_ENFORCED = priorEnforced;
  });

  it('a passkey_prf write into a non-empty set is refused with no password, even though AUTH_MFA_ENFORCED is off', async () => {
    const s = await signupVerifyLogin(t2);
    await authSet(s)(
      request(t2.app.getHttpServer()).put('/api/v1/auth/key-envelopes/recovery'),
    )
      .send(recoveryBody(s.householdId, 1, 'dGFnMQ'))
      .expect(204);
    const repo = t2.module.get(HouseholdKeyEnvelopesRepository);
    const before = await repo.getStableEnvelopeSet(s.householdId);

    const res = await authSet(s)(
      request(t2.app.getHttpServer()).put('/api/v1/auth/key-envelopes/passkey_prf'),
    ).send(newPasskeyPrfBody(s.householdId, 2, 'dGFnMg'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const after = await repo.getStableEnvelopeSet(s.householdId);
    expect(after).toEqual(before);
  });

  it('the same write succeeds with no step-up factor once the correct password rides along', async () => {
    const s = await signupVerifyLogin(t2);
    const authed = authSet(s);
    await authed(request(t2.app.getHttpServer()).put('/api/v1/auth/key-envelopes/recovery'))
      .send(recoveryBody(s.householdId, 1, 'dGFnMQ'))
      .expect(204);

    const res = await authed(
      request(t2.app.getHttpServer()).put('/api/v1/auth/key-envelopes/passkey_prf'),
    ).send({
      ...newPasskeyPrfBody(s.householdId, 2, 'dGFnMg'),
      currentPassword: STRONG_PASSWORD,
    });
    expect(res.status).toBe(204);
  });
});
