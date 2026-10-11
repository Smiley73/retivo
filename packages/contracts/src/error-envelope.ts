import { z } from 'zod';

/**
 * Canonical API error envelope. Every non-2xx response body is
 * `{ error: { code, message, details?, traceId? } }` (AGENTS.md → API
 * conventions). `details` and `traceId` are optional —
 * not every error path carries them, and clients must tolerate their absence.
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    traceId: z.string().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
