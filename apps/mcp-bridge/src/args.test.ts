import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT } from '@retirement/assistant-protocol';
import { parseBridgeArgs } from './args.js';

describe('parseBridgeArgs', () => {
  it('reads the origin and defaults the port', () => {
    expect(parseBridgeArgs(['--origin', 'https://app.example.com'])).toEqual({
      ok: true,
      origin: 'https://app.example.com',
      port: DEFAULT_BRIDGE_PORT,
    });
  });

  it('reads an explicit port', () => {
    expect(parseBridgeArgs(['--origin', 'http://localhost:5173', '--port', '30000'])).toEqual({
      ok: true,
      origin: 'http://localhost:5173',
      port: 30000,
    });
  });

  it.each([
    [[]],
    [['--port', '30000']],
    [['--origin', 'https://app.example.com/']],
    [['--origin', 'http://app.example.com']],
    [['--origin', 'https://app.example.com', '--port', '80']],
    [['--origin', 'https://app.example.com', '--port', 'abc']],
    [['--origin', 'https://app.example.com', '--bogus']],
    [['--origin', 'https://app.example.com', 'extra']],
  ])('refuses %j', (argv) => {
    const parsed = parseBridgeArgs(argv);
    expect(parsed.ok).toBe(false);
  });
});
