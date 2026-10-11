/**
 * Unit tests for env validation. Locks the production guard on
 * DISABLE_THROTTLE so a stray `true` value copied from a test .env into
 * a real deployment fails boot instead of silently disabling every rate
 * limit.
 */
import { generateKeyPairSync } from 'node:crypto';
import { validateEnv } from './env.config.js';

const { privateKey: TEST_PRIVATE_PEM, publicKey: TEST_PUBLIC_PEM } = generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  },
);

describe('validateEnv — DISABLE_THROTTLE production guard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  function applyMinimumValidEnv() {
    process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'kid-1': TEST_PRIVATE_PEM });
    process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'kid-1': TEST_PUBLIC_PEM });
    process.env.AUTH_JWT_CURRENT_KID = 'kid-1';
    process.env.WEB_ORIGIN = 'http://localhost:5173';
  }

  it('rejects DISABLE_THROTTLE=true when NODE_ENV=production', () => {
    applyMinimumValidEnv();
    process.env.NODE_ENV = 'production';
    process.env.DISABLE_THROTTLE = 'true';
    expect(() => validateEnv()).toThrow(/DISABLE_THROTTLE=true is not allowed/);
  });

  it('accepts DISABLE_THROTTLE=true when NODE_ENV=development', () => {
    applyMinimumValidEnv();
    process.env.NODE_ENV = 'development';
    process.env.DISABLE_THROTTLE = 'true';
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().DISABLE_THROTTLE).toBe('true');
  });

  it('accepts DISABLE_THROTTLE=true when NODE_ENV=test', () => {
    applyMinimumValidEnv();
    process.env.NODE_ENV = 'test';
    process.env.DISABLE_THROTTLE = 'true';
    expect(() => validateEnv()).not.toThrow();
  });

  it('defaults to false when unset under any NODE_ENV', () => {
    applyMinimumValidEnv();
    process.env.NODE_ENV = 'production';
    delete process.env.DISABLE_THROTTLE;
    expect(validateEnv().DISABLE_THROTTLE).toBe('false');
  });
});

describe('validateEnv — EXPOSE_VERIFICATION_TOKEN deployed-stack guard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  function applyMinimumValidEnv() {
    process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'kid-1': TEST_PRIVATE_PEM });
    process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'kid-1': TEST_PUBLIC_PEM });
    process.env.AUTH_JWT_CURRENT_KID = 'kid-1';
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    // These tests pin STACK, which makes the snapshot-purge function
    // name and the edge shared secret deployed-stack requirements — set
    // both so they exercise only the EXPOSE_VERIFICATION_TOKEN guard.
    process.env.SNAPSHOT_PURGE_FUNCTION_NAME = 'retirement-test-snapshot-purge';
    process.env.EDGE_SHARED_SECRET = 'retirement-test-edge-secret';
    // The test runner sets DISABLE_THROTTLE=true, which has its own
    // NODE_ENV=production guard — drop it so the cases below that
    // simulate a deployed Lambda fail on nothing but this flag.
    delete process.env.DISABLE_THROTTLE;
  }

  it('rejects EXPOSE_VERIFICATION_TOKEN=true when STACK=prod', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'prod';
    process.env.EXPOSE_VERIFICATION_TOKEN = 'true';
    expect(() => validateEnv()).toThrow(/EXPOSE_VERIFICATION_TOKEN=true is not allowed/);
  });

  // The shortcut is local-development only: an AWS dev Lambda runs
  // NODE_ENV=production, so it must be refused there too — not just on prod.
  it('rejects EXPOSE_VERIFICATION_TOKEN=true on a deployed dev stack (NODE_ENV=production)', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    process.env.NODE_ENV = 'production';
    process.env.EXPOSE_VERIFICATION_TOKEN = 'true';
    expect(() => validateEnv()).toThrow(/EXPOSE_VERIFICATION_TOKEN=true is not allowed/);
  });

  it('accepts EXPOSE_VERIFICATION_TOKEN=true for local dev under STACK=dev', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    process.env.NODE_ENV = 'development';
    process.env.EXPOSE_VERIFICATION_TOKEN = 'true';
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().EXPOSE_VERIFICATION_TOKEN).toBe('true');
  });

  it('accepts EXPOSE_VERIFICATION_TOKEN=false under STACK=prod', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'prod';
    process.env.EXPOSE_VERIFICATION_TOKEN = 'false';
    expect(() => validateEnv()).not.toThrow();
  });

  it('defaults to true for a local run with no STACK', () => {
    applyMinimumValidEnv();
    delete process.env.STACK;
    process.env.NODE_ENV = 'development';
    delete process.env.EXPOSE_VERIFICATION_TOKEN;
    expect(validateEnv().EXPOSE_VERIFICATION_TOKEN).toBe('true');
  });

  it('defaults to false when unset on a deployed dev stack (NODE_ENV=production)', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    process.env.NODE_ENV = 'production';
    delete process.env.EXPOSE_VERIFICATION_TOKEN;
    expect(validateEnv().EXPOSE_VERIFICATION_TOKEN).toBe('false');
  });

  it('defaults to false when unset under STACK=prod', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'prod';
    process.env.NODE_ENV = 'production';
    delete process.env.EXPOSE_VERIFICATION_TOKEN;
    expect(validateEnv().EXPOSE_VERIFICATION_TOKEN).toBe('false');
  });
});

