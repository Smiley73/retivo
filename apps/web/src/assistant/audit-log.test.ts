import { describe, expect, it } from 'vitest';
import { MAX_TOOL_RESULT_BYTES } from '@retirement/assistant-protocol';
import { AuditLog, summarizeArgs, type AuditInput } from './audit-log';

const AUDIT_MAX_ENTRIES = 200;
const AUDIT_MAX_PAYLOAD_BYTES = MAX_TOOL_RESULT_BYTES;
const AUDIT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const AUDIT_MAX_ARGS_CHARS = 2_000;

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
  it('keeps the exact payload up to the largest sendable result and only the size over it', () => {
    const log = new AuditLog();
    log.record(input({ payload: '{"a":1}' }));
    log.record(input({ payload: 'x'.repeat(70_000) }));
    log.record(input({ payload: 'x'.repeat(AUDIT_MAX_PAYLOAD_BYTES) }));
    log.record(input({ payload: 'x'.repeat(AUDIT_MAX_PAYLOAD_BYTES + 1) }));
    const [small, mid, atCap, over] = log.entries();
    expect(small).toMatchObject({ payload: '{"a":1}', payloadTruncated: false });
    expect(mid).toMatchObject({ payload: 'x'.repeat(70_000), payloadTruncated: false });
    expect(atCap).toMatchObject({ payloadTruncated: false });
    expect(over).toMatchObject({ payload: null, payloadTruncated: true });
  });

  it('evicts whole older entries once the retained bytes pass the budget, counting them as dropped', () => {
    const log = new AuditLog();
    const body = 'x'.repeat(AUDIT_MAX_PAYLOAD_BYTES);
    const fitting = Math.floor(AUDIT_MAX_TOTAL_BYTES / AUDIT_MAX_PAYLOAD_BYTES);
    for (let i = 0; i < fitting + 3; i += 1) log.record(input({ at: i, payload: body }));
    const entries = log.entries();
    expect(entries).toHaveLength(fitting);
    expect(entries[0]!.at).toBe(3);
    expect(entries.every((entry) => entry.payload === body)).toBe(true);
    expect(log.dropped()).toBe(3);
    log.clear();
    log.record(input({ payload: body }));
    expect(log.dropped()).toBe(0);
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
