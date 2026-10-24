// Per-aggregate forward migration registry (docs/architecture.md "Changing stored data safely"): steps run up to `current`
// on every read; each is total, never throws, and sanitises (drops, never invents) values from imports or tampered payloads.
import type { AggregateType, PayloadByType } from './types.js';
import { DANGEROUS_CATEGORY_RATE_KEYS } from './types.js';
import { isValidContributionGrowthPct } from '../lib/contribution-growth.js';
import { isValidRothMoney, isValidRothTaxYear } from './roth-fact-validation.js';
import {
  isValidRmdBoolean,
  isValidRmdIsoDate,
  isValidRmdBeneficiaryType,
  isValidRmdBeneficiaryElection,
} from './rmd-fact-validation.js';

type MigrationFn = (payload: Record<string, unknown>) => Record<string, unknown>;

interface Registry {
  current: number;
  migrations: { [fromVersion: number]: MigrationFn };
}

// `account` v1 -> v2: HSA accounts (keyed on `type`, whatever treatment was stored) get `taxTreatment: 'HSA'` and their
// planned contribution consolidated onto the pre-tax field (pre + post), since an HSA contribution is payroll pre-tax
// and the projection reads only that field for HSA. Withdrawal tax-freedom keys off `taxTreatment`, not the
// contribution field.
function migrateAccountV1ToV2(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.type !== 'HSA') return payload;
  const pre =
    typeof payload.plannedContributionPreTax === 'number'
      ? payload.plannedContributionPreTax
      : 0;
  const post =
    typeof payload.plannedContributionPostTax === 'number'
      ? payload.plannedContributionPostTax
      : 0;
  return {
    ...payload,
    taxTreatment: 'HSA',
    plannedContributionPreTax: pre + post,
    plannedContributionPostTax: 0,
  };
}

// `account` v2 -> v3: Roth IRA accounts (keyed on `type`) get `taxTreatment: 'ROTH'`; no contribution consolidation,
// since a Roth IRA is already post-tax funded.
function migrateAccountV2ToV3(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.type !== 'RETIREMENT_ROTH_IRA') return payload;
  return {
    ...payload,
    taxTreatment: 'ROTH',
  };
}

// `scenario` v1 -> v2: identity. The `income`/`expenses` patch value type widened to allow a `null` clear-marker
// (`PatchWithClears`); the bump exists so a v1 client rejects a `null`-bearing scenario through the schema-ahead guard
// instead of mis-resolving the clear.
function migrateScenarioV1ToV2(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return payload;
}

// `scenario` v2 -> v3: copies `overrides.magiBootstrapForFirstTwoYears` into both new `magiBootstrapLookbackMinus2` and
// `magiBootstrapLookbackMinus1` (it drove both projection years) and removes the old key; a non-number is dropped.
function migrateScenarioV2ToV3(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  if (!('magiBootstrapForFirstTwoYears' in ov)) return payload;
  const { magiBootstrapForFirstTwoYears: old, ...restOverrides } = ov;
  const nextOverrides =
    typeof old === 'number'
      ? {
          ...restOverrides,
          magiBootstrapLookbackMinus2: old,
          magiBootstrapLookbackMinus1: old,
        }
      : restOverrides;
  return { ...payload, overrides: nextOverrides };
}

// `scenario` v3 -> v4: renames `overrides.magiCap.preTaxDrawDollarsAnnual` to `magiCeilingAnnualDollars` and seeds
// `capMode: 'minimize'` and `capMagiLine: 'irmaa'` so existing capped scenarios reproduce their output; no cap, a `{
// disabled: true }` sentinel or a malformed cap passes through.
function migrateScenarioV3ToV4(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  const cap = ov.magiCap;
  if (typeof cap !== 'object' || cap === null) return payload;
  const capObj = cap as Record<string, unknown>;
  if ('disabled' in capObj) return payload;
  // Already migrated or no legacy field: the read side defaults the absent behavior keys.
  if (!('preTaxDrawDollarsAnnual' in capObj)) return payload;
  const { preTaxDrawDollarsAnnual: legacyCeiling, ...restCap } = capObj;
  const nextCap: Record<string, unknown> = {
    ...restCap,
    magiCeilingAnnualDollars: legacyCeiling,
    capMode: 'minimize',
    capMagiLine: 'irmaa',
  };
  return { ...payload, overrides: { ...ov, magiCap: nextCap } };
}

