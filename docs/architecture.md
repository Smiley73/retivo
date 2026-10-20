# Architecture overview

This guide is for people changing RETIVO's code. It explains how the browser
storage, the sync protocol, the encryption and the server fit together, where
each part lives in the repo, and what you must keep in step when you change
stored data. It does not repeat setup steps: to get a running copy, follow
[local-setup.md](local-setup.md).

## The big picture

RETIVO is **local-first**. That one idea decides where code belongs.

- The browser's **IndexedDB** (the database built into every browser) holds the
  working copy of a household's plan. The app reads and writes it directly.
- **Every calculation happens in the browser**: the projections, the tax
  estimates and the Monte Carlo runs. Monte Carlo is a simulation that replays
  a plan through many random market sequences. The heavy runs go to Web
  Workers (background threads the browser provides), and the rest of the
  engine runs on the page itself.
- The **server never computes anything about a plan**. It stores and relays
  encrypted change records, keeps periodic backups of them, and handles
  accounts and sign-in. It cannot read the plan, so it could not run a
  projection even if it tried.

If you are about to put plan logic in the API, stop: it belongs in the web app.
If you are about to make the web app depend on the server to show a plan, stop
too: the app must keep working from its local copy when the server is
unreachable.

```
  Browser                                      Your deployment
 +--------------------------------+            +--------------------------------+
 | React app                      |            | CloudFront                     |
 |  projections, Monte Carlo      |            |  / -> web app files (S3)       |
 |        |                       |            |  /api/* -> API Gateway         |
 |  IndexedDB (working copy)      |            |        |                       |
 |        |                       |   HTTPS    |  API Lambda (NestJS)           |
 |  mutation queue                | ---------> |        |                       |
 |   -> encrypt -> push / pull    | <--------- |  DynamoDB: encrypted changes,  |
 +--------------------------------+            |            accounts, key slots |
                                               |  S3: snapshots (encrypted)     |
                                               |  Background Lambdas            |
                                               +--------------------------------+
```

## Repo map

The workspace is a pnpm monorepo. `pnpm-workspace.yaml` lists three groups:
`apps/*`, `packages/*` and `infrastructure`.

| Package | Folder | What it owns |
|---|---|---|
| `@retirement/web` | `apps/web` | The React single-page app (React, React Router, Vite), the browser storage, the sync client, the encryption and the calculation engine. |
| `@retirement/api` | `apps/api` | The NestJS API, plus the entry points of the background Lambdas. |
| `@retirement/contracts` | `packages/contracts` | The Zod schemas and types for what travels between web and API (a shared contract), and the list of aggregate types. |
| `@retirement/assistant-protocol` | `packages/assistant-protocol` | The Zod schemas and constants shared by the local AI assistant bridge and the web app: the messages they exchange, the fixed list of tools, the error codes and the pairing rules. |
| `@retirement/mcp-bridge` | `apps/mcp-bridge` | A small Node program an AI assistant (Claude Code, Codex, Cursor) starts over standard input and output. It lists the fixed set of Retivo tools to the assistant and relays each call over a local WebSocket (`127.0.0.1` only) to the signed-in browser tab, after a one-time pairing code. It holds no plan data. |
| `@retirement/infrastructure` | `infrastructure` | The Pulumi program that builds the Amazon resources. |

The versions of the main libraries are in each package's `package.json`; this
guide does not repeat them.

The folders you will touch most:

