/**
 * Tests for the workspace import: file parsing, validation, apply +
 * round-trip drill against the demo dataset.
 *
 * The round-trip drill is the regression guard for the export bundle
 * compatibility contract — load
 * demo → export → wipe → import → identical workspace renders.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  listAggregates,
  listFailedConflicts,
  listPendingMutations,
  putAggregate,
  queueMutation,
  subscribeToStoreChanges,
} from '../db/store';
import { setRegisteredDeviceId } from '../sync/device-id';
import { currentSchemaVersion } from '../db/migrations';
import { loadDemoData } from './demo-data-loader';
import {
  AGGREGATE_TYPES_IN_DEPENDENCY_ORDER,
  EXPORT_BUNDLE_FORMAT,
  LEGACY_EXPORT_BUNDLE_FORMAT,
  EXPORT_BUNDLE_VERSION,
  buildExportBundle,
  gzipJson,
  plainJson,
  type ExportBundle,
} from './data-export';
import {
  DataImportError,
  applyImport,
  parseImportFile,
  validateBundle,
} from './data-import';

const HOUSEHOLD_ID = 'hh-import';
const OTHER_HOUSEHOLD_ID = 'hh-other';

function emptyBundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    format: EXPORT_BUNDLE_FORMAT,
    version: EXPORT_BUNDLE_VERSION,
    exportedAt: '2026-05-05T00:00:00Z',
    exportedByBuildId: 'test',
    householdId: HOUSEHOLD_ID,
    deviceId: 'dev-x',
    aggregates: {
      household: [],
      householdMember: [],
      account: [],
      accountBalance: [],
      socialSecurityBenefit: [],
      scenario: [],
      expenseCategory: [],
      expense: [],
      incomeStream: [],
    },
    ...overrides,
  };
}

// The account section of an export made before the server stopped storing legal
// acceptances: an `attestations` array plus the User row's legal pointer fields.
// The importer never reads the section, so such a bundle must keep importing.
const LEGACY_USER_LEGAL_FIELDS = {
  acceptedTermsVersion: 2,
  acceptedTermsSha256: 'a'.repeat(64),
  acknowledgedPrivacyVersion: 3,
  acknowledgedPrivacySha256: 'b'.repeat(64),
  acceptedPresentationVersion: 4,
  acceptedPresentationSha256: 'c'.repeat(64),
  legalAcceptedAt: '2026-01-01T00:00:00.000Z',
};
const LEGACY_ATTESTATIONS = [
  {
    userId: 'u-1',
    acceptedAt: '2026-01-01T00:00:00.000Z',
    emailSnapshot: 'a@example.test',
    rowType: 'legal_acceptance',
    terms: { documentType: 'terms', version: 2, sha256: 'a'.repeat(64) },
    privacy: { documentType: 'privacy', version: 3, sha256: 'b'.repeat(64) },
    presentation: { documentType: 'legal_presentation', version: 4, sha256: 'c'.repeat(64) },
    serverAcceptedAt: '2026-01-01T00:00:00.000Z',
    ip: null,
    userAgent: null,
    serverBuildId: 'abc1234',
    acceptanceMethod: 'signup_clickwrap',
    retainUntil: 4102444800,
  },
];

describe('parseImportFile', () => {
  it('parses a gzipped JSON bundle', async () => {
    const blob = await gzipJson(emptyBundle());
    const parsed = await parseImportFile(blob);
    expect((parsed as ExportBundle).format).toBe(EXPORT_BUNDLE_FORMAT);
  });

  it('parses a raw (non-gzipped) JSON bundle', async () => {
    const blob = new Blob([JSON.stringify(emptyBundle())]);
    const parsed = await parseImportFile(blob);
    expect((parsed as ExportBundle).format).toBe(EXPORT_BUNDLE_FORMAT);
  });

  it('rejects MALFORMED_BUNDLE on garbage bytes', async () => {
    // Random non-gzip non-JSON bytes.
    const blob = new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03])]);
    await expect(parseImportFile(blob)).rejects.toMatchObject({
      code: 'MALFORMED_BUNDLE',
    });
  });

  it('rejects MALFORMED_BUNDLE on a truncated gzip header', async () => {
    // Magic-bytes match but the payload is invalid.
    const blob = new Blob([new Uint8Array([0x1f, 0x8b, 0x00, 0x00])]);
    await expect(parseImportFile(blob)).rejects.toMatchObject({
      code: 'MALFORMED_BUNDLE',
    });
  });

  it('rejects BUNDLE_TOO_LARGE on a gzipped file exceeding the 50 MB compressed ceiling', async () => {
    // Build an oversized blob without paying the cost of allocating
    // 50 MB+ of real bytes: spoof `size` (Blob.size is the canonical
    // pre-read check). Content starts with the gzip magic bytes so the
    // 50 MB (compressed) ceiling — not the higher plain-file ceiling —
    // applies.
    const fake = new Blob([new Uint8Array([0x1f, 0x8b, 0x08])]) as Blob & { size: number };
    Object.defineProperty(fake, 'size', { value: 60 * 1024 * 1024 });
    await expect(parseImportFile(fake)).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
    });
  });

  // A plain (non-gzipped) file's ceiling matches
  // MAX_DECOMPRESSED_BYTES (200 MB), not the old flat 50 MB — see the
  // `round-trips a plain (non-gzipped) JSON export above the old 50 MiB flat
  // ceiling` test below for the positive case just under this ceiling.
  it('rejects BUNDLE_TOO_LARGE on a plain (non-gzipped) file exceeding the 200 MB decoded ceiling', async () => {
    const fake = new Blob(['x']) as Blob & { size: number };
    Object.defineProperty(fake, 'size', { value: 210 * 1024 * 1024 });
    await expect(parseImportFile(fake)).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
    });
  });

  it('rejects BUNDLE_FORBIDDEN_KEY on an object carrying `__proto__`', async () => {
    // Hand-crafted JSON text — `{ '__proto__': X }` in JS source sets
    // the prototype rather than creating a `"__proto__"` own-key, so
    // the only way to test the guard is a literal JSON string.
    const payload =
      `{"format":"${EXPORT_BUNDLE_FORMAT}","version":${EXPORT_BUNDLE_VERSION},` +
      `"householdId":"${HOUSEHOLD_ID}","aggregates":{"account":[{"id":"a",` +
      `"householdId":"${HOUSEHOLD_ID}","version":0,"schemaVersion":0,` +
      `"payload":{"__proto__":{"polluted":true}}}]}}`;
    const blob = new Blob([payload]);
    await expect(parseImportFile(blob)).rejects.toMatchObject({
      code: 'BUNDLE_FORBIDDEN_KEY',
    });
  });

  it('rejects BUNDLE_FORBIDDEN_KEY on a `constructor` own-key (prototype-pollution)', async () => {
    const payload =
      `{"format":"${EXPORT_BUNDLE_FORMAT}","version":${EXPORT_BUNDLE_VERSION},` +
      `"householdId":"${HOUSEHOLD_ID}","aggregates":{"account":[{"id":"a",` +
      `"householdId":"${HOUSEHOLD_ID}","version":0,"schemaVersion":0,` +
      `"payload":{"constructor":{"prototype":{"polluted":true}}}}]}}`;
    const blob = new Blob([payload]);
    await expect(parseImportFile(blob)).rejects.toMatchObject({
      code: 'BUNDLE_FORBIDDEN_KEY',
    });
  });

  it('rejects BUNDLE_ARRAY_TOO_LONG on a degenerate array', async () => {
    const big = new Array(100_001).fill(0);
    const payload = JSON.stringify({
      format: EXPORT_BUNDLE_FORMAT,
      version: EXPORT_BUNDLE_VERSION,
      householdId: HOUSEHOLD_ID,
      aggregates: { account: big },
    });
    const blob = new Blob([payload]);
    await expect(parseImportFile(blob)).rejects.toMatchObject({
      code: 'BUNDLE_ARRAY_TOO_LONG',
    });
  });

  // `MAX_IGNORED_ACCOUNT_SECTION_ARRAY_LENGTH`
  // is deliberately scoped to `path === 'bundle' && key === 'account'` — the
  // additive, ignored top-level `account` section — and must NOT leak to
  // `bundle.aggregates.account`, the real financial-account aggregate array,
  // which happens to share the name 'account' as an AggregateType. A well
  // over 100,000-row array here proves the normal `MAX_ARRAY_LENGTH` ceiling
  // still applies: were the carve-out ever loosened to match on `key ===
  // 'account'` alone (a plausible regression given the name collision), this
  // array — well under the 1,000,000 wide ceiling — would silently stop
  // being rejected and this test would fail to throw.
  it('rejects BUNDLE_ARRAY_TOO_LONG on bundle.aggregates.account specifically, never widening past MAX_ARRAY_LENGTH', async () => {
    const big = new Array(100_001).fill({ id: 'x', householdId: HOUSEHOLD_ID, version: 0, schemaVersion: 0, payload: {} });
    const payload = JSON.stringify({
      format: EXPORT_BUNDLE_FORMAT,
      version: EXPORT_BUNDLE_VERSION,
      householdId: HOUSEHOLD_ID,
      aggregates: { account: big },
    });
    const blob = new Blob([payload]);
    await expect(parseImportFile(blob)).rejects.toMatchObject({
      code: 'BUNDLE_ARRAY_TOO_LONG',
    });
  });
});

describe('validateBundle', () => {
  it('accepts a well-formed empty bundle', () => {
    const result = validateBundle(emptyBundle());
    expect(result.bundle.householdId).toBe(HOUSEHOLD_ID);
    expect(result.unknownTypes).toEqual([]);
  });

  it('rejects MALFORMED_BUNDLE on a non-object', () => {
    expect(() => validateBundle(null)).toThrow(DataImportError);
    expect(() => validateBundle('hello')).toThrow(/Bundle envelope is malformed/);
  });

  it('accepts a pre-rename bundle carrying the legacy `retirement-export` marker and normalises it', () => {
    const result = validateBundle({ ...emptyBundle(), format: LEGACY_EXPORT_BUNDLE_FORMAT });
    expect(result.bundle.format).toBe(EXPORT_BUNDLE_FORMAT);
  });

  it('rejects an unknown format marker', () => {
    expect(() => validateBundle({ ...emptyBundle(), format: 'something-else' })).toThrow(
      /Bundle envelope is malformed at format/,
    );
  });

  // Additive-only compatibility: a version-1 bundle carrying the new
  // optional `unresolvedLocalChanges` supplemental section validates cleanly and
  // still resolves the main `aggregates` view. The importer ignores the field.
  it('accepts a version-1 bundle carrying the additive unresolvedLocalChanges field', () => {
    const bundle: any = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: [
          {
            id: 'acc-1',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: currentSchemaVersion('account'),
            payload: { name: 'Checking', kind: 'taxable', currency: 'USD' },
          } as never,
        ],
      },
    });
    bundle.unresolvedLocalChanges = [
      {
        aggregateType: 'account',
        aggregateId: 'acc-1',
        exportedResolution: 'local_view',
        serverAggregate: null,
        localAggregate: null,
        queuedMutations: [],
      },
    ];
    const result = validateBundle(bundle);
    expect(result.bundle.version).toBe(1);
    expect(result.bundle.aggregates.account.map((a) => a.id)).toEqual(['acc-1']);
  });

  it('rejects MALFORMED_BUNDLE on missing format', () => {
    const bad: any = emptyBundle();
    delete bad.format;
    expect(() => validateBundle(bad)).toThrow(/Bundle envelope is malformed at format/);
  });

  it('rejects BUNDLE_VERSION_UNSUPPORTED on a future envelope version', () => {
    const bad = emptyBundle({ version: 99 });
    try {
      validateBundle(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DataImportError);
      expect((err as DataImportError).code).toBe('BUNDLE_VERSION_UNSUPPORTED');
    }
  });

  it('accepts a bundle whose householdId differs from the importing user — the UI is responsible for the cross-household warning', () => {
    // Self-consistent bundle exported from a different household: every
    // aggregate's `householdId` matches the envelope's. validateBundle
    // doesn't take an importing-user id; it just confirms the bundle is
    // internally well-formed. The UI layer decides whether to warn.
    const bundle = emptyBundle({ householdId: OTHER_HOUSEHOLD_ID });
    bundle.aggregates.account = [
      {
        id: 'acc-1',
        householdId: OTHER_HOUSEHOLD_ID,
        aggregateType: 'account',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        deviceId: 'dev-1',
        payload: { name: 'X' } as any,
      },
    ];
    const result = validateBundle(bundle);
    expect(result.bundle.householdId).toBe(OTHER_HOUSEHOLD_ID);
    expect(result.unknownTypes).toEqual([]);
  });

  it('rejects MALFORMED_BUNDLE when an aggregate inside the bundle disagrees with the envelope householdId (intra-bundle consistency)', () => {
    // Envelope says HOUSEHOLD_ID; aggregate says OTHER_HOUSEHOLD_ID.
    // That's a corrupt file, not a cross-household import.
    const bundle = emptyBundle({ householdId: HOUSEHOLD_ID });
    bundle.aggregates.account = [
      {
        id: 'acc-1',
        householdId: OTHER_HOUSEHOLD_ID,
        aggregateType: 'account',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        deviceId: 'dev-1',
        payload: { name: 'X' } as any,
      },
    ];
    try {
      validateBundle(bundle);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DataImportError).code).toBe('MALFORMED_BUNDLE');
    }
  });

  it('rejects AGGREGATE_VERSION_UNSUPPORTED when an aggregate carries a future schemaVersion', () => {
    const bundle = emptyBundle();
    bundle.aggregates.account = [
      {
        id: 'acc-1',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'account',
        schemaVersion: 99,
        version: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        deviceId: 'dev-1',
        payload: { name: 'X' } as any,
      },
    ];
    try {
      validateBundle(bundle);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DataImportError).code).toBe('AGGREGATE_VERSION_UNSUPPORTED');
    }
  });

  it('returns unknown aggregate types in the result instead of throwing', () => {
    const bundle: any = emptyBundle();
    bundle.aggregates.zorblax = [
      { id: 'z-1', householdId: HOUSEHOLD_ID, schemaVersion: 1, payload: {} },
      { id: 'z-2', householdId: HOUSEHOLD_ID, schemaVersion: 1, payload: {} },
    ];
    const result = validateBundle(bundle);
    expect(result.unknownTypes).toEqual([{ type: 'zorblax', count: 2 }]);
    // Known types still present + zero-filled.
    expect(result.bundle.aggregates.account).toEqual([]);
  });

  it('rejects MALFORMED_BUNDLE when an aggregate list is not an array', () => {
    const bundle: any = emptyBundle();
    bundle.aggregates.account = { not: 'array' };
    expect(() => validateBundle(bundle)).toThrow(/expected array/);
  });

  // A bundle carrying the additive `account` section
  // validates cleanly and resolves the SAME `aggregates` view as one without
  // it — the importer never reads the field.
  it('accepts a bundle carrying the additive account section, and the resolved bundle carries no account field', () => {
    const withAccount: any = emptyBundle();
    withAccount.account = {
      user: { userId: 'u-1', email: 'a@example.test', ...LEGACY_USER_LEGAL_FIELDS },
      credential: { updatedAt: '2026-01-01T00:00:00Z', kdf: { algorithm: 'Argon2id' } },
      history: [{ eventId: 'e1', eventType: 'login' }],
      attestations: LEGACY_ATTESTATIONS,
      nextCursor: null,
    };
    const withoutAccount = emptyBundle();

    const resultWith = validateBundle(withAccount);
    const resultWithout = validateBundle(withoutAccount);

    expect(resultWith.bundle).toEqual(resultWithout.bundle);
    expect((resultWith.bundle as any).account).toBeUndefined();
  });
});

describe('applyImport — round-trip drill', () => {
  beforeEach(async () => {
    await clearAllStores();
    setRegisteredDeviceId('test-device');
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('demo data → export → wipe → import yields identical aggregate counts per type', async () => {
    await loadDemoData({
      householdId: HOUSEHOLD_ID,
      email: 'demo@x',
      displayName: 'Demo User',
    });
    const exportedCounts: Record<string, number> = {};
    for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      exportedCounts[t] = (await listAggregates(t)).length;
    }
    const bundle = await buildExportBundle(HOUSEHOLD_ID, 'dev-x');

    await clearAllStores();
    // Confirm the wipe happened.
    expect((await listAggregates('account')).length).toBe(0);

    const result = await applyImport(bundle, HOUSEHOLD_ID);
    for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      const after = (await listAggregates(t)).length;
      expect(after).toBe(exportedCounts[t]);
      expect(result.countsByType[t]).toBe(exportedCounts[t]);
    }
    expect(result.total).toBe(
      Object.values(exportedCounts).reduce((s, n) => s + n, 0),
    );
  });

  // Regression guard for the zero-knowledge encryption boundary:
  // plaintext imports are accepted and queue NORMAL local mutations —
  // imported aggregate payloads stay plaintext in IndexedDB and become
  // encrypted only on the next cloud push, never an encrypted envelope at
  // import time.
  it('accepts a plaintext bundle and queues plaintext local mutations (no encrypted envelopes)', async () => {
    const bundle = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: [
          {
            id: 'acc-plain',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: currentSchemaVersion('account'),
            payload: { name: 'Checking', kind: 'taxable', currency: 'USD' },
          } as never,
        ],
      },
    });

    const result = await applyImport(bundle, HOUSEHOLD_ID);
    expect(result.countsByType.account).toBe(1);

    const pending = await listPendingMutations();
    const queued = pending.find((m) => m.aggregateId === 'acc-plain');
    expect(queued).toBeDefined();
    expect(queued?.operation).toBe('create');

    // The queued payload is the plaintext domain shape, not an envelope.
    const payload = queued?.payload as Record<string, unknown>;
    expect(payload.name).toBe('Checking');
    expect(payload).not.toHaveProperty('ciphertext');
    expect(payload).not.toHaveProperty('nonce');
    expect(payload).not.toHaveProperty('encryptionVersion');

    // And the persisted aggregate in IndexedDB is likewise plaintext.
    const stored = (await listAggregates('account')).find((a) => a.id === 'acc-plain');
    expect(stored).toBeDefined();
    const storedPayload = stored?.payload as Record<string, unknown>;
    expect(storedPayload.name).toBe('Checking');
    expect(storedPayload).not.toHaveProperty('ciphertext');
  });

  it('applies the main aggregates view of a bundle and ignores unresolvedLocalChanges', async () => {
    const base = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: [
          {
            id: 'acc-c2',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: currentSchemaVersion('account'),
            payload: { name: 'Savings', kind: 'taxable', currency: 'USD' },
          } as never,
        ],
      },
    });
    const bundle = {
      ...base,
      unresolvedLocalChanges: [
        {
          aggregateType: 'account',
          aggregateId: 'acc-c2',
          exportedResolution: 'local_view',
          serverAggregate: null,
          localAggregate: null,
          queuedMutations: [],
        },
      ],
    } as unknown as ExportBundle;

    const result = await applyImport(bundle, HOUSEHOLD_ID);
    expect(result.countsByType.account).toBe(1);
    const stored = (await listAggregates('account')).find((a) => a.id === 'acc-c2');
    expect(stored?.payload).toMatchObject({ name: 'Savings' });
  });

  // A bundle carrying the additive `account` section
  // imports EXACTLY as one without it — same aggregate counts, and nothing
  // from the account section (a sentinel-tagged value) is ever written to
  // IndexedDB or queued for the server. No section from someone else's
  // account can land in the importing user's workspace this way.
  it('imports a bundle carrying the account section identically to one without it, and writes nothing from it', async () => {
    const ACCOUNT_SENTINEL = 'ACCOUNT_SECTION_MUST_NEVER_BE_WRITTEN_c1c2b3';
    const base = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: [
          {
            id: 'acc-with-account-section',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: currentSchemaVersion('account'),
            payload: { name: 'Checking', kind: 'taxable', currency: 'USD' },
          } as never,
        ],
      },
    });
    const withAccount = {
      ...base,
      account: {
        user: { userId: ACCOUNT_SENTINEL, ...LEGACY_USER_LEGAL_FIELDS },
        history: [{ eventId: ACCOUNT_SENTINEL }],
        attestations: [{ ...LEGACY_ATTESTATIONS[0], emailSnapshot: ACCOUNT_SENTINEL }],
        nextCursor: null,
      },
    } as unknown as ExportBundle;

    await clearAllStores();
    const resultWith = await applyImport(withAccount, HOUSEHOLD_ID);

    await clearAllStores();
    const resultWithout = await applyImport(base, HOUSEHOLD_ID);

    expect(resultWith.total).toBe(resultWithout.total);
    expect(resultWith.countsByType).toEqual(resultWithout.countsByType);

    const stored = (await listAggregates('account')).find(
      (a) => a.id === 'acc-with-account-section',
    );
    expect(stored).toBeDefined();
    // The sentinel never reaches IndexedDB or the mutation queue anywhere.
    const everyAggregate = (
      await Promise.all(AGGREGATE_TYPES_IN_DEPENDENCY_ORDER.map((t) => listAggregates(t)))
    ).flat();
    expect(JSON.stringify(everyAggregate)).not.toContain(ACCOUNT_SENTINEL);
    const pending = await listPendingMutations();
    expect(JSON.stringify(pending)).not.toContain(ACCOUNT_SENTINEL);
  });

  // A real account with >100,000 retained AuthEvent
  // rows is reachable within the one-year retention window (the exporter
  // never truncates `history` — see account-export.service.ts) — e.g. one
  // successful refresh roughly every five minutes yields ≈105,000 events.
  // Before this fix, `MAX_ARRAY_LENGTH` (100,000) applied uniformly and
  // rejected this otherwise-valid export as BUNDLE_ARRAY_TOO_LONG. The
  // ignored `account` section must accept a boundary case above that ceiling
  // (a value the OLD code would reject; the aggregate-array ceiling below it
  // is untouched by this fix).
  it('round-trips successfully with an account-history section above the 100,000-row ceiling', async () => {
    const history = Array.from({ length: 105_000 }, (_, i) => ({
      eventId: `e${i}`,
      eventType: 'login',
      ip: null,
      userAgent: null,
      metadata: null,
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: 0,
    }));
    const bundle = {
      ...emptyBundle(),
      account: { user: { userId: 'u-1' }, history, nextCursor: null },
    } as unknown as ExportBundle;

    const blob = await gzipJson(bundle);
    const parsed = await parseImportFile(blob);
    const { bundle: validated } = validateBundle(parsed);
    const result = await applyImport(validated, HOUSEHOLD_ID);
    expect(result.total).toBe(0); // no aggregates in this fixture — the account section is ignored either way
  });

  // The exporter's own uncompressed-JSON download
  // option can legitimately produce a file bigger than the OLD flat
  // MAX_INPUT_BYTES (50 MiB) ceiling once account history is large — that
  // ceiling was applied to the plain file's raw on-disk size, which for a
  // NON-gzip file IS its logical content size (unlike a gzip file, where the
  // on-disk size is compressed). The old code rejected the app's own valid
  // plain-JSON export before it was even parsed; the plain-file ceiling must
  // match `MAX_DECOMPRESSED_BYTES` instead.
  it('round-trips a plain (non-gzipped) JSON export above the old 50 MiB flat ceiling', async () => {
    const bundle = {
      ...emptyBundle(),
      // A padding string, not an array — inflates the file past 50 MiB
      // without touching any array-length ceiling. Dropped by validateBundle
      // (the envelope schema doesn't declare `account`), same as every other
      // ignored `account`-section fixture in this file.
      account: { padding: 'x'.repeat(55 * 1024 * 1024) },
    } as unknown as ExportBundle;

    const blob = plainJson(bundle);
    expect(blob.size).toBeGreaterThan(50 * 1024 * 1024);

    const parsed = await parseImportFile(blob);
    const { bundle: validated } = validateBundle(parsed);
    const result = await applyImport(validated, HOUSEHOLD_ID);
    expect(result.total).toBe(0); // no aggregates in this fixture — the account section is ignored either way
  });

  // Export-bundle compatibility: a prior-version
  // (schemaVersion 1) expenseCategory survives applyImport and advances to
  // current (2) lazily on read via the migrate() chain.
  it('migrates an imported schemaVersion:1 expenseCategory to current (2) lazily on read', async () => {
    expect(currentSchemaVersion('expenseCategory')).toBe(2);
    const bundle = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        expenseCategory: [
          {
            id: 'cat-imported',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: 1,
            payload: { name: 'Imported Medical', isMedical: true },
          } as never,
        ],
      },
    });

    const result = await applyImport(bundle, HOUSEHOLD_ID);
    expect(result.countsByType.expenseCategory).toBe(1);

    const stored = (await listAggregates('expenseCategory')).find(
      (c) => c.id === 'cat-imported',
    );
    expect(stored).toBeDefined();
    expect(stored?.schemaVersion).toBe(2);
    expect((stored?.payload as { name: string }).name).toBe('Imported Medical');
    expect((stored?.payload as { isMedical?: boolean }).isMedical).toBe(true);
  });

  // Batched bulk-fill wake: a direct wrapped-caller path proves the
  // `withBatchedStoreSignals` wrap in `applyImport` can't silently no-op — N
  // account rows fire the fine `accounts` signal ONCE on scope exit, not once
  // per row. `applyImport` has no coarse tail, so this fine flush is the wake.
  it('fires one fine store signal per touched store, not one per imported row', async () => {
    const accountsListener = vi.fn();
    const unsubscribe = subscribeToStoreChanges('accounts', accountsListener);
    const bundle = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: [
          {
            id: 'acc-1',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: currentSchemaVersion('account'),
            payload: { name: 'A', kind: 'taxable', currency: 'USD' },
          },
          {
            id: 'acc-2',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: currentSchemaVersion('account'),
            payload: { name: 'B', kind: 'taxable', currency: 'USD' },
          },
          {
            id: 'acc-3',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: currentSchemaVersion('account'),
            payload: { name: 'C', kind: 'taxable', currency: 'USD' },
          },
        ] as never,
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    // Three account rows, one batched fine signal — not three.
    expect(accountsListener).toHaveBeenCalledTimes(1);
    expect((await listAggregates('account')).length).toBe(3);
    unsubscribe();
  });

  it('preserves aggregate ids and payloads through the round-trip', async () => {
    await loadDemoData({
      householdId: HOUSEHOLD_ID,
      email: 'demo@x',
      displayName: 'Demo User',
    });
    const before = await listAggregates('account');
    const beforeIds = before.map((a) => a.id).sort();
    const beforeNames = before.map((a) => (a.payload as any).name).sort();

    const bundle = await buildExportBundle(HOUSEHOLD_ID, 'dev-x');
    await clearAllStores();
    await applyImport(bundle, HOUSEHOLD_ID);

    const after = await listAggregates('account');
    const afterIds = after.map((a) => a.id).sort();
    const afterNames = after.map((a) => (a.payload as any).name).sort();
    expect(afterIds).toEqual(beforeIds);
    expect(afterNames).toEqual(beforeNames);
  });

  it('queues delete mutations for existing aggregates that are not in the bundle', async () => {
    // Seed a "stale" account that is not in the bundle being imported.
    // After the import, this row must have a tombstone mutation queued
    // so the server-side row also disappears once sync flushes; without
    // this, the next pull would resurrect the stale data.
    await putAggregate('account', {
      id: 'acc-stale',
      householdId: HOUSEHOLD_ID,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 5,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd-old',
      payload: {
        name: 'Stale',
        type: 'BROKERAGE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'hm-1',
        institution: '',
        notes: '',
        planningReturnPct: 0,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } as any,
    });

    await applyImport(emptyBundle(), HOUSEHOLD_ID);

    // Stale row tombstoned locally — listAggregates filters out deletes.
    const accounts = await listAggregates('account');
    expect(accounts.find((a) => a.id === 'acc-stale')).toBeUndefined();

    // And queued as a delete mutation so sync propagates the tombstone.
    const pending = await listPendingMutations();
    const tombstone = pending.find(
      (m) => m.aggregateId === 'acc-stale' && m.operation === 'delete',
    );
    expect(tombstone).toBeDefined();
    expect(tombstone?.expectedVersion).toBe(5);
  });

  it('clears stale pending and failed-conflict mutations from a previous broken push', async () => {
    // Mirrors the demo-reload regression: a leftover `failed-conflict`
    // row from an earlier broken import attempt would otherwise keep
    // the SyncBadge stuck on "Refresh needed" even after this clean
    // import flushes — `listFailedConflicts()` is the badge's source of
    // truth, and it was never cleared before this fix.
    await queueMutation({
      id: 'mut-stale-pending',
      aggregateId: 'acc-old-attempt',
      aggregateType: 'account',
      operation: 'create',
      expectedVersion: 0,
      schemaVersion: 1,
      payload: { name: 'stale-pending' },
      timestamp: Date.now(),
      deviceId: 'dev-1',
      status: 'pending',
    });
    await queueMutation({
      id: 'mut-stale-conflict',
      aggregateId: 'acc-old-attempt',
      aggregateType: 'account',
      operation: 'create',
      expectedVersion: 0,
      schemaVersion: 1,
      payload: { name: 'stale-conflict' },
      timestamp: Date.now(),
      deviceId: 'dev-1',
      status: 'failed-conflict',
    });

    await applyImport(emptyBundle(), HOUSEHOLD_ID);

    // Stale entries from the prior failed push are gone. The empty
    // bundle has no aggregates of its own to queue, but applyImport
    // backfills the 8 default expense categories when the bundle is
    // empty — those are intentional, not stale, so filter to the
    // account-typed ids the test seeded.
    const pending = await listPendingMutations();
    expect(pending.find((m) => m.id === 'mut-stale-pending')).toBeUndefined();
    expect(pending.filter((m) => m.aggregateType === 'account')).toEqual([]);
    expect(await listFailedConflicts()).toEqual([]);
  });

  it('queues update against tombstoned cloud rows so import resurrects instead of conflicting', async () => {
    // Mirrors the demo-loader regression on AWS: a previous broken
    // import (or any other path that produced cloud-side tombstones
    // for IDs the new bundle re-applies) leaves `AggregateVersion` at
    // v=N+1 with `deletedAt`. Bootstrap writes those tombstones into
    // IDB. `applyImport` must read tombstones too — otherwise it
    // queues `create @ 0` against a tombstoned cloud row and the
    // server rejects with CONFLICT.
    await putAggregate('account', {
      id: 'acc-tombstoned',
      householdId: HOUSEHOLD_ID,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 9,
      updatedAt: '2026-01-01T00:00:00Z',
      deletedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd-old',
      payload: {
        name: 'Tombstoned',
        type: 'BROKERAGE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'hm-1',
        institution: '',
        notes: '',
        planningReturnPct: 0,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } as any,
    });

    const bundle = emptyBundle({
      aggregates: {
        household: [],
        householdMember: [],
        account: [
          {
            id: 'acc-tombstoned',
            householdId: HOUSEHOLD_ID,
            aggregateType: 'account',
            schemaVersion: 1,
            version: 1,
            updatedAt: '2026-05-01T00:00:00Z',
            deviceId: 'd-bundle',
            payload: {
              name: 'Restored',
              type: 'BROKERAGE',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'POST_TAX',
              ownerId: 'hm-1',
              institution: '',
              notes: '',
              planningReturnPct: 0,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 0,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
            } as any,
          },
        ],
        accountBalance: [],
        socialSecurityBenefit: [],
        scenario: [],
        expenseCategory: [],
        expense: [],
        incomeStream: [],
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    const pending = await listPendingMutations();
    const restored = pending.find((m) => m.aggregateId === 'acc-tombstoned');
    expect(restored).toBeDefined();
    expect(restored?.operation).toBe('update');
    expect(restored?.expectedVersion).toBe(9);
  });

  it('overwrites overlapping ids via update at the local version', async () => {
    // Seed the same id the bundle will replay. The import must queue an
    // update at expectedVersion=existing.version (not a delete + create,
    // which would conflict on push because the server would advance the
    // version on the tombstone).
    await putAggregate('account', {
      id: 'acc-overlap',
      householdId: HOUSEHOLD_ID,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 7,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd-old',
      payload: {
        name: 'Old name',
        type: 'BROKERAGE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'hm-1',
        institution: '',
        notes: '',
        planningReturnPct: 0,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } as any,
    });

    const bundle = emptyBundle({
      aggregates: {
        household: [],
        householdMember: [],
        account: [
          {
            id: 'acc-overlap',
            householdId: HOUSEHOLD_ID,
            aggregateType: 'account',
            schemaVersion: 1,
            version: 7,
            updatedAt: '2026-04-01T00:00:00Z',
            deviceId: 'd-old',
            payload: {
              name: 'New name',
              type: 'BROKERAGE',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'POST_TAX',
              ownerId: 'hm-1',
              institution: '',
              notes: '',
              planningReturnPct: 0,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 0,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
            } as any,
          },
        ],
        accountBalance: [],
        socialSecurityBenefit: [],
        scenario: [],
        expenseCategory: [],
        expense: [],
        incomeStream: [],
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    const pending = await listPendingMutations();
    const overlap = pending.find((m) => m.aggregateId === 'acc-overlap');
    expect(overlap?.operation).toBe('update');
    expect(overlap?.expectedVersion).toBe(7);

    // No delete was queued for the overlapping id.
    const tombstone = pending.find(
      (m) => m.aggregateId === 'acc-overlap' && m.operation === 'delete',
    );
    expect(tombstone).toBeUndefined();

    // Local payload reflects the bundle.
    const accounts = await listAggregates('account');
    const updated = accounts.find((a) => a.id === 'acc-overlap');
    expect((updated?.payload as any).name).toBe('New name');
  });

  it('migrates older-than-current schemaVersion payloads up to current on import', async () => {
    // Synth an account at schemaVersion: 0 (current is 1). The migration
    // chain has no `migrations[0]` step today, so migrate() warns and
    // passes through; queueLocalMutation persists it at the current
    // schemaVersion. The contract this test guards: import never stores
    // an aggregate at a schemaVersion higher than the registry knows
    // *for that type*, and never lower than current.
    const bundle = emptyBundle({
      aggregates: {
        household: [],
        householdMember: [],
        account: [
          {
            id: 'acc-old',
            householdId: HOUSEHOLD_ID,
            aggregateType: 'account',
            schemaVersion: 0,
            version: 1,
            updatedAt: '2024-01-01T00:00:00Z',
            deviceId: 'dev-old',
            payload: {
              name: 'Old account',
              type: 'BROKERAGE',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'POST_TAX',
              ownerId: 'hm-1',
              institution: '',
              notes: '',
              planningReturnPct: 5,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 0,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
            } as any,
          },
        ],
        accountBalance: [],
        socialSecurityBenefit: [],
        scenario: [],
        expenseCategory: [],
        expense: [],
        incomeStream: [],
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    const accounts = await listAggregates('account');
    expect(accounts).toHaveLength(1);
    // `account` is at schemaVersion 6 (HSA v1→v2 + Roth v2→v3 tax-treatment
    // migrations + v3→v4 contributionGrowthPct add + v4→v5 Roth distribution-
    // tax facts + v5→v6 RMD profile facts). Import brings the older payload up
    // to current; every step is a no-op for a non-HSA, non-Roth (BROKERAGE)
    // account with no stored growth rate / Roth / RMD facts, so only the stored
    // version advances.
    expect(accounts[0].schemaVersion).toBe(currentSchemaVersion('account'));
    expect((accounts[0].payload as any).name).toBe('Old account');
  });

  it('carries populated v4 Roth facts through the real applyImport→migrate path', async () => {
    // A v4 account payload carrying the full Roth fact set, imported through
    // the REAL applyImport code path, proving the full import (not only a direct
    // migrate() call) carries the year facts through and strips the two Roth-basis
    // dollar totals at v6→v7. The conversion-lot
    // array is along for the ride: it is a retired key nothing reads, so the
    // corrupt-year entry inside it is no longer sanitised either.
    const bundle = emptyBundle({
      aggregates: {
        household: [],
        householdMember: [],
        account: [
          {
            id: 'acc-roth-v4',
            householdId: HOUSEHOLD_ID,
            aggregateType: 'account',
            schemaVersion: 4,
            version: 1,
            updatedAt: '2024-01-01T00:00:00Z',
            deviceId: 'dev-roth',
            payload: {
              name: 'Imported Roth',
              type: 'RETIREMENT_ROTH_IRA',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'ROTH',
              ownerId: 'hm-1',
              institution: '',
              notes: '',
              planningReturnPct: 6,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 3000,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
              rothIraRegularContributionBasis: 30000,
              rothIraFirstContributionTaxYear: 2015,
              rothIraConversionLots: [
                { taxYear: 2018, taxableConvertedPrincipal: 8000, nontaxableConvertedPrincipal: 2000 },
                { taxYear: 1990, taxableConvertedPrincipal: 5, nontaxableConvertedPrincipal: 0 }, // corrupt year → dropped
              ],
              designatedRothBasis: 45000,
              designatedRothFirstParticipationTaxYear: 2012,
            } as any,
          },
        ],
        accountBalance: [],
        socialSecurityBenefit: [],
        scenario: [],
        expenseCategory: [],
        expense: [],
        incomeStream: [],
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    const accounts = await listAggregates('account');
    const roth = accounts.find((a) => a.id === 'acc-roth-v4');
    expect(roth?.schemaVersion).toBe(currentSchemaVersion('account'));
    const p = roth?.payload as any;
    // Both stored basis totals are mapped to undefined (never deleted — the
    // policy keeps the key so an older snapshot's key set is preserved); both
    // year facts survive.
    expect('rothIraRegularContributionBasis' in p).toBe(true);
    expect(p.rothIraRegularContributionBasis).toBeUndefined();
    expect(p.rothIraFirstContributionTaxYear).toBe(2015);
    expect('designatedRothBasis' in p).toBe(true);
    expect(p.designatedRothBasis).toBeUndefined();
    expect(p.designatedRothFirstParticipationTaxYear).toBe(2012);
    // The retired lot array rides through VERBATIM, corrupt entry and all. The
    // v4→v5 step used to sanitise it; that went with the keys, because nothing
    // reads them and a CWE-20 guard earns its cost only where the value reaches
    // an engine. The array is an inert stored key here — both dated Roth facts
    // now come from the balance rows — and it disappears the next time the
    // account is saved, since the editor rebuilds the payload from scratch.
    expect(p.rothIraConversionLots).toEqual([
      { taxYear: 2018, taxableConvertedPrincipal: 8000, nontaxableConvertedPrincipal: 2000 },
      { taxYear: 1990, taxableConvertedPrincipal: 5, nontaxableConvertedPrincipal: 0 },
    ]);
  });

  it('a v6 bundle carrying both stored basis totals loses them at v6→v7, the version real households are on', async () => {
    // Unlike the synthesized v4 bundle exercising the whole v4→v7 chain,
    // this is the version real households were actually on — the only one that
    // exercises the new v6→v7 step ALONE.
    const bundle = emptyBundle({
      aggregates: {
        household: [],
        householdMember: [],
        account: [
          {
            id: 'acc-roth-v6',
            householdId: HOUSEHOLD_ID,
            aggregateType: 'account',
            schemaVersion: 6,
            version: 1,
            updatedAt: '2024-01-01T00:00:00Z',
            deviceId: 'dev-roth-v6',
            payload: {
              name: 'Imported Roth v6',
              type: 'RETIREMENT_ROTH_IRA',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'ROTH',
              ownerId: 'hm-1',
              institution: '',
              notes: '',
              planningReturnPct: 6,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 3000,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
              rothIraRegularContributionBasis: 22000,
              rothIraFirstContributionTaxYear: 2013,
              designatedRothBasis: 33000,
              designatedRothFirstParticipationTaxYear: 2011,
            } as any,
          },
        ],
        accountBalance: [],
        socialSecurityBenefit: [],
        scenario: [],
        expenseCategory: [],
        expense: [],
        incomeStream: [],
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    const accounts = await listAggregates('account');
    const roth = accounts.find((a) => a.id === 'acc-roth-v6');
    expect(roth?.schemaVersion).toBe(currentSchemaVersion('account'));
    const p = roth?.payload as any;
    expect('rothIraRegularContributionBasis' in p).toBe(true);
    expect(p.rothIraRegularContributionBasis).toBeUndefined();
    expect(p.rothIraFirstContributionTaxYear).toBe(2013);
    expect('designatedRothBasis' in p).toBe(true);
    expect(p.designatedRothBasis).toBeUndefined();
    expect(p.designatedRothFirstParticipationTaxYear).toBe(2011);
  });

  it('carries valid v5 RMD facts through applyImport→migrate to v6 (and sanitises a corrupt one)', async () => {
    // A v5 account payload carrying RMD profile facts — including a
    // deliberately-corrupt (out-of-bounds) inherited-owner death date that the
    // v5→v6 step must DROP, not preserve — imported through the REAL applyImport
    // path (every `current` bump needs a synthesised prior-version round trip).
    const bundle = emptyBundle({
      aggregates: {
        household: [],
        householdMember: [],
        account: [
          {
            id: 'acc-rmd-v5',
            householdId: HOUSEHOLD_ID,
            aggregateType: 'account',
            schemaVersion: 5,
            version: 1,
            updatedAt: '2024-01-01T00:00:00Z',
            deviceId: 'dev-rmd',
            payload: {
              name: 'Imported Inherited IRA',
              type: 'RETIREMENT_IRA',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'PRE_TAX',
              ownerId: 'hm-1',
              institution: '',
              notes: '',
              planningReturnPct: 6,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 0,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
              rmdInheritedAccount: true,
              rmdBeneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
              rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
              rmdInheritedOwnerDeathDate: '9999-12-31', // out-of-bounds → dropped
              rmdInheritedOwnerDiedOnOrAfterRbd: false,
              rmdBeneficiaryBirthdate: '1985-02-20',
            } as any,
          },
        ],
        accountBalance: [],
        socialSecurityBenefit: [],
        scenario: [],
        expenseCategory: [],
        expense: [],
        incomeStream: [],
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    const accounts = await listAggregates('account');
    const rmd = accounts.find((a) => a.id === 'acc-rmd-v5');
    expect(rmd?.schemaVersion).toBe(currentSchemaVersion('account'));
    const p = rmd?.payload as any;
    // Valid facts preserved.
    expect(p.rmdInheritedAccount).toBe(true);
    expect(p.rmdBeneficiaryType).toBe('DISABLED_OR_CHRONICALLY_ILL');
    expect(p.rmdBeneficiaryElection).toBe('LIFE_EXPECTANCY');
    expect(p.rmdInheritedOwnerDiedOnOrAfterRbd).toBe(false);
    expect(p.rmdBeneficiaryBirthdate).toBe('1985-02-20');
    // The out-of-bounds death date is sanitised out (never invented).
    expect('rmdInheritedOwnerDeathDate' in p).toBe(false);
  });

  it('reassigns aggregates from a cross-household bundle to the importing user', async () => {
    // Bundle was exported under OTHER_HOUSEHOLD_ID. The importing user
    // is HOUSEHOLD_ID. After applyImport, the local row + queued
    // mutation must carry HOUSEHOLD_ID, not the bundle's original.
    const bundle = emptyBundle({
      householdId: OTHER_HOUSEHOLD_ID,
      aggregates: {
        household: [],
        householdMember: [],
        account: [
          {
            id: 'acc-foreign',
            householdId: OTHER_HOUSEHOLD_ID,
            aggregateType: 'account',
            schemaVersion: 1,
            version: 1,
            updatedAt: '2026-01-01T00:00:00Z',
            deviceId: 'dev-foreign',
            payload: {
              name: 'Foreign account',
              type: 'BROKERAGE',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'POST_TAX',
              ownerId: 'hm-foreign',
              institution: '',
              notes: '',
              planningReturnPct: 0,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 0,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
            } as any,
          },
        ],
        accountBalance: [],
        socialSecurityBenefit: [],
        scenario: [],
        expenseCategory: [],
        expense: [],
        incomeStream: [],
      },
    });

    await applyImport(bundle, HOUSEHOLD_ID);

    const accounts = await listAggregates('account');
    expect(accounts).toHaveLength(1);
    expect(accounts[0].householdId).toBe(HOUSEHOLD_ID);
    expect((accounts[0].payload as any).name).toBe('Foreign account');

    const pending = await listPendingMutations();
    const m = pending.find((p) => p.aggregateId === 'acc-foreign');
    expect(m).toBeDefined();
    // Cross-household = ids new to the target household → create at v0.
    expect(m?.operation).toBe('create');
    expect(m?.expectedVersion).toBe(0);
  });

  it('round-trips a synthesized expense bundle preserving discretionaryGlide', async () => {
    // Export-bundle compatibility regression for the per-expense
    // discretionaryGlide field.
    // Synthesized inline — the repo has never used on-disk version
    // fixtures. Pre-launch v1 reset: every aggregate is at schemaVersion
    // 1, so a v1 payload carrying a glide must round-trip intact at v1.
    const glide = {
      endMultiplierPct: 70,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
      floor: {
        multiplierPct: 50,
        anchor: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
      },
    };
    const bundle = emptyBundle();
    bundle.aggregates.expense = [
      {
        id: 'exp-v1',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'expense',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-15T00:00:00Z',
        deviceId: 'dev-1',
        payload: {
          name: 'Travel',
          amount: 1000,
          frequency: 'yearly',
          classification: 'discretionary',
          categoryId: 'cat-fun',
          start: { kind: 'retirementStart' },
          end: { kind: 'lifetime', whose: 'last' },
          discretionaryGlide: glide,
        } as never,
      },
    ];

    await applyImport(bundle, HOUSEHOLD_ID);

    const expenses = await listAggregates('expense');
    const imported = expenses.find((e) => e.id === 'exp-v1');
    expect(imported).toBeDefined();
    // schemaVersion stays at the current v1 (pre-launch v1 reset)…
    expect(imported?.schemaVersion).toBe(1);
    // …and the round-trip preserves the payload intact.
    expect(
      (imported?.payload as { discretionaryGlide: unknown })
        .discretionaryGlide,
    ).toEqual(glide);
    expect((imported?.payload as { name: string }).name).toBe('Travel');
  });

  it('round-trips an INCREASING glide on an ESSENTIAL expense intact at v1 (extended)', async () => {
    // The widened range (endMultiplierPct > 100) + a ceiling, on an
    // essential expense — the same serialized shape that v44 now
    // activates — must survive export → import byte-identical at v1
    // (no schema bump).
    const glide = {
      endMultiplierPct: 150,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
      floor: {
        multiplierPct: 180,
        anchor: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
      },
    };
    const bundle = emptyBundle();
    bundle.aggregates.expense = [
      {
        id: 'exp-care',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'expense',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-06-22T00:00:00Z',
        deviceId: 'dev-1',
        payload: {
          name: 'Care',
          amount: 2000,
          frequency: 'monthly',
          classification: 'essential',
          categoryId: 'cat-medical',
          start: { kind: 'retirementStart' },
          end: { kind: 'lifetime', whose: 'last' },
          discretionaryGlide: glide,
        } as never,
      },
    ];

    await applyImport(bundle, HOUSEHOLD_ID);

    const expenses = await listAggregates('expense');
    const imported = expenses.find((e) => e.id === 'exp-care');
    expect(imported).toBeDefined();
    expect(imported?.schemaVersion).toBe(1);
    expect(
      (imported?.payload as { discretionaryGlide: unknown })
        .discretionaryGlide,
    ).toEqual(glide);
    expect((imported?.payload as { classification: string }).classification).toBe(
      'essential',
    );
  });

  it('round-trips a scenario patch carrying a null clear-marker, lazily advancing v1 → v2', async () => {
    // The income/expenses sparse patch value type widened to allow a
    // per-key `null` clear-marker (PatchWithClears). The `null` must
    // survive the import write→read intact (stripping happens only at
    // resolve time, never at the storage layer), and a synthesized v1
    // scenario bundle must lazily advance to the current v2 via the
    // identity migration.
    const bundle = emptyBundle();
    bundle.aggregates.scenario = [
      {
        id: 'sc-clear',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'scenario',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-20T00:00:00Z',
        deviceId: 'dev-1',
        payload: {
          name: 'No pension link',
          description: '',
          parentScenarioId: null,
          isPrimary: true,
          notes: '',
          overrides: {
            income: {
              patches: {
                'aggregate:i1': { linkedCbpAccountId: null },
              },
            },
          },
        } as never,
      },
    ];

    await applyImport(bundle, HOUSEHOLD_ID);

    const scenarios = await listAggregates('scenario');
    const imported = scenarios.find((s) => s.id === 'sc-clear');
    expect(imported).toBeDefined();
    // The v1 bundle row lazily advances to the current scenario version…
    expect(imported?.schemaVersion).toBe(currentSchemaVersion('scenario'));
    expect(imported?.schemaVersion).toBe(9);
    // …and the per-key `null` clear-marker survives storage intact.
    const patch = (
      imported?.payload as {
        overrides: {
          income: { patches: Record<string, Record<string, unknown>> };
        };
      }
    ).overrides.income.patches['aggregate:i1'];
    expect(patch).toHaveProperty('linkedCbpAccountId', null);
  });

  it('round-trips a v7 scenario carrying accountFloors, lazily advancing v7 → v8', async () => {
    // A synthesized prior-version (v7) bundle whose scenario aggregate already
    // carries the additive `accountFloors` section must survive applyImport and
    // lazily advance to the current scenario version (v8) on read, with the
    // floor payload intact.
    const floors = {
      perAccount: {
        'acct-hsa': { floorDollars: 10000, hsaMode: 'strict' },
        'acct-brokerage': { floorDollars: 25000 },
      },
    };
    const bundle = emptyBundle();
    bundle.aggregates.scenario = [
      {
        id: 'sc-floor',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'scenario',
        schemaVersion: 7,
        version: 1,
        updatedAt: '2026-06-26T00:00:00Z',
        deviceId: 'dev-1',
        payload: {
          name: 'Floored',
          description: '',
          parentScenarioId: null,
          isPrimary: true,
          notes: '',
          overrides: { accountFloors: floors },
        } as never,
      },
    ];

    await applyImport(bundle, HOUSEHOLD_ID);

    const scenarios = await listAggregates('scenario');
    const imported = scenarios.find((s) => s.id === 'sc-floor');
    expect(imported).toBeDefined();
    // The v7 bundle row lazily advances to the current scenario version…
    expect(imported?.schemaVersion).toBe(currentSchemaVersion('scenario'));
    expect(imported?.schemaVersion).toBe(9);
    // …and the floor payload survives storage intact (identity migration).
    const stored = (
      imported?.payload as { overrides: { accountFloors: typeof floors } }
    ).overrides.accountFloors;
    expect(stored).toEqual(floors);
  });

  it('coerces a v9 bundle carrying combinedPot to taxEfficient at the import boundary (a)', () => {
    // A bundle already AT the current scenario schemaVersion (v9) skips the
    // v8→v9 migration's `schemaVersion < current` gate, so the resolver-boundary
    // coercion in data-import.ts is the ONLY thing that corrects a residual
    // retired-strategy value. Proves the schemaVersion-equals bypass is closed.
    return (async () => {
      const bundle = emptyBundle();
      bundle.aggregates.scenario = [
        {
          id: 'sc-cp',
          householdId: HOUSEHOLD_ID,
          aggregateType: 'scenario',
          schemaVersion: currentSchemaVersion('scenario'),
          version: 1,
          updatedAt: '2026-06-27T00:00:00Z',
          deviceId: 'dev-1',
          payload: { overrides: { withdrawalStrategy: { kind: 'combinedPot' } } } as never,
        },
      ];
      await applyImport(bundle, HOUSEHOLD_ID);
      const scenarios = await listAggregates('scenario');
      const imported = scenarios.find((s) => s.id === 'sc-cp');
      expect(imported).toBeDefined();
      const strategy = (
        imported?.payload as { overrides: { withdrawalStrategy?: { kind: string } } }
      ).overrides.withdrawalStrategy;
      expect(strategy).toEqual({ kind: 'taxEfficient' });
    })();
  });

  it('coerces a present-but-null withdrawalStrategy to taxEfficient at the import boundary (a)', () => {
    // A present key with a malformed value (here: null) is coerced — only a
    // truly ABSENT key is left untouched.
    return (async () => {
      const bundle = emptyBundle();
      bundle.aggregates.scenario = [
        {
          id: 'sc-null',
          householdId: HOUSEHOLD_ID,
          aggregateType: 'scenario',
          schemaVersion: currentSchemaVersion('scenario'),
          version: 1,
          updatedAt: '2026-06-27T00:00:00Z',
          deviceId: 'dev-1',
          payload: { overrides: { withdrawalStrategy: null } } as never,
        },
      ];
      await applyImport(bundle, HOUSEHOLD_ID);
      const scenarios = await listAggregates('scenario');
      const imported = scenarios.find((s) => s.id === 'sc-null');
      expect(imported).toBeDefined();
      const strategy = (
        imported?.payload as { overrides: { withdrawalStrategy?: { kind: string } } }
      ).overrides.withdrawalStrategy;
      expect(strategy).toEqual({ kind: 'taxEfficient' });
    })();
  });

  it('coerces an unrecognised withdrawalStrategy kind to taxEfficient at the import boundary (a)', () => {
    // A present object whose `.kind` is not a named strategy is coerced.
    return (async () => {
      const bundle = emptyBundle();
      bundle.aggregates.scenario = [
        {
          id: 'sc-unknown',
          householdId: HOUSEHOLD_ID,
          aggregateType: 'scenario',
          schemaVersion: currentSchemaVersion('scenario'),
          version: 1,
          updatedAt: '2026-06-27T00:00:00Z',
          deviceId: 'dev-1',
          payload: { overrides: { withdrawalStrategy: { kind: 'unknownStrategy' } } } as never,
        },
      ];
      await applyImport(bundle, HOUSEHOLD_ID);
      const scenarios = await listAggregates('scenario');
      const imported = scenarios.find((s) => s.id === 'sc-unknown');
      expect(imported).toBeDefined();
      const strategy = (
        imported?.payload as { overrides: { withdrawalStrategy?: { kind: string } } }
      ).overrides.withdrawalStrategy;
      expect(strategy).toEqual({ kind: 'taxEfficient' });
    })();
  });

  it('rejects AGGREGATE_VERSION_UNSUPPORTED for a floored scenario above the current schemaVersion', () => {
    // A floored scenario stored ABOVE the client's current scenario version is
    // schema-ahead and must be rejected at validate time (the schema-ahead
    // guard the floor bump drives).
    const bundle = emptyBundle();
    bundle.aggregates.scenario = [
      {
        id: 'sc-ahead',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'scenario',
        schemaVersion: currentSchemaVersion('scenario') + 1,
        version: 1,
        updatedAt: '2026-06-26T00:00:00Z',
        deviceId: 'dev-1',
        payload: { overrides: { accountFloors: { perAccount: {} } } } as never,
      },
    ];
    try {
      validateBundle(bundle);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DataImportError).code).toBe('AGGREGATE_VERSION_UNSUPPORTED');
    }
  });

  it('rejects a future (v99) scenario schemaVersion via the schema-ahead guard', async () => {
    // The v1→v2 bump keeps the existing AGGREGATE_VERSION_UNSUPPORTED
    // rejection: a scenario row ahead of the registry's current version is
    // refused rather than mis-resolved.
    const bundle = emptyBundle();
    bundle.aggregates.scenario = [
      {
        id: 'sc-future',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'scenario',
        schemaVersion: 99,
        version: 1,
        updatedAt: '2026-05-20T00:00:00Z',
        deviceId: 'dev-1',
        payload: { name: 'Future', overrides: {} } as never,
      },
    ];
    try {
      validateBundle(bundle);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DataImportError).code).toBe('AGGREGATE_VERSION_UNSUPPORTED');
    }
  });
});

describe('applyImport — pre-v4 account / pre-v7 scenario migration round-trip', () => {
  beforeEach(async () => {
    await clearAllStores();
    setRegisteredDeviceId('test-device');
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('migrates a synthesized pre-v4 account up to v4, preserving a valid contributionGrowthPct', async () => {
    const bundle = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: [
          {
            id: 'acc-old',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: 3,
            payload: {
              name: '401k',
              type: 'RETIREMENT_401K',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'PRE_TAX',
              ownerId: 'm1',
              institution: 'Fidelity',
              notes: '',
              planningReturnPct: 6,
              active: true,
              plannedContributionPreTax: 12000,
              plannedContributionPostTax: 0,
              contributionGrowthPct: 2.5,
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
            },
          } as never,
        ],
      },
    });
    const result = await applyImport(bundle, HOUSEHOLD_ID);
    expect(result.countsByType.account).toBe(1);
    const stored = (await listAggregates('account')).find((a) => a.id === 'acc-old');
    expect((stored?.payload as Record<string, unknown>).contributionGrowthPct).toBe(2.5);
  });

  it('drops a corrupt stored contributionGrowthPct on a pre-v4 account (→ tracks-inflation)', async () => {
    const bundle = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: [
          {
            id: 'acc-corrupt',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: 3,
            payload: {
              name: 'Brokerage',
              type: 'BROKERAGE',
              ownershipType: 'INDIVIDUAL',
              taxTreatment: 'POST_TAX',
              ownerId: 'm1',
              institution: '',
              notes: '',
              planningReturnPct: 6,
              active: true,
              plannedContributionPreTax: 0,
              plannedContributionPostTax: 6000,
              contributionGrowthPct: 9999, // out of band
              assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
            },
          } as never,
        ],
      },
    });
    await applyImport(bundle, HOUSEHOLD_ID);
    const stored = (await listAggregates('account')).find((a) => a.id === 'acc-corrupt');
    expect(
      'contributionGrowthPct' in (stored?.payload as Record<string, unknown>),
    ).toBe(false);
  });

  it('migrates a synthesized pre-v7 scenario up to v7, preserving a per-account growth override', async () => {
    const bundle = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        scenario: [
          {
            id: 'scn-old',
            householdId: HOUSEHOLD_ID,
            version: 0,
            schemaVersion: 6,
            payload: {
              name: 'Aggressive savings',
              description: '',
              parentScenarioId: null,
              isPrimary: true,
              notes: '',
              overrides: {
                accountContributions: {
                  perAccount: { 'acc-old': { contributionGrowthPct: 6 } },
                },
              },
            },
          } as never,
        ],
      },
    });
    await applyImport(bundle, HOUSEHOLD_ID);
    const stored = (await listAggregates('scenario')).find((s) => s.id === 'scn-old');
    const overrides = (stored?.payload as Record<string, unknown>).overrides as {
      accountContributions: { perAccount: Record<string, Record<string, number>> };
    };
    expect(overrides.accountContributions.perAccount['acc-old'].contributionGrowthPct).toBe(6);
  });

  it('still rejects an ahead-of-current account schemaVersion at the validate gate', () => {
    // The future-version rejection lives in `validateBundle` (the read-path
    // schema-ahead guard); the new v4/v7 currents do not loosen it.
    const bundle = emptyBundle();
    bundle.aggregates.account = [
      {
        id: 'acc-future',
        householdId: HOUSEHOLD_ID,
        aggregateType: 'account',
        schemaVersion: 99,
        version: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        deviceId: 'dev-1',
        payload: { name: 'X' } as never,
      },
    ];
    try {
      validateBundle(bundle);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DataImportError).code).toBe('AGGREGATE_VERSION_UNSUPPORTED');
    }
  });

  it('round-trips the four designated-Roth employer-plan account types intact', async () => {
    // Regression guard: the four new types must survive export → import
    // without payload mutation (legal-value widening, no schemaVersion bump).
    const newTypes = [
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ] as const;
    const bundle = emptyBundle({
      aggregates: {
        ...emptyBundle().aggregates,
        account: newTypes.map((t, i) => ({
          id: `acc-roth-${i}`,
          householdId: HOUSEHOLD_ID,
          version: 1,
          aggregateType: 'account',
          schemaVersion: currentSchemaVersion('account'),
          updatedAt: '2026-06-23T00:00:00Z',
          deviceId: 'dev-x',
          payload: {
            name: `Demo ${t}`,
            type: t,
            ownershipType: 'INDIVIDUAL' as const,
            taxTreatment: 'ROTH' as const,
            ownerId: 'm1',
            institution: 'Test Bank',
            notes: null,
            planningReturnPct: 7,
            active: true,
            plannedContributionPreTax: 0,
            plannedContributionPostTax: 2000,
            assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
          },
        })) as never,
      },
    });

    const result = await applyImport(bundle, HOUSEHOLD_ID);
    expect(result.countsByType.account).toBe(4);

    const stored = (await listAggregates('account')) as unknown as { id: string; payload: { type: string } }[];
    const storedTypes = stored.map((a) => a.payload.type).sort();
    expect(storedTypes).toEqual([...newTypes].sort());
  });
});