// `scenario` v4 -> v5: rewrites the single-window MAGI cap into a one-window `windows` schedule that reproduces the
// legacy span (retirementStart to the `endAgeMemberRole` member's `endAge`, exclusive like the legacy `calendarYear <
// birthYear + endAge`). A cap already carrying `windows` passes through; one missing a numeric ceiling or `endAge`
// (corrupt) is omitted rather than given a synthesized bound.
function migrateScenarioV4ToV5(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  const cap = ov.magiCap;
  if (typeof cap !== 'object' || cap === null) return payload;
  const capObj = cap as Record<string, unknown>;
  if ('disabled' in capObj) return payload;
  if ('windows' in capObj) return payload;
  if (typeof capObj.magiCeilingAnnualDollars !== 'number') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip magiCap from the result
    const { magiCap: _drop, ...restOverrides } = ov;
    return { ...payload, overrides: restOverrides };
  }
  const endAgeMemberRole =
    capObj.endAgeMemberRole === 'secondary' ? 'secondary' : 'primary';
  if (typeof capObj.endAge !== 'number') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip magiCap from the result
    const { magiCap: _drop, ...restOverrides } = ov;
    return { ...payload, overrides: restOverrides };
  }
  const window: Record<string, unknown> = {
    start: { kind: 'retirementStart' },
    end: {
      kind: 'age',
      memberId: endAgeMemberRole,
      years: capObj.endAge,
      months: 0,
    },
    magiCeilingAnnualDollars: capObj.magiCeilingAnnualDollars,
    capMode: capObj.capMode === 'fill' ? 'fill' : 'minimize',
    capMagiLine: capObj.capMagiLine === 'aca' ? 'aca' : 'irmaa',
    ...(typeof capObj.targetRothAccountId === 'string'
      ? { targetRothAccountId: capObj.targetRothAccountId }
      : {}),
  };
  return { ...payload, overrides: { ...ov, magiCap: { windows: [window] } } };
}

// Upper bound on a stored `categoryRates` map (DoS guard): far above the seeded eight categories; a payload past it is
// truncated.
const MAX_CATEGORY_RATES_ENTRIES = 256;

// `scenario` v5 -> v6: the inflation override gains a sparse `categoryRates` map (percent per ExpenseCategory id).
// Clean data passes through; a pre-existing map from an import or tampered payload is sanitised: prototype keys dropped
// (CWE-1321), non-finite or out-of-[0,10] values dropped, size bounded (CWE-20).
function migrateScenarioV5ToV6(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  const inflation = ov.inflation;
  if (typeof inflation !== 'object' || inflation === null) return payload;
  const inf = inflation as Record<string, unknown>;
  const rawRates = inf.categoryRates;
  if (typeof rawRates !== 'object' || rawRates === null) return payload;
  const cleanRates: Record<string, number> = {};
  let count = 0;
  for (const key of Object.keys(rawRates as Record<string, unknown>)) {
    if (count >= MAX_CATEGORY_RATES_ENTRIES) break;
    if (DANGEROUS_CATEGORY_RATE_KEYS.has(key)) continue;
    const value = (rawRates as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < 0 || value > 10) continue;
    cleanRates[key] = value;
    count += 1;
  }
  const nextInflation: Record<string, unknown> = { ...inf };
  if (Object.keys(cleanRates).length > 0) {
    nextInflation.categoryRates = cleanRates;
  } else {
    delete nextInflation.categoryRates;
  }
  return {
    ...payload,
    overrides: { ...ov, inflation: nextInflation },
  };
}

// `account` v3 -> v4: adds optional `contributionGrowthPct`. A pre-existing non-finite or out-of-domain `(-100, 25]`
// value is dropped to the tracks-inflation default, since it feeds `(1 + pct/100)^n` compounding and would overflow the
// projection.
function migrateAccountV3ToV4(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!('contributionGrowthPct' in payload)) return payload;
  if (isValidContributionGrowthPct(payload.contributionGrowthPct)) {
    return payload;
  }
  const next = { ...payload };
  delete next.contributionGrowthPct;
  return next;
}

