# How the math works: taxes

This page explains how RETIVO works out the federal income tax for each year of
a projection. It is for anyone with basic personal-finance knowledge. You do
not need to read code. It says what counts as income, how the return is
filled in, which built-in figures are used and for which years, and what the
app simplifies. It is an explanation of the model, not tax advice: the figures
are estimates built from what you entered, and the tax tables are a snapshot
that may be out of date. For where tax figures appear on screen, see the
[user guide](user-guide.md). For how the calculation engine fits into the app,
see [architecture.md](architecture.md).

The tax calculation runs for every year of retirement in the projection. Each
year goes through the same steps:

1. Sort the year's money into kinds of income.
2. Work out how much of your Social Security is taxable.
3. Subtract deductions.
4. Apply the ordinary tax brackets and the capital-gains rates.
5. Add the net investment income tax and any early-withdrawal penalties.

The pages on Social Security and health costs, retirement accounts, income and
expenses, withdrawals and projections explain the parts that feed into or read
from this one. This page names them where they meet.

## What counts as income

Not every dollar you withdraw is income. What a withdrawal adds to taxable
income depends on the account's **tax treatment**: pre-tax, Roth, mixed,
post-tax, or HSA. Most account types have one fixed treatment. A few let you
choose it when you set up the account, and then your choice decides how the
withdrawal is taxed.

| Tax treatment | What a withdrawal adds to taxable income |
|---|---|
| Pre-tax | All of it, as ordinary income. A **QCD** (qualified charitable distribution, a gift straight from an IRA to charity) is left out. |
| Roth | Nothing for money that comes out tax-free: your contributions, and earnings once the withdrawal qualifies (age 59½ and the five-year rule). Earnings taken out before then count as ordinary income. |
| Mixed (a pre-tax part and a post-tax part) | The pre-tax part as above. The other part follows the Roth row above for 401(k), 403(b), 457(b) and TSP accounts (tax-free once qualified; earnings taken out before then count as ordinary income), and is a post-tax withdrawal (below) for Other. |
| Post-tax, brokerage-like | Only the gain share, as long-term capital gains. The rest is a return of what you put in. |
| Post-tax, cash-type | Nothing. The interest these accounts earn is taxed each year as it is earned. |
| HSA (health savings account) | Nothing for your modeled medical costs. For an emergency draw, the share that was not medical counts as ordinary income. |

Which treatment an account gets:

- **Fixed.** Traditional IRA and cash-balance plan are always pre-tax. The Roth
  accounts (Roth IRA, Roth 401(k), Roth 403(b), Roth 457(b), Roth TSP) are
  always Roth. Brokerage is always post-tax and brokerage-like. Savings, Money
  Market and CD are always post-tax and cash-type. HSA is always HSA.
- **Your choice.** 401(k), 403(b) and 457(b) can be pre-tax or mixed. TSP can be
  pre-tax, post-tax or mixed. Other can be pre-tax, post-tax or mixed. A TSP
  set to post-tax, or an Other set to post-tax, is taxed as brokerage-like, on
  its gain share only. An Other set to pre-tax is taxed in full as ordinary
  income.

