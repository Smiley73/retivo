/**
 * Unit tests for the freshness head MAC + monotonic-counter helpers.
 */
import { describe, it, expect } from 'vitest';
import { generateHdk, generatePasswordSlot, unwrapSlot } from './key-wrapping';
import {
  bumpCounter,
  computeCursorTag,
  FreshnessError,
  isRollback,
  verifyCursorTag,
} from './freshness';

describe('freshness', () => {
  it('round-trips computeCursorTag then verifyCursorTag', async () => {
    const hdk = await generateHdk();
    const cursorTag = await computeCursorTag(7, hdk);
    await expect(verifyCursorTag({ freshnessCounter: 7, cursorTag }, hdk)).resolves.toBeUndefined();
  });

  it('throws on a tampered cursorTag', async () => {
    const hdk = await generateHdk();
    const cursorTag = await computeCursorTag(7, hdk);
    // Tag computed for counter 7, served against counter 8.
    await expect(verifyCursorTag({ freshnessCounter: 8, cursorTag }, hdk)).rejects.toBeInstanceOf(
      FreshnessError,
    );
  });

  it('throws FreshnessError on a malformed (non-base64url) cursorTag', async () => {
    const hdk = await generateHdk();
    await expect(
      verifyCursorTag({ freshnessCounter: 1, cursorTag: 'not valid base64url !!!' }, hdk),
    ).rejects.toBeInstanceOf(FreshnessError);
  });

  it('detects a strictly-lower served counter as rollback', () => {
    expect(isRollback(5, 6)).toBe(true);
    expect(isRollback(6, 6)).toBe(false);
    expect(isRollback(7, 6)).toBe(false);
  });

  it('accepts first-contact (TOFU): served 0 against pinned 0 is not rollback', () => {
    expect(isRollback(0, 0)).toBe(false);
  });

  it('bumpCounter is monotonically increasing', () => {
    expect(bumpCounter(0)).toBe(1);
    expect(bumpCounter(41)).toBe(42);
  });

  it('cursor MAC key is HDK-derived: a tag verifies from a separately-unlocked HDK', async () => {
    const hdk = await generateHdk();
    const slot = await generatePasswordSlot('hh-1', 'slot-pw', 'pw', hdk);
    const cursorTag = await computeCursorTag(3, hdk);
    const unlocked = await unwrapSlot(slot, 'pw');
    await expect(
      verifyCursorTag({ freshnessCounter: 3, cursorTag }, unlocked),
    ).resolves.toBeUndefined();
  });
});
