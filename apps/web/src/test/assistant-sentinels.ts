/**
 * Plants recognisable strings into a demo workspace so the assistant tool tests can
 * serialize a result and ask, for each string, whether it is there. Never-shareable
 * strings must be absent whatever the switches say; each category string must be
 * present only while the switches that govern it are on. Asserting on the
 * serialized text is what makes a field added later, and left unclassified, fail.
 */
import {
  KEY_CACHE_ID,
  listAggregates,
  putAggregate,
  writeDeviceMetadata,
  writeKeyCacheEntry,
} from '../db/store';
import type { Aggregate, AggregateType } from '../db/types';
import { loadDemoData } from '../lib/demo-data-loader';
import { ANALYSIS_REQUIRED_SWITCH_IDS, type SharingSwitchId } from '../assistant/sharing/switches';

export const HOUSEHOLD_ID_SENTINEL = 'zz-household-id-sentinel';
export const SCENARIO_SENTINEL_ID = 'zq-scenario-sentinel';

/** Strings no switch may release. Compared case-insensitively. */
export const NEVER_SHAREABLE: Readonly<Record<string, string>> = {
  lastName: 'Zzlastname',
  email: 'zz.sentinel@leak.example',
  householdName: 'Zzhousehold Family',
  deviceId: 'zz-device-sentinel',
  householdId: HOUSEHOLD_ID_SENTINEL,
  keyCache: 'zz-key-cache-sentinel',
};

export interface CategorySentinel {
  token: string;
  /** Every switch that must be on for the token to appear. */
  requires: readonly SharingSwitchId[];
  /** Tools whose result carries the field the token sits in, under the demo workspace. */
  tools: readonly string[];
  /** Switches a tool needs on beyond `requires`, because the tool as a whole is gated by them. */
  toolRequires?: Readonly<Record<string, readonly SharingSwitchId[]>>;
}

const PLAN = 'retivo_get_plan_data';
const SCENARIO = 'retivo_get_scenario';
const LIST = 'retivo_list_scenarios';
const COMPARE = 'retivo_compare_scenarios';
const EXPLAIN = 'retivo_explain';
const WHAT_IF = 'retivo_run_what_if';

/** Every category the analysis tools draw on: a tool that computes answers nothing while one of these is off. */
const ANALYSIS = ANALYSIS_REQUIRED_SWITCH_IDS;

export const CATEGORY_SENTINELS: readonly CategorySentinel[] = [
  { token: 'Zqprimaryfirst', requires: ['members', 'firstNames'], tools: [PLAN] },
  { token: 'Zqsecondfirst', requires: ['members', 'firstNames'], tools: [PLAN] },
  // The what-if tool names its base scenario, so it answers only while the scenarios switch is on, and it computes.
  { token: 'Zqacctname', requires: ['accounts'], tools: [PLAN, WHAT_IF], toolRequires: { [WHAT_IF]: [...ANALYSIS, 'scenarios'] } },
  { token: 'Zqinstitution', requires: ['accounts'], tools: [PLAN] },
  { token: 'Zqacctnote', requires: ['accounts', 'notes'], tools: [PLAN] },
  { token: 'Zqbalcomment', requires: ['balances', 'notes'], tools: [PLAN] },
  { token: 'Zqincname', requires: ['income'], tools: [PLAN] },
  { token: 'Zqincnote', requires: ['income', 'notes'], tools: [PLAN] },
  { token: 'Zqexpname', requires: ['expenses'], tools: [PLAN] },
  { token: 'Zqexpdesc', requires: ['expenses', 'notes'], tools: [PLAN] },
  { token: 'Zqcatname', requires: ['expenses'], tools: [PLAN] },
  { token: 'Zqssnote', requires: ['socialSecurity', 'notes'], tools: [PLAN] },
  { token: 'Zqscnname', requires: ['scenarios'], tools: [PLAN, LIST, SCENARIO, COMPARE, EXPLAIN, WHAT_IF],
    toolRequires: { [COMPARE]: ANALYSIS, [EXPLAIN]: ANALYSIS, [WHAT_IF]: ANALYSIS } },
  { token: 'Zqscndesc', requires: ['scenarios', 'notes'], tools: [PLAN, LIST, SCENARIO] },
  { token: 'Zqscnnote', requires: ['scenarios', 'notes'], tools: [PLAN, SCENARIO] },
  // Names inside the rows a scenario adds follow the scenarios switch and their own category's.
  { token: 'Zqovrexp', requires: ['scenarios', 'expenses'], tools: [PLAN, SCENARIO, COMPARE, EXPLAIN], toolRequires: { [COMPARE]: ANALYSIS, [EXPLAIN]: ANALYSIS } },
  { token: 'Zqovrinc', requires: ['scenarios', 'income'], tools: [PLAN, SCENARIO, COMPARE, EXPLAIN], toolRequires: { [COMPARE]: ANALYSIS, [EXPLAIN]: ANALYSIS } },
];

