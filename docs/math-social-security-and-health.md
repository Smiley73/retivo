# How the math works: Social Security and health costs

This page explains how RETIVO turns what you entered into three things: each
person's yearly Social Security income, the Medicare surcharge (IRMAA) and the
ACA premium credit. It also covers the claim-age comparison, which tries
different claiming ages and ranks them. It is for anyone with basic
personal-finance knowledge. You do not need to read code. For each part it says
what goes in, how the number is worked out, which built-in yearly figures are
used and for which years, and what the app simplifies. It is an explanation of
the model, not advice: the figures are estimates built from what you entered,
and the built-in tables are a snapshot that may be out of date.

For where these settings are on screen, see the user guide sections
[Social Security](user-guide.md#social-security),
[What the cards do](user-guide.md#inside-a-scenario) and
[Social Security claim-age](user-guide.md#social-security-claim-age). How
Social Security is taxed, and how the two income measures (MAGI) used below are
built, is on [the taxes page](math-taxes.md#tax-on-social-security). This page
uses those measures and does not work them out again. For how the calculation
engine fits into the app, see [architecture.md](architecture.md). How the
income thresholds steer withdrawals is covered on the withdrawals page.

## Social Security benefits

Each year of retirement, the app works out how much Social Security each member
receives. The amounts are in nominal dollars, the dollars of that year. The
**Today's dollars** view deflates them later.

**The app does not calculate your benefit.** You type in the monthly benefit at
full retirement age from your Social Security statement. This is called the
**PIA** (primary insurance amount). There is no earnings record, no bend points
and no wage indexing anywhere in the app. Everything below starts from that one
entered amount and adjusts it.

### What goes in

- **PIA** for each member, under **Your Data → Social Security**, in today's
  dollars. The optional **Date on the SSA statement** says which year's
  cost-of-living raises it already includes. Enter it: without it, the amount is
  treated as the benefit in the year the member turns 62 (see
  [Cost-of-living raises](#cost-of-living-raises-cola)).
- Each member's **birthdate**. It sets full retirement age (FRA) and the claim
  date.
- On the scenario's **Social Security** card: each member's **claim age** (years
  and months), an optional **survivor claim age** for each member, the
  **Benefit reduction** (a what-if cut, 0% to 50% in steps of 5), **Track
  inflation**, and **Annual COLA**.
- **Life expectancy** for each member. The member is treated as alive through
  December 31 of the year they reach it, and the spousal and survivor rules
  switch on the following January.
- Part-time income streams, for the earnings test.

A member with no usable birthdate gets no benefit, because the claim date
cannot be placed. A member with no PIA has no benefit of their own but can
still receive a spousal or survivor amount.

### Claiming-age adjustments

**Full retirement age** (FRA) is the age at which you get exactly your PIA. It
depends on the birth year:

| Birth year | FRA |
|---|---|
| 1943 to 1954 | 66 |
| 1955 | 66 and 2 months |
| 1956 | 66 and 4 months |
| 1957 | 66 and 6 months |
| 1958 | 66 and 8 months |
| 1959 | 66 and 10 months |
| 1960 or later | 67 |

A person born on the 1st of a month is treated as born in the month before, and
a January 1 birthday counts as the previous year. Birth years before 1943 are
not in the table. The app then uses an FRA of 67.

The **claiming-age factor** multiplies the PIA:

- **Early claim.** Reduced by 5/9 of 1% for each of the first 36 months before
  FRA, and 5/12 of 1% for each month beyond that. At 62 with an FRA of 67 that
  is 36 x 5/9% + 24 x 5/12% = 30%, a factor of 0.70.
- **Late claim.** Raised by 2/3 of 1% for each month after FRA, so 8% a year.
  Credits stop at 70, and a claim age above 70 counts as 70. At 70 with an FRA
  of 67 the factor is 1.24.

Payments start in the month the member reaches the claim age (for a claim at
62, the first full month at 62). In the claim year, the yearly table counts only
the months paid.

The Planned and Historical projections pay delayed credits with a lag: credits
earned in a calendar year are paid from the following January, and from the
month you turn 70 all credits are paid. The stress test works from yearly
figures and pays the whole credit from the claim month.

### Cost-of-living raises (COLA)

COLA raises every benefit each January. The rule has three parts:

- **Which years.** The entered PIA is treated as already including every raise
  up to the statement date. Raises compound only for years after the
  statement's year. With no statement date on file, they compound for years
  after the year the member turns 62. So the amount is treated as the benefit
  in the year they turn 62, not in today's dollars. A member younger than 62
  gets no raises until then, and the benefit shrinks in today's dollars. Leaving
  the date blank is not harmless for them.
- **Which rate.** With **Track inflation** on (the default), the rate is the
  scenario's general inflation rate. With it off, the rate is the **Annual
  COLA** you set, 2% if you never set one.
- **Nominal.** The result is in nominal dollars. No other inflation factor is
  applied.

### Benefit reduction

**Benefit reduction** is a flat percentage cut on the whole projected benefit.
A 20% reduction multiplies every own, spousal and survivor amount by 0.80. See
[How the pieces combine](#how-the-pieces-combine) for where it is applied.

### Spousal benefits

A member can receive their own benefit plus a **spousal top-up**. It is not
"the larger of the two":

1. The top-up base is half of the other person's PIA, minus the member's own
   PIA. If that is zero or less, there is no top-up.
2. The base is reduced for early claiming on its own schedule: 25/36 of 1% for
   each of the first 36 months before FRA, and 5/12 of 1% for each month beyond
   that. At 62 with an FRA of 67 the factor is 0.65. At FRA or later it is 1.00.
   Delayed credits are never added.
3. The reduction is counted from the later of the member's own claim age and
   their age when the other person claims.
4. The top-up is paid only once both people have claimed, from the later of the
   two claim months. It grows with COLA counted from the other person's
   statement date, because it comes from their record.
5. It stops when the other person dies. The survivor rules take over.

### Survivor benefits

When one member dies, the other can step up to a survivor amount.

- **Its own claim age.** The survivor claim age is separate from the member's own
  claim age. The card allows 60 to 70. Payments start at the later of that age
  and the January after the death, and the reduction below is worked out at the
  age the payments actually start.
- **Its own FRA table.** The survivor FRA is the retirement table shifted two
  birth years later, shown below.
- **The base.** It is the deceased's PIA. If the deceased claimed after FRA, the
  base also includes the delayed credits they actually earned, up to their
  age at death. The deceased's own early-claim reduction does not carry over.
- **The survivor's early reduction.** It is 0% at the survivor FRA, rising evenly
  to 28.5% at age 60. The reduction amount is rounded up to the next dime of
  monthly benefit before it is subtracted. Waiting past the survivor FRA earns
  nothing.
- **The cap.** If the deceased had claimed before FRA and was already receiving
  that reduced benefit, the survivor amount cannot exceed the larger of that
  reduced benefit and 82.5% of the deceased's PIA.
- **The step-up.** The survivor receives the higher of their own check and the
  survivor amount, month by month. COLA is counted from the deceased's
  statement date.
- **No survivor claim age set.** The survivor amount is withheld, the survivor
  keeps only their own benefit, and the year is flagged. The app never picks an
  age for you.

| Birth year | Survivor FRA |
|---|---|
| 1943 | 65 and 8 months |
| 1944 | 65 and 10 months |
| 1945 to 1956 | 66 |
| 1957 | 66 and 2 months |
| 1958 | 66 and 4 months |
| 1959 | 66 and 6 months |
| 1960 | 66 and 8 months |
| 1961 | 66 and 10 months |
| 1962 or later | 67 |

### The earnings test

If you claim before full retirement age and keep working, Social Security
withholds part of your benefit. The app models this:

- **What counts as earnings.** Only that member's **part-time** income
  streams. Pensions, annuities, one-off amounts and withdrawals do not count.
- **Years before the FRA year.** $1 is withheld for every $2 of earnings over
  the lower yearly limit.
- **The FRA year.** Only earnings before the month you reach FRA count. $1 is
  withheld for every $3 over the higher limit. From the FRA month on there is
  no test.
- **What is withheld.** Monthly checks, one after another from the first payable
  month of the year. The last one withheld can be partial. Withholding never
  exceeds that year's checks before FRA.
- **Which checks.** A member's earnings are charged against everything paid on
  their record: their own and survivor checks, any spousal top-up their spouse
  draws on their record, and their own top-up.
- **The grace year.** In the first year with a month in which the member earns
  no more than one twelfth of the limit, any such month is paid in full whatever
  the yearly total. The app uses whichever of the two tests withholds less.
- **Credit back at FRA.** From the FRA month, withheld months are treated as if
  you had claimed that many months later (never later than FRA). Your own
  benefit and your spousal top-up rise. A withheld survivor check is not
  credited back.
- **Monte Carlo.** The earnings test is **not applied in Monte Carlo** (the
  stress test). Only the Planned and Historical projections apply it.

### How the pieces combine

Each year, for each member:

1. **Own benefit.** PIA x claiming-age factor x (1 - Benefit reduction) x COLA
   for each year since the anchor year. It is paid from the claim month.
2. **Add the spousal top-up,** reduced the same way.
3. **Step up to the survivor amount** if the other member has died, and the
   survivor amount is higher.
4. **Subtract the earnings-test withholding.**

Benefit reduction is built into step 1 and into the spousal and survivor
amounts, so it comes before the earnings test, which then works on the smaller
checks.

### Built-in figures and years

The earnings-test limits are the only yearly Social Security figures:

| Year | Lower limit | Higher limit (FRA year) |
|---|---|---|
| 2024 | $22,320 | $59,520 |
| 2025 | $23,400 | $62,160 |
| 2026 | $24,480 | $65,160 |

- **After 2026.** The 2026 limits are scaled by the scenario's inflation rate
  for each year past 2026 (no scaling at a zero or negative rate), rounded to
  the nearest $10, and the year is flagged as an estimate.
- **Before 2024.** The 2024 limits are used, also flagged as an estimate.

These have no year in the code. They are **fixed rules**, not tied to any
year: the FRA tables, the reduction and credit rates, ages 60, 62 and 70, the
50% spousal share, the 28.5% survivor reduction, the 82.5% cap, the $1-for-$2
and $1-for-$3 withholding ratios, and the 2% default COLA.

### Simplified or left out

- **No benefit calculation.** The PIA is entered, not worked out.
- **Not modeled:** divorced-spouse benefits, child benefits, disability
  benefits, SSI, and rules for people who worked or live abroad. The windfall
  elimination provision (WEP) and government pension offset (GPO) are not
  modeled either.
- **The stress test uses a simpler yearly version** of the benefit: **no
  earnings test** and no January lag on delayed credits. Each simulated path
  also scales the benefit by that path's own inflation relative to the
  scenario's inflation rate.
- **Survivor checks** withheld by the earnings test are not credited back at the
  survivor's FRA.
- **Death timing** comes from the **Life expectancy** setting, not from the
  market path or anything random.

**Code.** All paths are under `apps/web/src`. `lib/ss-projection.ts` assembles
the yearly and monthly benefits, and its header comment is a one-page summary
of the rules. `lib/ss-projection-helpers.ts` holds the claim dates, COLA
anchor, own and spousal amounts and the earnings-test timing.
`lib/ssa-formulas.ts` has the claiming-age factors, the FRA tables and the
birthdate rules. `lib/ss-spousal-survivor.ts` has the survivor rules.
`lib/ss-earnings-test.ts` has the limits and the withholding rule.
`lib/earned-income-series.ts` picks out the part-time income.
`lib/ss-context-builder.ts` assembles the inputs and chooses the COLA rate.
`lib/monte-carlo-input-bundle.ts` builds the stress test's yearly amounts.

## The Social Security claim-age comparison

The **Social Security claim-age** page answers one question: which claim age
gives the best modeled result for this scenario? It does this by trying them.

### What goes in

Everything in the scenario as it stands, plus a **goal**:

- **End-of-plan balance.** The total balance at the end of the plan, in today's
  dollars, from one projection. The Planned method gives the Planned row. The
  Historical method gives the Historical row.
- **Plan success %.** The share of simulated paths in the stress test where the
  money lasts. Every candidate runs the same random paths, so differences come
  from the claim age alone.

### How it is worked out

1. **List the ages to try.** For each member who has a PIA, every whole-year age
   from the later of 62 and their current age (rounded up) to 70. A member past
   70, or with no PIA, is left at the scenario's current claim age, or 67 if
   none is set. Only the other member's age is varied.
2. **Pair them.** For a couple, every pairing of the two lists.
3. **Run each pair.** The whole projection is run again with that pair as the
   claim ages. Nothing else in the scenario changes. The survivor claim age is
   not searched. The scenario's stored value is carried through unchanged.
4. **Pick the winner.** The highest result wins. When two results are exactly
   equal, the **younger age wins**: the lower primary age first, then the lower
   secondary age. This matters for Plan success %, where many ages can show
   the same percentage.
5. **Compare with the present.** The page shows the result at the scenario's
   current ages next to the winner, when those are whole years inside the
   searched range. If they are already the winning ages, it says so.

The comparison has no built-in yearly figures of its own. The ages 62 and 70 are
fixed rules with no year. Every projection it runs uses the figures on this page
and on the taxes page.

**Save to scenario** is described in the
[user guide](user-guide.md#social-security-claim-age). It writes the winning
ages as whole years and keeps the scenario's benefit reduction, COLA and
survivor ages.

### Simplified or left out

- It ranks on one number. It does not weigh risk, taxes you might owe, or what
  the money is for.
- It assumes each member lives exactly to their **Life expectancy** setting. It
  does not weigh the chance of living shorter or longer.
- Claim ages with extra months are never tried. Only whole years are.
- Plan success % uses the stress test, which does not apply the earnings test.

**Code.** All paths are under `apps/web/src`. `lib/claim-age-optimizer.ts` and
the files in `lib/claim-age-optimizer/` build the age lists
(`build-grid.ts`, `orchestrator-helpers.ts`), run each pair
(`simulate-candidate.ts`) and pick the winner (`pick-winner.ts`).
`lib/optimizer-mc-runner.ts` runs the Plan success % version.
`pages/SsOptimizerPage.tsx` is the screen.

## Medicare surcharges (IRMAA)

**IRMAA** (Income-Related Monthly Adjustment Amount) is an extra monthly charge
on Medicare Part B (doctor and outpatient cover) and Part D (drug cover) for
people with higher income. The app works out only the **surcharge**. It does not
model the base Part B premium. Enter that as a medical expense if you want it
counted. The Expenses page **Add Medicare premiums** action adds the standard
Part B and Part D amounts as ordinary medical expenses, which then grow at the
scenario's medical inflation rate like any other medical expense.

### What goes in

- The federal MAGI from **two years earlier**, and the filing status of that
  earlier return. See [the two income
  measures](math-taxes.md#the-two-income-measures-magi).
- Each member's **months on Medicare Part B and Part D**. By default these
  start in the month the member turns 65 (the month before, for a birthday on
  the 1st). You can state months per year on the **Health coverage** card.
- For the first two retirement years, the **Pre-retirement income (Medicare
  surcharge lookback)** setting on the **Advanced** tab of **Withdrawal
  strategy**.

### How it is worked out

1. **Find the look-back income.** It is the MAGI of the year two before the
   surcharge year. For the first two retirement years the projection has no
   earlier year of its own, so it uses the setting above. One amount stands in
   for both years. If you leave it on **Use engine default**, the Planned and
   Historical projections estimate it from the first retirement year's own MAGI
   and mark it as an estimate. With the default, the stress test charges no
   surcharge in those two years. It only matters if someone is on Medicare in
   them.
2. **Pick the ladder from the filing status of the look-back return.**
   - Single, head of household and qualifying surviving spouse share one ladder.
   - Married filing jointly has its own, higher thresholds.
   - Married filing separately uses the single ladder if the couple lived apart
     all year. If they lived together at any time, a steeper two-band ladder
     applies: the tier 4 amount from the first single threshold, and the tier 5
     amount from a lower top threshold.
3. **Find the tier.** Tiers 1 to 4 start when MAGI is **above** the threshold.
   Tier 5 starts when MAGI is **at or above** its threshold.
4. **Read the monthly surcharge** for that tier, for Part B and Part D.
5. **Prorate each part by months.** For each member on Medicare, Part B is
   (monthly surcharge x 12) x (Part B months / 12), and Part D is worked out
   the same way with that member's Part D months. The two parts are counted
   separately, so a member can have one and not the other.
6. **Add up the members.** This is the year's surcharge.

**How it reaches the numbers.** The surcharge is split per member. Each
member's share is withheld from their own Social Security, up to the amount of
that benefit. Anything left over is a same-year cash need that your accounts
fund. The surcharge is based on income two years back, so it is fixed within the
year and does not change as the year's withdrawals change.

### Built-in figures and years

2026 surcharges, by tier. The thresholds are MAGI.

| Tier | Single, head of household, surviving spouse | Married filing jointly | Part B a month | Part D a month |
|---|---|---|---|---|
| 1 | above $109,000 | above $218,000 | $81.20 | $14.50 |
| 2 | above $137,000 | above $274,000 | $202.90 | $37.50 |
| 3 | above $171,000 | above $342,000 | $324.60 | $60.40 |
| 4 | above $205,000 | above $410,000 | $446.30 | $83.30 |
| 5 | $500,000 or more | $750,000 or more | $487.00 | $91.00 |

For married filing separately and living together, 2026 has a charge of
$446.30 and $83.30 above $109,000, and $487.00 and $91.00 at $391,000 or more.

The built-in tables cover **2024, 2025 and 2026** and are keyed by the year the
surcharge is paid. The 2024 and 2025 tables follow the same rules with their
own figures. A year before 2024 uses the 2024 table. For a year after 2026:

- The look-back MAGI is divided by (1 + inflation) for each year past 2026, then
  compared with the 2026 thresholds. With zero or negative inflation it is not
  scaled.
- The surcharge dollars are multiplied by the same factor afterwards.

The ladder rules, the 65 starting age and the month-by-month proration are
fixed rules with no year.

### Simplified or left out

- **Surcharge only.** The base Part B and Part D premiums are not modeled. The
  Expenses page **Add Medicare premiums** action adds them as medical expenses,
  so they grow at medical inflation; Medigap, Medicare Advantage and your actual
  Part D plan price stay yours to enter.
- **A stand-in for the first two retirement years.** After that the look-back is
  the projection's own MAGI.
- **Year scaling.** Past 2026 it uses the scenario's general inflation rate, the
  same one the tax tables use.

**Code.** All paths are under `apps/web/src`. `lib/irmaa.ts` finds the tier and
prorates by month. `lib/irmaa-tiers.ts` has the built-in tables and the ladder
choice. `lib/tax-integration.ts` runs it each year and applies the year
scaling. `lib/tax-integration-helpers.ts` holds the year-table choice and
`resolveMemberHealthCoverage`, which works out Medicare months.
`lib/balance-projection-runner-tax.ts` supplies the look-back income.
`lib/tax-cashflow-solver.ts` withholds each member's share from their Social
Security.

## ACA premium credits

The **ACA premium tax credit** lowers the cost of a Marketplace plan for people
who are not yet on Medicare. The app works out the credit and uses it twice.
First it goes against the year's federal tax and IRMAA cash need. Whatever is
left lowers that year's withdrawals as its own line, **Credit applied to
premiums**, up to your Medical expenses for the year and up to what your
accounts would otherwise draw. You enter the full, unsubsidized plan price as a
medical expense, because the app works out the subsidy itself.

### What goes in

- The **ACA MAGI** for the current year. See
  [the two income measures](math-taxes.md#the-two-income-measures-magi). It adds
  back the untaxed part of Social Security.
- The year's filing status and household size.
- On the **Health coverage** card: who is on a Marketplace plan (each member can
  be marked as having other coverage), **Where you live**, **Months on a
  Marketplace plan** by year, and **Benchmark plan cost for the year**.

### How it is worked out

1. **Count the covered months.** For each member who is retired, was not marked
   as having other coverage, and has a usable birthdate, the default is 12
   minus their Medicare months. A count you state replaces the default. A month
   on Medicare is never a Marketplace month, so a count can never exceed 12
   minus the Medicare months. The household's covered months are the largest
   member count.
2. **Find the income as a share of the poverty line.** ACA MAGI divided by the
   federal poverty line for the household size, as a percentage. Under 100%,
   there is no credit.
3. **Check eligibility.** For 2026 and later years, income above 400% of the
   poverty line gets no credit (the percentage is rounded down to a whole
   number first, so 400.9% counts as 400%). For 2024 and 2025 there is no such
   cutoff. Married filing separately is **never** eligible.
4. **Find the applicable percentage,** the share of income you are expected to
   pay. Inside a band it rises evenly between the band's two ends.
5. **Expected contribution** = ACA MAGI x applicable percentage x covered
   months / 12.
6. **Find the benchmark premium.** This is the price of the second-lowest-cost
   silver plan, summed over the months covered. The app uses one of two:
   - The **Benchmark plan cost for the year** you entered for that year. It is a
     whole-year figure, so it is cut to the covered months (a 6-month year uses
     half).
   - Otherwise a rough estimate: **$700 a month at age 60 in 2026, up 5% for
     each year of age**, for each covered member and each covered month. The age
     is the year minus the birth year. For a year after 2026 the household's
     total is multiplied by (1 + medical inflation rate) for each year past
     2026, rounded once to the cent. The medical rate is the scenario's
     inflation rate for the Medical expense category, which is the general
     inflation rate plus 2 percentage points unless you set it.
7. **Credit** = benchmark premium minus expected contribution, never below zero.

**How it reaches the numbers.** The credit is used in two steps.

1. **Against tax and the surcharge.** It is counted against that year's federal
   tax and IRMAA cash need. It lowers what your accounts must fund for those,
   and it cannot make that need negative. This part is the **ACA PTC offset**.
2. **Against your Medical expenses.** What is left of the credit is a cash
   refund of premiums you already entered as an expense, so it lowers that
   year's withdrawals. The line is the smallest of three amounts: the credit
   left after step 1, the Medical expenses modeled for that year (every row in a
   Medical category, not only the ones marked HSA-qualified), and the amount
   your accounts would otherwise draw that year. It is never below zero.

The second step can only lower a draw that exists. The app has no place to put
surplus cash, so a year in which Social Security and pensions already cover
spending has nothing to lower, and the rest of the credit is dropped. When the
draw is smaller than the credit left, the line is that draw and the rest is
dropped too. The line is a separate column in the **Taxes & health costs** table
and a separate figure on the **Taxes** tab. The dollars are already part of the
ACA health credits shown there, so they are not added a second time.

The credit stops at the poverty line. A lower draw lowers income, and income
below 100% of the poverty line earns no credit, so a line that lowered the draw
past it would be one the household does not earn. Both engines therefore limit
the line the same way. The credit is worked out on the draw before the line, and
the draw may fall by at most the income that draw adds above the poverty line,
counted for each return that earns a credit and taking the narrowest. Only
withdrawals that count as income can pull income down: a qualified Roth or
savings withdrawal does not, so a household that draws only those is not
limited. Above the poverty line a lower draw only raises the credit, so a line
priced on the higher draw is never more than the household earns at the lower
one.

The stress test funds the whole IRMAA surcharge, where the projection funds only
the part not withheld from Social Security, so step 1 uses the whole surcharge
there. Both cap the line at the year's draw, which is the sum of the months in
which spending is above income, so a year with a few expensive months can carry
the whole line. Everything else is the same, and for the same flat household
whose credit does not move with the draw (qualified Roth withdrawals, say) the
two agree to the cent. When the credit does move with the draw, the projection
settles on the line the lowered draw earns, and the stress test keeps the line
priced on the draw before it, so the stress test's line is the smaller by a
little. Medical expenses are taken before any spending cut from the
downturn guardrail, because the premium is the amount you entered.

### Built-in figures and years

The 2026 poverty line, and the percentage of income you are expected to pay
(the applicable percentage) by band:

| Income as % of poverty line | Applicable percentage (2026) |
|---|---|
| 100% to 133% | 2.10% |
| 133% to 150% | 3.14% rising to 4.19% |
| 150% to 200% | 4.19% rising to 6.60% |
| 200% to 250% | 6.60% rising to 8.44% |
| 250% to 300% | 8.44% rising to 9.96% |
| 300% to 400% | 9.96% |
| Above 400% | no credit |

For 2026 the poverty line is $15,650 plus $5,500 for each person after the
first. Alaska uses $19,550 plus $6,880, and Hawaii $17,990 plus $6,330 (**Where
you live**). Each year's table uses the **previous** year's poverty
guidelines, so 2026 uses the 2025 ones.

The 2024 and 2025 tables use the same method with different figures: 0% up to
150% of the poverty line, then rising evenly to 2% at 200%, 4% at 250%, 6% at
300% and 8.5% at 400%, and a flat 8.5% above 400% with no cutoff.

The built-in tables cover **2024, 2025 and 2026**. A year before 2024 uses the
2024 table. For a year after 2026 the 2026 table is used, so the 400% cutoff
stays:

- ACA MAGI is divided by (1 + inflation) for each year past 2026 before it is
  compared with the 2026 poverty line and bands. With zero or negative
  inflation it is not scaled.
- The expected contribution is multiplied by the same factor afterwards.
- The benchmark premium is **not** scaled by general inflation. The rough
  estimate grows at the medical rate instead (step 6), and a premium you
  entered is used as entered.

The rough benchmark curve ($700 a month at age 60, +5% for each year of age) is
a 2026 price, a planning assumption and not a statutory figure. It stays at that
level in 2026 and earlier, and grows at the medical rate in later years. The
base amount and the base year (2026) move together when the curve is re-anchored.

### Simplified or left out

- **Months are counted as a number, not a calendar.** Two spouses covered in
  different parts of the year are credited the larger of their two counts.
- **Married filing separately** gets no credit, even though a few separated
  spouses can claim one in practice.
- **One calculation a year.** The credit is worked out once from that year's
  income. The app does not model advance payments or repayment at tax time.
- **A year with no draw cannot be lowered.** The credit is used against tax and
  the surcharge first, then against the year's Medical expenses, but only up to
  the draw. The app has no surplus deposit, so credit beyond a year's draw is
  dropped. In the real rules the credit is refundable and lowers the premium in
  full. A year in which Social Security and pensions already cover spending
  therefore shows slightly higher health costs than you would actually pay.
- **The credit is worked out for the withdrawals that fund the year.** The line
  is based on that funding calculation. The credit shown for the year can
  differ from it by a few dollars when a lot of the income comes from taxable
  brokerage accounts. A Roth conversion sized after the withdrawals are
  settled does not change the line.

**Code.** All paths are under `apps/web/src`. `lib/aca-ptc.ts` works out the
credit and holds the rough benchmark curve. `lib/aca-ptc-parameters.ts` has the
built-in bands and poverty lines. `lib/tax-integration.ts` runs it each year
and applies the year scaling. `lib/tax-integration-helpers.ts` has the covered
months and `resolveMemberHealthCoverage`. `lib/tax-cashflow-solver.ts` counts
the credit against the cash need. `lib/credit-applied-to-premiums.ts` holds the
one function that works out the line, called by both the projection
(`lib/tax-cashflow-solver.ts`) and the stress test (`lib/monte-carlo-tax.ts`).
`pages/scenario-tax-assumptions-sections.tsx` has the **Health coverage**
editor.

## Worked example

**Claiming ages.** Sam has a PIA of $2,000 a month and an FRA of 67.

| Claim age | Factor | Monthly benefit |
|---|---|---|
| 62 | 36 x 5/9% + 24 x 5/12% = 30% off, so 0.70 | $1,400 |
| 67 | 1.00 | $2,000 |
| 70 | 36 x 2/3% = 24% on top, so 1.24 | $2,480 |

**A spousal top-up.** Sam's spouse has a PIA of $800. Both claim at 62, with an
FRA of 67.

1. Own benefit: $800 x 0.70 = **$560** a month.
2. Top-up base: half of Sam's PIA is $1,000. Minus the spouse's own $800 is
   $200.
3. Reduced for claiming at 62: $200 x 0.65 = **$130** a month.
4. Total: $560 + $130 = **$690** a month, or $8,280 a year. Taking only "the
   larger of the two" would give $650 a month, or $7,800 a year.

**A Medicare surcharge.** A married couple files jointly. For 2026 their
look-back MAGI (2024) is $250,000. That is above $218,000 and not above
$274,000, so tier 1 applies: $81.20 for Part B and $14.50 for Part D each
month. One spouse has Part B for 6 months and Part D for 12.

- Part B: $81.20 x 12 x 6/12 = **$487.20**.
- Part D: $14.50 x 12 = **$174.00**.
- Surcharge for the year: **$661.20**.

**An ACA credit.** A person filing as single in 2026 has an ACA MAGI of
$31,300. That is exactly 200% of the $15,650 poverty line, so the 6.60% band
applies. Their benchmark plan costs $600 a month, $7,200 a year, for 12 months.

- Expected contribution: $31,300 x 6.60% = **$2,065.80**.
- Credit: $7,200 - $2,065.80 = **$5,134.20**.

**The same credit in a later year.** A person filing as single in 2028, born
in 1968, covered for 12 months, has an ACA MAGI of $33,854.08. General
inflation is 4% and no medical rate is set, so the medical rate is 6%.

- MAGI divided by 1.04 twice (1.0816) is $31,300, exactly 200% of the poverty
  line, so the 6.60% band applies. Expected contribution:
  $31,300 x 6.60% x 1.0816 = **$2,234.37**.
- Benchmark at age 60: $700 x 12 = $8,400 in 2026 prices, times 1.06 twice
  (1.1236) = **$9,438.24**.
- Credit: $9,438.24 - $2,234.37 = **$7,203.87**. Without the medical growth it
  would be $6,165.63.

**The credit lowering the draw.** Back to the 2026 credit of $5,134.20. This
person has $31,300 of Social Security, draws only from a Roth IRA, and spends
$64,000 on everything else plus the $7,200 premium entered as a medical expense.
Social Security is under the $25,000 base once halved, so none of it is taxed,
and federal tax is $0. The credit has nothing to offset in step 1.

- Draw before the credit: $64,000 + $7,200 - $31,300 = **$39,900**.
- Credit applied to premiums: the smallest of $5,134.20 (the credit left),
  $7,200 (Medical expenses) and $39,900 (the draw) = **$5,134.20**.
- Draw after the credit: $39,900 - $5,134.20 = **$34,765.80**.

With $26,800 of other spending the draw before the credit is only $2,700, so the
line is $2,700, the draw falls to $0, and $2,434.20 of the credit is dropped. If
Social Security covered all spending, the draw would be $0 and the whole credit
would be dropped.

If this person also had a $20,000 pension, $5,902.50 of Social Security would be
taxed and federal tax would be $980.25. Their ACA MAGI of $51,300 is 327.8% of
the poverty line, so the credit falls to $2,090.52. Step 1 uses $980.25 of it
against the tax, and the line is the $1,110.27 left.
