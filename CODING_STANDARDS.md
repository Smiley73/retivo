# Coding Standards

Standards for this repo's maintainers, AI assistants and contributors. Repo-specific rules live in [AGENTS.md](AGENTS.md).

## Who these rules bind

All rules here bind maintainer work and AI-driven work in this repo. For outside contributors they are recommendations; what binds a contributor is the automated checks:

- `pnpm gate` (lint, depcruise, knip, typecheck, test, audit:ci).
- The coverage thresholds in `pnpm test:coverage`.
- The CI workflow, which runs the same gates plus coverage. It runs automatically on every pull request (forks included), on later pushes to it, on pushes to `main` and on manual dispatch. The single required check is `All checks` (see the header of `.github/workflows/ci.yml`). The API suite gets one flagged re-run; on PRs a dependency-audit failure is reported without blocking unless the PR changes dependencies, and date-dependent tests are skipped. A first-time outside contributor's run waits for the owner's approval.

Four process rules are binding for maintainer and AI work and recommended for everyone else:

1. **600-line PR cap** (with its mechanical-edit exception) — see *PR discipline*.
2. **Atomic Conventional Commits** — see *Commit discipline*.
3. **PR description format** — see *PR descriptions*.
4. **What's New entry** for every user-facing change — see *PR discipline*.

## Source of truth

**The code and its tests define what the app does.** Guides ([docs/](docs/)) and math pages (`docs/math-*.md`) explain that behaviour. A change to behaviour that a page describes updates that page in the same pull request.

When a page and the code disagree, the code is what runs. Fix the page, or raise it with the maintainer if the code looks wrong. Never silently change either side to match.

### Currency check (end of session)

Before proposing a commit, verify the docs and the guides and math pages reflect current code. Flag discrepancies; fix before committing.

