import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  it('writes one JSON line per event with a timestamp', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).log({ event: 'tool_call', tool: 'retivo_status', callId: 'c1', bytes: 42 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\n$/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'tool_call', tool: 'retivo_status', callId: 'c1', bytes: 42 });
    expect(JSON.parse(lines[0]!).time).toEqual(expect.any(String));
  });

  it('truncates the attacker-controlled origin and keeps a newline inside the JSON string', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).log({ event: 'upgrade_rejected', reason: 'origin', origin: `evil\nhost${'x'.repeat(500)}` });
    expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(lines[0]!).origin).toHaveLength(200);
  });

  it('writes to stderr by default', () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      createLogger().log({ event: 'session_started' });
    } finally {
      process.stderr.write = original;
    }
    expect(chunks.join('')).toContain('session_started');
  });
});
