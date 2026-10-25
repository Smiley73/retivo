import { describe, expect, it } from 'vitest';
import {
  BRIDGE_FILE,
  BRIDGE_MANIFEST_FILE,
  BRIDGE_NOTICES_FILE,
  assertSafeOrigin,
  assertSafePort,
  bridgeCommandFor,
  bridgeInstallCommand,
  type AgentName,
} from './command.js';
import { DEFAULT_BRIDGE_PORT } from './constants.js';

const origin = 'https://app.example.com';
const sha256 = 'a'.repeat(64);

describe('bridgeCommandFor', () => {
  it.each<AgentName>(['claude', 'codex'])('builds a one-line %s command', (agent) => {
    const line = bridgeCommandFor(agent, { origin });
    expect(line).toBe(`${agent} mcp add retivo -- node "$HOME/.retivo/${BRIDGE_FILE}" --origin ${origin}`);
    expect(line).not.toContain('\n');
  });

  it('launches the saved bridge file with node, not a package fetched on every start', () => {
    expect(bridgeCommandFor('claude', { origin })).not.toMatch(/npx|placeholder/);
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

describe('bridgeInstallCommand', () => {
  it('downloads from the origin, verifies the checksum and only then moves the file into place', () => {
    const line = bridgeInstallCommand({ origin, sha256 });
    expect(line).not.toContain('\n');
    const steps = line.split(' && ');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBe('mkdir -p "$HOME/.retivo"');
    expect(steps[1]).toBe(`curl -fsSL ${origin}/${BRIDGE_FILE} -o "$HOME/.retivo/${BRIDGE_FILE}.download"`);
    expect(steps[2]).toBe(`echo "${sha256}  $HOME/.retivo/${BRIDGE_FILE}.download" | shasum -a 256 -c -`);
    expect(steps[3]).toBe(`mv "$HOME/.retivo/${BRIDGE_FILE}.download" "$HOME/.retivo/${BRIDGE_FILE}"`);
  });

  it('saves the file exactly where the launcher runs it from', () => {
    expect(bridgeInstallCommand({ origin, sha256 })).toContain(` "$HOME/.retivo/${BRIDGE_FILE}"`);
    expect(bridgeCommandFor('claude', { origin })).toContain(` node "$HOME/.retivo/${BRIDGE_FILE}" `);
  });

  it('accepts a loopback http origin', () => {
    expect(bridgeInstallCommand({ origin: 'http://localhost:5173', sha256 })).toContain(`http://localhost:5173/${BRIDGE_FILE}`);
  });

  it.each(['https://app.example.com/', 'https://app.example.com;rm', 'http://app.example.com', ''])('refuses the origin %j', (bad) => {
    expect(() => bridgeInstallCommand({ origin: bad, sha256 })).toThrow();
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)};`, `${'a'.repeat(62)}$(`])(
    'refuses the checksum %j',
    (bad) => {
      expect(() => bridgeInstallCommand({ origin, sha256: bad })).toThrow();
    },
  );
});

describe('the served file names', () => {
  it('are plain file names next to each other at the origin root', () => {
    for (const name of [BRIDGE_FILE, BRIDGE_NOTICES_FILE, BRIDGE_MANIFEST_FILE]) expect(name).toMatch(/^[a-z0-9-]+\.[a-z]+$/);
    expect(new Set([BRIDGE_FILE, BRIDGE_NOTICES_FILE, BRIDGE_MANIFEST_FILE]).size).toBe(3);
  });
});