| Surface | Update when |
|---|---|
| **Guides and math pages** (`docs/`) | a formula, limit or rule a math page states changes · a screen or flow `docs/user-guide.md` describes changes · setup, deploy, architecture or security behaviour changes · the yearly tax-table refresh (see `docs/yearly-tax-refresh.md`) |
| **Other docs** (README, `docs/local-setup.md`, `AGENTS.md`, `.env.example`, the What's New entry) | user-visible feature add/remove/change · setup step/prereq/command change · `process.env.*` add/remove/rename · new project-wide pattern/rule |

**Never commit a change that makes a guide or math page wrong** — update it first or call out the gap. **No guide update for:** pure refactor · test-only · minor/patch dep bump · formatting/lint/comment-only.

## Agentic behavior

Rules for AI assistants in agentic context (who they bind: see *Who these rules bind*).

### Session start

- **Orient first.** Read `AGENTS.md`, `CODING_STANDARDS.md`, the relevant code, tests and guides; explore the repo before coding. Codebase = primary style guide — match naming, module org, error shape, test structure.
- **Reuse before creating.** Check for existing helpers first.
- **Load prior context silently.** Read task lists, git history, session notes — don't ask the user to re-explain written info.

### Defining work

- **Plan before coding.** Checkable task plan before impl; verify with user before starting. Correction before code is free; after costs rework.
- **Challenge plans before agreeing.** Review on two layers: (1) standards here + `AGENTS.md` (shape limits, type safety, DRY, YAGNI, composition, fail-fast, TDD, security, atomic commits); (2) general best practice (SOLID, OWASP Top 10, least privilege, input validation, a11y, data modeling, concurrency). Rules here + `AGENTS.md` override general practice. Better way available → call it out, propose alternative, wait for confirmation. Never silently improve or silently implement a worse approach.
- **Define "done" as a measurable, agent-verifiable outcome, not process.** ❌ "keep checking logs until error found" → ✓ "check last 100 lines; error → root cause + one fix; none → say so, stop." Can't state done → clarify first.
- **Define verification method before implementing.** Match domain — backend: test suite · API: integration tests · frontend: browser/a11y · data: row-count diffs · infra: plan + smoke. Close the loop autonomously. Reusable verification scripts > one-off; can't prove correct = not done.
- **Handle ambiguity explicitly.** Ask before assuming; state unavoidable assumptions; prefer reversible choices; plan breaks → stop, re-plan. Never silently interpret ambiguity.
- **Planning surfaces every unknown — batching allowed.** Surface every unknown with concrete options; no implicit gap-fill. Related questions may be grouped into one turn when it's more efficient; serial one-at-a-time stays the default for genuine ambiguity or where one answer changes the next question. Triggers: "plan," "help me plan," "propose an approach," any open-ended design prompt.
- **Ask questions a junior dev understands.** Plain language; spell out jargon/acronyms on first use; frame the unknown by its concrete user-visible consequence; each option self-contained. An expert-only question hides the assumption instead of surfacing it.
- **Planning is a cycle.** After every open decision has an answer, re-review the whole plan, surface new unknowns, ask the next follow-up (grouped or serial). Repeat (ask → review → follow-up) until solid or the user says stop. Coding starts only after the cycle closes.

### During work

- **Work incrementally.** Minimal working version first; test after each meaningful change. Non-trivial logic: each increment = red/green/refactor — no second fn before the first has a passing test.
- **Narrate progress.** Brief what+why each step; update the checklist; don't go silent.
- **Parallelize tools.** Batch independent reads/searches in one step; sequential only when B needs A.
- **Search, don't browse.** Search before bulk-reading files. Prefer your harness's native search tools (dedicated grep/glob/file tools) over shelling out — they skip permission prompts and return structured results; fall back to shell `grep`/`ripgrep` only when no native tool fits. Run `git log`/`diff`/`status` directly; set timeouts on long bash ops.
- **Commit at milestones.** No unverified pile-up; 80% context + uncommitted → stop features, commit.
- **Verify after every tool call.** Confirm success before proceeding; re-read changed files for typos/dead code/unused imports/error paths before presenting. Staff-engineer bar — uncertain → keep improving.
- **Elegance check before done.** Every branch justified? Deps necessary? Smallest correct diff? Readable without opening other files?

### Definition of Done

Not complete until **all** true:

- [ ] Impl matches the agreed task + all its acceptance criteria
- [ ] Verification method defined before impl; passes autonomously
- [ ] All tests pass; typecheck + lint pass without suppressions
- [ ] PR description: required functional shape, risk, rollout/rollback, test plan
- [ ] New env vars documented in `.env.example`
- [ ] Guides and math pages updated (currency check passed)
- [ ] Conditionals: new/changed deps → audited + version-pinned · feature flags → owner + removal date · frontend → a11y baseline (keyboard nav, ARIA, contrast)

### Session end

- Commit or stage all working code — no uncommitted pile.
- Update task tracking: completed, next steps, blockers, assumptions.
- Run the full test suite before done.
- **Capture patterns after corrections.** Record the lesson; repeated mistake after correction = process failure.

## Code quality

**Shape limits** (flag before exceeding): functions ≤ 60 ln · files ≤ 800 ln · nesting ≤ 3 levels.

**File-length exception note.** A file that cannot reasonably split may stay over 800 lines if its header carries a note labelled `SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):` that states:

- that the file is over the 800-line limit (no line count, no date);
- why it cannot be split;
- the trigger: a change adding 5 or more lines must either refactor the file back under the limit or re-justify the exception in the note.

The note carries no owner name, approval date, plan, decision tag or PR number. A re-justification is added to the note as a plain reason.

**Types:** annotate all fn signatures; strict settings, never relax; no `any`/`object` without an inline comment.

**Structure:** DRY after 2nd repetition · no YAGNI · composition > inheritance · named constants not magic numbers · inject deps, don't instantiate inside fns.

**Framework defaults first.** Prefer the framework / design-system OOTB construction over a bespoke or arbitrary one. A deviation (arbitrary value, off-system style, hand-rolled replacement) needs (a) a written rationale why no OOTB construction works **and** (b) explicit user approval before merge, recorded in the PR. Where a linter enforces this, a green tree-wide lint is the completeness proof and a per-line documented disable is the only escape (project `AGENTS.md` names specifics).

**UI guards:** `obj?.flag === true` not `obj?.flag !== false` — negations silently pass `undefined` during fetch. Any explicit-Save surface must prompt before accidental discard: (1) `beforeunload` while dirty; (2) in-app guard on nav/modal-close (X, Esc, scrim); (3) Save visible when dirty. Explicit Cancel bypasses. Capture the pattern in `AGENTS.md` with a ref impl.

**Comments:** why/how it fits, not what. File header on non-trivial files: a one-line purpose. Where a guide or math page explains the behaviour, the header or comment may name it once, in plain words, and only a section that exists. No links to planning documents; no decision, plan, phase, finding or PR ids. TSDoc on exported symbols (purpose, non-obvious params, throws, side effects). Inline on security/math/concurrency/framework-quirk/a11y decisions. No syntax narration.

## Commit discipline (atomic commits)

**One logical change per commit** — self-contained, reviewable, revertable in isolation.

1. One commit per distinct change (bug fix + feature + refactor = three).
2. Commit before switching tasks.
3. Group by concern not file; same file, different concerns → `git add -p`.
4. Message needs "and also…" → should have been split.
5. Commit at milestones during multi-step impl.
6. **Commits may be made without prior approval.** After committing, show the message + changed files. Push to a shared branch, PRs, and destructive git ops still follow the Branching + "Ask before" rules.
7. **Run typecheck, tests, lint before every commit.** Fix failures first; never claim lint passes when broken.

**Commit message format (Conventional Commits):** `<type>(<scope>): <short description>` + optional body explaining what and why. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`, `ci`, `build`. Scope: module/area (e.g. `auth`, `web`, `db`).

## Branching

- Never commit to the default branch (`main`/`master`); every task gets its own branch.
- Branch from latest default (pull first). Task A done → ship, return to default, new branch for B.
- Propose a branch name + ask permission before coding on default or an unrelated branch: "I'll create `<type>/<short-description>` — proceed?"
- One concern per branch; split before opening a PR if spanning multiple.
- Reuse only for direct continuations (review feedback, CI fixes), not unrelated tweaks.
- Delete merged branches (ask confirmation; never delete a branch with unmerged commits without separate instruction).
- **Naming:** `<type>/<short-description>` e.g. `feat/oauth-login`, `fix/null-payment-response`.

## PR discipline

- **≤ 600 lines of non-generated code per PR**; larger → split by concern. **Mechanical-edit exception:** a PR that only deletes files or makes comment-only or other mechanical edits may exceed the cap if its description says so. Anything with new logic obeys the cap.
- **Atomicity waiver.** The cap yields only when splitting would break a rule that binds harder — an aggregate schema change whose shape, migration and demo data must land in one commit (`AGENTS.md` *Aggregate schema evolution*), or a user-facing change that must carry its What's New entry alongside the behaviour it describes (`AGENTS.md` *Documentation currency*). The maintainer approves the waiver explicitly; it is recorded in the PR body with the rule it yields to and the estimated size. Reviewers treat a waiver recorded this way as settled, not as a finding. Absent that record, the cap stands.
- One concern per PR.
- Never amend or force-push published commits; squash-merge to the default branch.
- **A user-facing change adds a What's New entry in the same PR** in `apps/web/src/lib/release-notes.ts`, and ticks the PR-template checkbox (`N/A — no user-facing change` for non-user-facing PRs). The repo detail is in `AGENTS.md` *Documentation currency*.

### PR descriptions — functional, not technical

For the reviewer and the future changelog reader. Anyone wanting *how* reads the diff — the description focuses on **what changes for the user/operator** and **why**.

| Keep | Drop |
|---|---|
| One-line summary of the user-visible change | File paths, fn names, constants, CSS classes, hook names (grep finds these) |
| Per-area sections: what the user can now see/do/configure | "Why this implementation" detail (→ commit message / inline comment) |
| Risk + rollout/rollback posture | Commit-by-commit recaps (git shows that) |
| Test plan focused on user-visible behavior | Impl gotchas only the author cares about |

Required PR body shape:

```md
## Summary
## What users/contributors can now do
## Risk + rollout
## Rollback
## Test plan
```

When in doubt: would a PM or a teammate from a different stack understand this? If not, it's too technical — move it to the commit message or an inline comment.

## Security & safety (baseline)

- Never log secrets, tokens, or PII; scrub at the logger.
- Never bypass the authentication or authorization checks.
- Never use `--no-verify`, `--no-gpg-sign`, or similar.
- Never commit `.env*` (gitignored except `.env.example`), credentials, or customer data.
- Integration tests hit a real database (or its local emulator), not mocks.
- **Audit deps before adding/upgrading.** Run `pnpm audit` (or equivalent), resolve or explicitly accept findings. "Audited" = ran clean, not intended to run.
- **Ownership checks compare IDs, not truthiness.** `if (resource.ownerId)` is not an auth check — compare owner ID against the caller's verified access set.
- **Check-and-mutate requires a transaction.** Read-then-act → wrap both in one transaction (or a conditional write); the gap is a TOCTOU race.
- **Rate limits declared explicitly.** Every public/high-sensitivity endpoint needs an explicit annotation (e.g. `@Throttle`); a new endpoint without one must be deliberate + documented.
- **Stateful singletons need bounded eviction + lifecycle cleanup.** Maps/caches growing under adversarial input cap size or evict on schedule; services with timers implement `OnModuleDestroy`.
- **Serialize API responses explicitly; never return raw database items directly.** Map through a typed serializer (documented API fields only) — raw items leak password hashes, soft-delete flags, audit columns.
- **Cookie auth requires CSRF protection.** `SameSite=Strict` alone is insufficient — add double-submit cookie, `Origin`/`Referer` validation, or synchronizer token before prod.
- **Validate redirect targets from user input** — must be a relative path (`/...`) or allowlisted origin; unvalidated = open redirect.
- **Least privilege at every boundary.** IAM roles and policies, deploy credentials, per-household data access — grant only what's needed; never reuse admin creds for runtime.
- **Secrets are environment-scoped.** Each env has its own; never share across envs, commit, log at boot, bundle in client, or write to CI/CD logs. Rotate immediately on suspected exposure.
- **Back up before destructive data changes.** Before any migration that drops/renames/rewrites data, confirm a recent backup or point-in-time recovery; document the restore procedure before any incident.

> **Rules that apply only where a project has that component** (TLS-on-DB, least-privilege DB role, row-level security, parameterized SQL, database connection-string credentials and their rotation) do not apply here. This repo stores data in DynamoDB, reached by IAM role, and has no relational database.

## Testing

**TDD order:** (1) write failing test, confirm the right failure reason; (2) minimal code to pass; (3) refactor. Skipping red = process failure.

**Coverage + naming:** ~80% line min; 100% of the acceptance criteria. Where a project wires a coverage gate (this repo: `pnpm test:coverage`, which CI runs on every PR), thresholds ratchet toward that target and are raise-only — lowering one requires a documented justification in the PR. **Documented redundancy reset (exception):** a PR that removes tests proven redundant — the deleted tests' lines stay covered by other tests — may re-baseline the threshold down to the new measured floor, with the coverage-overlap evidence documented in the PR. Normal work still ratchets up; silent regressions stay blocked. Behavior names (`should_return_404_when_resource_not_found`). Arrange → Act → Assert; one assertion cluster per test. Both happy-path and error/edge.

**Independence:** no shared mutable state; mock at the system boundary; unit tests < 250 ms; test behavior/contracts not impl details.

**Minimums per feature:** API endpoint → one positive + one negative (+ an allowed-caller / denied-caller pair if protected) · UI component → render + one interaction/state test · validation rule → one pass + one fail · tests committed same commit as the feature.

## Error handling

- **Fail fast** — validate at boundaries, surface failures immediately, no bad-state propagation.
- **Never swallow exceptions.** Caught error → log, re-throw, or typed error. Empty catch forbidden.
- **Typed/domain-specific error types** for failures callers handle differently.
- **Retry transient failures with exponential backoff + jitter.** Never retry non-idempotent ops.
- Log errors with full context (operation, safe inputs, correlation id); never secrets/PII.
- **Meaningful error responses at API boundaries** — error code, human message, debug context without leaking internals.

## Naming & format conventions

`SCREAMING_SNAKE_CASE` error codes · `camelCase` JSON bodies · `kebab-case` URL paths · ISO 8601 UTC timestamps.

## Ask before

Destructive git ops · adding/removing/upgrading any dependency · creating new top-level files or directories · schema-breaking or contract-phase migrations · production config, secrets, infra, CI/CD · long/expensive commands.

## Don't create

New READMEs, docs, scratch/notes files, committed plan files, duplicate configs (second `tsconfig`/lint config), or committed build artifacts — unless explicitly asked. Prefer editing existing files.

---

*Thanks to [Vinny Carpenter](https://github.com/vscarpenter) for providing the initial version of this file.*