// `account` v4 -> v5: adds optional Roth distribution-tax facts (`rothIraRegularContributionBasis`,
// `rothIraFirstContributionTaxYear`, `designatedRothBasis`, `designatedRothFirstParticipationTaxYear`). Absent means a
// conservative $0 basis / five-year rule not satisfied at the engine boundary; invalid pre-existing values (negative or
// non-finite money, out-of-range tax years) are dropped, since they feed the cents-based §408A ordering engine. The
// bump also stops a pre-Roth-engine client reading a populated fact as basis and understating tax. The old per-transfer
// lot arrays (`rothIraConversionLots`, `designatedRothInPlanRolloverLots`) are not sanitised: nothing reads them, so an
// old payload keeps them inert (see the REGISTRY note on their omission).
function migrateAccountV4ToV5(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...payload };
  let changed = false;

  const dropIfInvalid = (key: string, valid: boolean): void => {
    if (key in next && !valid) {
      delete next[key];
      changed = true;
    }
  };

  dropIfInvalid(
    'rothIraRegularContributionBasis',
    isValidRothMoney(payload.rothIraRegularContributionBasis),
  );
  dropIfInvalid(
    'rothIraFirstContributionTaxYear',
    isValidRothTaxYear(payload.rothIraFirstContributionTaxYear),
  );
  dropIfInvalid('designatedRothBasis', isValidRothMoney(payload.designatedRothBasis));
  dropIfInvalid(
    'designatedRothFirstParticipationTaxYear',
    isValidRothTaxYear(payload.designatedRothFirstParticipationTaxYear),
  );

  return changed ? next : payload;
}

// `account` v5 -> v6: adds the optional RMD profile facts: boolean flags, ISO-date fields (spouse-beneficiary
// birthdate, inherited-owner death date, original-owner and beneficiary birthdates), `rmdBeneficiaryType` and
// `rmdBeneficiaryElection`. Absent means the conservative default at the engine boundary, and an inherited account with
// incomplete facts withholds its RMD. Invalid pre-existing values (non-boolean flags, calendar-invalid dates,
// out-of-vocabulary categories) are dropped, never invented, so the engine withholds rather than guess a rule.
function migrateAccountV5ToV6(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...payload };
  let changed = false;

  const dropIfInvalid = (key: string, valid: boolean): void => {
    if (key in next && !valid) {
      delete next[key];
      changed = true;
    }
  };

  for (const key of [
    'rmdInheritedAccount',
    'rmdCurrentEmployerPlan',
    'rmdFivePercentOwner',
    'rmdPlanRequiresDistributionAtStatutoryAge',
    'rmdFirstYearDeferralElected',
    'rmdSoleSpouseBeneficiary',
    'rmdInheritedOwnerDiedOnOrAfterRbd',
  ]) {
    dropIfInvalid(key, isValidRmdBoolean(payload[key]));
  }

  for (const key of [
    'rmdSpouseBeneficiaryBirthdate',
    'rmdInheritedOwnerDeathDate',
    'rmdOriginalOwnerBirthdate',
    'rmdBeneficiaryBirthdate',
  ]) {
    dropIfInvalid(key, isValidRmdIsoDate(payload[key]));
  }

  dropIfInvalid('rmdBeneficiaryType', isValidRmdBeneficiaryType(payload.rmdBeneficiaryType));

  dropIfInvalid('rmdBeneficiaryElection', isValidRmdBeneficiaryElection(payload.rmdBeneficiaryElection));

  return changed ? next : payload;
}

// `account` v6 -> v7: removes the Roth-basis dollar totals `rothIraRegularContributionBasis` and `designatedRothBasis`
// (both engines now derive basis from the `accountBalance` history); the sibling year facts stay. Maps each key to
// `undefined`, never `delete`, so an older snapshot carrying it keeps its key set (like `migrateAccountBalanceV1ToV2`);
// a payload with neither key is returned by reference. The bump is required despite the no-bump precedent for removed
// fields, which holds only while no build reads the key: a build from before the engine cutover reads an absent basis
// as a conservative $0 basis (a different number), so the bump makes it refuse the row via the schema-ahead guard
// instead of silently re-pricing Roth tax. The stored values are gone on upgrade, with no recovery path.
function migrateAccountV6ToV7(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const keys = ['rothIraRegularContributionBasis', 'designatedRothBasis'] as const;
  const present = keys.filter((key) => key in payload);
  if (present.length === 0) return payload;
  const next = { ...payload };
  for (const key of present) next[key] = undefined;
  return next;
}

