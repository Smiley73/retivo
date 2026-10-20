# RETIVO

[![CI](https://github.com/Smiley73/retivo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Smiley73/retivo/actions/workflows/ci.yml)

**Model your retirement. See the possibilities.**

RETIVO (**R**etirement **E**xploration **T**hrough **I**nputs, **V**ariables &
**O**utcomes) is a retirement planner you run yourself. You enter your household,
accounts, income and spending, and it projects how your savings could hold up
through retirement, so you can change one assumption at a time and compare.

It is for developers who want to self-host it (run your own copy rather than
use someone else's), people who want to check the math, and contributors. The
calculations are US-specific: federal income tax, Social Security, Medicare
(IRMAA), ACA subsidies, and RMD and QCD rules.

RETIVO is **local-first**: your data lives in your browser, and the browser
encrypts it before syncing it to a small server that runs in your own Amazon
account. A local AI assistant such as Claude Code or Codex can read and
run your plan through an opt-in connector, with the data staying in your browser
except for the results you allow; see the
[AI assistants guide](docs/ai-assistants.md).

## What you need

- **To run it for real:** your own Amazon Web Services account. You deploy RETIVO
  there and pay Amazon for it.
- **To try it on your computer:** no Amazon account. A local run uses Docker
  emulators that keep everything on your machine.

## Status

RETIVO is in active development. It has no releases yet, and only the latest
`main` is supported (see [SECURITY.md](SECURITY.md)). One person maintains it.
Treat the projections as estimates, and read
[Not financial advice](#not-financial-advice) before you rely on them.

## Guides

- [Local setup](docs/local-setup.md): run RETIVO on your own computer, sign in
  and load demo data.
- [Deploy](docs/deploy.md): put RETIVO in your own Amazon account, step by step.
- [User guide](docs/user-guide.md): what each screen does and how to read the
  results.
- [AI assistants](docs/ai-assistants.md): let an AI assistant on your computer read
  and run your plan, what it can see, how to set it up and what it does not
  protect.
- [Architecture](docs/architecture.md): how the browser storage, sync,
  encryption and server fit together, for people changing the code.
- [Security overview](docs/security.md): how sign-in and encryption work, and
  what the server can and cannot see.
- [How the math works: taxes](docs/math-taxes.md): how federal tax, tax on
  Social Security and early-withdrawal penalties are worked out.
- [How the math works: Social Security and health costs](docs/math-social-security-and-health.md):
  benefits, claim-age comparison, Medicare surcharges and ACA credits.
- [How the math works: retirement accounts](docs/math-retirement-accounts.md):
  required distributions, charitable gifts, Roth conversions and Roth
  withdrawals.
- [How the math works: income, expenses and account returns](docs/math-income-expenses-and-returns.md):
  what each year's income and spending are, and how accounts grow.
- [How the math works: withdrawals](docs/math-withdrawals.md): which accounts pay
  each year, in what order, and how tax is covered.
- [How the math works: projections](docs/math-projections.md): how a plan
  becomes balances over time, and how the stress test works.

## Not financial advice

Projections are estimates built from what you enter and from simplified
assumptions, and actual results will differ. Nothing RETIVO produces is
financial, investment, tax or legal advice. Get advice from a qualified
professional before you make a decision.

## Questions, bugs and ideas

- **A question** about running, deploying or using RETIVO: ask in
  [Discussions](https://github.com/Smiley73/retivo/discussions).
- **A bug or an idea:** open an
  [issue](https://github.com/Smiley73/retivo/issues/new/choose) and pick the form.
- **A security problem:** report it privately; see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up and what a change must
pass, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for how we treat each other, and
[SECURITY.md](SECURITY.md) for reporting a security problem privately.

## License

RETIVO is licensed under the [Apache License 2.0](LICENSE). Third-party credits
(fonts and market data) are in [NOTICE](NOTICE).
