/**
 * Unit tests for `FactorNoticeService`.
 *
 * `consume` — the ordering the file header is built around: the claim is the
 * pre-flight gate (nothing runs on a failed claim), the session revoke runs
 * BEFORE the single-use gate (a failure there leaves the token valid for a
 * retry), and the destructive undo action never runs as a separate write —
 * it rides INSIDE `UsersRepository.consumeFactorUndo`'s transaction, so a
 * token superseded between the claim and the commit can never act on a
 * factor it was not about. The API-integration suite
 * (`factor-notice.spec.ts`) covers the end-to-end HTTP contract against real
 * emulators and reproduces that race deterministically by injecting the
 * supersession after the claim.
 *
 * `notify` — runs after an already-committed factor change, so it must never
 * reject: a failed token persist and a failed SES send both resolve `false`,
 * and a persist failure must not send a mail
 * whose link points at a token that was never stored.
 */
import 'reflect-metadata';
import { FactorNoticeService } from './factor-notice.service.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { SessionRevocationService } from './session-revocation.service.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import type { SESClient } from '@aws-sdk/client-ses';

const USER_ID = 'u1';
const EMAIL = 'person@example.test';

const PASSKEY_DELETE_ITEM = { Delete: { TableName: 'Passkey', Key: { userId: USER_ID, credentialId: 'claimed-cred' } } };
const TOTP_CLEAR_ITEM = { Put: { TableName: 'UserMfa', Item: { userId: USER_ID, totpEnabled: false } } };

interface Built {
  svc: FactorNoticeService;
  ses: { send: jest.Mock };
  users: { claimFactorUndo: jest.Mock; consumeFactorUndo: jest.Mock; setPendingFactorUndo: jest.Mock };
  passkeys: { removeTransactItem: jest.Mock };
  userMfa: { clearTotpTransactItem: jest.Mock };
  sessions: { revokeAll: jest.Mock };
  auth: { record: jest.Mock };
}

function buildConfig(): ConfigService<EnvConfig, true> {
  // Every non-NODE_ENV key (incl. SES_ENDPOINT) resolves truthy, so
  // `sesEnabled` is on and `notify` really calls `ses.send`.
  return {
    get: jest.fn((key: string) => (key === 'NODE_ENV' ? 'test' : 'https://app.example.test')),
  } as unknown as ConfigService<EnvConfig, true>;
}

function build(): Built {
  const ses = { send: jest.fn().mockResolvedValue({}) };
  const users = {
    claimFactorUndo: jest.fn(),
    consumeFactorUndo: jest.fn().mockResolvedValue(true),
    setPendingFactorUndo: jest.fn().mockResolvedValue(undefined),
  };
  const passkeys = { removeTransactItem: jest.fn().mockReturnValue(PASSKEY_DELETE_ITEM) };
  const userMfa = { clearTotpTransactItem: jest.fn().mockReturnValue(TOTP_CLEAR_ITEM) };
  const sessions = { revokeAll: jest.fn().mockResolvedValue(undefined) };
  const auth = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new FactorNoticeService(
    ses as unknown as SESClient,
    users as unknown as UsersRepository,
    passkeys as unknown as PasskeysRepository,
    userMfa as unknown as UserMfaRepository,
    sessions as unknown as SessionRevocationService,
    auth as unknown as AuthEventsRepository,
    buildConfig(),
  );
  return { svc, ses, users, passkeys, userMfa, sessions, auth };
}

