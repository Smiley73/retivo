# Local setup

This guide takes you from a fresh clone of RETIVO to a running copy on your own
machine, signed in, with demo data loaded and every check the repo has within
reach.

## What you get

A local run starts the web app and its API on your machine. The services the API
normally uses in the cloud are replaced by **emulators**: small programs, run in
Docker, that behave like the real Amazon services but keep everything on your
computer. Nothing in this guide needs an Amazon account, and nothing leaves your
machine.

- **DynamoDB Local** stands in for the database. It is Amazon's own emulator
  image: free to run, but not open source.
- **Moto** stands in for file storage (S3) and email (SES). It is open source.

Both emulators keep their data in memory, so stopping and restarting them wipes
the slate clean.

Deploying to a real Amazon account is covered in the [deploy guide](deploy.md).

## Prerequisites

| Tool | Version | Check with |
|---|---|---|
| Node.js | 24.2 or newer, below 25 (`engines` in `package.json`) | `node -v` |
| pnpm | 10 (`packageManager` in `package.json` pins `pnpm@10.33.2`) | `pnpm -v` |
| Docker with Compose v2 | a recent version | `docker compose version` |
| Git | a recent version | `git --version` |

You also need a Unix-style shell (macOS, Linux, or WSL on Windows) for the
commands below. `openssl` and `jq` are needed only for the optional key step.

## Set up

1. **Clone and install.**

   ```bash
   git clone https://github.com/Smiley73/retivo.git
   cd retivo
   pnpm install
   ```

2. **Create your settings file.**

   ```bash
   cp .env.example .env
   ```

   `.env` is ignored by Git. The defaults are already wired to the emulators, so
   you do not have to edit anything to get started.

3. **Optional: generate sign-in keys.** The API signs login tokens with a
   key pair. If `.env` still holds the placeholder values from
   `.env.example`, the API makes a temporary pair each time it starts and prints
   `[auth] AUTH_JWT_PRIVATE_KEYS missing or placeholder — generated an
   ephemeral RSA-2048 keypair`. That works, but after every API restart your
   old session no longer validates and you sign in again. The API restarts
   whenever you edit its code, so if you are changing the code, make a permanent
   pair once:

   ```bash
   PRIV=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)
   PUB=$(printf '%s\n' "$PRIV" | openssl pkey -pubout)
   {
     printf 'AUTH_JWT_PRIVATE_KEYS=%s\n' "$(jq -cn --arg pem "$PRIV" '{"local-dev": $pem}')"
     printf 'AUTH_JWT_PUBLIC_KEYS=%s\n' "$(jq -cn --arg pem "$PUB" '{"local-dev": $pem}')"
   } >> .env
   ```

   This appends two lines to `.env`. When a name appears twice, the API uses the
   last one, so the new lines win over the placeholders. Each value must stay on
   one line: the API loads `.env` with Node's `--env-file`, which reads one line
   per setting. The recipe uses `printf` rather than `echo` for the same reason,
   because some shells' `echo` turns the `\n` inside the keys into real line
   breaks.

4. **Start the emulators.**

   ```bash
   pnpm emu:up
   ```

   This starts two containers (`retivo-dynamodb-local` and `retivo-moto`) and
   reads `.env`, so create that first. The first run pulls the images. The
   emulators listen on ports 8000 and 5001 (macOS uses port 5000 for AirPlay,
   which is why Moto sits on 5001). To change them, set `EMU_DYNAMODB_HOST_PORT`
   and `EMU_MOTO_HOST_PORT` in `.env` and keep `DYNAMODB_ENDPOINT` and
   `S3_ENDPOINT` pointing at the same ports. Set `REGISTRY` if you pull images
   from a mirror. `pnpm emu:down` stops them.

5. **Start the app.**

   ```bash
   pnpm dev
   ```

   This runs the API and the web app together.

   | What | Address |
   |---|---|
   | Web app | http://localhost:5173 |
   | API | http://localhost:3001, under `/api/v1` (for example `/api/v1/health`) |

   Open the web app as `localhost`. Vite also prints `http://127.0.0.1:5173`,
   but the API's allowed-origins list names `localhost`, so the browser blocks
   the app's requests from the `127.0.0.1` address.

   On start-up the API creates the tables and the snapshots bucket in the
   emulators if they are missing, and adds a ready-made account (below). Because
   the emulators lose everything when they restart, restart `pnpm dev` after
   restarting them.

