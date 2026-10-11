/**
 * Unit tests for HDK wrapping + envelope-set integrity.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  computeEnvelopeSetTag,
  deriveArgon2idWrapKey,
  derivePasswordWrapKey,
  EnvelopeSetPinAbortedError,
  exportHdk,
  generateArgon2idPasswordSlot,
  generateHdk,
  generatePasskeyPrfSlot,
  generatePasswordSlot,
  generatePbkdf2PasswordSlot,
  generateRecoverySlot,
  isEnvelopeSetRollback,
  isStrictEncryptedEnvelope,
  KeyWrappingError,
  raiseEnvelopeSetPinFloor,
  readEnvelopeSetPin,
  unwrapPrfSlot,
  unwrapSlot,
  validateKdfParams,
  verifyEnvelopeSetTag,
  writeEnvelopeSetPin,
} from './key-wrapping';
import { derivePrfWrapKey } from './passkey-prf';
import { bytesToBase64Url, canonicalJsonBytes } from './payload-crypto';
import {
  dropLocalDatabase,
  readDeviceMetadata,
  updateDeviceMetadata,
  writeDeviceMetadata,
} from '../db/store';
import type {
  Argon2idKdfParams,
  EncryptedPayloadEnvelope,
  KdfParams,
  KeyEnvelopeSlot,
  Pbkdf2KdfParams,
} from './encryption-types';

/** A well-formed encrypted aggregate payload envelope. */
function validEnvelope(overrides: Partial<EncryptedPayloadEnvelope> = {}): EncryptedPayloadEnvelope {
  return {
    encryptionVersion: 1,
    keyId: 'hh-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2U',
    ciphertext: 'Y2lwaGVy',
    ...overrides,
  };
}

async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const [ra, rb] = await Promise.all([exportHdk(a), exportHdk(b)]);
  const va = new Uint8Array(ra);
  const vb = new Uint8Array(rb);
  if (va.length !== vb.length) return false;
  return va.every((byte, i) => byte === vb[i]);
}

describe('key-wrapping — password slot (Argon2id default)', () => {
  it('round-trips the HDK with the correct password', async () => {
    const hdk = await generateHdk();
    const slot = await generatePasswordSlot('hh-1', 'slot-pw', 'correct horse', hdk);
    const recovered = await unwrapSlot(slot, 'correct horse');
    expect(await sameKey(recovered, hdk)).toBe(true);
  });

  it('defaults new password slots to Argon2id with the OWASP 2024 baseline', async () => {
    const hdk = await generateHdk();
    const slot = await generatePasswordSlot('hh-1', 'slot-pw', 'correct horse', hdk);
    expect(slot.kdf?.algorithm).toBe('Argon2id');
    const kdf = slot.kdf as Argon2idKdfParams;
    expect(kdf.m).toBe(65_536);
    expect(kdf.t).toBe(3);
    expect(kdf.p).toBe(4);
    expect(typeof kdf.salt).toBe('string');
    expect(kdf.salt.length).toBeGreaterThan(0);
  });

  it('throws on the wrong password', async () => {
    const hdk = await generateHdk();
    const slot = await generatePasswordSlot('hh-1', 'slot-pw', 'correct horse', hdk);
    await expect(unwrapSlot(slot, 'wrong password')).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws when Argon2id slot kdf metadata is tampered (lowered m → AAD mismatch)', async () => {
    const hdk = await generateHdk();
    const slot = await generateArgon2idPasswordSlot('hh-1', 'slot-pw', 'correct horse', hdk);
    const tampered: KeyEnvelopeSlot = {
      ...slot,
      kdf: { ...(slot.kdf as Argon2idKdfParams), m: 1024 },
    };
    await expect(unwrapSlot(tampered, 'correct horse')).rejects.toBeInstanceOf(KeyWrappingError);
  });
});

