/**
 * The share view: the only way plan data becomes something a tool may say.
 *
 * Given the workspace aggregates and a session's sharing choices it yields one
 * entry per category that is switched on and names the categories that are not
 * in `withheld`, so a tool can tell the agent what it is not seeing. The switches
 * govern what is sent, not what the engine computes with: tools run over the
 * whole workspace and put only this view into a response.
 *
 * Rows are built field by field from `classification.ts`. Aggregate ids pass as
 * opaque references; envelope metadata (`householdId`, `deviceId`, versions,
 * timestamps) is never read.
 */
import type { Aggregate } from '../../db/types';
import {
  ACCOUNT_CLASSIFICATION,
  BALANCE_CLASSIFICATION,
  EXPENSE_CATEGORY_CLASSIFICATION,
  EXPENSE_CLASSIFICATION,
  INCOME_CLASSIFICATION,
  MEMBER_CLASSIFICATION,
  SCENARIO_CLASSIFICATION,
  SOCIAL_SECURITY_CLASSIFICATION,
} from './classification';
import { isOpaqueId, projectPayload, type ProjectionContext } from './project';
import { roundingDescriptor, type RoundingDescriptor } from './rounding';
import { buildMasker, sanitizeLabel } from './sanitize';
import { scrubValue } from './scrub';
import { withheldSwitches, type SharingChoices, type SharingSwitchId } from './switches';

type Row = Record<string, unknown> & { id: string };

/**
 * The aggregate lists a tool reads (`listAggregates` output); a category list left out reads as empty.
 * `households` and `members` are required whatever the tool answers: they are where the terms a view
 * must never say (emails, last names, the household name) come from, so a view built without them
 * would mask nothing and the final scrub would have nothing to catch. Pass the workspace's full lists.
 */
export interface ShareSource {
  /** Read only to mask the household name, which is commonly the family surname. Never emitted. */
  households: readonly Aggregate[];
  /** Every member of the workspace, even for a tool that answers about something else. */
  members: readonly Aggregate[];
  accounts?: readonly Aggregate[];
  balances?: readonly Aggregate[];
  socialSecurity?: readonly Aggregate[];
  scenarios?: readonly Aggregate[];
  expenseCategories?: readonly Aggregate[];
  expenses?: readonly Aggregate[];
  incomeStreams?: readonly Aggregate[];
}

export interface ShareViewOptions {
  /** The clock for ages. */
  now: Date;
}

interface ShareViewMember extends Row {
  /** A first name, or `Primary` / `Secondary` when first names are off. */
  name: string;
  isPrimary: boolean;
  birthdate?: string;
  /** Whole years on `options.now`. */
  age?: number;
}

export interface ShareView {
  members?: ShareViewMember[];
  accounts?: Row[];
  balances?: Row[];
  income?: Row[];
  expenses?: { categories: Row[]; items: Row[] };
  socialSecurity?: Row[];
  scenarios?: Row[];
  /** The sharing switches that are off, in screen order. */
  withheld: SharingSwitchId[];
  /** How dollar figures in this view are rounded. */
  rounding: RoundingDescriptor;
}

const PRIMARY_LABEL = 'Primary';
const SECONDARY_LABEL = 'Secondary';

function payloadOf(aggregate: Aggregate): unknown {
  return aggregate.payload;
}

