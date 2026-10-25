import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import { loadDemoData } from './demo-data-loader';
import {
  AGGREGATE_TYPES_IN_DEPENDENCY_ORDER,
  EXPORT_BUNDLE_FORMAT,
  EXPORT_BUNDLE_VERSION,
  buildExportBundle,
  exportFilename,
  exportFilenameJson,
  gzipJson,
  plainJson,
} from './data-export';

const HOUSEHOLD_ID = 'hh-export';
const DEVICE_ID = 'dev-export';

describe('buildExportBundle', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('writes envelope metadata + empty arrays for every type when the workspace is empty', async () => {
    const bundle = await buildExportBundle(HOUSEHOLD_ID, DEVICE_ID);

    expect(bundle.format).toBe(EXPORT_BUNDLE_FORMAT);
    expect(bundle.version).toBe(EXPORT_BUNDLE_VERSION);
    expect(bundle.householdId).toBe(HOUSEHOLD_ID);
    expect(bundle.deviceId).toBe(DEVICE_ID);
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof bundle.exportedByBuildId).toBe('string');

    for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      expect(bundle.aggregates[type]).toEqual([]);
    }
  });

  it('captures every non-deleted aggregate from the populated workspace', async () => {
    await loadDemoData({
      householdId: HOUSEHOLD_ID,
      email: 'demo@x',
      displayName: 'Demo User',
    });

    const bundle = await buildExportBundle(HOUSEHOLD_ID, DEVICE_ID);

    for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      const fromStore = await listAggregates(type);
      expect(bundle.aggregates[type].length).toBe(fromStore.length);
    }
    expect(bundle.aggregates.account.length).toBe(14);
    expect(bundle.aggregates.accountBalance.length).toBe(140);
    expect(bundle.aggregates.householdMember.length).toBe(2);
  });

  // Regression guard for the zero-knowledge boundary: local export bundles stay plaintext; encryption happens only on cloud push.
  it('exports plaintext aggregate payloads, never encrypted envelopes', async () => {
    await loadDemoData({
      householdId: HOUSEHOLD_ID,
      email: 'demo@x',
      displayName: 'Demo User',
    });

    const bundle = await buildExportBundle(HOUSEHOLD_ID, DEVICE_ID);

    const member = bundle.aggregates.householdMember[0];
    expect(member).toBeDefined();
    const memberPayload = member.payload as Record<string, unknown>;
    expect(Object.keys(memberPayload).length).toBeGreaterThan(0);

    const account = bundle.aggregates.account[0];
    expect(account).toBeDefined();
    const accountPayload = account.payload as Record<string, unknown>;
    expect('name' in accountPayload || 'kind' in accountPayload).toBe(true);

    for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      for (const aggr of bundle.aggregates[type]) {
        const payload = aggr.payload as Record<string, unknown>;
        expect(payload).not.toHaveProperty('ciphertext');
        expect(payload).not.toHaveProperty('nonce');
        expect(payload).not.toHaveProperty('encryptionVersion');
      }
    }
  });
});

describe('exportFilename', () => {
  it('uses the household id and ISO date portion of exportedAt', () => {
    const name = exportFilename('hh-1', '2026-05-05T12:34:56.789Z');
    expect(name).toBe('retivo-export-hh-1-2026-05-05.json.gz');
  });
});

describe('exportFilenameJson', () => {
  it('uses the .json suffix (uncompressed variant)', () => {
    const name = exportFilenameJson('hh-1', '2026-05-05T12:34:56.789Z');
    expect(name).toBe('retivo-export-hh-1-2026-05-05.json');
  });
});

describe('plainJson', () => {
  it('produces an UNCOMPRESSED blob that parses back to the original value', async () => {
    const value = { hello: 'world', n: 42, nested: { ok: true } };
    const blob = plainJson(value);

    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect(head[0]).not.toBe(0x1f);

    const text = await blob.text();
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('gzipJson', () => {
  it('produces a gzipped blob that round-trips back to the original JSON', async () => {
    const value = { hello: 'world', n: 42, nested: { ok: true } };
    const blob = await gzipJson(value);

    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect(head[0]).toBe(0x1f);
    expect(head[1]).toBe(0x8b);

    const body = new Response(blob).body;
    expect(body).toBeTruthy();
    const ungzipped = await new Response(
      body!.pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(JSON.parse(ungzipped)).toEqual(value);
  });
});