describe('key-wrapping — legacy PBKDF2 password slot (backward-compat read path)', () => {
  it('still unwraps a PBKDF2-wrapped slot (no migration needed)', async () => {
    const hdk = await generateHdk();
    const slot = await generatePbkdf2PasswordSlot('hh-1', 'slot-pw', 'correct horse', hdk);
    expect(slot.kdf?.algorithm).toBe('PBKDF2-HMAC-SHA-256');
    const recovered = await unwrapSlot(slot, 'correct horse');
    expect(await sameKey(recovered, hdk)).toBe(true);
  });

  it('throws on the wrong password for a legacy PBKDF2 slot', async () => {
    const hdk = await generateHdk();
    const slot = await generatePbkdf2PasswordSlot('hh-1', 'slot-pw', 'correct horse', hdk);
    await expect(unwrapSlot(slot, 'wrong password')).rejects.toBeInstanceOf(KeyWrappingError);
  });
});

describe('key-wrapping — Argon2id KDF param validation', () => {
  const validKdf: Argon2idKdfParams = {
    algorithm: 'Argon2id',
    m: 65_536,
    t: 3,
    p: 4,
    salt: 'c2FsdHNhbHQ',
  };

  it('accepts in-bounds Argon2id params', () => {
    expect(() => validateKdfParams(validKdf)).not.toThrow();
  });

  it('rejects an out-of-bounds memory cost (m > 65536)', () => {
    expect(() => validateKdfParams({ ...validKdf, m: 65_537 })).toThrow(KeyWrappingError);
  });

  it('rejects an out-of-bounds time cost (t > 10)', () => {
    expect(() => validateKdfParams({ ...validKdf, t: 11 })).toThrow(KeyWrappingError);
  });

  it('rejects an out-of-bounds parallelism (p > 16)', () => {
    expect(() => validateKdfParams({ ...validKdf, p: 17 })).toThrow(KeyWrappingError);
  });

  it('rejects non-positive / non-integer m/t/p', () => {
    expect(() => validateKdfParams({ ...validKdf, m: 0 })).toThrow(KeyWrappingError);
    expect(() => validateKdfParams({ ...validKdf, t: 0 })).toThrow(KeyWrappingError);
    expect(() => validateKdfParams({ ...validKdf, p: 1.5 })).toThrow(KeyWrappingError);
  });

  it('rejects a missing/empty salt', () => {
    expect(() => validateKdfParams({ ...validKdf, salt: '' })).toThrow(KeyWrappingError);
  });

  it('deriveArgon2idWrapKey fails closed on a malformed (non-base64url) salt', async () => {
    await expect(
      deriveArgon2idWrapKey('pw', { ...validKdf, salt: 'not valid base64url !!!' }),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });
});

describe('key-wrapping — legacy PBKDF2 kdf param validation', () => {
  const validKdf: Pbkdf2KdfParams = {
    algorithm: 'PBKDF2-HMAC-SHA-256',
    iterations: 600_000,
    salt: 'c2FsdHNhbHQ',
  };

  it('throws on an out-of-range (excessive) iteration count', async () => {
    const kdf: KdfParams = { ...validKdf, iterations: 2_000_001 };
    await expect(derivePasswordWrapKey('pw', kdf)).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws on a non-positive iteration count', async () => {
    const kdf: KdfParams = { ...validKdf, iterations: 0 };
    await expect(derivePasswordWrapKey('pw', kdf)).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws on a non-integer iteration count', async () => {
    const kdf: KdfParams = { ...validKdf, iterations: 1.5 };
    await expect(derivePasswordWrapKey('pw', kdf)).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws on an unsupported kdf algorithm', async () => {
    const kdf = { ...validKdf, algorithm: 'scrypt' } as unknown as KdfParams;
    await expect(derivePasswordWrapKey('pw', kdf)).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws on a missing/empty salt', async () => {
    const kdf: KdfParams = { ...validKdf, salt: '' };
    await expect(derivePasswordWrapKey('pw', kdf)).rejects.toBeInstanceOf(KeyWrappingError);
  });
});

describe('key-wrapping — recovery slot', () => {
  it('round-trips the HDK with the correct recovery key', async () => {
    const hdk = await generateHdk();
    const { slot, recoveryKey } = await generateRecoverySlot('hh-1', 'slot-rec', hdk);
    const recovered = await unwrapSlot(slot, recoveryKey);
    expect(await sameKey(recovered, hdk)).toBe(true);
  });

  it('throws on the wrong recovery key', async () => {
    const hdk = await generateHdk();
    const { slot } = await generateRecoverySlot('hh-1', 'slot-rec', hdk);
    await expect(unwrapSlot(slot, '0000-0000-0000-0000-0000-0000-0000-0000')).rejects.toBeInstanceOf(
      KeyWrappingError,
    );
  });

  it('never persists the raw recovery key in the slot (display encoding only)', async () => {
    const hdk = await generateHdk();
    const { slot, recoveryKey } = await generateRecoverySlot('hh-1', 'slot-rec', hdk);
    expect(JSON.stringify(slot)).not.toContain(recoveryKey);
    // Display encoding is grouped hex, not raw base64url key bytes.
    expect(recoveryKey).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4})+$/);
  });
});

