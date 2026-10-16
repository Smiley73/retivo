# Project-Specific Agent & Assistant Instructions

Repo-specific rules + repo-specific deltas over the universal standards. Read [CODING_STANDARDS.md](CODING_STANDARDS.md) first, then re-open the relevant section at the point of use before planning, editing, committing, or creating/updating PR metadata. Universal rules live there; this file does **not** restate them. [CLAUDE.md](CLAUDE.md), [.github/copilot-instructions.md](.github/copilot-instructions.md) and [.cursor/rules/assistant-policy-pointer.mdc](.cursor/rules/assistant-policy-pointer.mdc) are pointer-only.

Source of truth: the code and its tests. The guides in [docs/](docs/) explain them and drift; when a guide and the code disagree, the code wins and the guide gets fixed.

## Who these rules bind

Process rules in this file and in CODING_STANDARDS.md bind maintainer and AI-driven work. Outside contributors are bound by the automated checks only (`pnpm gate`; CI when it runs) — for them the process rules are recommendations. Four process rules stay:

- **600-line PR cap.** ≤ 600 lines of non-generated code per PR; larger → split by concern. A PR that only deletes files or makes comment-only or other mechanical edits may exceed it, and records the exception in its description. New logic always obeys the cap.
- **Atomic Conventional Commits.** One logical change per commit, `<type>(<scope>): <short description>` (CODING_STANDARDS.md *Commit discipline*).
- **PR description format.** Summary / What users/contributors can now do / Risk + rollout / Rollback / Test plan (CODING_STANDARDS.md *PR discipline*).
- **What's New entry** for every user-facing change, plus the PR-template checkbox (see *Documentation currency*).

## Ground rules — no assumptions, surface every unknown

Universal: CODING_STANDARDS.md *Handle ambiguity explicitly*. Repo deltas:

- **Applies to**: planning, impl, refactors, doc edits, commit/branch/dependency/file-placement decisions — anything with >1 reasonable interpretation. Exception: user says "make the call" / "use your judgment" / "don't ask, just do it" for a specific task — honor that scope, ask again next decision.
- **CodeGraph in worktrees** (where the checkout is indexed; tooling in `.mcp.json`): a primary checkout `.codegraph/` does not make a git worktree indexed. When the primary repo is indexed, run `codegraph init "$WORKTREE"` after creating/attaching a worktree, then verify with `codegraph status "$WORKTREE"` before implementation. `init` builds a one-time snapshot and does not auto-track later edits, so run `codegraph sync "$WORKTREE"` before reading code that changed since. Do not use `-i`; `codegraph init --help` marks it deprecated. If CodeGraph fails in a worktree, fix that before implementing.
- **PR titles + descriptions**: governed by CODING_STANDARDS.md *PR discipline*. Title = `<type>: <one-line functional summary of the user/operator-visible change>` using the CODING_STANDARDS.md commit types; no implementation framing. Body = required PR discipline sections.

## Where things are documented

- [README.md](README.md) — front door: what you need, guide list, license.
- [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) — contributor guide, community conduct, private security reporting.
- [docs/local-setup.md](docs/local-setup.md) — run it locally, checks, end-to-end tests.
- [docs/deploy.md](docs/deploy.md) — deploy to your own Amazon account; updating; tearing down.
- [docs/architecture.md](docs/architecture.md) — browser storage, sync, encryption, server; *Changing stored data safely*.
- [docs/security.md](docs/security.md) — sign-in, second factor, encryption, what the server can see.
- [docs/ui-conventions.md](docs/ui-conventions.md) — tokens, contrast, components, tables, modals, password managers, accessibility.
- [docs/yearly-tax-refresh.md](docs/yearly-tax-refresh.md) — annual tax/benefit table refresh and the checked-answer fixtures.
- [docs/user-guide.md](docs/user-guide.md) — what each screen does.
- Math pages: [taxes](docs/math-taxes.md), [Social Security and health](docs/math-social-security-and-health.md), [retirement accounts](docs/math-retirement-accounts.md), [income, expenses and returns](docs/math-income-expenses-and-returns.md), [withdrawals](docs/math-withdrawals.md), [projections](docs/math-projections.md).
- [docs/PRODUCT.md](docs/PRODUCT.md), [docs/DESIGN.md](docs/DESIGN.md) — see *Design context*.

## Design context (for any UI / design work)

[docs/PRODUCT.md](docs/PRODUCT.md) is the strategic design anchor (register: **product**). Read it before UI work. Principles: numbers first · earn trust through legibility not persuasion · plain language, real math · scannable structure · quiet confidence. The visual system is **Graphite Spectrum**: semantic tokens in [apps/web/src/styles.css](apps/web/src/styles.css), rules in [docs/ui-conventions.md](docs/ui-conventions.md); [docs/DESIGN.md](docs/DESIGN.md) is impeccable's consolidated read of it. WCAG 2.2 AA is locked.

## Locked stack (do not substitute or major-bump)

Versions come from `package.json` files and `engines`; check them there, not here, before relying on a number.

- **Runtime/tooling**: Node 24 only (`engines`: `>=24.2.0 <25.0.0`; Lambda runtime `nodejs24.x`), pnpm 10 (`packageManager` pins `pnpm@10.33.2`), TypeScript 5.
- **Web** (`apps/web`): React 19 + Vite 8 + React Router 8 (`react-router`) + Tailwind v4 (`@tailwindcss/vite`, Preflight on). IndexedDB (via `idb`) is the working store. Interactive controls are React Aria first (`react-aria-components` + `@internationalized/date`). Styling uses the semantic-token utilities, enforced by ESLint (*UI coding standards*). Charts are the in-house SVG engine; no charting library.
- **API** (`apps/api`): NestJS 11 on Express 5, running as AWS Lambda behind API Gateway HTTP API; CloudFront in front of the API and the web bucket (WAF per stack config `enableWaf`).
- **Data/infra**: DynamoDB on-demand (sync log + auth), S3 (gzipped workspace snapshots), Pulumi 3.x (TypeScript) with `dev` and `prod` stack files.
- **Compaction**: the compactor Lambda runs hourly on `prod`, every 6 hours on any other stack (`infrastructure/src/lambda.ts`).
- **Accounts**: local accounts only — password (argon2id) or passkey (WebAuthn, user verification required), no external IdP. Email verification is required before login (`EMAIL_NOT_VERIFIED`, `apps/api/src/auth/login.service.ts`). A second factor (TOTP / email OTP / passkey) is enforced when `AUTH_MFA_ENFORCED` is on: deployed stacks default it on (`retivo:authMfaEnforced`), the code default is off so local `pnpm dev` is password-only.
- **Authorization**: no roles. The `householdId` claim in the JWT is the authoritative partition key and the only isolation boundary; a `householdId` in a body is a sanity check only.
- **Non-negotiables**:
  - every authenticated request checks the access-token denylist (`RevokedToken`);
  - every state-changing request carries CSRF + Origin checks;
  - sync push runs in `TransactWriteItems`;
  - `BatchWriteItem` on the sync tables from the api role only in `HouseholdSweepService`;
  - email uniqueness via `EmailReservation` + `TransactWriteItems`;
  - snapshots are immutable at their original schema version; the client migrates them forward.
