/**
 * Aggregate sync round-trip harness.
 *
 * Proves a changed aggregate shape survives the full local-first loop:
 *
 *   serialize → push (encrypt) → pull (decrypt) → fresh IndexedDB store
 *   rehydration → read back
 *
 * without losing fields OR inventing a stored default when a sparse-optional
 * field is ABSENT. The push side encrypts through the real
 * `encryptPayload`/`decryptPayload` path so the JSON
 * serialize/deserialize boundary the wire crosses is exercised, and the pulled
 * payload is written into a freshly-cleared store to model a fresh tab picking
 * the row up from bootstrap.
 *
 * It covers the scenario `taxFilingPlan` filing plan (including the `separate`
 * plan's §86(c)(1)(C)(ii) `livedTogether` flag — pinned both explicitly `true`
 * and ABSENT, since absent is the meaningful sparse default (lived apart)),
 * the per-member survivor claim-age override
 * (`overrides.socialSecurity.survivor`), the per-account Roth
 * distribution-tax facts and RMD profile facts on `AccountPayload`, and the
 * scenario per-member/year health coverage months
 * (`overrides.healthCoverageMonths`) + FPL region (`overrides.acaFplRegion`).
 * A new field extends `roundTripAggregate` with its own case.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateHdk } from '../crypto/key-wrapping';
import { encryptPayload, decryptPayload } from '../crypto/payload-crypto';
import type { AadMetadata } from '../crypto/encryption-types';
import { clearAllStores, listAggregates, putAggregate } from './store';
import { currentSchemaVersion } from './migrations';
import type {
  Aggregate,
  AggregateType,
  ScenarioPayload,
  AccountPayload,
  AccountBalancePayload,
  HealthCoverageMonthsOverride,
  MemberCoverageMonths,
} from './types';

const HH = 'hh-roundtrip';

/**
 * Run one serialize → push (encrypt) → pull (decrypt) → fresh-store → read-back
 * cycle for an aggregate and return the rehydrated row. The store is cleared
 * before the pulled row is applied, so the read comes from a store that never
 * saw the original in-memory object — a fresh-tab rehydration.
 */
async function roundTripAggregate<T extends Record<string, unknown>>(
  type: AggregateType,
  aggregate: Aggregate<T>,
): Promise<Aggregate<T>> {
  const hdk = await generateHdk();
  const meta: AadMetadata = {
    householdId: aggregate.householdId,
    aggregateId: aggregate.id,
    aggregateType: type,
    encryptionVersion: 1,
  };

  // Push side: encrypt the payload (JSON-serializes it under the hood).
  const envelope = await encryptPayload(aggregate.payload, meta, hdk, 'key-roundtrip');

  // Pull side: decrypt the envelope a fresh device would receive.
  const pulledPayload = (await decryptPayload(envelope, meta, hdk)) as T;

  // Fresh-store rehydration: clear the store, then apply the pulled row.
  await clearAllStores();
  await putAggregate(type, { ...aggregate, payload: pulledPayload });

  const rows = (await listAggregates(type)) as Aggregate<T>[];
  const found = rows.find((r) => r.id === aggregate.id);
  if (!found) throw new Error(`round-trip lost aggregate ${aggregate.id}`);
  return found;
}

function scenarioRow(
  id: string,
  overrides: ScenarioPayload['overrides'],
): Aggregate<ScenarioPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-07-18T00:00:00Z',
    deviceId: 'dev-roundtrip',
    payload: {
      name: 'Round-trip',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides,
    },
  };
}

