/**
 * Unit tests for DataExportAuthorizationService. Proves the 5-minute session-bound
 * export-authorization token round-trips for the exact minting session and fails closed for a wrong
 * session / user / household, a tampered token, an expired one, a missing `purpose`, or a missing
 * cookie. Uses a real generated RS256 keypair + the real JwtKeyStore so the sign/verify path is
 * genuine; only the config is stubbed.
 *
 * The "never accepted as a session bearer" property is proven in
 * jwt-auth.guard.spec.ts (the guard's domain), where JwtAuthGuard rejects this
 * token because it carries a `purpose` claim.
 */
import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { EnvConfig } from '../common/env.config.js';
import { JwtKeyStore } from './jwt-key-store.js';
import {
  DataExportAuthorizationService,
  DATA_EXPORT_AUTHORIZATION_PURPOSE,
  type ExportAuthorizationBinding,
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

const BINDING: ExportAuthorizationBinding = {
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
    // Flip the FIRST character of the signature segment. Its base64url char
    // encodes the top 6 bits of the signature's first byte — always meaningful,
    // unlike the whole-token last char (only the last byte's low 2 bits, the
    // rest decode-discarded padding), so this is deterministically tamper-red.
    const [header, payload, sig] = token.split('.');
    const tamperedSigHead = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${header}.${payload}.${tamperedSigHead}${sig.slice(1)}`;
    expect(svc.verify(tampered, BINDING)).toBe(false);
  });

  it('should_reject_an_expired_token', () => {
    const { svc, keyStore } = buildService();
    const { kid, privateKey: pk } = keyStore.current();
    const expired = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: DATA_EXPORT_AUTHORIZATION_PURPOSE },
      pk,
      { algorithm: 'RS256', keyid: kid, expiresIn: -10 },
    );
    expect(svc.verify(expired, BINDING)).toBe(false);
  });

  it('should_reject_a_token_with_a_wrong_issuer_audience_domain', () => {
    // A token minted for a DIFFERENT environment/service must fail closed even
    // though it is otherwise a valid RS256 export-authorization token.
    const other = buildService(
      configFor({ issuer: 'retivo-api/other', audience: 'retivo-web/other' }),
    );
    const token = other.svc.sign(BINDING);
    const { svc } = buildService();
    expect(svc.verify(token, BINDING)).toBe(false);
  });

  it('should_reject_a_token_carrying_no_issuer_audience_claims', () => {
    // A legacy export-authorization token was signed without iss/aud — mint one
    // directly with the real key but no issuer/audience options.
    const { svc, keyStore } = buildService();
    const { kid, privateKey: pk } = keyStore.current();
    const legacyToken = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: DATA_EXPORT_AUTHORIZATION_PURPOSE },
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
    // A lone `%` is an invalid percent-sequence: decodeURIComponent throws
    // URIError. verifyFromRequest must treat it as an absent cookie (false), not
    // let the exception escape its documented never-throws contract.
    const req = reqWithCookie(`${EXPORT_AUTHORIZATION_COOKIE_NAME}=%; other=x`);
    expect(() => svc.verifyFromRequest(req, BINDING)).not.toThrow();
    expect(svc.verifyFromRequest(req, BINDING)).toBe(false);
  });

  it('should_reject_a_token_with_no_kid_in_its_header', () => {
    const { svc, keyStore } = buildService();
    const { privateKey: pk } = keyStore.current();
    const noKid = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: DATA_EXPORT_AUTHORIZATION_PURPOSE },
      pk,
      { algorithm: 'RS256', expiresIn: EXPORT_AUTHORIZATION_TTL_SEC },
    );
    expect(svc.verify(noKid, BINDING)).toBe(false);
  });

  it('should_reject_a_token_with_an_unknown_kid', () => {
    const { svc } = buildService();
    const unknownKid = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: DATA_EXPORT_AUTHORIZATION_PURPOSE },
      privateKey,
      { algorithm: 'RS256', keyid: 'not-registered', expiresIn: EXPORT_AUTHORIZATION_TTL_SEC },
    );
    expect(svc.verify(unknownKid, BINDING)).toBe(false);
  });

  it('should_reject_a_token_signed_with_a_non_rs256_algorithm', () => {
    const { svc } = buildService();
    // HS256-signed token carrying a registered kid: the kid lookup succeeds but
    // the RS256-only verify must reject the disallowed algorithm.
    const hsToken = jwt.sign(
      { ...BINDING, boundJti: BINDING.jti, purpose: DATA_EXPORT_AUTHORIZATION_PURPOSE },
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