describe('validateEnv — API_HOST', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  function applyMinimumValidEnv() {
    process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'kid-1': TEST_PRIVATE_PEM });
    process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'kid-1': TEST_PUBLIC_PEM });
    process.env.AUTH_JWT_CURRENT_KID = 'kid-1';
    process.env.WEB_ORIGIN = 'http://localhost:5173';
  }

  it('defaults to loopback 127.0.0.1 when unset', () => {
    applyMinimumValidEnv();
    delete process.env.API_HOST;
    expect(validateEnv().API_HOST).toBe('127.0.0.1');
  });

  it('honors an explicit override (LAN opt-in)', () => {
    applyMinimumValidEnv();
    process.env.API_HOST = '0.0.0.0';
    expect(validateEnv().API_HOST).toBe('0.0.0.0');
  });

  it('defaults AUTH_JWT_ISSUER/AUTH_JWT_AUDIENCE to the local token-domain values when unset', () => {
    applyMinimumValidEnv();
    delete process.env.AUTH_JWT_ISSUER;
    delete process.env.AUTH_JWT_AUDIENCE;
    const env = validateEnv();
    expect(env.AUTH_JWT_ISSUER).toBe('retivo-api/local');
    expect(env.AUTH_JWT_AUDIENCE).toBe('retivo-web/local');
  });

  it('honors explicit per-stack AUTH_JWT_ISSUER/AUTH_JWT_AUDIENCE values', () => {
    applyMinimumValidEnv();
    process.env.AUTH_JWT_ISSUER = 'retivo-api/prod';
    process.env.AUTH_JWT_AUDIENCE = 'retivo-web/prod';
    const env = validateEnv();
    expect(env.AUTH_JWT_ISSUER).toBe('retivo-api/prod');
    expect(env.AUTH_JWT_AUDIENCE).toBe('retivo-web/prod');
  });
});

