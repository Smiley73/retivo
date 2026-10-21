import { describe, expect, it } from 'vitest';
import { failureResult, notPairedAwaitingCode, notPairedAwaitingConsent, toolNotSupported } from '@retirement/assistant-protocol';
import { toCallToolResult } from './tool-result.js';

describe('toCallToolResult', () => {
  it('returns a success as JSON text and structured content', () => {
    const result = { ok: true as const, payload: { a: 1 }, disclosure: { rounding: 'whole dollars' } };
    const mapped = toCallToolResult(result);
    expect(mapped.isError).toBeUndefined();
    expect(JSON.parse((mapped.content[0] as { text: string }).text)).toEqual(result);
    expect(mapped.structuredContent).toEqual(result);
  });

  it('returns NOT_PAIRED with a code as a normal result that names the code and the Settings card', () => {
    const result = notPairedAwaitingCode({ origin: 'https://app.example.com', pairingCode: 'ABCDE-FGHJK', expiresAt: '2026-01-01T00:05:00.000Z' });
    const mapped = toCallToolResult(result);
    expect(mapped.isError).toBeUndefined();
    const text = (mapped.content[0] as { text: string }).text;
    expect(text).toContain('ABCDE-FGHJK');
    expect(text).toContain('Settings');
    expect(text).toContain('AI assistants');
    expect(mapped.structuredContent).toEqual(result);
  });

  it('returns NOT_PAIRED while awaiting consent without any code', () => {
    const mapped = toCallToolResult(notPairedAwaitingConsent());
    expect(mapped.isError).toBeUndefined();
    expect((mapped.content[0] as { text: string }).text).toContain('approve');
  });

  it('marks every other failure isError with the code and message untouched', () => {
    const failure = failureResult('WORKSPACE_LOCKED', 'Unlock the workspace in Retivo.');
    const mapped = toCallToolResult(failure);
    expect(mapped.isError).toBe(true);
    expect((mapped.content[0] as { text: string }).text).toBe('WORKSPACE_LOCKED: Unlock the workspace in Retivo.');
    expect(mapped.structuredContent).toEqual(failure);
    const unsupported = toolNotSupported('retivo_explain', 'build-7');
    expect(toCallToolResult(unsupported).isError).toBe(true);
    expect(toCallToolResult(unsupported).structuredContent).toEqual(unsupported);
  });
});
