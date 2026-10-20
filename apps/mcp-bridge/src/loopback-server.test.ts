import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOSE_CODES, MAX_FRAME_BYTES, handshakeErrorForCloseCode } from '@retirement/assistant-protocol';
import { startHarness, type Harness } from './test-support/harness.js';
import { TEST_ORIGIN } from './test-support/fake-tab.js';
import { createLogger } from './logger.js';
import { startBridge } from './bridge.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

/** Sends a hand-written upgrade request so a refusal is proved to happen before any WebSocket is accepted. */
function rawUpgrade(port: number, headers: string[]): Promise<{ head: string; received: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
    });
    socket.on('error', reject);
    socket.on('close', () => resolve({ head: received.split('\r\n')[0] ?? '', received }));
    socket.on('connect', () => {
      const lines = [
        'GET / HTTP/1.1',
        ...headers,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      // An accepted upgrade stays open; end it so the promise settles.
      setTimeout(() => socket.destroy(), 300);
    });
  });
}

describe('upgrade gate', () => {
  it('accepts the exact origin and host', async () => {
    const { head } = await rawUpgrade(h.port, [`Host: 127.0.0.1:${h.port}`, `Origin: ${TEST_ORIGIN}`]);
    expect(head).toContain('101');
  });

  const badOrigins: [string, string[]][] = [
    ['a missing Origin', []],
    ['Origin: null', ['Origin: null']],
    ['a foreign origin', ['Origin: https://evil.example.com']],
    ['the right host under the other scheme', ['Origin: http://app.example.com']],
    ['a trailing path', [`Origin: ${TEST_ORIGIN}/`]],
    ['a case variant of the host', ['Origin: https://App.Example.com']],
    ['a case variant of the scheme', ['Origin: HTTPS://app.example.com']],
    ['two Origin headers', [`Origin: ${TEST_ORIGIN}`, 'Origin: https://evil.example.com']],
  ];
  it.each(badOrigins)('refuses %s with a 403 and no hello', async (_name, originHeaders) => {
    const { head, received } = await rawUpgrade(h.port, [`Host: 127.0.0.1:${h.port}`, ...originHeaders]);
    expect(head).toBe('HTTP/1.1 403 Forbidden');
    expect(received).not.toContain('hello');
    expect(received).not.toContain('bridgeNonce');
    expect(h.logs.some((entry) => entry.event === 'session_started')).toBe(false);
    expect(h.logs.some((entry) => entry.event === 'upgrade_rejected')).toBe(true);
  });

  const badHosts: [string, (port: number) => string][] = [
    ['localhost with the right port', (port) => `localhost:${port}`],
    ['a rebinding hostname with the right port', (port) => `rebind.example.com:${port}`],
    ['the right IP with another port', (port) => `127.0.0.1:${port + 1}`],
    ['the right IP without a port', () => '127.0.0.1'],
    ['an IPv6 loopback', (port) => `[::1]:${port}`],
  ];
  it.each(badHosts)('refuses Host %s with a 403 and no hello', async (_name, host) => {
    const { head, received } = await rawUpgrade(h.port, [`Host: ${host(h.port)}`, `Origin: ${TEST_ORIGIN}`]);
    expect(head).toBe('HTTP/1.1 403 Forbidden');
    expect(received).not.toContain('hello');
    expect(h.logs.some((entry) => entry.event === 'session_started')).toBe(false);
  });

  it('refuses the same cases through a real WebSocket client', async () => {
    await expect(h.newTab({ origin: null })).rejects.toThrow('403');
    await expect(h.newTab({ origin: 'https://evil.example.com' })).rejects.toThrow('403');
    await expect(h.newTab({ headers: { Host: `localhost:${h.port}` } })).rejects.toThrow('403');
  });

  it('answers a plain HTTP request without upgrading', async () => {
    const response = await fetch(`http://127.0.0.1:${h.port}/`);
    expect(response.status).toBe(426);
  });
});

describe('binding', () => {
  it('binds 127.0.0.1 explicitly, never a wildcard address', () => {
    expect(h.bridge.host).toBe('127.0.0.1');
  });

  it('rejects a second bridge on the same port and the first keeps serving', async () => {
    await expect(
      startBridge({ origin: TEST_ORIGIN, port: h.port, bridgeVersion: '0', logger: createLogger(() => undefined) }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const tab = await h.newTab();
    expect((await tab.next()).type).toBe('hello');
  });

  it('refuses an unsafe origin or port before binding', async () => {
    const logger = createLogger(() => undefined);
    await expect(startBridge({ origin: 'http://evil.example.com', port: 0, bridgeVersion: '0', logger })).rejects.toThrow();
    await expect(startBridge({ origin: TEST_ORIGIN, port: 80, bridgeVersion: '0', logger })).rejects.toThrow();
  });
});

describe('the single tab slot', () => {
  it('closes a second socket with ALREADY_CONNECTED, sends it no hello and leaves the first session alone', async () => {
    const first = await h.newTab();
    expect((await first.next()).type).toBe('hello');
    const second = await h.newTab();
    expect(await second.closed).toMatchObject({ code: CLOSE_CODES.ALREADY_CONNECTED });
    expect(second.received).toBe(0);
    expect(first.socket.readyState).toBe(first.socket.OPEN);
  });

  it('frees the slot as soon as the first session ends', async () => {
    const first = await h.newTab();
    await first.next();
    first.close();
    await h.waitForLog('session_ended');
    const next = await h.newTab();
    expect((await next.next()).type).toBe('hello');
  });
});

describe('frame cap', () => {
  it('closes a frame one byte over MAX_FRAME_BYTES with the code that maps to FRAME_TOO_LARGE, then ends the session', async () => {
    const tab = await h.newTab();
    await tab.next();
    tab.send('x'.repeat(MAX_FRAME_BYTES + 1));
    const { code } = await tab.closed;
    expect(handshakeErrorForCloseCode(code)).toBe('FRAME_TOO_LARGE');
    await h.waitForLog('session_ended');
  });
});
