/**
 * Unit tests for the server-authoritative "Export my data" merge.
 * Drives the pure merge/materialize
 * helpers plus `buildServerAuthoritativeExportBundle` with a fake sync transport
 * and injected read-only local stores, so every verification criterion is
 * proven without a real bootstrap/pull or IndexedDB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentSchemaVersion } from '../db/migrations';
import type { Aggregate, AggregateType, PendingMutation } from '../db/types';
import type {
  BootstrapResponseBody,
  PullResponseBody,
  SnapshotListItem,
} from '../sync/types';
import { SyncApiError, type SyncTransport } from '../sync/sync-client';

// `exportServerData`'s format branch (6.test-coverage.1) ends in
// `triggerBrowserDownload`, which touches `document` — unavailable under this
// file's `node` test environment. Replace ONLY that DOM-touching function
// with a spy; `plainJson`/`gzipJson`/`exportFilename`/`exportFilenameJson`
// stay real, so the test still exercises the actual format-branch behavior
// (real uncompressed vs. real gzipped blob), not a mock standing in for it.
const triggerBrowserDownload = vi.fn();
vi.mock('./data-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data-export')>();
  return { ...actual, triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownload(...args) };
});

// The wait-notice raiser is mocked at the
// module boundary — its own drop/coalesce behaviour is covered by
// `toast-queue.test.ts`; this file proves only that a `SyncApiError` raised
// through THIS call site (unlike the sync loop) triggers it.
const raiseWaitNotice = vi.fn();
vi.mock('./toast-queue', () => ({
  raiseWaitNotice: (...args: unknown[]) => raiseWaitNotice(...args),
}));

import {
  RETAINED_INTENT_STATUSES,
  ServerDataExportError,
  buildServerAuthoritativeExportBundle,
  exportServerData,
  fetchServerAuthoritativeState,
  materializeServerState,
  mergeServerExportBundle,
} from './server-data-export';

const HH = 'hh-1';
const DEV = 'dev-1';

// ---------- fixtures ----------

function agg(
  type: AggregateType,
  id: string,
  over: Partial<Aggregate> = {},
): Aggregate {
  return {
    id,
    householdId: HH,
    aggregateType: type,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deviceId: DEV,
    payload: { name: id },
    ...over,
  };
}

function snapAgg(
  type: AggregateType,
  id: string,
  over: Partial<BootstrapResponseBody['workspaceSnapshot']['aggregates'][number]> = {},
) {
  return {
    id,
    householdId: HH,
    aggregateType: type,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deviceId: DEV,
    payload: { name: id },
    ...over,
  };
}

function change(
  type: AggregateType,
  id: string,
  operation: 'create' | 'update' | 'delete',
  over: Partial<PullResponseBody['changes'][number]> = {},
) {
  return {
    aggregateId: id,
    aggregateType: type,
    operation,
    payload: { name: id },
    version: 2,
    schemaVersion: 1,
    updatedAt: '2026-02-01T00:00:00.000Z',
    deviceId: DEV,
    ...over,
  };
}

function mut(
  type: AggregateType,
  id: string,
  operation: 'create' | 'update' | 'delete',
  over: Partial<PendingMutation> = {},
): PendingMutation {
  return {
    id: `m-${id}-${operation}`,
    aggregateId: id,
    aggregateType: type,
    operation,
    expectedVersion: 0,
    schemaVersion: 1,
    payload: { name: id },
    timestamp: 1000,
    deviceId: DEV,
    status: 'pending',
    ...over,
  };
}

function bootstrapBody(
  aggregates: ReturnType<typeof snapAgg>[],
  postSnapshotMutations: ReturnType<typeof change>[] = [],
): BootstrapResponseBody {
  return {
    snapshotId: 'snap-1',
    workspaceSnapshot: { householdId: HH, aggregates },
    postSnapshotMutations,
    syncCursor: 'cursor-0',
    timestamp: '2026-03-01T00:00:00.000Z',
  };
}

function pullBody(
  changes: ReturnType<typeof change>[] = [],
  over: Partial<PullResponseBody> = {},
): PullResponseBody {
  return { changes, newCursor: 'cursor-1', hasMore: false, ...over };
}

/** Fake transport: only bootstrap + pull are used; the mutating legs are spies
 *  we assert are NEVER called (read-only guarantee). */
