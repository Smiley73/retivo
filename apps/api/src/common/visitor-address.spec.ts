// The viewer-address rule: the proof derivation matches the edge's, the header replaces `ip` only behind an accepted proof and only as a bare address, and only an own `ip` property is written.
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { settleViewerAddress, viewerAddressProof } from './visitor-address.js';

const GATEWAY = '130.176.0.1';
const VIEWER = '203.0.113.9';
// Produced outside this code: printf '%s' 'viewer-address-v1' | openssl dgst -sha256 -hmac '<secret>'
const PROOF = '9aec177ceb9bc60c5875610065ec2d03679328f6e8d08fdb85b08537a45d6dbc';
const PREVIOUS_PROOF = 'be68abb2cae84b681d8491e32d55c020f6aa6963a02f198cc5cf553cb36638c2';
const ACCEPTED = [Buffer.from(PROOF), Buffer.from(PREVIOUS_PROOF)];

function ownIpRequest(headers: Record<string, string>): Request {
  return { ip: GATEWAY, headers } as unknown as Request;
}

describe('viewerAddressProof', () => {
  it('derives the HMAC-SHA256 the edge computes, for the current and the previous secret', () => {
    expect(viewerAddressProof('edge-secret-test-vector')).toBe(PROOF);
    expect(viewerAddressProof('edge-secret-test-vector-previous')).toBe(PREVIOUS_PROOF);
  });
});

describe('settleViewerAddress', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it.each([
    ['IPv4', VIEWER],
    ['IPv6', '2001:db8:abcd:12::9'],
  ])('takes a bare %s address behind an accepted proof, whichever secret derived it', (_, address) => {
    for (const proof of [PROOF, PREVIOUS_PROOF]) {
      const req = ownIpRequest({ 'x-viewer-address': address, 'x-viewer-address-proof': proof });
      settleViewerAddress(req, ACCEPTED);
      expect(req.ip).toBe(address);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the gateway address without warning when the proof is missing or wrong', () => {
    const cases: Array<Record<string, string>> = [
      { 'x-viewer-address': VIEWER },
      { 'x-viewer-address': VIEWER, 'x-viewer-address-proof': 'f'.repeat(64) },
      { 'x-viewer-address': VIEWER, 'x-viewer-address-proof': PROOF.slice(1) },
    ];
    for (const headers of cases) {
      const req = ownIpRequest(headers);
      settleViewerAddress(req, ACCEPTED);
      expect(req.ip).toBe(GATEWAY);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['carrying a port', '203.0.113.9:443'],
    ['a comma-joined pair', '203.0.113.9, 198.51.100.7'],
    ['empty', ''],
    ['not an address', 'viewer'],
  ])('keeps the gateway address and warns once behind an accepted proof when the header is %s', (_, value) => {
    const req = ownIpRequest({
      'x-viewer-address-proof': PROOF,
      ...(value === undefined ? {} : { 'x-viewer-address': value }),
    });
    settleViewerAddress(req, ACCEPTED);
    expect(req.ip).toBe(GATEWAY);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('takes the header without a proof, and without warning, when no proof is configured', () => {
    const req = ownIpRequest({ 'x-viewer-address': VIEWER });
    settleViewerAddress(req, []);
    expect(req.ip).toBe(VIEWER);

    const unusable = ownIpRequest({ 'x-viewer-address': '203.0.113.9:443' });
    settleViewerAddress(unusable, []);
    expect(unusable.ip).toBe(GATEWAY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a prototype accessor untouched instead of throwing', () => {
    const proto = Object.defineProperty({}, 'ip', { get: () => '198.51.100.7' });
    const req = Object.assign(Object.create(proto) as object, {
      headers: { 'x-viewer-address': VIEWER },
    }) as unknown as Request;
    expect(() => settleViewerAddress(req, [])).not.toThrow();
    expect(req.ip).toBe('198.51.100.7');
  });
});
