# Lens: financial

Does this apply the rule — IRS, SSA, Medicare, or standard planning practice —
that actually governs the year and situation it's computing for?

Look for: a contribution, withdrawal, deduction, or credit limit (401(k)/403(b),
IRA, catch-up, HSA, QCD) that is hardcoded, stale, or missing its inflation
adjustment for the tax year it applies to; a rule read from the wrong tax year
(a January calculation using last year's bracket or limit, an RMD using the
wrong Uniform Lifetime / Joint Life / Single Life divisor table for the
beneficiary situation); a threshold applied with the wrong boundary (`>` where
the rule says `>=`, an age check off by the wrong birthday convention); a
filing-status, account-type, or age branch the rule actually has (MFJ vs.
single brackets, Roth vs. traditional treatment, pre- vs. post-SECURE 2.0 RMD
age) that the code collapses into one path; a fee, tax, or rate applied to the
wrong base (gross where the rule says net, pre-tax where it says post-tax); an
ACA subsidy or IRMAA threshold read against the wrong household size or MAGI
definition; double-counting or dropping an amount when it moves between two
records meant to net to the same total; a sign error that turns a withdrawal
into a contribution or a debit into a credit; a date-boundary mistake in a rule
keyed to calendar year, tax year, or age (birthday-year effects, December 31
cutoffs, five-year Roth clocks).

Also watch for a plan that's technically legal but a competent CFP would flag
as a bad default: a withdrawal sequence that draws down tax-advantaged
accounts before taxable ones for no stated reason, a Roth conversion
recommendation that ignores IRMAA/ACA cliff effects it should be aware of, a
safe-withdrawal-rate or guardrail default with no basis in the standard
literature, an emergency-fund or asset-location assumption at odds with common
planning practice. Flag these as findings, but be explicit that they are
practice/default judgment calls, not IRS-rule violations — say which is which.

Cite the rule the code should be following, not just that the number looks
off — a citation to the actual limit, bracket, divisor table, or IRS/SSA
provision (or, for a practice-based finding, the planning principle) is what
turns "this seems wrong" into a finding. A rule that will need updating next
year is not a finding; a rule read wrong for the year it claims to apply to is.

Not yours: the arithmetic and numerical precision of a formula once the right
rule and inputs are chosen — that is the math lens; whether storing or
transmitting the data is secure — that is security.