- **Accessibility**: WCAG 2.2 AA for every user-facing screen.

## Repo layout

pnpm workspace; members under `apps/*` + `packages/*` + top-level `infrastructure/`.

- `apps/api/` — `@retirement/api`. NestJS 11. Modules: `auth/`, `aws/`, `dynamo/`, `sync/`, `compactor/`, `janitor/`, `health/`, `common/`, `logger/`, `throttle/`. Local: `node --env-file=../../.env`; AWS: Lambda handlers (`lambda.ts` and the others at `apps/api/src/*-lambda.ts`) wrapping the same Nest app.
- `apps/web/` — `@retirement/web`. React 19 SPA, IndexedDB working store. Sources in `src/{auth,components,db,layout,lib,pages,sync}` plus `api`, `contexts`, `crypto`, `monte-carlo`, `workers`. Demo dataset: `src/lib/demo-data-loader.ts`.
- `packages/*` — shared workspace libraries consumed by the apps via `workspace:*`. Convention: each compiles to `dist/` and is consumed from its compiled output (package `exports` → `dist/index.js` + `dist/index.d.ts`); a `prepare` script builds `dist/` on `pnpm install` so consumers resolve without a manual build (`dist/` is gitignored — never commit it). `packages/contracts/` (`@retirement/contracts`) is the first: the single source for the FE/BE sync wire-envelope types + Zod schemas and the `ACTIVE_AGGREGATE_TYPES_LIST` / `AggregateType` inventory (API `sync/aggregate-types.ts` + web `db/types.ts` re-export it). Jest (api) resolves it from source via a `moduleNameMapper` (its ESM-only `exports` map has no `require` condition).
- `infrastructure/` — Pulumi (TypeScript). `dev` + `prod` stack files. Lambda shells in `lambda-shells/` are only the `pulumi preview` fallback when the API build is missing; a real `pulumi up` needs the full build (`infrastructure/src/lambda-artifact.ts`). Local Docker stack in `docker-compose.yml` (DynamoDB Local + Moto).
- Root `.env` (copy from `.env.example`) is the canonical env file (API loads via `node --env-file=../../.env`). No per-app `.env` files.

## Commands (actual, not aspirational)

Run from repo root unless noted. Scripts fan out with `pnpm -r`.

| Purpose | Command | Notes |
|---|---|---|
| Install | `pnpm install` | |
| Start emulator (DynamoDB Local + Moto) | `pnpm emu:up` | Docker. Needed for API tests, to sign in under `pnpm dev`, and for `pnpm test:e2e`. Web (Vitest) and script tests do not need it. |
| Stop emulator | `pnpm emu:down` | |
| Dev (API + web parallel) | `pnpm dev` | API `:3001`, web `:5173`. |
| Typecheck | `pnpm typecheck` | |
| Lint | `pnpm lint` | ESLint + `@typescript-eslint`. |
| Contracts | `pnpm test:contracts` | Slow script checks gated off `pnpm test:scripts`: builds the Lambda artifact (`build:lambda`), runs a production `pnpm audit` (network), and the schema-ahead guard's subprocess runs. Runs as its own CI step; not part of the local gate. |
| Test | `pnpm test` | Jest (API), Vitest (web) + `pnpm test:scripts`. `--passWithNoTests`. Part of the local gate. |
| Local gate (pre-commit) | `pnpm gate` | `lint` + `depcruise` + `knip` + `typecheck` + `test` + `audit:ci` (fails on moderate+ dependency advisories). The sole local pre-commit gate. |
| Module-boundary/cycle check | `pnpm depcruise` | dependency-cruiser; rules in `.dependency-cruiser.cjs` (no import cycles, `lib/` independent of UI, `db/` layering). Part of `pnpm gate`. |
| Dead-code check | `pnpm knip` | Unused exports/files/deps; config in `knip.json`. Part of `pnpm gate`. |
| Affected tests | `pnpm test:affected [ref]` | Inner loop only — tests related to changed files; auto-escalates to full `pnpm test` for broad/unmapped changes. **Not** the gate. |
| Coverage-gated tests | `pnpm test:coverage` | CI gate. Same suites as `pnpm test`, instrumented (v8) with enforced thresholds (`apps/web/vitest.config.ts`, `apps/api/jest.config.cjs`). Runs workspaces sequentially; slower — not part of the local pre-commit gate. |
| End-to-end (web) | `pnpm test:e2e` | Playwright. Needs the FULL local stack up first: `pnpm emu:up` + `pnpm dev` (every flow signs in as the seeded dev user; Playwright auto-boots only the Vite server). Flows in `apps/web/e2e/`; the fixture purges the dev household's server rows between tests. Interactive runner: `pnpm --filter @retirement/web test:e2e:ui`. First run on a new machine needs `pnpm --filter @retirement/web exec playwright install chromium` and the `.env` setup in [docs/local-setup.md](docs/local-setup.md) → "End-to-end tests". |
| Build | `pnpm build` | Web build also runs `tsc --noEmit`. |
| Deploy (costs real money) | First bring-up: `infrastructure/scripts/bootstrap-stack.sh <stack>`. Every update after: `infrastructure/scripts/deploy-stack.sh <dev\|prod>` | A bare `pulumi up` skips the schema-ahead check and stamps `BUILD_ID=dev`. Steps in [docs/deploy.md](docs/deploy.md) → "Updating". |
| Pulumi preview | `pulumi preview --stack {dev,prod}` from `infrastructure/`, after logging in | See [docs/deploy.md](docs/deploy.md) → "Running Pulumi commands yourself". |

Focused runs: single app `pnpm --filter @retirement/api <script>` (or `@retirement/web`, `@retirement/infrastructure`) · single API test `pnpm --filter @retirement/api exec jest <pattern>` · single web test `pnpm --filter @retirement/web exec vitest run <pattern>`.

**Do not invent missing commands.** `pnpm test:a11y` and all `prisma:*`/`db:*` scripts do not exist.

**CI** (`.github/workflows/ci.yml`): four suites — lint+`depcruise`+`knip`+typecheck+`test:scripts`+`audit:ci` (same six checks as the local `pnpm gate`, run sequentially instead of concurrently), web `test:coverage` (the Vitest suite is split across four parallel shards, then a merge job enforces the thresholds once), API `test:coverage` against the compose emulators, and the Playwright e2e suite (full local stack; its test step is non-blocking while the suite earns trust — a failing test shows as "FAILED, NOT BLOCKING" in the summary, a job-level failure fails `All checks`; remove `continue-on-error` on that step to make it blocking). CI runs automatically on every pull request (including from forks), on every later push to it, on every push to `main`, and on manual `workflow_dispatch`; a first-time outside contributor's run waits for the owner's approval (a repo setting). No job holds a write permission or reads a secret, and the workflow uses no privileged trigger (`scripts/test/workflow-trust-boundary.test.mjs` enforces this). The one check to require in branch protection is **`All checks`**, an aggregate job that always runs and fails when any suite failed, was cancelled or was skipped; never require the per-suite jobs (their matrix names such as `web-unit (n/4)` are not stable). It writes a per-suite results table to the run's job summary (there is no PR comment). The API suite (and each web shard) gets one bounded restart-and-re-run; a pass on the re-run is flagged with a warning annotation and shown as "pass on re-run", and a repeated failure fails the run. On pull requests only, a failing dependency audit is reported without blocking when the PR changes no `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`, and the date-dependent feature-flag `reviewBy` test is skipped (`SKIP_REVIEW_BY_DATE_CHECK`); `main` and manual runs stay strict. `pnpm gate` is the local pre-commit gate; CI is the pre-merge check. Coverage thresholds are raise-only (lowering one requires a documented justification in the PR).

