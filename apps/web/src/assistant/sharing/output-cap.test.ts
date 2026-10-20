import { describe, expect, it } from 'vitest';
import { MAX_TOOL_RESULT_BYTES } from '@retirement/assistant-protocol';
import { checkOutputSize, checkSerializedSize } from './output-cap';

describe('output size cap', () => {
  it('accepts a result exactly at the cap', () => {
    // JSON.stringify adds two quote characters around a string.
    const atCap = 'a'.repeat(MAX_TOOL_RESULT_BYTES - 2);
    expect(checkOutputSize(atCap)).toEqual({ ok: true, bytes: MAX_TOOL_RESULT_BYTES });
  });

  it('refuses a result one byte over, with a typed failure rather than a throw', () => {
    const overCap = 'a'.repeat(MAX_TOOL_RESULT_BYTES - 1);
    expect(checkOutputSize(overCap)).toEqual({
      ok: false,
      code: 'OUTPUT_TOO_LARGE',
      bytes: MAX_TOOL_RESULT_BYTES + 1,
      maxBytes: MAX_TOOL_RESULT_BYTES,
    });
  });

  it('counts UTF-8 bytes, not characters', () => {
    // Each euro sign is one UTF-16 unit and three UTF-8 bytes: the length passes the cap, the bytes do not.
    const text = '\u20AC'.repeat(Math.floor(MAX_TOOL_RESULT_BYTES / 3) + 1);
    expect(text.length).toBeLessThan(MAX_TOOL_RESULT_BYTES);
    const check = checkSerializedSize(JSON.stringify(text));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('OUTPUT_TOO_LARGE');
  });
});
