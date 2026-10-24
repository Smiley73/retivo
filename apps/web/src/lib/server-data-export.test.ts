import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentSchemaVersion } from '../db/migrations';
import type { Aggregate, AggregateType, PendingMutation } from '../db/types';
import type {
  BootstrapResponseBody,
  PullResponseBody,
  SnapshotListItem,
} from '../sync/types';
import { SyncApiError, type SyncTransport } from '../sync/sync-client';

// `triggerBrowserDownload` touches `document`, which this node-environment file lacks; the rest of the download path stays real.
const triggerBrowserDownload = vi.fn();
vi.mock('./data-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data-export')>();
  return { ...actual, triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownload(...args) };
});

// Mocked: this file proves only that a throttled SyncApiError raised through this call site triggers the notice.
const raiseWaitNotice = vi.fn();
vi.mock('./toast-queue', () => ({
  raiseWaitNotice: (...args: unknown[]) => raiseWaitNotice(...args),
}));

import { exportServerData } from './server-data-export';

const HH = 'hh-1';
const DEV = 'dev-1';

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

type ExportOptions = {
  bootstrap: BootstrapResponseBody | (() => Promise<BootstrapResponseBody>);
  pulls?: PullResponseBody[];
  local?: Partial<Record<AggregateType, Aggregate[]>>;
  mutations?: PendingMutation[];
  fetchAccount?: () => Promise<Record<string, unknown>>;
};

async function runExport(opts: ExportOptions, format?: 'json' | 'gzip') {
  triggerBrowserDownload.mockClear();
  const t = fakeTransport({ bootstrap: opts.bootstrap, pulls: opts.pulls });
  const result = await exportServerData(
    {
      transport: t.transport,
      householdId: HH,
      deviceId: DEV,
      readLocalAggregates: localReader(opts.local ?? {}),
      readAllMutations: async () => opts.mutations ?? [],
      fetchAccount: opts.fetchAccount,
    },
    format,
  );
  expect(triggerBrowserDownload).toHaveBeenCalledTimes(1);
  const [blob, filename] = triggerBrowserDownload.mock.calls[0] as [Blob, string];
  return { blob, filename, result, t };
}

type ExportedBundle = {
  householdId: string;
  aggregates: Record<AggregateType, Aggregate[]>;
  unresolvedLocalChanges?: Array<{
    serverAggregate: Aggregate | null;
    localAggregate: Aggregate | null;
    queuedMutations: PendingMutation[];
  }>;
  account?: unknown;
};

async function build(opts: ExportOptions) {
  const { blob, t } = await runExport(opts, 'json');
  return { bundle: JSON.parse(await blob.text()) as ExportedBundle, t };
}

const SERVER_UNAVAILABLE = { code: 'SERVER_STATE_UNAVAILABLE' };

const exportOnTransport = (transport: SyncTransport) =>
  exportServerData({
    transport,
    householdId: HH,
    deviceId: DEV,
    readLocalAggregates: localReader({}),
    readAllMutations: async () => [],
  });

