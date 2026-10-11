/**
 * Unit tests for PasskeyAssertionService — the shared WebAuthn boundary for the passkey LOGIN and
 * the passkey SECOND-FACTOR paths. The `@simplewebauthn/server` primitives are module-mocked so the
 * assertion logic is testable TDD-first: we drive `generateAuthenticationOptions` +
 * `verifyAuthenticationResponse` per case and assert the userId-scoping, the conditional counter
 * write, and the typed failure codes.
 *
 * The challenge store is a real DynamoDB-backed `PasskeyChallengeStore`
 * pulled from a bootstrapped app's DI
 * container — cheap to share across every case in this file since it holds
 * no in-process state; the PasskeysRepository + ConfigService are stubbed.
 */
import 'reflect-metadata';

const generateAuthenticationOptions = jest.fn();
const verifyAuthenticationResponse = jest.fn();

jest.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: (...a: unknown[]) => generateAuthenticationOptions(...a),
  verifyAuthenticationResponse: (...a: unknown[]) => verifyAuthenticationResponse(...a),
}));

// Imported after the mock is registered.
import { PasskeyAssertionService } from './passkey-assertion.service.js';
import { PasskeyChallengeStore } from './passkey-challenge-store.js';
import { bootstrapTestApp, type TestApp } from '../test/test-helpers.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import type { PasskeyRow } from '../dynamo/types.js';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

const WEB_ORIGIN = 'https://app.example.test';
const CHALLENGE = 'webauthn-challenge-xyz';

/** Build a clientDataJSON base64url string carrying the WebAuthn challenge. */
function clientDataJSON(challenge: string): string {
  return Buffer.from(JSON.stringify({ challenge, type: 'webauthn.get' })).toString('base64url');
}

function assertion(credentialId: string, challenge = CHALLENGE) {
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: clientDataJSON(challenge),
      authenticatorData: 'AA',
      signature: 'AA',
      userHandle: Buffer.from('attacker-user', 'utf8').toString('base64url'),
    },
    clientExtensionResults: {},
    type: 'public-key' as const,
  };
}

function passkeyRow(credentialId: string, counter = 0): PasskeyRow {
  return {
    userId: 'u1',
    credentialId,
    publicKey: Buffer.from('pk').toString('base64url'),
    counter,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: null,
    createdAt: '',
    lastUsedAt: null,
  };
}

interface Built {
  svc: PasskeyAssertionService;
  store: PasskeyChallengeStore;
  passkeys: { find: jest.Mock; listForUser: jest.Mock; updateCounterAndLastUsed: jest.Mock };
}

// The challenge store is now a DynamoDB-backed async facade with no
// in-process state and no sweep interval to leak — a single real instance,
// pulled from a bootstrapped app's DI container, is shared by every
// `build()` call in this file.
let t: TestApp;
let realStore: PasskeyChallengeStore;

beforeAll(async () => {
  t = await bootstrapTestApp();
  realStore = t.module.get(PasskeyChallengeStore);
});

afterAll(async () => {
  await t.app.close();
});

function build(): Built {
  const store = realStore;
  const passkeys = {
    find: jest.fn(),
    listForUser: jest.fn().mockResolvedValue([]),
    updateCounterAndLastUsed: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string) => (key === 'WEB_ORIGIN' ? WEB_ORIGIN : undefined)),
  } as unknown as ConfigService<EnvConfig, true>;
  const svc = new PasskeyAssertionService(
    store,
    passkeys as unknown as PasskeysRepository,
    config,
  );
  return { svc, store, passkeys };
}

describe('PasskeyAssertionService — generateMfaStartOptions', () => {
  beforeEach(() => {
    generateAuthenticationOptions.mockReset();
    verifyAuthenticationResponse.mockReset();
  });

  it('scopes allowCredentials to the challenge user and stores under the mfa namespace', async () => {
    const { svc, store, passkeys } = build();
    passkeys.listForUser.mockResolvedValue([
      passkeyRow('cred-a'),
      { ...passkeyRow('cred-b'), transports: ['internal'] },
    ]);
    generateAuthenticationOptions.mockResolvedValue({ challenge: CHALLENGE });

    const options = await svc.generateMfaStartOptions('u1');

    expect(options).toEqual({ challenge: CHALLENGE });
    // allowCredentials were scoped to the user's enrolled passkeys.
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        userVerification: 'required',
        allowCredentials: [
          { id: 'cred-a' },
          { id: 'cred-b', transports: ['internal'] },
        ],
      }),
    );
    // The challenge is stored under the userId-scoped mfa namespace, not
    // the discoverable `auth:` namespace.
    expect(await store.consume(`mfa:u1:${CHALLENGE}`)).toMatchObject({ challenge: CHALLENGE });
    expect(await store.consume(`auth:${CHALLENGE}`)).toBeNull();
  });
});

