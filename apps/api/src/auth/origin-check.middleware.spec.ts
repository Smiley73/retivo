// OriginCheckMiddleware multi-origin allowlist (the parsed WEB_ALLOWED_ORIGINS): an allowed web origin (localhost or a LAN address) passes on state-changing requests, a disallowed origin is 403 ORIGIN_MISMATCH, and safe methods bypass.
import type { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { OriginCheckMiddleware } from './origin-check.middleware.js';
import type { EnvConfig } from '../common/env.config.js';

const LOCALHOST_ORIGIN = 'http://localhost:5173';
const LAN_ORIGIN = 'http://192.168.1.42:5173';

function buildMiddleware(allowedOrigins: readonly string[]) {
  const config = {
    get: (key: keyof EnvConfig) => {
      if (key === 'WEB_ALLOWED_ORIGINS_PARSED') return allowedOrigins;
      throw new Error(`unexpected config key ${String(key)}`);
    },
  } as unknown as ConfigService<EnvConfig, true>;
  return new OriginCheckMiddleware(config);
}

function fakeReq(opts: {
  method?: string;
  origin?: string;
  referer?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.referer !== undefined) headers.referer = opts.referer;
  return { method: opts.method ?? 'POST', headers } as unknown as Request;
}

function fakeRes(): { res: Response; statusCode?: number; body?: unknown } {
  const captured: { res: Response; statusCode?: number; body?: unknown } =
    {} as never;
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    },
  } as unknown as Response;
  captured.res = res;
  return captured;
}

describe('OriginCheckMiddleware', () => {
  it('passes a state-changing request from the localhost origin', () => {
    const mw = buildMiddleware([LOCALHOST_ORIGIN, LAN_ORIGIN]);
    const next = jest.fn() as NextFunction;
    const out = fakeRes();
    mw.use(fakeReq({ origin: LOCALHOST_ORIGIN }), out.res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBeUndefined();
  });

  it('passes a state-changing request from a LAN origin', () => {
    const mw = buildMiddleware([LOCALHOST_ORIGIN, LAN_ORIGIN]);
    const next = jest.fn() as NextFunction;
    const out = fakeRes();
    mw.use(fakeReq({ origin: LAN_ORIGIN }), out.res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBeUndefined();
  });

  it('accepts a Referer that sits under an allowed origin', () => {
    const mw = buildMiddleware([LOCALHOST_ORIGIN, LAN_ORIGIN]);
    const next = jest.fn() as NextFunction;
    const out = fakeRes();
    mw.use(
      fakeReq({ referer: `${LAN_ORIGIN}/accounts` }),
      out.res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a disallowed origin with 403 ORIGIN_MISMATCH', () => {
    const mw = buildMiddleware([LOCALHOST_ORIGIN, LAN_ORIGIN]);
    const next = jest.fn() as NextFunction;
    const out = fakeRes();
    mw.use(fakeReq({ origin: 'http://192.168.1.99:5173' }), out.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(403);
    expect((out.body as { error: { code: string } }).error.code).toBe(
      'ORIGIN_MISMATCH',
    );
  });

  it('rejects a hostile Origin even when the Referer is allowed', () => {
    const mw = buildMiddleware([LOCALHOST_ORIGIN, LAN_ORIGIN]);
    const next = jest.fn() as NextFunction;
    const out = fakeRes();
    mw.use(
      fakeReq({
        origin: 'http://evil.example.com',
        referer: `${LOCALHOST_ORIGIN}/accounts`,
      }),
      out.res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(403);
    expect((out.body as { error: { code: string } }).error.code).toBe(
      'ORIGIN_MISMATCH',
    );
  });

  it('rejects a request with no Origin or Referer', () => {
    const mw = buildMiddleware([LOCALHOST_ORIGIN]);
    const next = jest.fn() as NextFunction;
    const out = fakeRes();
    mw.use(fakeReq({}), out.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(403);
  });

  it('bypasses safe methods regardless of origin', () => {
    const mw = buildMiddleware([LOCALHOST_ORIGIN]);
    const next = jest.fn() as NextFunction;
    const out = fakeRes();
    mw.use(
      fakeReq({ method: 'GET', origin: 'http://evil.example.com' }),
      out.res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBeUndefined();
  });
});