function fakeTransport(opts: {
  bootstrap: BootstrapResponseBody | (() => Promise<BootstrapResponseBody>);
  pulls?: PullResponseBody[];
}): {
  transport: SyncTransport;
  push: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  clearWorkspace: ReturnType<typeof vi.fn>;
  pullCalls: Array<{ since: string }>;
} {
  const push = vi.fn();
  const restore = vi.fn();
  const clearWorkspace = vi.fn();
  const pullCalls: Array<{ since: string }> = [];
  const pulls = opts.pulls ?? [pullBody()];
  let pullIdx = 0;
  const transport: SyncTransport = {
    push: push as unknown as SyncTransport['push'],
    async bootstrap() {
      return typeof opts.bootstrap === 'function' ? opts.bootstrap() : opts.bootstrap;
    },
    async pull(args) {
      pullCalls.push(args);
      const page = pulls[Math.min(pullIdx, pulls.length - 1)];
      pullIdx += 1;
      return page!;
    },
    async listSnapshots(): Promise<SnapshotListItem[]> {
      return [];
    },
    restore: restore as unknown as SyncTransport['restore'],
    clearWorkspace: clearWorkspace as unknown as SyncTransport['clearWorkspace'],
  };
  return { transport, push, restore, clearWorkspace, pullCalls };
}

function localReader(byType: Partial<Record<AggregateType, Aggregate[]>>) {
  return async (type: AggregateType): Promise<Aggregate[]> => byType[type] ?? [];
}

async function build(opts: {
  bootstrap: BootstrapResponseBody | (() => Promise<BootstrapResponseBody>);
  pulls?: PullResponseBody[];
  local?: Partial<Record<AggregateType, Aggregate[]>>;
  mutations?: PendingMutation[];
  fetchAccount?: () => Promise<Record<string, unknown>>;
}) {
  const t = fakeTransport({ bootstrap: opts.bootstrap, pulls: opts.pulls });
  const bundle = await buildServerAuthoritativeExportBundle({
    transport: t.transport,
    householdId: HH,
    deviceId: DEV,
    readLocalAggregates: localReader(opts.local ?? {}),
    readAllMutations: async () => opts.mutations ?? [],
    fetchAccount: opts.fetchAccount,
  });
  return { bundle, t };
}

// ---------- retained-intent contract ----------

describe('RETAINED_INTENT_STATUSES', () => {
  it('covers exactly the four unsynced-intent statuses', () => {
    expect([...RETAINED_INTENT_STATUSES].sort()).toEqual([
      'failed-conflict',
      'failed-error',
      'pending',
      'pushing',
    ]);
  });
});

// ---------- materialize ----------

describe('materializeServerState', () => {
  it('applies snapshot + post-snapshot mutations + tombstones, later writes overriding', () => {
    const boot = bootstrapBody(
      [snapAgg('account', 'A', { version: 1 })],
      [
        change('account', 'A', 'update', { version: 2, updatedAt: '2026-02-02T00:00:00.000Z' }),
        change('account', 'B', 'delete', { version: 3, updatedAt: '2026-02-03T00:00:00.000Z' }),
        change('account', 'C', 'create', { version: 1 }),
      ],
    );
    const pulls = [pullBody([change('account', 'C', 'update', { version: 5, payload: { name: 'C5' } })])];
    const state = materializeServerState(boot, pulls, HH);
    const accounts = state.get('account')!;
    expect(accounts.get('A')!.version).toBe(2);
    expect(accounts.get('B')!.deletedAt).toBe('2026-02-03T00:00:00.000Z'); // tombstone preserved
    expect(accounts.get('C')!.version).toBe(5); // pull override wins
    expect(accounts.get('C')!.payload).toEqual({ name: 'C5' });
  });

  // The normal bootstrap/pull apply writes a served row to
  // IndexedDB at the server's schemaVersion and every READ migrates it on the
  // way out; this export never writes the server state, so it has to run the
  // migrate() chain itself — or a snapshot / pull row still at `account` v6
  // would carry the removed Roth-basis dollar totals into the file verbatim.
  it('migrates a schema-behind served row in memory (a v6 account loses the removed Roth basis totals, keeps its year fact)', () => {
    const boot = bootstrapBody([
      snapAgg('account', 'A', {
        schemaVersion: 6,
        payload: {
          type: 'RETIREMENT_ROTH_IRA',
          rothIraRegularContributionBasis: 30000,
          rothIraFirstContributionTaxYear: 2015,
        },
      }),
    ]);
    const pulls = [
      pullBody([
        change('account', 'B', 'create', {
          schemaVersion: 6,
          payload: { type: 'RETIREMENT_ROTH_401K', designatedRothBasis: 45000 },
        }),
      ]),
    ];
    const state = materializeServerState(boot, pulls, HH);
    const accounts = state.get('account')!;
    const current = currentSchemaVersion('account');
    expect(accounts.get('A')!.schemaVersion).toBe(current);
    expect(accounts.get('A')!.payload.rothIraRegularContributionBasis).toBeUndefined();
    expect(accounts.get('A')!.payload.rothIraFirstContributionTaxYear).toBe(2015);
    expect(accounts.get('B')!.schemaVersion).toBe(current);
    expect(accounts.get('B')!.payload.designatedRothBasis).toBeUndefined();
  });
});

