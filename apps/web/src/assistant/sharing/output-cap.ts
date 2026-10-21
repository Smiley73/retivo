/**
 * The size check tools call before they build an envelope. It counts the UTF-8
 * bytes of the serialized result against the protocol's `MAX_TOOL_RESULT_BYTES`,
 * the same constant and the same unit as the frame cap, so a string of
 * multi-byte characters cannot pass on its `length`. The dispatcher enforces the
 * cap again on the wire; this is the earlier, typed refusal.
 */
import { MAX_TOOL_RESULT_BYTES } from '@retirement/assistant-protocol';

export type OutputSizeCheck =
  | { ok: true; bytes: number }
  | { ok: false; code: 'OUTPUT_TOO_LARGE'; bytes: number; maxBytes: number };

const utf8 = new TextEncoder();

/** Checks an already-serialized result. */
export function checkSerializedSize(serialized: string): OutputSizeCheck {
  const bytes = utf8.encode(serialized).length;
  if (bytes > MAX_TOOL_RESULT_BYTES) return { ok: false, code: 'OUTPUT_TOO_LARGE', bytes, maxBytes: MAX_TOOL_RESULT_BYTES };
  return { ok: true, bytes };
}

/** Serializes `result` and checks it; never throws on size. */
export function checkOutputSize(result: unknown): OutputSizeCheck {
  return checkSerializedSize(JSON.stringify(result));
}
