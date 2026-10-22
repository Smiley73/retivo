/**
 * Source of truth for the in-app "What's New" page.
 *
 * A typed, compile-time list of user-facing changes in plain language,
 * maintained AND rendered **newest-first** — the array order is the display
 * order. The page does NOT runtime-sort: ordering correctness is
 * load-bearing in this array and enforced solely by `release-notes.test.ts`
 * (non-increasing dates, ties allowed; valid `kind`; non-empty fields;
 * parseable ISO). A manual prepend that breaks the order fails that test
 * instead of being silently masked by a client sort.
 *
 * `kind` drives a small New / Improved / Fixed badge on the page (tone map in
 * `WhatsNewPage.tsx`). `date` is an ISO `YYYY-MM-DD` string rendered
 * via the shared `formatDate` helper.
 *
 * Maintained by hand: every user-facing PR adds an entry here (PR-template
 * checkbox) with the ship date. Non-user-facing PRs skip it (N/A).
 */

export type ReleaseNoteKind = 'new' | 'improved' | 'fixed';

export interface ReleaseNote {
  /** ISO `YYYY-MM-DD` release date (stamped at ship time for new entries). */
  readonly date: string;
  /** Change category → New / Improved / Fixed badge. */
  readonly kind: ReleaseNoteKind;
  /** Short headline in plain language. */
  readonly title: string;
  /** One-sentence description of what changed for the user. */
  readonly blurb: string;
}

/** The full changelog, newest-first. New entries are prepended at ship time. */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    date: '2026-10-21',
    kind: 'new',
    title: 'Save a Roth conversion plan to a scenario',
    blurb:
      'Each ranked plan in the Roth conversion comparison now has a "Save plan to scenario" ' +
      'button. It writes the plan as one income cap window per year on the scenario\'s Withdrawal ' +
      'strategy, with the fixed dollar ceilings the comparison used, and says what it replaces ' +
      'first. The card then shows which plan you saved and the date, and marks it out of date ' +
      'when your data changes; that marker stays on this device only.',
  },
  {
    date: '2026-10-21',
    kind: 'improved',
    title: 'See why each year of a Roth conversion plan converts what it does',
    blurb:
      'Each plan in the Roth conversion comparison now has a "Why each year" button that opens a ' +
      'year-by-year table: the amount converted, the limit that stopped it, the figures that give ' +
      'the amount, and what the year cost in income tax, taxable Social Security, the Medicare ' +
      'surcharge and the health-insurance premium credit. A year that a Medicare surcharge or ' +
      'premium-credit line stopped also shows what crossing it would have cost.',
  },
  {
    date: '2026-10-20',
    kind: 'improved',
    title: 'Claim-age comparison understands months',
    blurb:
      'If a scenario\'s Social Security claim age includes months, such as 66 ' +
      'years 4 months, the comparison now ranks that exact age next to the ' +
      'whole years, shows it as your current result, and says "Already set" ' +
      'when it comes out on top. Save to scenario now tells you when your ' +
      'stored months are being replaced, and keeps the months of a member it ' +
      'does not change. The page also states that it compares a fixed set of ' +
      'options at one assumed death age and is not advice.',
  },
  {
    date: '2026-10-20',
    kind: 'new',
    title: 'Compare Roth conversion plans on the Roth conversion comparison page',
    blurb:
      'A new panel tries filling the 12%, 22%, 24% and 32% brackets each year before required ' +
      'withdrawals begin, with and without staying under the Medicare surcharge and ' +
      'health-insurance premium credit lines, and lists each next to your current plan by ' +
      'after-tax ending balance. It shows what each plan does in the model, not which one to pick, ' +
      'and you can cancel a run at any time.',
  },
  {
    date: '2026-10-20',
    kind: 'new',
    title: 'Compare two scenarios on Projections',
    blurb:
      'A new Compare tab sets the scenario you are viewing beside another one, ' +
      'showing the ending balance at the end of each plan and the year money ' +
      'runs out, with the difference between them, a Plan success row, and a ' +
      'Drivers table of lifetime tax, Roth conversion, withdrawal and other ' +
      'totals. Scenario cards also have a Compare with parent link that opens ' +
      'the comparison against the scenario they came from.',
  },
  {
    date: '2026-10-20',
    kind: 'new',
    title: 'Your AI assistant can try a what-if without saving it (beta)',
    blurb:
      'A connected assistant can now show how a change, such as retiring earlier or claiming ' +
      'Social Security later, would turn out next to your scenario. The what-if is not saved: ' +
      'it never appears on the Scenarios page, and you create the real scenario yourself.',
  },
  {
    date: '2026-10-20',
    kind: 'new',
    title: 'Your AI assistant can run the projection and the stress test (beta)',
    blurb:
      'A connected assistant can now read the Balance Projection numbers, the stress test, ' +
      'a comparison of two scenarios and where a headline number comes from. It still cannot ' +
      'change anything, and a stress test it runs is not saved or shown on the page.',
  },
  {
    date: '2026-10-20',
    kind: 'new',
    title: 'Ask an AI assistant about your plan (beta)',
    blurb:
      'Where your copy offers it, you can connect an AI assistant such as Claude Code ' +
      'or Codex that runs on your computer: it reads only what you allow, shows ' +
      'every request in an activity list, and cannot change anything.',
  },
  {
    date: '2026-10-04',
    kind: 'new',
    title: 'RETIVO is open source',
    blurb:
      'The source code is now public on GitHub, where you can see how RETIVO ' +
      'works and report an issue.',
  },
];
