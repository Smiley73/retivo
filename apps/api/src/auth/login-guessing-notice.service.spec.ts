// LoginGuessingNoticeService: the mail send is dispatched without being awaited (an unknown email must not pay SES latency it never sends), the once-per-24h stamp gate is atomic in the repository (no TOCTOU read here),
// and an unknown email follows the same stamp-check and lookup shape as a known one while sending and recording nothing.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SESClient } from '@aws-sdk/client-ses';
import type { EnvConfig } from '../common/env.config.js';
import { LoginGuessingNoticeService } from './login-guessing-notice.service.js';
import type { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { UserRow } from '../dynamo/types.js';

const EMAIL = 'alice@example.test';

function user(): UserRow {
  return {
    userId: 'u1',
    email: 'Alice@Example.test',
    emailLowercase: EMAIL,
    householdId: 'u1',
    emailVerifiedAt: new Date().toISOString(),
    createdAt: '',
    updatedAt: '',
  };
}

function buildConfig(sesEnabled = true): ConfigService<EnvConfig, true> {
  return {
    get: jest.fn((key: string) => {
      if (key === 'NODE_ENV') return 'test';
      if (key === 'SES_ENDPOINT') return sesEnabled ? 'https://ses.example.test' : undefined;
      if (key === 'SES_FROM_ADDRESS') return 'noreply@example.test';
      return undefined;
    }),
  } as unknown as ConfigService<EnvConfig, true>;
}

function build(opts: { sesEnabled?: boolean } = {}) {
  const ses = { send: jest.fn().mockResolvedValue({}) };
  const repo = { stampGuessingNotice: jest.fn() } as unknown as FailedLoginAttemptsRepository;
  const users = { findByEmail: jest.fn() } as unknown as UsersRepository;
  const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
  const svc = new LoginGuessingNoticeService(
    ses as unknown as SESClient,
    repo,
    users,
    auth,
    buildConfig(opts.sesEnabled ?? true),
  );
  return { svc, ses, repo, users, auth };
}

describe('LoginGuessingNoticeService.notifyIfNeeded', () => {
  it('is a no-op below the threshold — no stamp check, no lookup', async () => {
    const { svc, repo, users } = build();
    await svc.notifyIfNeeded(EMAIL, 9, null, null);
    expect(repo.stampGuessingNotice).not.toHaveBeenCalled();
    expect(users.findByEmail).not.toHaveBeenCalled();
  });

  it('at the threshold: stamps, audits the real account, and sends mail without being awaited', async () => {
    const { svc, repo, users, auth, ses } = build();
    (repo.stampGuessingNotice as jest.Mock).mockResolvedValue(true);
    (users.findByEmail as jest.Mock).mockResolvedValue(user());

    await svc.notifyIfNeeded(EMAIL, 10, '203.0.113.7', 'jest');

    expect(repo.stampGuessingNotice).toHaveBeenCalledWith(EMAIL, 24 * 60 * 60);
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', eventType: 'login_guessing_notice_sent' }),
    );
    expect(ses.send).toHaveBeenCalledTimes(1);
  });

  it('composes the exact subject line and a mail body that escapes an interpolated value', async () => {
    const { svc, repo, users, ses } = build();
    (repo.stampGuessingNotice as jest.Mock).mockResolvedValue(true);
    (users.findByEmail as jest.Mock).mockResolvedValue(user());

    await svc.notifyIfNeeded(EMAIL, 10, null, null);

    const sent = ses.send.mock.calls[0][0].input as {
      Message: { Subject: { Data: string }; Body: { Text: { Data: string }; Html: { Data: string } } };
    };
    expect(sent.Message.Subject.Data).toBe('Failed sign-in attempts on your Retivo account');
    expect(sent.Message.Body.Html.Data).toContain('<p>Someone entered');
    expect(sent.Message.Body.Text.Data).toMatch(/once a day/i);
  });

  it('already notified within the window: stampGuessingNotice returns false — no lookup, no audit, no mail', async () => {
    const { svc, repo, users, auth, ses } = build();
    (repo.stampGuessingNotice as jest.Mock).mockResolvedValue(false);

    await svc.notifyIfNeeded(EMAIL, 15, null, null);

    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(auth.record).not.toHaveBeenCalled();
    expect(ses.send).not.toHaveBeenCalled();
  });

  it('an unknown email at the threshold follows the same stamp-check + lookup shape, sends nothing, records nothing user-linked', async () => {
    const { svc, repo, users, auth, ses } = build();
    (repo.stampGuessingNotice as jest.Mock).mockResolvedValue(true);
    (users.findByEmail as jest.Mock).mockResolvedValue(null);

    await svc.notifyIfNeeded(EMAIL, 10, null, null);

    expect(repo.stampGuessingNotice).toHaveBeenCalledWith(EMAIL, 24 * 60 * 60);
    expect(users.findByEmail).toHaveBeenCalledWith(EMAIL);
    expect(auth.record).not.toHaveBeenCalled();
    expect(ses.send).not.toHaveBeenCalled();
  });

  it('a send failure is caught, logged with a fingerprint + error name only, and never rejects the caller', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, repo, users, ses } = build();
    (repo.stampGuessingNotice as jest.Mock).mockResolvedValue(true);
    (users.findByEmail as jest.Mock).mockResolvedValue(user());
    ses.send.mockRejectedValue(new Error('SES throttled: alice@example.test'));

    await expect(svc.notifyIfNeeded(EMAIL, 10, null, null)).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalled();
    const [, meta] = warnSpy.mock.calls[0];
    expect(JSON.stringify(meta)).not.toContain('alice@example.test');
    warnSpy.mockRestore();
  });
});
