# Security policy

## Reporting a problem

Please do not file security problems as public issues.

Report them privately through GitHub's private vulnerability reporting:
<https://github.com/Smiley73/retivo/security/advisories/new>

Say what you found, the steps to reproduce it and what an attacker could do
with it. Do not include real financial figures, passwords or recovery keys.

## What is supported

- Only the latest `main` is supported. There are no releases.
- There is no hosted RETIVO service and no bug bounty. Everyone deploys their
  own copy, so test only against a deployment you own. Never test against
  someone else's.

## What counts

The code in this repository, including the deploy code under `infrastructure/`.

For how sign-in and encryption work, and what the server can see, read
[docs/security.md](docs/security.md).