describe('aggregate sync round trip — scenario taxFilingPlan', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
  });

  it('preserves a seeded joint filing plan through push/pull and a fresh store', async () => {
    const row = scenarioRow('sc-joint', { taxFilingPlan: { kind: 'joint' } });
    const out = await roundTripAggregate('scenario', row);
    expect(out.payload.overrides.taxFilingPlan).toEqual({ kind: 'joint' });
  });

  it('preserves a separate filing plan with per-unit status, household size, and lived-together', async () => {
    // `livedTogether: true` is the §86(c)(1)(C)(ii) fact that removes an
    // MFS unit's Social Security base amounts and moves IRMAA to the steeper
    // separate-filer table, so losing it in transit is a silent tax CUT. Pinned
    // explicitly set to true here; the sibling case below pins its ABSENCE.
    const row = scenarioRow('sc-separate', {
      taxFilingPlan: {
        kind: 'separate',
        livedTogether: true,
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'MFS', householdSize: 2 },
        ],
      },
    });
    const out = await roundTripAggregate('scenario', row);
    expect(out.payload.overrides.taxFilingPlan).toEqual({
      kind: 'separate',
      livedTogether: true,
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 2 },
      ],
    });
  });

  it('does not invent livedTogether when the stored plan omits it', async () => {
    // Sparse-optional contract: ABSENT means the spouses lived apart, the
    // lower-tax reading. A round trip must not materialize it as `false` (a dead
    // key on every synced device) nor as `true`.
    const row = scenarioRow('sc-separate-apart', {
      taxFilingPlan: {
        kind: 'separate',
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
        ],
      },
    });
    const out = await roundTripAggregate('scenario', row);
    const plan = out.payload.overrides.taxFilingPlan;
    expect(plan && 'livedTogether' in plan).toBe(false);
  });

  it('preserves year-bounded QSS/HoH exception windows', async () => {
    const row = scenarioRow('sc-windows', {
      taxFilingPlan: {
        kind: 'joint',
        statusWindows: [
          { status: 'QSS', start: { kind: 'year', year: 2031 }, end: { kind: 'year', year: 2033 } },
          {
            status: 'HoH',
            start: { kind: 'age', memberId: 'primary', years: 60, months: 0 },
            end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
          },
        ],
      },
    });
    const out = await roundTripAggregate('scenario', row);
    expect(out.payload.overrides.taxFilingPlan).toEqual(row.payload.overrides.taxFilingPlan);
  });

  it('does NOT invent a taxFilingPlan when the field is absent (sparse-optional absence survives)', async () => {
    const row = scenarioRow('sc-absent', {});
    const out = await roundTripAggregate('scenario', row);
    expect('taxFilingPlan' in out.payload.overrides).toBe(false);
    expect(out.payload.overrides.taxFilingPlan).toBeUndefined();
  });
});

describe('aggregate sync round trip — scenario survivor claim-age override', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
  });

  it('preserves per-member survivor claim ages through push/pull and a fresh store', async () => {
    const row = scenarioRow('sc-survivor', {
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 65, ageMonths: 0 },
        survivor: {
          primary: { ageYears: 62, ageMonths: 0 },
          secondary: { ageYears: 60, ageMonths: 6 },
        },
      },
    });
    const out = await roundTripAggregate('scenario', row);
    expect(out.payload.overrides.socialSecurity?.survivor).toEqual({
      primary: { ageYears: 62, ageMonths: 0 },
      secondary: { ageYears: 60, ageMonths: 6 },
    });
  });

  it('preserves a one-member-sparse survivor section (only the set member survives)', async () => {
    const row = scenarioRow('sc-survivor-sparse', {
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        survivor: { secondary: { ageYears: 64, ageMonths: 0 } },
      },
    });
    const out = await roundTripAggregate('scenario', row);
    const survivor = out.payload.overrides.socialSecurity?.survivor;
    expect(survivor?.secondary).toEqual({ ageYears: 64, ageMonths: 0 });
    expect(survivor && 'primary' in survivor).toBe(false);
  });

  it('does NOT invent a survivor section when absent (withheld semantics survive rehydration)', async () => {
    const row = scenarioRow('sc-survivor-absent', {
      socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
    });
    const out = await roundTripAggregate('scenario', row);
    const ss = out.payload.overrides.socialSecurity;
    expect(ss).toBeDefined();
    expect(ss && 'survivor' in ss).toBe(false);
    expect(ss?.survivor).toBeUndefined();
  });
});

describe('aggregate sync round trip — scenario health coverage months + FPL region', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
  });

  it('preserves per-member/year Part B/D + Marketplace months and the FPL region', async () => {
    // ACA→Medicare transition year (2032): 6 Marketplace months, then 6 months
    // of Part B/D once enrolled at 65. Typed against the real shapes.
    const transitionYear: MemberCoverageMonths = { marketplaceMonths: 6, partBMonths: 6, partDMonths: 6 };
    const healthCoverageMonths: HealthCoverageMonthsOverride = {
      perMember: {
        'demo-member-primary': {
          2031: { marketplaceMonths: 12 },
          2032: transitionYear,
          2033: { partBMonths: 12, partDMonths: 12 },
        },
      },
    };
    const row = scenarioRow('sc-health', {
      acaFplRegion: 'alaska',
      acaMarketplaceOptOutMemberIds: ['demo-member-secondary'],
      healthCoverageMonths,
    });
    const out = await roundTripAggregate('scenario', row);
    expect(out.payload.overrides.acaFplRegion).toBe('alaska');
    expect(out.payload.overrides.healthCoverageMonths).toEqual({
      perMember: {
        'demo-member-primary': {
          2031: { marketplaceMonths: 12 },
          2032: { marketplaceMonths: 6, partBMonths: 6, partDMonths: 6 },
          2033: { partBMonths: 12, partDMonths: 12 },
        },
      },
    });
    // Precedence companion field survives alongside the new months.
    expect(out.payload.overrides.acaMarketplaceOptOutMemberIds).toEqual(['demo-member-secondary']);
  });

  it('does NOT invent health fields when absent (sparse-optional absence survives)', async () => {
    const row = scenarioRow('sc-health-absent', {});
    const out = await roundTripAggregate('scenario', row);
    expect('healthCoverageMonths' in out.payload.overrides).toBe(false);
    expect('acaFplRegion' in out.payload.overrides).toBe(false);
    expect(out.payload.overrides.healthCoverageMonths).toBeUndefined();
    expect(out.payload.overrides.acaFplRegion).toBeUndefined();
  });
});

