# Deploy to your own Amazon account

This guide takes you from a cloned copy of RETIVO to a running deployment in
your own Amazon Web Services account, signed in. It uses the cheapest setup and
needs no custom domain. After that come the optional extras (each one costs
extra and is off by default), the limits of running without a domain, how to
update a deployment, and how to tear one down.

You run the deployment, you pay Amazon for it, and you look after it.

## Words used in this guide

- **Pulumi** is the tool that reads the infrastructure code in `infrastructure/`
  and creates, changes or deletes the matching Amazon resources.
- A **stack** is one deployment of that code with its own settings. This repo
  ships settings for two stacks, `dev` and `prod`. Which one you pick matters
  ([Choosing a stack](#choosing-a-stack)).
- **CloudFront** is Amazon's content delivery service. It is the front door: the
  address you open in the browser is a CloudFront address.
- **SES** (Simple Email Service) is how the app sends email: sign-up
  confirmations, approval notices and sign-in codes. New Amazon accounts start
  in the **SES sandbox**, a default mode that delivers only to addresses you
  have verified with Amazon.
- **SSM Parameter Store** is Amazon's place for small settings and secrets. The
  deployment keeps the app's signing keys and a few other values there, and the
  setup script keeps each stack's Pulumi passphrase there.
- **Second factor** is the extra proof asked for after your password: an emailed
  code, an authenticator app, or a passkey.

## What you need

- An Amazon account you own, and the AWS command line tool configured for it
  ([install](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
  [configure](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-configure.html)).
  The deployment creates many kinds of resources, including permission roles, so
  use credentials with administrator-level access. If your account requires
  every new role to carry a permissions boundary, set
  `iamPermissionsBoundaryArn` ([Other settings](#other-settings)).
- The Pulumi command line tool
  ([install](https://www.pulumi.com/docs/iac/download-install/)). The repo does
  not pin a version of it.
- Node.js, pnpm and Git, at the versions listed in the
  [prerequisites of the local setup guide](local-setup.md#prerequisites), plus
  `openssl` and `jq`. You do not need Docker for a deployment.
- A sender email address you control and can open the inbox of, and an inbox for
  the person who approves new accounts (yours). They may be the same address.
- One Amazon region for every stack in the account. The examples use
  `us-east-1`. The setup script puts its state bucket, the passphrase and the
  mail identities in the region named by `aws:region` in the stack file.

## What it costs, in outline

Even the cheapest deployment is not free. It runs on these Amazon services, and
each is billed by Amazon under its own pricing page:

| Service | What it does here | Pricing |
|---|---|---|
| Lambda | Runs the API and the background jobs | [Lambda pricing](https://aws.amazon.com/lambda/pricing/) |
| API Gateway | Receives API requests | [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/) |
| DynamoDB | The database | [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/) |
| S3 | The web app files and saved workspace snapshots | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| CloudFront, including CloudFront Functions | Serves the web app and fronts the API | [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) |
| SES | Sends the app's email | [SES pricing](https://aws.amazon.com/ses/pricing/) |
| SSM Parameter Store | Keys and settings | [Systems Manager pricing](https://aws.amazon.com/systems-manager/pricing/) |
| CloudWatch (logs and metrics) | Logs from Lambda and API Gateway, and the numbers the app publishes | [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) |
| EventBridge | The schedules for the background jobs | [EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/) |

The Pulumi state bucket the setup script creates is also an S3 bucket. Every
optional extra below adds services to this list and names them.

## Choosing a stack

The stack name changes behaviour. The scripts and the config check treat the name
`prod` specially:

| What | Behaviour |
|---|---|
| Updating | `deploy-stack.sh` accepts only `dev` or `prod`. The first-time script `bootstrap-stack.sh` accepts any name, but a stack with another name cannot be updated with the script. |
| `enableBackups` | Refused on any stack not named `prod`. |
| `logRetentionDays` | Must be at least 90 on `prod`. |
| Alarms | The API latency alarm, the daily-cleanup-job heartbeat alarm and the whole capacity alarm group exist only on `prod`. |
| Background job schedule | The compactor (the job that merges synced changes into snapshots) runs hourly on `prod` and every 6 hours on any other stack. |
| `edgeAllowedIps` | Refused on `prod`. |

These are gaps in the tooling, written down as they are. The cheapest path is the
`dev` stack, built from `infrastructure/Pulumi.dev.yaml.example`. If you want
backups or the full set of alarms, use the `prod` stack and
`infrastructure/Pulumi.prod.yaml.example` instead. That example turns every extra
on, so copy it and switch off the ones you do not want before the first run. Its
`manageCloudTrail` choice in particular cannot be changed afterwards
([audit trail](#audit-trail-managecloudtrail)).

## The cheapest deployment, from start to first sign-in

The steps below use the `dev` stack. Run every command from the repo root unless
a step says otherwise.

1. **Clone and install.** Clone the repo and run `pnpm install` as described in
   the [local setup guide](local-setup.md#set-up). You can stop before the
   `.env` file: a deployment does not use it.

2. **Create your stack file.**

   ```bash
   cp infrastructure/Pulumi.dev.yaml.example infrastructure/Pulumi.dev.yaml
   ```

   Edit the new file directly. `pulumi config set` cannot work yet, because the
   stack does not exist until the next step. The file is ignored by Git.

3. **Set the sender and approver addresses.** In `infrastructure/Pulumi.dev.yaml`
   change these two keys and leave everything else as shipped:

   ```yaml
   retivo:sesFromAddress: "you@example.com"
   retivo:approverEmail: "you@example.com"
   ```

   - `sesFromAddress` is the address the app sends mail from. It ships as the
     placeholder `no-reply@example.invalid`, and the setup script stops on the
     placeholder. Do not get past that with `--allow-placeholder-ses`: with the
     placeholder no mail is sent at all, and a deployed stack has no shortcut
     that hands a verification link to the browser, so nobody could verify an
     email address or sign in.
   - `approverEmail` is required once the sender is a real address (without it
     the config fails to load). A sign-up from exactly this address is approved
     automatically as the owner. Every other sign-up waits for an approval email
     that goes to this address.

   To use a region other than `us-east-1`, change `aws:region` too, and use that
   region in the commands below.

   Leave `retivo:domainName` and `retivo:apiDomainName` empty. The stack is then
   reached at its default Amazon addresses. Leave the paid switches at `"false"`
   and `retivo:alarmNotificationEmail` blank: nothing alerts with every switch
   off, so the blank address is fine.

4. **Clear leftovers, if any.** If this checkout ever pointed at a different
   Amazon account, delete the file `infrastructure/.deploy.env` first. It holds
   the Pulumi state bucket name for the old account. If a stack file was kept
   from a stack that has since been wiped, delete its `encryptionsalt:` line, or
   the setup script refuses to continue.

5. **Run the first-time setup script.**

   ```bash
   ./infrastructure/scripts/bootstrap-stack.sh dev
   ```

   It needs `pulumi`, `aws`, `pnpm`, `openssl` and `jq` on your path. On the
   first run it:

   - creates a locked-down S3 bucket for Pulumi's state, named
     `retivo-pulumi-state-<account id>`, and records its address in
     `infrastructure/.deploy.env`;
   - generates a passphrase, stores it in SSM Parameter Store as a secure string
     named `/retivo-pulumi/dev/passphrase`, and creates the stack. Pulumi uses
     the passphrase to encrypt the secrets in the stack's state;
   - builds the API and the web app, then deploys everything with `pulumi up`
     (you are asked to confirm; pass `--yes` to skip that);
   - replaces the placeholder signing keys and secrets in SSM Parameter Store
     with real random ones;
   - starts the sender verification described in the next step;
   - sets `retivo:webOrigin` to the CloudFront address and deploys a second time
     so the API knows its own web address, then uploads the web app and clears
     CloudFront's cache.

   Expect it to take several minutes. At the end it offers to run smoke tests
   (three quick checks of the home page, the API health address and the build
   marker). Say yes. If a check fails while CloudFront is still spreading the new
   site, wait a few minutes and run the `curl` lines the script prints.
   The last lines name the **SPA URL**: that is your web address, ending in
   `.cloudfront.net`. Keep it.

   If config loading fails, the error names the key to fix. The script is safe to
   run again after a failure.

6. **Verify the sender address.** Bootstrap asks Amazon to verify the sender, and
   Amazon emails a verification link to that inbox. Open the email (check spam)
   and click the link. Check that it took:

   ```bash
   aws sesv2 get-email-identity --email-identity you@example.com \
     --region us-east-1 --query VerifiedForSendingStatus --output text
   ```

   `True` means Amazon will send from it. (If the sender's domain has a hosted
   zone in the same account's Route 53, bootstrap verifies the whole domain
   instead by adding verification records to the zone, and there is no email to
   click. Verification usually completes within minutes. Check it by running the
   same command with the domain, such as `example.com`, in place of the address.)

7. **Verify every inbox that must receive mail.** Because a new account is in the
   SES sandbox, Amazon delivers only to verified addresses. That includes the
   approver's inbox, and the inbox of every person who will sign up. Without it,
   their verification, approval and sign-in-code emails never arrive. For each
   address that is not already verified (the sender counts as verified), run:

   ```bash
   aws sesv2 create-email-identity --email-identity person@example.com \
     --region us-east-1
   ```

   The person clicks the link Amazon emails them. The way out of the sandbox is
   to request production access in the SES console
   ([Amazon's instructions](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)).
   Amazon decides each request; this guide cannot say whether or how fast it will
   be approved. Until then, repeat this step for each new person.

8. **Sign up as the owner.** Open the SPA URL and choose **Sign up** (or go to
   `/signup`). Fill in your name, date of birth, the approver email address and a
   password, tick **I understand this is not financial advice**, and choose
   **Create account**. Amazon sends a "Verify your email" message from your
   sender address; click its link. Because this is the approver address, the
   account is approved already.

9. **Sign in and meet the second factor.** `authMfaEnforced` defaults to on for a
   deployed stack (the [security overview](security.md#the-second-factor)
   explains the second factor). After your password, a new browser reaches **Two-factor
   authentication**. A new account has no authenticator app or passkey yet, so
   the only choice is **Email code**:

   1. Choose **Send code by email**. A message titled "Your sign-in code" arrives
      from the sender address.
   2. Type the 6-digit code into **Verification code** and continue. Tick **Trust
      this device for 30 days** first if you do not want to be asked again in
      this browser. Codes and the sign-in step expire after a few minutes. If
      yours does, go back and sign in again.

   Add an authenticator app or a passkey afterwards under **Settings → Security**
   if you prefer.

10. **Set up encryption and save the recovery key.** Your data is encrypted in the
    browser before it leaves your device. On **Set up encryption**, type the same
    password and choose **Set up encryption**. **Save your recovery key** then
    shows the only way back into your encrypted data if you forget the password
    (see [Encryption](security.md#encryption)).
    Copy it somewhere safe, tick **I have saved my recovery key**, and choose
    **Continue**. The
    [local setup guide](local-setup.md#sign-in-for-the-first-time) walks through
    the same screens through to the app's first page, and the
    [user guide](user-guide.md) explains the app from there.

You now have a working deployment. To let another person in, they sign up at the
same address, click the verification link in their email, and wait for you:
you get an email titled "Approve new account" with **Approve** and **Decline**
links, valid for seven days. Once you approve, they get an email with a sign-in
link. All of this needs their inbox to be verified with Amazon first (step 7).

### Running Pulumi commands yourself

The scripts log in to the state bucket and fetch the passphrase on their own. For
your own `pulumi` commands (config changes, outputs, preview, teardown), do the
same in your shell. Replace `us-east-1` with your region and `dev` with your stack:

```bash
cd infrastructure
set -a; source .deploy.env; set +a
pulumi login "$PULUMI_BACKEND_URL"
export PULUMI_CONFIG_PASSPHRASE="$(aws ssm get-parameter \
  --name /retivo-pulumi/dev/passphrase --with-decryption \
  --region us-east-1 --query Parameter.Value --output text)"
pulumi stack output --stack dev
```

### Passphrase facts

- Without a stack's passphrase `pulumi up` cannot read the secrets in its state.
  Bootstrap never replaces a stored passphrase, and it refuses to run on a stack
  that has state but no passphrase.
- To use your own passphrase, `export PULUMI_CONFIG_PASSPHRASE` before
  bootstrapping. It is used exactly as given and nothing is stored in SSM
  Parameter Store, so you must export the same value for every later bootstrap
  and deploy.
- If an exported passphrase is left over from another account or stack, the
  scripts stop and tell you to `unset PULUMI_CONFIG_PASSPHRASE`.

## Optional extras

Each extra below is off in the dev example, costs extra, and is opt-in. To turn
one on, edit its key in `infrastructure/Pulumi.<stack>.yaml` and run
`./infrastructure/scripts/deploy-stack.sh <stack>`
([Updating](#updating)). Each names the Amazon services that drive its cost, with
a link to Amazon's pricing. This guide gives no prices: Amazon's pages are the
source, and they change.

| Extra | Setting | Cost drivers |
|---|---|---|
| [Custom domains](#custom-domains) | `domainName`, `apiDomainName` | Route 53 |
| [Firewall](#firewall-and-the-dev-edge-ip-gate) | `enableWaf` | AWS WAF |
| [Edge IP gate](#firewall-and-the-dev-edge-ip-gate) | `edgeAllowedIps` | CloudFront Functions |
| [Audit trail](#audit-trail-managecloudtrail) | `manageCloudTrail` | CloudTrail, S3 |
| [Backups](#backups-enablebackups) | `enableBackups` | AWS Backup, S3, CloudWatch, EventBridge, SNS |
| [Alarms](#alarms) | four `enable...Alarms` switches | CloudWatch alarms, SNS |
| [Point-in-time recovery](#point-in-time-recovery-enablepitr) | `enablePitr` | DynamoDB |
| [Longer log retention](#longer-log-retention-logretentiondays) | `logRetentionDays` | CloudWatch Logs |

### Custom domains

Instead of the `.cloudfront.net` address you can serve the app from your own
domain, and put the API on its own name too.

- `retivo:domainName` is the web address, for example `retivo.example.com`.
- `retivo:apiDomainName` is a separate regional API address, for example
  `api.retivo.example.com`. When set, CloudFront's `/api/*` traffic goes to it.
  You can set it without setting `domainName`.
- The last two labels of each name (`example.com`) must be a **public hosted
  zone** that already exists in your Amazon account's Route 53, with the domain
  delegated to it. The stack looks the zone up and does not create it. It adds
  the certificates and the DNS records itself.
- Set these before the first bootstrap if you can. Passkeys and browser-stored
  data are tied to the web address and do not carry over if you add a domain
  later. If you add `domainName` to an already-bootstrapped stack, also change
  `retivo:webOrigin` to `https://<your domain>`: bootstrap keeps an existing
  value, and the deploy script never changes it.

Cost drivers: **Route 53**, meaning the hosted zone and DNS queries, plus domain
registration if you buy the domain through Amazon
([Route 53 pricing](https://aws.amazon.com/route53/pricing/)).

**Locking the default API address (two steps).** With a custom API domain the
original `*.execute-api.*` address keeps working until you turn it off, so you
can fall back if the new domain misbehaves. `disableExecuteApiEndpoint` is
honoured only when `apiDomainName` is set.

1. Keep `retivo:disableExecuteApiEndpoint: "false"` and deploy. This creates the
   custom domain and repoints CloudFront at it.
2. Check the API works through the web address: `curl -fsS https://<web
   address>/api/v1/health` should print `{"status":"ok"}`.
3. Turn the default address off, by either route:
   - set `retivo:disableExecuteApiEndpoint: "true"` and deploy; or
   - run `./infrastructure/scripts/bootstrap-stack.sh dev --smoke --lock-execute-api`.
     `--yes` alone never locks it; the flag is required for an unattended run.
     This runs the first-time script again, which has no schema check, so use it
     only from a checkout you trust.

   To roll back, set the key back to `"false"` and deploy.

### Firewall and the dev edge IP gate

`retivo:enableWaf` adds an **AWS WAF** web ACL in front of CloudFront: Amazon's
managed common rule set plus a per-address rate limit that blocks heavy senders.
The dev example leaves it off. A stack with neither the firewall nor the gate
below prints a warning on every preview. That warning is expected with the dev
example's defaults. Cost drivers: **AWS WAF** (the web ACL, its rules and the
requests it inspects)
([AWS WAF pricing](https://aws.amazon.com/waf/pricing/)).

`retivo:edgeAllowedIps` is the cheaper way to restrict who can reach a **dev**
stack: a comma-separated list of IPv4 addresses or blocks, for example
`"203.0.113.7/32"`. Anyone outside the list gets a plain `403` from CloudFront
before the web app files, the API or any database is touched. `prod` refuses
this key. Cost driver: **CloudFront Functions** invocations
([CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/)).

- Find your address with `curl -4 https://checkip.amazonaws.com`, then set the key
  and deploy.
- Turning it on also turns IPv6 off for the distribution, because the list holds
  IPv4 only. The check uses the address CloudFront sees, so a VPN or relay service
  changes the result.
- Entries are plain IPv4 with no leading zeros, and `/0` is rejected.
- The list is baked into the deployed function, so it is visible in your stack
  file, in the Pulumi state, and to anyone who may read the function. Put nothing
  in it but your own address.
- If your address changes you are locked out of the app, but not out of
  deploying: set the new address and deploy. Setting the key to `""` removes the
  gate again.

### Audit trail (`manageCloudTrail`)

Turns on an account-wide **CloudTrail** trail that records management activity
(for example who changed which resource) in a log bucket that the stack owns. The
bucket is locked: its objects cannot be deleted for 90 days without special
permission. Cost drivers: **CloudTrail**, because only the first copy of
management events per region is free, so two stacks in one account that both own a
trail pay for a second one, and **S3** for the stored log files
([CloudTrail pricing](https://aws.amazon.com/cloudtrail/pricing/),
[S3 pricing](https://aws.amazon.com/s3/pricing/)).

Decide this when the stack is created. Once the trail exists, setting the key
back to `false` and deploying fails, because Pulumi tries to delete the locked
bucket. There is no clean way back short of editing the Pulumi state by hand. To
be rid of the trail, tear the whole stack down ([Tearing down](#tearing-down)).

### Backups (`enableBackups`)

Takes a daily **AWS Backup** copy of every DynamoDB table and the snapshots
bucket into a locked vault, kept 90 days. It also turns on versioning for the
snapshots bucket, and adds an alert for failed backups and an alarm if no backup
ran in a day. It works only on a stack named `prod`, and it makes
`alarmNotificationEmail` required. Cost drivers: **AWS Backup** (stored recovery
points and backup jobs), **S3** (versioning keeps older object versions for 90
days), **CloudWatch** (the no-backup alarm), and **EventBridge** and **SNS** (the
failed-backup alert)
([AWS Backup pricing](https://aws.amazon.com/backup/pricing/),
[S3 pricing](https://aws.amazon.com/s3/pricing/),
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/),
[EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/),
[SNS pricing](https://aws.amazon.com/sns/pricing/)).

Turning it off again is not a clean undo:

- The vault and its lock configuration are kept when Pulumi lets go of them. They
  are not deleted. Recovery points already in the vault keep billing until their
  90 days end. The lock is in governance mode, so only an administrator with the
  right Backup permissions can delete one earlier.
- S3 versioning, once on, can only be suspended, never switched off. A stack that
  once had backups on keeps a versioned snapshots bucket.

[Tearing down](#tearing-down) covers how to clear both.

### Alarms

Four switches each turn on one group of CloudWatch alarms. Alarms send email
through an Amazon notification topic in SNS (Simple Notification Service). Cost drivers for every group:
**CloudWatch alarms**, which are billed per alarm, and **SNS** email notifications
([CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/),
[SNS pricing](https://aws.amazon.com/sns/pricing/)).

| Switch | Watches | Only on `prod` |
|---|---|---|
| `enableSecurityAlarms` | A burst of failed password sign-ins, a burst of failed second-factor attempts, and any reuse of a refresh token (a sign of theft) | none |
| `enableApiHealthAlarms` | Errors from the API | Slow API responses (p95 latency) |
| `enableBackgroundJobAlarms` | The compactor: failures, coverage, snapshot read errors, runs that hit their limits, and a missing heartbeat | The daily cleanup job's heartbeat |
| `enableCapacityAlarms` | Account-wide Lambda throttling and concurrency headroom | The whole group: on any other stack the switch deploys no alarms |

Turning on any group, or `enableBackups`, makes `retivo:alarmNotificationEmail`
required, even for the capacity group on a stack that deploys nothing for it.
Config loading fails without it. Amazon then emails that address a subscription
confirmation. **Click the link in that email**: until you do, no alert is
delivered. If every switch and `enableBackups` are later turned off, the topic is
removed, and turning one back on creates a new subscription that needs
confirming again.

### Point-in-time recovery (`enablePitr`)

Turns on **DynamoDB** point-in-time recovery for every table, so a table can be
restored to any moment in the recent past. Cost driver: **DynamoDB** continuous
backup storage, which grows with the size of your tables
([DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)).

### Longer log retention (`logRetentionDays`)

Sets how many days **CloudWatch Logs** keeps the logs of every Lambda and API
Gateway log group. It is a required setting on every stack: the dev example ships
`7`, the prod example `90`, and `prod` refuses anything under 90. Only Amazon's
allowed values work: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545,
731, 1096, 1827, 2192, 2557, 2922, 3288 or 3653. Any other number, such as 45,
fails config loading. Cost driver: **CloudWatch Logs** storage, which grows with
longer retention ([CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)).

## Other settings

These have a default, so a missing key never fails a deploy. Set them in the stack
file, then deploy.

| Key | Default | What it does |
|---|---|---|
| `authMfaEnforced` | `true` | Whether sign-in asks for a [second factor](security.md#when-it-is-required) on a new browser. `"false"` skips it, leaving the password as the only barrier. |
| `betaFeatures` | `all` | Which beta features the web app offers: `all`, `none`, or a comma-separated list of `projected-withdrawals`, `guardrails` and `ai-assistants`. `ai-assistants` (the Settings → Preferences card that connects a local AI assistant) also needs `assistantBridgePort`; without that port the card never renders, whatever this setting says. People still switch them on in their preferences. It is baked in when the web app is built, so it needs a deploy. |
| `assistantBridgePort` | none | Leave it unset unless you run the AI assistant connector. Set it to a whole number from 1024 to 65535 (the connector's default is `24580`) and the deploy does two things from that one value: it bakes the port into the web app when it is built, and it adds exactly one entry, `ws://127.0.0.1:<port>`, to the connection list of the content security policy, so the browser may open a connection to a program on the same computer and nowhere else. Unset adds nothing to the web app or the policy. It costs nothing extra, and it needs a deploy. |
| `apiThrottleRatePerSec`, `apiThrottleBurst` | `20`, `50` | A cap on API requests per second and in a short burst, across all callers. Extra requests get Amazon's own `429` reply without running the API. The dev example ships `5` and `10`. Both must be positive whole numbers. |
| `lambdaConcurrencyQuota` | `10` | Your account's Lambda concurrency limit, used only to set the capacity alarm's threshold (the quota minus 2). A whole number of at least 3. Raise it after Amazon approves a higher limit. |
| `iamPermissionsBoundaryArn` | none | The ARN of a permissions boundary to attach to every role the stack creates, for accounts that require one. |
| `snapshotMinKeep`, `snapshotMinAgeDays` | `10`, `90` | The daily cleanup job always keeps at least this many snapshots per household, and deletes older ones only beyond that. Both must be at least 1. |

## Limits without a domain

The default addresses work, with these limits:

- **The SES sandbox.** Amazon delivers mail only to addresses you have verified
  with it, until you are granted production access (step 7 of the main path).
- **The default API address refuses outside requests.** The `*.execute-api.*`
  address stays reachable, but it turns away any request that did not come
  through CloudFront.
- **Passkeys and browser-stored data follow the web address.** If you add a custom
  domain later, they do not carry over.

One limit applies with or without a domain: CloudFront lets in only viewers in the
United States. People elsewhere cannot open the app. The restriction is set in
`GEO_ALLOWLIST` in `infrastructure/src/cloudfront.ts`, and there is no setting
for it.

## Updating

Use `deploy-stack.sh` for every update after the first bring-up. `bootstrap-stack.sh`
is for first bring-up only, and neither it nor a bare `pulumi up` runs the safety
check below.

```bash
git pull
pnpm install
./infrastructure/scripts/deploy-stack.sh dev
```

- It builds the API and web app, runs `pulumi up --yes`, uploads the web app and
  clears CloudFront's cache without waiting for it to finish. It runs no smoke
  tests; it prints two `curl` lines to try once the cache has caught up.
- It refuses a stack whose first-time setup has not finished (empty
  `retivo:webOrigin`). On `prod` it also refuses the placeholder sender.
- **Schema check.** It refuses to deploy a build whose data-format versions are
  ahead of your local `origin/main`, because data saved by it could become
  unreadable once that branch is gone. The check reads your local copy of the
  branch, so run `git fetch origin main` first, particularly in a fork. If your
  checkout truly carries the next data-format version, override the check for one
  command: `ALLOW_SCHEMA_AHEAD=1 ./infrastructure/scripts/deploy-stack.sh dev`.
  Never put that variable in `.deploy.env`. The script needs a Git clone with an
  `origin/main` branch: in a directory with no `.git`, such as an unpacked
  download, it stops at this check, before it touches Amazon.
- **Changing a setting.** Edit `infrastructure/Pulumi.<stack>.yaml` and run the
  deploy again. To see the plan first, run `pulumi preview --stack <stack>` after
  [logging in](#running-pulumi-commands-yourself).
- **Turning an extra off.** Change its setting to `"false"` and deploy. Mind these
  cases: switching the firewall off leaves the stack open unless an edge IP gate is
  set first; `manageCloudTrail` cannot be turned off this way
  ([audit trail](#audit-trail-managecloudtrail)); backups leave the vault and a
  versioned snapshots bucket behind ([Backups](#backups-enablebackups)); and
  turning an alarm group back on needs the email subscription confirmed again.

## Tearing down

There is no teardown script. `pulumi destroy` alone does not do it, because
several resources are set up to resist deletion. Work through these steps in
order, from `infrastructure/` with
[Pulumi logged in and the passphrase exported](#running-pulumi-commands-yourself).
Replace `dev` with your stack, and `us-east-1` in the commands with your region
(`aws:region` in the stack file). If you only want to stop paying for an extra, turn
it off and deploy instead ([Updating](#updating)).

### 1. Find the buckets and prepare a helper

The stack has four buckets. Three have a stack output; the fourth does not:

```bash
pulumi stack output spaBucket --stack dev
pulumi stack output snapshotsBucket --stack dev
pulumi stack output cloudTrailBucket --stack dev
aws s3 ls | grep retivo-dev-snapshots-access-logs
```

In that order these name the web app files bucket, the saved workspace snapshots
bucket and the audit log bucket (the text `(disabled)` if the trail is off); the last
command finds the snapshots bucket's access-log bucket by name.

The commands in this section use your AWS CLI's default profile and region, so
make sure they match the stack's. The helper below deletes every object version and
delete marker, up to 1000 at a time, passing each batch to the AWS CLI as a temporary file (a batch that size is too long to pass as an inline argument on Linux). Plain `aws s3 rm --recursive` is not enough for a versioned bucket: it only
adds delete markers, so the bucket stays non-empty and the destroy fails with
`BucketNotEmpty`. With `enableBackups` on, the snapshots bucket is versioned. It
stays versioned even after the setting is switched off, because S3 versioning can
only be suspended. The audit-log bucket is always versioned.

```bash
empty_bucket() {
  local bucket="$1" batch tmp
  tmp="$(mktemp)"
  while :; do
    batch="$(aws s3api list-object-versions --bucket "$bucket" --no-paginate --output json \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}')"
    [ "$(jq '.Objects | length' <<<"$batch")" -eq 0 ] && break
    jq -c '{Objects: .Objects}' <<<"$batch" >"$tmp"
    aws s3api delete-objects --bucket "$bucket" --delete "file://$tmp" \
      --output json "${@:2}" | jq -e '(.Errors // []) | length == 0' >/dev/null || { echo "delete failed" >&2; rm -f "$tmp"; return 1; }
  done
  rm -f "$tmp"
}
```

### 2. Empty the buckets

```bash
empty_bucket "$(pulumi stack output spaBucket --stack dev)"
empty_bucket "$(pulumi stack output snapshotsBucket --stack dev)"
empty_bucket <the access-logs bucket name from the grep above>
```

If the stack owns an audit trail, empty its bucket too. Its objects are under a 90
day lock, so the helper must pass the bypass flag, which needs permission to
bypass governance retention (an account administrator normally has it):

```bash
empty_bucket "$(pulumi stack output cloudTrailBucket --stack dev)" --bypass-governance-retention
```

Without that permission the objects can only be deleted once their lock ends, 90
days after they were written.

### 3. Lift the protection on the web app bucket

The web app bucket is deletion-protected. Only that one resource is protected, so:

```bash
pulumi state unprotect --all --stack dev --yes
```

### 4. Destroy the stack

```bash
pulumi destroy --stack dev
```

Know which kind of failure you hit:

- **The protected bucket** fails the destroy while it is still planning, before
  anything is deleted. Nothing is gone, so everything keeps billing. Do step 3.
- **A non-empty bucket or the locked audit-log bucket** fails midway, after other
  resources are already deleted. The trail may have written new logs since you
  emptied its bucket. Empty that bucket again (with the bypass flag for the audit
  log) and run the destroy again. It continues from where it stopped.

When the destroy finishes, remove the stack record and your local file:

```bash
pulumi stack rm dev
rm Pulumi.dev.yaml
```

### 5. Clear what the destroy leaves behind

- **The backup vault, if backups were ever on.** The vault, its lock and any
  recovery points are not deleted by the destroy. Recovery points keep billing
  until their 90 days are up, and the lock keeps anyone but a suitably permitted
  administrator from deleting them sooner. After that, delete anything left and
  then the vault, by hand. Backups work only on a stack named `prod`, so the vault
  is named `retivo-prod-backups`:

  ```bash
  aws backup list-recovery-points-by-backup-vault --backup-vault-name retivo-prod-backups --region us-east-1
  aws backup delete-recovery-point --backup-vault-name retivo-prod-backups --recovery-point-arn <arn> --region us-east-1
  aws backup delete-backup-vault --backup-vault-name retivo-prod-backups --region us-east-1
  ```

  If the lock stops the vault from being deleted, remove it first with
  `aws backup delete-backup-vault-lock-configuration --backup-vault-name
  retivo-prod-backups --region us-east-1`, which also needs administrator
  permission.
- **The Pulumi state bucket and the passphrase.** Both are shared by every stack in
  the account and are created by the setup script, not the stack. Keep them until
  every stack is gone, because you need them to destroy a stack. To remove them,
  empty the state bucket with the helper (it is versioned) and delete it, then
  delete each stack's passphrase:

  ```bash
  empty_bucket retivo-pulumi-state-<account id>
  aws s3api delete-bucket --bucket retivo-pulumi-state-<account id> --region us-east-1
  aws ssm delete-parameter --name /retivo-pulumi/dev/passphrase --region us-east-1
  ```

  Then delete `infrastructure/.deploy.env`, and run `unset PULUMI_BACKEND_URL
  PULUMI_CONFIG_PASSPHRASE` in any shell where you exported them, so a later
  setup does not reuse the old values.
- **The SES identities.** Delete the sender address and every recipient you
  verified: `aws sesv2 delete-email-identity --email-identity you@example.com
  --region us-east-1`. If bootstrap verified a whole domain, also delete the
  three `*._domainkey.<domain>` records it added to your Route 53 zone.
- **Your own Route 53 zone and domain**, if you made them. The stack never owned
  them.

The stack's own SSM parameters under `/retivo/dev/` are created by Pulumi (the
setup script only fills in their values), so the destroy removes them. The
passphrase is the only parameter the script creates itself.
