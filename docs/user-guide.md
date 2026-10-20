# User guide

This guide is for someone who already has a running copy of RETIVO and wants to
know how to use it: how to get in, what each screen is for, what to enter, and
how far to trust what comes out. It is words only. Screen names, buttons and
settings are written the way they appear in the app.

If you do not have a running copy yet, start with the
[local setup guide](local-setup.md). It covers the install and the shortcuts that
only exist on your own machine. To run a copy on Amazon, see the
[deploy guide](deploy.md). This guide does not repeat either.

## What RETIVO does

RETIVO is a retirement planner. You describe your household, your accounts, your
income and your spending, and it projects how your savings could hold up through
retirement. You can then change one assumption at a time (retire later, claim
Social Security earlier, spend less) and compare the results.

**It models United States rules only.** That means federal income tax, Social
Security, and four other things you will see named throughout the app:

- **RMD (required minimum distribution).** The minimum amount the IRS makes you
  withdraw each year from tax-deferred retirement accounts such as a traditional
  IRA (individual retirement account) or 401(k) (an employer plan), once you
  reach a set age.
- **QCD (qualified charitable distribution).** A gift made directly from a
  traditional IRA to a charity at age 70½ or older. It stays out of your taxable
  income and can count toward your RMD.
- **IRMAA.** An extra Medicare premium charged when your income is above certain
  levels.
- **ACA.** The Affordable Care Act. Before Medicare starts at 65, a retired person
  can buy a health plan on the ACA Marketplace and may get a premium subsidy that
  depends on income.

State income tax and rules from other countries are not modeled.

Two things to keep in mind as you read the rest:

