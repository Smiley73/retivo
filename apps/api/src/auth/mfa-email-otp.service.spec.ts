/**
 * Unit tests for MfaEmailOtpService:
 *   - cooldown: a recent send is a silent no-op (no User update, no code Put),
 *   - daily cap: 5 sends/day max — the 6th is a silent no-op,
 *   - hash round-trip: only sha256(code) is stored; a matching raw code verifies,
 *   - response floor: send always takes ≥ 200 ms,
 *   - per-code attempt cap: the 5th wrong guess invalidates the code (delete +
 *     MFA_CODE_INVALID).
 *
 * Pure unit test: the doc client, SES client, repos, and config are stubbed.
 */
import 'reflect-metadata';
import { GoneException, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SESClient } from '@aws-sdk/client-ses';
import type { EnvConfig } from '../common/env.config.js';
import {
  MfaEmailOtpService,
  MFA_EMAIL_OTP_DAILY_LIMIT,
  MFA_EMAIL_OTP_MAX_ATTEMPTS,
  MFA_EMAIL_OTP_RESPONSE_FLOOR_MS,
} from './mfa-email-otp.service.js';
import type { MfaEmailOtpRepository } from '../dynamo/mfa-email-otp.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { MfaEmailOtpRow, UserRow } from '../dynamo/types.js';