## Sign in for the first time

There are two ways in. The quick route uses an account the API creates for you.
The full route creates a new account the way anyone else would.

Two things to know first.

- **No email is sent locally.** The API only sends mail when it runs in
  production mode or when `SES_ENDPOINT` is set, and `.env.example` leaves
  `SES_ENDPOINT` commented out. Steps that would normally email you a link
  instead hand the link to the browser, because `EXPOSE_VERIFICATION_TOKEN=true`
  is the default outside production. A deployed stack refuses that setting.
  [Which mailed steps have a shortcut](#which-mailed-steps-work-locally) is
  listed below.
- **Your data is encrypted in the browser** before it goes to the server, so the
  first sign-in on any account includes an encryption set-up step with a
  recovery key. The [security overview](security.md#encryption) explains how.

### Quick route: the ready-made account

When the API starts against the emulators, it adds a verified, approved account
if it is not there yet:

| Email | Password |
|---|---|
| `dev@local.test` | `LocalDevPass1!` |

The login page fills these in for you when you open it on `localhost`, `127.0.0.1`
or a private network address (for example `192.168.x.x`), in a dev build.

1. Open http://localhost:5173 and choose **Sign in**.
2. On **Set up encryption**, the password is already filled in. Choose
   **Set up encryption**.
3. **Save your recovery key** appears. Copy the key and keep it, because it is
   the only way back into your encrypted data if you forget the password. Tick
   **I have saved my recovery key** and choose **Continue**.
4. You land on the Dashboard with a **Try the demo dataset?** dialog. **Load demo
   data** fills the workspace with a sample household. **Skip** leaves it empty.

On later sign-ins in the same browser you just sign in. In a browser that has
never held this account's key (a new browser profile, or after clearing site
data), you get **Unlock your data** instead and enter the password.

### Full route: sign up

1. Open http://localhost:5173/signup (or choose **Sign up** on the login page).
2. Fill in **First name**, **Last name**, **Date of birth**, **Email** and
   **Password**, tick **I understand this is not financial advice**, and choose
   **Create account**.
3. **Check your inbox** appears. No mail was sent, so use the **verify now**
   link marked **Dev shortcut**.
4. The **Email verification** page says the owner has been notified and sign-in
   is locked until they approve. Any email other than `APPROVER_EMAIL` starts
   out waiting for approval. `APPROVER_EMAIL` falls back to `SES_FROM_ADDRESS`,
   which is `no-reply@example.invalid` locally. Use the **approve this account**
   link, again marked **Dev shortcut**. (To skip approval, set `APPROVER_EMAIL`
   in `.env` to the address you sign up with and restart `pnpm dev`; that
   address is approved on sign-up. You still verify the email.)
5. Choose **Go to sign in** and sign in with your email and password.
6. On **Set up encryption**, the field is pre-filled with the ready-made
   account's password. Clear it, type the password you signed up with, and
   choose **Set up encryption**.
7. In **Save your recovery key**, tick **I have saved my recovery key** and choose
   **Continue**.
8. The app quietly creates your household from the name and date of birth you
   gave, and the Dashboard shows **Your household is set up.** with a **Load demo
   data** button. Use it for a sample household, or dismiss the banner with the
   **×** to keep just your own member.

### Which mailed steps work locally

| Step | Local shortcut |
|---|---|
| Email verification | Yes: **verify now** on the sign-up confirmation, and on the page that offers to resend the link. |
| Owner approval | Yes: **approve this account** on the verification page, or set `APPROVER_EMAIL` to your own address. |
| Password reset | Yes: **reset now** appears under the form on **Forgot password?** after you send a link. The account must be verified, and a new link can be requested once a minute. A reset does not unlock your saved data; you still need your recovery key. |
| Email change (Settings → Security → Account → Change email) | No button. The API's reply carries the link's token when the second factor is off, but the app does not show it. You would copy it from your browser's network tools and open `/auth/change-email/confirm#token=<token>`. |
| Second-factor code by email | No. The code is neither sent nor shown. Use an authenticator app or a passkey instead (see below). |

## Reset local data

Everything under **Settings → Workspace** (the **Workspace tools** card):

- **Load demo data** loads the sample household. It warns before replacing data
  you already have.
- **Reload from server** drops everything this browser holds, including edits
  that have not synced yet (it lists them first), and downloads a fresh copy.
  You stay signed in.
- **Clear data on this device** signs you out and wipes the browser's stored
  copy (the browser keeps its working data in IndexedDB, a database built into
  the browser). Server data is untouched and comes back at your next sign-in.
- **Delete workspace data** asks for your password and a confirmation, then
  clears every account, scenario, expense and member on the server and in the
  browser, demo data included. Your account and sign-in stay.

For a completely clean start, including the ready-made account:

```bash
pnpm emu:down && pnpm emu:up
```

Then restart `pnpm dev` (it re-creates the tables and the account on start) and
clear the browser's stored data for `localhost:5173` too, for example with
**Clear data on this device** before you stop the emulators.

## Run the checks

Run these from the repo root. **`pnpm gate` runs the full set**, in this order,
and stops at the first failure.

| Command | What it does |
|---|---|
| `pnpm lint` | ESLint over the API and web sources. |
| `pnpm depcruise` | Checks module boundaries and import cycles. |
| `pnpm knip` | Finds unused files, exports and dependencies. |
| `pnpm typecheck` | Builds the shared `packages/contracts` package, then type-checks every package, including the browser tests in `apps/web/e2e`. |
| `pnpm test` | Runs each package's tests one package at a time, then the script tests. |
| `pnpm audit:ci` | `pnpm audit` for known vulnerabilities in dependencies (moderate and above). Needs network access. |
| `pnpm gate` | All of the above: `lint`, `depcruise`, `knip`, `typecheck`, `test`, `audit:ci`. |

Other scripts:

| Command | What it does |
|---|---|
| `pnpm test:scripts` | Only the script tests (`scripts/test` and `apps/api/scripts`), with Node's built-in test runner. Part of `pnpm test`. |
| `pnpm test:affected` | Quick loop: runs just the tests related to your uncommitted changes. Add a ref to widen it, for example `pnpm test:affected main`. It is not the full check. |
| `pnpm test:coverage` | Like `pnpm test`, with coverage measured. Slower. |
| `pnpm test:e2e` | The end-to-end browser tests (next section). |
| `pnpm build` | Builds every package. |

To run one test file or a pattern:

```bash
pnpm --filter @retirement/api exec jest <pattern>
pnpm --filter @retirement/web exec vitest run <pattern>
```

Where tests live, and what they need:

| Tests | Location | Needs the emulators |
|---|---|---|
| API (Jest) | `apps/api/src/**/*.spec.ts`; integration tests in `apps/api/src/test/` | **Yes.** Run `pnpm emu:up` first. They create their own temporary tables, separate from the ones `pnpm dev` uses. |
| Web (Vitest) | beside the code, in `apps/web/src` | No |
| Script tests | `scripts/test`, `apps/api/scripts` | No |
| End to end (Playwright) | `apps/web/e2e` | Yes, and `pnpm dev` too |

The API tests read your `.env`. With a `.env` copied unchanged from
`.env.example`, one of them fails: `src/common/env.config.spec.ts`, "defaults to
false when unset under any NODE_ENV", because the example file sets
`EXPOSE_VERIFICATION_TOKEN=true` and that test runs as production. Comment that
line out in `.env` (put a `#` in front). Outside production the app already
defaults it to true, so the sign-up shortcuts keep working.

## End-to-end tests

The Playwright suite drives the real app in a real browser as the ready-made
`dev@local.test` account, so the whole local stack has to be running. In one
terminal, start the emulators and the API and web app, and leave it running:

```bash
pnpm emu:up
pnpm dev
```

In a second terminal, run the suite:

```bash
pnpm test:e2e
```

Before the first run:

- Install the test browser once: `pnpm --filter @retirement/web exec playwright install chromium`.
- Uncomment `DISABLE_THROTTLE=true` in `.env` and restart `pnpm dev`. Without it
  the API's rate limit trips partway through and tests fail at the **Set up
  encryption** step. The API refuses this setting in production.

Every test starts from a clean slate, so **each run wipes the ready-made
account's data** on the server and in the browser. If you use that account for
your own work, sign up a separate account for that, or reload the demo data
afterwards.

To pick tests, add a name pattern (`pnpm test:e2e smoke`). To debug one in an
interactive window, run `pnpm --filter @retirement/web test:e2e:ui`. The suite
always uses port 5173.

## Optional modes

### Keep changes in the browser only

Set `VITE_SYNC_MOCK=true` in `.env` and restart `pnpm dev`. Signing in still
goes to the API, so the emulators and the API must be running. What changes is
syncing: the app stops sending data to the server and shows itself as
synced, so your edits live only in the browser's storage.

### Turn the second factor on

Locally, signing in needs only a password. Deployed stacks also ask for a [second
factor](security.md#the-second-factor), and `AUTH_MFA_ENFORCED=true` in `.env` (then a `pnpm dev` restart) turns
that on locally. Because the emailed code never arrives locally, first add an
**authenticator app** under **Settings → Security → Two-factor authentication**,
or a passkey under **Passkeys**, while the setting is off. With the setting on
and no such factor, sign-in stops at an email code you cannot receive. Set it
back to `false` and restart to get back in.

Passkeys work only on `localhost`. Browsers refuse them over plain-HTTP network
addresses.

### Run a second checkout

Two checkouts running at once collide on ports 3001 and 5173. In the second
one's `.env`, change the whole set together. Changing only the ports leaves the
web app calling the wrong API, and the API rejecting the web app. For web on
5273 and API on 3101:

```bash
VITE_PORT=5273
API_PORT=3101
VITE_API_BASE_URL=http://localhost:3101
WEB_ORIGIN=http://localhost:5273
WEB_ALLOWED_ORIGINS=http://localhost:5273
```

`VITE_API_BASE_URL` has to be set here. Left blank, the web app assumes the API
is on port 3001. Both checkouts use the same emulators, so they share the same
local accounts and data. Run `pnpm emu:up` from only one of them.

### Open the dev server from another device

By default both servers listen on `127.0.0.1`, so only your own machine can reach
them. To use a phone or a second laptop on your network:

1. In `.env`, set `API_HOST=0.0.0.0` and `VITE_HOST=0.0.0.0`.
2. Find your machine's network address, for example `192.168.1.42` (on macOS,
   `ipconfig getifaddr en0`).
3. Add the device-facing address to the allowed origins:
   `WEB_ALLOWED_ORIGINS=http://localhost:5173,http://192.168.1.42:5173`.
   Origins not on the list are rejected.
4. Leave `VITE_API_BASE_URL` blank. The web app then calls the API on whatever
   host it was loaded from.
5. Restart `pnpm dev` and open `http://192.168.1.42:5173` on the other device.

> **Security.** `0.0.0.0` exposes the app and API, including the ready-made
> account's password, to every device on your network. Do this only on a network
> you trust. Passkeys do not work this way, because browsers allow them only on
> `localhost` or HTTPS; use a password.

## Folder map

| Folder | Contents |
|---|---|
| `apps/web` | The web app: React, Vite, and the browser-side storage and encryption. |
| `apps/api` | The API: NestJS, with the Lambda entry point used when deployed. |
| `packages/contracts` | Request and response types shared by the web app and the API. |
| `infrastructure` | Pulumi code for the Amazon deployment, and the Docker file for the emulators. |
| `scripts` | Repo-wide check scripts and their tests. |
| `docs` | Guides, including this one. |

To see how the pieces fit together, read the
[architecture overview](architecture.md). Once the app runs, the
[user guide](user-guide.md) explains each screen. To run it on Amazon, follow the
[deploy guide](deploy.md).

For the repo's coding rules, see [CODING_STANDARDS.md](../CODING_STANDARDS.md)
and [AGENTS.md](../AGENTS.md). The project overview is in
[README.md](../README.md).
