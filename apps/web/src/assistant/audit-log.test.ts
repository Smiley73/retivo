import { describe, expect, it } from 'vitest';
import { AUDIT_MAX_ARGS_CHARS, AUDIT_MAX_ENTRIES, AUDIT_MAX_PAYLOAD_BYTES, AuditLog, summarizeArgs, type AuditInput } from './audit-log';

function input(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    at: 1,
    tool: 'retivo_status',
    argsSummary: '',
    argsText: '{}',
    outcome: 'ok',
    durationMs: 3,
    bytes: 2,
    movedIdleClock: false,
    payload: '{}',
    ...overrides,
  };
}

describe('AuditLog', () => {
  it('keeps the exact payload under the per-entry cap and only the size over it', () => {
    const log = new AuditLog();
    log.record(input({ payload: '{"a":1}' }));
    log.record(input({ payload: 'x'.repeat(AUDIT_MAX_PAYLOAD_BYTES + 1) }));
    const [small, large] = log.entries();
    expect(small).toMatchObject({ payload: '{"a":1}', payloadTruncated: false });
    expect(large).toMatchObject({ payload: null, payloadTruncated: true });
  });

  it('measures the cap in bytes, not characters', () => {
    const log = new AuditLog();
    log.record(input({ payload: 'é'.repeat(AUDIT_MAX_PAYLOAD_BYTES / 2 + 1) }));
    expect(log.entries()[0]!.payloadTruncated).toBe(true);
  });

  it('evicts the oldest entries first once full', () => {
    const log = new AuditLog();
    for (let i = 0; i < AUDIT_MAX_ENTRIES + 5; i += 1) log.record(input({ at: i }));
    const entries = log.entries();
    expect(entries).toHaveLength(AUDIT_MAX_ENTRIES);
    expect(entries[0]!.at).toBe(5);
    expect(entries.at(-1)!.at).toBe(AUDIT_MAX_ENTRIES + 4);
  });

  it('counts the entries the bound pushed out, and resets the count on clear', () => {
    const log = new AuditLog();
    for (let i = 0; i < AUDIT_MAX_ENTRIES; i += 1) log.record(input());
    expect(log.dropped()).toBe(0);
    log.record(input());
    log.record(input());
    expect(log.dropped()).toBe(2);
    log.clear();
    expect(log.dropped()).toBe(0);
  });

  it('keeps the arguments text whole under the cap and ends a longer one with an ellipsis', () => {
    const log = new AuditLog();
    log.record(input({ argsText: '{"a":1.0}' }));
    log.record(input({ argsText: 'x'.repeat(AUDIT_MAX_ARGS_CHARS + 50) }));
    const [short, long] = log.entries();
    expect(short!.argsText).toBe('{"a":1.0}');
    expect(Array.from(long!.argsText)).toHaveLength(AUDIT_MAX_ARGS_CHARS);
    expect(long!.argsText.endsWith('…')).toBe(true);
  });

  it('hands out a new array per change and clears', () => {
    const log = new AuditLog();
    const before = log.entries();
    log.record(input());
    expect(log.entries()).not.toBe(before);
    log.clear();
    expect(log.entries()).toEqual([]);
    const empty = log.entries();
    log.clear();
    expect(log.entries()).toBe(empty);
  });
});

describe('summarizeArgs', () => {
  it('names scalars briefly and counts nested content instead of copying it', () => {
    expect(summarizeArgs({ scenarioId: 'abc', n: 2, flag: false, list: [1, 2, 3], nested: { secret: 'x' } })).toBe(
      'scenarioId=abc, n=2, flag=false, list=[3], nested={…}',
    );
  });

  it('bounds both a value and the whole summary', () => {
    expect(summarizeArgs({ a: 'y'.repeat(100) })).toBe(`a=${'y'.repeat(40)}`);
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, 'v'.repeat(30)]));
    expect(summarizeArgs(wide).length).toBeLessThanOrEqual(200);
  });
});