The early-withdrawal penalty is decided by the account type instead, not by the
treatment (see [Early-withdrawal penalties](#early-withdrawal-penalties)). An
Other account never carries the 10%, whichever treatment it has.

The retirement accounts page explains which Roth dollars come out first and
how the five-year clocks run.

Other income in each year:

- **Social Security.** Only the taxable part counts, and it counts as ordinary
  income. How much is taxable is in
  [Tax on Social Security](#tax-on-social-security).
- **Pensions and part-time or earned income.** All of it is ordinary income.
- **One-off income.** A one-off amount you send to a target account is treated
  as a deposit and is not taxed. A one-off with no target account is ordinary
  income.
- **Roth conversions.** A conversion is ordinary income in the year it is
  done. It is not a withdrawal, so it carries no early-withdrawal penalty.
- **Interest on cash-type accounts.** Each year's growth on a Savings, Money
  Market or CD account is ordinary interest in the year it is earned, whether
  or not you withdraw anything. A year with a loss adds no income.
- **Assumed income on brokerage-like accounts.** The app assumes these
  accounts pay taxable dividends and interest even if you sell nothing. See
  [What is simplified or left out](#what-is-simplified-or-left-out).

The app assumes no tax-exempt (municipal-bond) interest, so nothing is added
back for it anywhere on this page.

## Filing status and tax units

A **filing status** decides which bracket table, deduction and thresholds
apply. A **tax unit** is one tax return. Most households have one. A couple
who file apart have two.

With no saved filing choice:

- A one-person household files **Single**.
- A couple files **MFJ** (married filing jointly) while both are alive, then
  Single for the survivor. A spouse who dies still counts as alive for that
  whole year, so the joint return runs through the year of the death.
- **HoH** (head of household) is never chosen automatically, because the app
  does not track dependents.

The **Filing** tab under **Tax assumptions** on a scenario lets you set this
yourself. The user guide describes the tab. What it changes:

- **One person.** Files Single or head of household every year. You can add
  year-bounded windows that set a different status for some years.
- **A couple filing together.** Files MFJ through the year a spouse dies,
  then Single for the survivor. A year-bounded window can say **QSS**
  (qualifying surviving spouse) or head of household for some of those years.
- **A couple filing apart.** While both are alive, each spouse has their own
  return, MFS (married filing separately) unless that spouse qualifies as head
  of household. After a death the survivor follows the same rule as a joint
  couple.
- **You lived together at some point during the year.** This applies to
  separate returns. It changes two rules for a spouse filing as MFS: Social
  Security is taxed from the first dollar of income, and the Medicare
  surcharge uses the steeper separate-filer table.

How each status differs:

- **QSS** uses the MFJ bracket table, standard deduction, capital-gains bands
  and NIIT threshold. It counts as one person for the age add-on and the
  senior deduction, and it uses the Single Social Security thresholds.
- **MFS** has brackets that are half of the MFJ ones, its own capital-gains
  bands, and an NIIT threshold of $125,000. It gets no senior deduction.
- **HoH** has its own bracket table and standard deduction.

Who counts as 65 or older: anyone who reaches 65 by December 31 counts for the
whole year. Someone born on January 1 counts from the year before.

When a couple files apart, the whole calculation is run once for each return
and the results are added up. Each return gets:

- the withdrawals, interest and assumed yield of the accounts that spouse
  owns;
- that spouse's own Social Security benefit;
- an even share of everything else: pensions, part-time income, one-off
  income, Roth conversions and Roth earnings.

## How the tax is worked out

The same steps run for each return in each year.

1. **Add up ordinary income.** This is pre-tax withdrawals (less any QCD),
   pensions and other income, interest, the non-medical part of any HSA draw,
   conversions, early Roth earnings, and the taxable part of Social Security.
2. **Add up capital gains and qualified dividends.** These are the gain share
   of brokerage-like withdrawals plus the qualified-dividend part of the
   assumed yield. They are taxed at their own, lower rates.
3. **Take the deductions.** The deduction is the standard deduction, plus the
   age-65 add-on, plus the senior deduction.
4. **Find taxable income.** Total income minus the deductions, and not below
   zero. The deductions are used against ordinary income first. If any are
   left over, they lower the taxable gains.
5. **Tax the ordinary part with the brackets.** Only the dollars inside each
   bracket are taxed at that bracket's rate.
6. **Tax the gains on top.** The gains are stacked on top of ordinary income.
   Ordinary income uses up the 0% band first. Only gains that spill past it
   pay 15%, and 20% at the top. This is the step people most often get wrong:
   it is the total taxable income, not the gains alone, that decides the rate.
7. **Add the net investment income tax** (NIIT, below).
8. **Add early-withdrawal penalties** (below). The penalties are part of the
   year's federal tax total.

### Deductions

2026 standard deduction and age-65 add-on, by filing status:

| Filing status | Standard deduction (2026) | Age-65 add-on (2026) |
|---|---|---|
| Single | $16,100 | $2,050 |
| Head of household | $24,150 | $2,050 |
| Married filing jointly | $32,200 | $1,650 for each spouse 65 or older, up to two |
| Qualifying surviving spouse | $32,200 | $1,650, one |
| Married filing separately | $16,100 | $1,650, one |

The **senior deduction** comes from a 2025 law. It is a fixed rule for tax
years 2025 through 2028 only:

- $6,000 for each filer who is 65 or older. A joint return has at most two.
- It shrinks by 6% of the amount your income is over $75,000 ($150,000 on a
  joint return). The shrinking applies to each filer's $6,000 separately, so
  a Single filer loses all of it at $175,000, and a joint couple loses all of
  it at $250,000.
- Head of household and qualifying surviving spouse use the $75,000 limit.
  Married filing separately gets no senior deduction.
- It lowers taxable income, but not MAGI. The income test uses your income
  before the deduction, without any tax-exempt interest.
- It is never scaled for inflation.

### Ordinary brackets

2026 ordinary brackets. Each row is the taxable income at which the rate
starts.

| Rate | Single | MFJ and QSS | Head of household | MFS |
|---|---|---|---|---|
| 10% | $0 | $0 | $0 | $0 |
| 12% | $12,400 | $24,800 | $17,700 | $12,400 |
| 22% | $50,400 | $100,800 | $67,450 | $50,400 |
| 24% | $105,700 | $211,400 | $105,700 | $105,700 |
| 32% | $201,775 | $403,550 | $201,775 | $201,775 |
| 35% | $256,225 | $512,450 | $256,200 | $256,225 |
| 37% | $640,600 | $768,700 | $640,600 | $384,350 |

### Capital-gains rates

Long-term gains and qualified dividends pay 0%, 15% or 20% depending on total
taxable income, including the gains. The rates are a fixed rule. The 2026
amounts where the 15% and the 20% rates start:

| Filing status | 15% starts at (2026) | 20% starts at (2026) |
|---|---|---|
| Single | $49,450 | $545,500 |
| MFJ and QSS | $98,900 | $613,700 |
| Head of household | $66,200 | $579,600 |
| MFS | $49,450 | $306,850 |

### Net investment income tax

The **net investment income tax** (NIIT) is 3.8% of the smaller of two
amounts: your net investment income, and how far your income is over a
threshold. The rate and the thresholds are fixed rules, and the thresholds are
never indexed for inflation.

- Net investment income is capital gains and qualified dividends, plus the
  ordinary interest from the assumed brokerage yield and from cash-type
  accounts. IRA and pension withdrawals, Social Security and Roth money are
  not part of it.
- The income that is tested against the threshold is ordinary income, with
  the taxable part of Social Security, plus gains, before deductions.
- Thresholds: $200,000 for Single and head of household, $250,000 for MFJ and
  QSS, and $125,000 for MFS.

## Tax on Social Security

Social Security benefits are taxed in tiers that depend on **provisional
income**:

> provisional income = other income + tax-exempt interest + half of gross
> Social Security benefits

Other income is everything taxable except the benefits themselves: pre-tax
withdrawals (less any QCD), gains, interest, pensions and conversions. On
separate returns, each return uses its own spouse's benefit.

The base amounts are set by law and never indexed for inflation. They are a
fixed rule. The app stores them once, under 2024, and uses them for every
year.

| Filing status | No tax up to | Up to 50% taxable | Up to 85% taxable above |
|---|---|---|---|
| Single, HoH, QSS, MFS living apart | $25,000 | $25,000 to $34,000 | $34,000 |
| MFJ | $32,000 | $32,000 to $44,000 | $44,000 |
| MFS living together | $0 | none | $0 |

Inside each tier:

- **50% tier.** The taxable part is the smaller of half the benefit and half
  the amount over the lower base.
- **85% tier.** The taxable part is 85% of the amount over the upper base,
  plus the smaller of half the benefit and half the gap between the two bases
  ($4,500 for the non-joint bases, $6,000 for MFJ). It never goes above 85% of
  the benefit.

The taxable part is then added to ordinary income. The rest is not taxed.

## Early-withdrawal penalties

Two extra taxes apply to money taken out too early. Both are added to the
year's federal tax. The ages and rates are fixed rules.

| Account | Extra tax | Before | Applies to |
|---|---|---|---|
| 401(k), traditional IRA, 403(b), TSP, cash-balance plan | 10% | 59½ | The taxable part of the withdrawal |
| Roth 401(k), Roth 403(b), Roth TSP | 10% | 59½ | The earnings share of the withdrawal |
| Roth IRA | 10% | 59½ | Earnings, plus converted money taken out within five years of the conversion |
| 457(b), Roth 457(b) | None | n/a | n/a |
| HSA | 20% | 65 | The non-medical part of an emergency draw |
| Brokerage, Savings, Money Market, CD, Other | None | n/a | n/a |

How the penalty is applied:

- **The year you reach the age.** The penalty applies only to the months
  before the month you reach the age (59½, or 65 for an HSA). The fraction is
  (that month - 1) / 12. Someone who reaches 59½ in July is penalised on
  6/12 of that year's early withdrawals.
- **Inherited accounts** skip the 10% at any age.
- **Penalty exemptions.** On the **Penalty exemptions** tab you can mark
  accounts that skip the 10%. This is how a payment plan or another exception
  is expressed. The app does not check whether an account really qualifies.
  The income tax on the withdrawal still applies.
- **Conversions** are not penalised.
- **A missing birthdate** skips the penalty, because the app cannot tell the
  person's age.
- **HSA.** The **HSA** tab sets how much of an emergency HSA draw went to
  medical care. Only the rest is taxed and, before 65, penalised.

## The two income measures (MAGI)

**MAGI** (modified adjusted gross income) is the income figure that the health
cost rules read. RETIVO works out two of them each year.

- **Federal and Medicare MAGI** is ordinary income, plus capital gains, plus
  tax-exempt interest. It includes only the taxable part of Social Security.
- **ACA MAGI** is the same figure plus the untaxed part of Social Security.

A QCD lowers both. A Roth conversion raises both. The senior deduction lowers
neither.

What reads them:

- The Medicare surcharge (IRMAA) reads the federal MAGI from two years earlier.
- The ACA premium credit reads the ACA MAGI for the current year.
- The income-ceiling cap on withdrawals and conversions reads whichever of the
  two you pick for it. For a couple on two returns, the cap reads the sum of
  both returns' MAGI, while IRMAA reads each return's own MAGI.

The pages on Social Security and health costs and on withdrawals explain how
each rule uses it.

## Built-in figures and years

The built-in federal tables have a separate set of figures for 2024, 2025 and
2026. This page quotes 2026. The 2024 and 2025 tables follow the same rules
with their own figures.

| Figure | Built-in years | After 2026 |
|---|---|---|
| Ordinary bracket floors, standard deduction, age-65 add-on | 2024, 2025, 2026 | Scaled by inflation, see below |
| Capital-gains band floors | 2024, 2025, 2026 | Scaled by inflation |
| Ordinary bracket rates, the 0/15/20% rates | Fixed rule | Unchanged |
| Senior deduction ($6,000, $75,000, $150,000, 6%) | Fixed rule, 2025 to 2028 | Not scaled. Carried through 2028, dropped from 2029 |
| NIIT rate and thresholds | Fixed rule | Frozen, never indexed |
| Social Security base amounts | Fixed rule, stored under 2024 | Unchanged |
| Early-withdrawal ages and rates | Fixed rule | Unchanged |
| Assumed brokerage yield | Planning assumption, stored under 2026 | Unchanged |

For a year after 2026, the app builds a table from the 2026 one:

- Every figure marked "scaled" is multiplied by (1 + inflation) for each year
  past 2026.
- The inflation rate is the scenario's general inflation rate. The stress test
  uses the same fixed rate on every path. A path's own random inflation does
  not move the tax tables.
- With an inflation rate of zero or below, the figures are not scaled, though
  the rounding below still applies.
- Ordinary bracket floors round down to a multiple of $25 (Single and MFS) or
  $50 (MFJ, HoH and QSS). Capital-gains floors round down to a multiple of
  $50. Deductions, including the age-65 add-on, round to the nearest $50.

## What is simplified or left out

- **Federal income tax only.** There is no state or local tax, no alternative
  minimum tax, no itemized deductions, no qualified business income deduction
  and no payroll tax. No tax credit is modeled except the ACA premium credit.
- **No municipal-bond interest** is assumed.
- **Assumed income on brokerage-like accounts.** These are planning
  assumptions, not tax rules:
  - Brokerage and Other balances are assumed to yield 2% a year, set for 2026
    and used unchanged for later years. Half is qualified dividends and half
    is ordinary interest.
  - The yield is assumed reinvested, and each year's yield is added to the
    account's cost basis.
  - A withdrawal is taxed on its gain share. The share starts from the
    **Return of principal (taxable accounts)** setting on the **Advanced** tab
    of the withdrawal strategy card, 50% unless you change it. It is applied to
    the account's balance when the projection starts. After that, the app
    tracks a cost basis for each account year by year: it grows with deposits
    and the reinvested yield, and shrinks in proportion to each withdrawal. It
    is an estimate, not your purchase records.
- **Part of the tax shown is not paid from your balances.** The tax shown for
  each year includes the tax on the assumed yield and on cash-type interest.
  The projected balances do not subtract that part.
- **Penalty exceptions** such as disability are not checked. You mark them
  yourself.

Edge cases that change a number:

- A member with no usable birthdate gets no early-withdrawal penalty. No
  screen warns about this.
- A saved filing choice that cannot be matched to the household (for example a
  **Single** setting saved before a spouse was added) is not guessed. While the
  choice is unresolved, a couple is filed as **MFJ** (Single for the survivor
  after a death). If an older saved filing status exists, that status is used
  instead. The **Filing** tab asks you to choose in either case.
- A qualifying surviving spouse window longer than two tax years shows a
  warning but is still used.
- The stress test does not apply the 20% HSA tax. It also attributes only
  Social Security to each spouse on separate returns, and splits everything
  else evenly.

## Worked example

Pat is 67 and files Single for 2026. Pat takes $24,000 of Social Security and
$50,000 from a traditional IRA. Pat also sells $40,000 of brokerage holdings,
half of which is gain, so $20,000 of long-term gains. To keep the numbers
round, the example leaves out the assumed yield and any interest.

1. **Taxable Social Security.** Other income is $50,000 + $20,000 = $70,000.
   Provisional income is $70,000 + half of $24,000 = $82,000. That is above
   $34,000, so the 85% tier applies. 85% of ($82,000 - $34,000) is $40,800.
   Add the smaller of half the benefit ($12,000) and half the $9,000 gap
   between the bases ($4,500), which is $4,500. The sum is $45,300. The cap is
   85% of $24,000 = $20,400, so **$20,400** of the benefit is taxable.
2. **Income.** Ordinary income is $50,000 + $20,400 = $70,400. Gains are
   $20,000. Total income is $90,400. The federal MAGI is $90,400. The ACA MAGI
   adds the untaxed $3,600 of Social Security: $94,000.
3. **Deductions.** The standard deduction is $16,100 and the age-65 add-on is
   $2,050. For the senior deduction, income is $15,400 over $75,000. 6% of
   that is $924, so the deduction is $6,000 - $924 = $5,076. The total
   deduction is $16,100 + $2,050 + $5,076 = $23,226.
4. **Taxable income.** $90,400 - $23,226 = $67,174. The $20,000 of gains stay
   whole, so taxable ordinary income is $47,174.
5. **Ordinary tax.** 10% of the first $12,400 is $1,240.00. 12% of the next
   $34,774 ($47,174 - $12,400) is $4,172.88. The ordinary tax is
   **$5,412.88**.
6. **Tax on gains.** The gains sit on top of the $47,174, so they cover taxable
   income from $47,174 to $67,174. The 0% band for Single in 2026 ends at
   $49,450. The first $2,276 of gains pay 0%. The other $17,724 pay 15%, which
   is **$2,658.60**.
7. **NIIT.** Income of $90,400 is below the $200,000 threshold, so the tax is
   $0.
8. **Penalties.** Pat is past 59½, so there are none.

The federal tax for the year is $5,412.88 + $2,658.60 = **$8,071.48**.

## Where the code lives

All paths are under `apps/web/src`.

- `lib/federal-tax.ts`: deductions, ordinary brackets, capital-gains
  stacking and NIIT.
- `lib/federal-tax-config.ts`: the built-in 2024, 2025 and 2026 tables.
- `lib/federal-tax-extrapolation.ts`: carrying the tables past 2026.
- `lib/tax-integration.ts`: the yearly assembly (income by kind, Social
  Security, both MAGI figures, penalties, and one run per tax unit).
- `lib/tax-integration-helpers.ts`: the inflation scaling factor, the MAGI
  sum and the split of the assumed yield.
- `lib/ss-taxation.ts` and `lib/ss-taxation-thresholds.ts`: tax on Social
  Security and its base amounts.
- `lib/early-withdrawal-penalty.ts`: the 10% and 20% penalties.
- `lib/roth-distribution-tax.ts`: which Roth dollars are taxed and penalised.
- `lib/filing-status.ts`: filing status and tax units.
- `lib/assumed-taxable-yield-config.ts`: the assumed brokerage yield.
- `lib/balance-projection-runner-tax.ts` and
  `lib/balance-projection-runner-tax-helpers.ts`: how the standard projection
  sorts withdrawals by account type and tracks cost basis.
- `lib/monte-carlo-tax.ts`: the same for the stress test.
- `pages/scenario-tax-assumptions-sections.tsx`: the **Filing**, **HSA** and
  **Penalty exemptions** tabs.
