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
    date: '2026-10-04',
    kind: 'new',
    title: 'RETIVO is open source',
    blurb:
      'The source code is now public on GitHub, where you can see how RETIVO ' +
      'works and report an issue.',
  },
];
