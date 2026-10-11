/**
 * Single-version-step guard shared by the ordinary key-envelope PUT/DELETE
 * paths (`KeyEnvelopeController`) and the change-password commit's
 * re-wrap branch. Extracted so the "no
 * operation may skip versions" invariant has exactly one definition.
 */
import { ConflictException } from '@nestjs/common';

/**
 * Enforce that a proposed envelope-set version advances the client's held
 * version by exactly one. A jump/regression reuses the existing `409
 * STALE_ENVELOPE_VERSION` contract so the current client refetch flow
 * handles it without a new error code.
 */
export function assertSingleVersionStep(expected: number, proposed: number): void {
  if (proposed !== expected + 1) {
    throw new ConflictException({
      code: 'STALE_ENVELOPE_VERSION',
      message: 'Envelope-set version is stale or non-monotonic.',
    });
  }
}