- Everything you see is an **estimate built from what you entered**. The app says
  so on the screens where it matters, and [the last section](#what-the-app-is-not)
  says it again.
- The person who runs your copy makes some choices that change what you see, such
  as whether a second sign-in step is required and which beta features are
  offered. Where that applies, the guide says "the person who runs your copy
  decides".

## Getting in

### Sign up

On the sign-in page, choose **Sign up**. The **Create your account** form asks for:

- **First name** and **Last name**
- **Date of birth**
- **Email**
- **Password**, with a tooltip listing the password requirements
- a checkbox, **I understand this is not financial advice**

Then choose **Create account**. Three more steps stand between you and the app:

1. **Verify your email.** A link is sent to your address and is valid for 15
   minutes. If it expires, the app offers to send a new one
   (**Resend verification email**).
2. **Wait for the owner to approve your account.** Anyone other than the copy's
   owner starts out "waiting for approval". Once you have verified your email, the
   owner is emailed an approval link, valid for 7 days. Until they approve, sign-in
   is locked. If they decline, the pending account is deleted. The owner is
   whoever runs your copy; their own sign-up is approved automatically.
3. **Sign in** with your email and password.

If you are running a copy on your own machine, the
[local setup guide](local-setup.md) shows how to skip the email and approval
steps.

### Set up encryption and save your recovery key

Your financial data is encrypted in your browser before it is sent to the server.
The first time you sign in, the app shows **Set up encryption**. Enter the same
password you just signed in with. The app then shows **Save your recovery key**.

**Treat the recovery key as the most important thing on this screen.** The app's
own wording is that it is "the only way back into your encrypted data if you ever
forget your password", and that "forgetting your password alone is enough to need
it". The app cannot recover it for you. If you lose both your password and the
key, and no browser you have used before still holds your key, your encrypted data
is gone for good and no one can read it.

Use **Copy recovery key**, keep it somewhere safe and separate from your password
(a password manager is ideal), tick **I have saved my recovery key**, and choose
**Continue**. How the key and encryption work is in the
[security overview](security.md#encryption).

### Signing in later

On a browser that already holds your key, you just sign in. On a browser that has
never held your key (a new browser, a new computer, or after clearing the site's
data), the app shows **Unlock your data** after you sign in. Enter your password,
or choose **Use recovery key instead** and enter the key.

You can also sign in with **Sign in with a passkey** if you have added one. A
passkey lets you sign in with your device's biometrics or PIN instead of typing
a password (see [Security](#security)). A passkey sign-in does not ask for a
further code.

### The second sign-in step

A deployed copy asks for a second factor after your password by default, unless
the person who runs it turned that off (the
[security overview](security.md#the-second-factor) has the detail). The choices are:

- **Passkey**
- **Authenticator app** (a code from an app such as Google Authenticator or
  1Password)
- **Email code**

You can tick **Trust this device for 30 days** to skip the code on that device.
A copy running on your own machine usually does not ask for a second factor.
Sign-in also ends on its own after 30 minutes of inactivity by default. The person
who runs your copy can change that.

### If you forget your password

Choose **Forgot password?** on the sign-in page, enter your email, and a reset
link is sent that is valid for 15 minutes. The link opens **Set a new password**.

**A new password does not unlock your saved data.** The app warns you of this on
the reset page. Setting a new password lets you sign in again, but you will then
be asked for your **recovery key** (or a passkey on this device) to unlock your
encrypted data. Without one of those, the encrypted data cannot be recovered.

Before you give up, try a browser you used before and signed in on. It may still
hold your key, and if so your data opens there without the recovery key. If you
have no recovery key, no passkey marked **Use for encryption**, and no earlier
browser that still unlocks your data, the one way forward is to start over with
the same account. It permanently deletes the encrypted data and keeps the
account. See [Start over when you cannot unlock your data](#start-over-when-you-cannot-unlock-your-data).

## First run and demo data

When you sign in for the first time after signing up, the app creates your
household's primary member from the name and date of birth on your account
record. The Dashboard then shows a banner, **Your household is set up.**, with
two choices:

- **Load demo data** fills the workspace with a made-up family: accounts,
  balances, Social Security details, expenses, income and a few example
  scenarios. It is a good way to see every screen with realistic
  numbers.
- The **×** button dismisses the banner and keeps just your own member.

On an account that was not created through the sign-up form, such as the
ready-made account on a local copy, you get a **Try the demo dataset?** dialog
with **Load demo data** and **Skip** instead.

**Demo data can be removed, but not selectively.** There is no button that
deletes only the demo records. Instead:

- **Settings → Workspace → Workspace tools → Delete workspace data** clears
  every account, scenario, expense and member, demo data included, and gives you a
  clean, empty workspace. It also clears anything you entered yourself.
- **Load demo data** in the same card, used on a workspace that already has data,
  replaces everything with the demo set after a password check and a second
  confirmation.
- You can also delete demo items one at a time on the screens that hold them.

After **Delete workspace data**, the app does not offer the demo data again, and
does not create your primary member again, on the browser where you deleted it.
That promise is per browser. Go to **Your Data → Household** and add yourself as
the primary member to start fresh. A browser that has never opened the populated
workspace, including one you cleared with **Clear data on this device**, sets the
primary member up once from your account record.

## Finding your way around

The left-hand sidebar is the map. On a narrow screen it opens as a drawer. On a
phone-sized screen the sign-in page shows a **Best on a larger screen** notice,
because the app is laid out for tablets and computers.

At the top of the sidebar are the cloud-sync badge (see
[Syncing](#syncing-and-where-your-data-lives)) and the **Active Scenario** picker.
The scenario you pick there is the one the Dashboard and Projections show.
**Report** and **Roth conversion comparison** have their own **Scenario** picker,
and **Social Security claim-age** compares every scenario. At the bottom are your name and **Sign out**.

| Sidebar item | Group | What it is for |
|---|---|---|
| **Dashboard** | top of the sidebar | A read-only summary of where you stand and where the plan is heading. |
| **Projections** | Planning | The full projection, with charts and tables. |
| **Scenarios** | Planning | "What if?" versions of your plan. |
| **Social Security claim-age** | Planning | Compares claim ages for each scenario. |
| **Roth conversion comparison** | Planning | Compares a Roth conversion: moving money from a traditional (pre-tax) account into a Roth account, paying income tax on it now so that qualified withdrawals later are tax-free. |
| **Projected withdrawals** (Beta) | Planning | A year-by-year view of what the plan would withdraw. Only if turned on. |
| **Report** | Planning | Downloads a PDF. |
| **Guardrails today** (Beta) | Planning | Where your spending stands against your guardrails, which are rules that trim spending after markets fall and allow more after they rise. Only if turned on. |
| **Household** | Your Data | The people in the plan. |
| **Accounts** | Your Data | Each account's type, owner and assumptions. |
| **Account Balances** | Your Data | Yearly balance history for each account. |
| **Annual Contributions** | Your Data | What you plan to put into each account. |
| **Income** | Your Data | Pensions, part-time work and windfalls. |
| **Expenses** | Your Data | What you expect to spend. |
| **Expense Categories** | Your Data | The categories expenses are grouped under. |
| **Social Security** | Your Data | Your benefit amounts. |
| **Preferences** | Settings | Appearance and beta features. |
| **Security** | Settings | Password, passkeys, second factor, recovery key, account. |
| **Workspace** | Settings | Export, import, restore, and clearing data. |
| **What's New** | Help & Info | A plain-language list of recent changes. |

The Planning group is open by default; the other groups are collapsed until you
open them. A few page headings differ slightly from the sidebar label, for
example **Projections** opens a page headed "Balance Projection" and **Report**
opens "Export PDF". This guide uses the sidebar label to tell you where to click.

## The Dashboard

The Dashboard is the first screen after you sign in. It is **read-only**: you
look at it, you do not edit anything on it. It always shows the **active
scenario**, the one chosen in the sidebar. Its figures are shown in **today's
dollars**: adjusted for inflation, so an amount means what it would buy at
today's prices.

From top to bottom:

- **Retirement readiness.** A large **plan success** percentage and a small grid
  with two columns, **Typical** and **Pessimistic**, and two rows, **Ending
  balance** and **Money runs out**. These come from a **stress test**, also called
  a **Monte Carlo** simulation: the app replays your plan through 10,000 simulated
  market histories instead of assuming one fixed return. The percentage is the
  share of those runs in which your savings last the whole plan. **Typical** is the
  middle outcome (about half do better, half worse) and **Pessimistic** is a rough
  1-in-4 bad case. Beside the percentage the app shows a plain label for where it
  falls: "At or above 85%", "70% to 84%" or "Below 70%". **Money runs out** shows
  the year savings are used up, or **Never**. Hover over the percentage or the
  words "plan success" for a short explanation. The small **(i)** button beside
  **Plan basics** opens a longer one, "How success probability is calculated".
- A **disclaimer** under it, which says the percentage is "a statistical
  illustration, not advice or a promise about your future".
- Three cards: **Plan basics** (**Current net worth**, **Projected at
  retirement** and **Retirement year**), then **Portfolio allocation - by tax
  treatment** and **Portfolio allocation - by account type**.
- **Balance projection**, a chart with an **Open full projection →** link to the
  Projections screen.

Two behaviors are worth knowing:

- The stress-test figures fill in after a short delay while the simulation runs. Until then you see "—" and a progress bar. The rest of the page
  appears immediately.
- With **no accounts** yet, the Dashboard shows a prompt instead: "No accounts
  yet", with links to **Set up your household** and **add your first account**.

## Entering your data

The **Your Data** group holds everything you enter. The order below is a good one
for a newcomer, because each screen builds on the one before it.

### How the data fits together

- **Household** members own **Accounts**.
- Each account gets **Account Balances** (what it actually held, year by year) and
  **Annual Contributions** (what you plan to add).
- **Income**, **Expenses** (grouped by **Expense Categories**) and **Social
  Security** describe the money coming in and going out.
- A **Scenario** starts from all of that and can override parts of it. The
  **Projections**, **Dashboard**, planning tools and **Report** all read a
  scenario.

A balance entry is a **dated actual**: what an account held on a particular date.
A contribution is a **plan**: what you intend to add. Expenses are entered in
**today's dollars**, meaning at today's prices. The projection adds future
inflation for you, so you do not guess at it.

### Household

The people in the plan. You are the **Primary member (you)**. You may add a
**Spouse**. The page says to add a second member only if they are your legal
spouse; unmarried partners must use separate plans. Each person has a first and
last name, an email and a **Birthdate**. Only the spouse can be deleted. Deleting
a member that owns accounts asks you twice and warns that those accounts will need
to be reassigned or removed.

Your **Security → Account** card holds your sign-in details. It is separate from
this page: changing one does not change the other.

### Accounts

**Add Account** opens a form. The fields are:

- **Account name** and **Institution**.
- **Account type**, grouped as *Traditional (pre-tax)* (401(k), Traditional IRA,
  403(b), 457(b), TSP, Cash Balance Pension), *Roth* (Roth IRA and the Roth
  versions of the employer plans, where you paid tax on the money before it went
  in), and *Other* (HSA, Brokerage, Savings, Money Market, CD, Other). An IRA is an
  individual retirement account, 403(b), 457(b) and TSP are employer plans (the
  TSP is the federal employee plan), and an HSA is a health savings account. **Once an account has
  balance entries, its type can no longer be changed**; create a new account
  instead.
- **Owner**: one of the household members, or **Joint Ownership** for types that
  allow it.
- **Tax treatment**: *Tax-deferred* (you pay income tax when you withdraw),
  *Taxable*, *Tax-free (Roth)*, *Tax-free (HSA)* or *Mixed*. It is locked when the
  type allows only one.
- **Planning Return %**: the expected annual return the projection uses for this
  account.
- **Asset allocation**: **Stocks %**, **Bonds %** and **Cash %**, which must sum to
  100%. The stress test uses this mix.
- **Advanced tax details**, an optional section for special cases, such as an
  inherited account, a current employer's plan, or a start year for Roth
  contributions. Leave it alone unless one of those applies. The page notes that
  its cautious defaults can overstate tax, never understate it.
- **Notes** and an **Active** switch. Inactive accounts still count toward totals.

### Account Balances

A list of every account with its current balance, plus portfolio totals such as
**Current Balance**, **Contributions**, **Gain/Loss** and the split between
**Tax-Deferred**, **Taxable** and **Tax-Free** money. Choose **Edit** on a row to
open that account's yearly entries.

On the account's page, **Add Year** opens **Add Balance Entry**. Each entry has a
**Year**, a **Balance as of** date, and the year's **Starting Balance**,
**Contributions**, **Company Contributions**, **Ending Balance**, **Rollover** and
**Distributions**. Mixed accounts ask for pre-tax and post-tax amounts
separately, and some account types add **Roth Conversion (taxable)** and **Roth
Conversion (after-tax)** fields. A **Comment (optional)** box is available.

This history matters. It sets each account's current balance, and it is what the
**Historical** projection basis (the one that replays each account's own past
returns; see [Reading projections](#reading-projections)) learns from.

### Annual Contributions

One row per account, with planned **Pre-Tax** and **Post-Tax** amounts per year.
Enter personal and company contributions combined. The **Annual increase** column
defaults to **Match inflation**; set a percentage to override it. The
**Remaining** columns show the planned amount minus what you have already recorded
for the current year. Choose **Save** when you change anything. These are your own
planning targets: the app does not enforce IRS contribution limits.

### Income

**Add income** opens a form. The **Kind** is one of:

- **Pension**, paid as an **Annuity (lifetime monthly benefit)** or as a **Lump
  sum**, with a **Monthly benefit ($)**, a **Joint-and-survivor benefit** choice,
  and an **Annual COLA** (cost-of-living adjustment). **Use scenario inflation**
  ties the COLA to the scenario's inflation rate instead.
- **Part-time / earned income**, with an **Annual amount ($)**, start and end, and
  the same COLA choices.
- **One-off / windfall**, whose **Source** is **Inheritance**, **Asset sale** or
  **Other**, with an **Amount ($)** and a **Target account**.

Income reduces how much the projection draws from savings each year.

### Expenses

**Add expense** opens a form with **Name**, **Category**, **Frequency** (Weekly,
Monthly, Quarterly, Yearly or One-off), **Amount**, and a **Classification** of
**Essential** or **Discretionary**. The amount is in **today's dollars**; the
projection inflates it for you. Under **Start** and **End** you choose when the
expense begins and ends: at retirement, at a given age, or in a given year.

Two optional extras:

- **Spending glide** lets an expense's real cost fall over retirement (less
  travel as you age) or rise (care costs). It is switched on with the **Enable
  spending glide** toggle.
- For a medical expense, **Can be paid tax-free from an HSA** says whether the
  expense is paid from an HSA.

### Expense Categories

The categories expenses are grouped under. You can add, rename and delete them;
a category that is in use cannot be deleted until its expenses are moved. A
**Medical category** switch gives a category the higher medical-inflation default.

### Social Security

For each adult member, enter the **Monthly benefit at full retirement age (today's
dollars)** from your Social Security statement, and the **Date on the SSA
statement** (SSA is the Social Security Administration). The app derives the estimated amounts **At 62**, **At FRA** (full
retirement age) and **At 70** from that. You choose a claim age later, on the
scenario, not here.

## Scenarios

A scenario is a "what if?" version of your plan. Open **Planning → Scenarios**.

- The **Base** scenario holds your starting assumptions. It is the root of a tree.
- **Create scenario** makes a new one with a **Name**, an optional **Description**
  and a **Parent scenario**. A child scenario **inherits its parent's settings**.
  The Scenarios page puts it this way: child scenarios "inherit every change -
  only your overrides stay fixed".
- Each row shows the scenario's **Plan success** and four results: **Planned**,
  **Historical**, **Typical** and **Pessimistic**, explained under
  [Reading projections](#reading-projections). **Recalculate** (or **Recalculate
  all**) refreshes the stress-test numbers.
- The **Active** badge marks the scenario that is active. Change it with the
  **Active Scenario** picker in the sidebar. The choice is stored per device, in
  that browser.
- Use the pencil icon to open a scenario. The active scenario and the base
  scenario cannot be deleted. Deleting a scenario with children deletes them too.

### Inside a scenario

A scenario's page has fields for **Name**, **Parent scenario**, **Description** and
**Notes**, then four groups of cards. Each card has a **Configure** button and,
when it overrides the parent, a **Reset** button that goes back to the inherited
value. A group shows how many of its settings are customized.

| Group | Cards |
|---|---|
| **Timing & longevity** | **Retirement age**, **Social Security** (claim age), **Life expectancy** |
| **Income & expenses** | **Income**, **Expenses**, **Inflation**, **Discretionary adjustment**, **Spending guardrails** |
| **Savings & investments** | **Future contributions**, **Account contributions**, **Planned returns**, **Asset allocation** |
| **Withdrawals & taxes** | **Withdrawal strategy**, **Tax assumptions**, **Health coverage**, **Pre-retirement Roth conversions**, **Charitable distributions (QCDs)**, **Account limits** |

The scenario header also has **Reset all overrides**, **Promote to base** and
**Delete** (not on the base itself). **Promote to base** makes this scenario's
values the new base and deletes the old base, after two confirmations.

What the cards do:

- **Retirement age**: when each member stops working. This is when the projection
  switches from saving to spending down. Members can retire independently or
  together.
- **Social Security**: the age each member starts claiming, plus a **Benefit
  reduction** (a what-if cut to benefits) and an **Annual COLA**, either **Track
  inflation** or a fixed rate.
- **Life expectancy**: how long to plan for each member to live. A longer life
  means savings have to stretch further.
- **Income** and **Expenses**: the page subtitle says you can "disable an
  inherited" item, "modify it, or add one that exists only in this scenario".
  This changes the scenario only, not your Your Data entries.
- **Inflation**: how fast costs rise after you retire. The general rate applies to
  every category by default, and Medical starts higher.
- **Discretionary adjustment**: raise or lower optional spending (travel, hobbies,
  dining out) by a percentage, for some or all of retirement.
- **Spending guardrails**: automatic spending rules. Guardrails trim spending when
  markets fall and let you spend more when they rise, based on how well your
  savings cover the spending that guaranteed income (Social Security, pensions)
  does not. Cuts never drop below essential spending and raises are capped. This
  is a normal setting, switched on with **Use spending guardrails in this
  scenario**, and the stress test applies it when it is on. It is separate from
  the beta **Guardrails today** screen.
- **Future contributions**: **Stop contributing today**, or continue until
  retirement.
- **Account contributions** and **Planned returns**: override the planned
  contribution or the return for a single account in this scenario. Planned
  returns affect the **Planned** projection only.
- **Asset allocation**: a different stocks, bonds and cash split for an account in
  this scenario. The page itself is headed "Asset-mix overrides".
- **Withdrawal strategy**: the order accounts are tapped to cover spending. The
  four choices are **Tax-efficient** (taxable, then tax-deferred, then Roth, with
  HSA handled separately), **Proportional**, **Roth first** and **Custom order**.
  Tabs add a **MAGI cap** (a limit on pre-tax withdrawals; MAGI is the modified
  adjusted gross income figure that Medicare surcharges and ACA subsidies are
  based on) and **Advanced** settings.
- **Tax assumptions**: tabs for **HSA** (how much emergency HSA spending still goes
  to medical care), **Penalty exemptions** (accounts that skip the 10% penalty on
  withdrawals before age 59½) and **Filing** (how your household files its tax
  return).
- **Health coverage**: who is on an ACA Marketplace plan before Medicare, a **Where
  you live** setting (Alaska and Hawaii use different poverty guidelines), and
  months of coverage by year. The app asks you to enter the **full, unsubsidized**
  premium as a Medical expense, because it works out the subsidy itself.
- **Pre-retirement Roth conversions**: a **Roth conversion** moves money from a
  pre-tax account into a Roth account and you pay income tax on it now. This card
  models doing that during your working years, and its page is headed "Roth
  conversions while working".
- **Charitable distributions (QCDs)**: gifts from a traditional IRA to charity at
  70½ or older.
- **Account limits**: a minimum balance to keep in an account. Only taxable and
  HSA accounts can have one. The amount is a fixed dollar figure, not adjusted
  for inflation.

## Reading projections

Open **Planning → Projections**. The page is headed "Balance Projection" and shows
the active scenario's name.

### The controls

A strip across the top has:

- **Basis**: which kind of projection to show. See below.
- **Show another likely path**: when a stress-test basis is selected, picks a
  different example path.
- **Recalculate**: re-runs the stress test with a fresh random sample.
- **Today's dollars** and **Future dollars**: see below.
- **What do these mean?**: opens "How to read these figures", a short glossary of
  the figures on the page.
- **Print / Save as PDF**, at the top right, uses your browser's print dialog.

At the top of the page, a **Success probability** card shows the stress-test
percentage. The page disclaimer says output is informational and past performance
does not guarantee future results.

### The three bases

The **Basis** menu has two groups.

**Deterministic** means one fixed return per account, so the answer is a single
line.

- **Planned** grows each account at the **Planning Return %** you set for it. It is
  your plan if your own estimates hold.
- **Historical** grows each account at the rate it has **actually earned in your
  balance history**, as a check against your real track record. It needs enough
  balance history; without it the option is greyed out. Past performance is not a
  forecast: your accounts may earn more or less than they have.

**Monte Carlo** is the **stress test**. Instead of one fixed return it runs 10,000
simulated market histories, each built by randomly stitching together stretches of
real historical monthly returns, with inflation drawn from the same historical
record. That shows the range of outcomes instead of one, including the effect of
bad luck early in retirement. It reports a **success probability** (the share of those runs in which
the savings last) and three representative outcomes:

- **Typical**: the middle outcome. About half do better, half worse.
- **Pessimistic**: a rough 1-in-4 bad case (the 25th-percentile outcome).
- **Bad-luck**: a rough 1-in-10 bad case (the 10th-percentile outcome).

When you pick one of these in **Basis**, the page shows one example simulated path
near that outcome and labels it "Based on one example simulated path".

There is no separate Monte Carlo screen: the stress test is a basis on this page.

### Today's dollars and Future dollars

- **Today's dollars** shows amounts adjusted for inflation, in today's money, so
  $100k stays $100k however distant the year.
- **Future dollars** shows the raw projected amount for that year with inflation
  left in, so the same $100k reads larger the further out you look.

One is the other adjusted by the scenario's inflation rate. The Expenses screen
has the same toggle.

### The six views

Tabs under the controls, **Projection views**, split the page:

- **Overview**: totals at retirement and at the **horizon** (the end of the plan,
  the last household member's projected end of life) for each basis; the **Monte
  Carlo outcomes** cards with each tier's ending balance and either "Runs out" and
  a year or "Funds the full horizon"; the **Per-year projection** chart; and the
  **Stress-test outcomes** card. Under it, **Compare against market stresses**
  re-runs the same plan with **Higher fees**, **Lower returns**, **Higher
  inflation** and **Longer life**, and shows the change in success.
- **Cash flow**: expected income against spending, an income breakdown, and
  yearly money flowing in and out of the portfolio.
- **Accounts**: a per-account breakdown, a year-by-year table, and a stacked chart
  of balances.
- **Taxes & distributions**: the **Tax & Health-Cost Burden** chart, which shows
  **Federal income tax**, **Medicare surcharges (IRMAA)** and **ACA health credits**
  (credits are shown below zero because they reduce your cost). Below it, three
  bands appear only when they apply to your plan: **Required Minimum
  Distributions** (RMDs met, with any shortfall), **Qualified Charitable
  Distributions (QCD)**, and **Roth conversions**.
- **Safe withdrawal rate**: compares your plan's yearly withdrawal from the
  portfolio with the "4% rule" and "4.5% rule" lines. These are rules of thumb
  from published research, not forecasts, and the page notes that they are stated
  before tax while the comparison is after tax.
- **Compare**: sets the scenario you are viewing against one other scenario. Pick
  it in the **Compare with** list, which shows every other scenario indented the
  same way as the **Active Scenario** list in the sidebar. It starts on the
  viewed scenario's parent; on Base, which has no parent, it asks you to pick
  one, and with only one scenario it says there is nothing to compare with and
  links to **Scenarios**. The choice is remembered in your browser for each
  scenario you view, and a link ending `?view=compare&with=` plus a scenario's
  id opens the tab with that scenario chosen. A table shows both scenarios side
  by side, each headed by its name and its horizon year: the **ending balance at
  the horizon**, the year money runs out (or "Never"), and a **Difference**
  column that is the viewed scenario minus the other, written with a sign and a
  word such as "more" or "later" so it never relies on colour. Compare always
  uses the Planned projection in today's dollars, so the **Basis** menu and the
  **Today's dollars** / **Future dollars** switch in the header do not apply to
  it.

Most charts and bands have a small **(i)** button that explains what they show.

### How far to trust it

- A projection is only as good as the inputs. Wrong balances, spending or ages
  mean wrong answers.
- Past returns do not predict future ones, in any basis.
- The tax rules inside the app are a point-in-time snapshot and may be out of
  date, and the tax figure is a simplified estimate, not a tax return.
- Comparing two plans that differ by a point or so of success is mostly noise: the
  stress test is a sample, and the same plan re-run can move by a fraction of a
  point.
- The stress-test explainer lists what it does and does not model. Open the
  **(i)** beside **Success probability** to read it.

## The planning tools

These three sit under **Planning** and each answers one question.

### Social Security claim-age

*"Which claim age gives the best modeled result?"* The page is headed "Social
Security claim-age comparison". For each scenario it compares the projected result
at every eligible whole-year claim age for each household member, and shows the
age with the highest modeled result. It says explicitly that this "does not tell
you when to claim", and that the model leaves out some real-world Social Security
rules, such as divorced-spouse benefits.

Choose the goal, **End-of-plan balance** (a quick comparison using the Planned and
Historical projections) or **Plan success %** (the stress test; choose how many simulated paths, then **Run
comparison**, which can take several minutes and runs in your browser, so keep
the screen open). A member with no benefit amount shows "PIA not set"; PIA
(primary insurance amount) is the benefit at full retirement age that you enter
under **Your Data → Social Security**.

**Save to scenario** writes the winning claim age into that scenario's Social
Security setting, after a confirmation that names the scenario and the ages. It
replaces the claim ages but keeps the scenario's benefit reduction and COLA.

### Roth conversion comparison

*"At what tax rate does converting stop paying off?"* It compares the tax you
would pay on a conversion with a break-even tax rate, across four ways of paying
the tax (**Pay tax from the IRA**, two **Taxable account** choices with lower or
higher default tax drag, meaning the share of a taxable account's growth lost to
tax each year, and **Cash**), with a **Working years** panel and a
**Retirement years** table. It assumes all the money in traditional accounts is
pre-tax (the IRA pro-rata rule, which taxes a conversion partly by the after-tax money
already in your IRAs, is not modeled), uses federal taxes only, and is a
deterministic projection (one fixed return, not the stress test). The page says its comparisons are informational and "do
not tell you whether converting is right for you".

Two buttons write results back to the selected scenario: **Save working-years
conversions to scenario** and **Save retirement Fill window to scenario** (a
pre-RMD MAGI-cap "Fill" window, set up on the scenario's **Withdrawal strategy**).

### Report

*"Can I get all of this on paper?"* The page is headed "Export PDF". Pick a
**Scenario**, a **Basis** and **Today's dollars** or **Future dollars**, check the
preview, and choose **Export PDF**. The PDF is built in your browser and
downloaded; nothing is saved back to the scenario.

The PDF has a cover, a scenario summary, your accounts, the balance projection,
cash flow, year-by-year detail, income, expenses, the RMD, QCD and Roth sections
when they apply, tax and health costs, and an **Important Information** page with
the disclaimer. A beta section is left out unless that beta feature is on.

## Beta features

Two items are marked **Beta**, which means still being finished. They may not work
perfectly, may change, or may be removed. They appear only when **both** of these
are true:

1. The copy's build offers them. A local copy offers all beta features unless its
   settings say otherwise; the person who runs a deployed copy decides.
2. You turn on **Show beta features** under **Settings → Preferences**. It is off
   by default, and the choice is stored in that browser.

If the build offers none, the **Beta features** card is not shown at all.

- **Projected withdrawals** (Planning). A year-by-year view of the withdrawals the
  plan projects from each account, with the required minimum by account group,
  the year's income tax and Medicare, and what is left to spend after tax. It
  has a year stepper and a full schedule you can expand.
- **Guardrails today** (Planning). Reads your current balances and shows where your
  spending stands today against the range set in the scenario's **Spending
  guardrails**. It is a description, not an instruction. **Check now** runs a fresh
  stress test for context.

These are different from the **Spending guardrails** card inside a scenario, which
is a regular setting and not a beta feature.

## Settings, syncing and your data

### Preferences

**Appearance** is a **Light**, **Dark** or **System** theme. The **Beta features**
card is described above.

### Security

**Settings → Security** has one card for each of these:

- **Account**: edit your first name, last name and birthdate, and **Change email**
  (you confirm with your password and a link sent to the new address).
- **Password**: **Change password**. It signs out your other devices. You must
  have your data unlocked first.
- **Passkeys**: **Add passkey** to sign in with your device's biometrics or PIN. A
  passkey you mark **Use for encryption** can also unlock your data.
- **Recovery key & encryption**: **Generate a new recovery key** if you lost yours.
  The app cannot show the old key again, but the old key keeps working until you
  activate the new one.
- **Two-factor authentication**: **Set up authenticator app**, and a list of
  **Trusted devices**.
- **Delete account**: **Delete my account…**. You confirm your password and are
  offered **Export my data** first. It deletes your live account and workspace. The
  dialog notes that security logs and backups are not removed at once but expire on
  their own schedule.

Many of these actions open **Confirm it's you** and ask for a fresh second factor
(this is called step-up) when the copy requires a second factor. The
[security overview](security.md) covers all of these in depth.

### Start over when you cannot unlock your data

If you are signed in but cannot unlock your encrypted data (you have neither the
password nor the recovery key, and no browser you used before still unlocks it),
**Settings → Security → Recovery key &
encryption** offers **Use recovery key to unlock your data** and, as a last
resort, **Delete unreadable encrypted data**.

The last one opens **Start over with this account**. After you enter your current
password and type **DELETE**, **Delete and start over** permanently deletes the
encrypted data you cannot unlock, on this device and on the server, and signs you
out of every device. **This cannot be undone.** Your account, sign-in details and
security history stay, and you can sign in again and begin with an empty
workspace. The unlock screen links to the same place with "Lost access to your
password and recovery key?". The
[security overview](security.md#start-over-resetting-encryption) describes what this does.

### Workspace

**Settings → Workspace** has three cards.

**Data**

- **Export my data** downloads a compressed file with your saved data and your
  account record, sign-in and security history. Keep it somewhere private. It asks
  for your password.
- **Import from file** replaces your workspace with a copy you exported earlier.
  Anything in your current workspace that is not in the file is deleted, and those
  replacements and deletions sync to the server and to your other devices, so the
  current server copy is not kept. Export your current workspace first if you may
  want it back. Import asks for your password, warns that unsynced changes are
  lost, and warns if the file came from a different account.
- **Restore previous version** rolls the workspace back to an earlier saved
  snapshot. The app says versions are saved automatically about once an hour.
  Restoring replaces your workspace with that version, and every change since
  then is permanently lost. It cannot be undone. If you changed your password
  since that version, you may need your recovery key afterwards.

**Workspace tools**

- **Load demo data** adds the demo family. If you already have data it warns you,
  asks for your password, and asks a second time before it replaces everything.
- **Reload from server** drops what this browser holds, including edits that have
  not synced yet (it lists them first), and downloads a fresh copy. You stay
  signed in.
- **Clear data on this device** signs you out and removes the app's saved data
  from this browser. Your account and the server copy are untouched; sign in again
  to get it back. If it cannot confirm that you are signed out, for example
  because you are offline, nothing is changed.
- **Delete workspace data** asks for your password and a confirmation that shows
  how many records it will clear. It deletes every account, scenario, expense and
  member on this device **and on the server**, and keeps your account and sign-in.
  An empty Base scenario and the default expense categories come back. An **Also
  erase backup history** box also removes the saved backups; leave it unticked
  and you can undo the deletion from **Restore previous version** until the
  backups age out.

Use **Clear data on this device** whenever you have signed in on a public or shared
computer. The sign-in page reminds you to avoid those computers.

**Diagnostics**

Recent errors and activity are saved on the device so you can review them or
download a file. Nothing is sent anywhere automatically. **Export diagnostics**,
**View recent activity** and **Clear diagnostics** only touch this device. The
file may contain personal data, so look through it before sharing it.

### Syncing and where your data lives

Your data lives in two places. It is stored in your browser for speed and
offline use, and it is synced to the copy's server, encrypted. You work against the
browser copy, and edits are sent to the server in the background.

The **sync badge** at the top of the sidebar shows the state. Choose it for
details (**Status**, **Last synced**, **Pending**, **Conflicts**, **Connection**):

| Badge | Meaning |
|---|---|
| **Synced** | Everything is up to date, with the time of the last sync. |
| **Syncing…** or **Refreshing…** | Sending or receiving changes. |
| **Pending (N)** | N edits are waiting to be sent. **Sync now** sends them. |
| **Offline** | No connection. Edits are kept and sent when you reconnect. |
| **Sync failed** | A problem sending or receiving. **Retry now** tries again. |
| **Refresh needed** | Someone changed things elsewhere. **Refresh from server** fetches them. |
| **Update available** | A newer version of the app is available. **Reload to update**. |
| **Sync blocked** | The server returned an out-of-date or tampered view, and sync stopped to protect your data. There is nothing to retry. |

If the same item was changed on two devices, the details list it as a conflict with
**Keep mine** and **Discard** for each one.

Three things follow:

- **Browser data belongs to a web address.** A different address, or a different
  browser, starts empty until you sign in and sync. After you sign in, it asks you
  to unlock your data with your password or recovery key.
- **Clearing browser data is recoverable only from the server copy.** Edits that
  had not synced yet are lost. Check that the badge reads **Synced** first.
- **Idle sign-out.** The app signs you out after a period of inactivity (30
  minutes by default) and tells you so.

## What the app is not

- **It is not financial, tax or legal advice.** Every screen that shows an
  estimate carries a reminder along the lines of "Illustrative only. Not financial
  advice." and tells you to consult an appropriately qualified professional and
  verify every figure that matters against your own records before acting. The
  PDF carries a fuller notice.
- **It is a model, not a forecast.** The outputs follow from your inputs and a set
  of simplified assumptions. Actual results will differ, potentially
  significantly.
- **Past returns do not predict future returns**, whether they are your accounts'
  history or the market history the stress test draws on.
- **Its tax and benefit rules are a snapshot.** They cover United States federal
  rules only and may be out of date.
- **It leaves things out.** The pages that rely on a simplification say so in their
  **(i)** notes or disclaimers, and the Social Security comparison lists some real
  rules it does not model.
