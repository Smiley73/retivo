import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from './constants.js';
import { decodeFrame, encodeFrame, type BridgeFrame, type TabFrame } from './frames.js';
import { notPairedAwaitingConsent, toolNotSupported } from './result.js';

const nonce = 'ab'.repeat(32);
const proof = 'cd'.repeat(32);

const bridgeFrames: BridgeFrame[] = [
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, bridgeNonce: nonce, bridgeVersion: '0.1.0', client: { name: 'claude-code', version: '2.0' } },
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, bridgeNonce: nonce, bridgeVersion: '0.1.0' },
  { type: 'paired', bridgeProof: proof },
  { type: 'call', id: 'c1', tool: 'retivo_status', args: { scenarioId: 's1' } },
  { type: 'cancel', id: 'c1', reason: 'timeout' },
];
const tabFrames: TabFrame[] = [
  { type: 'pair', protocolVersion: PROTOCOL_VERSION, tabNonce: nonce, tabProof: proof },
  { type: 'ready', keepSignedInWhileActive: true },
  { type: 'progress', id: 'c1', fraction: 0.5, message: 'running' },
  { type: 'result', id: 'c1', result: { ok: true, payload: { a: 1 }, disclosure: {} } },
  { type: 'result', id: 'c2', result: notPairedAwaitingConsent() },
  { type: 'result', id: 'c3', result: toolNotSupported('retivo_status', 'build-1') },
];

function roundTrip(from: 'bridge' | 'tab', frame: BridgeFrame | TabFrame) {
  const encoded = encodeFrame(frame);
  if (!encoded.ok) throw new Error('encode failed');
  return decodeFrame(from, encoded.text);
}

describe('frames', () => {
  it.each(bridgeFrames)('round-trips bridge frame $type', (frame) => {
    expect(roundTrip('bridge', frame)).toEqual({ ok: true, frame });
  });

  it.each(tabFrames)('round-trips tab frame $type', (frame) => {
    expect(roundTrip('tab', frame)).toEqual({ ok: true, frame });
  });

  it('rejects an unknown type, bad JSON and a frame from the wrong direction', () => {
    expect(decodeFrame('bridge', '{"type":"nope"}')).toMatchObject({ ok: false, code: 'PROTOCOL_ERROR' });
    expect(decodeFrame('bridge', 'not json')).toMatchObject({ ok: false, code: 'PROTOCOL_ERROR' });
    expect(roundTrip('tab', bridgeFrames[2]!)).toMatchObject({ ok: false, code: 'PROTOCOL_ERROR' });
    expect(roundTrip('bridge', tabFrames[0]!)).toMatchObject({ ok: false, code: 'PROTOCOL_ERROR' });
  });

  it('does not put frame contents in a failure reason', () => {
    const failure = decodeFrame('tab', JSON.stringify({ type: 'pair', protocolVersion: 'secret-value' }));
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).not.toContain('secret-value');
  });

  it('caps the serialized size in bytes, not string length', () => {
    const atCap = (extra: number): BridgeFrame => ({ type: 'call', id: 'c1', tool: 'retivo_status', args: { v: 'a'.repeat(extra) } });
    const overhead = new TextEncoder().encode(JSON.stringify(atCap(0))).length;
    const fits = atCap(MAX_FRAME_BYTES - overhead);
    expect(encodeFrame(fits).ok).toBe(true);
    expect(encodeFrame(atCap(MAX_FRAME_BYTES - overhead + 1))).toMatchObject({ ok: false, code: 'FRAME_TOO_LARGE' });

    // Under the cap in string length, over it in bytes.
    const multiByte: BridgeFrame = { type: 'call', id: 'c1', tool: 'retivo_status', args: { v: '€'.repeat(Math.floor(MAX_FRAME_BYTES / 3)) } };
    const text = JSON.stringify(multiByte);
    expect(text.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(encodeFrame(multiByte)).toMatchObject({ ok: false, code: 'FRAME_TOO_LARGE' });
    expect(decodeFrame('bridge', text)).toMatchObject({ ok: false, code: 'FRAME_TOO_LARGE' });
  });

  it('strips unknown keys instead of rejecting them', () => {
    const decoded = decodeFrame('bridge', JSON.stringify({ ...bridgeFrames[2], addedLater: true }));
    expect(decoded).toEqual({ ok: true, frame: bridgeFrames[2] });
  });

  it('defaults keepSignedInWhileActive to false when absent', () => {
    expect(decodeFrame('tab', JSON.stringify({ type: 'ready' }))).toEqual({ ok: true, frame: { type: 'ready', keepSignedInWhileActive: false } });
  });

  it('versions the protocol with an integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(decodeFrame('bridge', JSON.stringify({ ...bridgeFrames[0], protocolVersion: 1.5 })).ok).toBe(false);
  });
});