## Aggregate schema evolution — required companion edits

Aggregates carry their own `schemaVersion`. Any payload shape change (field add/remove/rename/retype) or new aggregate type → same commit as all of the steps below. [docs/architecture.md](docs/architecture.md) → "Changing stored data safely" carries the same checklist and explains the guards.

1. **TypeScript shape** — the per-aggregate files in `apps/web/src/db/types/` (barrel: [apps/web/src/db/types.ts](apps/web/src/db/types.ts)). New field → the aggregate's `*Payload` interface in its `db/types/<aggregate>.ts` file. New aggregate → a new `db/types/<aggregate>.ts` file re-exported from the barrel + a `PayloadByType` entry + an entry in `ACTIVE_AGGREGATE_TYPES_LIST` in [packages/contracts/src/aggregate-types.ts](packages/contracts/src/aggregate-types.ts) (the API's `apps/api/src/sync/aggregate-types.ts` re-exports it, and its type-level check there fails to compile until it names the new type).
2. **IndexedDB store wiring** — [apps/web/src/db/store.ts](apps/web/src/db/store.ts). New aggregate → object store with `householdId` + `updatedAt` indexes **and a `DB_VERSION` bump**; new fields don't need this.
3. **Forward migrations** — [apps/web/src/db/migrations.ts](apps/web/src/db/migrations.ts). Raise that aggregate's `current` in `REGISTRY`, add the `from → to` step. Forward-only; never modify shipped snapshots.
4. **Server schema ceiling** — `SCHEMA_VERSION_CEILING` in [apps/api/src/sync/dto/push.dto.ts](apps/api/src/sync/dto/push.dto.ts) must equal the highest `current` in `REGISTRY` plus one. `scripts/check-schema-version-ceiling.mjs` (run by `pnpm test:scripts`) fails when they drift. Change both in the same commit.
5. **Demo dataset** — [apps/web/src/lib/demo-data-loader.ts](apps/web/src/lib/demo-data-loader.ts). Add a realistic value for the new field.

**Deploys.** A `current` ahead of `origin/main` **blocks deploys** until the bump merges (`scripts/check-schema-not-ahead.mjs`, run by `deploy-stack.sh`) — data written by an unmerged schema-ahead build halts that workspace's sync permanently. To validate such a branch on a throwaway stack anyway: `ALLOW_SCHEMA_AHEAD=1` on that one invocation, never in `.deploy.env` ([docs/deploy.md](docs/deploy.md) → "Updating").

**Pre-commit verification:** steps 1–5 present (call out intentional omissions). Round-trip drill: load demo data → push → pull fresh tab → field survives (tests cover this where the suite exists; manual otherwise).

## DynamoDB tables — required companion edits

New table, new GSI, or TTL change → update all that apply + `pulumi preview --stack dev` must succeed:

1. **Pulumi** — `infrastructure/src/dynamo.ts`.
2. **Repository/service** — `apps/api/src/dynamo/<table>.repository.ts`.
3. **Local bootstrap** — `apps/api/src/aws/local-bootstrap.ts` (auto-creates on `pnpm dev`), plus the table-name setting in `.env.example`.
4. **Env config** — a `TABLE_<NAME>` entry in `apps/api/src/common/env.config.ts`.
5. **Lambda env** — the matching variable on the API Lambda in `infrastructure/src/lambda.ts`, and on any other Lambda that reads the table.
6. **IAM grant** — `infrastructure/src/iam.ts` (a new GSI also needs its ARN listed in the grant).

Without steps 5 and 6 everything passes locally but a deployed stack points at a local table name that does not exist and has no permission on the real one.

## ENGINE_VERSION bump — required companion edits

`export const ENGINE_VERSION` in [apps/web/src/lib/monte-carlo.ts](apps/web/src/lib/monte-carlo.ts) gates the Monte-Carlo IndexedDB result cache. A change that alters MC output for some input → same commit as all of:

1. **Bump `ENGINE_VERSION`** — in [apps/web/src/lib/monte-carlo.ts](apps/web/src/lib/monte-carlo.ts), **only** when the change alters Monte-Carlo output for some input. Byte-identical output = **no bump** (the frozen fixtures — `apps/web/src/lib/__fixtures__/mc-parity-baselines.json`, `mc-perf-identity.json`, and the BPP fixture `apps/web/src/pages/__fixtures__/bpp-parity-mc-demo-dataset.json` — prove which).
2. **Re-capture the parity fixtures + re-pin** — run the recorder protocol in [apps/web/src/test/capture-bpp-parity-mc-fixture.test.ts](apps/web/src/test/capture-bpp-parity-mc-fixture.test.ts) (unskip → run the capture command → re-skip → commit the fixture). `mc-perf-identity.json` carries `engineVersion` stamps too: re-stamp it through [apps/web/src/test/capture-mc-perf-identity-fixture.test.ts](apps/web/src/test/capture-mc-perf-identity-fixture.test.ts) the same way. Then update the pinned `expect(ENGINE_VERSION).toBe(N)` + its message in [apps/web/src/lib/cross-engine-pin.test.ts](apps/web/src/lib/cross-engine-pin.test.ts).
3. **Cache invalidation is automatic, but its literal pins are not** — [apps/web/src/db/monte-carlo-cache.ts](apps/web/src/db/monte-carlo-cache.ts) silently re-computes entries whose stored `engineVersion` mismatches on read, so no production code changes. The tests that pin the number DO: grep the repo for the OUTGOING version (`rg -n '\b<N>\b' apps/web/src`) and update every literal — historically [apps/web/src/db/monte-carlo-cache.test.ts](apps/web/src/db/monte-carlo-cache.test.ts) (many pins + its `engineVersion` fixture stamps), [apps/web/src/lib/monte-carlo.guardrails.test.ts](apps/web/src/lib/monte-carlo.guardrails.test.ts), and the `engineVersion` field of every captured fixture. A bump that leaves any of them behind ships a red gate.
   **New serialized MC input field?** Add a cache-key inclusion test in the same commit — one case per new field proving it changes `mcCacheKey`, that ordering is canonicalized, and that an absent field reproduces the pre-feature key. The `health-coverage cache-key inclusion` block in `apps/web/src/db/monte-carlo-cache.test.ts` shows the pattern. A silently-colliding key serves one household's saved simulation to another at the SAME engine version, which no version bump fixes.
4. **Release-notes entry** — only if the numeric change is user-visible ([apps/web/src/lib/release-notes.ts](apps/web/src/lib/release-notes.ts)).

