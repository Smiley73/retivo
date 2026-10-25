/**
 * Versioned frames between the loopback bridge and the signed-in tab, with the
 * byte-capped encode/decode helpers both ends use.
 *
 * Legal order: bridge `hello`, tab `pair`, bridge `paired`, tab `ready`, then
 * `call` / `cancel` (bridge) and `progress` / `result` (tab). Anything else is
 * `PROTOCOL_ERROR`; the state machines live with the bridge and the tab.
 *
 * The bridge is usually older than the tab, so these use the default
 * `z.object` (unknown keys stripped), never `strictObject`. Additions inside one
 * protocol version are optional fields. A frame that fails to parse is a protocol
 * violation and closes the socket.
 */
import { z } from 'zod';
import { MAX_FRAME_BYTES, NONCE_BYTES } from './constants.js';
import { toolResultSchema } from './result.js';

const hexField = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
const nonceSchema = hexField(NONCE_BYTES);
const proofSchema = hexField(32);
const callIdSchema = z.string().min(1).max(64);
const protocolVersionSchema = z.number().int();

const helloFrameSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: protocolVersionSchema,
  bridgeNonce: nonceSchema,
  bridgeVersion: z.string().max(64),
  /** Learned at MCP `initialize` and untrusted: display and log only. */
  client: z.object({ name: z.string().max(128), version: z.string().max(64) }).optional(),
});
const pairedFrameSchema = z.object({ type: z.literal('paired'), bridgeProof: proofSchema });
const callFrameSchema = z.object({
  type: z.literal('call'),
  id: callIdSchema,
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
});
const cancelFrameSchema = z.object({
  type: z.literal('cancel'),
  id: callIdSchema,
  reason: z.enum(['client', 'timeout']),
});

const pairFrameSchema = z.object({
  type: z.literal('pair'),
  protocolVersion: protocolVersionSchema,
  tabNonce: nonceSchema,
  tabProof: proofSchema,
});
const readyFrameSchema = z.object({
  type: z.literal('ready'),
  /** Absent from an old tab, which never extends anything. */
  keepSignedInWhileActive: z.boolean().default(false),
});
const progressFrameSchema = z.object({
  type: z.literal('progress'),
  id: callIdSchema,
  fraction: z.number().min(0).max(1).optional(),
  message: z.string().max(200).optional(),
});
const resultFrameSchema = z.object({
  type: z.literal('result'),
  id: callIdSchema,
  result: toolResultSchema,
});

const bridgeFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  pairedFrameSchema,
  callFrameSchema,
  cancelFrameSchema,
]);
const tabFrameSchema = z.discriminatedUnion('type', [
  pairFrameSchema,
  readyFrameSchema,
  progressFrameSchema,
  resultFrameSchema,
]);
export type BridgeFrame = z.infer<typeof bridgeFrameSchema>;
export type TabFrame = z.infer<typeof tabFrameSchema>;

/** Who sent a frame; `decodeFrame` accepts only that side's frames. */
type FrameSender = 'bridge' | 'tab';
type FrameBySender = { bridge: BridgeFrame; tab: TabFrame };
const SCHEMA_BY_SENDER = { bridge: bridgeFrameSchema, tab: tabFrameSchema } as const;

/** Why a frame was refused; the caller closes the socket with `CLOSE_CODES[code]`. */
interface FrameFailure {
  ok: false;
  code: 'FRAME_TOO_LARGE' | 'PROTOCOL_ERROR';
  /** Fixed wording plus a field path, never frame contents, so it is safe to log. */
  reason: string;
}

const utf8 = new TextEncoder();

/** Serializes a frame, refusing one over `MAX_FRAME_BYTES` UTF-8 bytes. */
export function encodeFrame(frame: BridgeFrame | TabFrame): { ok: true; text: string } | FrameFailure {
  const text = JSON.stringify(frame);
  if (utf8.encode(text).length > MAX_FRAME_BYTES) {
    return { ok: false, code: 'FRAME_TOO_LARGE', reason: 'frame exceeds the size cap' };
  }
  return { ok: true, text };
}

/** Parses text received from `from`, refusing oversize, malformed, unknown and wrong-direction frames. */
export function decodeFrame<S extends FrameSender>(
  from: S,
  text: string,
): { ok: true; frame: FrameBySender[S] } | FrameFailure {
  if (utf8.encode(text).length > MAX_FRAME_BYTES) {
    return { ok: false, code: 'FRAME_TOO_LARGE', reason: 'frame exceeds the size cap' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'PROTOCOL_ERROR', reason: 'frame is not valid JSON' };
  }
  const parsed = SCHEMA_BY_SENDER[from].safeParse(json);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.') ?? '';
    return { ok: false, code: 'PROTOCOL_ERROR', reason: `frame failed validation at "${path}"` };
  }
  // The schema is chosen by `from`, so its output is that sender's frame type.
  return { ok: true, frame: parsed.data as FrameBySender[S] };
}