async function rewrite(
  type: AggregateType,
  change: (aggregate: Aggregate, index: number) => Record<string, unknown>,
): Promise<void> {
  const all = await listAggregates(type);
  let index = 0;
  for (const aggregate of all) {
    await putAggregate(type, {
      ...aggregate,
      deviceId: NEVER_SHAREABLE.deviceId!,
      payload: { ...aggregate.payload, ...change(aggregate, index) },
    });
    index += 1;
  }
}

/** Loads the demo workspace under the sentinel household and plants every string above. */
export async function seedSentinelWorkspace(): Promise<void> {
  await loadDemoData({ householdId: HOUSEHOLD_ID_SENTINEL, email: NEVER_SHAREABLE.email!, displayName: 'Demo', todayYear: 2026 });
  await rewrite('householdMember', (member) => ({
    firstName: member.payload.isPrimary === true ? 'Zqprimaryfirst' : 'Zqsecondfirst',
    lastName: NEVER_SHAREABLE.lastName,
    email: NEVER_SHAREABLE.email,
  }));
  await rewrite('account', () => ({ name: 'Zqacctname', institution: 'Zqinstitution', notes: 'Zqacctnote' }));
  await rewrite('accountBalance', () => ({ comment: 'Zqbalcomment' }));
  await rewrite('incomeStream', () => ({ name: 'Zqincname', notes: 'Zqincnote' }));
  await rewrite('expense', () => ({ name: 'Zqexpname', description: 'Zqexpdesc' }));
  await rewrite('expenseCategory', () => ({ name: 'Zqcatname' }));
  await rewrite('socialSecurityBenefit', () => ({ notes: 'Zqssnote' }));
  const [base] = (await listAggregates('scenario')).filter((scenario) => scenario.payload.isPrimary === true);
  await putAggregate('scenario', {
    id: SCENARIO_SENTINEL_ID,
    householdId: HOUSEHOLD_ID_SENTINEL,
    aggregateType: 'scenario',
    schemaVersion: base?.schemaVersion ?? 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: NEVER_SHAREABLE.deviceId!,
    payload: {
      name: 'Zqscnname',
      description: 'Zqscndesc',
      parentScenarioId: base?.id ?? null,
      isPrimary: false,
      notes: 'Zqscnnote',
      overrides: {
        expenses: {
          added: [
            {
              _localId: 'zq-added-expense',
              name: 'Zqovrexp',
              amount: 1499,
              frequency: 'monthly',
              classification: 'discretionary',
              categoryId: 'cat-1',
              start: { kind: 'year', year: 2030 },
            },
          ],
        },
        income: {
          added: [{ _localId: 'zq-added-income', name: 'Zqovrinc', kind: 'partTime', memberId: 'demo-member-primary', annualAmount: 1500 }],
        },
        accountReturns: { perAccount: { 'demo-account-john-401k': { planningReturnPct: 5.25 } } },
      },
    },
  });
  await putAggregate('household', {
    id: 'zz-household',
    householdId: HOUSEHOLD_ID_SENTINEL,
    aggregateType: 'household',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: NEVER_SHAREABLE.deviceId!,
    payload: { name: NEVER_SHAREABLE.householdName, currency: 'USD', createdAt: '2026-01-01T00:00:00Z' },
  });
  await writeDeviceMetadata({
    deviceId: NEVER_SHAREABLE.deviceId!,
    syncCursor: '0',
    lastSyncedAt: '2026-06-14T08:30:00.000Z',
    displayName: NEVER_SHAREABLE.deviceId!,
  });
  await writeKeyCacheEntry({
    id: KEY_CACHE_ID,
    householdId: NEVER_SHAREABLE.keyCache!,
    hdkExported: new TextEncoder().encode(NEVER_SHAREABLE.keyCache).buffer as ArrayBuffer,
  });
}
