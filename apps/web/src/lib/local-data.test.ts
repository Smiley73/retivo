/**
 * Completeness tests for the clear-local-data nuke. Proves every client-
 * side storage surface is wiped, the selective-preserve carve-outs work,
 * and Cache Storage handling is best-effort (present + absent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { clearAllLocalData } from './local-data';
import { writeDeviceMetadata, readDeviceMetadata, dropLocalDatabase } from '../db/store';

async function seedAll(): Promise<void> {
  localStorage.setItem('retivo.auth.deviceId', 'dev-123');
  localStorage.setItem('retivo.theme.anonymous', 'dark');
  localStorage.setItem('retivo.optimizer.pathCount', '5000');
  sessionStorage.setItem('retivo.auth.signoutReason', 'idle-timeout');
  sessionStorage.setItem('retivo.auth.deletedNotice', 'gone');
  // Seed IndexedDB through the real store so the drop is observable.
  await writeDeviceMetadata({
    deviceId: 'dev-123',
    syncCursor: '7',
    lastSyncedAt: new Date().toISOString(),
    displayName: 'Test device',
  });
}

describe('clearAllLocalData', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await dropLocalDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wipes localStorage, sessionStorage, and IndexedDB (deviceId included)', async () => {
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    });
    await seedAll();
    expect(localStorage.length).toBeGreaterThan(0);
    expect(sessionStorage.length).toBeGreaterThan(0);
    expect(await readDeviceMetadata()).not.toBeNull();

    await clearAllLocalData();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(await readDeviceMetadata()).toBeNull();
  });

  it('invokes caches.delete once per cache key', async () => {
    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['v1', 'v2']),
      delete: del,
    });

    await clearAllLocalData();

    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith('v1');
    expect(del).toHaveBeenCalledWith('v2');
  });

  it('keeps preserveLocalKeys and drops the rest', async () => {
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    });
    localStorage.setItem('k', 'keep');
    localStorage.setItem('other', 'drop');

    await clearAllLocalData({ preserveLocalKeys: ['k'] });

    expect(localStorage.getItem('k')).toBe('keep');
    expect(localStorage.getItem('other')).toBeNull();
    expect(localStorage.length).toBe(1);
  });

  it('keeps preserveSessionKeys and drops the rest', async () => {
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    });
    sessionStorage.setItem('s', 'keep');
    sessionStorage.setItem('other', 'drop');

    await clearAllLocalData({ preserveSessionKeys: ['s'] });

    expect(sessionStorage.getItem('s')).toBe('keep');
    expect(sessionStorage.getItem('other')).toBeNull();
    expect(sessionStorage.length).toBe(1);
  });

  it('does not resurrect a preserved-but-absent key', async () => {
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    });

    await clearAllLocalData({ preserveLocalKeys: ['missing'] });

    expect(localStorage.getItem('missing')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('resolves without throwing when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    localStorage.setItem('x', '1');

    await expect(clearAllLocalData()).resolves.toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('never aborts the nuke when caches.delete rejects (best-effort)', async () => {
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['v1']),
      delete: vi.fn().mockRejectedValue(new Error('cache boom')),
    });
    localStorage.setItem('x', '1');
    sessionStorage.setItem('y', '2');

    await expect(clearAllLocalData()).resolves.toBeUndefined();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
