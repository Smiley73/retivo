/**
 * Unit test for the JwtAuthGuard challenge-token rejection. A real RS256 MFA challenge token
 * (minted by MfaChallengeService, which shares the access-token key store) must be rejected when
 * presented as an `Authorization: Bearer` value — it carries `purpose: 'mfa_challenge'`, and the
 * guard refuses any verified token that carries a `purpose`.
 *
 * Uses a real generated RS256 keypair + the real AccessTokenService /
 * JwtKeyStore so the verify path + claim surfacing are genuine; only the config
 * + RevokedTokens repo are stubbed.
 */
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { JwtKeyStore } from './jwt-key-store.js';
import { AccessTokenService } from './jwt.service.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import { DataExportAuthorizationService } from './data-export-authorization.service.js';
import type { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';

type TypedConfig = ConfigService<EnvConfig, true>;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/**
 * `issuer`/`audience` override the token-domain claims. Passing
 * `undefined` for either simulates a legacy token that carries no such claim
 * (or a token minted for a different environment/service).
 */
function configFor(
  opts: { issuer?: string; audience?: string } = {
    issuer: 'retivo-api/test',
    audience: 'retivo-web/test',
  },
): TypedConfig {
  return {
    get: jest.fn((key: string) => {
      if (key === 'AUTH_JWT_PRIVATE_KEYS') return { k1: privateKey };
      if (key === 'AUTH_JWT_PUBLIC_KEYS') return { k1: publicKey };
      if (key === 'AUTH_JWT_CURRENT_KID') return undefined;
      if (key === 'AUTH_ACCESS_TOKEN_TTL_MIN') return 5;
      if (key === 'AUTH_JWT_ISSUER') return opts.issuer;
      if (key === 'AUTH_JWT_AUDIENCE') return opts.audience;
      return undefined;
    }),
  } as unknown as TypedConfig;
}

function buildGuard(config: TypedConfig = configFor()): {
  guard: JwtAuthGuard;
  keyStore: JwtKeyStore;
  tokens: AccessTokenService;
  config: TypedConfig;
  revoked: { isRevoked: jest.Mock; isGenerationRevoked: jest.Mock };
} {
  const keyStore = new JwtKeyStore(config);
  keyStore.onModuleInit();
  const tokens = new AccessTokenService(keyStore, config);
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
  const revoked = {
    isRevoked: jest.fn().mockResolvedValue(false),
    isGenerationRevoked: jest.fn().mockResolvedValue(false),
  };
  const guard = new JwtAuthGuard(reflector, tokens, revoked as unknown as RevokedTokensRepository);
  return { guard, keyStore, tokens, config, revoked };
}

function ctxWithBearer(token: string): ExecutionContext {
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard — challenge token cannot be a session bearer', () => {
  it('rejects an MFA challenge token presented as Authorization: Bearer', async () => {
    const { guard, keyStore, config } = buildGuard();
    const challengeSvc = new MfaChallengeService(keyStore, config);
    const challengeToken = challengeSvc.sign('u1', 'd1', 'rev-1', 0);

    await expect(guard.canActivate(ctxWithBearer(challengeToken))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a data-export authorization token presented as Authorization: Bearer', async () => {
    const { guard, keyStore, config } = buildGuard();
    // The export-authorization token carries `purpose: 'data_export'`; like the
    // MFA challenge token it must never work as a session bearer — it is only
    // valid as the HttpOnly export cookie.
    const exportAuth = new DataExportAuthorizationService(keyStore, config);
    const token = exportAuth.sign({ userId: 'u1', householdId: 'h1', jti: 'j1' });
    await expect(guard.canActivate(ctxWithBearer(token))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts a genuine access token (no purpose claim)', async () => {
    const { guard, tokens } = buildGuard();
    const { token } = tokens.sign({
      userId: 'u1',
      householdId: 'u1',
      deviceId: 'd1',
      email: 'a@b.test',
      sessionGeneration: 0,
    });
    await expect(guard.canActivate(ctxWithBearer(token))).resolves.toBe(true);
  });

  it('rejects an access token that carries NO issuer/audience claims', async () => {
    // A legacy access token was signed without iss/aud. Mint one directly with
    // the real key material but no issuer/audience options, then verify against
    // a strict guard.
    const { guard, keyStore } = buildGuard();
    const { kid, privateKey } = keyStore.current();
    const token = jwt.sign(
      { userId: 'u1', householdId: 'u1', deviceId: 'd1', email: 'a@b.test' },
      privateKey,
      { algorithm: 'RS256', keyid: kid, jwtid: 'j1', expiresIn: 300 },
    );
    await expect(guard.canActivate(ctxWithBearer(token))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an access token minted for a DIFFERENT environment/service (wrong issuer/audience)', async () => {
    const other = buildGuard(
      configFor({ issuer: 'retivo-api/other', audience: 'retivo-web/other' }),
    );
    const { token } = other.tokens.sign({
      userId: 'u1',
      householdId: 'u1',
      deviceId: 'd1',
      email: 'a@b.test',
    });
    const { guard } = buildGuard();
    await expect(guard.canActivate(ctxWithBearer(token))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('authenticates a token carrying legal-status claims and drops them from req.auth', async () => {
    const { guard, keyStore } = buildGuard();
    // A token issued before legal enforcement was removed may still carry the
    // six legal-status claims; `sign` no longer emits them, so sign one by hand.
    const { kid, privateKey: signingKey } = keyStore.current();
    const token = jwt.sign(
      {
        userId: 'u1',
        householdId: 'u1',
        deviceId: 'd1',
        email: 'a@b.test',
        sessionGeneration: 0,
        acceptedTermsVersion: 2,
        acceptedTermsSha256: 'a'.repeat(64),
        acknowledgedPrivacyVersion: 3,
        acknowledgedPrivacySha256: 'b'.repeat(64),
        acceptedPresentationVersion: 4,
        acceptedPresentationSha256: 'c'.repeat(64),
      },
      signingKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        jwtid: 'legacy-jti',
        expiresIn: 300,
        issuer: 'retivo-api/test',
        audience: 'retivo-web/test',
      },
    );
    const req = { headers: { authorization: `Bearer ${token}` } } as {
      headers: Record<string, string>;
      auth?: Record<string, unknown>;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.auth).toEqual(expect.objectContaining({ userId: 'u1', jti: 'legacy-jti' }));
    for (const name of [
      'acceptedTermsVersion',
      'acceptedTermsSha256',
      'acknowledgedPrivacyVersion',
      'acknowledgedPrivacySha256',
      'acceptedPresentationVersion',
      'acceptedPresentationSha256',
    ]) {
      expect(req.auth).not.toHaveProperty(name);
    }
  });
});

/**
 * Unit coverage for the generation-based revocation check:
 * the guard's four cases — jti hit,
 * tombstone hit, both absent, claim absent — and that the two point reads
 * are issued CONCURRENTLY, never one `await`ed before the other starts.
 */
describe('JwtAuthGuard — generation-based revocation', () => {
  it('accepts a token whose jti and generation are both clean', async () => {
    const { guard, tokens } = buildGuard();
    const { token } = tokens.sign({
      userId: 'u1',
      householdId: 'u1',
      deviceId: 'd1',
      email: 'a@b.test',
      sessionGeneration: 3,
    });
    await expect(guard.canActivate(ctxWithBearer(token))).resolves.toBe(true);
  });

  it('rejects on a jti hit (ACCESS_TOKEN_REVOKED)', async () => {
    const { guard, tokens, revoked } = buildGuard();
    revoked.isRevoked.mockResolvedValue(true);
    const { token } = tokens.sign({
      userId: 'u1',
      householdId: 'u1',
      deviceId: 'd1',
      email: 'a@b.test',
      sessionGeneration: 3,
    });
    await expect(guard.canActivate(ctxWithBearer(token))).rejects.toMatchObject({
      response: { code: 'ACCESS_TOKEN_REVOKED' },
    });
  });

  it('rejects on a tombstoned generation (ACCESS_TOKEN_REVOKED), jti clean', async () => {
    const { guard, tokens, revoked } = buildGuard();
    revoked.isGenerationRevoked.mockResolvedValue(true);
    const { token } = tokens.sign({
      userId: 'u1',
      householdId: 'u1',
      deviceId: 'd1',
      email: 'a@b.test',
      sessionGeneration: 3,
    });
    await expect(guard.canActivate(ctxWithBearer(token))).rejects.toMatchObject({
      response: { code: 'ACCESS_TOKEN_REVOKED' },
    });
    expect(revoked.isGenerationRevoked).toHaveBeenCalledWith('u1', 3);
  });

  it('rejects a token with no sessionGeneration claim at all (cutover) without consulting either repository lookup', async () => {
    const { guard, tokens, revoked } = buildGuard();
    const { token } = tokens.sign({
      userId: 'u1',
      householdId: 'u1',
      deviceId: 'd1',
      email: 'a@b.test',
      // sessionGeneration omitted — a pre-cutover token.
    });
    await expect(guard.canActivate(ctxWithBearer(token))).rejects.toMatchObject({
      response: { code: 'ACCESS_TOKEN_REVOKED' },
    });
    expect(revoked.isRevoked).not.toHaveBeenCalled();
    expect(revoked.isGenerationRevoked).not.toHaveBeenCalled();
  });

  it('issues the jti and generation lookups CONCURRENTLY — never awaits the first before starting the second', async () => {
    const { guard, tokens, revoked } = buildGuard();
    const order: string[] = [];
    let releaseJti: () => void = () => {};
    const jtiGate = new Promise<void>((resolve) => {
      releaseJti = resolve;
    });
    revoked.isRevoked.mockImplementation(async () => {
      order.push('jti-start');
      await jtiGate;
      order.push('jti-end');
      return false;
    });
    revoked.isGenerationRevoked.mockImplementation(async () => {
      // If the guard sequentially awaited `isRevoked` first, this would never
      // run until `jtiGate` resolves — proving it instead starts BEFORE the
      // jti lookup settles closes the race a sequential implementation would
      // otherwise hide behind identical pass/fail behaviour.
      order.push('generation-start');
      return false;
    });
    const { token } = tokens.sign({
      userId: 'u1',
      householdId: 'u1',
      deviceId: 'd1',
      email: 'a@b.test',
      sessionGeneration: 3,
    });

    const pending = guard.canActivate(ctxWithBearer(token));
    // Let both mocks' synchronous prologue run before releasing the gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['jti-start', 'generation-start']);
    releaseJti();
    await expect(pending).resolves.toBe(true);
    expect(order).toEqual(['jti-start', 'generation-start', 'jti-end']);
  });
});