type TypedConfig = ConfigService<EnvConfig, true>;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function baseUser(over: Partial<UserRow> = {}): UserRow {
  return {
    userId: 'u1',
    email: 'a@b.test',
    emailLowercase: 'a@b.test',
    householdId: 'u1',
    emailVerifiedAt: new Date().toISOString(),
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function buildConfig(): TypedConfig {
  return {
    get: jest.fn((key: string) => {
      if (key === 'SES_FROM_ADDRESS') return 'no-reply@test';
      if (key === 'NODE_ENV') return 'test';
      return undefined;
    }),
  } as unknown as TypedConfig;
}

function deps(user: UserRow | null) {
  const docSend = jest.fn().mockResolvedValue({});
  const doc = { send: docSend } as unknown as DynamoDBDocumentClient;
  const ses = { send: jest.fn().mockResolvedValue({}) } as unknown as SESClient;
  const otpPut = jest.fn().mockResolvedValue(undefined);
  const otps = {
    get: jest.fn(),
    put: otpPut,
    delete: jest.fn().mockResolvedValue(undefined),
    incrementAttempts: jest.fn(),
  } as unknown as MfaEmailOtpRepository;
  const realUsers = {
    findById: jest.fn().mockResolvedValue(user),
    // Use the real builder so the conditional UpdateExpression is exercised.
    mfaEmailOtpSendUpdate: jest.fn((args) => ({
      TableName: 't-user',
      Key: { userId: args.userId },
      UpdateExpression: 'SET mfaEmailOtpLastSentAt = :sent',
      ConditionExpression: 'attribute_not_exists(mfaEmailOtpLastSentAt)',
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: { ':sent': args.sentAtIso },
    })),
  } as unknown as UsersRepository;
  const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
  return { doc, docSend, ses, otps, otpPut, users: realUsers, auth };
}

describe('MfaEmailOtpService — send rate limits', () => {
  it('is a silent no-op while the 60 s cooldown has not elapsed', async () => {
    const user = baseUser({ mfaEmailOtpLastSentAt: new Date().toISOString() });
    const { doc, docSend, ses, otps, otpPut, users, auth } = deps(user);
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await svc.send({ userId: 'u1', email: user.email });

    expect(docSend).not.toHaveBeenCalled(); // no User-counter update
    expect(otpPut).not.toHaveBeenCalled(); // no code row Put
    expect(auth.record).not.toHaveBeenCalled();
  });

  it('is a silent no-op when the daily cap is already reached', async () => {
    const todayKey = Math.floor(Date.now() / 1000 / 86400);
    const user = baseUser({
      mfaEmailOtpSentDayKey: todayKey,
      mfaEmailOtpSentToday: MFA_EMAIL_OTP_DAILY_LIMIT,
    });
    const { doc, docSend, ses, otps, otpPut, users, auth } = deps(user);
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await svc.send({ userId: 'u1', email: user.email });

    expect(docSend).not.toHaveBeenCalled();
    expect(otpPut).not.toHaveBeenCalled();
  });

  it('sends a fresh code (User update then code Put) when under cap + past cooldown', async () => {
    const user = baseUser();
    const { doc, docSend, ses, otps, otpPut, users, auth } = deps(user);
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await svc.send({ userId: 'u1', email: user.email });

    expect(docSend).toHaveBeenCalledTimes(1); // the conditional User update
    expect(otpPut).toHaveBeenCalledTimes(1); // then the code row
    const putRow = (otpPut as jest.Mock).mock.calls[0][0] as MfaEmailOtpRow;
    expect(putRow.attempts).toBe(0);
    expect(putRow.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // The stored TTL is a future epoch-SECOND Number, not an ISO string.
    expect(typeof putRow.expiresAt).toBe('number');
    expect(putRow.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'mfa_email_otp_sent' }),
    );
  });

  it('holds the response to at least the 200 ms floor', async () => {
    const { doc, ses, otps, users, auth } = deps(baseUser({
      mfaEmailOtpLastSentAt: new Date().toISOString(), // cheapest no-op branch
    }));
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    const start = Date.now();
    await svc.send({ userId: 'u1', email: 'a@b.test' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(MFA_EMAIL_OTP_RESPONSE_FLOOR_MS - 25);
  });
});

describe('MfaEmailOtpService — verify', () => {
  function liveRow(code: string, attempts = 0): MfaEmailOtpRow {
    return {
      userId: 'u1',
      codeHash: sha256(code),
      // Numeric epoch-second TTL.
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      sentAt: new Date().toISOString(),
      attempts,
    };
  }

  it('verifies a correct code (hash round-trip) and consumes it', async () => {
    const { doc, ses, users, auth } = deps(baseUser());
    const del = jest.fn().mockResolvedValue(undefined);
    const otps = {
      get: jest.fn().mockResolvedValue(liveRow('123456')),
      delete: del,
      incrementAttempts: jest.fn(),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    const r = await svc.verify({ userId: 'u1', code: '123456' });
    expect(r.ok).toBe(true);
    expect(del).toHaveBeenCalledWith('u1');
  });

  it('returns ok:false on a wrong guess, increments attempts, and emits the brute-force log', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { doc, ses, users, auth } = deps(baseUser());
    const otps = {
      get: jest.fn().mockResolvedValue(liveRow('123456', 0)),
      delete: jest.fn(),
      incrementAttempts: jest.fn().mockResolvedValue(1),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    const r = await svc.verify({ userId: 'u1', code: '999999' });
    expect(r.ok).toBe(false);
    expect(otps.incrementAttempts).toHaveBeenCalled();
    // Incident-context warn only — the MfaVerifyFailed metric is now direct
    // EMF from AuthEventsRepository, not sourced from this log line.
    expect(warnSpy).toHaveBeenCalledWith('MFA verification failed', {
      userId: 'u1',
      factor: 'email_otp',
    });
    warnSpy.mockRestore();
  });

  it('invalidates the code after the 5th wrong guess (delete + MFA_CODE_INVALID)', async () => {
    const { doc, ses, users, auth } = deps(baseUser());
    const del = jest.fn().mockResolvedValue(undefined);
    const otps = {
      get: jest.fn().mockResolvedValue(liveRow('123456', MFA_EMAIL_OTP_MAX_ATTEMPTS - 1)),
      delete: del,
      // The 5th wrong guess pushes attempts to the cap.
      incrementAttempts: jest.fn().mockResolvedValue(MFA_EMAIL_OTP_MAX_ATTEMPTS),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await expect(svc.verify({ userId: 'u1', code: '999999' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(del).toHaveBeenCalledWith('u1');
  });

  it('throws MFA_CODE_EXPIRED on a TTL-elapsed code (and deletes the row)', async () => {
    const { doc, ses, users, auth } = deps(baseUser());
    const del = jest.fn().mockResolvedValue(undefined);
    const expired: MfaEmailOtpRow = {
      userId: 'u1',
      codeHash: sha256('123456'),
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      sentAt: new Date().toISOString(),
      attempts: 0,
    };
    const otps = {
      get: jest.fn().mockResolvedValue(expired),
      delete: del,
      incrementAttempts: jest.fn(),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await expect(svc.verify({ userId: 'u1', code: '123456' })).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(del).toHaveBeenCalledWith('u1');
  });

  it('still throws MFA_CODE_EXPIRED when the best-effort delete of the stale row throws', async () => {
    // A transient DynamoDB fault on the hygiene delete must not turn the
    // expired-code fallback into a 500 — the typed GoneException still throws.
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { doc, ses, users, auth } = deps(baseUser());
    const expired: MfaEmailOtpRow = {
      userId: 'u1',
      codeHash: sha256('123456'),
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      sentAt: new Date().toISOString(),
      attempts: 0,
    };
    const del = jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const otps = {
      get: jest.fn().mockResolvedValue(expired),
      delete: del,
      incrementAttempts: jest.fn(),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await expect(svc.verify({ userId: 'u1', code: '123456' })).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(del).toHaveBeenCalledWith('u1');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rejects a legacy ISO-string `expiresAt` code as expired (clean cutover)', async () => {
    const { doc, ses, users, auth } = deps(baseUser());
    const del = jest.fn().mockResolvedValue(undefined);
    // A pre-cutover row whose TTL is still an ISO string (nonnumeric) must fail
    // the numeric guard and be invalidated — even with a matching code.
    const legacy: MfaEmailOtpRow = {
      userId: 'u1',
      codeHash: sha256('123456'),
      expiresAt: '2030-01-01T00:00:00.000Z' as unknown as number,
      sentAt: new Date().toISOString(),
      attempts: 0,
    };
    const otps = {
      get: jest.fn().mockResolvedValue(legacy),
      delete: del,
      incrementAttempts: jest.fn(),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await expect(svc.verify({ userId: 'u1', code: '123456' })).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(del).toHaveBeenCalledWith('u1');
  });

  it('throws MFA_CODE_INVALID when no live code exists', async () => {
    const { doc, ses, users, auth } = deps(baseUser());
    const otps = {
      get: jest.fn().mockResolvedValue(null),
      delete: jest.fn(),
      incrementAttempts: jest.fn(),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await expect(svc.verify({ userId: 'u1', code: '123456' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('MfaEmailOtpService — verifyStepUp', () => {
  it('still throws MFA_CODE_EXPIRED when the best-effort step-up delete throws', async () => {
    // The step-up expired-code fallback must survive a transient DynamoDB fault
    // on the hygiene delete — the typed GoneException still throws, not a 500.
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { doc, ses, users, auth } = deps(baseUser());
    const expired: MfaEmailOtpRow = {
      userId: 'u1#stepup',
      codeHash: sha256('123456'),
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      sentAt: new Date().toISOString(),
      attempts: 0,
      purpose: 'delete_account',
    };
    const del = jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const otps = {
      getStepUp: jest.fn().mockResolvedValue(expired),
      deleteStepUp: del,
      incrementAttemptsStepUp: jest.fn(),
    } as unknown as MfaEmailOtpRepository;
    const svc = new MfaEmailOtpService(doc, ses, otps, users, auth, buildConfig());

    await expect(
      svc.verifyStepUp({ userId: 'u1', code: '123456', purpose: 'delete_account' }),
    ).rejects.toBeInstanceOf(GoneException);
    expect(del).toHaveBeenCalledWith('u1');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
