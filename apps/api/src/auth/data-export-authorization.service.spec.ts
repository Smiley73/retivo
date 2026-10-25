// DataExportAuthorizationService: the 5-minute session-bound export token round-trips for the exact minting session and fails closed for a wrong session, user or household, a tampered or expired token, a missing `purpose` or a missing cookie.
// Real RS256 keypair and JwtKeyStore; only config is stubbed. That the token is never accepted as a session bearer is proven in jwt-auth.guard.spec.ts.
import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { EnvConfig } from '../common/env.config.js';
import { JwtKeyStore } from './jwt-key-store.js';
import {
  DataExportAuthorizationService,
} from './data-export-authorization.service.js';
import {
  EXPORT_AUTHORIZATION_COOKIE_NAME,
  EXPORT_AUTHORIZATION_TTL_SEC,
} from './cookie-config.js';

type TypedConfig = ConfigService<EnvConfig, true>;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ISSUER = 'retivo-api/test';
const AUDIENCE = 'retivo-web/test';

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
  svc: DataExportAuthorizationService;
  keyStore: JwtKeyStore;
} {
  const keyStore = new JwtKeyStore(config);
  keyStore.onModuleInit();
  return { svc: new DataExportAuthorizationService(keyStore, config), keyStore };
}

const BINDING = {
  userId: 'user-1',
  householdId: 'household-1',
  jti: 'jti-1',
};

function reqWithCookie(cookie: string): Request {
  return { headers: { cookie } } as unknown as Request;
}

