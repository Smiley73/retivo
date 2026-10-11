# Yearly tax refresh

The app ships built-in tax and benefit tables. Some of them change every year
when an agency publishes new figures. This page says what to update, in what
order, and which checks to run. It also lists the checked-answer (oracle)
fixtures that prove the engines against primary sources.

The tables are plain TypeScript constants. Nothing is fetched at run time.
There is no scraper and no link checker. You read the new publication and
edit the files by hand.

## What gets refreshed

Each table is a `CalibrationSnapshot<T>` from
[calibration.ts](../apps/web/src/lib/calibration.ts). It has a `values` map
keyed by year and one `metadata` block: `source`, `asOfDate` and
`jurisdiction` (always `US-federal` today). All files are in
[apps/web/src/lib/](../apps/web/src/lib/).

| Constant | File | Years | Source |
|---|---|---|---|
| `FEDERAL_TAX_CONFIG` | `federal-tax-config.ts` | 2024, 2025, 2026 | IRS Rev. Proc. each Oct–Nov, plus the 2025 law for the standard deduction and senior deduction |
| `IRMAA_TIERS` | `irmaa-tiers.ts` | 2024, 2025, 2026 | CMS Medicare Part B premium fact sheet each Nov |
| `ACA_PTC_PARAMETERS` | `aca-ptc-parameters.ts` | 2024, 2025, 2026 | IRS Rev. Proc. applicable-percentage table, plus HHS poverty guidelines each Jan |
| `SSA_EARNINGS_TEST` | `ss-earnings-test.ts` | 2024, 2025, 2026 | SSA cost-of-living notice each Oct |
| `QCD_LIMITS` | `qcd-limits.ts` | 2024, 2025, 2026 | IRS Pub. 590-B, which indexes the limit each year |
| `RMD_DIVISORS` | `rmd-divisors.ts` | one entry, under 2024 | IRS Pub. 590-B Table III |
| `RMD_UNIFORM_LIFETIME_TABLE_III` | `rmd-life-expectancy-tables.ts` | the same object as `RMD_DIVISORS` | IRS Pub. 590-B |
| `RMD_SINGLE_LIFE_TABLE_I` | `rmd-life-expectancy-tables.ts` | one entry | IRS Pub. 590-B Table I |
| `RMD_JOINT_LIFE_TABLE_II` | `rmd-life-expectancy-tables.ts` | one entry | IRS Pub. 590-B Table II |
| `SS_TAX_THRESHOLDS` | `ss-taxation-thresholds.ts` | one entry, under 2024 | 26 U.S.C. §86(c) |
| `DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG` | `assumed-taxable-yield-config.ts` | one entry, under 2026 | A planning assumption |

Three groups:

- **Follow an agency cycle.** The first five rows. Refresh them when the
  agency publishes: IRS Rev. Proc. in October or November, CMS in November,
  the SSA cost-of-living notice in October, HHS poverty guidelines in January.
  The QCD limit changes when the IRS publishes the next indexed amount. The ACA applicable percentages come from a Rev. Proc. published in the summer
  (the 2026 one in August 2025). Each ACA year uses the **previous** year's HHS
  poverty guidelines, so the 2026 table holds the 2025 poverty line.
- **Fixed by statute or by the IRS table.** The rest of the federal figures that
  law fixes stay as they are: the Social Security tax thresholds, the net
  investment income tax thresholds inside `FEDERAL_TAX_CONFIG`, and the senior
  deduction's size and phase-out. The three RMD tables change only when Treasury
  revises them. They are in effect since 2022. Leave these alone unless the law
  or the table changes.
- **A planning assumption, not a refresh.** The assumed taxable yield (2% a
  year, half qualified dividends, none tax-exempt) is a modelling choice, set
  centrally. It is not a scenario or household input. Change it only when you
  decide to change the assumption.