// `scenario` v6 -> v7: the per-account contribution override (`overrides.accountContributions.perAccount[id]`) gains
// optional `contributionGrowthPct`. A pre-existing value on any entry is dropped unless finite and inside `(-100, 25]`
// (as in account v3 -> v4); other entry fields survive.
function migrateScenarioV6ToV7(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  const contrib = ov.accountContributions;
  if (typeof contrib !== 'object' || contrib === null) return payload;
  const contribObj = contrib as Record<string, unknown>;
  const perAccount = contribObj.perAccount;
  if (typeof perAccount !== 'object' || perAccount === null) return payload;
  const perAccountObj = perAccount as Record<string, unknown>;
  const nextPerAccount: Record<string, unknown> = {};
  for (const key of Object.keys(perAccountObj)) {
    if (DANGEROUS_CATEGORY_RATE_KEYS.has(key)) continue;
    const entry = perAccountObj[key];
    if (typeof entry !== 'object' || entry === null) {
      nextPerAccount[key] = entry;
      continue;
    }
    const entryObj = entry as Record<string, unknown>;
    if (
      'contributionGrowthPct' in entryObj &&
      !isValidContributionGrowthPct(entryObj.contributionGrowthPct)
    ) {
      const nextEntry = { ...entryObj };
      delete nextEntry.contributionGrowthPct;
      nextPerAccount[key] = nextEntry;
    } else {
      nextPerAccount[key] = entry;
    }
  }
  return {
    ...payload,
    overrides: {
      ...ov,
      accountContributions: { ...contribObj, perAccount: nextPerAccount },
    },
  };
}

// `scenario` v7 -> v8: identity. The overrides gain a sparse `accountFloors` section (absent means no floor); its
// `floorDollars`/`hsaMode` sanitisation lives at the resolver boundary (`resolveAccountFloorsForScenario`). The bump
// drives the schema-ahead guard: a v7 client must reject a floored scenario rather than draw an account below the
// intended minimum, a wrong-number outcome rather than a safe degrade.
function migrateScenarioV7ToV8(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return payload;
}

/**
 * The four named withdrawal strategies that survive the Combined Pot retirement (scenario v8 -> v9); any other `.kind`
 * coerces to `taxEfficient`. Also used by the import coercion in `lib/data-import.ts`.
 */
export const NAMED_WITHDRAWAL_STRATEGY_KINDS = new Set<string>([
  'taxEfficient',
  'proportional',
  'rothFirst',
  'customOrder',
]);

// `scenario` v8 -> v9: retires the Combined Pot withdrawal strategy, an active transform: an absent strategy, the
// retired kind or a malformed `.kind` (CWE-20) becomes `{ kind: 'taxEfficient' }`; the four surviving named strategies
// are unchanged and `magiCap` and every other override is preserved. `lib/data-import.ts` applies the same coercion,
// since a current-version bundle skips this step.
function migrateScenarioV8ToV9(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return payload;
  }
  const overridesRecord = overrides as Record<string, unknown>;
  const strategy = overridesRecord.withdrawalStrategy;
  const kind =
    strategy !== null && typeof strategy === 'object' && !Array.isArray(strategy)
      ? (strategy as Record<string, unknown>).kind
      : undefined;
  if (typeof kind === 'string' && NAMED_WITHDRAWAL_STRATEGY_KINDS.has(kind)) {
    return payload;
  }
  return {
    ...payload,
    overrides: {
      ...overridesRecord,
      withdrawalStrategy: { kind: 'taxEfficient' },
    },
  };
}

// `expenseCategory` v1 -> v2: adds optional `isMedical`. A pre-existing non-boolean value is dropped, since the flag is
// the canonical "is this medical?" signal for the projection engine. Payload-only, so it cannot flip the seeded
// `cat-medical` row; the id-keyed backfill in `lib/expense-categories-bootstrap.ts` does that.
function migrateExpenseCategoryV1ToV2(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!('isMedical' in payload)) return payload;
  if (typeof payload.isMedical === 'boolean') return payload;
  const next = { ...payload };
  delete next.isMedical;
  return next;
}

