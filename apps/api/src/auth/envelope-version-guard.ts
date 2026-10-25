// Single-version-step guard shared by the key-envelope PUT and DELETE paths and the change-password re-wrap, so "no operation may skip
// versions" has one definition.
import { ConflictException } from '@nestjs/common';

/**
 * Enforces that a proposed envelope-set version advances the held version by exactly one; a jump or regression reuses
 * 409 STALE_ENVELOPE_VERSION so the client refetch flow handles it.
 */
export function assertSingleVersionStep(expected: number, proposed: number): void {
  if (proposed !== expected + 1) {
    throw new ConflictException({
      code: 'STALE_ENVELOPE_VERSION',
      message: 'Envelope-set version is stale or non-monotonic.',
    });
  }
}
