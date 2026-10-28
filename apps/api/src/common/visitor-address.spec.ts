// The visitor-address derivation: one trailing sourceIp entry is dropped, the last remaining entry wins, and only a request carrying `ip` as an own property is rewritten.
import type { Request } from 'express';
import { visitorAddress, visitorAddressMiddleware } from './visitor-address.js';

const EDGE = '130.176.0.1';

describe('visitorAddress', () => {
  it('drops the trailing gateway-appended edge entry', () => {
    expect(visitorAddress(`spoofed, 203.0.113.9, ${EDGE}`, EDGE)).toBe('203.0.113.9');
  });

  it('takes the last entry when the gateway passes the header through', () => {
    expect(visitorAddress('spoofed, 203.0.113.9', EDGE)).toBe('203.0.113.9');
  });

  it('puts requests that differ only in their planted leftmost entries in one bucket', () => {
    const a = visitorAddress(`1.1.1.1, 203.0.113.9, ${EDGE}`, EDGE);
    const b = visitorAddress(`9.9.9.9, 8.8.8.8, 203.0.113.9, ${EDGE}`, EDGE);
    expect(a).toBe('203.0.113.9');
    expect(b).toBe(a);
  });

  it('loses only one entry when the header ends with the edge address twice', () => {
    expect(visitorAddress(`${EDGE}, ${EDGE}`, EDGE)).toBe(EDGE);
    expect(visitorAddress(`203.0.113.9, ${EDGE}, ${EDGE}`, EDGE)).toBe(EDGE);
  });

  it('keeps sourceIp when there is no usable header', () => {
    expect(visitorAddress(undefined, EDGE)).toBe(EDGE);
    expect(visitorAddress('', EDGE)).toBe(EDGE);
    expect(visitorAddress(' , ', EDGE)).toBe(EDGE);
    expect(visitorAddress(EDGE, EDGE)).toBe(EDGE);
  });
});

describe('visitorAddressMiddleware', () => {
  it('rewrites an own ip property and calls next', () => {
    const req = { ip: EDGE, headers: { 'x-forwarded-for': `203.0.113.9, ${EDGE}` } } as unknown as Request;
    const next = jest.fn();
    visitorAddressMiddleware(req, {} as never, next);
    expect(req.ip).toBe('203.0.113.9');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves a prototype accessor untouched instead of throwing', () => {
    const proto = Object.defineProperty({}, 'ip', { get: () => '198.51.100.7' });
    const req = Object.assign(Object.create(proto) as object, {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    }) as unknown as Request;
    const next = jest.fn();
    visitorAddressMiddleware(req, {} as never, next);
    expect(req.ip).toBe('198.51.100.7');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