// `accountBalance` v1 -> v2: adds sparse-optional per-year Roth conversion amounts. Identity for every app-stored
// record; an import or hand-edited payload with an invalid amount has it mapped to `undefined`, key kept (fields are
// removed only that way, as older snapshots may still carry them). Non-objects and clean payloads return by reference.
function migrateAccountBalanceV1ToV2(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const keys = [
    'rothConversionTaxableAmount',
    'rothConversionNontaxableAmount',
  ] as const;
  const bad = keys.filter(
    (key) => key in payload && !isValidRothMoney(payload[key]),
  );
  if (bad.length === 0) return payload;
  const next = { ...payload };
  for (const key of bad) next[key] = undefined;
  return next;
}

// Current schema version per aggregate type; a shape change bumps `current` and adds a migration entry. A bump also
// drives the schema-ahead guard: a client behind a row's version rejects it instead of mis-reading it. Read as text,
// not imported, by scripts/check-schema-not-ahead.mjs (the deploy preflight): renaming or reshaping this declaration
// makes it throw, so update that script and scripts/test/schema-ahead-guard.test.mjs together.
const REGISTRY: Record<AggregateType, Registry> = {
  household: { current: 1, migrations: {} },
  householdMember: { current: 1, migrations: {} },
  // No bump for the removed `rothIraConversionLots` / `designatedRothInPlanRolloverLots` keys: nothing reads them and
  // re-saving rebuilds the payload without them, so a stored copy is inert (AGENTS.md "Aggregate schema evolution",
  // step 3). Reopen if a read path uses them again.
  account: {
    current: 7,
    migrations: {
      1: migrateAccountV1ToV2,
      2: migrateAccountV2ToV3,
      3: migrateAccountV3ToV4,
      4: migrateAccountV4ToV5,
      5: migrateAccountV5ToV6,
      6: migrateAccountV6ToV7,
    },
  },
  // `accountBalance` stays at 2 after the in-plan Roth rollover pair: additive sparse-optional, and the runtime fact
  // adapter re-validates every amount at the consumption boundary, so a migration sanitiser would duplicate it
  // (AGENTS.md "Aggregate schema evolution", step 3).
  accountBalance: {
    current: 2,
    migrations: { 1: migrateAccountBalanceV1ToV2 },
  },
  socialSecurityBenefit: { current: 1, migrations: {} },
  expenseCategory: {
    current: 2,
    migrations: { 1: migrateExpenseCategoryV1ToV2 },
  },
  // `expense` stays at 1 after `hsaQualified`: additive sparse-optional, absent means not qualified (AGENTS.md
  // "Aggregate schema evolution", step 3).
  expense: { current: 1, migrations: {} },
  incomeStream: { current: 1, migrations: {} },
  // `scenario` stays at 9 after the `annualInvestmentCostPct` override was removed: it was sparse-optional and nothing
  // reads it, so a synced copy is inert, and a bump would only make older clients reject newer scenarios (AGENTS.md
  // "Aggregate schema evolution", step 3).
  scenario: {
    current: 9,
    migrations: {
      1: migrateScenarioV1ToV2,
      2: migrateScenarioV2ToV3,
      3: migrateScenarioV3ToV4,
      4: migrateScenarioV4ToV5,
      5: migrateScenarioV5ToV6,
      6: migrateScenarioV6ToV7,
      7: migrateScenarioV7ToV8,
      8: migrateScenarioV8ToV9,
    },
  },
};

export function currentSchemaVersion(type: AggregateType): number {
  return REGISTRY[type].current;
}

export function migrate<T extends AggregateType>(
  type: T,
  payload: Record<string, unknown>,
  fromVersion: number,
): PayloadByType[T] {
  const registry = REGISTRY[type];
  let result = payload;
  for (let v = fromVersion; v < registry.current; v++) {
    const fn = registry.migrations[v];
    if (!fn) {
      // Gap in the chain: fail open and pass through (reads are never blocked on a missing migration); warn so the dev
      // notices.
      console.warn(
        `[migrations] Missing forward migration for ${type} v${v} → v${v + 1}; passing through`,
      );
      break;
    }
    result = fn(result);
  }
  return result as unknown as PayloadByType[T];
}