describe('server state materialization', () => {
  it('applies snapshot, post-snapshot mutations and pulls in order, with later writes overriding and tombstones dropped', async () => {
    const { bundle } = await build({
      bootstrap: bootstrapBody(
        [snapAgg('account', 'A', { version: 1 })],
        [
          change('account', 'A', 'update', { version: 2, updatedAt: '2026-02-02T00:00:00.000Z' }),
          change('account', 'B', 'delete', { version: 3, updatedAt: '2026-02-03T00:00:00.000Z' }),
          change('account', 'C', 'create', { version: 1 }),
        ],
      ),
      pulls: [pullBody([change('account', 'C', 'update', { version: 5, payload: { name: 'C5' } })])],
    });
    const byId = new Map(bundle.aggregates.account.map((a) => [a.id, a]));
    expect([...byId.keys()].sort()).toEqual(['A', 'C']);
    expect(byId.get('A')!.version).toBe(2);
    expect(byId.get('C')!.version).toBe(5);
    expect(byId.get('C')!.payload).toEqual({ name: 'C5' });
  });
});

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

  // Served rows are never written to IndexedDB, so the export runs the migration chain itself; a v6 row would otherwise carry the removed Roth-basis totals into the file.
  it('migrates schema-behind server rows (snapshot and pulled): the removed Roth basis totals go, the year fact stays', async () => {
    const { bundle } = await build({
      bootstrap: bootstrapBody([
        snapAgg('account', 'A', {
          schemaVersion: 6,
          payload: {
            type: 'RETIREMENT_ROTH_IRA',
            rothIraRegularContributionBasis: 30000,
            rothIraFirstContributionTaxYear: 2015,
          },
        }),
      ]),
      pulls: [
        pullBody([
          change('account', 'B', 'create', {
            schemaVersion: 6,
            payload: { type: 'RETIREMENT_ROTH_401K', designatedRothBasis: 45000 },
          }),
        ]),
      ],
    });
    const byId = new Map(bundle.aggregates.account.map((a) => [a.id, a]));
    const current = currentSchemaVersion('account');
    expect(byId.get('A')!.schemaVersion).toBe(current);
    expect(byId.get('A')!.payload.rothIraFirstContributionTaxYear).toBe(2015);
    expect(byId.get('B')!.schemaVersion).toBe(current);
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('rothIraRegularContributionBasis');
    expect(json).not.toContain('designatedRothBasis');
  });
});

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

  // The server variant kept in `unresolvedLocalChanges` must be migrated too, or the removed basis total survives through that path.
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

  it('emits the exact deterministically ordered queue stack per id', async () => {
    const m1 = mut('account', 'G', 'update', { id: 'zzz', timestamp: 200 });
    const m2 = mut('account', 'G', 'update', { id: 'aaa', timestamp: 200 });
    const m3 = mut('account', 'G', 'create', { id: 'mid', timestamp: 100 });
    const { bundle } = await build({
      bootstrap: bootstrapBody([]),
      local: { account: [agg('account', 'G')] },
      mutations: [m1, m2, m3],
    });
    const stack = bundle.unresolvedLocalChanges![0]!.queuedMutations;
    expect(stack.map((m) => m.id)).toEqual(['mid', 'aaa', 'zzz']);
  });
});

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

describe('exportServerData — format branch', () => {
  it("format: 'json' triggers a download with an UNCOMPRESSED blob and the .json filename", async () => {
    const { blob, filename } = await runExport({ bootstrap: bootstrapBody([]) }, 'json');
    expect(filename.endsWith('.json')).toBe(true);
    expect(filename.endsWith('.json.gz')).toBe(false);
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect(head[0]).not.toBe(0x1f);
    expect(JSON.parse(await blob.text()).householdId).toBe(HH);
  });

  it("format: 'gzip' (and the default, no format arg) trigger a download with a GZIPPED blob and the .json.gz filename", async () => {
    for (const format of ['gzip', undefined] as const) {
      const { blob, filename } = await runExport({ bootstrap: bootstrapBody([]) }, format);
      expect(filename.endsWith('.json.gz')).toBe(true);
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
    const { result } = await runExport({ bootstrap: bootstrapBody([]) }, 'json');
    expect(result).toEqual({ unresolvedCount: 0 });
  });
});

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
    (bad as unknown as { payload: unknown }).payload = 'not-an-object';
    await expect(
      build({
        bootstrap: bootstrapBody([]),
        mutations: [bad],
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_LOCAL_MUTATION' });
  });
});