**Pre-commit verification:** steps 1–2 present for a math-affecting change; call out an intentional no-bump with the byte-identical-fixture evidence. What the tests fail on:

- `cross-engine-pin.test.ts` — `ENGINE_VERSION` differs from its pinned number.
- `PlanStressTestSection.parity.test.ts` — the BPP fixture's `engineVersion` differs from `ENGINE_VERSION`, or any percentile, success probability or median depletion year in the fixture moves.
- `monte-carlo.perf-identity.test.ts` — a summary (its `engineVersion` stamp included) differs from `mc-perf-identity.json`.
- `monte-carlo-cache.test.ts` — a literal pin names a version that is no longer current.

Nothing fails on a forgotten bump by itself: a math change shows up as a fixture mismatch, and a change that moves output for an input no fixture covers is a judgement call the author makes.

## Documentation currency

Universal currency-check rules in CODING_STANDARDS.md. Docs that drift fastest here:

- [README.md](README.md) — user-visible features, top-level commands, the guide list, license.
- The [docs/](docs/) guides and math pages — when behaviour they describe changes, update the page in the same PR: [docs/user-guide.md](docs/user-guide.md), [docs/local-setup.md](docs/local-setup.md) (prerequisites, setup, first sign-in, checks, end-to-end tests), [docs/deploy.md](docs/deploy.md), [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/ui-conventions.md](docs/ui-conventions.md), and the six `docs/math-*.md` pages.
- [AGENTS.md](AGENTS.md) — locked stack, repo layout, commands, auth posture, UI rules, ask-before list.
- [.env.example](.env.example) — any `process.env.*` added/removed/renamed.
- [docs/yearly-tax-refresh.md](docs/yearly-tax-refresh.md) — the tax and benefit tables drift annually (IRS Rev. Proc. in October–November, CMS premiums in November, SSA COLA in October, HHS poverty guidelines in January). Follow its steps and refresh the affected checked-answer fixtures with their sources and dates.
- [apps/web/src/lib/release-notes.ts](apps/web/src/lib/release-notes.ts) — **a user-facing change adds a newest-first entry in the same PR** (the in-app "What's New" page; `release-notes.test.ts` fails when dates go out of order; the PR-template checkbox carries the explicit `N/A — no user-facing change` affordance). Non-user-facing PRs (refactor / infra / deps / tests / chore / internal docs) skip it. The entry is prepended with the ship date.

Doc edits need no approval; note which docs changed in the commit/PR. `CLAUDE.md`, `.github/copilot-instructions.md` and the Cursor pointer rule are pointer-only — don't edit for behavior changes.

## Auth implementation

