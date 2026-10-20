/**
 * The consent switches: one registry that the dialog renders and the share view
 * reads. Every sharing switch means "share this", is ON by default, and
 * describes its OFF state, so nobody inverts a sentence. Order here is the
 * order on screen.
 *
 * `keepSignedInWhileActive` is not a sharing switch: it changes a security
 * control, not what is shared, so it sits in its own "Session" group, is OFF by
 * default and never reaches the share view.
 */
import { keepSignedInDescription, KEEP_SIGNED_IN_LABEL } from './sentences';

export const SHARING_SWITCH_IDS = [
  'members',
  'accounts',
  'balances',
  'income',
  'expenses',
  'socialSecurity',
  'scenarios',
  'notes',
  'exactDollars',
  'firstNames',
] as const;
export type SharingSwitchId = (typeof SHARING_SWITCH_IDS)[number];

/** The data categories among the sharing switches; the other two change how data reads. */
export type SharingCategoryId = Exclude<SharingSwitchId, 'exactDollars' | 'firstNames'>;

export type SharingChoices = Record<SharingSwitchId, boolean>;

export const KEEP_SIGNED_IN_ID = 'keepSignedInWhileActive';
type ConsentSwitchId = SharingSwitchId | typeof KEEP_SIGNED_IN_ID;
type SwitchGroup = 'sharing' | 'session';

export interface SwitchDefinition<Id extends ConsentSwitchId = ConsentSwitchId> {
  id: Id;
  label: string;
  group: SwitchGroup;
  defaultOn: boolean;
  /** What the switch covers and what OFF does, as the dialog shows it under the switch. */
  describe(context: { idleMinutes: number | null }): string;
  /** What OFF does, as a sentence on its own, for the rows that say what was withheld. */
  offDescription: string;
}

function sharing(id: SharingSwitchId, label: string, covers: string, off: string): SwitchDefinition<SharingSwitchId> {
  return { id, label, group: 'sharing', defaultOn: true, offDescription: off, describe: () => `${covers} Off: ${off}` };
}

/** Sharing switches first, in screen order, then the session switch. */
export const CONSENT_SWITCHES: readonly SwitchDefinition[] = [
  sharing(
    'members',
    'Household members',
    'Birth dates, wherever they are recorded, ages and which member is the primary one.',
    'the assistant sees no household members.',
  ),
  sharing(
    'accounts',
    'Accounts',
    'Account names, institutions, types, tax treatment, owners, return and contribution settings, and required-distribution and Roth details, except birth dates, which follow Household members.',
    'the assistant sees no accounts.',
  ),
  sharing('balances', 'Account balances', 'The balance and activity recorded for each account, year by year.', 'the assistant sees no balances.'),
  sharing('income', 'Income', 'Pensions, part-time work and one-time income.', 'the assistant sees no income.'),
  sharing('expenses', 'Expenses', 'Expenses and their categories.', 'the assistant sees no expenses.'),
  sharing('socialSecurity', 'Social Security', 'Each member’s benefit estimate.', 'the assistant sees no Social Security details.'),
  sharing(
    'scenarios',
    'Scenarios',
    'Scenario names, how they relate, and the changes each one makes.',
    'the assistant sees no scenarios.',
  ),
  sharing(
    'notes',
    'Notes and descriptions',
    'The free text you wrote on accounts, balances, expenses, income, Social Security and scenarios.',
    'the assistant sees the rows but none of the text you wrote on them.',
  ),
  sharing(
    'exactDollars',
    'Exact dollar figures',
    'Dollar amounts exactly as you entered them.',
    'every dollar figure is rounded to the nearest $1,000. Percentages, years and ages are not rounded.',
  ),
  sharing(
    'firstNames',
    'First names',
    'Members appear by first name.',
    'members appear as Primary and Secondary instead.',
  ),
  {
    id: KEEP_SIGNED_IN_ID,
    label: KEEP_SIGNED_IN_LABEL,
    group: 'session',
    defaultOn: false,
    offDescription: 'assistant activity does not keep you signed in.',
    describe: ({ idleMinutes }) => keepSignedInDescription(idleMinutes),
  },
];

export const SHARING_SWITCHES: readonly SwitchDefinition<SharingSwitchId>[] = CONSENT_SWITCHES.filter(
  (definition): definition is SwitchDefinition<SharingSwitchId> => definition.group === 'sharing',
);

export function defaultSharingChoices(): SharingChoices {
  const choices = {} as SharingChoices;
  for (const definition of SHARING_SWITCHES) choices[definition.id] = definition.defaultOn;
  return choices;
}

/** The switches that are off, in screen order: what a response names as withheld. */
export function withheldSwitches(choices: SharingChoices): SharingSwitchId[] {
  return SHARING_SWITCH_IDS.filter((id) => !choices[id]);
}
