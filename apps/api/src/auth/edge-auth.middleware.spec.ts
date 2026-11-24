// EdgeAuthMiddleware: no-op pass-through with both secrets unset (local dev, tests), the primary or previous (rotation overlap) secret calls next(), and a missing or wrong header is 403 EDGE_AUTH_REQUIRED.
// Accepting exits settle `req.ip` from the viewer-address header; the rejecting exit never does.
import type { Request, Response } from 'express';
import { EdgeAuthMiddleware } from './edge-auth.middleware.js';

interface FakeConfig {
  EDGE_SHARED_SECRET?: string;
  EDGE_SHARED_SECRET_PREVIOUS?: string;
}

function makeMiddleware(env: FakeConfig): EdgeAuthMiddleware {
  const config = {
    get: (key: keyof FakeConfig) => env[key],
  } as unknown as ConstructorParameters<typeof EdgeAuthMiddleware>[0];
  return new EdgeAuthMiddleware(config);
}

function makeReqRes(header?: string) {
  const req = { headers: header !== undefined ? { 'x-origin-verify': header } : {} } as unknown as Request;
  const calls = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      calls.status = code;
      return this;
    },
    json(body: unknown) {
      calls.body = body;
      return this;
    },
  } as unknown as Response;
  const next = jest.fn();
  return { req, res, next, calls };
}

describe('EdgeAuthMiddleware', () => {
  it('is a no-op when neither env var is set (local dev / tests)', () => {
    const mw = makeMiddleware({});
    const { req, res, next, calls } = makeReqRes();
    mw.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(calls.status).toBe(0);
  });

  it('calls next() when the request carries the primary secret', () => {
    const mw = makeMiddleware({ EDGE_SHARED_SECRET: 'primary-secret-xyz' });
    const { req, res, next } = makeReqRes('primary-secret-xyz');
    mw.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() when the request carries the previous secret (rotation overlap)', () => {
    const mw = makeMiddleware({
      EDGE_SHARED_SECRET: 'new-secret-abc',
      EDGE_SHARED_SECRET_PREVIOUS: 'old-secret-xyz',
    });
    const { req, res, next } = makeReqRes('old-secret-xyz');
    mw.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects with 403 EDGE_AUTH_REQUIRED when the header is missing', () => {
    const mw = makeMiddleware({ EDGE_SHARED_SECRET: 'primary-secret-xyz' });
    const { req, res, next, calls } = makeReqRes();
    mw.use(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(calls.status).toBe(403);
    expect(calls.body).toEqual({
      error: {
        code: 'EDGE_AUTH_REQUIRED',
        message: 'Direct origin access denied.',
      },
    });
  });

  it('rejects when the header value does not match either secret', () => {
    const mw = makeMiddleware({
      EDGE_SHARED_SECRET: 'new-secret',
      EDGE_SHARED_SECRET_PREVIOUS: 'old-secret',
    });
    const { req, res, next, calls } = makeReqRes('totally-wrong-secret');
    mw.use(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(calls.status).toBe(403);
  });

  it('rejects when the header is present but empty', () => {
    const mw = makeMiddleware({ EDGE_SHARED_SECRET: 'primary-secret-xyz' });
    const { req, res, next, calls } = makeReqRes('');
    mw.use(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(calls.status).toBe(403);
  });

  it('rejects a near-miss without leaking timing (length-different)', () => {
    const mw = makeMiddleware({ EDGE_SHARED_SECRET: 'primary-secret-xyz' });
    const { req, res, next, calls } = makeReqRes('primary-secret-xy'); // one char shorter
    mw.use(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(calls.status).toBe(403);
  });
});

describe('EdgeAuthMiddleware — viewer address', () => {
  const VIEWER = '203.0.113.9';
  // printf '%s' 'viewer-address-v1' | openssl dgst -sha256 -hmac 'edge-secret-test-vector'
  const PROOF = '9aec177ceb9bc60c5875610065ec2d03679328f6e8d08fdb85b08537a45d6dbc';
  // The same, keyed with 'edge-secret-test-vector-previous'.
  const PREVIOUS_PROOF = 'be68abb2cae84b681d8491e32d55c020f6aa6963a02f198cc5cf553cb36638c2';
  const SECRETS = {
    EDGE_SHARED_SECRET: 'edge-secret-test-vector',
    EDGE_SHARED_SECRET_PREVIOUS: 'edge-secret-test-vector-previous',
  };

  function ownIpReqRes(headers: Record<string, string>) {
    const parts = makeReqRes();
    (parts.req as { ip?: string }).ip = '130.176.0.1';
    Object.assign(parts.req.headers, headers);
    return parts;
  }

  it('takes the header on the primary and the previous secret when the proof derives from either', () => {
    for (const proof of [PROOF, PREVIOUS_PROOF]) {
      const { req, res, next } = ownIpReqRes({
        'x-origin-verify': 'edge-secret-test-vector',
        'x-viewer-address': VIEWER,
        'x-viewer-address-proof': proof,
      });
      makeMiddleware(SECRETS).use(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.ip).toBe(VIEWER);
    }
  });

  it('keeps the gateway address when the proof is absent', () => {
    const { req, res, next } = ownIpReqRes({
      'x-origin-verify': 'edge-secret-test-vector',
      'x-viewer-address': VIEWER,
    });
    makeMiddleware(SECRETS).use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.ip).toBe('130.176.0.1');
  });

  it('takes the header with no secret configured, where there is no proof to check', () => {
    const { req, res, next } = ownIpReqRes({ 'x-viewer-address': VIEWER });
    makeMiddleware({}).use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.ip).toBe(VIEWER);
  });

  it('never honors the header on a rejected request, even behind a correct proof', () => {
    const { req, res, next, calls } = ownIpReqRes({
      'x-origin-verify': 'wrong-secret',
      'x-viewer-address': VIEWER,
      'x-viewer-address-proof': PROOF,
    });
    makeMiddleware(SECRETS).use(req, res, next);
    expect(calls.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.ip).toBe('130.176.0.1');
  });
});

// A deployed instance (STACK set) with no usable secret must refuse rather than pass every request through; the fake above never sets STACK, so each test builds its own.
describe('EdgeAuthMiddleware — deployed-stack fail-closed guard', () => {
  interface DeployedFakeConfig {
    STACK?: string;
    EDGE_SHARED_SECRET?: string;
    EDGE_SHARED_SECRET_PREVIOUS?: string;
  }

  function makeDeployedMiddleware(env: DeployedFakeConfig): EdgeAuthMiddleware {
    const config = {
      get: (key: keyof DeployedFakeConfig) => env[key],
    } as unknown as ConstructorParameters<typeof EdgeAuthMiddleware>[0];
    return new EdgeAuthMiddleware(config);
  }

  it('refuses to construct when STACK is set and no secret is configured', () => {
    expect(() => makeDeployedMiddleware({ STACK: 'dev' })).toThrow(
      /EDGE_SHARED_SECRET/,
    );
  });

  it('constructs normally when STACK is set and the primary secret is configured', () => {
    expect(() =>
      makeDeployedMiddleware({ STACK: 'dev', EDGE_SHARED_SECRET: 'a-real-secret' }),
    ).not.toThrow();
  });

  it('constructs normally when STACK is unset even with no secret (local dev)', () => {
    expect(() => makeDeployedMiddleware({})).not.toThrow();
  });
});
