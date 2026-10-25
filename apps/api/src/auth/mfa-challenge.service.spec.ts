// MfaChallengeService: the 5-minute challenge token round-trips for its minting environment and fails closed with MFA_CHALLENGE_INVALID for the wrong issuer/audience or none at all,
// using a real RS256 keypair and JwtKeyStore with only config stubbed. That it is never accepted as a session bearer is proven in jwt-auth.guard.spec.ts.
import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import { JwtKeyStore } from './jwt-key-store.js';
import { MfaChallengeService } from './mfa-challenge.service.js';

type TypedConfig = ConfigService<EnvConfig, true>;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ISSUER = 'retivo-api/test';
const AUDIENCE = 'retivo-web/test';
const USER_ID = 'user-1';
const DEVICE_ID = 'device-1';
const MFA_CHALLENGE_TTL_SEC = 5 * 60;

function configFor(
  opts: { issuer?: string; audience?: string } = { issuer: ISSUER, audience: AUDIENCE },
): TypedConfig {
  return {
    get: jest.fn((key: string) => {
      if (key === 'AUTH_JWT_PRIVATE_KEYS') return { k1: privateKey };
      if (key === 'AUTH_JWT_PUBLIC_KEYS') return { k1: publicKey };
      if (key === 'AUTH_JWT_CURRENT_KID') return undefined;
      if (key === 'AUTH_JWT_ISSUER') return opts.issuer;
      if (key === 'AUTH_JWT_AUDIENCE') return opts.audience;
      return undefined;
    }),
  } as unknown as TypedConfig;
}

function buildService(config: TypedConfig = configFor()): {
  svc: MfaChallengeService;
  keyStore: JwtKeyStore;
} {
  const keyStore = new JwtKeyStore(config);
  keyStore.onModuleInit();
  return { svc: new MfaChallengeService(keyStore, config), keyStore };
}

function expectChallengeInvalid(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UnauthorizedException);
  const body = (thrown as UnauthorizedException).getResponse() as { code?: string };
  expect(body.code).toBe('MFA_CHALLENGE_INVALID');
}

describe('MfaChallengeService', () => {
  it('should_verify_a_correctly_signed_token_for_the_minting_environment', () => {
    const { svc } = buildService();
    const decoded = svc.verify(svc.sign(USER_ID, DEVICE_ID, 'rev-1', 0));
    expect(decoded).toMatchObject({ userId: USER_ID, deviceId: DEVICE_ID });
    // Single-use ledger claims: a namespace-disjoint `mfa:`-prefixed jti, and the numeric epoch-second expiry used as the ledger row TTL.
    expect(decoded.jti).toMatch(/^mfa:[0-9a-f-]+$/);
    expect(typeof decoded.expiresAt).toBe('number');
  });

  it('should_reject_a_token_missing_or_mis-prefixed_jti', () => {
    // A bare-UUID jti must fail closed: only the `mfa:`-prefixed jti is accepted, so a consumption ledger row can never collide with a bearer-token revocation.
    const { svc, keyStore } = buildService();
    const { kid, privateKey: pk } = keyStore.current();
    const badJtiToken = jwt.sign(
      {
        userId: USER_ID,
        deviceId: DEVICE_ID,
        purpose: 'mfa_challenge',
        jti: 'not-mfa-prefixed',
      },
      pk,
      {
        algorithm: 'RS256',
        keyid: kid,
        expiresIn: MFA_CHALLENGE_TTL_SEC,
        issuer: 'retivo-api/test',
        audience: 'retivo-web/test',
      },
    );
    expectChallengeInvalid(() => svc.verify(badJtiToken));
  });

  it('should_reject_a_token_signed_for_a_different_issuer_audience_domain', () => {
    // A token minted for another environment or service must fail closed though otherwise a valid RS256 challenge token.
    const other = buildService(
      configFor({ issuer: 'retivo-api/other', audience: 'retivo-web/other' }),
    );
    const token = other.svc.sign(USER_ID, DEVICE_ID, 'rev-1', 0);
    const { svc } = buildService();
    expectChallengeInvalid(() => svc.verify(token));
  });

  it('should_reject_a_token_carrying_no_issuer_audience_claims', () => {
    // A legacy challenge token signed without iss/aud, minted directly with the real key.
    const { svc, keyStore } = buildService();
    const { kid, privateKey: pk } = keyStore.current();
    const legacyToken = jwt.sign(
      { userId: USER_ID, deviceId: DEVICE_ID, purpose: 'mfa_challenge' },
      pk,
      { algorithm: 'RS256', keyid: kid, expiresIn: MFA_CHALLENGE_TTL_SEC },
    );
    expectChallengeInvalid(() => svc.verify(legacyToken));
  });
});
