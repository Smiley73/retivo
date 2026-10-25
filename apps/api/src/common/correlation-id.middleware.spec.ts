// CorrelationIdMiddleware is the one place the external x-correlation-id enters, so it must reject anything outside the canonical UUID shape or log-forging payloads would flow into Pino and the response.
import { CorrelationIdMiddleware } from './correlation-id.middleware.js';
import type { Request, Response } from 'express';

function makeReqRes(incoming?: string): {
  req: Request;
  res: Response;
  setHeader: jest.Mock;
} {
  const req = { headers: { 'x-correlation-id': incoming } } as unknown as Request;
  const setHeader = jest.fn();
  const res = { setHeader } as unknown as Response;
  return { req, res, setHeader };
}

describe('CorrelationIdMiddleware', () => {
  const sut = new CorrelationIdMiddleware();

  it('passes a valid UUID through unchanged', () => {
    const valid = '550e8400-e29b-41d4-a716-446655440000';
    const { req, res, setHeader } = makeReqRes(valid);
    const next = jest.fn();
    sut.use(req, res, next);
    expect(req.headers['x-correlation-id']).toBe(valid);
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', valid);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('replaces non-UUID input with a fresh UUID', () => {
    const malicious = '"; injected json {';
    const { req, res, setHeader } = makeReqRes(malicious);
    sut.use(req, res, jest.fn());
    const written = req.headers['x-correlation-id'] as string;
    expect(written).not.toBe(malicious);
    expect(written).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', written);
  });

  it('generates a UUID when no header is present', () => {
    const { req, res } = makeReqRes(undefined);
    sut.use(req, res, jest.fn());
    expect(req.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects an empty string and substitutes a fresh UUID', () => {
    const { req, res } = makeReqRes('');
    sut.use(req, res, jest.fn());
    expect(req.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
