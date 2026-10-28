// Source for the in-app "What's New" page, rendered newest-first in array order (no runtime sort; `release-notes.test.ts` enforces it).
// Every user-facing PR prepends an entry with the ship date.

export type ReleaseNoteKind = 'new' | 'improved' | 'fixed';

export interface ReleaseNote {
  readonly date: string;
  readonly kind: ReleaseNoteKind;
  readonly title: string;
  readonly blurb: string;
}

/** Newest-first; new entries are prepended at ship time. */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    date: '2026-10-28',
    kind: 'improved',
    title: 'The assistant stays silent on projections when a part of your plan is switched off',
    blurb:
      'A projection, stress test, comparison, explanation or what-if depends on your members, accounts, ' +
      'balances, income, expenses and Social Security together, so a figure cannot be traced to one of them. ' +
      'When any of those six sharing switches is off, the assistant now gets no figure from those tools, ' +
      'only a note naming what is switched off. Comparing or explaining a scenario other than the base one ' +
      'also needs the Scenarios switch.',
  },
  {
    date: '2026-10-28',
    kind: 'fixed',
    title: 'Devices and sign-in history show the address you connected from',
    blurb:
      'The Devices list and your sign-in history now record the address you connected from ' +
      'rather than Amazon\'s edge network, so they show where each sign-in came from. ' +
      'Devices you already remembered keep the address they were recorded with.',
  },
  {
    date: '2026-10-28',
    kind: 'improved',
    title: 'Remembered devices are forgotten when your password changes',
    blurb:
      'Changing your password, or finishing a password reset, now also forgets every device ' +
      'you had asked to remember, so each one asks for your second factor the next time you ' +
      'sign in. Also, on an account with a passkey, the emailed code no longer offers to ' +
      'remember a device.',
  },
  {
    date: '2026-10-27',
    kind: 'improved',
    title: 'Each authenticator code now works only once',
    blurb:
      'If you sign in with an authenticator code and then confirm a sensitive action within ' +
      'the same half-minute, the same code is reported as wrong. Wait for the next code from ' +
      'your app and enter that. Each code works once, at sign-in or for a sensitive action, ' +
      'so a code someone else sees cannot be used again.',
  },
  {
    date: '2026-10-21',
    kind: 'new',
    title: 'Add Medicare premiums to your expenses in one step',
    blurb:
      'The Expenses page has an Add Medicare premiums action. It previews a Part B and ' +
      'a Part D premium for each person, with the current Medicare amounts you can edit, ' +
      'and adds them as monthly Medical expenses from age 65. Medigap, Medicare Advantage ' +
      'and your actual drug-plan price stay yours to enter.',
  },
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
    title: 'Projections now flag years when Medicaid may apply',
    blurb:
      'When a year with a Marketplace plan has income at or below 138% of the ' +
      'federal poverty line, a note under the charts says Medicaid may cover ' +
      'you instead, depending on your state. Retivo still does not model ' +
      'states or Medicaid, and no projected number changes.',
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
    title: 'Your Marketplace credit now lowers your withdrawals',
    blurb:
      'When the ACA premium credit is larger than your tax and Medicare surcharge, ' +
      'the extra now lowers that year\u2019s withdrawals, up to the Medical expenses ' +
      'you entered and what you would otherwise withdraw, instead of disappearing. ' +
      'It shows as Credit applied to premiums on the Taxes tab, in the yearly ' +
      'table and on the Cash flow tab. Projections and stress tests change when you update.',
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
