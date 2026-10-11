# Product

## Register

product

## Users

Self-directed (DIY) retirement planners. The primary user models their own
household: account balances, contributions, Social Security timing, and
multi-year projections. They are financially motivated but not necessarily
financially fluent — the audience reaches beyond power users to everyday people
who are uncomfortable with the underlying tax-and-benefit math but still want a
real answer.

Their context: planning sessions at a desk, often comparing scenarios
("what if I retire at 62 vs 67?", "what does this do to my IRMAA bracket?"),
returning over weeks as inputs change. Local-first: their data lives in the
browser (IndexedDB) and syncs to the cloud zero-knowledge. The job to be done is
**make a confident, well-modeled retirement decision without hiring a planner.**

## Name

**RETIVO** — Retirement Exploration Through Inputs, Variables & Outcomes.
Tagline: *Model your retirement. See the possibilities.* In running text the name
is written "Retivo"; the all-caps form is the wordmark.

## Product Purpose

A local-first retirement planning tool that runs *real* modeling —
federal tax, IRMAA, RMDs, ACA subsidies, Social Security bend-points, Monte
Carlo success probability — rather than a back-of-napkin growth curve. It exists
so a careful individual can do the work a paid professional would, on their own
data, privately.

Success looks like: a user trusts the numbers enough to act on them, can see
*why* a scenario wins or loses (not just that it does), and never has to leave
to a spreadsheet to check the tool's work. The tool earns trust through accuracy
and legibility, not persuasion. The Social Security claim-age comparison reflects this: its
ranking assumes a single fixed death age as a documented modeling assumption
rather than presenting the ranking as unconditional.

It is explicitly **not** financial advice (see the README disclaimer), and the
modeling deliberately stops short of full CFP complexity — no multi-regime
planning, dependent-tracking, or planner-defensibility machinery.

## Brand Personality

**Precise. Quiet. Trustworthy.** A well-made financial instrument: numbers come
first, chrome stays out of the way, and the interface projects expert confidence
without showing off. Voice is plain and direct — it explains the hard concepts
(IRMAA, RMD, Modified-Dietz) in layman's terms on first use, but never dumbs the
*modeling* down to get there. Reassuring through clarity, not cheerleading.

The visual identity is the bespoke **Graphite Spectrum** system: cool
graphite neutrals, a single pine money-green accent used as a fill, five type-coded
account-bucket hues (iris/violet/cyan/amber/teal), and JetBrains Mono for tabular
numerals. Light, dark, and system themes are first-class.

## Anti-references

- **Generic SaaS dashboard** — stock indigo-on-slate, hero-metric cards,
  endless identical icon+heading+text card grids. The "could be any B2B app" look.
- **Salesy fintech / robo-advisor** — persuasive nudges, gamified confetti,
  "you're on track!" cheerleading that hides or sugarcoats the real numbers.
- **Spreadsheet / legacy finance** — undifferentiated gray grids, no hierarchy,
  an intimidating wall of figures with Excel-grade visual design.
- **Consumer-cute / playful** — mascots, pastel illustrations, emoji, jokey copy.
  Too informal for money decisions.

## Design Principles

- **Numbers first.** The data is the interface. Chrome, ornament, and motion
  recede so the figures and their relationships are what the eye lands on.
- **Earn trust through legibility, not persuasion.** Show *why*, not just *what*.
  Never hide, round away, or cheerlead over an inconvenient number. When the
  model has to assume a figure the user didn't supply — e.g. estimating the
  first retirement year's Medicare (IRMAA) surcharge from the projected
  first-year income because no two-years-prior income was provided — disclose
  the estimate and its basis in plain English rather than silently defaulting.
- **Plain language, real math.** Translate the jargon (IRMAA, RMD, bend-points)
  into plain English at first use; never simplify the model behind it to match.
  Expert-grade modeling with a non-expert-readable surface.
- **Scannable structure.** Account types are distinguishable at a glance (hue +
  label, never hue alone); hierarchy and rhythm do the work a dense grid can't.
- **Quiet confidence.** The bespoke Graphite Spectrum identity carries the brand;
  resist the reflex toward generic dashboard scaffolding and decorative effects.

## Accessibility & Inclusion

- **WCAG 2.2 AA is locked and non-negotiable.** Every UI and chart
  color pair is proven against its contrast threshold in both light and dark
  themes (`lib/contrast.ts`, `contrast.test.ts`).
- **Never rely on color alone.** The five account-bucket hues always pair with a
  text label so the encoding survives color blindness and grayscale.
- **`prefers-reduced-motion` is respected** for theme transitions and any added
  motion; reduced-motion needs a real alternative, not a removed one.
- **React Aria primitive-first** for every interactive control —
  keyboard, focus, and screen-reader semantics come from the primitive layer.
- Light / dark / system themes, resolved with no flash of incorrect theme.