describe('DataExportAuthorizationService', () => {
  it('should_verify_a_token_for_the_exact_minting_session', () => {
    const { svc } = buildService();
    expect(svc.verify(svc.sign(BINDING), BINDING)).toBe(true);
  });

  it('should_reject_a_token_for_a_different_user', () => {
    const { svc } = buildService();
    const token = svc.sign(BINDING);
    expect(svc.verify(token, { ...BINDING, userId: 'user-2' })).toBe(false);
  });

  it('should_reject_a_token_for_a_different_household', () => {
    const { svc } = buildService();
    const token = svc.sign(BINDING);
    expect(svc.verify(token, { ...BINDING, householdId: 'household-2' })).toBe(false);
  });

  it('should_reject_a_token_bound_to_a_different_session_jti', () => {
    const { svc } = buildService();
    const token = svc.sign(BINDING);
    expect(svc.verify(token, { ...BINDING, jti: 'jti-2' })).toBe(false);
  });

  it('should_reject_a_tampered_token', () => {
    const { svc } = buildService();
    const token = svc.sign(BINDING);
    // The signature's first base64url char encodes the top 6 bits of its first byte, always meaningful, unlike the last char (low 2 bits of the last byte, the rest discarded padding), so flipping it is a deterministic tamper.
    const [header, payload, sig] = token.split('.');
    const tamperedSigHead = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${header}.${payload}.${tamperedSigHead}${sig.slice(1)}`;
    expect(svc.verify(tampered, BINDING)).toBe(false);
  });

  it('should_reject_an_expired_token', () => {
    const { svc, keyStore } = buildService();
    const { kid, privateKey: pk } = keyStore.current();
    const expired = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: 'data_export' },
      pk,
      { algorithm: 'RS256', keyid: kid, expiresIn: -10 },
    );
    expect(svc.verify(expired, BINDING)).toBe(false);
  });

  it('should_reject_a_token_with_a_wrong_issuer_audience_domain', () => {
    // A token minted for another environment or service must fail closed though otherwise a valid RS256 token.
    const other = buildService(
      configFor({ issuer: 'retivo-api/other', audience: 'retivo-web/other' }),
    );
    const token = other.svc.sign(BINDING);
    const { svc } = buildService();
    expect(svc.verify(token, BINDING)).toBe(false);
  });

  it('should_reject_a_token_carrying_no_issuer_audience_claims', () => {
    // A legacy token signed without iss/aud, minted directly with the real key.
    const { svc, keyStore } = buildService();
    const { kid, privateKey: pk } = keyStore.current();
    const legacyToken = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: 'data_export' },
      pk,
      { algorithm: 'RS256', keyid: kid, expiresIn: EXPORT_AUTHORIZATION_TTL_SEC },
    );
    expect(svc.verify(legacyToken, BINDING)).toBe(false);
  });

  it('should_reject_a_token_missing_the_data_export_purpose', () => {
    const { svc, keyStore } = buildService();
    const { kid, privateKey: pk } = keyStore.current();
    const noPurpose = jwt.sign(
      { userId: BINDING.userId, householdId: BINDING.householdId, boundJti: BINDING.jti },
      pk,
      { algorithm: 'RS256', keyid: kid, expiresIn: EXPORT_AUTHORIZATION_TTL_SEC },
    );
    expect(svc.verify(noPurpose, BINDING)).toBe(false);
  });

  it('should_verify_a_valid_cookie_off_the_request', () => {
    const { svc } = buildService();
    const token = svc.sign(BINDING);
    const req = reqWithCookie(`${EXPORT_AUTHORIZATION_COOKIE_NAME}=${token}; other=x`);
    expect(svc.verifyFromRequest(req, BINDING)).toBe(true);
  });

  it('should_reject_a_request_with_no_export_cookie', () => {
    const { svc } = buildService();
    expect(svc.verifyFromRequest(reqWithCookie('other=x'), BINDING)).toBe(false);
  });

  it('should_fail_closed_not_throw_for_a_malformed_percent_encoded_cookie', () => {
    const { svc } = buildService();
    // A lone `%` makes decodeURIComponent throw URIError; verifyFromRequest must treat it as an absent cookie, not break its never-throws contract.
    const req = reqWithCookie(`${EXPORT_AUTHORIZATION_COOKIE_NAME}=%; other=x`);
    expect(() => svc.verifyFromRequest(req, BINDING)).not.toThrow();
    expect(svc.verifyFromRequest(req, BINDING)).toBe(false);
  });

  it('should_reject_a_token_with_no_kid_in_its_header', () => {
    const { svc, keyStore } = buildService();
    const { privateKey: pk } = keyStore.current();
    const noKid = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: 'data_export' },
      pk,
      { algorithm: 'RS256', expiresIn: EXPORT_AUTHORIZATION_TTL_SEC },
    );
    expect(svc.verify(noKid, BINDING)).toBe(false);
  });

  it('should_reject_a_token_with_an_unknown_kid', () => {
    const { svc } = buildService();
    const unknownKid = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: 'data_export' },
      privateKey,
      { algorithm: 'RS256', keyid: 'not-registered', expiresIn: EXPORT_AUTHORIZATION_TTL_SEC },
    );
    expect(svc.verify(unknownKid, BINDING)).toBe(false);
  });

  it('should_reject_a_token_signed_with_a_non_rs256_algorithm', () => {
    const { svc } = buildService();
    // An HS256-signed token with a registered kid passes the kid lookup, so the RS256-only verify must reject the algorithm.
    const hsToken = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: 'data_export' },
      'shared-secret',
      { algorithm: 'HS256', keyid: 'k1', expiresIn: EXPORT_AUTHORIZATION_TTL_SEC },
    );
    expect(svc.verify(hsToken, BINDING)).toBe(false);
  });

  it('should_set_an_httponly_strict_5min_cookie_scoped_to_api_v1', () => {
    const { svc } = buildService();
    const cookie = jest.fn();
    svc.issueCookie({ cookie } as unknown as Response, BINDING);
    expect(cookie).toHaveBeenCalledWith(
      EXPORT_AUTHORIZATION_COOKIE_NAME,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        path: '/api/v1',
        maxAge: EXPORT_AUTHORIZATION_TTL_SEC * 1000,
      }),
    );
  });
});
