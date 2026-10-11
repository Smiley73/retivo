/**
 * Shared builder from a validated `UpsertKeyEnvelopeSlotDto` to the persisted
 * `HouseholdKeyEnvelopeRow`. Extracted from
 * `KeyEnvelopeController` so the atomic change-password commit —
 * which carries the SAME slot shape in its
 * own request body — builds the row with the one definition rather than a
 * second hand-rolled copy.
 */
import type { KeyEnvelopeKdfDto, UpsertKeyEnvelopeSlotDto } from './dto/auth.dto.js';
import type { HouseholdKeyEnvelopeRow, KeyEnvelopeKdf } from '../dynamo/types.js';

/**
 * Copy the validated KDF DTO into a PLAIN persisted-row object, dispatching on
 * `algorithm` so the stored row carries the algorithm's own work-factor fields
 * and nothing else. See the (former) `KeyEnvelopeController.toKdfRow` doc —
 * unchanged behaviour, only the location moved.
 */
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
 * Build the persisted slot row from a validated `UpsertKeyEnvelopeSlotDto`.
 * Binds the row to `householdId` + `slotId` — never the (untrusted) body's
 * own `householdId`/`slotId` fields — so it always lands in the caller's
 * partition at the id the caller (route param or the change-password commit)
 * decided. `credentialRevision`, when supplied, is stamped server-side —
 * NEVER read from the DTO, which carries no
 * such field.
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