describe('key-wrapping — envelope-set integrity', () => {
  async function buildSet(): Promise<{
    hdk: CryptoKey;
    slots: KeyEnvelopeSlot[];
  }> {
    const hdk = await generateHdk();
    const pw = await generatePasswordSlot('hh-1', 'slot-a', 'pw', hdk);
    const { slot: rec } = await generateRecoverySlot('hh-1', 'slot-b', hdk);
    return { hdk, slots: [pw, rec] };
  }

  it('verifies on an intact set', async () => {
    const { hdk, slots } = await buildSet();
    const tag = await computeEnvelopeSetTag(slots, 1, hdk);
    await expect(verifyEnvelopeSetTag(slots, { envelopeSetVersion: 1, envelopeSetTag: tag }, hdk))
      .resolves.toBeUndefined();
  });

  it('rejects a stripped slot', async () => {
    const { hdk, slots } = await buildSet();
    const tag = await computeEnvelopeSetTag(slots, 1, hdk);
    await expect(
      verifyEnvelopeSetTag([slots[0]], { envelopeSetVersion: 1, envelopeSetTag: tag }, hdk),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('rejects an injected extra slot', async () => {
    const { hdk, slots } = await buildSet();
    const tag = await computeEnvelopeSetTag(slots, 1, hdk);
    const extra = await generatePasswordSlot('hh-1', 'slot-c', 'pw2', hdk);
    await expect(
      verifyEnvelopeSetTag([...slots, extra], { envelopeSetVersion: 1, envelopeSetTag: tag }, hdk),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('rejects a tampered wrappedKey (slot content reorder/substitution)', async () => {
    const { hdk, slots } = await buildSet();
    const tag = await computeEnvelopeSetTag(slots, 1, hdk);
    const mutated: KeyEnvelopeSlot[] = [
      { ...slots[0], wrappedKey: slots[1].wrappedKey },
      slots[1],
    ];
    await expect(
      verifyEnvelopeSetTag(mutated, { envelopeSetVersion: 1, envelopeSetTag: tag }, hdk),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('rejects a tampered credentialBinding (slot reassociation)', async () => {
    const { hdk, slots } = await buildSet();
    const tag = await computeEnvelopeSetTag(slots, 1, hdk);
    const mutated: KeyEnvelopeSlot[] = [
      { ...slots[0], credentialBinding: 'attacker-credential' },
      slots[1],
    ];
    await expect(
      verifyEnvelopeSetTag(mutated, { envelopeSetVersion: 1, envelopeSetTag: tag }, hdk),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('rejects a lower envelopeSetVersion (rollback on a device holding the newer counter)', async () => {
    const { hdk, slots } = await buildSet();
    const tag = await computeEnvelopeSetTag(slots, 5, hdk);
    // Same slots, but the served version is older than the tag was computed for.
    await expect(
      verifyEnvelopeSetTag(slots, { envelopeSetVersion: 4, envelopeSetTag: tag }, hdk),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('MAC key is HDK-derived: a tag verifies after unlocking from either slot', async () => {
    const { hdk, slots } = await buildSet();
    const tag = await computeEnvelopeSetTag(slots, 1, hdk);
    const fromPassword = await unwrapSlot(slots[0], 'pw');
    await expect(
      verifyEnvelopeSetTag(slots, { envelopeSetVersion: 1, envelopeSetTag: tag }, fromPassword),
    ).resolves.toBeUndefined();
  });
});

describe('key-wrapping — envelope-set version rollback', () => {
  it('detects a strictly-lower served version as rollback (mirrors freshness isRollback)', () => {
    expect(isEnvelopeSetRollback(4, 5)).toBe(true);
    expect(isEnvelopeSetRollback(5, 5)).toBe(false);
    expect(isEnvelopeSetRollback(6, 5)).toBe(false);
  });

  it('accepts first-contact (TOFU): served 0 against pinned 0 is not rollback', () => {
    expect(isEnvelopeSetRollback(0, 0)).toBe(false);
  });

  it('a version=4 slot set with its own valid MAC is rejected when pinned=5', async () => {
    const hdk = await generateHdk();
    const pw = await generatePasswordSlot('hh-1', 'slot-a', 'pw', hdk);
    const { slot: rec } = await generateRecoverySlot('hh-1', 'slot-b', hdk);
    const slots = [pw, rec];
    // The replayed set carries a self-consistent tag for its own version=4.
    const tag = await computeEnvelopeSetTag(slots, 4, hdk);
    await expect(
      verifyEnvelopeSetTag(slots, { envelopeSetVersion: 4, envelopeSetTag: tag }, hdk),
    ).resolves.toBeUndefined();
    // The MAC alone cannot see the rollback — the pinned-version check does.
    expect(isEnvelopeSetRollback(4, 5)).toBe(true);
  });
});

describe('key-wrapping — strict encrypted-envelope guard', () => {
  it('accepts a well-formed envelope', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope())).toBe(true);
  });

  it('accepts the optional aadVersion when it is a number', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope({ aadVersion: 2 }))).toBe(true);
  });

  it('rejects a non-object / null', () => {
    expect(isStrictEncryptedEnvelope(null)).toBe(false);
    expect(isStrictEncryptedEnvelope('x')).toBe(false);
    expect(isStrictEncryptedEnvelope(42)).toBe(false);
  });

  it('rejects a domain payload that merely carries encryptionVersion (false-decrypt guard)', () => {
    // The old loose check (encryptionVersion !== undefined) misfired here.
    expect(isStrictEncryptedEnvelope({ encryptionVersion: 1, name: 'Account' })).toBe(false);
  });

  it('rejects when encryptionVersion is not exactly 1', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope({ encryptionVersion: 2 as 1 }))).toBe(false);
  });

  it('rejects the wrong alg string', () => {
    expect(
      isStrictEncryptedEnvelope(validEnvelope({ alg: 'AES-128-GCM' as 'AES-256-GCM' })),
    ).toBe(false);
  });

  it('rejects when nonce / ciphertext / keyId are missing or non-string', () => {
    const noNonce: Record<string, unknown> = { ...validEnvelope() };
    delete noNonce.nonce;
    expect(isStrictEncryptedEnvelope(noNonce)).toBe(false);
    const noCipher: Record<string, unknown> = { ...validEnvelope() };
    delete noCipher.ciphertext;
    expect(isStrictEncryptedEnvelope(noCipher)).toBe(false);
    expect(isStrictEncryptedEnvelope(validEnvelope({ keyId: 7 as unknown as string }))).toBe(false);
  });

  it('rejects a non-number aadVersion', () => {
    expect(
      isStrictEncryptedEnvelope(validEnvelope({ aadVersion: 'x' as unknown as number })),
    ).toBe(false);
  });

  // Mirrors
  // apps/api/src/common/encrypted-envelope.spec.ts's identical case on the
  // identical fixture — the two guards can't share one test (separate
  // packages), so agreement is pinned by asserting the SAME shape yields the
  // SAME outcome in both specs.
  it('rejects an otherwise-valid envelope carrying one extra key', () => {
    const withExtra: Record<string, unknown> = { ...validEnvelope(), name: 'plaintext-leak' };
    expect(isStrictEncryptedEnvelope(withExtra)).toBe(false);
  });
});

describe('key-wrapping — envelope-set pin round-trip', () => {
  beforeEach(async () => {
    await dropLocalDatabase();
    localStorage.clear();
  });
  afterEach(async () => {
    await dropLocalDatabase();
    localStorage.clear();
  });

  function seedMetadata(envelopeSetVersion?: number): Promise<void> {
    return writeDeviceMetadata({
      deviceId: 'dev-1',
      syncCursor: '0',
      lastSyncedAt: null,
      displayName: 'Device',
      ...(envelopeSetVersion !== undefined ? { envelopeSetVersion } : {}),
    });
  }

  it('returns 0 (TOFU) when no metadata row exists', async () => {
    expect(await readEnvelopeSetPin('hh-1')).toBe(0);
  });

  it('returns 0 when the metadata row has no pin yet', async () => {
    await seedMetadata();
    expect(await readEnvelopeSetPin('hh-1')).toBe(0);
  });

  it('round-trips a written pin through deviceMetadata', async () => {
    await seedMetadata(3);
    expect(await readEnvelopeSetPin('hh-1')).toBe(3);
  });

  it('advances the pin monotonically (max of existing and served)', async () => {
    await seedMetadata(3);
    await writeEnvelopeSetPin(5);
    expect(await readEnvelopeSetPin('hh-1')).toBe(5);
    // A lower served version never lowers the pin.
    await writeEnvelopeSetPin(2);
    expect(await readEnvelopeSetPin('hh-1')).toBe(5);
  });

  it('no-ops when there is no metadata row AND no deviceId (backward-compat)', async () => {
    await writeEnvelopeSetPin(9);
    expect(await readEnvelopeSetPin('hh-1')).toBe(0);
    expect(await readDeviceMetadata()).toBeNull();
  });

  it('seeds a minimal metadata row with the pin when no row exists but deviceId is given', async () => {
    // Setup/rotation can run before the first sync writes deviceMetadata. Without
    // persisting the pin here, a later replay of an old valid set passes the
    // rollback check (isEnvelopeSetRollback(N, 0) === false). The seeded row
    // carries the pin so the rollback guard works on the first activation.
    await writeEnvelopeSetPin(4, 'dev-seed');
    expect(await readEnvelopeSetPin('hh-1')).toBe(4);
    const meta = await readDeviceMetadata();
    expect(meta?.deviceId).toBe('dev-seed');
    expect(meta?.envelopeSetVersion).toBe(4);
    expect(meta?.syncCursor).toBe('0');
  });

  it('does not seed a row for a non-positive served version even with a deviceId', async () => {
    // Version 0 is the TOFU baseline — there is nothing to pin yet, so seeding a
    // row would be premature noise; readEnvelopeSetPin already returns 0.
    await writeEnvelopeSetPin(0, 'dev-seed');
    expect(await readDeviceMetadata()).toBeNull();
    expect(await readEnvelopeSetPin('hh-1')).toBe(0);
  });

  it('advances the pin on an existing row regardless of the deviceId argument', async () => {
    await seedMetadata(3);
    // deviceId is ignored when a row already exists — the existing row is updated.
    await writeEnvelopeSetPin(7, 'other-dev');
    expect(await readEnvelopeSetPin('hh-1')).toBe(7);
    const meta = await readDeviceMetadata();
    expect(meta?.deviceId).toBe('dev-1');
  });

  it('raiseEnvelopeSetPinFloor durably rejects a replay even when the deviceMetadata pin write never lands', async () => {
    // No deviceMetadata row exists (mirrors a persistent IndexedDB write
    // failure that never seeds/advances the row) — before the fix,
    // readEnvelopeSetPin had no other durable signal and would return 0,
    // letting a replay of any served version pass isEnvelopeSetRollback.
    expect(await readEnvelopeSetPin('hh-1')).toBe(0);

    raiseEnvelopeSetPinFloor(3, 'hh-1');

    // The independent localStorage floor now governs the pin even though the
    // deviceMetadata row is still absent — a replay of the retired version 3
    // (or lower) reads as a rollback.
    expect(await readEnvelopeSetPin('hh-1')).toBe(3);
    expect(await readDeviceMetadata()).toBeNull();

    // Monotonic: a lower raise never lowers the floor.
    raiseEnvelopeSetPinFloor(1, 'hh-1');
    expect(await readEnvelopeSetPin('hh-1')).toBe(3);
  });

  it('reports the raise as confirmed when localStorage actually persists it', () => {
    expect(raiseEnvelopeSetPinFloor(3, 'hh-1')).toBe(true);
  });

  it('reports the raise as FAILED when localStorage silently accepts the write without persisting it', () => {
    // Regression guard for the exact gap an earlier fallback missed: a
    // browser can return from `setItem` without throwing yet not actually
    // store the value (pre-2017 Safari private-mode; a write landing on a
    // quota boundary in some engines). Simulate that by making `setItem` a
    // silent no-op — the write "succeeds" from the caller's point of view,
    // but nothing durable records the floor.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      // no-op: accepted without throwing, but never actually stored.
    });
    try {
      expect(raiseEnvelopeSetPinFloor(3, 'hh-1')).toBe(false);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('scopes the localStorage floor per household so switching accounts on the same device cannot cross-contaminate', async () => {
    // Household A's deviceMetadata pin write fails and falls back to the
    // localStorage floor, raising it to a high version.
    expect(raiseEnvelopeSetPinFloor(10, 'household-a')).toBe(true);
    expect(await readEnvelopeSetPin('household-a')).toBe(10);

    // The device now signs in to a DIFFERENT household whose deviceMetadata
    // row (and hence the whole IndexedDB working store) was dropped on the
    // switch, but localStorage was never touched. Before this fix, both
    // households shared one unscoped key, so household B's genuinely lower
    // version would have been wrongly rejected as a rollback against
    // household A's floor. Scoped by householdId, household B sees no floor
    // at all.
    expect(await readEnvelopeSetPin('household-b')).toBe(0);

    // And household A's floor is untouched by household B's activity.
    expect(await readEnvelopeSetPin('household-a')).toBe(10);
  });

  it('does not revert a concurrent sync-metadata write (lost-update regression)', async () => {
    // The unlock/rotation flows call writeEnvelopeSetPin OUTSIDE the
    // SyncContext mutex, so it must merge atomically instead of spreading
    // a stale full-row read over a concurrently-persisted syncCursor.
    await seedMetadata(3);
    await Promise.all([
      writeEnvelopeSetPin(8, 'dev-1'),
      updateDeviceMetadata((current) => ({
        ...(current ?? {
          deviceId: 'dev-1',
          syncCursor: '0',
          lastSyncedAt: null,
          displayName: 'Device',
        }),
        syncCursor: 'cursor-42',
      })),
    ]);
    const after = await readDeviceMetadata();
    expect(after?.envelopeSetVersion).toBe(8);
    expect(after?.syncCursor).toBe('cursor-42');
  });

  it('an isStale check that stays false throughout does not change the write (regression)', async () => {
    await seedMetadata(3);
    await writeEnvelopeSetPin(6, 'dev-1', () => false);
    expect(await readEnvelopeSetPin('hh-1')).toBe(6);
  });

  it('a session already stale right after the existence probe aborts the write BEFORE it commits, instead of only being noticed after', async () => {
    await seedMetadata(3);
    // Mirrors a cross-household session switch that completed strictly
    // inside writeEnvelopeSetPin's own probe await, before this line's check
    // runs — the write must never reach `updateDeviceMetadata` at all.
    await expect(writeEnvelopeSetPin(6, 'dev-1', () => true)).rejects.toBeInstanceOf(
      EnvelopeSetPinAbortedError,
    );
    // The write never landed — the pin is untouched at its pre-abort value.
    expect(await readEnvelopeSetPin('hh-1')).toBe(3);
  });

  it('a household switch landing inside updateDeviceMetadata\'s own read aborts before the put, never touching the row', async () => {
    await seedMetadata(3);
    // isStale reports false for the pre-call check (letting the existence
    // probe pass) but true by the time the updater itself runs — mirroring a
    // switch landing strictly inside `updateDeviceMetadata`'s internal read.
    let calls = 0;
    const isStale = vi.fn(() => {
      calls += 1;
      return calls > 1;
    });
    await expect(writeEnvelopeSetPin(6, 'dev-1', isStale)).rejects.toBeInstanceOf(
      EnvelopeSetPinAbortedError,
    );
    expect(await readEnvelopeSetPin('hh-1')).toBe(3);
  });
});

describe('key-wrapping — malformed server-stored fields fail closed (KeyWrappingError)', () => {
  it('throws KeyWrappingError on a malformed (non-base64url) wrappedKey', async () => {
    const hdk = await generateHdk();
    const slot = await generatePasswordSlot('hh-1', 'slot-pw', 'pw', hdk);
    const tampered: KeyEnvelopeSlot = { ...slot, wrappedKey: 'not valid base64url !!!' };
    await expect(unwrapSlot(tampered, 'pw')).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws KeyWrappingError on a malformed (non-base64url) kdf salt', async () => {
    const kdf: KdfParams = {
      algorithm: 'PBKDF2-HMAC-SHA-256',
      iterations: 600_000,
      salt: 'not valid base64url !!!',
    };
    await expect(derivePasswordWrapKey('pw', kdf)).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws KeyWrappingError on a malformed (non-base64url) envelopeSetTag', async () => {
    const hdk = await generateHdk();
    const pw = await generatePasswordSlot('hh-1', 'slot-a', 'pw', hdk);
    const { slot: rec } = await generateRecoverySlot('hh-1', 'slot-b', hdk);
    const slots = [pw, rec];
    await expect(
      verifyEnvelopeSetTag(
        slots,
        { envelopeSetVersion: 1, envelopeSetTag: 'not valid base64url !!!' },
        hdk,
      ),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });
});

describe('key-wrapping — passkey_prf slot (unwrapPrfSlot)', () => {
  const GCM_NONCE_BYTES = 12;

  /**
   * Build a `passkey_prf` slot the way the producer does: wrap
   * the HDK under the PRF-derived AES-GCM key with the slot-metadata AAD that
   * `unwrapPrfSlot` reconstructs. PRF slots carry no `kdf`, so the AAD binds only
   * `slotType` + `encryptionVersion` (`kdf: null`) — mirrors the recovery slot.
   * Reconstructing the wrap here (rather than calling an internal helper) keeps
   * the test asserting the public unwrap contract end-to-end.
   */
  async function buildPrfSlot(
    hdk: CryptoKey,
    prfWrapKey: CryptoKey,
    encryptionVersion = 1,
  ): Promise<KeyEnvelopeSlot> {
    const aad = canonicalJsonBytes({
      encryptionVersion,
      kdf: null,
      slotType: 'passkey_prf',
    });
    const hdkBytes = await exportHdk(hdk);
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
    const wrapped = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      prfWrapKey,
      hdkBytes,
    );
    const combined = new Uint8Array(nonce.length + wrapped.byteLength);
    combined.set(nonce, 0);
    combined.set(new Uint8Array(wrapped), nonce.length);
    const now = new Date().toISOString();
    return {
      householdId: 'hh-1',
      slotId: 'slot-prf',
      slotType: 'passkey_prf',
      prfSalt: 'cHJmLXNhbHQ',
      wrappedKey: bytesToBase64Url(combined),
      encryptionVersion,
      createdAt: now,
      updatedAt: now,
    };
  }

  it('round-trips the HDK with the correct PRF wrap key', async () => {
    const hdk = await generateHdk();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const wrapKey = await derivePrfWrapKey(prfOutput);
    const slot = await buildPrfSlot(hdk, wrapKey);
    const recovered = await unwrapPrfSlot(slot, wrapKey);
    expect(await sameKey(recovered, hdk)).toBe(true);
  });

  it('fails closed (KeyWrappingError) with a wrong PRF wrap key', async () => {
    const hdk = await generateHdk();
    const rightOutput = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const wrongOutput = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const rightKey = await derivePrfWrapKey(rightOutput);
    const wrongKey = await derivePrfWrapKey(wrongOutput);
    const slot = await buildPrfSlot(hdk, rightKey);
    await expect(unwrapPrfSlot(slot, wrongKey)).rejects.toBeInstanceOf(KeyWrappingError);
  });

  it('throws KeyWrappingError when given a non-passkey_prf slot type', async () => {
    const hdk = await generateHdk();
    const pwSlot = await generatePasswordSlot('hh-1', 'slot-pw', 'pw', hdk);
    const prfOutput = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const wrapKey = await derivePrfWrapKey(prfOutput);
    // The slot-type guard rejects before any async work (synchronous throw).
    expect(() => unwrapPrfSlot(pwSlot, wrapKey)).toThrow(KeyWrappingError);
  });
});

describe('key-wrapping — passkey_prf slot (generatePasskeyPrfSlot)', () => {
  it('round-trips the HDK through unwrapPrfSlot and binds credentialBinding + prfSalt', async () => {
    const hdk = await generateHdk();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const wrapKey = await derivePrfWrapKey(prfOutput);
    const slot = await generatePasskeyPrfSlot(
      'hh-1',
      'passkey_prf',
      wrapKey,
      hdk,
      'cHJmLXNhbHQ',
      'cred-abc',
    );
    expect(slot.slotType).toBe('passkey_prf');
    expect(slot.credentialBinding).toBe('cred-abc');
    expect(slot.prfSalt).toBe('cHJmLXNhbHQ');
    expect(slot.kdf).toBeUndefined();
    const recovered = await unwrapPrfSlot(slot, wrapKey);
    expect(await sameKey(recovered, hdk)).toBe(true);
  });

  it('produces a slot that verifies in an envelope set alongside password + recovery slots', async () => {
    const hdk = await generateHdk();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const wrapKey = await derivePrfWrapKey(prfOutput);
    const pw = await generatePasswordSlot('hh-1', 'slot-pw', 'pw', hdk);
    const { slot: rec } = await generateRecoverySlot('hh-1', 'slot-rec', hdk);
    const prf = await generatePasskeyPrfSlot(
      'hh-1',
      'slot-prf',
      wrapKey,
      hdk,
      'cHJmLXNhbHQ',
      'cred-abc',
    );
    const slots = [pw, rec, prf];
    const tag = await computeEnvelopeSetTag(slots, 3, hdk);
    await expect(
      verifyEnvelopeSetTag(slots, { envelopeSetVersion: 3, envelopeSetTag: tag }, hdk),
    ).resolves.toBeUndefined();
  });

  it('fails the set tag when the PRF slot is rebound to a different credential', async () => {
    const hdk = await generateHdk();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const wrapKey = await derivePrfWrapKey(prfOutput);
    const pw = await generatePasswordSlot('hh-1', 'slot-pw', 'pw', hdk);
    const prf = await generatePasskeyPrfSlot(
      'hh-1',
      'slot-prf',
      wrapKey,
      hdk,
      'cHJmLXNhbHQ',
      'cred-abc',
    );
    const slots = [pw, prf];
    const tag = await computeEnvelopeSetTag(slots, 2, hdk);
    // A server silently rebinding the PRF slot to another credential id changes
    // the canonical set form (credentialBinding is MACed) → tag mismatch.
    const rebound = [pw, { ...prf, credentialBinding: 'cred-evil' }];
    await expect(
      verifyEnvelopeSetTag(rebound, { envelopeSetVersion: 2, envelopeSetTag: tag }, hdk),
    ).rejects.toBeInstanceOf(KeyWrappingError);
  });
});