describe('validateEnv — WEB_ALLOWED_ORIGINS', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  function applyMinimumValidEnv() {
    process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'kid-1': TEST_PRIVATE_PEM });
    process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'kid-1': TEST_PUBLIC_PEM });
    process.env.AUTH_JWT_CURRENT_KID = 'kid-1';
    process.env.WEB_ORIGIN = 'http://localhost:5173';
  }

  it('defaults the parsed list to WEB_ORIGIN when unset', () => {
    applyMinimumValidEnv();
    delete process.env.WEB_ALLOWED_ORIGINS;
    expect(validateEnv().WEB_ALLOWED_ORIGINS_PARSED).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('defaults the parsed list to WEB_ORIGIN when blank', () => {
    applyMinimumValidEnv();
    process.env.WEB_ALLOWED_ORIGINS = '';
    expect(validateEnv().WEB_ALLOWED_ORIGINS_PARSED).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('parses a comma-separated list with surrounding whitespace', () => {
    applyMinimumValidEnv();
    process.env.WEB_ALLOWED_ORIGINS =
      'http://localhost:5173, http://192.168.1.42:5173';
    expect(validateEnv().WEB_ALLOWED_ORIGINS_PARSED).toEqual([
      'http://localhost:5173',
      'http://192.168.1.42:5173',
    ]);
  });

  it('strips a single trailing slash to the canonical origin', () => {
    applyMinimumValidEnv();
    process.env.WEB_ALLOWED_ORIGINS = 'http://localhost:5173/';
    expect(validateEnv().WEB_ALLOWED_ORIGINS_PARSED).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('rejects an entry that is not a valid URL', () => {
    applyMinimumValidEnv();
    process.env.WEB_ALLOWED_ORIGINS = 'not-a-url';
    expect(() => validateEnv()).toThrow(/WEB_ALLOWED_ORIGINS/);
  });

  it('rejects an entry carrying a path', () => {
    applyMinimumValidEnv();
    process.env.WEB_ALLOWED_ORIGINS = 'http://localhost:5173/app';
    expect(() => validateEnv()).toThrow(/WEB_ALLOWED_ORIGINS/);
  });

  it('rejects WEB_ORIGIN carrying a path so the fallback list cannot be empty', () => {
    applyMinimumValidEnv();
    process.env.WEB_ORIGIN = 'http://localhost:5173/app';
    delete process.env.WEB_ALLOWED_ORIGINS;
    expect(() => validateEnv()).toThrow(/WEB_ORIGIN/);
  });

  it('defaults the parsed list to a path-free WEB_ORIGIN', () => {
    applyMinimumValidEnv();
    process.env.WEB_ORIGIN = 'http://localhost:5173/';
    delete process.env.WEB_ALLOWED_ORIGINS;
    expect(validateEnv().WEB_ALLOWED_ORIGINS_PARSED).toEqual([
      'http://localhost:5173',
    ]);
  });
});

describe('validateEnv — SNAPSHOT_PURGE_FUNCTION_NAME deployed-stack guard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  function applyMinimumValidEnv() {
    process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'kid-1': TEST_PRIVATE_PEM });
    process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'kid-1': TEST_PUBLIC_PEM });
    process.env.AUTH_JWT_CURRENT_KID = 'kid-1';
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    // These tests pin STACK, which also makes the edge shared secret a
    // deployed-stack requirement — set it so they exercise only the
    // SNAPSHOT_PURGE_FUNCTION_NAME guard.
    process.env.EDGE_SHARED_SECRET = 'retirement-test-edge-secret';
  }

  it('rejects a deployed stack (STACK set) with the purge function name missing', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    delete process.env.SNAPSHOT_PURGE_FUNCTION_NAME;
    expect(() => validateEnv()).toThrow(/SNAPSHOT_PURGE_FUNCTION_NAME is required/);
  });

  it('accepts a deployed stack when the purge function name is set', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    process.env.SNAPSHOT_PURGE_FUNCTION_NAME = 'retivo-dev-snapshot-purge';
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().SNAPSHOT_PURGE_FUNCTION_NAME).toBe(
      'retivo-dev-snapshot-purge',
    );
  });

  it('allows the purge function name to stay unset in local/emulator runtime (STACK unset)', () => {
    applyMinimumValidEnv();
    delete process.env.STACK;
    delete process.env.SNAPSHOT_PURGE_FUNCTION_NAME;
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().SNAPSHOT_PURGE_FUNCTION_NAME).toBeUndefined();
  });
});

describe('validateEnv — EDGE_SHARED_SECRET deployed-stack guard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  function applyMinimumValidEnv() {
    process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'kid-1': TEST_PRIVATE_PEM });
    process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'kid-1': TEST_PUBLIC_PEM });
    process.env.AUTH_JWT_CURRENT_KID = 'kid-1';
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    // Pinning STACK also makes SNAPSHOT_PURGE_FUNCTION_NAME a deployed-stack
    // requirement — set it so these tests exercise only the edge-secret guard.
    process.env.SNAPSHOT_PURGE_FUNCTION_NAME = 'retirement-test-snapshot-purge';
  }

  it('rejects a deployed stack (STACK set) with EDGE_SHARED_SECRET absent', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    delete process.env.EDGE_SHARED_SECRET;
    expect(() => validateEnv()).toThrow(/EDGE_SHARED_SECRET is required/);
  });

  it('rejects a deployed stack with EDGE_SHARED_SECRET blank/whitespace-only', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    process.env.EDGE_SHARED_SECRET = '   ';
    expect(() => validateEnv()).toThrow(/EDGE_SHARED_SECRET is required/);
  });

  it('rejects a deployed stack with EDGE_SHARED_SECRET still the Pulumi placeholder', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    process.env.EDGE_SHARED_SECRET =
      'phase-1-placeholder-replace-via-aws-ssm-put-parameter-overwrite';
    expect(() => validateEnv()).toThrow(/EDGE_SHARED_SECRET is required/);
  });

  it('accepts a deployed stack with a real, rotated EDGE_SHARED_SECRET', () => {
    applyMinimumValidEnv();
    process.env.STACK = 'dev';
    process.env.EDGE_SHARED_SECRET = 'a-real-rotated-secret';
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().EDGE_SHARED_SECRET).toBe('a-real-rotated-secret');
  });

  it('allows EDGE_SHARED_SECRET to stay unset in local/emulator runtime (STACK unset) — the regression that would break every local dev run and the api Jest suite', () => {
    applyMinimumValidEnv();
    delete process.env.STACK;
    delete process.env.EDGE_SHARED_SECRET;
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().EDGE_SHARED_SECRET).toBeUndefined();
  });
});