describe('FactorNoticeService.consume — claim, revoke, then act + clear in one transaction', () => {
  it('performs no session revoke, no transaction, and no audit when the claim fails (token unknown, superseded, expired, or kind-mismatched)', async () => {
    const { svc, users, passkeys, userMfa, sessions, auth } = build();
    users.claimFactorUndo.mockResolvedValue(null);

    const result = await svc.consume({ userId: USER_ID, token: 'raw-token', kind: 'totp_add' });

    expect(result).toEqual({ ok: false });
    expect(sessions.revokeAll).not.toHaveBeenCalled();
    expect(users.consumeFactorUndo).not.toHaveBeenCalled();
    expect(passkeys.removeTransactItem).not.toHaveBeenCalled();
    expect(userMfa.clearTotpTransactItem).not.toHaveBeenCalled();
    expect(auth.record).not.toHaveBeenCalled();
  });

  it('commits a passkey_add undo as the credential delete INSIDE the token-consume transaction, built from what the claim returned', async () => {
    const { svc, users, passkeys, sessions, auth } = build();
    users.claimFactorUndo.mockResolvedValue({ kind: 'passkey_add', credentialId: 'claimed-cred' });

    const result = await svc.consume({ userId: USER_ID, token: 'raw-token', kind: 'passkey_add' });

    expect(result).toEqual({ ok: true });
    expect(passkeys.removeTransactItem).toHaveBeenCalledWith(USER_ID, 'claimed-cred');
    expect(users.consumeFactorUndo).toHaveBeenCalledTimes(1);
    expect(users.consumeFactorUndo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, action: PASSKEY_DELETE_ITEM }),
    );
    // Revoke runs BEFORE the single-use gate commits (see the file header).
    expect(sessions.revokeAll).toHaveBeenCalledWith({ userId: USER_ID });
    expect(sessions.revokeAll.mock.invocationCallOrder[0]).toBeLessThan(
      users.consumeFactorUndo.mock.invocationCallOrder[0],
    );
    expect(auth.record).toHaveBeenCalledTimes(1);
    expect(auth.record).toHaveBeenCalledWith({
      userId: USER_ID,
      eventType: 'factor_undo_consumed',
      metadata: { kind: 'passkey_add', credentialId: 'claimed-cred' },
    });
  });

  it('commits a totp_add undo as the TOTP clear INSIDE the transaction and audits the disable alongside the consume', async () => {
    const { svc, users, userMfa, auth } = build();
    users.claimFactorUndo.mockResolvedValue({ kind: 'totp_add' });

    const result = await svc.consume({ userId: USER_ID, token: 'raw-token', kind: 'totp_add' });

    expect(result).toEqual({ ok: true });
    expect(userMfa.clearTotpTransactItem).toHaveBeenCalledWith(USER_ID);
    expect(users.consumeFactorUndo).toHaveBeenCalledWith(
      expect.objectContaining({ action: TOTP_CLEAR_ITEM }),
    );
    expect(auth.record).toHaveBeenCalledWith({ userId: USER_ID, eventType: 'mfa_totp_disabled' });
    expect(auth.record).toHaveBeenCalledWith({
      userId: USER_ID,
      eventType: 'factor_undo_consumed',
      metadata: { kind: 'totp_add' },
    });
  });

  it('a _remove kind consumes with no action item — the removed factor is never restored', async () => {
    const { svc, users, passkeys, userMfa } = build();
    users.claimFactorUndo.mockResolvedValue({ kind: 'passkey_remove', credentialId: 'gone-cred' });

    const result = await svc.consume({ userId: USER_ID, token: 'raw-token', kind: 'passkey_remove' });

    expect(result).toEqual({ ok: true });
    expect(passkeys.removeTransactItem).not.toHaveBeenCalled();
    expect(userMfa.clearTotpTransactItem).not.toHaveBeenCalled();
    expect(users.consumeFactorUndo).toHaveBeenCalledTimes(1);
    expect(users.consumeFactorUndo.mock.calls[0][0]).not.toHaveProperty('action');
  });

  it('reports { ok: false } and audits nothing when the transaction loses the single-use condition (token superseded or consumed between claim and commit)', async () => {
    const { svc, users, auth } = build();
    users.claimFactorUndo.mockResolvedValue({ kind: 'totp_add' });
    users.consumeFactorUndo.mockResolvedValue(false);

    const result = await svc.consume({ userId: USER_ID, token: 'raw-token', kind: 'totp_add' });

    expect(result).toEqual({ ok: false });
    expect(auth.record).not.toHaveBeenCalled();
  });

  it('leaves the token unconsumed when the session revoke fails, so the same link can safely retry', async () => {
    const { svc, users, sessions } = build();
    users.claimFactorUndo.mockResolvedValue({ kind: 'passkey_add', credentialId: 'claimed-cred' });
    sessions.revokeAll.mockRejectedValue(new Error('DynamoDB unavailable'));

    await expect(
      svc.consume({ userId: USER_ID, token: 'raw-token', kind: 'passkey_add' }),
    ).rejects.toThrow('DynamoDB unavailable');

    expect(users.consumeFactorUndo).not.toHaveBeenCalled();
  });
});

describe('FactorNoticeService.notify — never rejects into the committed factor change', () => {
  it('persists the token, sends the mail, and reports it as sent', async () => {
    const { svc, users, ses } = build();

    const sent = await svc.notify({ userId: USER_ID, email: EMAIL, kind: 'passkey_add', credentialId: 'c1' });

    expect(sent).toBe(true);
    expect(users.setPendingFactorUndo).toHaveBeenCalledTimes(1);
    expect(users.setPendingFactorUndo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, kind: 'passkey_add', credentialId: 'c1' }),
    );
    expect(ses.send).toHaveBeenCalledTimes(1);
  });

  it('resolves false and sends NO mail when the token persist fails — a link to a token that was never stored must not go out', async () => {
    const { svc, users, ses } = build();
    users.setPendingFactorUndo.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

    await expect(
      svc.notify({ userId: USER_ID, email: EMAIL, kind: 'totp_add' }),
    ).resolves.toBe(false);

    expect(ses.send).not.toHaveBeenCalled();
  });

  it('resolves false when the SES send fails, with the token already persisted', async () => {
    const { svc, users, ses } = build();
    ses.send.mockRejectedValue(new Error('SES is down'));

    await expect(
      svc.notify({ userId: USER_ID, email: EMAIL, kind: 'totp_remove' }),
    ).resolves.toBe(false);

    expect(users.setPendingFactorUndo).toHaveBeenCalledTimes(1);
  });
});
