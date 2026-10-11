/**
 * Tests for the device-local HDK cache. The
 * household-mismatch guard and the corrupt-bytes catch are security
 * load-bearing: a stale or unusable cached key must surface as "no cache" so
 * the caller falls back to an explicit unlock rather than trusting it. Runs
 * against a real IDB via `fake-indexeddb`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { cacheHdk, clearCachedHdk, loadCachedHdk } from './key-cache';
import { generateHdk } from './key-wrapping';
import {
  KEY_CACHE_ID,
  dropLocalDatabase,
  readKeyCacheEntry,
  writeKeyCacheEntry,
} from '../db/store';

describe('key-cache', () => {
  beforeEach(async () => {
    await dropLocalDatabase();
  });

  afterEach(async () => {
    await dropLocalDatabase();
  });

  it('round-trips: caches an HDK then loads a key with the same algorithm', async () => {
    const hdk = await generateHdk();
    await cacheHdk('hh-1', hdk);
    const loaded = await loadCachedHdk('hh-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.algorithm).toEqual(hdk.algorithm);
  });

  it('returns null when the cached entry belongs to a different household', async () => {
    const hdk = await generateHdk();
    await cacheHdk('hh-1', hdk);
    expect(await loadCachedHdk('hh-2')).toBeNull();
  });

  it('returns null without throwing when the cached bytes are corrupt', async () => {
    // Write an entry whose `hdkExported` is not a valid raw AES-GCM key
    // (1 byte) so the re-import in loadCachedHdk throws and is swallowed.
    await writeKeyCacheEntry({
      id: KEY_CACHE_ID,
      householdId: 'hh-1',
      hdkExported: new Uint8Array([0x01]).buffer,
    });
    await expect(loadCachedHdk('hh-1')).resolves.toBeNull();
  });

  it('clearCachedHdk empties the store so a subsequent load returns null', async () => {
    const hdk = await generateHdk();
    await cacheHdk('hh-1', hdk);
    expect(await readKeyCacheEntry()).not.toBeNull();
    await clearCachedHdk();
    expect(await readKeyCacheEntry()).toBeNull();
    expect(await loadCachedHdk('hh-1')).toBeNull();
  });

  it('clearCachedHdk does not throw when the store is already empty', async () => {
    await expect(clearCachedHdk()).resolves.toBeUndefined();
    await expect(clearCachedHdk()).resolves.toBeUndefined();
  });
});