| Folder | What is there |
|---|---|
| `apps/web/src/db` | IndexedDB store (`store.ts`), per-record migrations (`migrations.ts`), the record shapes (`types.ts` and `types/`), the Monte Carlo result cache. |
| `apps/web/src/sync` | The mutation queue, the sync client, the pull-apply logic, auto-repair, quarantine, the sync badge and the mock transport. |
| `apps/web/src/crypto` | Payload encryption, key wrapping, the key cache, the passkey key derivation and the freshness counter. |
| `apps/web/src/auth` | Sign-in state, the key-envelope client and the cross-user guard. |
| `apps/web/src/lib/projection-engine` | The yearly projection and Monte Carlo kernels. |
| `apps/web/src/workers` | The Web Worker entry points (Monte Carlo and the claim-age optimizer). |
| `apps/web/src/lib/demo-data-loader.ts` | The demo dataset. |
| `apps/api/src` | One folder per API module: `auth`, `sync`, `dynamo`, `compactor`, `janitor`, `aws`, `common`, `health`, `throttle` and `logger`. The Lambda entry files sit directly in `apps/api/src`. |
| `packages/contracts/src` | The wire schemas (`sync-envelopes.ts`, `error-envelope.ts`) and `aggregate-types.ts`. |
| `apps/mcp-bridge/src` | The assistant bridge: the pairing-code store (`pairing-code-store.ts`), the loopback WebSocket server (`loopback-server.ts`), the tab session state machine (`session.ts`), the call relay (`relay.ts`), the MCP tool registration (`mcp-server.ts`) and the entry point (`bin.ts`). |
| `packages/assistant-protocol/src` | The assistant message frames (`frames.ts`), the tool registry (`registry.ts`), the result envelope (`result.ts`) and the pairing proofs (`pairing.ts`). |
| `infrastructure/src` | One file per resource group: `dynamo.ts`, `lambda.ts`, `s3.ts`, `cloudfront.ts`, `api-gateway.ts`, `iam.ts` and more. |
| `scripts` | Repo-wide check scripts and their tests. |

## Browser storage

The web app keeps its data in an IndexedDB database named `retirement`
(`DB_NAME` and `DB_VERSION` in `apps/web/src/db/store.ts`). `DB_VERSION` is
currently 9.

**Two version numbers, easy to confuse.**

- The **store version** (`DB_VERSION`) describes the database's layout: which
  object stores (the IndexedDB word for a table) and indexes exist. It changes
  only when you add a store or an index.
- Each record also carries its own **`schemaVersion`**, which describes the
  shape of that record's data. `apps/web/src/db/migrations.ts` holds a registry
  with one entry per aggregate type: the current version and a chain of
  forward-only steps. Whenever a record is read from IndexedDB or arrives from
  the server, the steps run until it reaches the current version.

An **aggregate** is one synced record, such as an account, a scenario or an
expense. The list of aggregate types lives in
`packages/contracts/src/aggregate-types.ts`, and the web app re-exports it
from `apps/web/src/db/types.ts`.

Besides the aggregates, the database holds local-only stores that are never
synced: the mutation queue, device metadata, the selected scenario, the Monte
Carlo result cache, the key cache and an on-device diagnostics log.

**Local data is not encrypted at rest.** Encryption protects what leaves the
browser (see below), not the copy on the device. The household's data key is
cached in the `keyCache` store of the same database
(`apps/web/src/crypto/key-cache.ts`), next to the plaintext records, so anyone
who can read the browser profile can read both. Do not write code or docs that
imply otherwise.

**A different user signing in on the same browser drops the local database.**
`apps/web/src/auth/user-transition.ts` compares the new user with the last one
and also checks the stored records for another household's data. A mismatch
deletes the database. Because other open tabs may hold the database open,
`store.ts` posts a `BroadcastChannel` message that asks them to release it so
the delete can finish.

## Sync

Sync moves encrypted change records between each browser and the server. The
web side lives in `apps/web/src/sync`. The server side lives in
`apps/api/src/sync`.

### Writing

1. An edit updates the local record in IndexedDB first, so the screen reacts
   at once, and appends a **mutation** to the local queue
   (`apps/web/src/sync/mutation-queue.ts`). A mutation is one create, update
   or delete of one record. Each carries the record version the browser last
   saw.
2. The sync client (`sync-client.ts`, driven by `SyncContext.tsx`) encrypts each
   queued mutation's payload and pushes a batch with `POST /api/v1/sync/push`.
3. The server checks every mutation against the record's current version. This
   is **per-record optimistic concurrency**: the push succeeds only if the
   version the browser saw is still the latest. The response lists each
   mutation as `applied` or `rejected`, and a rejection carries a reason
   (`CONFLICT`, `NOT_FOUND` or `SCHEMA_MISMATCH`) and the server's current
   version.
4. Rejections are handled on the browser. `auto-repair.ts` is a pure function
   that picks an action for each one: drop the mutation because the server
   already holds the same result, re-apply it on top of the server's version,
   or escalate. Whatever it cannot repair silently shows up in the sync badge
   and its popover (`SyncBadge.tsx`, `SyncDetailsPopover.tsx`), where the user
   decides.