function stringField(aggregate: Aggregate, key: string): string {
  const value = (payloadOf(aggregate) as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Everything a tool must never say, as literal terms: each member's email and last name, the
 * household name, and each first name while the person chose role labels.
 */
export function maskTermsFor(source: ShareSource, choices: SharingChoices): string[] {
  const terms: string[] = [];
  for (const member of source.members) {
    terms.push(stringField(member, 'email'), stringField(member, 'lastName'));
    if (!choices.firstNames) terms.push(stringField(member, 'firstName'));
  }
  for (const household of source.households) terms.push(stringField(household, 'name'));
  return terms;
}

/** Whole years between an ISO birth date and `now`; `undefined` for a date that is not one. */
function ageOn(birthdate: unknown, now: Date): number | undefined {
  if (typeof birthdate !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthdate);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  let age = now.getUTCFullYear() - year;
  const beforeBirthday = now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age <= 150 ? age : undefined;
}

function rowsOf(
  aggregates: readonly Aggregate[] | undefined,
  fields: Parameters<typeof projectPayload>[1],
  context: ProjectionContext,
): Row[] {
  const rows: Row[] = [];
  for (const aggregate of aggregates ?? []) {
    if (aggregate.deletedAt !== undefined || !isOpaqueId(aggregate.id)) continue;
    rows.push({ id: aggregate.id, ...projectPayload(payloadOf(aggregate), fields, context) });
  }
  return rows;
}

function memberRows(
  members: readonly Aggregate[],
  context: ProjectionContext,
  now: Date,
): ShareViewMember[] {
  const rows: ShareViewMember[] = [];
  for (const member of members) {
    if (member.deletedAt !== undefined || !isOpaqueId(member.id)) continue;
    const fields = projectPayload(payloadOf(member), MEMBER_CLASSIFICATION, context);
    const isPrimary = fields.isPrimary === true;
    const role = isPrimary ? PRIMARY_LABEL : SECONDARY_LABEL;
    const firstName = context.choices.firstNames ? sanitizeLabel(stringField(member, 'firstName'), context.masker) : '';
    const age = ageOn(fields.birthdate, now);
    rows.push({
      id: member.id,
      name: firstName === '' ? role : firstName,
      isPrimary,
      ...(typeof fields.birthdate === 'string' && { birthdate: fields.birthdate }),
      ...(age !== undefined && { age }),
    });
  }
  // The primary member first, so "the household" reads the same on every call.
  return rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

export function buildShareView(source: ShareSource, choices: SharingChoices, options: ShareViewOptions): ShareView {
  // Fail closed for a caller that slipped past the type: without these lists nothing would be masked.
  if (!Array.isArray(source.members) || !Array.isArray(source.households)) {
    throw new TypeError('A share view needs the workspace members and households to know what it must never say.');
  }
  const masker = buildMasker(maskTermsFor(source, choices));
  const context: ProjectionContext = { choices, masker };
  const view: ShareView = {
    withheld: withheldSwitches(choices),
    rounding: roundingDescriptor(choices.exactDollars),
  };
  if (choices.members) view.members = memberRows(source.members, context, options.now);
  if (choices.accounts) view.accounts = rowsOf(source.accounts, ACCOUNT_CLASSIFICATION, context);
  if (choices.balances) view.balances = rowsOf(source.balances, BALANCE_CLASSIFICATION, context);
  if (choices.income) view.income = rowsOf(source.incomeStreams, INCOME_CLASSIFICATION, context);
  if (choices.expenses) {
    view.expenses = {
      categories: rowsOf(source.expenseCategories, EXPENSE_CATEGORY_CLASSIFICATION, context),
      items: rowsOf(source.expenses, EXPENSE_CLASSIFICATION, context),
    };
  }
  if (choices.socialSecurity) view.socialSecurity = rowsOf(source.socialSecurity, SOCIAL_SECURITY_CLASSIFICATION, context);
  if (choices.scenarios) view.scenarios = rowsOf(source.scenarios, SCENARIO_CLASSIFICATION, context);
  // Defense in depth: the allowlist is the mechanism, this catches a map or sanitizer that missed something.
  // First names are left to the sanitizers: an aggregate id may legitimately contain one.
  // `withheld` and `rounding` are generated, not stored, so they are not scrubbed: a short name must not garble them.
  const scrubMasker = buildMasker(maskTermsFor(source, { ...choices, firstNames: true }));
  const { withheld, rounding, ...data } = view;
  return { withheld, rounding, ...(scrubValue(data, scrubMasker) as Omit<ShareView, 'withheld' | 'rounding'>) };
}
