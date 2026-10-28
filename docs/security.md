# Security overview

This guide is for people who run their own copy of RETIVO, want to check what
it claims about security, or are about to change code that touches sign-in or
encryption. It explains how an account is created and signed in to, how the
second factor works, how the household data is encrypted and unlocked, and what
the server (and so the person who runs the Amazon account) can and cannot see.

Everything here describes the code as it is today. File names in backticks are
where to check each claim. This is a description, not a guarantee: it does not
promise that the software is free of flaws. For the mechanics of browser
storage and sync, which this guide does not repeat, see
[architecture.md](architecture.md). For running a copy on your own machine, see
[local-setup.md](local-setup.md); for deploying to your own Amazon account, see
[deploy.md](deploy.md); for the screens themselves, see
[user-guide.md](user-guide.md).

## The short version

What the encryption does:

- A household's financial records are encrypted in the browser before they
  leave it. The server stores and relays only that scrambled form. Someone who
  can only read the stored data (the database tables, the snapshot files, the
  backups, or a leaked copy of any of them) cannot read the records.
- The key that unlocks the records is stored on the server only in locked
  ("wrapped") form. It is locked three ways: by your password, by a recovery
  key, and optionally by a passkey.

What it does not do:

- **It does not encrypt the data on the device.** The browser keeps the working
  copy of the data as plain text, and keeps the unlocked key next to it. Both
  survive a plain sign-out. See [Data on the device](#data-on-the-device).
- **The server receives your password.** Sign-up and sign-in send it to the API.
  The key that unlocks the "password" slot is derived from that same password
  in the browser. So encryption protects the data from someone who can only
  read what is stored. It does not protect against someone who can change the
  server code, or the web app the server hands out, because they could capture
  the password or the key as you type or unlock. For a self-hoster, that
  "someone" is whoever controls the Amazon account and the deploy. This is not
  a flaw particular to RETIVO; it is what a web app that serves its own code
  can and cannot promise.
- **The server stores a good deal in readable form**: your email, name and date
  of birth, sign-in history with IP addresses, authenticator secrets, and
  metadata about every change. See
  [What the server can and cannot see](#what-the-server-can-and-cannot-see).
- **Losing access has hard edges.** A password reset lets you sign in again but
  does not by itself unlock your data. The data opens with the recovery key, a
  passkey set up for unlocking, a browser that still holds the key, or the
  password the data was last locked with (after a reset, that is your old
  password). With none of those it cannot be recovered. See
  [If you lose access](#if-you-lose-access).

## Accounts and sign-in

### Sign-up

Sign-up asks for an email address, a password, a first name, a last name and a
date of birth. The browser sends all of them to the API over HTTPS
(`apps/api/src/auth/signup.service.ts`).

1. **Email verification.** The API emails a link. It works for 15 minutes, and
   an account that is never verified is abandoned after 24 hours.
2. **Approval by the owner.** On a deployed stack, every sign-up except one that
   uses the approver's own address waits for the owner. The approver is the
   address in the stack setting `approverEmail` (the API reads it as
   `APPROVER_EMAIL`). After the new person verifies their email, the approver
   gets a message with the applicant's name and email address (not the date of
   birth) and an approve link and a decline link. The new person cannot sign in
   until the owner approves. If nobody acts for 7 days the pending account is
   deleted (`signup-approval.service.ts`).

### Password rules

The API enforces these on sign-up, on changing the password and on resetting it
(`password-validator.service.ts`):

- at least 16 characters, with an uppercase letter, a lowercase letter, a digit
  and a symbol;
- not on a built-in list of common passwords;
- not found in known data breaches. The API checks the Have I Been Pwned range
  service in a way that never sends the password: it sends only the first 5
  characters of the password's SHA-1 hash and looks for the rest of the hash in
  the list that comes back (`hibp-client.ts`). The check waits at most 3 seconds
  and **fails open**: if that service is down or slow, the check passes, and only
  the other rules apply.

### How the password is stored

The API stores an **Argon2id** hash of the password, not the password itself.
Argon2id is a password-hashing function built to be slow and memory-hungry so
that guessing is expensive. The API uses the argon2 library's default cost
settings (`signup.service.ts`, `login.service.ts`).

Sign-in always runs a hash comparison, even for an email address that has no
account, so the response time does not reveal which addresses exist
(`login.service.ts`).

After 3 wrong passwords in a row for an address, each further wrong password
makes the next attempt wait twice as long (2, 4, 8, 16, 32 seconds, then 64
seconds at most). On the 10th wrong password in a row, the account's owner gets
a notice email, at most once every 24 hours (`failed-login.service.ts`,
`login-guessing-notice.service.ts`).

### Sessions

- **Access token.** A **JWT** (JSON Web Token: a signed piece of text that says
  who you are) signed with RS256, valid for 5 minutes. The web app holds it in
  memory only and sends it with each request (`jwt.service.ts`, setting
  `AUTH_ACCESS_TOKEN_TTL_MIN`).
- **Refresh token.** A random value that gets a new access token when the old
  one expires. The server keeps only its SHA-256 hash. The browser keeps it in a
  cookie named `__Secure-rt` (in production) that page scripts cannot read
  (`HttpOnly`), that is only sent over HTTPS (`Secure`) and only from the app's
  own site (`SameSite=Strict`), and that is scoped to `/api/v1/auth`
  (`cookie-config.ts`). Every refresh issues a new token and retires the old
  one. If a retired token is ever presented again, the whole chain of tokens
  from that sign-in is revoked and the event is recorded
  (`refresh-token.service.ts`).
- **Idle timeout.** A refresh token lasts 30 minutes from the moment it is issued
  (`AUTH_REFRESH_TOKEN_TTL_MIN`), so a session that makes no requests for 30
  minutes ends on the server. The web app also watches for keyboard, mouse and
  touch input. After 30 minutes without any it signs you out, and it warns you 2
  minutes before that (`IdleTimer.tsx`; build setting `VITE_IDLE_TIMEOUT_MIN`).
  A deployed stack does not override either default.
  An AI assistant's activity does not count as input unless the person turned on
  "Let assistant activity keep me signed in" for that session; see
  [AI assistants](#ai-assistants).
- **Ending sessions.** Signing out revokes that session on the server. Changing
  the password or completing a password reset ends every session. Signing out
  does not clear the data kept on the device (see
  [Data on the device](#data-on-the-device)).

### Request-forgery protection

**CSRF** (cross-site request forgery) is when another website tricks your
browser into sending a request to the app while you are signed in. Three things
guard against it:

- The cookies are `SameSite=Strict`, so the browser does not attach them to
  requests started from other sites.
- Every request that changes data (POST, PUT, PATCH, DELETE) must carry an
  `X-CSRF-Token` header whose value equals the `csrf-token` cookie
  (`csrf.middleware.ts`). Routes that run before any session exists, such as
  sign-in, sign-up and the links in emails, cannot have that cookie yet. They
  are exempt and rely on unguessable tokens, the origin check and rate limits.
  The session refresh route is exempt too; it relies on the `SameSite=Strict`
  refresh cookie and the origin check.
- The API checks the `Origin` header (or `Referer` when `Origin` is missing) of
  every request that changes data against the list of allowed web addresses
  (`origin-check.middleware.ts`).

### Emails the app sends about your account

All are best effort: a failure to send does not block the action.

- A **verification** link (sign-up, and a new address in an email change).
- A **password reset** link (valid 15 minutes) and a notice when a reset
  completes. The link carries its token after a `#`, so the browser does not send
  it to the server when the page loads.
- A notice to the **old** address when an email change completes.
- A notice when a **passkey or authenticator app is added or removed**. It holds
  a link, valid for 24 hours and usable once, that undoes an addition and signs
  you out everywhere (`factor-notice.service.ts`).
- A notice about **repeated failed sign-ins** (above).
- Email **sign-in codes** (below).

### Signing in with a passkey

A **passkey** is a sign-in credential held by your device or password manager.
It works with the **WebAuthn** browser standard: the device keeps a private key
and gives the server only the matching public key, and each sign-in proves you
hold the private key. The API requires "user verification", meaning your device
PIN, fingerprint or face (`passkey.controller.ts`).

Signing in with a passkey needs no password and counts as both factors, so it
skips the second-factor challenge. It does not by itself unlock your data; see
[Unlocking](#unlocking).

## The second factor

A **second factor** is a second proof of identity besides the password.

### The three methods

| Method | Name in the app | How it works |
|---|---|---|
| Passkey | Passkey | A WebAuthn assertion, as above. |
| **TOTP** (time-based one-time password) | Authenticator app | A 6-digit code that changes every 30 seconds, made from a secret shared between your authenticator app and the server. |
| Email code | Email code | A 6-digit code emailed to the account address. It is valid for 10 minutes, allows 5 wrong tries, can be requested once a minute and at most 5 times a day (`mfa-email-otp.service.ts`). |

The sign-in challenge offers a passkey first if one is enrolled, then the
authenticator app if one is set up, and otherwise the email code. **The email
code is always offered as a fallback**, even when stronger factors exist.

Repeated wrong authenticator codes for an account trigger the same growing wait
as wrong passwords (`mfa.service.ts`).

An authenticator code is accepted **once**, at sign-in or to confirm a sensitive
action. The server records the 30-second step of the last code it accepted, and
the same code presented again, even inside that half-minute, is treated as a
wrong code (and counts toward the wait above), so a captured code cannot be
replayed. Wait for the next code.

### When it is required

A deployed stack requires a second factor by default (stack setting
`authMfaEnforced`, which sets `AUTH_MFA_ENFORCED` for the API). After a correct
password, a browser that is not trusted gets a challenge and receives no session
until it passes (`login.service.ts`, `mfa.controller.ts`). The operator can turn
this off with the setting. Running locally, it is off. See
[Local versus deployed](#local-versus-deployed).

### Trust this device

On the challenge screen, a passkey or an authenticator code can be passed with
**Trust this device for 30 days** ticked. So can an email code, but only when it
is the account's only second factor (no passkey and no authenticator app). The browser then skips the second factor on later sign-ins for 30
days. The browser keeps a secret in a cookie named `__Secure-dt` (production;
`HttpOnly`, `SameSite=Strict`), and the server stores its SHA-256 hash together
with the device id, the IP address and the browser's user agent. Passing the
challenge with the email code as a fallback while any passkey or authenticator
app is set up does not offer this.

Trusted devices are listed under Settings, Security, Two-factor authentication,
Trusted devices, where you can forget one or all of them.

### Step-up for sensitive actions

For sensitive actions the app asks for a fresh proof even though you are signed
in. When the second factor is enforced, that proof is a second factor, and most
of the actions also ask for your password again. The actions are:

- changing the account email or the password;
- adding a passkey or an authenticator app;
- turning off the authenticator app, or removing a passkey;
- turning a passkey into an unlock method for your data, or removing or replacing
  a key slot (see [The three unlock slots](#the-three-unlock-slots));
- starting over with encrypted data (see
  [Start over](#start-over-resetting-encryption));
- deleting the account.

Adding a passkey or an authenticator app re-checks the password on every stack,
whether or not the second factor is enforced (`factor-enrollment-guard.service.ts`,
`step-up.service.ts`).

A passkey or authenticator app added while a password reset is pending, or in
the 24 hours after one completes, is held as "Needs confirmation". It cannot be
used to sign in or approve changes until you confirm it with a sign-in method you
had before the reset (`factor-restriction.ts`).

### If you lose access

- There are **no recovery codes** for the second factor.
- **You lose your authenticator app or passkey.** Choose "Email code" on the
  challenge. A code goes to the account's email address. Once in, you can remove
  the lost factor. Removing accepts the email code as the proof. Adding a new
  factor accepts it only when no other passkey or authenticator app remains;
  otherwise you confirm with the one that remains. The lost factor is not
  needed.
- That fallback means the second factor is only as strong as the email inbox.
  Someone who has your password and your inbox can pass the challenge, sign in,
  and then unlock your **data** with that same password, because the password
  slot opens with it. Someone who controls only your inbox can reset the password
  and sign in, but cannot unlock your **data** unless they also know the password
  the data was last locked with, or hold the recovery key, a passkey set up for
  unlocking, or a browser that already holds the key. An inbox alone is enough,
  though, to replace your second factor with theirs: removing a passkey or the
  authenticator app accepts the email code, so after the reset they can remove
  yours and then add their own. One added while the reset is pending or in the
  24 hours after it is held as "Needs confirmation"; one added later is not. The
  notices about these changes go to that same inbox.
- **You also lose the inbox.** The app has no way back in: it has no
  administrator role or support flow, and changing the account email needs you to
  be signed in. The person who runs the Amazon account has direct access to the
  tables, but the app gives them no feature for this.
- **The undo link in a factor-change notice** is not a way back in. It exists for
  the owner who did not make the change. For an added factor, it removes that
  factor. For a removed factor, it cannot restore it. In both cases it signs the
  account out everywhere. It works once and only for the most recent change.
- **You forget your password.** "Forgot password?" on the sign-in page emails a
  reset link. A reset gives you a new sign-in password but does not by itself
  unlock the data. If you still know your old password, it still opens the data
  at "Unlock your data". See
  [Password change, password reset](#password-change-password-reset).
- **You lose the recovery key and cannot unlock the data.** The data opens with
  any of: a passkey set up for unlocking, a browser that still holds the key, or
  the password the password slot was last locked with (after a reset that has
  not been followed by an unlock, your old password). If none of those works, the
  encrypted data cannot be recovered. See
  [Start over](#start-over-resetting-encryption), which keeps the account but
  wipes the data. Try the old password before starting over.

## Encryption

### The household key and the payloads

The first time a household signs in, the browser generates a random 256-bit
**household key** with the browser's built-in crypto (`apps/web/src/crypto/key-wrapping.ts`).
The server never receives it in readable form.

Each record that syncs is encrypted on its own (`payload-crypto.ts`):

- The cipher is **AES-256-GCM**, a standard cipher that both scrambles data and
  detects any change to it. Each record gets a fresh random 12-byte nonce.
- The AES key is not the household key itself. It is derived from it with
  **HKDF**, a standard way to derive several separate keys from one master key.
  Other keys for other jobs (the key-set check and the freshness check below) are
  derived with different labels.
- The record's household id, record id, record type and encryption version are
  fed in as extra authenticated data. Decryption fails if a ciphertext is moved
  to another record or another household. The version number, the time and the
  device are **not** bound: a server could hand back an older ciphertext of the
  same record. The freshness check below catches part of that, not all of it.

The snapshots the server writes for restores are built from these same
ciphertexts.

**The push path refuses plaintext.** The API rejects any change whose payload is
not in the encrypted envelope shape, and one such change fails the whole batch
with nothing written (`apps/api/src/sync/push.service.ts`). It checks the shape.
It cannot tell real ciphertext from random bytes, and it never holds the key.

### The three unlock slots

The household key is stored on the server as **slots**. Each slot is the
household key encrypted (AES-256-GCM) under a different unlocking secret. The
slot's type, its key-derivation settings and the encryption version are bound in
as extra authenticated data, so tampering with the settings makes unlocking fail.
Any one slot opens the household key.

| Slot | Unlocked by | How the unlocking key is made |
|---|---|---|
| Password | Your account password | **Argon2id** in the browser: 64 MiB of memory, 3 passes, 4 lanes, a random salt. Slots from before Argon2id used PBKDF2-HMAC-SHA-256 (typically 600,000 rounds) and still unlock. |
| Recovery | The recovery key | The key is 128 random bits, shown as 8 groups of 4 letters and digits. It is random, so HKDF is applied to it directly with no slow stretching. |
| Passkey | A passkey on this device, if you set it up | The **WebAuthn PRF extension** lets a passkey produce a secret that depends on a salt and never leaves the authenticator. That secret goes through HKDF to make the key. Not every browser or authenticator supports it. |

Notes:

- A slot opens with the secret it was last locked with, not with whatever the
  secret is called today. The password slot opens with the password it was last
  re-wrapped under. That is the current password, except after a password reset
  and before the next unlock, when it is still the old one. Replacing a slot does
  not change the household key. The server keeps the slot it displaced for 30
  days (and backups for up to 90), so the old secret keeps working against a
  copy of the stored data for that long, and anyone who already unlocked with it
  keeps the household key.
- The password slot's key comes from the same password the API receives at
  sign-in. That is why a server you do not trust with your password cannot also
  be trusted with the data (see [The short version](#the-short-version)).
- A copy of the stored data lets someone try passwords against the password slot
  offline. The Argon2id cost, the 16-character minimum and the breach check make
  that slow. The recovery key and a passkey's secret are random, so they cannot
  be guessed that way.
- The recovery key is shown once, in the browser, and never stored anywhere by the
  app. The server cannot show it again. You can make a new one under Settings,
  Security, Recovery key & encryption, "Generate a new recovery key". The app
  stops accepting the old key once the new one is active, but the replaced slot
  stays readable as described in the first note above.
- Only one passkey at a time can be the unlock slot ("Use for encryption" on the
  Passkeys card). Choosing another replaces it.

### First-time setup

After the first sign-in of a new account, **Set up encryption** asks for the
account password again. The browser then generates the household key, builds the
password slot and the recovery slot, and uploads them. **Save your recovery key**
shows the recovery key once and asks you to confirm you saved it before you
continue.

### Unlocking

After sign-in the browser needs the household key before it can decrypt
anything. It gets it one of two ways:

1. **From the device.** If this browser already holds the key, it uses it. See
   [Data on the device](#data-on-the-device).
2. **From a slot.** Otherwise **Unlock your data** asks for the password, or for
   the recovery key ("Use recovery key instead"), or offers "Unlock with passkey"
   when a passkey slot exists.

Before it trusts what the server served, the browser checks it (`key-wrapping.ts`,
`freshness.ts`, `apps/web/src/sync/sync-client.ts`):

- **Key-set check.** Once it has the household key, the browser computes a tag
  (an **HMAC**, a keyed checksum) over all the slots and a version number, and
  compares it with the tag the server stored. Removing, adding or editing a slot
  changes the tag.
- **Rollback checks.** Each browser remembers the highest key-set version and
  the highest freshness counter it has seen. A server that serves a lower one is
  refused. The counter is signed with a key derived from the household key, and
  the browser raises it with each push.
- **A "no keys" guard.** If a browser has used a key before and the server
  suddenly reports none, the browser stops instead of starting a new key.

The limits: a brand-new browser has nothing to compare against and accepts what
the server first serves. The freshness counter covers the counter only, not each
record's content, so it is not proof that every record is the latest one.

### Password change, password reset

- **Changing the password** (Settings, Security, Password) needs the data to be
  unlocked. The browser re-wraps the password slot under the new password, the
  API swaps the sign-in password and the slot together, and every other session
  is signed out.
- **A password reset** cannot re-wrap anything, because the server holds no key.
  It sets a new sign-in password and ends all sessions. The password slot stays
  locked under the old password. The next sign-in lands on "Unlock your data".
  The recovery key or a passkey slot opens the data there
  (`ResetPasswordPage.tsx`), and so does the **old password**, because the slot
  still opens with it. A browser that still holds the key can also carry on.
  Once the data is unlocked by any route, the app re-wraps the password slot
  under the new password, asking for it if it does not already have it
  (`useDerivedRewrap.ts`). Until that happens, anyone who knows the old password
  and can sign in can unlock the data with it. If you reset because the old
  password was exposed, unlock once so the re-wrap runs.

### Start over (resetting encryption)

If you cannot unlock your data, Settings, Security, Recovery key & encryption
shows **Delete unreadable encrypted data**. It leads to "Start over with this
account". After a password and typed confirmation (and a second factor, when
enforced), it deletes the synced data on this device and on the server (the
change records, the snapshots and the key slots) and signs you out everywhere. It
**keeps the account**, the sign-in details and the security history. You then
sign in again and run first-time setup on empty data. The API route is
`/api/v1/auth/encrypted-workspace-reset` (`encrypted-workspace-reset.service.ts`).

## Data on the device

**Data on the device is not encrypted at rest.** The browser's **IndexedDB** (the
database built into the browser) stores the household's records as plain text.
The unwrapped household key is cached in the same database
(`apps/web/src/crypto/key-cache.ts`). Encryption protects the data on the server
and in transit through sync, not on the device.

- A plain **sign-out keeps both** the records and the cached key, so the next
  sign-in is fast. Anyone who can read the browser profile (another person on a
  shared computer, someone with the unlocked disk, malware running as you) can
  read the data and the key.
- Both are removed only when the local database is dropped: **Clear data on this
  device** (Settings, Workspace, Workspace tools), account deletion, or a
  different person signing in on the same browser.
- Protect the device itself: a lock screen and full-disk encryption are what
  guard this copy.
- A local AI assistant reads this copy only through the open tab and only what the
  person allowed; see [AI assistants](#ai-assistants).

## What the server can and cannot see

"The server" means the API, its database tables, the snapshot files and the logs.
In your own copy that is everything in the Amazon account, so it is
everything the person who runs that account can read. Row types are in
`apps/api/src/dynamo/types.ts`.

### Readable by the server

- **The account record.** Email address, first name, last name and date of birth;
  when it was made; whether the email is verified and whether the owner approved
  the account. While an email change is pending, the new address too. Your email
  address also appears in lookup rows for sign-up, verification, password reset
  and approval.
- **The password hash**, and the password itself at the moment you sign up, sign
  in, change it or reset it, because it arrives in the request.
- **Sign-in and security events.** Each has a type, a time, the IP address, the
  browser's user agent and some details such as the device id or which second
  factor was used. They expire after 1 year. A failed sign-in for an address that has no account is
  recorded too, for 1 year, with the IP address and user agent, under a SHA-256
  hash of the address instead of an account id. The hash is not salted, so
  anyone who can read the table can check it against a guessed address, and
  deleting an account does not remove it. Active sign-ins carry the same IP
  address, user agent and device id. Failed-sign-in counters per email address
  last about a day.
- **Devices.** Each trusted device has an id, an IP address and a user agent.
  The sync device registry table has fields for a device name, operating system
  and user agent. The current API code does not write to it, but anything stored
  there would be readable.
- **Authenticator secrets.** The shared secret behind an authenticator app is
  stored so that the server can check codes. It is protected only by Amazon's
  standard at-rest encryption of the table, which the API reads through, so the
  server can read it. The same applies to a secret that is still being set up.
- **Passkey public keys**, with each credential id, usage counter, transports
  and whether it is backed up.
- **Per-change metadata.** For every change: which household, the record id, the
  record type, the operation (create, update or delete), the version, the time,
  the device id, the schema version and the size. Per record, the server also
  keeps the latest version, the update time and the deletion time. So it can see
  which kinds of record exist, how many, how big, and when they change. It also
  keeps a freshness counter and its tag, and short-lived (7-day) records that let
  a retried push be recognised.
- **Daily push-quota counters** per household.
- **The wrapped key slots**, still locked: the slot types, the key-derivation
  settings and salts, the passkey credential id and the version and tag of the
  key set. Earlier versions of the key set are kept for 30 days.
- **Mail content.** Verification links, reset links and email codes pass through
  the Amazon email service the stack is set up with.

### Not readable by the server

The financial records themselves: the household's accounts, balances, income,
expenses, scenarios and the rest, as they live in sync payloads and snapshots.
The server holds them only as ciphertext and never holds the key. The limit
described in [The short version](#the-short-version) applies: this is true of the
stored data, not of someone who can change the code.

### Logs

- **Application logs** (CloudWatch) record requests by method and path. They mask
  values logged under field names such as password, token, cookie, code, secret
  and email, one level deep. They do **not** mask user ids and household ids
  (`apps/api/src/logger/logger.module.ts`).
- **API access logs** record the IP address, method, path, status and user agent
  of each request (`infrastructure/src/api-gateway.ts`).
- Both are kept for the stack setting `logRetentionDays` (at least 90 on a stack
  named `prod`). The snapshot bucket's own access logs are kept 30 days. The
  optional audit trail (`manageCloudTrail`) records activity on the Amazon
  account itself, such as who changed a setting, not RETIVO's data.

### Backups and at-rest encryption

- DynamoDB tables use Amazon's standard at-rest encryption with a key Amazon
  owns, and the snapshot bucket uses S3's default encryption. These protect
  against theft of the physical disks. Anyone with permission to read the tables
  through Amazon's tools sees everything in the lists above.
- Optional **point-in-time recovery** (`enablePitr`) keeps a 35-day window of
  each table. When **backups** are switched on (`enableBackups`, prod stack
  only), Amazon copies every table and the snapshot bucket daily and keeps each
  copy for 90 days under a vault lock. These copy the account tables **as they
  are**, with all the readable fields above, and the ciphertext.
- **After deletion**, the account deletion text says security logs expire on
  their own after about a year and backups expire on their own within 90 days.
  That is consistent with the code: security events expire after 1 year, and
  backup copies after at most 90 days. Log lines age out on the
  `logRetentionDays` schedule. Amazon's expiry of deleted table rows can lag by
  about two days.

### Edge protections

CloudFront sits in front of the web app and the API. It adds security headers to
the web app, including HSTS (use HTTPS only) and a content security policy that
limits scripts and connections to the app's own address and sets
`frame-ancestors 'none'` (`infrastructure/src/edge-functions.mjs`). The one
exception is stack-gated: a stack that sets `assistantBridgePort` also lets the
browser open a WebSocket connection to exactly one address,
`ws://127.0.0.1:<that port>`, a program on the same computer, and nothing
broader; a stack that leaves it unset has no such entry (see
[AI assistants](#ai-assistants)). It also adds a
shared secret header (`X-Origin-Verify`) to API calls, and the API rejects calls
without it (`edge-auth.middleware.ts`). An optional firewall can be switched on with the stack setting
`enableWaf`. Setup for each belongs to the [deploy guide](deploy.md).

## AI assistants

This section covers the optional connector that lets an AI assistant running on
your own computer read and run your plan through your open RETIVO tab. How to use
it is in [ai-assistants.md](ai-assistants.md). It is off unless the stack sets
`assistantBridgePort` and the person opts in, and what follows describes the code
as it is today, with the same limits as the rest of this guide. Each claim names
the file that enforces it and, in brackets, the test that checks it. A claim with
no test says so.

**The data-egress statement.** Anything the assistant reads goes to its model
provider, unless it runs a local model. The defaults are generous: everything you
can share is on. Turn off whatever you would rather the assistant not see. The
consent dialog and the Settings card say the same thing
(`apps/web/src/assistant/sharing/sentences.ts`). Once a tool result reaches the
assistant, it is outside RETIVO's control, and this section's protections end
there.

### Trust model

Four parties are involved, and each sees different things:

- **The signed-in tab** holds the plan, the household key and the arithmetic. It
  answers every call and decides what leaves.
- **The bridge** (`apps/mcp-bridge`) is a program on your computer that the
  assistant starts. It holds no plan data and writes none to disk. It sees every
  tool result in passing, because it relays them to the assistant, and keeps none.
  It is one file that the deployed site itself serves (a stack that sets
  `assistantBridgePort` publishes it, with a `bridge.json` naming its SHA-256, at
  deploy time), and the person downloads it once and has the assistant run it. The
  download command the card shows checks the file against that checksum before it
  keeps it, which catches a damaged download and nothing more: both come from the
  same site, so whoever controls the site controls the bridge. Nothing is
  installed from a package registry, and the file embeds its dependencies, so
  nothing else is fetched when the assistant starts it.
- **The assistant** sees every tool result. It runs with your user's permissions.
- **The model provider** sees whatever the assistant puts into the conversation,
  including every tool result.

The RETIVO server is not involved. Nothing about a call passes through it.

### Never shared

No switch releases these. The tab builds each answer field by field from an
allowlist, so a field with no entry is not shared
(`apps/web/src/assistant/sharing/classification.ts`, typed so that an unclassified
payload field fails `pnpm typecheck`). A final pass over every result also removes
the keys listed after the bullets, at any depth (`sharing/scrub.ts` and
`tools/envelope.ts`):

- Email addresses (`email`).
- Last names (`lastName`).
- Your household name: the household record is not exposed at all (`name`,
  `currency` and `createdAt` are classified as never shared).
- Your account record and your sign-in and security history: the tools read only
  the plan's own records through `tools/workspace.ts`.
- Encryption keys and encrypted data: the tools read the decrypted local copy of
  the plan, not the key cache or any ciphertext.
- Device identifiers (`deviceId`).

Removed from every result at any depth: `email`, `lastName`, `householdId`,
`deviceId`, `schemaVersion`, `version`, `updatedAt`, `deletedAt`,
`aggregateType`. A literal occurrence of a member's email or last name, or of the
household name, inside free text is masked, and first names too while the person
chose role labels. [`sharing/classification.test.ts`, `sharing/view.test.ts`,
`tools/sharing.test.ts`, which plants a sentinel in each of last name, email,
household name, device id, household id and key cache and asserts it is absent
under every switch setting.] No test plants a value in the account record or the
sign-in history; that claim rests on what `workspace.ts` reads.

### What the person chooses

At pairing the dialog offers one switch per part of the plan (Household members,
Accounts, Account balances, Income, Expenses, Social Security, Scenarios, Notes and
descriptions), one for exact dollar figures and one for first names. All are on by
default. A part switched off is left out of every answer and named in it. With
**Exact dollar figures** off, annual figures round to the nearest $1,000 and monthly
ones to the nearest $100; with **First names** off, members read Primary and
Secondary. The choices are fixed for the session
(`sharing/switches.ts`, `sharing/consent.ts`). A separate **Let assistant activity
keep me signed in** switch is off by default; see [the idle stance](#the-idle-stance).

### Pairing and the loopback checks

- **The bridge listens on `127.0.0.1` only**, bound explicitly, never a wildcard
  address (`apps/mcp-bridge/src/loopback-server.ts`
  [`loopback-server.test.ts`]).
- **The upgrade is the boundary.** Before anything is sent, the `Origin` and `Host`
  headers are compared as exact strings: `Origin` must be the one address the
  bridge was started for, `Host` must be `127.0.0.1:<port>`. A missing or `null`
  `Origin`, another origin, a duplicated header and a DNS-rebinding hostname are
  refused with a 403 and no greeting. [`loopback-server.test.ts`]
- **One tab, one session.** A second tab is closed at once with a code that says
  why. A tab that never completes the handshake in 10 seconds is closed
  (`loopback-server.ts`, `session.ts` [`loopback-server.test.ts`,
  `session.test.ts`]).
- **The pairing code is minted only when an assistant calls a tool**, is 10
  characters from a 32-symbol alphabet (about 50 bits), lives 5 minutes, allows 3
  wrong tries counted across connections and is single use
  (`apps/mcp-bridge/src/pairing-code-store.ts`, `packages/assistant-protocol/src/constants.ts`
  [`pairing-code-store.test.ts`, `session.test.ts`]).
- **The code never travels.** The tab and the bridge each prove they know it with an
  HMAC bound to both sides' fresh nonces, derived with HKDF, and compare proofs in
  constant time (`packages/assistant-protocol/src/pairing.ts`
  [`pairing.test.ts`, `session.test.ts`]). A program that grabbed the port first
  cannot read the code from the traffic, and the tab only continues once the
  bridge's proof verifies (`apps/web/src/assistant/session.ts`
  [`assistant/session.test.ts`]). The version check runs before any proof.
- **Consent comes after pairing and before any data.** The tab sends `ready` only
  after the person allows, and answers `WORKSPACE_LOCKED` to a call that arrives
  before then (`assistant/dispatcher.ts` [`assistant/session.test.ts`]).
- **Logs hold no plan data and no code.** The bridge logs typed events to its
  standard error; the tab logs state names only
  (`apps/mcp-bridge/src/logger.ts` [`logger.test.ts`, `relay.test.ts`]).

### What crosses the socket, and what never does

Crossing it: the protocol version, fresh nonces and proofs, the bridge's version and
the assistant's self-reported name and version (untrusted, shown only after
cleaning), the single flag saying whether activity keeps you signed in, and for each
call the tool name, its arguments, progress and the result. Results carry only what
the switches allow, wrapped in the envelope (`packages/assistant-protocol/src/frames.ts`).

Never crossing it: the pairing code, the household key, any ciphertext, your email
address, last name, household name, the account record and device identifiers
(above). A frame is capped at 1 MiB and a result a little below that, with at most 2
calls at once and 60 per minute on the bridge; a call that runs too long is cancelled
(`constants.ts`, `relay.ts`, `dispatcher.ts` [`relay.test.ts`,
`session.dispatch.test.ts`]).

### Session state is in memory only

The session, the consent record, the pairing code and the activity log live in the
tab's memory and end with the session. Nothing is written to IndexedDB,
`localStorage` or disk, so "Clear data on this device" has nothing to clear. The
one stored value is the per-device opt-in, a blanket-cleared `localStorage` key
(`assistant/preference.ts`). The tab's diagnostics may hold redacted console lines
naming the session's state, such as the phase it reached, so a diagnostics export
can contain them; the code, nonces, proofs and payloads are not logged. The bridge
keeps nothing between runs. Teardown is on Disconnect, a declined dialog, sign-out
(idle included), locking, a different person signing in and a reload or tab close
[`AssistantContext.test.tsx`, `session.test.ts`].

### The shared-loopback residual

Port 24580 (the default) on your computer is reachable by any program on it, so
the loopback address is shared with every other local user. The `Origin` check
stops a web page; it does not stop a program, which can send any `Origin` it likes.
What stops another local user from pairing is the code: it is minted only when
your assistant calls a tool and is delivered through that assistant's output, never
shown elsewhere, and it takes a proof of the code to pair. Such a user can still
hold the tab's slot for a few seconds or use up a code's three tries; the cost is a
new code, not access. A process that takes the port before the bridge does cannot
prove it knows the code, and the tab stops with a message. A process already
running as you is a different case: it can read the browser's profile directly,
which "Data on the device" above already says is possible, so the connector adds
nothing it could not already do. The connector depends on the browser asking
before a site reaches your computer and on your own machine being clean; both are
outside RETIVO's control.

### The idle stance

By default the assistant's activity is not user activity, and an idle sign-out ends
the session as it always would (`auth/IdleTimer.tsx`). The consent switch **Let
assistant activity keep me signed in**, off by default and chosen per session, makes
each completed tool call count as activity: the tab calls `recordProgrammaticActivity`
for a call whose tool returned data, only while the session is allowed and the
switch is on, and the idle timer treats that like a click, in every tab through the
shared last-activity key. Calls that start, fail, are cancelled, time out or are
refused do not count (`assistant/session.ts`, `dispatcher.ts`
[`AssistantContext.test.tsx`: the switch off, on and a call of every outcome]). The
consequence is plain: with it on, an assistant you walked away from keeps the
session, and every open RETIVO tab in that browser, signed in for as long as it
keeps calling. Signing out, **Disconnect**, closing the tab and locking still end
it. The switch changes only the browser's idle timer, not anything the server
enforces.

### Limits

- The model provider, and everything after a result leaves the tab, are outside
  RETIVO's control; the data-egress statement above is the whole promise.
- The assistant reports its own name; RETIVO cannot verify it.
- Text inside tool results comes from your plan. It is cleaned and marked as data,
  but an assistant may still be swayed by it; that is the assistant's behaviour.
- The connector relies on the browser's local-network prompt and on your own
  computer being free of other malware.
- The tools are read-only; there is no write path. The what-if tool builds its scenario in memory for the length of one call and writes nothing to storage, the sync queue or the Monte Carlo result cache, and the never-shared list is unchanged (`assistant/tools/what-if.ts` [`tools/what-if.test.ts`: the scenario store, its version, the change event, the result cache and the selected scenario are the same after a success and after each kind of failure]).
- Only a browser that asks before a site reaches your computer is supported; Safari
  and browsers on an iPhone or iPad are not.

## Deleting and exporting your data

- **Export my data** (Settings, Workspace, Data). After a password check, the
  browser decrypts your saved data and builds one compressed JSON file. It holds your saved data plus your account record, sign-in and
  security history, and the other records tied to your account. Short-lived
  server and storage access logs are not in it. **The file is not encrypted.**
  Keep it somewhere private. Exporting needs the data to be unlocked.
- **Delete workspace data** (Settings, Workspace, Workspace tools). After a
  password check, it clears the synced data on this device and on the server and
  keeps the account. A checkbox, "Also erase backup history", also removes the
  saved snapshots.
- **Delete account** (Settings, Security). It needs the password (and a second
  factor, when enforced) and offers an export first. It removes the account and
  the data: sessions, snapshots, synced data, key slots, passkeys, the
  authenticator secret, trusted devices, the password hash and the account
  record. It leaves the sign-in and security history (up to a year), backups (up
  to 90 days) and logs to expire on their own.

## Local versus deployed

| | Local run | Deployed stack |
|---|---|---|
| Second factor | Off (`AUTH_MFA_ENFORCED=false`). | Required by default (stack setting `authMfaEnforced`). |
| Email verification link | Shown on screen (`EXPOSE_VERIFICATION_TOKEN`). | Refused: the API will not start with that setting on a deployed stack. |
| Sign-up approval | Shortcuts are shown on screen. | Every sign-up waits for the owner, except one using `approverEmail`. |
| Test account | A ready-made account exists. | None. |
| Cookie names | `dev-rt`, `dev-dt` (no `Secure` flag). | `__Secure-rt`, `__Secure-dt`. |
| AI assistant connector | On when `VITE_ASSISTANT_BRIDGE_PORT` is set; the dev server sends no content security policy. | Only on a stack that sets `assistantBridgePort`, which also adds the one loopback address to the policy. |

The local steps are in [local-setup.md](local-setup.md), and the deployed ones are in
[deploy.md](deploy.md).
