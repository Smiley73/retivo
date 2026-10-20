/** The result envelope every tool returns, plus the structured `NOT_PAIRED` and `TOOL_NOT_SUPPORTED` errors. */
import { z } from 'zod';
import { errorCodeSchema, type ErrorCode } from './codes.js';
import { PAIRING_ENTRY_PATH } from './constants.js';

/** Assumptions, rounding and not-financial-advice framing a result relied on; the tool rows fill it. */
export const disclosureSchema = z.object({
  assumptions: z.array(z.string()).optional(),
  rounding: z.string().optional(),
  framing: z.string().optional(),
});

const genericErrorSchema = z.object({
  code: errorCodeSchema.exclude(['NOT_PAIRED', 'TOOL_NOT_SUPPORTED']),
  message: z.string(),
});

// The error's own `code` is the error code, so the pairing code travels as
// `pairingCode`. It exists only while awaiting the code: once the code has been
// typed it is single use, and a schema that allowed it afterwards could leak it.
const awaitingCodeSchema = z.object({
  code: z.literal('NOT_PAIRED'),
  message: z.string(),
  state: z.literal('awaiting-code'),
  pairingCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/),
  expiresAt: z.iso.datetime(),
  enterAt: z.url(),
  instructions: z.string(),
});

const awaitingConsentSchema = z.object({
  code: z.literal('NOT_PAIRED'),
  message: z.string(),
  state: z.literal('awaiting-consent'),
  instructions: z.string(),
});

const toolNotSupportedSchema = z.object({
  code: z.literal('TOOL_NOT_SUPPORTED'),
  message: z.string(),
  tool: z.string(),
  appBuildId: z.string(),
});

export const toolErrorSchema = z.union([
  awaitingCodeSchema,
  awaitingConsentSchema,
  toolNotSupportedSchema,
  genericErrorSchema,
]);
export type ToolError = z.infer<typeof toolErrorSchema>;

/** `{ ok: true, payload, disclosure }` or `{ ok: false, error }`; `payload` is narrowed per tool. */
export const toolResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), payload: z.unknown(), disclosure: disclosureSchema }),
  z.object({ ok: z.literal(false), error: toolErrorSchema }),
]);
export type ToolResult = z.infer<typeof toolResultSchema>;

/** A failed result for any code other than the two with extra fields. */
export function failureResult(code: Exclude<ErrorCode, 'NOT_PAIRED' | 'TOOL_NOT_SUPPORTED'>, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

/** What the person is told to do, built from the same parts the result carries so the two cannot disagree. */
export function notPairedInstructions(parts: { pairingCode?: string; enterAt?: string }): string {
  if (parts.pairingCode === undefined || parts.enterAt === undefined) {
    return 'Waiting for you to approve the assistant in the Retivo tab. Nothing is shared until you do.';
  }
  return `Open ${parts.enterAt} in the signed-in Retivo tab and enter the code ${parts.pairingCode}. Nothing is shared until you approve it there.`;
}

/** `NOT_PAIRED` while the bridge awaits the code: carries the code, its expiry and where to type it. */
export function notPairedAwaitingCode(args: { origin: string; pairingCode: string; expiresAt: string }): ToolResult {
  const enterAt = new URL(PAIRING_ENTRY_PATH, args.origin).toString();
  const { pairingCode, expiresAt } = args;
  return {
    ok: false,
    error: {
      code: 'NOT_PAIRED',
      message: 'The assistant is not paired with Retivo yet.',
      state: 'awaiting-code',
      pairingCode,
      expiresAt,
      enterAt,
      instructions: notPairedInstructions({ pairingCode, enterAt }),
    },
  };
}

/** `NOT_PAIRED` once the code was accepted and the person has yet to consent: no code at all. */
export function notPairedAwaitingConsent(): ToolResult {
  return {
    ok: false,
    error: {
      code: 'NOT_PAIRED',
      message: 'The assistant is waiting for consent in the Retivo tab.',
      state: 'awaiting-consent',
      instructions: notPairedInstructions({}),
    },
  };
}

/** The tab is older than the bridge and does not implement `tool`. */
export function toolNotSupported(tool: string, appBuildId: string): ToolResult {
  return {
    ok: false,
    error: {
      code: 'TOOL_NOT_SUPPORTED',
      message: `${tool} is not supported by this version of Retivo. Update the app or use another tool.`,
      tool,
      appBuildId,
    },
  };
}