describe('server pull loop', () => {
  it('walks pull pages from the bootstrap cursor until hasMore is false', async () => {
    const { bundle, t } = await build({
      bootstrap: bootstrapBody([], []),
      pulls: [
        pullBody([change('account', 'A', 'create')], { newCursor: 'c1', hasMore: true }),
        pullBody([change('account', 'B', 'create')], { newCursor: 'c2', hasMore: false }),
      ],
    });
    expect(t.pullCalls.map((c) => c.since)).toEqual(['cursor-0', 'c1']);
    expect(bundle.aggregates.account.map((a) => a.id)).toEqual(['A', 'B']);
  });

  it('no-progress guard (hasMore true, cursor unchanged) throws instead of using a partial baseline', async () => {
    await expect(
      build({
        bootstrap: bootstrapBody([]),
        pulls: [pullBody([], { newCursor: 'cursor-0', hasMore: true })],
      }),
    ).rejects.toMatchObject(SERVER_UNAVAILABLE);
  });

  it('page cap hit while hasMore is still true throws instead of using a partial baseline', async () => {
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
    await expect(exportOnTransport(transport)).rejects.toMatchObject(SERVER_UNAVAILABLE);
  });

  // The sync loop is excluded from the wait notice, but not the SyncApiError class: this call site must still raise it.
  describe('wait-notice raise on a throttled SyncApiError', () => {
    afterEach(() => {
      raiseWaitNotice.mockClear();
    });

    const failingTransport = (overrides: Partial<SyncTransport>): SyncTransport => ({
      push: vi.fn() as unknown as SyncTransport['push'],
      bootstrap: vi.fn() as unknown as SyncTransport['bootstrap'],
      pull: vi.fn() as unknown as SyncTransport['pull'],
      async listSnapshots(): Promise<SnapshotListItem[]> {
        return [];
      },
      restore: vi.fn() as unknown as SyncTransport['restore'],
      clearWorkspace: vi.fn() as unknown as SyncTransport['clearWorkspace'],
      ...overrides,
    });

    it('raises the shared notice when bootstrap fails with a SyncApiError carrying Retry-After, then still fails visibly', async () => {
      const transport = failingTransport({
        async bootstrap() {
          throw new SyncApiError('RATE_LIMITED', 'Too many requests', 429, undefined, 7_000);
        },
      });
      await expect(exportOnTransport(transport)).rejects.toBeInstanceOf(SyncApiError);
      expect(raiseWaitNotice).toHaveBeenCalledExactlyOnceWith(7_000);
    });

    it('raises the shared notice when a pull page fails with a SyncApiError carrying Retry-After', async () => {
      const transport = failingTransport({
        async bootstrap() {
          return bootstrapBody([]);
        },
        async pull() {
          throw new SyncApiError('RATE_LIMITED', 'Too many requests', 429, undefined, 3_000);
        },
      });
      await expect(exportOnTransport(transport)).rejects.toBeInstanceOf(SyncApiError);
      expect(raiseWaitNotice).toHaveBeenCalledExactlyOnceWith(3_000);
    });

    it('raises nothing for a SyncApiError with no Retry-After (a genuine enveloped 5xx)', async () => {
      const transport = failingTransport({
        async bootstrap() {
          throw new SyncApiError('INTERNAL_ERROR', 'Something broke', 500);
        },
      });
      await expect(exportOnTransport(transport)).rejects.toBeInstanceOf(SyncApiError);
      expect(raiseWaitNotice).not.toHaveBeenCalled();
    });

    // The S3-bootstrap contract returns a 503 with Retry-After on persistent failure: a failed export, not a throttle.
    it('raises nothing for a 503 SyncApiError that DOES carry Retry-After (the S3-bootstrap contract)', async () => {
      const transport = failingTransport({
        async bootstrap() {
          throw new SyncApiError('UPSTREAM_ERROR', 'Bootstrap unavailable', 503, undefined, 30_000);
        },
      });
      await expect(exportOnTransport(transport)).rejects.toMatchObject({
        status: 503,
        retryAfterMs: 30_000,
      });
      expect(raiseWaitNotice).not.toHaveBeenCalled();
    });
  });
});

describe('server state fail-visible guards', () => {
  it('throws on an unrecognized aggregateType in the bootstrap snapshot', async () => {
    await expect(
      build({ bootstrap: bootstrapBody([snapAgg('bogus' as AggregateType, 'A')]) }),
    ).rejects.toMatchObject(SERVER_UNAVAILABLE);
  });

  it('throws on an unrecognized aggregateType in a pulled change', async () => {
    await expect(
      build({
        bootstrap: bootstrapBody([]),
        pulls: [pullBody([change('bogus' as AggregateType, 'B', 'create')])],
      }),
    ).rejects.toMatchObject(SERVER_UNAVAILABLE);
  });

  it('throws on a still-encrypted server payload (workspace key locked, decryption skipped)', async () => {
    const encryptedEnvelope = {
      encryptionVersion: 1,
      alg: 'AES-256-GCM',
      keyId: 'k-1',
      nonce: 'nonce',
      ciphertext: 'cipher',
    };
    await expect(
      build({ bootstrap: bootstrapBody([snapAgg('account', 'A', { payload: encryptedEnvelope })]) }),
    ).rejects.toMatchObject(SERVER_UNAVAILABLE);
  });
});
