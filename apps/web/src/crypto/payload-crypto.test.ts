// Unit tests for AES-256-GCM payload encryption and canonical AAD.
import { describe, it, expect } from 'vitest';
import { generateHdk } from './key-wrapping';
import {
  decryptPayload,
  encryptPayload,
  PayloadCryptoError,
} from './payload-crypto';
import type { AadMetadata, EncryptedPayloadEnvelope } from './encryption-types';

const meta: AadMetadata = {
  householdId: 'hh-1',
  aggregateId: 'agg-1',
  aggregateType: 'account',
  encryptionVersion: 1,
};

const payload = { balance: 12345, label: 'Brokerage', owner: 'primary' };

describe('payload-crypto', () => {
  it('round-trips encrypt then decrypt with matching AAD', async () => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    const decrypted = await decryptPayload(envelope, meta, hdk);
    expect(decrypted).toEqual(payload);
  });

  it('produces a well-formed v1 envelope', async () => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    expect(envelope.encryptionVersion).toBe(1);
    expect(envelope.alg).toBe('AES-256-GCM');
    expect(envelope.keyId).toBe('key-1');
    expect(typeof envelope.nonce).toBe('string');
    expect(typeof envelope.ciphertext).toBe('string');
  });

  it.each([
    { field: 'aggregateId', value: 'agg-2' },
    { field: 'householdId', value: 'hh-2' },
  ])('fails closed when the AAD $field differs', async ({ field, value }) => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    const wrongMeta: AadMetadata = { ...meta, [field]: value };
    await expect(decryptPayload(envelope, wrongMeta, hdk)).rejects.toBeInstanceOf(
      PayloadCryptoError,
    );
  });

  it('fails closed with the wrong key', async () => {
    const hdk = await generateHdk();
    const otherHdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    await expect(decryptPayload(envelope, meta, otherHdk)).rejects.toBeInstanceOf(
      PayloadCryptoError,
    );
  });

  it('fails closed on an unsupported encryptionVersion', async () => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    const bad = { ...envelope, encryptionVersion: 2 } as unknown as EncryptedPayloadEnvelope;
    await expect(decryptPayload(bad, meta, hdk)).rejects.toBeInstanceOf(PayloadCryptoError);
  });

  it('rejects encrypting with an unsupported meta.encryptionVersion', async () => {
    const hdk = await generateHdk();
    const badMeta: AadMetadata = { ...meta, encryptionVersion: 2 };
    await expect(encryptPayload(payload, badMeta, hdk, 'key-1')).rejects.toBeInstanceOf(
      PayloadCryptoError,
    );
  });

  it('fails closed when meta.encryptionVersion disagrees with the envelope', async () => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    const mismatchedMeta: AadMetadata = { ...meta, encryptionVersion: 2 };
    await expect(decryptPayload(envelope, mismatchedMeta, hdk)).rejects.toBeInstanceOf(
      PayloadCryptoError,
    );
  });

  it('fails closed on an unsupported alg', async () => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    const bad = { ...envelope, alg: 'AES-128-GCM' } as unknown as EncryptedPayloadEnvelope;
    await expect(decryptPayload(bad, meta, hdk)).rejects.toBeInstanceOf(PayloadCryptoError);
  });

  it('uses a fresh nonce per encryption of the same payload', async () => {
    const hdk = await generateHdk();
    const envelopeA = await encryptPayload(payload, meta, hdk, 'key-1');
    const envelopeB = await encryptPayload(payload, meta, hdk, 'key-1');
    expect(envelopeA.nonce).not.toBe(envelopeB.nonce);
    expect(envelopeA.ciphertext).not.toBe(envelopeB.ciphertext);
  });

  it('ciphertext does not contain recognizable plaintext payload fields', async () => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toMatch(/Brokerage/);
    expect(serialized).not.toMatch(/balance/);
    expect(serialized).not.toMatch(/12345/);
  });

  it('decrypts with the AAD fields in any order', async () => {
    const hdk = await generateHdk();
    const envelope = await encryptPayload(payload, meta, hdk, 'key-1');
    const reordered: AadMetadata = {
      aggregateType: 'account',
      encryptionVersion: 1,
      aggregateId: 'agg-1',
      householdId: 'hh-1',
    };
    expect(await decryptPayload(envelope, reordered, hdk)).toEqual(payload);
  });
});
