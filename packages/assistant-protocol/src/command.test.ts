import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_LAUNCHER, bridgeCommandFor, type AgentName } from './command.js';
import { DEFAULT_BRIDGE_PORT } from './constants.js';

const origin = 'https://app.example.com';

describe('bridgeCommandFor', () => {
  it.each<AgentName>(['claude', 'codex'])('builds a one-line %s command', (agent) => {
    const line = bridgeCommandFor(agent, { origin });
    expect(line).toBe(`${agent} mcp add retivo -- ${DEFAULT_BRIDGE_LAUNCHER} --origin ${origin}`);
    expect(line).not.toContain('\n');
  });

  it('builds a one-line mcp.json server object for Cursor', () => {
    const line = bridgeCommandFor('cursor', { origin });
    expect(line).not.toContain('\n');
    const [command, ...args] = DEFAULT_BRIDGE_LAUNCHER.split(' ');
    expect(JSON.parse(line)).toEqual({
      mcpServers: { retivo: { command, args: [...args, '--origin', origin] } },
    });
  });

  it('adds --port only for a non-default port', () => {
    expect(bridgeCommandFor('claude', { origin, port: DEFAULT_BRIDGE_PORT })).not.toContain('--port');
    expect(bridgeCommandFor('claude', { origin, port: 30000 })).toMatch(/--port 30000$/);
    expect(JSON.parse(bridgeCommandFor('cursor', { origin, port: 30000 })).mcpServers.retivo.args).toContain('30000');
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
