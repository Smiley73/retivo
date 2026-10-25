// Shared builder from a validated `UpsertKeyEnvelopeSlotDto` to the persisted `HouseholdKeyEnvelopeRow`, used by the controller and the
// change-password commit alike.
import type { KeyEnvelopeKdfDto, UpsertKeyEnvelopeSlotDto } from './dto/auth.dto.js';
import type { HouseholdKeyEnvelopeRow, KeyEnvelopeKdf } from '../dynamo/types.js';

// Copies the validated KDF DTO into a plain row object, dispatching on `algorithm` so the row carries only that
// algorithm work-factor fields.
function toKdfRow(kdf: KeyEnvelopeKdfDto): KeyEnvelopeKdf {
  if (kdf.algorithm === 'Argon2id') {
    return {
      algorithm: 'Argon2id',
      ...(kdf.m === undefined ? {} : { m: kdf.m }),
      ...(kdf.t === undefined ? {} : { t: kdf.t }),
      ...(kdf.p === undefined ? {} : { p: kdf.p }),
      salt: kdf.salt,
    } as KeyEnvelopeKdf;
  }
  return {
    algorithm: kdf.algorithm,
    ...(kdf.iterations === undefined ? {} : { iterations: kdf.iterations }),
    salt: kdf.salt,
  } as KeyEnvelopeKdf;
}

/**
 * Builds the slot row bound to the given `householdId` and `slotId`, never the untrusted body fields, so it lands in
 * the caller partition at the id the caller decided. `credentialRevision` is stamped server-side and never read from
 * the DTO.
 */
export function buildKeyEnvelopeSlotRow(
  householdId: string,
  slotId: string,
  slot: UpsertKeyEnvelopeSlotDto,
  credentialRevision?: string,
): HouseholdKeyEnvelopeRow {
  return {
    householdId,
    slotId,
    slotType: slot.slotType,
    ...(slot.kdf === undefined ? {} : { kdf: toKdfRow(slot.kdf) }),
    ...(slot.prfSalt === undefined ? {} : { prfSalt: slot.prfSalt }),
    ...(slot.credentialBinding === undefined
      ? {}
      : { credentialBinding: slot.credentialBinding }),
    wrappedKey: slot.wrappedKey,
    encryptionVersion: slot.encryptionVersion,
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
    ...(slot.rotatedAt === undefined ? {} : { rotatedAt: slot.rotatedAt }),
    ...(credentialRevision === undefined ? {} : { credentialRevision }),
  };
}