**The server refuses plaintext.** `apps/api/src/sync/push.service.ts` works in
two passes. First it checks every mutation in the batch (size, idempotency and
encryption shape) and writes nothing. Only if the whole batch passes does it
apply the writes. A batch with one plaintext mutation therefore fails with
nothing written. Each mutation's version check runs on its own during the
apply pass, so one conflict is rejected without stopping the others.

### Reading

- `GET /api/v1/sync/pull?since=<cursor>` returns the next page of the mutation
  log after a cursor, up to 100 changes at a time.
- `GET /api/v1/sync/bootstrap` returns the latest **snapshot** (a full copy of
  the household's records, written by a background job) plus the mutations made
  after it. A new device starts here.
- The mutation log is not kept forever. The **compactor** Lambda
  (`apps/api/src/compactor/compactor.service.ts`) writes a new snapshot to S3,
  then deletes the log entries the snapshot now covers and moves a watermark
  forward (`mutationLogCursorBase` on the workspace record). A device whose
  cursor is older than the watermark gets `CURSOR_EXPIRED` from
  `apps/api/src/sync/pull.service.ts`. It cannot catch up by pulling, so it
  must bootstrap again.
- When a pulled row will not decrypt, the browser **quarantines** that row on
  this device (`quarantine.ts`) rather than failing the whole pull. The rest of
  the household's data still loads.
- A **freshness counter** lets the browser notice if the server serves it
  older data than it has seen before (`apps/web/src/crypto/freshness.ts`). The
  [security overview](security.md#unlocking) explains it.

The rest of `apps/api/src/sync/sync.controller.ts`: `GET /api/v1/sync/snapshots`
lists the household's snapshots, `POST /api/v1/sync/restore` rewinds the
household to a chosen snapshot, and `POST /api/v1/sync/workspace/clear` erases
the household's synced data after a password check.

### Keeping sync data safe

Four rules protect saved data. The code comments beside each one explain the
detail; the rules themselves are:

- **The compactor only deletes what a snapshot provably covers.** It verifies
  that every log row it is about to delete is reflected in the new snapshot,
  then deletes. A row it cannot account for is kept and raises an alarm rather
  than being dropped (`apps/api/src/compactor/compactor.service.ts`).
- **A push that lands behind the compaction point is re-appended.** A change's
  sequence id is minted before its transaction commits, so a very slow commit
  can land at or below the point the compactor has already passed. Pull only
  returns rows above that point, so no device would ever see it. After the
  commit, the push service writes the same change again with an id that sorts
  after the compaction point. This is best effort and never turns an
  acknowledged write into an error (`apps/api/src/sync/push.service.ts`).
- **Creating over a deleted record revives it, safely.** When a create hits the
  tombstone of a record the same household deleted, the server revives it only
  if the stored row is still a tombstone at exactly the version it just read,
  so a concurrent write cannot be overwritten. The response is flagged
  `recreatedOverTombstone` so the browser's auto-repair can tell this safe case
  from a real collision (`push.service.ts`).
- **A restore flips the pointer last.** Restoring a snapshot rebuilds every
  per-record version row first and only then points the household at the
  restored snapshot. A crash part-way leaves the household without a pointer,
  and re-running the restore converges. The pointer always goes to a freshly
  written copy of the snapshot, so the janitor's retention can never delete the
  snapshot the household is pointing at (`apps/api/src/sync/restore.service.ts`).

### The wire contract and drift

`packages/contracts` holds the Zod schemas for the sync request and response
bodies, shared by the web app and the API. The web client checks each pulled
or bootstrapped body against them but **deliberately degrades**: on a mismatch
it logs a warning and still applies the data (`validateServedBody` in
`sync-client.ts`). The reason is deploys. The web app and the API are never
updated at the same instant, so a field added on one side must not stall sync
on the other. Do not "fix" this to throw.

### The mock transport

`sync-client.ts` defines `SyncTransport`, the interface sync talks through.
`HttpSyncClient` implements it against the real API. Setting
`VITE_SYNC_MOCK=true` swaps in `apps/web/src/sync/mock-sync.ts`, a browser-only
transport with no server behind it. It is useful for UI work. See
[local-setup.md](local-setup.md) for how to switch it on.

## Encryption, in outline

This section gives the shape only. The [security overview](security.md#encryption) covers algorithms,
parameters and what the server can see in full.

- The browser generates a random **household key** (the data key). The server
  never sees it.
- Each change payload is encrypted in the browser with a key derived from the
  household key. The payload is bound to its household and record identity, so
  a server cannot move one record's ciphertext onto another. The code is in
  `apps/web/src/crypto/payload-crypto.ts`.
- The household key is stored on the server only in **wrapped** form: locked
  separately under the user's password, a recovery key and, optionally, a
  passkey. Each lock is a "slot". Unlocking with any one slot recovers the
  household key. Wrapping lives in `apps/web/src/crypto/key-wrapping.ts` and
  `passkey-prf.ts`, and the server stores the slots through the key-envelope
  routes under `/api/v1/auth/key-envelopes`.
- The server rejects any push whose payloads are not in the encrypted form
  (see Writing, above).

Encryption does not hide everything. The server still sees account details and,
for every change, its metadata: record ids, record types, versions,
timestamps and sizes. It also sees the snapshots, which hold the same
ciphertext. It cannot read the contents of a plan.

## The server

### The API

The API is a NestJS app. When deployed, it runs in one Lambda behind an API
Gateway HTTP API, bridged by `@codegenie/serverless-express`
(`apps/api/src/lambda.ts`). Every route lives under `/api/v1`. Locally it runs
as an ordinary Node process (`apps/api/src/main.ts`). The modules, under
`apps/api/src`:

| Module | Role |
|---|---|
| `auth` | Sign-up, sign-in, tokens, second factors, passkeys, key-envelope storage, account export and deletion. |
| `sync` | The routes above: push, pull, bootstrap, snapshots, restore and workspace clear. |
| `dynamo` | One repository class per table, plus shared helpers for batched and transactional writes. |
| `aws` | The AWS clients, and `local-bootstrap.ts`. |
| `compactor`, `janitor` | The background jobs (below). |
| `common` | Config loading, the `X-Build-Id` header, correlation ids, error handling. |
| `health`, `throttle`, `logger` | The health endpoint, request throttling backed by DynamoDB, and logging. |

### Data

**DynamoDB** holds the data, in tables you can group by role:

- *Sync*: the mutation log, a per-record version table that enforces the
  concurrency check, an idempotency table (so a retried push does not apply
  twice), a device registry and a per-household metadata table (snapshot
  pointer, watermark and freshness values).
- *Accounts*: users, email reservations and verifications, password resets,
  credentials and the household key slots.
- *Sign-in*: refresh tokens, revoked tokens, failed-login counters, second
  factor and trusted-device records, passkeys and passkey challenges, and an
  audit trail of sign-in events.
- *Sign-up approval*: pending approvals.

All table definitions are in `infrastructure/src/dynamo.ts`, and the repository
for each is in `apps/api/src/dynamo`.

**S3** holds the snapshots: one gzipped JSON file per snapshot, under a prefix
named for the household, in a private bucket with its own access-log bucket
(`infrastructure/src/s3.ts`). A separate bucket holds the built web app
(`infrastructure/src/spa-hosting.ts`).

### Background Lambdas

The header of `infrastructure/src/lambda.ts` lists the Lambda functions. Besides
the API, four have real jobs. All of them ship from one shared build of
`apps/api`, and each has its own handler file in `apps/api/src`:

- **compactor**: writes snapshots and trims the mutation log, as described
  under Reading. It runs hourly on the `prod` stack and every six hours on the
  others.
- **janitor**: runs daily and deletes snapshots past their retention age while
  always keeping a minimum number per household.
- **snapshot-purge**: called by the API during account deletion, to delete the
  account's snapshots.
- **signup-cascade**: triggered by a DynamoDB stream, to clean up the leftovers
  of a sign-up that was never approved.

A fifth, the **probe**, checks the public health endpoint. It is deployed with
its schedule switched off.

Monitoring is optional alarms; see the [deploy guide](deploy.md#alarms).

### The request path

One CloudFront distribution sits in front of everything. It serves the web app
from the S3 bucket and forwards `/api/*` to API Gateway, adding a shared secret
header (`X-Origin-Verify`). The API rejects any request without it
(`apps/api/src/auth/edge-auth.middleware.ts`), so calls that skip CloudFront
get nowhere. A firewall (AWS WAF) in front of CloudFront can be turned on with a
setting. The routing is in `infrastructure/src/cloudfront.ts`.

### Running locally

Locally, DynamoDB and S3 are emulators. On start, the API creates its own tables
and bucket in them (`ensureLocalAwsResources` in
`apps/api/src/aws/local-bootstrap.ts`, called from `main.ts`). This is why a
new table needs an entry in `local-bootstrap.ts` as well as in
`infrastructure/src/dynamo.ts`.

## Changing stored data safely

Stored data outlives any one version of the code. Browsers hold records written
by older bundles, the server holds ciphertext written by every device, and a
deploy never reaches all of them at once. A few guards protect this. Know them
before you change a record's shape.

### The version guards

- **The server's schema ceiling.** `SCHEMA_VERSION_CEILING` in
  `apps/api/src/sync/dto/push.dto.ts` is the highest `schemaVersion` the
  server accepts on a push. It must equal the highest `current` version in the
  web registry plus one. The extra one lets a build that carries the next
  version still sync. `scripts/check-schema-version-ceiling.mjs`, run by
  `pnpm test:scripts`, fails when they drift apart. Change both in the same
  commit.
- **No schema-ahead deploys.** `infrastructure/scripts/deploy-stack.sh` refuses
  to deploy a branch whose record versions are ahead of `origin/main`
  (`scripts/check-schema-not-ahead.mjs`). Data written at a version no shipped
  build knows can halt that household's sync permanently, because the client
  stops pulling when it meets a version newer than it understands, and a reload
  cannot fix that. To test such a branch on a throwaway stack anyway, set
  `ALLOW_SCHEMA_AHEAD=1` on the command.
- **`ENGINE_VERSION`.** `apps/web/src/lib/monte-carlo.ts` exports it. It keys
  the Monte Carlo result cache in IndexedDB (`apps/web/src/db/monte-carlo-cache.ts`).
  Cached results made under another engine version are thrown away and
  recomputed. Raise it when a change alters Monte Carlo output for some input.
- **`X-Build-Id`.** The API puts its build id on every response. When it
  differs from the build id baked into the web app,
  `apps/web/src/lib/build-id.ts` shows a banner asking the user to reload.

### Adding or changing a field or a record type

A change to the shape of stored data touches these places, in the same commit:

1. **The web types**, in `apps/web/src/db/types/`. A new field goes on that
   aggregate's payload interface. A new aggregate type gets its own file there,
   re-exported from `apps/web/src/db/types.ts`, plus an entry in
   `PayloadByType`. A new type also goes into `ACTIVE_AGGREGATE_TYPES_LIST` in
   `packages/contracts/src/aggregate-types.ts`. The server's
   `apps/api/src/sync/aggregate-types.ts` re-exports that list, and its
   type-level check in the same file fails to compile until it names the new
   type.
2. **The store wiring**, in `apps/web/src/db/store.ts`. A new aggregate type
   needs an object store with `householdId` and `updatedAt` indexes (and a
   `DB_VERSION` bump). A new field on an existing type does not.
3. **A forward migration**, in `apps/web/src/db/migrations.ts`. Raise that
   type's `current` and add the step from the old version to the new one.
   Migrations only move forward, and shipped steps are never edited. Raising a
   `current` also raises the ceiling in the first guard above.
4. **The demo dataset**, in `apps/web/src/lib/demo-data-loader.ts`: give the
   new field a realistic value.
5. **The assistant sharing field model**, in
   `apps/web/src/assistant/sharing/classification.ts`. The AI assistant
   connector builds what it may say field by field, from an allowlist: a payload
   field with no entry is never shared. Classify the new field in that payload's
   map as a label, free text, a dollar figure, an opaque reference, a plain
   value, or `never`. Each map is typed `satisfies Record<KnownKeys<Payload>,
   Classification>`, so `pnpm typecheck` fails until the field is classified. A
   new aggregate type needs its own map and a section in
   `assistant/sharing/view.ts`.

A new **DynamoDB table** needs more than its definition in
`infrastructure/src/dynamo.ts` and a repository under `apps/api/src/dynamo/`:

- an entry in `apps/api/src/aws/local-bootstrap.ts`, together with its
  table-name setting in `.env.example`;
- a `TABLE_<NAME>` entry in `apps/api/src/common/env.config.ts`;
- the matching environment variable on the API Lambda in
  `infrastructure/src/lambda.ts`, and on any other Lambda that reads the table;
- a grant for the table in `infrastructure/src/iam.ts`.

Without the last two, everything passes locally but a deployed stack points at
a local table name that does not exist and has no permission on the real one.

`AGENTS.md` carries the same checklists for contributors working with a coding
assistant.