Engines never read these constants directly. A run resolves them once and passes
them through. `DEFAULT_TAX_CALIBRATION_BUNDLE` in
[tax-integration-helpers.ts](../apps/web/src/lib/tax-integration-helpers.ts)
pins six of them for a run: federal tax, Social Security tax, IRMAA, ACA, the
RMD divisors and the assumed yield. The QCD limit and the earnings test are
read by their own code.

A snapshot covers one jurisdiction. No state tables ship today. If one is added,
make it a separate constant. Figures that law fixes are still stored by year, so
a later change to them needs no new shape.

## The steps

1. Find the new publication and check its figures against the old year.
2. Add the new year to each affected constant. Add a new key under `values`.
   Keep the old years. The engines still look them up.
3. Update `metadata.source` and `metadata.asOfDate`. A snapshot has one of each,
   even when it spans several years. `source` is a comma-separated list of the
   citations, one per year, and `asOfDate` is the latest publication date.
4. **Composite sources.** `ACA_PTC_PARAMETERS` bundles figures from two agencies
   for one lookup: the IRS applicable percentages and the HHS poverty
   guidelines. List all the URLs in `source` in the order they were published,
   mixing the two agencies. `asOfDate` is the latest of them.
   `aca-ptc-parameters.test.ts` checks the order. Do not bundle tables that do
   not belong to one lookup. Use two constants.
5. In `federal-tax.ts`, extend the `TaxYear` union when you add a federal year.
6. Run the tests below and fix every pin on purpose. Each failing pin is a
   figure you changed, so read the failure before you edit the test.
7. Read the engine-version and What's New section below.

