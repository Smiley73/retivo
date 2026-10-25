// PasskeyController's register/finish factor-notice wiring and authenticate/finish session-generation pinning. The integration suite has no virtual authenticator, so every
// dependency is stubbed, WebAuthn verification is mocked to succeed, and the collaborator call under test is asserted.
import 'reflect-metadata';

const verifyRegistrationResponse = jest.fn();

jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(),
  verifyRegistrationResponse: (...a: unknown[]) => verifyRegistrationResponse(...a),
}));

import { PasskeyController } from './passkey.controller.js';
import { PasskeyChallengeStore } from './passkey-challenge-store.js';
import { bootstrapTestApp, type TestApp } from '../test/test-helpers.js';
import type { PasskeyAssertionService } from './passkey-assertion.service.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { LoginService } from './login.service.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { VerifyPasswordService } from './verify-password.service.js';
import type { StepUpService } from './step-up.service.js';
import type { FactorNoticeService } from './factor-notice.service.js';
import type { FactorEnrollmentGuardService } from './factor-enrollment-guard.service.js';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import type { AccessTokenClaims } from './jwt.service.js';

const WEB_ORIGIN = 'https://app.example.test';
const USER_ID = 'u1';
const CHALLENGE = 'webauthn-registration-challenge';

// One real challenge store from a bootstrapped app's DI container is shared by every build() call, since it holds no in-process state.
let t: TestApp;
let realChallengeStore: PasskeyChallengeStore;

beforeAll(async () => {
  t = await bootstrapTestApp();
  realChallengeStore = t.module.get(PasskeyChallengeStore);
});

afterAll(async () => {
  await t.app.close();
});

afterEach(() => {
  jest.clearAllMocks();
});

function buildConfig(): ConfigService<EnvConfig, true> {
  return {
    get: jest.fn((key: string) =>
      key === 'WEB_ORIGIN' ? WEB_ORIGIN : 'false',
    ),
  } as unknown as ConfigService<EnvConfig, true>;
}

interface Built {
  controller: PasskeyController;
  challenges: PasskeyChallengeStore;
  passkeys: { insert: jest.Mock; find: jest.Mock };
  users: { findById: jest.Mock; findByIdConsistent: jest.Mock };
  assertions: { consumeLoginChallenge: jest.Mock; verifyLoginAssertion: jest.Mock };
  loginSvc: { issueSession: jest.Mock };
  auth: { record: jest.Mock };
  factorNotice: { notify: jest.Mock };
  factorEnrollmentGuard: { enforce: jest.Mock };
}

function build(): Built {
  const challenges = realChallengeStore;
  const passkeys = {
    insert: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue(null),
  };
  const users = {
    findById: jest.fn().mockResolvedValue({ userId: USER_ID, email: 'person@example.test' }),
    findByIdConsistent: jest
      .fn()
      .mockResolvedValue({ userId: USER_ID, householdId: USER_ID, email: 'person@example.test' }),
  };
  const assertions = {
    consumeLoginChallenge: jest.fn().mockReturnValue(null),
    verifyLoginAssertion: jest.fn().mockResolvedValue({ verified: false }),
  };
  const loginSvc = { issueSession: jest.fn() };
  const auth = { record: jest.fn().mockResolvedValue(undefined) };
  const factorNotice = { notify: jest.fn().mockResolvedValue(true) };
  const factorEnrollmentGuard = { enforce: jest.fn().mockResolvedValue(undefined) };
  const controller = new PasskeyController(
    challenges,
    assertions as unknown as PasskeyAssertionService,
    passkeys as unknown as PasskeysRepository,
    users as unknown as UsersRepository,
    loginSvc as unknown as LoginService,
    auth as unknown as AuthEventsRepository,
    {} as VerifyPasswordService,
    {} as StepUpService,
    factorNotice as unknown as FactorNoticeService,
    factorEnrollmentGuard as unknown as FactorEnrollmentGuardService,
    buildConfig(),
  );
  return {
    controller,
    challenges,
    passkeys,
    users,
    assertions,
    loginSvc,
    auth,
    factorNotice,
    factorEnrollmentGuard,
  };
}

function claims(): AccessTokenClaims {
  return { userId: USER_ID } as AccessTokenClaims;
}

