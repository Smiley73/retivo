import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_LAUNCHER, assertSafeOrigin, assertSafePort, bridgeCommandFor, type AgentName } from './command.js';
import { DEFAULT_BRIDGE_PORT } from './constants.js';

const origin = 'https://app.example.com';

describe('bridgeCommandFor', () => {
  it.each<AgentName>(['claude', 'codex'])('builds a one-line %s command', (agent) => {
    const line = bridgeCommandFor(agent, { origin });
    expect(line).toBe(`${agent} mcp add retivo -- ${DEFAULT_BRIDGE_LAUNCHER} --origin ${origin}`);
    expect(line).not.toContain('\n');
  });

  it('adds --port only for a non-default port', () => {
    expect(bridgeCommandFor('claude', { origin, port: DEFAULT_BRIDGE_PORT })).not.toContain('--port');
    expect(bridgeCommandFor('claude', { origin, port: 30000 })).toMatch(/--port 30000$/);
  });

  it('accepts a loopback http origin', () => {
    expect(bridgeCommandFor('claude', { origin: 'http://localhost:5173' })).toContain('--origin http://localhost:5173');
    expect(bridgeCommandFor('claude', { origin: 'http://127.0.0.1:5173' })).toContain('http://127.0.0.1:5173');
  });

  it.each([
    'https://app.example.com/path',
    'https://app.example.com/',
    'https://app.example.com?x=1',
    'https://user:pw@app.example.com',
    'https://app example.com',
    'https://app.example.com;rm',
    'https://app.example.com$(id)',
    'https://app.example.com`id`',
    'https://app.example.com&x',
    "https://app.example.com'",
    'http://app.example.com',
    'ftp://app.example.com',
    'app.example.com',
    '',
  ])('refuses the origin %j', (bad) => {
    expect(() => bridgeCommandFor('claude', { origin: bad })).toThrow();
  });

  it('refuses a port outside the usable range', () => {
    expect(() => bridgeCommandFor('claude', { origin, port: 80 })).toThrow();
    expect(() => bridgeCommandFor('claude', { origin, port: 70000 })).toThrow();
    expect(() => bridgeCommandFor('claude', { origin, port: 1.5 })).toThrow();
  });
});

describe('assertSafeOrigin and assertSafePort', () => {
  it('accept what the command template accepts', () => {
    expect(() => assertSafeOrigin(origin)).not.toThrow();
    expect(() => assertSafeOrigin('http://127.0.0.1:5173')).not.toThrow();
    expect(() => assertSafePort(DEFAULT_BRIDGE_PORT)).not.toThrow();
  });

  it('refuse what the command template refuses', () => {
    expect(() => assertSafeOrigin('https://app.example.com/')).toThrow();
    expect(() => assertSafeOrigin('http://app.example.com')).toThrow();
    expect(() => assertSafePort(1024)).toThrow();
  });
});
