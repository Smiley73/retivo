// StepUpService.computeFactors: no enrolled factor gives the Email-OTP floor, TOTP-only gives TOTP plus Email-OTP recovery, and an enrolled passkey leads. Only UserMfaRepository.get and PasskeysRepository.listForUser are exercised.
import 'reflect-metadata';
import { StepUpService } from './step-up.service.js';
import type { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { UserMfaRow, PasskeyRow } from '../dynamo/types.js';

const USER_ID = 'user-123';

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