// ---------- fresh / stale-without-intent ----------

describe('server-authoritative baseline (no retained intent)', () => {
  it('fresh device with empty local → current server bundle, no unresolved records', async () => {
    const { bundle, t } = await build({
      bootstrap: bootstrapBody([snapAgg('account', 'A'), snapAgg('household', 'H')]),
    });
    expect(bundle.aggregates.account.map((a) => a.id)).toEqual(['A']);
    expect(bundle.aggregates.household.map((a) => a.id)).toEqual(['H']);
    expect(bundle.unresolvedLocalChanges).toBeUndefined();
    expect(t.push).not.toHaveBeenCalled();
    expect(t.restore).not.toHaveBeenCalled();
    expect(t.clearWorkspace).not.toHaveBeenCalled();
  });

  it('stale local rows without queued intent never beat the server baseline', async () => {
    // Server: A only. Local: a stale A (different payload) + a stale orphan Z
    // that no longer exists server-side. With no mutations, the server wins and
    // the stale local rows are ignored entirely.
    const { bundle } = await build({
      bootstrap: bootstrapBody([snapAgg('account', 'A', { version: 9, payload: { name: 'server-A' } })]),
      local: {
        account: [
          agg('account', 'A', { version: 2, payload: { name: 'stale-local-A' } }),
          agg('account', 'Z', { payload: { name: 'orphan' } }),
        ],
      },
    });
    expect(bundle.aggregates.account.map((a) => a.id)).toEqual(['A']);
    expect(bundle.aggregates.account[0]!.payload).toEqual({ name: 'server-A' });
    expect(bundle.unresolvedLocalChanges).toBeUndefined();
  });

  it('server tombstones are omitted from the importable view', async () => {
    const { bundle } = await build({
      bootstrap: bootstrapBody(
        [snapAgg('account', 'A')],
        [change('account', 'B', 'delete', { updatedAt: '2026-02-03T00:00:00.000Z' })],
      ),
    });
    expect(bundle.aggregates.account.map((a) => a.id)).toEqual(['A']);
  });

  // A server-only account still at v6 (no retained local
  // intent, so the server baseline is what lands in `aggregates`) must reach
  // the downloaded file at the current schema with the removed Roth-basis
  // dollar total gone — the bytes that leave the device are the JSON.
  it('a server-only v6 account reaches the importable view without the removed Roth basis total', async () => {
    const { bundle } = await build({
      bootstrap: bootstrapBody([
        snapAgg('account', 'A', {
          schemaVersion: 6,
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 30000 },
        }),
      ]),
    });
    const [a] = bundle.aggregates.account;
    expect(a!.schemaVersion).toBe(currentSchemaVersion('account'));
    expect(a!.payload.rothIraRegularContributionBasis).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('rothIraRegularContributionBasis');
  });
});

// ---------- retained intent overlay ----------