describe('PasskeyAssertionService — verifyMfaAssertion', () => {
  beforeEach(() => {
    generateAuthenticationOptions.mockReset();
    verifyAuthenticationResponse.mockReset();
  });

  it('verifies an assertion scoped to the challenge user and advances the counter', async () => {
    const { svc, store, passkeys } = build();
    await store.set(`mfa:u1:${CHALLENGE}`, CHALLENGE, 'u1');
    passkeys.find.mockResolvedValue(passkeyRow('cred-a', 0));
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });

    const result = await svc.verifyMfaAssertion('u1', assertion('cred-a') as never);

    expect(result).toEqual({ credentialId: 'cred-a' });
    // Resolved the credential under the challenge user — never the assertion
    // userHandle.
    expect(passkeys.find).toHaveBeenCalledWith('u1', 'cred-a');
    expect(passkeys.updateCounterAndLastUsed).toHaveBeenCalledWith(
      'u1',
      'cred-a',
      5,
      expect.any(String),
    );
  });

  it('rejects a missing/expired challenge with MFA_CODE_INVALID', async () => {
    const { svc, passkeys } = build();
    // No challenge stored.
    passkeys.find.mockResolvedValue(passkeyRow('cred-a'));
    await expect(svc.verifyMfaAssertion('u1', assertion('cred-a') as never)).rejects.toMatchObject({
      response: { code: 'MFA_CODE_INVALID' },
    });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('rejects a credential not enrolled to the challenge user (credential substitution)', async () => {
    const { svc, store, passkeys } = build();
    await store.set(`mfa:u1:${CHALLENGE}`, CHALLENGE, 'u1');
    // The asserted credential is not enrolled to u1 even though userHandle
    // claims a different user.
    passkeys.find.mockResolvedValue(null);
    await expect(svc.verifyMfaAssertion('u1', assertion('cred-foreign') as never)).rejects.toMatchObject(
      { response: { code: 'MFA_CODE_INVALID' } },
    );
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('maps a verifyAuthenticationResponse UV-failure throw to PASSKEY_USER_VERIFICATION_REQUIRED', async () => {
    const { svc, store, passkeys } = build();
    await store.set(`mfa:u1:${CHALLENGE}`, CHALLENGE, 'u1');
    passkeys.find.mockResolvedValue(passkeyRow('cred-a'));
    // SimpleWebAuthn v13's exact UV-failure message.
    verifyAuthenticationResponse.mockRejectedValue(
      new Error('User verification required, but user could not be verified'),
    );
    await expect(svc.verifyMfaAssertion('u1', assertion('cred-a') as never)).rejects.toMatchObject({
      response: { code: 'PASSKEY_USER_VERIFICATION_REQUIRED' },
    });
  });

  it('maps a verifyAuthenticationResponse counter-regression throw to PASSKEY_COUNTER_ANOMALY', async () => {
    const { svc, store, passkeys } = build();
    await store.set(`mfa:u1:${CHALLENGE}`, CHALLENGE, 'u1');
    passkeys.find.mockResolvedValue(passkeyRow('cred-a', 9));
    // SimpleWebAuthn v13's exact counter-regression message (cloned-authenticator
    // signal): both counters non-zero, presented did not strictly advance.
    verifyAuthenticationResponse.mockRejectedValue(
      new Error('Response counter value 3 was lower than expected 9'),
    );
    await expect(svc.verifyMfaAssertion('u1', assertion('cred-a') as never)).rejects.toMatchObject({
      response: { code: 'PASSKEY_COUNTER_ANOMALY' },
    });
  });

  it('maps any other verifyAuthenticationResponse throw (bad/malformed signature) to MFA_CODE_INVALID', async () => {
    const { svc, store, passkeys } = build();
    await store.set(`mfa:u1:${CHALLENGE}`, CHALLENGE, 'u1');
    passkeys.find.mockResolvedValue(passkeyRow('cred-a'));
    // An unrecognised verification failure must NOT masquerade as a UV or a
    // counter anomaly — it surfaces the generic MFA_CODE_INVALID.
    verifyAuthenticationResponse.mockRejectedValue(
      new Error('Could not verify the assertion signature'),
    );
    await expect(svc.verifyMfaAssertion('u1', assertion('cred-a') as never)).rejects.toMatchObject({
      response: { code: 'MFA_CODE_INVALID' },
    });
  });

  it('rejects a counter regression (conditional write rejection) with PASSKEY_COUNTER_ANOMALY', async () => {
    const { svc, store, passkeys } = build();
    await store.set(`mfa:u1:${CHALLENGE}`, CHALLENGE, 'u1');
    passkeys.find.mockResolvedValue(passkeyRow('cred-a', 5));
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 3 },
    });
    passkeys.updateCounterAndLastUsed.mockRejectedValue(
      new ConditionalCheckFailedException({ message: 'counter', $metadata: {} }),
    );
    await expect(svc.verifyMfaAssertion('u1', assertion('cred-a') as never)).rejects.toMatchObject({
      response: { code: 'PASSKEY_COUNTER_ANOMALY' },
    });
  });

  it('only consumes the mfa-namespace challenge, never an auth-namespace one', async () => {
    const { svc, store, passkeys } = build();
    // An `auth:`-minted (discoverable-login) challenge must NOT satisfy MFA
    // verify (namespace isolation).
    await store.set(`auth:${CHALLENGE}`, CHALLENGE);
    passkeys.find.mockResolvedValue(passkeyRow('cred-a'));
    await expect(svc.verifyMfaAssertion('u1', assertion('cred-a') as never)).rejects.toMatchObject({
      response: { code: 'MFA_CODE_INVALID' },
    });
    // The auth challenge is still present (untouched by the MFA path).
    expect(await store.consume(`auth:${CHALLENGE}`)).toMatchObject({ challenge: CHALLENGE });
  });
});