function accountRow(
  id: string,
  extra: Partial<AccountPayload>,
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'account',
    // Write at the current account schema version so the fresh-store rehydration
    // read does NOT run a migration — this test pins the WIRE + store boundary,
    // not the migration (migrations.test.ts covers that).
    schemaVersion: currentSchemaVersion('account'),
    version: 1,
    updatedAt: '2026-07-18T00:00:00Z',
    deviceId: 'dev-roundtrip',
    payload: {
      name: 'Round-trip Roth',
      type: 'RETIREMENT_ROTH_IRA',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'ROTH',
      ownerId: 'member-primary',
      institution: 'Test',
      notes: '',
      planningReturnPct: 6,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 3000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...extra,
    },
  };
}

describe('aggregate sync round trip — account Roth distribution-tax facts', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
  });

  // Conversion lots are deliberately absent here: they are no longer account facts
  // and are recorded per year on `accountBalance`. Asserting a retired key here
  // would pass vacuously anyway — encrypt/decrypt preserves any JSON key. The keys
  // were dropped with no schema bump, so there is no migration step to cover;
  // `data-import.test.ts` pins that a stored lot survives import as an inert key.
  it('preserves a Roth IRA\'s first-contribution year', async () => {
    const row = accountRow('acc-roth-facts', {
      rothIraFirstContributionTaxYear: 2015,
    });
    const out = await roundTripAggregate('account', row);
    expect(out.payload.rothIraFirstContributionTaxYear).toBe(2015);
  });

  it('preserves a designated-Roth plan\'s first-participation year', async () => {
    const row = accountRow('acc-designated-roth', {
      type: 'RETIREMENT_ROTH_401K',
      designatedRothFirstParticipationTaxYear: 2012,
    });
    const out = await roundTripAggregate('account', row);
    expect(out.payload.designatedRothFirstParticipationTaxYear).toBe(2012);
  });

  it('does NOT invent Roth facts when absent (conservative-absence survives rehydration)', async () => {
    const row = accountRow('acc-roth-absent', {});
    const out = await roundTripAggregate('account', row);
    expect('rothIraConversionLots' in out.payload).toBe(false);
    expect('rothIraFirstContributionTaxYear' in out.payload).toBe(false);
    expect('designatedRothFirstParticipationTaxYear' in out.payload).toBe(false);
    expect(out.payload.rothIraFirstContributionTaxYear).toBeUndefined();
  });
});

