/**
 * Focused unit tests for StepUpService.computeFactors — the shared step-up
 * factor-eligibility computation. Directly asserts
 * the three enrollment states (previously only covered indirectly via the
 * change-email integration tests): no enrolled factor → Email-OTP floor;
 * TOTP-only → TOTP + Email-OTP recovery; passkey-enrolled → passkey first.
 *
 * Only `UserMfaRepository.get` + `PasskeysRepository.listForUser` are exercised,
 * so the remaining constructor deps are stubbed away.
 */
import 'reflect-metadata';
import { StepUpService } from './step-up.service.js';
import type { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { UserMfaRow, PasskeyRow } from '../dynamo/types.js';

const USER_ID = 'user-123';

/** A minimal enrolled passkey row for `USER_ID` (only presence matters here). */
function passkeyRow(): PasskeyRow {
  return {
    userId: USER_ID,
    credentialId: 'cred-1',
    publicKey: 'pk',
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

/** Build the service with stubbed factor repos; other deps are unused here. */
function buildService(opts: {
  mfa: Partial<UserMfaRow> | null;
  passkeys: PasskeyRow[];
}): StepUpService {
  const userMfa = {
    get: jest.fn().mockResolvedValue(opts.mfa ?? undefined),
  } as unknown as UserMfaRepository;
  const passkeys = {
    listForUser: jest.fn().mockResolvedValue(opts.passkeys),
  } as unknown as PasskeysRepository;
  return new StepUpService(
    {} as never,
    userMfa,
    passkeys,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('StepUpService.computeFactors', () => {
  it('falls back to the Email-OTP floor when no factor is enrolled', async () => {
    const svc = buildService({ mfa: null, passkeys: [] });
    const factors = await svc.computeFactors(USER_ID);
    expect(factors).toEqual({
      methods: ['email_otp'],
      recoveryMethods: ['email_otp'],
    });
  });

  it('offers totp with Email-OTP recovery when only TOTP is enrolled', async () => {
    const svc = buildService({ mfa: { totpEnabled: true }, passkeys: [] });
    const factors = await svc.computeFactors(USER_ID);
    expect(factors).toEqual({
      methods: ['totp'],
      recoveryMethods: ['email_otp'],
    });
  });

  it('lists passkey first when a passkey is enrolled', async () => {
    const svc = buildService({
      mfa: { totpEnabled: true },
      passkeys: [passkeyRow()],
    });
    const factors = await svc.computeFactors(USER_ID);
    expect(factors.methods[0]).toBe('passkey');
    expect(factors).toEqual({
      methods: ['passkey', 'totp'],
      recoveryMethods: ['email_otp'],
    });
  });
});