For the federal tables, fill in all five filing statuses (see
[Filing statuses](#filing-statuses)). The married-filing-separately ordinary
brackets and standard deduction are half the joint figures by statute. The
separate-return net investment income threshold is its own fixed $125,000. The
separate-return 15%-to-20% capital-gains breakpoint is published on its own, so
read it from the Rev. Proc. and do not halve the joint one.

## Tests and years

These tests pin the values, so a refresh breaks them until you update them:

| Test | What it pins |
|---|---|
| `federal-tax-config.test.ts` | The year list, the shape of every table, the senior-deduction bases and some 2026 figures |
| `irmaa-tiers.test.ts` | The year list and spot-check thresholds |
| `aca-ptc-parameters.test.ts` | The year list, every band and poverty figure, the source order, and the exact `asOfDate` |
| `qcd-limits.test.ts` | The year list, the limits and the exact `asOfDate` |
| `ss-earnings-test.test.ts` | The published amounts and the exact `asOfDate` |
| `rmd-divisors.test.ts` | The source links and the divisors and life-expectancy tables |
| `ss-taxation-thresholds.test.ts` | The statutory thresholds |
| `federal-tax-extrapolation.test.ts` | How a year past the newest table is built |

The assumed yield has no table test of its own. The `basis.json` oracle case
pins its 2% and 50%.

**Years past the newest built-in year.** What a later year uses depends on the
table. Some figures scale by inflation, some carry forward unchanged, and some
flag the year as an estimate. Each math page describes its own, in a "Built-in
figures and years" section:

- [Taxes](math-taxes.md#built-in-figures-and-years)
- [Social Security, Medicare surcharges and ACA credits](math-social-security-and-health.md)
  (one section under "The earnings test", "Medicare surcharges (IRMAA)" and
  "ACA premium credits")
- [Retirement accounts](math-retirement-accounts.md#built-in-figures-and-years)
- [Withdrawals](math-withdrawals.md#built-in-figures-and-years)
- [Projections](math-projections.md#built-in-figures-and-years)
- [Income, expenses and returns](math-income-expenses-and-returns.md#built-in-figures-and-years)

Adding a year changes what the later years use, because they now follow the new
newest table. Expect `integrated-30-year.json` to need new expected values (see
the fixtures below).

## Filing statuses

The married-filing-separately (MFS) and qualifying-surviving-spouse (QSS)
tables are **live**. `FEDERAL_TAX_CONFIG` holds all five statuses (`Single`,
`MFJ`, `HoH`, `MFS`, `QSS`). A scenario's filing plan can select them, and the
oracle fixture `mfs.json` runs through that production path. Refresh them every
year with the other three. QSS reuses the joint tables.
[Filing status and tax units](math-taxes.md#filing-status-and-tax-units)
explains how the app picks a status.

## Engine version and What's New

**Monte Carlo output.** A refresh that changes any figure a projected year
reads changes Monte Carlo results. The six pinned tables travel inside the run's
input as `taxContext.taxBundle`, and the run uses them for every path. They are
also part of `mcCacheKey`, so an old cached result is not served after a value
changes. The change still goes through the "ENGINE_VERSION bump — required
companion edits" section of [AGENTS.md](../AGENTS.md). It sets what to do: a
bump only when output changes for some input, the amendment entry, and the
re-captured parity fixture. The byte-identical parity fixtures decide whether a
bump is due.

A change to `metadata` alone does not change any result. It changes the cache
key, so a plan recomputes once. No bump.

**What's New.** The same section says to add a release-notes entry only when the
numeric change is visible to users. A refresh that moves projected taxes, credits
or limits is. Add a newest-first entry to
[release-notes.ts](../apps/web/src/lib/release-notes.ts). A metadata-only fix
needs none.

## The checked-answer fixtures

[`__fixtures__/retirement-oracle/`](../apps/web/src/lib/__fixtures__/retirement-oracle/)
holds ten JSON files. `retirement-oracle.test.ts` runs them against the real
engine entry points. They check the tax, benefit and distribution rules against
primary sources, not against the engine's own earlier output.

Each file lists its `sources` with a publication date and an accessed date. Each
case has a step-by-step `derivation`, its `inputs`, the `expected` values and a
`tolerance`.

**Independence rule.** An expected value comes from the primary source, worked
by hand in the fixture. It never comes from engine output. The test rebuilds
each rule from the fixture's own `statutory` figures, never from the production
formulas or tables. It first proves that this independent formula reproduces the
expected value. Only then does it compare with the engine.

**Tolerance.**

- **exact** for table lookups, threshold and status selection, month counts,
  RMD divisors and distribution order.
- **$1** for currency worked from exact inputs after the documented rounding.
- **$50** for parts that are approximate on purpose. Direction and assumptions
  are checked separately.

| File | What it checks | Main sources | Tolerance |
|---|---|---|---|
| `individual.json` | The 2026 senior-deduction phase-out (4 cases), the Social Security tax tiers (4), and the Social Security earnings test (4) | IRS senior-deduction page, the IRS 2026 inflation notice (Rev. Proc. 2025-32), 26 U.S.C. §86, SSA earnings-test amounts, POMS RS 02501.030, SSA retirement-age chart | $1; tiers and earnings test exact |
| `integrated-30-year.json` | A single retiree over 30 years, 2026 to 2055, with an $80,000 IRA draw and $24,000 of Social Security: federal tax, taxable Social Security, MAGI, RMD and IRMAA each year | the IRS 2026 inflation notice, the senior-deduction page, 26 U.S.C. §86(c), Pub. 590-B Table III, CMS 2026 fact sheet | $1 a year per field; tier labels exact |
| `survivor.json` | Social Security dual entitlement and survivor limits (3 cases) | POMS RS 00615.020, RS 00615.101 and .201, RS 00615.320 | Method C exact; currency $1 |
| `mfs.json` | Married filing separately (6 cases): brackets at half the joint ones, no senior deduction, zero Social Security base when living together, IRMAA for both living arrangements, no premium credit | Rev. Proc. 2025-32 Table 4, §86(c)(1)(C), CMS 2026 fact sheet, IRS premium credit Q&A | Lookups and status exact; currency $1 |
| `aca-medicare.json` | The 2026 premium credit (8 cases): the 200% and 400% edges, the cliff above 400%, a mid-band percentage, two kinds of MAGI, the rough benchmark, and month-aware IRMAA | Rev. Proc. 2025-25, HHS 2025 poverty guidelines, the 2020 Form 8962 instructions, §36B, §86, CMS 2026 fact sheet, POMS HI 01101.031 | Credit $1; band and cliff exact; benchmark $50; IRMAA exact |
| `roth.json` | Roth distribution order for an IRA (3 cases) and designated-Roth pro-rata splits (3) | Pub. 590-B, the IRS designated-Roth FAQ, §72(t) | Exact |
| `rmd.json` | The Pub. 590-B worked example, divisor lookups, the age 73 and 75 trigger ages, the still-working exception, the April 1 deferral and an inherited 10-year window (6 cases) | Pub. 590-B, the IRS RMD FAQ, SECURE 2.0 §107 | Divisors and rules exact; the worked example $1 |
| `blocker.json` | Results that must be withheld, with the missing inputs listed, never guessed (4 cases) | Pub. 590-B beneficiary rules, the IRS RMD FAQ, 42 U.S.C. §402(e) and (f) | Exact |
| `basis.json` | Bank interest as ordinary income and the assumed-yield split (2 cases) | IRS Topic 403, §1411, the IRS 2026 inflation notice, the assumed-yield assumption | $1; direction checked separately |
| `market-stress.json` | The monthly fee shift, the composition of the stress shocks, a 30-year fee-drag case and the longevity cap (4 cases) | SEC investor bulletins on fees and on performance claims; the stress sizes are a product choice | Shift, composition and horizon exact; 30-year currency $1 |

**Refresh triggers.**

1. **An agency publishes its yearly update.** The cycles are the ones above.
   Check every fixture that cites that agency. Update the values, the
   publication date and the accessed date together. A fixture pins one tax year,
   mostly 2026. Adding a later year to the built-in tables does not change it,
   but a correction to the pinned year does. `integrated-30-year.json` is the
   exception, because its later years follow the newest table.
2. **A law changes a rule a fixture cites.** The senior deduction's end after
   2028 is already coded.
3. **An engine change legitimately moves an expected value.** Re-derive the
   fixture from the primary source in the same PR. Never copy the engine's
   output into the fixture.

**Known-divergence records in `aca-medicare.json`.** Two cases pin a place where
the engine knowingly differs from the form. Each has the correct answer in
`expected` (or `expectedCorrect`) and today's engine output in
`expectedCurrentEngine`. The test checks both.

- A household at 177.5% of the poverty line. The form rounds down to a whole
  percent and gives 5.49%. The engine interpolates the raw percentage and gives
  5.52%, which is $8.34 a year less credit.
- A household at 400.5% of the poverty line. The form makes it ineligible. The
  engine rounds to 400% before the cliff check and keeps a credit of $957.25.

If the engine is fixed, the pin fails on purpose. Then turn the record into a
normal agreement case, with the expected value still from the form.

### Assumed taxable yield

`basis.json` cites this section for the assumed-yield figures. The table is
`DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG`. It holds `totalYieldPct` (0.02),
`qualifiedDividendFraction` (0.5) and `taxExemptMunicipalFraction` (0), under
2026. It has no authoritative source. It is a round figure near a diversified
total-market portfolio's dividend yield plus a modest interest part, and it
is not a statute or an agency number. No agency publishes a refresh for it. The
fixture treats it as a stated assumption. If you change the assumption, update
`asOfDate`, the `basis.json` source note and the expected values in its two
cases, and treat it as a numeric change for the engine-version section.

### Market-stress fixture

`market-stress.json` cites this section for its repo-designed case.
`fee-drag-30-year-shortfall` is not taken from any publication. Its parameters
were chosen here: $100,000 for 360 months at a 0.85% monthly gross return, with
and without a 0.50% annual cost, so it lines up with the portfolio and month in
the two exact cases. Only the principle comes from the SEC bulletin, which is
that a fee reduces the return and the shortfall compounds. The stress sizes are
a product choice, not an agency figure. They do not follow a yearly cycle. Change
them only when the product decision changes.

## Related

[historical-data/REFRESH.md](../apps/web/src/lib/historical-data/REFRESH.md) is
the separate refresh for the historical return and inflation series.