describe('aggregate sync round trip — account RMD profile facts', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
  });

  it('preserves owner-side RMD facts (still-working + Table II + first-year deferral)', async () => {
    const row = accountRow('acc-rmd-owner', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      rmdCurrentEmployerPlan: true,
      rmdFivePercentOwner: false,
      rmdPlanRequiresDistributionAtStatutoryAge: false,
      rmdSoleSpouseBeneficiary: true,
      rmdSpouseBeneficiaryBirthdate: '1970-04-15',
      rmdFirstYearDeferralElected: true,
    });
    const out = await roundTripAggregate('account', row);
    expect(out.payload.rmdCurrentEmployerPlan).toBe(true);
    expect(out.payload.rmdFivePercentOwner).toBe(false);
    expect(out.payload.rmdSoleSpouseBeneficiary).toBe(true);
    expect(out.payload.rmdSpouseBeneficiaryBirthdate).toBe('1970-04-15');
    expect(out.payload.rmdFirstYearDeferralElected).toBe(true);
  });

  it('preserves a complete inherited-account fact set', async () => {
    const row = accountRow('acc-rmd-inherited', {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'DISABLED_OR_CHRONICALLY_ILL',
      rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      rmdInheritedOwnerDeathDate: '2023-09-01',
      rmdInheritedOwnerDiedOnOrAfterRbd: true,
      rmdOriginalOwnerBirthdate: '1945-06-10',
      rmdBeneficiaryBirthdate: '1985-02-20',
    });
    const out = await roundTripAggregate('account', row);
    expect(out.payload.rmdInheritedAccount).toBe(true);
    expect(out.payload.rmdBeneficiaryType).toBe('DISABLED_OR_CHRONICALLY_ILL');
    expect(out.payload.rmdBeneficiaryElection).toBe('LIFE_EXPECTANCY');
    expect(out.payload.rmdInheritedOwnerDeathDate).toBe('2023-09-01');
    expect(out.payload.rmdInheritedOwnerDiedOnOrAfterRbd).toBe(true);
    expect(out.payload.rmdOriginalOwnerBirthdate).toBe('1945-06-10');
    expect(out.payload.rmdBeneficiaryBirthdate).toBe('1985-02-20');
  });

  it('does NOT invent RMD facts when absent (conservative-absence survives rehydration)', async () => {
    const row = accountRow('acc-rmd-absent', { type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' });
    const out = await roundTripAggregate('account', row);
    expect('rmdInheritedAccount' in out.payload).toBe(false);
    expect('rmdBeneficiaryType' in out.payload).toBe(false);
    expect('rmdInheritedOwnerDeathDate' in out.payload).toBe(false);
    expect(out.payload.rmdInheritedAccount).toBeUndefined();
  });
});

/** One annual `accountBalance` row at the current schema version. */
function balanceRow(
  id: string,
  extra: Partial<AccountBalancePayload> = {},
): Aggregate<AccountBalancePayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'accountBalance',
    schemaVersion: currentSchemaVersion('accountBalance'),
    version: 1,
    updatedAt: '2026-07-18T00:00:00Z',
    deviceId: 'dev-roundtrip',
    payload: {
      accountId: 'acc-roth-401k',
      year: 2021,
      lastUpdated: '2021-12-31T23:59:59Z',
      startingBalance: 80_000,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: 90_000,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 2_500,
      comment: null,
      ...extra,
    },
  };
}

// The demo loader writes the dated in-plan-rollover pair for the first time, so
// the drill has to prove those sparse-optional keys survive the wire and that
// ABSENT still means absent after a fresh-tab rehydration. The payload SHAPE did
// not change in this phase; what changed is that the keys are now produced.
describe('aggregate sync round trip — accountBalance in-plan-rollover pair', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
  });

  it('preserves both halves of a recorded in-plan rollover and its inbound rollover leg', async () => {
    const row = balanceRow('bal-roth-401k-2021', {
      rollover: 20_000,
      endingBalance: 110_000,
      rothInPlanRolloverTaxableAmount: 20_000,
      rothInPlanRolloverNontaxableAmount: 1_250.5,
    });
    const out = await roundTripAggregate('accountBalance', row);
    expect(out.payload.rothInPlanRolloverTaxableAmount).toBe(20_000);
    // Dollars WITH CENTS survive intact — these are not whole-dollar fields.
    expect(out.payload.rothInPlanRolloverNontaxableAmount).toBe(1_250.5);
    // The balance leg that makes the fact reconcilable comes back with it.
    expect(out.payload.rollover).toBe(20_000);
  });

  it('preserves a recorded $0 half (recorded 0 is a stronger claim than absent)', async () => {
    const row = balanceRow('bal-roth-401k-zero', {
      rothInPlanRolloverTaxableAmount: 0,
      rothInPlanRolloverNontaxableAmount: 5_000,
    });
    const out = await roundTripAggregate('accountBalance', row);
    expect('rothInPlanRolloverTaxableAmount' in out.payload).toBe(true);
    expect(out.payload.rothInPlanRolloverTaxableAmount).toBe(0);
    expect(out.payload.rothInPlanRolloverNontaxableAmount).toBe(5_000);
  });

  it('does NOT invent the pair when absent (absence survives rehydration)', async () => {
    const out = await roundTripAggregate('accountBalance', balanceRow('bal-roth-401k-absent'));
    expect('rothInPlanRolloverTaxableAmount' in out.payload).toBe(false);
    expect('rothInPlanRolloverNontaxableAmount' in out.payload).toBe(false);
    expect('rothConversionTaxableAmount' in out.payload).toBe(false);
    expect(out.payload.rothInPlanRolloverTaxableAmount).toBeUndefined();
  });
});