describe('PasskeyAssertionService — discoverable login seam', () => {
  beforeEach(() => {
    generateAuthenticationOptions.mockReset();
    verifyAuthenticationResponse.mockReset();
  });

  it('stores the login challenge under the auth namespace; it cannot be consumed as an mfa challenge', async () => {
    const { svc, store } = build();
    generateAuthenticationOptions.mockResolvedValue({ challenge: CHALLENGE });
    await svc.generateLoginStartOptions();
    // The login challenge lives under `auth:` only — the MFA verify path keys on
    // `mfa:<userId>:<challenge>`, so it can never consume this one.
    expect(await store.consume(`mfa:u1:${CHALLENGE}`)).toBeNull();
    expect(await svc.consumeLoginChallenge(assertion('cred-a') as never)).toMatchObject({
      challenge: CHALLENGE,
    });
  });

  it('throws PASSKEY_COUNTER_ANOMALY on a login counter regression (shared conditional write)', async () => {
    const { svc, passkeys } = build();
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    passkeys.updateCounterAndLastUsed.mockRejectedValue(
      new ConditionalCheckFailedException({ message: 'counter', $metadata: {} }),
    );
    await expect(
      svc.verifyLoginAssertion({
        userId: 'u1',
        response: assertion('cred-a') as never,
        expectedChallenge: CHALLENGE,
        passkey: passkeyRow('cred-a', 9),
      }),
    ).rejects.toMatchObject({ response: { code: 'PASSKEY_COUNTER_ANOMALY' } });
  });

  it('returns verified + advances the counter on a good login assertion', async () => {
    const { svc, passkeys } = build();
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 7 },
    });
    const result = await svc.verifyLoginAssertion({
      userId: 'u1',
      response: assertion('cred-a') as never,
      expectedChallenge: CHALLENGE,
      passkey: passkeyRow('cred-a', 0),
    });
    expect(result).toEqual({ verified: true });
    expect(passkeys.updateCounterAndLastUsed).toHaveBeenCalledWith('u1', 'cred-a', 7, expect.any(String));
  });
});