- Guards/decorators in `apps/api/src/auth/` (`jwt-auth.guard.ts`, `@Public()`, `@CurrentUser()`, `csrf.middleware.ts`, `origin-check.middleware.ts`). All routes guarded by default; opt out via `@Public()`. No roles — auth = "does `householdId` match the JWT claim".
- **Access tokens**: 5 min (`AUTH_ACCESS_TOKEN_TTL_MIN`, default 5; the infrastructure does not override it), in-memory on the web, RS256-signed with a private key indexed by `kid` from the `AUTH_JWT_PRIVATE_KEYS` map; the matching `AUTH_JWT_PUBLIC_KEYS` map drives verification + the `GET /auth/.well-known/jwks.json` endpoint (both SSM Parameter Store in AWS, read at the api Lambda's cold start); `kid` in the header for rotation. The signing key is `AUTH_JWT_CURRENT_KID` when that env var is set, else the first key of the private map (see *JWT signing-key rotation*). Every RS256 token (access, MFA challenge, data-export authorization) also carries and strictly verifies the per-stack `iss`/`aud` claims (`AUTH_JWT_ISSUER`/`AUTH_JWT_AUDIENCE`) — a token-confusion boundary.
- **Refresh tokens**: rotate on every use, HTTP-only `SameSite=Strict` cookies, revoked on logout, family-wide revocation on reuse detection.
- **Access-token denylist**: every authenticated request does one `GetItem` on `RevokedToken` to honor logout (~5–10 ms).
- **CSRF + Origin middleware**: double-submit cookie + Origin check on every state-changing request. The exempt paths (login / signup / refresh / passkey-authenticate and the other pre-session or token-authenticated endpoints) are listed in `csrf.middleware.ts`.
- **Step-up re-auth** (`StepUpService`, `apps/api/src/auth/step-up.service.ts`): sensitive/destructive ops (change-email, delete-account, encrypted-workspace reset, change-password, TOTP disable, passkey removal) require a fresh second factor immediately before running when `AUTH_MFA_ENFORCED` is on — trusted-device state never satisfies it — and degrade to a floor of ≥ password re-verify when off. Reuse the shared `StepUpService.verify` + the reusable client `StepUpModal`/`useStepUp`; don't hand-roll a new gate. Passkey removal is a body-bearing `POST /auth/passkey/:credentialId/remove` (not `DELETE`).

## Testing setup (project-specific)

Universal minimums in CODING_STANDARDS.md. Stack details:

- **API**: `supertest` + `jest` against DynamoDB Local + Moto (`pnpm emu:up`). Stubbed AWS clients fine for narrow unit logic; emulator required end-to-end. Tests run in parallel (`maxWorkers: process.env.CI ? '100%' : '50%'` in [jest.config.cjs](apps/api/jest.config.cjs) — the 50% cap is local-only co-tenancy, so two worktrees co-fit one machine; CI's runner is dedicated, so it uses all vCPUs); each test process + worker owns a private `retirement-test-${JEST_RUN_ID}-${JEST_WORKER_ID}-*` table/bucket namespace ([jest.setup.ts](apps/api/src/test/jest.setup.ts)) and drops it on exit ([global-teardown.ts](apps/api/src/test/global-teardown.ts)), so concurrent test processes (e.g. two worktrees) don't collide on the one shared emulator. *Within* a worker namespace multiple suites still share one table set — tests must still use unique data (random uuid emails/devices) and be idempotent. Use `bootstrapTestApp()` from [test-helpers.ts](apps/api/src/test/test-helpers.ts).
- **Web**: `vitest` + `jsdom` + `@testing-library/react`. IndexedDB-backed pages mock at the storage layer with `fake-indexeddb`. Wrap in `MemoryRouter` when routes are involved.
- **Web timing races.** Assert a React Aria overlay's result (open, closed) with `findBy*`/`waitFor`, never synchronously after the interaction, and wait for focus to be inside the overlay before sending it a key (its key handlers live on the overlay element, and after an earlier `fireEvent.click` in the file its first focus move is deferred a frame). Never assert `toHaveFocus` across a popover close inside a Dialog: `useDialog` re-focuses the dialog from a 500 ms timer. Pin timer-driven state the test does not own: `Math.random` to `1` for the full-jitter sync retry, the stress vm (`isRunning`) for the ~800 ms Monte Carlo auto-run that disables Print.
- **A11y smoke for interactive/complex components.** A test file in [apps/web/src/components/](apps/web/src/components/) includes ≥ 1 `await expectNoA11yViolations(container)` (helper: [apps/web/src/test/a11y.ts](apps/web/src/test/a11y.ts) — `jest-axe` WCAG 2.1 AA rule set, disables `color-contrast` + `region` jsdom false-positives) **when the component is interactive or complex** — its rendered tree has an interactive control, an ARIA role/state/`aria-*`, focus management, or a keyboard handler. **Purely presentational** components (layout/typography primitives with none of those — e.g. `Stack`, `StatGrid`, `TotalsRow`, `Muted`, `Badge`, `KbdHint`) are exempt. A file that scans multiple variants of the same component collapses to one representative scan. WCAG 2.2 AA stays locked ([docs/ui-conventions.md](docs/ui-conventions.md) → "Accessibility"). Sanity fixture [apps/web/src/test/a11y-sanity.test.tsx](apps/web/src/test/a11y-sanity.test.tsx) is `describe.skip` by default; un-skip to verify the engine after a dep upgrade, then re-skip before committing. Page-level a11y is not covered by the smoke scan yet.

## Project-specific security

Universal security baseline in CODING_STANDARDS.md. Repo specifics:

- **CSRF + Origin middleware are in place.** The SPA's `apiRequest` ([apps/web/src/api/client.ts](apps/web/src/api/client.ts)) echoes the `csrf-token` cookie as `X-CSRF-Token` on POST/PUT/PATCH/DELETE; `sync-client.ts` and `key-envelope-client.ts` do the same. A new state-changing call goes through `apiRequest` (or sets the header itself) — verify in tests that the endpoint actually receives it before merging.
- **`AUTH_JWT_PRIVATE_KEYS` is a secret** (the RS256 signing material; `AUTH_JWT_PUBLIC_KEYS` is the non-secret verification counterpart). Never log/commit/hardcode the private map. Rotate it as written in *JWT signing-key rotation* below.
- **IAM scoping matters.** Roles `retivo-<stack>-api-role`, `-compactor-role`, `-janitor-role`, `-snapshot-purge-role`, `-probe-role`, `-signup-cascade-role`, `-backup-role` and `-backup-restore-role` are deliberately disjoint (`infrastructure/src/iam.ts`, `infrastructure/src/signup-cascade.ts`). Don't widen any grant below from another code path — propose the scope change explicitly first.
  - **Compactor** — `Query`/`Scan`/`BatchWriteItem`/`DeleteItem` on `MutationLog`, `GetItem`/`PutItem`/`UpdateItem`/`Scan` on `WorkspaceMeta`, and `GetObject`/`PutObject`/`ListBucket` on the snapshots bucket. No auth-table access.
  - **Janitor + snapshot-purge** — each *only* `s3:ListBucket` + `s3:DeleteObject` on the snapshots bucket; no DynamoDB, SSM, SES, or `PutObject`.
  - **api role, S3** — `s3:GetObject` (read snapshot objects) + `s3:PutObject` (object-scoped `.../*`; `RestoreService` / `POST /sync/restore` mints a fresh restored snapshot at a current timestamp so the daily janitor's newest-N retention always protects the live `WorkspaceMeta` pointer — pointing at an old chosen key let the janitor delete the very object the workspace pointed at) + `s3:GetBucketLocation` (bucket-level metadata read for the `/health/dependencies` liveness probe) + bucket-wide `s3:ListBucket` (the `GET /sync/snapshots` self-service restore listing — `SnapshotsService.list` enforces the per-household `${householdId}/` prefix at the code layer since IAM can't scope `ListBucket` to a dynamic per-caller prefix). **No `s3:DeleteObject`** — snapshot purges are delegated to the dedicated snapshot-purge Lambda, invoked via `lambda:InvokeFunction` scoped to that one function. Authorised invokers: `DELETE /auth/account`, `POST /auth/encrypted-workspace-reset`, and `POST /sync/workspace/clear` (the erase-history clear, which passes a **keep-key** to preserve the just-minted live empty snapshot; the keep-key is a delete-list filter on the same prefix).
  - **api role, DynamoDB** — `BatchWriteItem` on `MutationLog`/`IdempotencyKey`/`AggregateVersion`/`DeviceRegistry`, plus the snapshot-purge-Lambda invocation, are scoped to the shared household-data sweep (`HouseholdSweepService`).
  - **Authorised `HouseholdSweepService` consumers (canonical list)** — `DeleteAccountService`, the encrypted-workspace reset, `RestoreService` (`POST /sync/restore`, the self-service snapshot restore), and `RestoreService.clearToEmpty` (`POST /sync/workspace/clear`, the server-authoritative "Delete workspace data" clear). Adding a fifth consumer needs an explicit scope-change proposal.
  - **probe role** — basic Lambda execution + CloudWatch Logs only; no DynamoDB, S3, SSM, or SES access. The probe emits `HealthCheckStatus` via EMF stdout and calls the public `/api/v1/health` endpoint — it needs no AWS service grants beyond its own log group.
  - **signup-cascade role** — basic Lambda execution + CloudWatch Logs; `GetItem`/`DeleteItem`/`ConditionCheckItem` on the `User`, `Credential`, `EmailReservation` and `SignupApproval` tables (no GSIs); `PutItem` on `AuthEvent`; `DescribeStream`/`GetRecords`/`GetShardIterator`/`ListStreams` on the `SignupApproval` stream. No SES, no S3.
  - **backup role** — the AWS Backup service role (assumed by `backup.amazonaws.com`) for the immutable vault: only the AWS-managed `AWSBackupServiceRolePolicyForBackup` and `AWSBackupServiceRolePolicyForS3Backup`; no `backup:Delete*`/`Disable*`, so it cannot weaken the vault lock. Created on every stack; inert without a backup plan (`enableBackups`).
  - **backup-restore role** — a separate restore-only role for a restore drill or incident: only `AWSBackupServiceRolePolicyForRestores` and `AWSBackupServiceRolePolicyForS3Restore`; no `backup:Delete*`/`Disable*`.
- **API base URL has a single source.** Read from [apps/web/src/lib/api-base-url.ts](apps/web/src/lib/api-base-url.ts) only — never inline `import.meta.env.VITE_API_BASE_URL` with a `??` fallback. Resolution (first match wins): an explicit non-empty `VITE_API_BASE_URL` wins everywhere; in dev (`import.meta.env.DEV`) a blank/missing var derives `http://${window.location.hostname}:3001` so localhost and LAN browsers each reach the API on the host they loaded from; in prod (`import.meta.env.PROD`) a blank var is same-origin (CloudFront `/api/*`) and a **missing** var throws at module load so misconfigured prod builds fail visibly (a `??` fallback masked a sync 404 in dev). Vite reads canonical env from repo root via `envDir` in [apps/web/vite.config.ts](apps/web/vite.config.ts); AWS builds inject `VITE_API_BASE_URL=""` for same-origin via CloudFront `/api/*` ([infrastructure/scripts/bootstrap-stack.sh](infrastructure/scripts/bootstrap-stack.sh)). The `.env.example` dev default is blank so the dev derivation runs out of the box.
- **Build-id propagation.** The api Lambda emits `X-Build-Id` on every response (BuildIdMiddleware); the SPA bakes its build id into the bundle via `vite.config.ts` `define`. The detector [apps/web/src/lib/build-id.ts](apps/web/src/lib/build-id.ts) drives the `<VersionBanner>` reload prompt. Both read the fingerprint from `BUILD_ID`/`VITE_BUILD_ID`; the deploy scripts derive one from git sha + UTC timestamp. **Two-step gate**: an API mismatch alone does not surface the banner — the detector then fetches `/build-id.json` (a manifest Vite emits, synced + invalidated alongside `index.html`) and prompts only when that file's `buildId` matches the server's `X-Build-Id` (avoids the "reload → same banner" loop while CF still serves the old bundle). New API responses must keep the header; new lazy chunks rely on `ErrorBoundary` recognising `ChunkLoadError`. The `dev` sentinel disables the prompt locally — never rename/special-case it without updating the detector. Don't bypass the verifier (e.g. emitting from `recordServerBuildId`) without updating the tests.
- **All client-side persistence goes through known storage surfaces.** "Clear data on this device" must wipe every trace of local data, so a new storage *mechanism* (a second IndexedDB database, Cache Storage, a service worker, Web SQL, etc.) MUST extend `clearAllLocalData()` ([apps/web/src/lib/local-data.ts](apps/web/src/lib/local-data.ts)) in the same change. ESLint enforces this: the `idb` import is allowed only in `db/store.ts`, and `caches`/`navigator.serviceWorker`/`indexedDB.deleteDatabase` are banned outside their audited homes (`db/store.ts`, `lib/local-data.ts`) — adding a new mechanism trips the rule, forcing a conscious nuke update + a per-line documented disable. Adding a storage mechanism is an ask-before event (see "Project-specific 'ask before'"). Blanket `localStorage`/`sessionStorage` keys need no special handling — the nuke clears them wholesale regardless of name.

### JWT signing-key rotation

Rotate on a quarterly rhythm and at once on any suspected exposure. Nothing reminds you on routine deploys: only `bootstrap-stack.sh` prints the key-age warning (when the newest `key-YYYYMM` kid is more than 3 months old), and that script is first-bring-up only ([docs/deploy.md](docs/deploy.md) → "Updating"). `deploy-stack.sh` does not print it, so schedule the rotation yourself.

How a deployed stack holds and uses its keys:

- Two SSM SecureString parameters, `/retivo/<stack>/auth/jwt-private-keys` and `/retivo/<stack>/auth/jwt-public-keys`, each a JSON map `{kid: PEM}`. `infrastructure/src/ssm.ts` creates them with a placeholder and ignores later changes to value and description, so `pulumi up` neither reverts nor refreshes a rotation. `bootstrap-stack.sh` writes the first pair, kid `key-YYYYMM`.
- The api signs with the **first key** of the private map (`JwtKeyStore.onModuleInit`). `AUTH_JWT_CURRENT_KID` would override that, but there is no SSM parameter for it: `apps/api/src/aws/ssm-bootstrap.ts` loads only the two key maps, the refresh secret, the sender address and the edge secret, and `infrastructure/` never sets that variable. On a deployed stack, **the order of kids in the private-key JSON is the switch**.
- Verification accepts any kid in the public map, and `GET /api/v1/auth/.well-known/jwks.json` serves the public map.
- Only the api Lambda reads the keys, once per cold start (`loadSecretsFromSsm` in `apps/api/src/lambda.ts`). The compactor and janitor Lambdas never call it, and their roles have no `ssm:GetParameter`. Every `deploy-stack.sh` run stamps a fresh `BUILD_ID` (git sha + UTC timestamp) into the api Lambda's environment, and a changed environment makes Lambda retire the old execution environments, so **a deploy is what forces the new keys to load**. A bare `pulumi up` stamps `BUILD_ID=dev`, which is no change: do not use it.
- `env.config.ts` refuses to boot when the two maps' kid sets differ. A cold start in that state fails: the API Gateway returns a 5xx on every request, and the `/aws/lambda/retivo-<stack>-api` log shows `Environment validation failed:` with a line like `AUTH_JWT_PUBLIC_KEYS: AUTH_JWT_PUBLIC_KEYS missing kid(s) present in AUTH_JWT_PRIVATE_KEYS: <kid>`. Environments already warm keep serving until they are recycled. The fix is to write the lagging parameter.
- Standard-tier SSM parameters hold 4 KB (`ssm.ts` sets no tier). Two RSA-2048 private keys measure about 3.5 KB as compact JSON, so keep at most two kids (current and previous) at a time.

Steps (run from the repo root with AWS credentials for the stack; `STACK` is `dev` or `prod`):

1. Pick a kid that is in neither map, and refuse otherwise. `key-YYYYMM` collides when bootstrap or an earlier rotation already used this month (a same-month emergency rotation); then set `KID` by hand to a distinct value such as `key-YYYYMM-b`. A kid outside the `key-YYYYMM` form makes bootstrap's key-age check report "age undetermined", which is only a warning. Then generate the keypair in a temporary directory:
   ```sh
   STACK=prod; KID="key-$(date -u +%Y%m)"; D="$(mktemp -d)"
   get() { aws ssm get-parameter --name "/retivo/$STACK/auth/$1" --with-decryption --query Parameter.Value --output text; }
   put() { aws ssm put-parameter --name "/retivo/$STACK/auth/$1" --type SecureString --overwrite --value "$2" > /dev/null; }
   for m in jwt-private-keys jwt-public-keys; do
     get "$m" | jq -e --arg k "$KID" 'has($k) | not' > /dev/null || { echo "kid $KID is already in $m: set KID to a distinct value" >&2; false; }
   done
   ```
   If the loop prints a refusal, or `get` fails, stop and fix `KID` before going on. Then:
   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$D/priv.pem"
   openssl rsa -in "$D/priv.pem" -pubout -out "$D/pub.pem"
   jq -n --arg kid "$KID" --rawfile pem "$D/priv.pem" '{($kid): $pem}' > "$D/new-priv.json"
   jq -n --arg kid "$KID" --rawfile pem "$D/pub.pem"  '{($kid): $pem}' > "$D/new-pub.json"
   ```
2. Put the new kid **first** in the private map and add it to the public map. `jq '$new[0] + .'` keeps the new key first (the right operand wins on a duplicate kid, which is why step 1 refuses one); the `jq -s '.[0] * .[1]'` shape with the current map as the first input keeps the old kid first and so would never switch signing. Write both parameters back to back, and only when both values are non-empty, which minimises the window in which a cold start can see mismatched kid sets:
   ```sh
   PRIV="$(get jwt-private-keys | jq -c --slurpfile new "$D/new-priv.json" '$new[0] + .')"
   PUB="$(get jwt-public-keys | jq -c --slurpfile new "$D/new-pub.json" '$new[0] + .')"
   [ -n "$PRIV" ] && [ -n "$PUB" ] && put jwt-private-keys "$PRIV" && put jwt-public-keys "$PUB"
   ```
   If this prints an error or exits non-zero, do not deploy: a deploy with mismatched kid sets fails every cold start. Re-read both parameters, write the lagging one (or restore the previous value of the one that changed), and only then continue.
3. Deploy at once so the api Lambda reloads: `./infrastructure/scripts/deploy-stack.sh "$STACK"`. Until it finishes, a token signed by a fresh environment can be rejected by an old one that has not loaded the new kid.
4. Check that `GET /api/v1/auth/.well-known/jwks.json` lists both kids and that a new sign-in's access token carries the new `kid` in its header.
5. Wait before removing the old kid: at least the longest-lived RS256 token, counted from the moment the deploy finishes. Those are the access token (`AUTH_ACCESS_TOKEN_TTL_MIN`, default 5, not set by the infrastructure), the MFA challenge token (`MFA_CHALLENGE_TTL_SEC` in `apps/api/src/auth/mfa-challenge.service.ts`, 5 minutes) and the data-export authorization token (`EXPORT_AUTHORIZATION_TTL_SEC` in `apps/api/src/auth/cookie-config.ts`, 5 minutes). With the defaults that is 5 minutes; if you raised the access-token setting, use that value. Refresh tokens are opaque rows, not RS256 tokens, and are unaffected.
6. Remove the old kid from both maps, back to back, then deploy again so the old kid stops being accepted:
   ```sh
   OLD="key-YYYYMM"
   PRIV="$(get jwt-private-keys | jq -c --arg k "$OLD" 'del(.[$k])')"
   PUB="$(get jwt-public-keys  | jq -c --arg k "$OLD" 'del(.[$k])')"
   [ -n "$PRIV" ] && [ -n "$PUB" ] && put jwt-private-keys "$PRIV" && put jwt-public-keys "$PUB" &&
     ./infrastructure/scripts/deploy-stack.sh "$STACK"
   ```
   If a write fails, stop and repair the lagging parameter before any deploy, as in step 2. `OLD` must be the previous kid, never `$KID`: removing the new kid would delete the only signing key.
7. Destroy the temporary files (`rm -rf "$D"`) and unset `PRIV`/`PUB`.

### Key-envelope archive recovery

Every key-envelope write that displaces existing key material (a `PUT` replacing a slot, a `DELETE`) archives what it displaced — the previous slot row and the previous `ENVELOPE_META` row — under `ARCHIVE#<version>#…` sort keys in the same `HouseholdKeyEnvelope` table (`retivo-<stack>-household-key-envelope`), each stamped with an `expiresAt` TTL of `ARCHIVE_RETENTION_DAYS` (30 days, `apps/api/src/dynamo/types.ts`). DynamoDB TTL deletes lazily, up to about 48 hours late: the retention is a floor, not a ceiling. There is **no API or UI path** to restore an archived version; when a household genuinely needs its previous envelope-set state back (for example a compromised session replaced a slot before the owner could react), an operator does it by hand with direct `PutItem`/`DeleteItem` under operator credentials:

1. Query the household's `ARCHIVE#`-prefixed rows (`householdId = :h AND begins_with(slotId, :p)`, `:p = 'ARCHIVE#'`). An archived `ARCHIVE#<v>#ENVELOPE_META` row is the meta row exactly as it stood at version `v`, and its `slotIds` attribute lists every slot that was live at `v` — the membership manifest. Pick the target version `V` from those rows.
2. Build the slot set for `V` from the `slotIds` of its archived meta row, never by inference from which slot rows happen to be archived. An archived slot row `ARCHIVE#<w>#<slotId>` is that slot exactly as it stood at version `w` (displaced by the write that produced `w + 1`), and a slot's row does not change between displacements. So for each id in `slotIds`, take the archived row with the **smallest `w >= V`**; if there is none, the slot was never displaced after `V` and its **current live row** is the one. Delete every live slot not in `slotIds`: it was added after `V`, and the restored meta's tag will not match a set that includes it.
3. Republish that exact `(slots, envelopeSetVersion, envelopeSetTag)` triple at the live ids. **Rewrite each item before writing it:** `slotId` becomes the live id (`ARCHIVE#<w>#recovery` → `recovery`, `ARCHIVE#<V>#ENVELOPE_META` → `ENVELOPE_META`), and **strip `expiresAt` and `slotIds`**. The table's TTL keys on the `expiresAt` attribute alone, not on the row's namespace, so a live row republished with it still set is reaped at that stamp, silently destroying the key material the archive just gave back. The server cannot re-tag or re-derive anything; it holds no household key.
4. Straight after step 3, **delete every archived row above `V`**: each `ARCHIVE#<w>#…` row with `w > V`, `ARCHIVE#<w>#ENVELOPE_META` included. Those rows belong to the abandoned versions, and the writes that follow the restore reuse those version numbers while overwriting only the archive ids they displace. A leftover row would then sit beside newer ones under the same `w`, and a later recovery's smallest-`w` rule would pick it and republish key material the tag was not computed over, so no device could unlock. Rows with `w <= V` describe versions the restored state shares and stay. Never delete before step 3: step 2 reads some of those rows. The abandoned versions are not restorable afterwards.

Limits. A device that has already verified and pinned a higher version rejects the restored, lower version by design (the rollback-pin check in `useZeroKnowledgeKey`), so recovery is complete only while no device has adopted the bad version — typically when the attacker held the bearer session but not the household key (a garbage slot carries a garbage tag, so no device advances its pin on it). Do not present it as full repair. Once the target version's archived meta row, or an archived slot row it points to, has expired, that version is **not restorable**: never run the steps with a guessed set, because a set the tag was not computed over fails verification on every device.

### Legacy security-row hygiene

`apps/api/scripts/security-retention-cleanup.mjs`, run as `pnpm --filter @retirement/api security:legacy-data-hygiene`, permanently deletes old-format rows from the `MfaEmailOtp` and `TrustedDevice` tables. It runs by hand only — never from startup, a Lambda, a deploy script, CI or a schedule — and refuses any shape except these two:

```sh
pnpm --filter @retirement/api security:legacy-data-hygiene --stack prod --dry-run
pnpm --filter @retirement/api security:legacy-data-hygiene --stack prod --execute --confirm-execute
```

- **Two separate approvals by the stack owner.** The first covers the dry run. The second is given on the counts the dry run reported, before the `--execute --confirm-execute` run. The dry run prints only table names, scanned and eligible counts and consumed read capacity; never row contents.
- **Eligibility, never widened.** A row in `MfaEmailOtp` (`retivo-prod-mfa-email-otp`) or `TrustedDevice` (`retivo-prod-trusted-device`) whose `expiresAt` is present but not a number. A numeric `expiresAt`, or none, is left alone.
- **Why those rows exist.** Current code writes `expiresAt` as epoch seconds (`mfa-email-otp.service.ts`, `trusted-device.service.ts`), the form DynamoDB TTL acts on, and rejects any non-numeric value on read (the trusted-device service also deletes it). An older build stored an ISO-8601 string, which TTL never expires, so such rows linger. A stack that has only ever run current code holds none: its dry run reports zero eligible rows and there is nothing to do.
- **Signup-approval rows are excluded.** An application-issued `DeleteItem` on a `SignupApproval` row would bypass the TTL-only cascade trigger — `signup-cascade-lambda.ts` handles only removals made by DynamoDB's own TTL sweep — and strand the pending user, credential and email-reservation rows forever. DynamoDB's own TTL clears them and fires the cascade.
- **Conditional deletes + postcheck.** Each delete is conditional on the row still being non-numeric, so a row rewritten since the scan is skipped and reported, never erased. After `--execute`, a re-scan must find zero; any remainder exits non-zero.
- **Rollback.** Point-in-time recovery is the only way back, and only when `enablePitr` is on for the stack. Before `--execute`, confirm it on both tables (`aws dynamodb describe-continuous-backups --table-name <table>`). A mistaken delete is undone by restoring to a new table and reconciling.
- **Credentials.** The command uses the operator's own AWS credentials; if they cannot `Scan`/`DeleteItem` those tables it aborts with the permission error.

## API conventions

Universal naming in CODING_STANDARDS.md. Repo-specific shapes:

- **Error envelope**: `{ error: { code, message, details?, traceId? } }` — schema in [packages/contracts/src/error-envelope.ts](packages/contracts/src/error-envelope.ts).
- **Sync push**: `POST /sync/push` ≤ 100 mutations/request, ≤ 64 KB/`payload`, ≤ 5 MB total. Per-mutation `TransactWriteItems` (3 ops): conditional Put on `AggregateVersion`, Put on `MutationLog`, conditional Put on `IdempotencyKey`. Idempotency key `(householdId#deviceId#mutationId)`, 7-day TTL. `schemaVersion` above `SCHEMA_VERSION_CEILING` → `SCHEMA_VERSION_TOO_NEW`.
- **Sync pull**: `GET /sync/pull?since=<cursor>` returns ≤ 100 mutations; `hasMore` pages the rest; a cursor older than retention → `CURSOR_EXPIRED` (re-bootstrap).
- **Sync bootstrap**: `GET /sync/bootstrap?force=true|false` returns the workspace snapshot plus the mutations after it and a sync cursor (shape in `apps/api/src/sync/bootstrap.service.ts`). Hard cap 5 MB gzipped; exceed → `BOOTSTRAP_TOO_LARGE`.
- Every outbound call has an explicit timeout (AWS clients: `apps/api/src/aws/aws.module.ts`); retries only on idempotent ops.
- **Mandatory test automation for sync/auth API changes.** No sync or auth endpoint added/changed without integration tests — every new endpoint ≥ 1 positive + 1 negative; auth-protected endpoints also need an unauthenticated-rejection test.

## UI coding standards

The **Graphite Spectrum** semantic-token layer (Tailwind v4 `@theme inline`) + the typed component library + React Aria are the design system. This section is a cold-start trigger digest only; read [docs/ui-conventions.md](docs/ui-conventions.md) before changing UI code or reviewing a UI diff.

High-risk triggers that require that page:

- Styling: use the semantic-token utilities (`bg-surface`, `text-muted`, `border-line`, `bg-accent`/`text-accent-ink`, `text-positive`, the `pretax`/`roth`/`taxable`/`cash`/`tax_free` bucket hues) + typed components; raw `slate-*`/`indigo-*` are retired and dark mode is a CSS-var swap (no `dark:` colour twin). No inline `style`, raw arbitrary-value utilities, arbitrary-property utilities, or off-token colours without a documented per-line rationale and explicit approval. The one standing exception: the SVG chart engine places tooltips and crosshairs at positions it computes while drawing, so its few inline styles in `components/charts/` are allowed, each with a per-line disable. Keep contrast pairs in [apps/web/src/lib/contrast.ts](apps/web/src/lib/contrast.ts).
- Components: prefer shared components (`Card`, `Field`, `PageHeader`, `TableScroll`, `Modal`, `ToggleSwitch`, `PercentInput`, etc.) and React Aria primitives over raw controls.
- Typography: page body/control text is `text-sm` unless a documented exception applies; numeric money/percent columns use `tabular-nums`.
- Tables, modals, toggles, destructive actions, date display, money/percent inputs, number fields, unsaved-change guards, member labels, and age copy all have project-specific rules in [docs/ui-conventions.md](docs/ui-conventions.md).
- New route or page navigation change -> check `Sidebar` `matchWhen` and "Charts and navigation" in [docs/ui-conventions.md](docs/ui-conventions.md).
- Password/secret entry -> follow "Password managers" in [docs/ui-conventions.md](docs/ui-conventions.md): real `<form>` + `type="submit"`, correct `autocomplete` tokens, hidden username field (`HiddenUsernameField`), `PM_IGNORE_ATTRS` on non-credential secrets, locked outside-click dismissal on password modals.
- New chart/status color -> update both theme maps plus the contrast registry and tests described in [docs/ui-conventions.md](docs/ui-conventions.md) ("Contrast", "Chart colours").

## Project-specific "ask before"

Universal ask-before list in CODING_STANDARDS.md. Repo additions:

- Pulumi changes affecting billable AWS resources (new GSI, enabled compactor schedule, CloudFront price-class bump) — flag the change *and* the cost impact before applying.
- Any aggregate schema migration — adding a migration step to `apps/web/src/db/migrations.ts` OR bumping a type's `current` — requires explicit user approval before implementation. No exceptions (including additive/identity steps).
- Widening the api-role IAM policy — flag before any of: a code path outside `HouseholdSweepService` wanting `BatchWriteItem` on `MutationLog`/`IdempotencyKey`/`AggregateVersion`/`DeviceRegistry`; re-adding `s3:DeleteObject` on snapshots to the api role; or invoking the snapshot-purge Lambda from a new path. Canonical role scope + authorised sweep consumers live in *Project-specific security → IAM scoping matters*.
- Any non-React-Aria UI primitive (raw `<input>`/`<select>`/`<table>`/`<details>` or a hand-rolled disclosure/popover/dialog/tooltip) — propose the Aria-based alternative first; only fall back to non-Aria after explicit user approval recorded in the PR. See [docs/ui-conventions.md](docs/ui-conventions.md) → "Components".
- A new client-side storage *mechanism* (second IndexedDB database, Cache Storage, service worker, Web SQL, …) — it must extend `clearAllLocalData()` so "Clear data on this device" stays complete (ESLint-enforced). Flag the addition + the nuke update first. See "Project-specific security".

## Response style — caveman mode

Active every response (no auto-revert; still active if unsure). Off only on "stop caveman" / "normal mode".

| | |
|---|---|
| **Drop** | articles (a/an/the) · filler (just/really/basically/actually/simply) · pleasantries (sure/certainly/of course/happy to) · hedging · conjunctions. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Abbreviate common terms (DB/auth/config/req/res/fn/impl). Arrows for causality (X → Y). One word when one word is enough. Pattern: `[thing] [action] [reason]. [next step].` |
| **Keep exact** | technical terms · code blocks · quoted errors |
| **Auto-suspend (no toggle needed) for** | security warnings · irreversible-action confirmations · multi-step sequences where fragment order risks misread · explanations or any "explain" request · planning output / plans · questions or answers framed for a junior dev or in layman's terms · user asks to clarify / repeats the question. Resume terse after. |
