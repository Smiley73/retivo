// EdgeAuthMiddleware: no-op pass-through with both secrets unset (local dev, tests), the primary or previous (rotation overlap) secret calls next(), and a missing or wrong header is 403 EDGE_AUTH_REQUIRED.
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