describe('PasskeyController.registerFinish — factor-change notice wiring', () => {
  it('notifies passkey_add with the new credentialId on a successful registration', async () => {
    const { controller, challenges, passkeys, factorNotice } = build();
    await challenges.set(`reg:${USER_ID}`, CHALLENGE, USER_ID);

    const credentialId = 'new-credential-id';
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: credentialId,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: undefined,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });

    const result = await controller.registerFinish(claims(), {
      response: {},
      stepUp: { currentPassword: 'pw123456' },
    } as never, { ip: '203.0.113.1', headers: {} } as never);

    expect(passkeys.insert).toHaveBeenCalledTimes(1);
    expect(factorNotice.notify).toHaveBeenCalledTimes(1);
    expect(factorNotice.notify).toHaveBeenCalledWith({
      userId: USER_ID,
      email: 'person@example.test',
      kind: 'passkey_add',
      credentialId,
    });
    expect(result).toEqual(expect.objectContaining({ credentialId, noticeSent: true }));
  });

  it('reports noticeSent: false when the notice could not be mailed, with the registration still committed', async () => {
    const { controller, challenges, passkeys, factorNotice } = build();
    await challenges.set(`reg:${USER_ID}`, CHALLENGE, USER_ID);
    factorNotice.notify.mockResolvedValue(false);
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-unmailed', publicKey: new Uint8Array([1]), counter: 0 },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });

    const result = await controller.registerFinish(
      claims(),
      { response: {}, stepUp: { currentPassword: 'pw123456' } } as never,
      { ip: '203.0.113.1', headers: {} } as never,
    );

    expect(passkeys.insert).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ credentialId: 'cred-unmailed', noticeSent: false }));
  });
});

describe('PasskeyController.authenticateFinish — session generation pinning', () => {
  const DEVICE_ID = '11111111-1111-1111-1111-111111111111';
  const CREDENTIAL_ID = 'cred-1';

  function assertionBody(): never {
    return {
      deviceId: DEVICE_ID,
      response: {
        id: CREDENTIAL_ID,
        rawId: CREDENTIAL_ID,
        type: 'public-key',
        response: {
          userHandle: Buffer.from(USER_ID, 'utf8').toString('base64url'),
          clientDataJSON: 'e30',
          authenticatorData: 'AA',
          signature: 'AA',
        },
      },
    } as never;
  }

  it('stamps the generation observed BEFORE the assertion verified — a revoke committing between the assertion and issuance is not adopted', async () => {
    const { controller, users, passkeys, assertions, loginSvc } = build();
    const beforeRevoke = {
      userId: USER_ID,
      householdId: USER_ID,
      email: 'person@example.test',
      sessionGeneration: 0,
    };
    const afterRevoke = { ...beforeRevoke, sessionGeneration: 1 };
    assertions.consumeLoginChallenge.mockReturnValue({ challenge: 'login-challenge' });
    users.findByIdConsistent.mockResolvedValue(beforeRevoke);
    passkeys.find.mockResolvedValue({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      restrictedPostReset: false,
    });
    assertions.verifyLoginAssertion.mockImplementation(async () => {
      // The account-wide revocation lands here, after the assertion proof is gathered and before the session is issued: revokeAll commits generation 0 to 1.
      users.findByIdConsistent.mockResolvedValue(afterRevoke);
      users.findById.mockResolvedValue(afterRevoke);
      return { verified: true };
    });
    loginSvc.issueSession.mockResolvedValue({
      accessToken: 'access',
      expiresInSec: 300,
      refreshToken: 'refresh',
      refreshExpiresInSec: 1800,
      csrfToken: 'csrf',
    });

    await controller.authenticateFinish(
      assertionBody(),
      { ip: '203.0.113.1', headers: {} } as never,
      { cookie: jest.fn() } as never,
    );

    // Issuance must stamp the pre-assertion value (0), so the generation ConditionCheck against the now-1 User row rejects the sign-in instead of a fallback re-read minting a session that survives the revoke.
    expect(loginSvc.issueSession).toHaveBeenCalledTimes(1);
    expect(loginSvc.issueSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, sessionGeneration: 0 }),
    );
    // Exactly one User read, strongly consistent and before the assertion.
    expect(users.findByIdConsistent).toHaveBeenCalledTimes(1);
    expect(users.findById).not.toHaveBeenCalled();
    const [userRead] = users.findByIdConsistent.mock.invocationCallOrder;
    const [assertionVerified] = assertions.verifyLoginAssertion.mock.invocationCallOrder;
    expect(userRead).toBeLessThan(assertionVerified);
  });

  it('returns only the session tokens — a session object carrying the profile is not forwarded', async () => {
    const { controller, users, passkeys, assertions, loginSvc } = build();
    assertions.consumeLoginChallenge.mockReturnValue({ challenge: 'login-challenge' });
    passkeys.find.mockResolvedValue({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      restrictedPostReset: false,
    });
    assertions.verifyLoginAssertion.mockResolvedValue({ verified: true });
    users.findByIdConsistent.mockResolvedValue({
      userId: USER_ID,
      householdId: USER_ID,
      email: 'person@example.test',
      sessionGeneration: 0,
    });
    // The mock is untyped and can carry fields the real result no longer declares; a handler that still mapped them would leak them.
    loginSvc.issueSession.mockResolvedValue({
      accessToken: 'access',
      expiresInSec: 300,
      refreshToken: 'refresh',
      refreshExpiresInSec: 1800,
      csrfToken: 'csrf',
      firstName: 'Jane',
      lastName: 'Smith',
      birthdate: '1980-04-15',
    });

    const result = await controller.authenticateFinish(
      assertionBody(),
      { ip: '203.0.113.1', headers: {} } as never,
      { cookie: jest.fn() } as never,
    );

    expect(result).toEqual({ accessToken: 'access', expiresIn: 300 });
  });
});
