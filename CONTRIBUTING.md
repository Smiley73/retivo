# Contributing to RETIVO

Thanks for helping. This page is short on purpose: each detail lives in the
guide linked beside it.

## Questions, bugs and ideas

Ask questions in [Discussions](https://github.com/Smiley73/retivo/discussions).
File bugs and ideas as [issues](https://github.com/Smiley73/retivo/issues/new/choose)
with the matching form; there is no blank issue. Report security problems
privately, never as an issue: see [SECURITY.md](SECURITY.md).

## Set up

Follow [docs/local-setup.md](docs/local-setup.md). It covers the tools you need,
running RETIVO on your computer and the Docker emulators the API tests use.

## Checks a change must pass

- `pnpm gate` (lint, module boundaries, unused code, typecheck, tests and the
  dependency audit). See the table in
  [Run the checks](docs/local-setup.md#run-the-checks).
- The coverage thresholds of `pnpm test:coverage`.
- The pull-request checks below.

## Pull-request checks

The checks run the same gates plus coverage. They start on every pull request,
forks included, and again on every push to it. On your first pull request they
may wait for the maintainer's approval before they start.

- **One check must be green: `All checks`.** It always runs and fails when any
  suite failed, was cancelled or was skipped. The per-suite checks beneath it
  have no stable names, so ignore their names and read `All checks`.
- **Flagged re-runs.** If the API tests (or the emulator start) fail, the check
  restarts the emulators and runs the whole suite once more. A web test shard
  that fails gets one re-run too. A pass on the re-run is shown as a warning
  and as "pass on re-run" in the results. A failure that repeats is real.
- **Reported without blocking:**
  - the dependency audit, unless your pull request changes a dependency file;
  - tests that compare against today's date, which are skipped on pull
    requests;
  - the browser end-to-end tests: a failing test shows in the results as
    "FAILED, NOT BLOCKING" and does not turn `All checks` red while the suite
    earns trust. A broken job (the emulators or API not starting, the browser
    not installing, a timeout) still fails the check.
- **Where to read the results:** the run's job summary (open the run from the
  pull request's Checks tab, then its Summary page) lists each suite, whether
  it needed a re-run, and the audit and date checks.
- **A check fails for a reason unrelated to your change:** read the summary and
  the logs first. If the failure repeats on a re-run and does not touch what you
  changed, say so in a comment on the pull request and the maintainer will look.

## Flaky API tests on your computer

The API tests need the Docker emulators, which read your `.env`
(`cp .env.example .env`; see [docs/local-setup.md](docs/local-setup.md)). When
they fail:

1. Run `pnpm emu:down`, then `pnpm emu:up`.
2. Wait until `docker ps` shows both `retivo-dynamodb-local` and `retivo-moto`
   as `(healthy)`.
3. Re-run the failing suite.

A failure that repeats after the restart is real. If `env.config.spec.ts` fails
with an unchanged `.env.example`, that is expected; see
[Run the checks](docs/local-setup.md#run-the-checks).

## Recommended practices

For outside contributors these are recommendations; the checks above are what
bind. They are defined in [AGENTS.md](AGENTS.md) (*Who these rules bind*) and
[CODING_STANDARDS.md](CODING_STANDARDS.md) (*Who these rules bind*):

- **600-line cap.** Keep a pull request to 600 lines of non-generated code or
  fewer, and split larger work by concern. Deleting files and comment-only or
  other mechanical edits may exceed it, with a note in the description.
- **Atomic Conventional Commits.** One logical change per commit, written as
  `<type>(<scope>): <short description>`.
- **Pull-request description.** Summary, what users and contributors can now do,
  risk and rollout, rollback, and test plan (the template guides you).
- **What's New entry** for every user-facing change, with the pull-request
  template's checkbox.

For UI work read [docs/ui-conventions.md](docs/ui-conventions.md). For tax-table
changes read [docs/yearly-tax-refresh.md](docs/yearly-tax-refresh.md).

## Licensing

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE) (section 5). There is no sign-off line and no
contributor agreement to sign.

## Conduct and security

Be kind: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report security problems
privately, never as a public issue: see [SECURITY.md](SECURITY.md).
