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
    kind: 'improved',
    title: 'Projections now flag years when Medicaid may apply',
    blurb:
      'When a year with a Marketplace plan has income at or below 138% of the ' +
      'federal poverty line, a note under the charts says Medicaid may cover ' +
      'you instead, depending on your state. Retivo still does not model ' +
      'states or Medicaid, and no projected number changes.',
  },
  {
    date: '2026-10-20',
    kind: 'improved',
    title: 'Your Marketplace credit now lowers your withdrawals',
    blurb:
      'When the ACA premium credit is larger than your tax and Medicare surcharge, ' +
      'the extra now lowers that year\u2019s withdrawals, up to the Medical expenses ' +
      'you entered and what you would otherwise withdraw, instead of disappearing. ' +
      'It shows as Credit applied to premiums on the Taxes tab and in the yearly ' +
      'table. Projections and stress tests change when you update.',
  },
  {
    date: '2026-10-20',
    kind: 'improved',
    title: 'Estimated Marketplace plan price now grows with medical inflation',
    blurb:
      'When you have not entered a benchmark plan price, the estimate now grows ' +
      'every year after 2026 at your scenario\u2019s medical inflation rate, so ' +
      'later-year health insurance subsidies are no longer overstated or understated. ' +
      'A price you enter is still used exactly as entered.',
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
