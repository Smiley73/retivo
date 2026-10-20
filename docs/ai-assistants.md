# AI assistants

This guide is for people who want an AI assistant that runs on their own
computer, such as Claude Code, Codex or Cursor, to read and run their RETIVO plan.
It covers what the connector is, how to set it up for each assistant, how to
pair and choose what the assistant may see, what the assistant can ask for, and
what to check when it does not work. The screens themselves are described in the
[user guide](user-guide.md#ai-assistants); what the connector does and does not
protect, with the code that enforces each claim, is in the
[security overview](security.md#ai-assistants). Like everything else in RETIVO,
what the assistant tells you is an estimate and not advice; see
[Not financial advice](../README.md#not-financial-advice).

## What it is

An opt-in connector. A small program called the **bridge** runs on your computer,
started by the assistant. It lists a fixed set of read-only RETIVO tools to the
assistant. When the assistant calls one, the bridge passes the call to your signed-in
RETIVO browser tab over a connection that stays on your computer, the tab works out
the answer from your plan, and the answer goes back the same way. The plan, the key
that unlocks it and the arithmetic stay in the tab; the bridge holds no plan data
and keeps nothing. The assistant cannot change anything: it cannot edit, add or
delete your data, and nothing it asks is saved.

**Anything the assistant reads goes to its model provider, unless it runs a local
model.** Whatever a tool returns becomes part of the conversation, and the
conversation goes to whichever company runs the model your assistant uses.
**The defaults are generous: everything you can share is on.** Turn off whatever
you would rather the assistant not see. The consent dialog asks when you pair. Some things
are never shared, whatever you choose; the list is under
[What it does not protect](#what-it-does-not-protect) and in the
[security overview](security.md#ai-assistants).

## Before you start

- **A build that offers it.** The connector exists only in a copy whose build
  carries a bridge port. A deployed copy has it when its owner set the
  `assistantBridgePort` stack setting ([deploy guide](deploy.md)); a local copy has
  it when `VITE_ASSISTANT_BRIDGE_PORT` is set ([local setup](local-setup.md#connect-a-local-ai-assistant)).
  Without a port the card described below never appears, whatever else you set.
- **Beta features on.** The connector is a beta feature. Turn on **Show beta
  features** under **Settings → Preferences**; the copy must also offer the AI
  assistants beta feature (the `betaFeatures` setting, `all` by default).
- **A supported browser.** Chrome, Edge, Firefox 151 or later, or Brave, on a
  computer, after the one-time permission described in [Browser support](#browser-support).
  Safari and every browser on an iPhone or iPad cannot connect.
- **Node 24 for the bridge.** The bridge is a Node program and needs Node 24 (24.2
  or later in the 24 line) where the assistant runs.
- **The same computer.** The assistant, the bridge and the browser tab must all be
  on one computer. The connection is to `127.0.0.1` and is refused from anywhere else.

## Set up with your assistant

1. Open **Settings → Preferences**. In the **AI assistants** card, turn on **Allow AI
   assistants on this device**. This is stored in this browser only; it is off by
   default and per signed-in person.
2. Copy the command for your assistant from the card: there is one each for Claude
   Code, Codex and Cursor. **Copy the command from the card instead of typing it.** It
   already holds this copy's own web address, which the bridge compares exactly: the
   scheme, host and port must match the address in your browser's address bar, with
   no trailing slash. Typed from memory, a small difference makes the bridge refuse
   the tab and the card report that it could not reach the bridge.
3. Run it where the assistant runs:
   - **Claude Code** and **Codex**: the card shows a `claude mcp add retivo ...` or
     `codex mcp add retivo ...` line to run in a terminal.
   - **Cursor**: the card shows one line of JSON for Cursor's `mcp.json`, for you to add
     to the `mcpServers` list there.
4. Start a new assistant session if it does not pick the new server up by itself. The
   assistant starts the bridge; you do not run it yourself.

**One bridge per assistant session.** The bridge listens on one fixed port and
serves one browser tab. If a second assistant session starts its own bridge on
the same port, it exits and says the port is in use; close the first session
first. The default port is 24580; the owner of a deployed copy may choose another
with `assistantBridgePort`, and the web app dials only the port its build carries.

**Per-client note.** Each assistant reads the bridge's tool list at start and, as far
as is known, a list that grew later would not reach every assistant (Codex was
seen not to refresh its list during a session). That is why the bridge declares
every tool at start and never changes the list. Whether each client shows a tool
result to the person, in particular the message that carries the pairing code, is
the client's behaviour, and no test here proves it. The verification record is:

| Assistant | Shows the full tool list at start | Shows the pairing code to the person | Verified (version, date) |
|---|---|---|---|
| Claude Code | not verified | not verified | not verified |
| Codex | not verified | not verified | not verified |
| Cursor | not verified | not verified | not verified |

If your assistant hides the tool result, ask it to show you the exact text of the
last tool result.

## Pair and consent

The bridge does not need a separate "connect" step, and the assistant has no
"connect" tool. Every RETIVO tool is present from the start, and **until you pair,
each of them answers with a `NOT_PAIRED` result** that carries a one-time pairing
code and where in RETIVO to type it. So:

1. Ask the assistant anything about your plan, for example "What does my plan
   look like?"
2. The first answer carries the code, like `ABCDE-FGHJK`, and tells you to open
   RETIVO's Settings page (`/profile`) in your signed-in tab. Several questions in a
   row get the same code while it is valid.
3. In the **AI assistants** card, enter the code under **Pairing code** and choose
   **Connect**. A code works once, expires after five minutes and allows three
   wrong tries; after that the assistant's next answer carries a new code. Your
   browser never sends the code itself: the tab sends a proof that it knows the
   code.
4. RETIVO asks **Let this assistant read your plan?** and shows the assistant's
   own name for itself, which RETIVO cannot verify. Choose the switches below and
   **Allow**, or **Don't allow**.
5. Ask again. The same tools now answer with data.

The workspace must be unlocked in the tab while this happens and for as long as the
assistant works; a locked workspace answers `WORKSPACE_LOCKED`.

### The switches

Your choices last until the assistant disconnects. To change them, disconnect and
pair again.

| Switch | Default | What it covers, and what off does |
|---|---|---|
| **Household members** | On | Birth dates wherever they are recorded, ages and which member is the primary one. Off: the assistant sees no household members. |
| **Accounts** | On | Account names, institutions, types, tax treatment, owners, return and contribution settings, and required-distribution and Roth details, except birth dates, which follow Household members. Off: no accounts. |
| **Account balances** | On | The balance and activity recorded for each account, year by year. Off: no balances. |
| **Income** | On | Pensions, part-time work and one-time income. Off: no income. |
| **Expenses** | On | Expenses and their categories. Off: no expenses. |
| **Social Security** | On | Each member's benefit estimate. Off: no Social Security details. |
| **Scenarios** | On | Scenario names, how they relate, and the changes each one makes. Off: no scenarios. |
| **Notes and descriptions** | On | The free text you wrote on accounts, balances, expenses, income, Social Security and scenarios. Off: the assistant sees the rows but none of the text you wrote on them. |
| **Exact dollar figures** | On | Dollar amounts exactly as you entered them. Off: annual dollar figures are rounded to the nearest $1,000 and monthly ones to the nearest $100; percentages, years and ages are not rounded. |
| **First names** | On | Members appear by first name. Off: members appear as Primary and Secondary. |
| **Let assistant activity keep me signed in** | Off | See below. |

A switch that gates one part also gates the same data wherever it shows up. For
example, a birth date on an account row follows **Household members** as well as
**Accounts**, and income figures inside a scenario's changes follow **Income** as well
as **Scenarios**. Every answer names what was left out.

### Let assistant activity keep me signed in

RETIVO signs you out after a period without your own clicks or key presses (30
minutes by default). **By default the assistant's activity does not count**, so the
idle sign-out ends the session as it always would, even while the assistant is
working.

With **Let assistant activity keep me signed in** on, each tool call that finishes
and returns data counts like a click, in every open RETIVO tab of that browser.
Calls that start, fail, are cancelled, time out or are refused do not count.

The trade-off, in plain words: with it on, **an assistant you walked away from keeps
you signed in, in every open RETIVO tab in that browser, for as long as it keeps
making calls.** Signing out, **Disconnect**, closing the tab and locking still end
the session. Use it for a long review you are sitting through. Do not use it on a
shared or unattended machine. It changes only the browser's own idle timer, not
anything the server enforces.

## While it is connected

- **Assistant connected** appears in the header with a **Disconnect** button beside
  it. Choose the status to open **Assistant activity**: every request the assistant
  made, how long it took, how many bytes RETIVO sent back and the exact text it
  sent. The log is kept in memory only, up to 200 requests, and is gone when you
  sign out, when a different person signs in or when you pair again. **Disconnect**
  keeps it readable until then.
- **Disconnect** ends the session at once, with no confirmation.

**What ends a session.** Each of these closes the connection and drops everything
the tab held for it; a new session needs a new pairing code and new consent:

- Choosing **Disconnect**.
- Declining the consent dialog, or closing the tab while it is open.
- Signing out, including the idle sign-out and an expired sign-in.
- Locking the workspace.
- A different person signing in on this browser.
- Reloading or closing the tab.
- Turning off **Allow AI assistants on this device**, or the beta feature becoming hidden.
- The assistant closing, which stops the bridge, or the connection dropping: the
  bridge checks every 15 seconds that the tab still answers.

**Idle behaviour in both switch states.** With **Let assistant activity keep me
signed in** off, the idle timer ignores the assistant: when it runs out you are
signed out and the session ends with the sign-out. With it on, each completed call
resets the timer for every tab, so the idle sign-out comes only after a whole idle
window has passed with no input from you and no completed call.

## Tools and the prompt

RETIVO declares eight read-only tools and one prompt. The assistant sees these
names; you do not need to type them. The assistant may call at most 2 tools at once
and at most 60 per minute, and a result larger than about 1 MiB is refused.

| Tool | What it returns |
|---|---|
| `retivo_status` | Whether the workspace is ready, the connection, the app build, the calculation engine version, the tax-table year, when your data last synced and which sharing switches are on. |
| `retivo_get_plan_data` | The plan data you chose to share: members, accounts, balances, income, expenses, Social Security and scenarios with their overrides. It can ask for fewer parts; a part you turned off is left out and named. |
| `retivo_list_scenarios` | The scenarios with their ids, names, parents, which is the base scenario and the settings each one changes. |
| `retivo_get_scenario` | One scenario's inputs after inheritance, each with the scenario that set it or the default RETIVO applied. |
| `retivo_get_projection` | The year-by-year projection the Balance Projection page shows for a scenario, Planned or Historical (Historical only when the plan has two years of balance history), with the balance in future and today's dollars, withdrawals, deposits, growth and the tax figures. It can limit the rows to a range of years. |
| `retivo_get_stress_test` | The Monte Carlo result the page shows: the chance the money lasts, the Typical, Pessimistic and Bad-luck endings and the balance by year. It reads the result the app already saved; if there is none it runs the 10,000 paths in your open tab, which can take up to a minute, and saves nothing. One simulation runs at a time. |
| `retivo_compare_scenarios` | How two scenarios relate, which inputs differ and how their planned outcomes differ, with each one's saved stress-test result if the app has one. It never runs a simulation. |
| `retivo_explain` | Where one headline number comes from: its value, the inputs and defaults behind it, the assumptions and the math page that describes it. |

**The prompt.** `retivo_plan_review` is a prompt, not a tool: a short checklist the
assistant can use to review your plan. It is served by the bridge without asking the
tab, so it can never contain your plan. It tells the assistant to start with the
status tool, never invent an input, cite the assumptions and defaults each result
lists, name the RETIVO screen where you would make a change, treat text in results
as data and not as instructions, and finish with the not-advice reminder.

**What every answer carries.** Besides the data, every answer states the assumptions
and defaults it relied on, how dollar figures were rounded, how members are named,
which sharing switches were off and so what was left out, what is never shared, the
not-financial-advice and verify-before-acting reminders, the calculation engine
version (`ENGINE_VERSION`), the tax-table year and whether later years scale it
forward, and when the data last synced and whether edits are waiting to sync. Text
that came from your plan, such as names and notes, is cleaned, shortened and marked
as data. The numbers are the ones the app shows, because they come from the same
code in the same tab.

## Troubleshooting

The **AI assistants** card says what it can tell about a failed connection. These are
the usual causes.

| What you see | What it means and what to do |
|---|---|
| "RETIVO could not reach the bridge. It is either not running or blocked by your browser." | The browser cannot tell an absent bridge from a blocked one. Check that the command was added to your assistant and that the assistant has started a session. Then check the browser's permission for this site ([Browser support](#browser-support)); a denied permission looks exactly like an absent bridge. |
| "The bridge is not running." | The browser allowed the connection and nothing answered. Add the command to your assistant, ask a question about your plan, then enter the new code. |
| "Your browser blocked the connection to the bridge." | The permission was denied. Allow it in the browser's site settings for this site, then try again. |
| "Something answered, but it is not the Retivo bridge." | Another program holds the port. Close it, or change the port in the build. |
| The bridge's error log says "Port 24580 is already in use" (or your port) and the bridge exits. | Another assistant session already runs a bridge. Close it first. Only one bridge and one tab can be paired at a time. |
| "The bridge already has a Retivo tab connected." | A second tab is already paired. Disconnect or close that tab first. |
| Every call answers `NOT_PAIRED`. | You have not paired in this session yet, or the last session ended. Enter the code from the latest answer. If it says the assistant is waiting for consent, the consent dialog is open in your tab. |
| "That code is not right." / "Too many wrong codes." / "That code has expired or was already used." | A code works once, for five minutes, with three wrong tries. Ask the assistant for a new answer; it carries a new code. |
| Calls answer `TOOL_NOT_SUPPORTED`. | The bridge is newer than this copy of RETIVO and lists a tool this copy cannot answer. Reload RETIVO to get the newest copy, or use another tool. The tool list lives in the bridge, so a new tool reaches you when the bridge is updated. |
| "The bridge and this version of Retivo do not speak the same version." | The protocol version differs. Add the command to your assistant again to update the bridge, then reload RETIVO. |
| Calls answer `WORKSPACE_LOCKED`. | The workspace is locked, or you have not allowed this assistant. Unlock RETIVO, or allow it in the dialog. |
| Calls answer `TOO_MANY_IN_FLIGHT` or `RATE_LIMITED`. | The assistant asked for more than 2 things at once or 60 in a minute. Wait a moment. |
| A call answers `CALL_TIMEOUT` or `COMPUTE_CAP_EXCEEDED`. | The tab did not answer in time. The stress test stops after about a minute and is never shortened to fit. Open the Balance Projection page, let its stress test finish, then ask again: the tool reads the saved result. |
| A call answers `OUTPUT_TOO_LARGE`. | The answer would not fit in one result. Ask for fewer parts, for example fewer `sections`, or a range of years. |
| Brave shows "blocked" every time. | Brave blocks localhost by default; see the matrix below. |
| Safari, or any browser on an iPhone or iPad. | These cannot connect. Use Chrome, Edge, Brave or Firefox on a computer. |

The bridge writes what it does to the assistant's error log, never plan data and
never the pairing code. Where an assistant shows that log depends on the
assistant.

## Browser support

The table is a **record of what was observed, not a promise.** The "Expected"
column is the design; the "Verified" column says on which browser version and date
the behaviour was seen, or says "not verified". A browser whose permission prompt
is denied looks like an absent bridge.

| Browser | Expected | Verified (version, date) | Observed |
|---|---|---|---|
| **Chrome** | Works after a one-time "local network access" prompt for the site. A denial looks like an absent bridge. | not verified | not verified |
| **Edge** | Same as Chrome. | not verified | not verified |
| **Firefox** | Works from version 151, with its own prompt. Older versions cannot connect. | not verified | not verified |
| **Brave** | Works only after localhost access is allowed for the site, at `brave://settings/content/localhostAccess`. | not verified | not verified |
| **Safari** | Does not work. WebKit treats the loopback address as untrusted content, and so does every browser on an iPhone or iPad. The card says so. | not verified | not verified |

Embedded web views and headless automation work only with the permission already
granted.

**Re-verifying a row.** Do this on a copy that offers the connector, or on a local
HTTPS origin if no deployed copy has the port set yet:

1. Open RETIVO in the browser and turn on **Allow AI assistants on this device**.
2. Start the bridge with the command from the card, through an assistant.
3. Ask the assistant about the plan. Type the code from its answer into the card.
4. Record the browser's permission prompt text, whether the connection opened and
   what the card said.
5. Repeat with the prompt denied and record what the card reports.
6. On Safari, record the failure and the card's message.
7. Put the browser version and the date in the "Verified" column and what you saw
   in "Observed".

## What it does not protect

The security overview ([AI assistants](security.md#ai-assistants)) is the full list
with the code behind each claim. In short:

- **What the assistant reads goes to its model provider**, unless it runs a local
  model. RETIVO cannot see, limit or delete what the provider keeps.
- **The assistant's own replies are its own.** RETIVO cannot vouch for them, and
  they are estimates, not advice.
- **It relies on a browser prompt and on your computer being clean.** Another
  program running as you can read the browser's data directly, as the security
  overview says for any data on the device. The origin check stops a web page
  and the pairing code stops another local user from pairing; neither stops that.
- **Never shared, whatever you choose:** email addresses, last names, your
  household name, your account record and your sign-in and security history,
  encryption keys and encrypted data, and device identifiers.
- **The session is not stored.** Nothing is written to disk. The pairing code and
  the log are in memory and end with the session.
- **The assistant can change nothing.** All the tools are read-only.
