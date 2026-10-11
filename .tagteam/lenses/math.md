# Lens: math

Does the projection/simulation engine compute what it claims to, for every
input it will actually see?

Scope: `balance-projection-runner*`, the Monte Carlo engine and its workers,
Roth-conversion math, RMD calculation, tax-integration/withdrawal-guidance
math, claim-age optimization, and anything else feeding the numbers a person
is shown about their retirement. Not chart formatting, currency display
helpers, or other UI-only numeric code — those are not this lens.

Look for: an operation applied in the wrong order (compounding growth before a
fee or withdrawal that should reduce the base first, tax computed before a
deduction that should lower it, inflation applied to the wrong side of a
comparison); a formula that matches the common case but not a boundary one
(zero balance, negative growth, a single remaining year, an empty account
list, a plan that starts or ends mid-year); a rounding mode inconsistent with
the rest of the engine or applied more than once to the same figure, so error
compounds instead of cancelling; a floating-point comparison or accumulation
where cents matter across a multi-decade projection; a Monte Carlo
implementation where the random draws, correlation structure, or percentile
aggregation silently assumes a shape the input does not have (a single-path
"simulation," a success-rate calculation that miscounts a boundary path); an
iterative or converging calculation (Roth-conversion optimization,
claim-age search) with no termination guarantee, or one that terminates on the
wrong condition or a local optimum it never checks; units mixed within one
expression (annual rate against a monthly period, real vs. nominal dollars,
dollars against basis points).

Show the input that breaks it and what the formula returns instead of what it
should. A formula that is merely unclear to read is not a finding on its own;
one that returns the wrong number for a real input — including a boundary one
this app's users will actually hit (retiring mid-year, a zero-balance account,
a single-year plan) — is.

Not yours: whether the formula is the one the governing rule actually requires
— that is the financial lens; general code correctness unrelated to a
numerical result; UI-only numeric/formatting code outside the projection
engine.
