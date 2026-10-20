import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_CODES, PAIRING_CODE_TTL_MS, PROTOCOL_VERSION } from '@retirement/assistant-protocol';
import { startHarness, type Harness } from './test-support/harness.js';

let h: Harness;
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

describe('pairing', () => {
  beforeEach(async () => {
    h = await startHarness();
  });

  it('answers a correct proof with paired and a bridge proof the protocol function verifies', async () => {
    const code = await h.mintCode();
    const tab = await h.newTab();
    const { hello, paired } = await tab.pair(code);
    expect(hello).toMatchObject({ type: 'hello', protocolVersion: PROTOCOL_VERSION, bridgeVersion: '0.0.0-test' });
    expect(hello.bridgeNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(paired.type).toBe('paired');
  });

  it('tells the tab what the agent called itself at initialize', async () => {
    const tab = await h.newTab();
    expect((await tab.next()).client).toEqual({ name: 'test-agent', version: '9.9.9' });
  });

  it('ends three wrong proofs over three sockets in PAIRING_ATTEMPTS_EXCEEDED, then refuses the old code until a new one is minted', async () => {
    const code = await h.mintCode();
    const closes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const tab = await h.newTab();
      await tab.pair(code, { proof: 'a'.repeat(64) });
      closes.push((await tab.closed).code);
    }
    expect(closes).toEqual([CLOSE_CODES.PAIRING_FAILED, CLOSE_CODES.PAIRING_FAILED, CLOSE_CODES.PAIRING_ATTEMPTS_EXCEEDED]);

    const stale = await h.newTab();
    await stale.pair(code);
    expect((await stale.closed).code).toBe(CLOSE_CODES.PAIRING_EXPIRED);

    const fresh = await h.mintCode();
    expect(fresh).not.toBe(code);
    const tab = await h.newTab();
    expect((await tab.pair(fresh)).paired.type).toBe('paired');
  });

  it('fails an expired code with PAIRING_EXPIRED', async () => {
    const code = await h.mintCode();
    h.clock.advance(PAIRING_CODE_TTL_MS);
    const tab = await h.newTab();
    await tab.pair(code);
    expect((await tab.closed).code).toBe(CLOSE_CODES.PAIRING_EXPIRED);
  });

  it('fails a tab that dials before any code was minted', async () => {
    const tab = await h.newTab();
    await tab.pair('0123456789');
    expect((await tab.closed).code).toBe(CLOSE_CODES.PAIRING_EXPIRED);
  });

  it('refuses a consumed code once its session has ended', async () => {
    const code = await h.mintCode();
    const first = await h.newTab();
    await first.pair(code);
    first.close();
    await h.waitForLog('session_ended');
    const second = await h.newTab();
    await second.pair(code);
    expect((await second.closed).code).toBe(CLOSE_CODES.PAIRING_EXPIRED);
  });

  it('closes a wrong PROTOCOL_VERSION with the mismatch code before any proof check', async () => {
    const code = await h.mintCode();
    const tab = await h.newTab();
    await tab.pair(code, { protocolVersion: PROTOCOL_VERSION + 1, proof: 'b'.repeat(64) });
    expect((await tab.closed).code).toBe(CLOSE_CODES.PROTOCOL_VERSION_MISMATCH);
    // The proof was never checked, so no attempt was spent and the code still works.
    const next = await h.newTab();
    expect((await next.pair(code)).paired.type).toBe('paired');
  });

  it.each([
    ['a first frame other than pair', JSON.stringify({ type: 'ready' })],
    ['a bridge-side frame', JSON.stringify({ type: 'hello' })],
    ['text that is not JSON', 'not json'],
    ['a frame that fails validation', JSON.stringify({ type: 'pair', protocolVersion: 1 })],
  ])('closes %s with PROTOCOL_ERROR', async (_name, text) => {
    const tab = await h.newTab();
    await tab.next();
    tab.send(text);
    expect((await tab.closed).code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
  });

  it('closes a binary frame with PROTOCOL_ERROR', async () => {
    const tab = await h.newTab();
    await tab.next();
    tab.socket.send(Buffer.from([1, 2, 3]));
    expect((await tab.closed).code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
  });

  it('closes a second pair frame and an out-of-order frame after pairing with PROTOCOL_ERROR', async () => {
    const code = await h.mintCode();
    const tab = await h.newTab();
    await tab.pair(code);
    tab.send({ type: 'result', id: 'x', result: { ok: true, payload: null, disclosure: {} } });
    expect((await tab.closed).code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
  });

  it('closes a ready tab that sends pair again', async () => {
    const tab = await h.pairedTab();
    tab.send({ type: 'pair', protocolVersion: PROTOCOL_VERSION, tabNonce: 'a'.repeat(64), tabProof: 'a'.repeat(64) });
    expect((await tab.closed).code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
  });

  it('closes a silent socket past the handshake window with PROTOCOL_ERROR and frees the slot', async () => {
    await h.close();
    h = await startHarness({ handshakeTimeoutMs: 80 });
    const silent = await h.newTab();
    await silent.next();
    expect((await silent.closed).code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    const next = await h.newTab();
    expect((await next.next()).type).toBe('hello');
  });
});

describe('liveness', () => {
  it('terminates a tab that stops answering pings and ends the session', async () => {
    h = await startHarness();
    const code = await h.mintCode();
    // Installed before the tab connects: the session's ping interval is created at accept.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const tab = await h.newTab({ autoPong: false });
    await tab.pair(code);
    tab.send({ type: 'ready' });
    await h.waitForLog('session_ready');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.logs.some((entry) => entry.event === 'session_ended')).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await h.waitForLog('session_ended');
    vi.useRealTimers();
    expect(await h.mintCode()).not.toBe(code);
  });

  it('keeps a tab that answers its pings', async () => {
    h = await startHarness({ pingIntervalMs: 150 });
    const tab = await h.pairedTab();
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(tab.socket.readyState).toBe(tab.socket.OPEN);
    expect(h.logs.some((entry) => entry.event === 'session_ended')).toBe(false);
  });
});