describe('retained local intent overlay', () => {
  it('pending create with no server row overlays into aggregates + unresolved', async () => {
    const localD = agg('account', 'D', { version: 1, payload: { name: 'local-D' } });
    const { bundle } = await build({
      bootstrap: bootstrapBody([]),
      local: { account: [localD] },
      mutations: [mut('account', 'D', 'create')],
    });
    expect(bundle.aggregates.account.map((a) => a.id)).toEqual(['D']);
    const u = bundle.unresolvedLocalChanges!;
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({
      aggregateId: 'D',
      aggregateType: 'account',
      exportedResolution: 'local_view',
      serverAggregate: null,
      localAggregate: expect.objectContaining({ id: 'D' }),
    });
    expect(u[0]!.queuedMutations).toHaveLength(1);
  });

  it('interrupted pushing update: local view wins, newer server variant preserved (never lost)', async () => {
    // Server A is at v2 (newer). Local A' carries an unsynced edit parked as
    // `pushing`. The importable view takes the local edit, but the newer server
    // row is retained in unresolvedLocalChanges so it is never silently lost.
    const serverA = snapAgg('account', 'A', { version: 2, payload: { name: 'server-A-v2' } });
    const localA = agg('account', 'A', { version: 2, payload: { name: 'local-edit-A' } });
    const { bundle } = await build({
      bootstrap: bootstrapBody([serverA]),
      local: { account: [localA] },
      mutations: [mut('account', 'A', 'update', { status: 'pushing' })],
    });
    expect(bundle.aggregates.account[0]!.payload).toEqual({ name: 'local-edit-A' });
    const u = bundle.unresolvedLocalChanges!;
    expect(u[0]!.serverAggregate).toMatchObject({ version: 2, payload: { name: 'server-A-v2' } });
    expect(u[0]!.localAggregate).toMatchObject({ payload: { name: 'local-edit-A' } });
  });

  it('failed-conflict keeps rejection metadata and a newer server row in unresolved', async () => {
    const serverE = snapAgg('account', 'E', { version: 7, payload: { name: 'server-E-v7' } });
    const localE = agg('account', 'E', { version: 3, payload: { name: 'local-E' } });
    const conflict = mut('account', 'E', 'update', {
      status: 'failed-conflict',
      reason: 'CONFLICT',
      currentVersion: 7,
      currentUpdatedAt: '2026-04-01T00:00:00.000Z',
    });
    const { bundle } = await build({
      bootstrap: bootstrapBody([serverE]),
      local: { account: [localE] },
      mutations: [conflict],
    });
    expect(bundle.aggregates.account[0]!.payload).toEqual({ name: 'local-E' });
    const entry = bundle.unresolvedLocalChanges![0]!;
    expect(entry.serverAggregate).toMatchObject({ version: 7 });
    expect(entry.queuedMutations[0]).toMatchObject({
      reason: 'CONFLICT',
      currentVersion: 7,
      currentUpdatedAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('retained local delete stays absent from aggregates but preserves both variants', async () => {
    const serverF = snapAgg('account', 'F', { version: 4, payload: { name: 'server-F' } });
    // Local delete → local row is a tombstone.
    const localFTombstone = agg('account', 'F', {
      version: 5,
      deletedAt: '2026-05-01T00:00:00.000Z',
      payload: { name: 'server-F' },
    });
    const { bundle } = await build({
      bootstrap: bootstrapBody([serverF]),
      local: { account: [localFTombstone] },
      mutations: [mut('account', 'F', 'delete', { status: 'failed-error' })],
    });
    expect(bundle.aggregates.account.map((a) => a.id)).toEqual([]); // F omitted
    const entry = bundle.unresolvedLocalChanges![0]!;
    expect(entry.serverAggregate).toMatchObject({ version: 4 }); // server variant kept
    expect(entry.localAggregate).toMatchObject({ deletedAt: '2026-05-01T00:00:00.000Z' }); // tombstone kept
  });

  // With retained intent the server variant is preserved in
  // `unresolvedLocalChanges.serverAggregate`; a v6 server row must arrive there
  // migrated too, or the removed designated-Roth basis total would survive in
  // the file through that second path.
  it('a retained id whose server variant is still v6 preserves it in unresolvedLocalChanges without the removed Roth basis total', async () => {
    const current = currentSchemaVersion('account');
    const serverA = snapAgg('account', 'A', {
      version: 2,
      schemaVersion: 6,
      payload: { type: 'RETIREMENT_ROTH_401K', designatedRothBasis: 45000 },
    });
    const localA = agg('account', 'A', {
      version: 2,
      schemaVersion: current,
      payload: { type: 'RETIREMENT_ROTH_401K', name: 'local-edit-A' },
    });
    const { bundle } = await build({
      bootstrap: bootstrapBody([serverA]),
      local: { account: [localA] },
      mutations: [mut('account', 'A', 'update', { status: 'pushing', schemaVersion: current })],
    });
    const entry = bundle.unresolvedLocalChanges![0]!;
    expect(entry.serverAggregate).toMatchObject({ version: 2, schemaVersion: current });
    expect(entry.serverAggregate!.payload.designatedRothBasis).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('designatedRothBasis');
  });

  it('emits the exact deterministically ordered queue stack per id', () => {
    // Out-of-order timestamps + a same-timestamp tie broken by id.
    const m1 = mut('account', 'G', 'update', { id: 'zzz', timestamp: 200 });
    const m2 = mut('account', 'G', 'update', { id: 'aaa', timestamp: 200 });
    const m3 = mut('account', 'G', 'create', { id: 'mid', timestamp: 100 });
    const serverByType = new Map<AggregateType, Map<string, Aggregate>>([
      ['account', new Map()],
    ]);
    const localByType = new Map<AggregateType, Map<string, Aggregate>>([
      ['account', new Map([['G', agg('account', 'G')]])],
    ]);
    const bundle = mergeServerExportBundle({
      serverByType,
      localByType,
      mutations: [m1, m2, m3],
      householdId: HH,
      deviceId: DEV,
    });
    const stack = bundle.unresolvedLocalChanges![0]!.queuedMutations;
    expect(stack.map((m) => m.id)).toEqual(['mid', 'aaa', 'zzz']); // ts 100, then (200,aaa), (200,zzz)
  });
});

// ---------- account section ----------

describe('account-record section merge', () => {
  it('merges the fetched account section into the bundle when provided', async () => {
    const account = { user: { userId: 'u-1' }, history: [], nextCursor: null };
    const { bundle } = await build({
      bootstrap: bootstrapBody([]),
      fetchAccount: async () => account,
    });
    expect(bundle.account).toEqual(account);
  });

  it('omits `account` entirely when no fetcher is supplied (the local-only round-trip drill)', async () => {
    const { bundle } = await build({ bootstrap: bootstrapBody([]) });
    expect(bundle.account).toBeUndefined();
  });

  it('a failing account fetch propagates (no silent bundle without its account half)', async () => {
    await expect(
      build({
        bootstrap: bootstrapBody([]),
        fetchAccount: () => Promise.reject(new Error('ACCOUNT_EXPORT_UNAVAILABLE')),
      }),
    ).rejects.toThrow('ACCOUNT_EXPORT_UNAVAILABLE');
  });
});

// 6.test-coverage.1: `exportServerData`'s format branch (plain JSON vs.
// gzip) was previously exercised only through mocks (every caller stubs
// `exportServerData` itself) — nothing proved `format: 'json'` really
// produces an uncompressed blob with the `.json` filename, or that
// `format: 'gzip'`/the default still produces the gzipped one. These call
// the REAL `exportServerData` against a fake transport and inspect the
// blob `triggerBrowserDownload` actually received.
describe('exportServerData — format branch', () => {
  async function run(format?: 'json' | 'gzip') {
    triggerBrowserDownload.mockClear();
    const t = fakeTransport({ bootstrap: bootstrapBody([]) });
    const result = await exportServerData(
      {
        transport: t.transport,
        householdId: HH,
        deviceId: DEV,
        readLocalAggregates: localReader({}),
        readAllMutations: async () => [],
      },
      format,
    );
    expect(triggerBrowserDownload).toHaveBeenCalledTimes(1);
    const [blob, filename] = triggerBrowserDownload.mock.calls[0] as [Blob, string];
    return { blob, filename, result };
  }

  it("format: 'json' triggers a download with an UNCOMPRESSED blob and the .json filename", async () => {
    const { blob, filename } = await run('json');
    expect(filename.endsWith('.json')).toBe(true);
    expect(filename.endsWith('.json.gz')).toBe(false);

    // Not gzip: the first two bytes must NOT be the 1f 8b magic.
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect(head[0]).not.toBe(0x1f);

    const parsed = JSON.parse(await blob.text());
    expect(parsed.householdId).toBe(HH);
  });

  it("format: 'gzip' (and the default, no format arg) trigger a download with a GZIPPED blob and the .json.gz filename", async () => {
    for (const format of ['gzip', undefined] as const) {
      const { blob, filename } = await run(format);
      expect(filename.endsWith('.json.gz')).toBe(true);

      // Gzip magic bytes: 1f 8b at the start of every gzip stream.
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      expect(head[0]).toBe(0x1f);
      expect(head[1]).toBe(0x8b);

      const body = new Response(blob).body;
      const ungzipped = await new Response(
        body!.pipeThrough(new DecompressionStream('gzip')),
      ).text();
      expect(JSON.parse(ungzipped).householdId).toBe(HH);
    }
  });

  it('returns the unresolved-local-change count from the built bundle', async () => {
    const { result } = await run('json');
    expect(result).toEqual({ unresolvedCount: 0 });
  });
});

// ---------- read-only + fail-visible ----------

describe('read-only + fail-visible guarantees', () => {
  it('never pushes, restores, or clears while building', async () => {
    const { t } = await build({
      bootstrap: bootstrapBody([snapAgg('account', 'A')]),
      local: { account: [agg('account', 'B')] },
      mutations: [mut('account', 'B', 'create')],
    });
    expect(t.push).not.toHaveBeenCalled();
    expect(t.restore).not.toHaveBeenCalled();
    expect(t.clearWorkspace).not.toHaveBeenCalled();
  });

  it('a server-fetch failure propagates (no silent local-only fallback)', async () => {
    await expect(
      build({ bootstrap: () => Promise.reject(new Error('SERVER_UNAVAILABLE')) }),
    ).rejects.toThrow('SERVER_UNAVAILABLE');
  });

  it('malformed retained queued intent fails visibly', async () => {
    const bad = mut('account', 'X', 'update');
    // Corrupt the payload to a non-object.
    (bad as unknown as { payload: unknown }).payload = 'not-an-object';
    await expect(
      build({
        bootstrap: bootstrapBody([]),
        mutations: [bad],
      }),
    ).rejects.toBeInstanceOf(ServerDataExportError);
  });
});

// ---------- fetch loop ----------

describe('fetchServerAuthoritativeState', () => {
  it('walks pull pages from the bootstrap cursor until hasMore is false', async () => {
    const { transport, pullCalls } = fakeTransport({
      bootstrap: bootstrapBody([], []),
      pulls: [
        pullBody([change('account', 'A', 'create')], { newCursor: 'c1', hasMore: true }),
        pullBody([change('account', 'B', 'create')], { newCursor: 'c2', hasMore: false }),
      ],
    });
    const { bootstrap, pulls } = await fetchServerAuthoritativeState(transport);
    expect(bootstrap.syncCursor).toBe('cursor-0');
    expect(pulls).toHaveLength(2);
    expect(pullCalls.map((c) => c.since)).toEqual(['cursor-0', 'c1']);
  });

  it('no-progress guard (hasMore true, cursor unchanged) throws instead of using a partial baseline', async () => {
    // Server keeps saying "more pages" but never advances past the bootstrap
    // cursor. The old code silently broke and built from the partial pull.
    const { transport } = fakeTransport({
      bootstrap: bootstrapBody([]),
      pulls: [pullBody([], { newCursor: 'cursor-0', hasMore: true })],
    });
    await expect(fetchServerAuthoritativeState(transport)).rejects.toBeInstanceOf(
      ServerDataExportError,
    );
  });

  it('page cap hit while hasMore is still true throws instead of using a partial baseline', async () => {
    // Server advances the cursor every page but never reports hasMore:false, so
    // the loop runs to the MAX_PULL_PAGES ceiling; the last page still had
    // hasMore:true, so the baseline is incomplete and must fail visibly.
    let n = 0;
    const transport: SyncTransport = {
      push: vi.fn() as unknown as SyncTransport['push'],
      async bootstrap() {
        return bootstrapBody([]);
      },
      async pull() {
        n += 1;
        return { changes: [], newCursor: `c-${n}`, hasMore: true };
      },
      async listSnapshots(): Promise<SnapshotListItem[]> {
        return [];
      },
      restore: vi.fn() as unknown as SyncTransport['restore'],
      clearWorkspace: vi.fn() as unknown as SyncTransport['clearWorkspace'],
    };
    await expect(fetchServerAuthoritativeState(transport)).rejects.toBeInstanceOf(
      ServerDataExportError,
    );
  });

  // This is a DIFFERENT call site over the
  // SAME SyncTransport / SyncApiError the sync loop uses — only the
  // sync loop is excluded, not the error class, so a SyncApiError raised
  // here must still raise the shared notice.
  describe('wait-notice raise on a throttled SyncApiError', () => {
    afterEach(() => {
      raiseWaitNotice.mockClear();
    });

    it('raises the shared notice when bootstrap fails with a SyncApiError carrying Retry-After, then still fails visibly', async () => {
      const transport: SyncTransport = {
        push: vi.fn() as unknown as SyncTransport['push'],
        async bootstrap() {
          throw new SyncApiError('RATE_LIMITED', 'Too many requests', 429, undefined, 7_000);
        },
        pull: vi.fn() as unknown as SyncTransport['pull'],
        async listSnapshots(): Promise<SnapshotListItem[]> {
          return [];
        },
        restore: vi.fn() as unknown as SyncTransport['restore'],
        clearWorkspace: vi.fn() as unknown as SyncTransport['clearWorkspace'],
      };
      await expect(fetchServerAuthoritativeState(transport)).rejects.toBeInstanceOf(
        SyncApiError,
      );
      expect(raiseWaitNotice).toHaveBeenCalledExactlyOnceWith(7_000);
    });

    it('raises the shared notice when a pull page fails with a SyncApiError carrying Retry-After', async () => {
      const { transport } = fakeTransport({ bootstrap: bootstrapBody([]) });
      transport.pull = async () => {
        throw new SyncApiError('RATE_LIMITED', 'Too many requests', 429, undefined, 3_000);
      };
      await expect(fetchServerAuthoritativeState(transport)).rejects.toBeInstanceOf(
        SyncApiError,
      );
      expect(raiseWaitNotice).toHaveBeenCalledExactlyOnceWith(3_000);
    });

    it('raises nothing for a SyncApiError with no Retry-After (a genuine enveloped 5xx)', async () => {
      const transport: SyncTransport = {
        push: vi.fn() as unknown as SyncTransport['push'],
        async bootstrap() {
          throw new SyncApiError('INTERNAL_ERROR', 'Something broke', 500);
        },
        pull: vi.fn() as unknown as SyncTransport['pull'],
        async listSnapshots(): Promise<SnapshotListItem[]> {
          return [];
        },
        restore: vi.fn() as unknown as SyncTransport['restore'],
        clearWorkspace: vi.fn() as unknown as SyncTransport['clearWorkspace'],
      };
      await expect(fetchServerAuthoritativeState(transport)).rejects.toBeInstanceOf(
        SyncApiError,
      );
      expect(raiseWaitNotice).not.toHaveBeenCalled();
    });

    // The S3-bootstrap contract returns a 503
    // WITH Retry-After on persistent failure. That is a failed export, not a
    // throttle — a genuine enveloped 5xx raises nothing, even
    // when the header is present.
    it('raises nothing for a 503 SyncApiError that DOES carry Retry-After (the S3-bootstrap contract)', async () => {
      const transport: SyncTransport = {
        push: vi.fn() as unknown as SyncTransport['push'],
        async bootstrap() {
          throw new SyncApiError('UPSTREAM_ERROR', 'Bootstrap unavailable', 503, undefined, 30_000);
        },
        pull: vi.fn() as unknown as SyncTransport['pull'],
        async listSnapshots(): Promise<SnapshotListItem[]> {
          return [];
        },
        restore: vi.fn() as unknown as SyncTransport['restore'],
        clearWorkspace: vi.fn() as unknown as SyncTransport['clearWorkspace'],
      };
      await expect(fetchServerAuthoritativeState(transport)).rejects.toMatchObject({
        status: 503,
        retryAfterMs: 30_000,
      });
      expect(raiseWaitNotice).not.toHaveBeenCalled();
    });
  });
});

// ---------- fail-visible on incomplete/encrypted server state ----------

describe('materializeServerState fail-visible guards', () => {
  it('throws on an unrecognized aggregateType in the bootstrap snapshot', () => {
    const boot = bootstrapBody([snapAgg('bogus' as AggregateType, 'A')]);
    expect(() => materializeServerState(boot, [], HH)).toThrow(ServerDataExportError);
  });

  it('throws on an unrecognized aggregateType in a pulled change', () => {
    const boot = bootstrapBody([]);
    const pulls = [pullBody([change('bogus' as AggregateType, 'B', 'create')])];
    expect(() => materializeServerState(boot, pulls, HH)).toThrow(ServerDataExportError);
  });

  it('throws on a still-encrypted server payload (workspace key locked, decryption skipped)', () => {
    const encryptedEnvelope = {
      encryptionVersion: 1,
      alg: 'AES-256-GCM',
      keyId: 'k-1',
      nonce: 'nonce',
      ciphertext: 'cipher',
    };
    const boot = bootstrapBody([snapAgg('account', 'A', { payload: encryptedEnvelope })]);
    expect(() => materializeServerState(boot, [], HH)).toThrow(ServerDataExportError);
  });
});
