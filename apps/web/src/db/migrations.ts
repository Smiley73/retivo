/**
 * Per-aggregate-type forward migration registry (see "Changing stored data
 * safely" in docs/architecture.md).
 *
 * Each aggregate type ships a `CURRENT` version + a chain of
 * `(payload: vN) => vN+1` functions. On every read from IndexedDB or
 * sync response, the client runs all required migrations up to current.
 * Every step is total, idempotent where it can be, and never throws.
 */
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

/**
 * `account` v1 → v2: HSA accounts gain their own `'HSA'` tax treatment.
 *
 * Keyed on `type === 'HSA'` (not the stored treatment) so every legacy HSA
 * row migrates regardless of whether it was stored PRE_TAX or POST_TAX —
 * demo HSAs shipped POST_TAX, and hand-entered ones could be either.
 *
 * Two fields are rewritten:
 *  - `taxTreatment` → `'HSA'`.
 *  - The planned contribution is consolidated onto the **pre-tax** field
 *    (`plannedContributionPreTax = pre + post`, `plannedContributionPostTax = 0`).
 *    An HSA contribution is made pre-tax (payroll deduction), so the single
 *    Contributions-screen input lives on the pre-tax side. Legacy rows whose
 *    amount was stored post-tax (e.g. demo HSAs) would otherwise show an empty
 *    pre-tax box and have their contribution dropped by the projection (which
 *    reads the pre-tax field for HSA). Summing both sides preserves the dollar
 *    amount whichever side it was on. This does NOT make withdrawals taxable:
 *    qualified HSA withdrawals are tax-free by `taxTreatment === 'HSA'`,
 *    independent of the contribution field. Every other field survives
 *    unchanged. Non-HSA accounts pass through untouched.
 */
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

/**
 * `account` v2 → v3: Roth IRA accounts gain their own `'ROTH'` tax treatment.
 *
 * Keyed on `type === 'RETIREMENT_ROTH_IRA'` (not the stored treatment) so every
 * legacy Roth IRA row migrates regardless of the value it carried — demo Roth
 * IRAs shipped POST_TAX, the historical treatment for the type.
 *
 * Only `taxTreatment` is rewritten. Unlike the HSA v1→v2 step, no contribution
 * field consolidation is needed: a Roth IRA is post-tax funded, so its planned
 * contribution already lives on `plannedContributionPostTax` and the
 * Contributions screen already shows it on the correct (post-tax) side. The
 * tax-free withdrawal character is keyed off `taxTreatment === 'ROTH'`,
 * independent of which contribution field holds the amount. Every other field
 * survives unchanged. Non-Roth-IRA accounts pass through untouched.
 */
function migrateAccountV2ToV3(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.type !== 'RETIREMENT_ROTH_IRA') return payload;
  return {
    ...payload,
    taxTreatment: 'ROTH',
  };
}

/**
 * `scenario` v1 → v2: identity. The `income`/`expenses` sparse patch
 * value type widened to allow a per-key `null` clear-marker
 * (`PatchWithClears`). `null` is only a new *legal value*, not a reshape
 * of existing data, so no field transform is needed — every v1 payload
 * is already a valid v2 payload. The bump exists solely to drive the
 * schema-ahead guard: a pre-feature (v1) client receiving a `null`-bearing
 * (v2) scenario via sync/import is rejected by the `schemaVersion >
 * current` check (VersionBanner reload) rather than silently
 * mis-resolving the clear. Total, never throws.
 */
function migrateScenarioV1ToV2(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return payload;
}

/**
 * `scenario` v2 → v3: split the single MAGI bootstrap into two
 * lookback-year fields. The former `overrides.magiBootstrapForFirstTwoYears`
 * value drove BOTH projection year 0 (= `MAGI(ret−2)`) and year 1
 * (= `MAGI(ret−1)`), so this step COPIES it into BOTH new fields —
 * `magiBootstrapLookbackMinus2` and `magiBootstrapLookbackMinus1` — and removes
 * the old key. Behavior-preserving: seeding both fields reproduces the prior
 * single-value output exactly (no data loss, no dropped value). A v2 payload
 * with the field absent migrates to v3 with both fields absent. The old key is
 * deleted so the v3 shape no longer carries it.
 */
function migrateScenarioV2ToV3(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  if (!('magiBootstrapForFirstTwoYears' in ov)) return payload;
  const { magiBootstrapForFirstTwoYears: old, ...restOverrides } = ov;
  // Only copy a real numeric value into both fields; a non-number (corrupt)
  // value is dropped (treated as absent) — both new fields stay undefined.
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

/**
 * `scenario` v3 → v4: rename the
 * MAGI-cap field `overrides.magiCap.preTaxDrawDollarsAnnual` →
 * `magiCeilingAnnualDollars` (honest MAGI-ceiling naming; unit unchanged —
 * whole dollars) and seed the new behavior keys with their backward-compatible
 * defaults so existing capped scenarios reproduce today's exact output:
 *   - `capMode = 'minimize'` (draw minimal pre-tax, convert $0),
 *   - `capMagiLine = 'irmaa'` (the line the legacy cap effectively targeted),
 *   - no `targetRothAccountId` (no auto-conversion).
 *
 * Total / never-throws: every branch returns a payload. A scenario with
 * no `magiCap`, a `{ disabled: true }` sentinel, or a malformed override is
 * passed through unchanged. Logs carry NO balances / account-id values (this
 * step logs nothing; the only ceiling value moved is a number, never logged).
 */
function migrateScenarioV3ToV4(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  const cap = ov.magiCap;
  // No cap, or the `{ disabled: true }` sentinel, or a non-object → pass through.
  if (typeof cap !== 'object' || cap === null) return payload;
  const capObj = cap as Record<string, unknown>;
  if ('disabled' in capObj) return payload;
  // Already migrated (idempotent) or a malformed cap with no legacy field →
  // leave it; the read-side defaults cover absent behavior keys.
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

/**
 * `scenario` v4 → v5: reshape the
 * single-window MAGI-cap override into a non-overlapping WINDOW SCHEDULE.
 *
 * The legacy `overrides.magiCap` carried a single implicit window — active from
 * the drawdown loop's first year (retirement) through `endAge - 1` of the
 * `endAgeMemberRole` member. This step rewrites it into a one-window ladder
 * that reproduces that exact span:
 *   `{ windows: [ {
 *        start: { kind: 'retirementStart' },
 *        end:   { kind: 'age', memberId: <endAgeMemberRole>, years: endAge, months: 0 },
 *        magiCeilingAnnualDollars, capMode, capMagiLine, targetRothAccountId
 *   } ] }`
 * `end{kind:'age',years:N}` resolves EXCLUSIVE (the year the member turns N),
 * matching the legacy `calendarYear < birthYear + endAge`.
 *
 * Total / idempotent / never-throws:
 *   - non-object / null cap → pass through untouched;
 *   - `{ disabled: true }` sentinel → pass through untouched;
 *   - already-v5 (`'windows' in cap`) → pass through (idempotent guard);
 *   - a malformed / partial legacy cap MISSING a numeric
 *     `magiCeilingAnnualDollars` (only reachable via corrupted / tampered data —
 *     v4 requires the field) → OMIT `magiCap` entirely (migrate to no cap);
 *     the migration never synthesizes a ceiling and never throws.
 * Logs nothing (no balances / account-ids / ceilings logged).
 */
function migrateScenarioV4ToV5(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (typeof overrides !== 'object' || overrides === null) return payload;
  const ov = overrides as Record<string, unknown>;
  const cap = ov.magiCap;
  // No cap, or the `{ disabled: true }` sentinel, or a non-object → pass through.
  if (typeof cap !== 'object' || cap === null) return payload;
  const capObj = cap as Record<string, unknown>;
  if ('disabled' in capObj) return payload;
  // Already migrated (idempotent) — the v5 shape carries `windows`.
  if ('windows' in capObj) return payload;
  // Malformed / partial legacy cap with no numeric ceiling (corrupted data) →
  // migrate to NO cap (omit `magiCap`); never synthesize a ceiling, never throw.
  if (typeof capObj.magiCeilingAnnualDollars !== 'number') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip magiCap from the result
    const { magiCap: _drop, ...restOverrides } = ov;
    return { ...payload, overrides: restOverrides };
  }
  const endAgeMemberRole =
    capObj.endAgeMemberRole === 'secondary' ? 'secondary' : 'primary';
  // A legacy cap that never carried an `endAge` (corrupt) cannot resolve a
  // window end-year; rather than throw or synthesize a bound, drop to no cap.
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

/**
 * `scenario` v5 → v6: the inflation override
 * gains an optional sparse `categoryRates` map (per-category effective
 * inflation rate, percent, keyed by ExpenseCategory aggregate id). The new
 * field is additive — a v5 payload that never carried it is a valid v6
 * payload as-is — so this step is an identity pass for clean data. It is
 * NOT a bare identity, though: an imported / corrupted v5 payload may already
 * carry a `categoryRates` object (plaintext import bundles, or a
 * tampered local payload), so this step SANITISES any pre-existing map at the
 * migration boundary — dropping the dangerous prototype keys
 * (`__proto__`/`constructor`/`prototype`), dropping non-finite or
 * out-of-`[0,10]` values, and bounding the stored map size — so a hostile
 * payload cannot inject prototype-pollution (CWE-1321) or `NaN`/`Infinity`
 * into the engine (CWE-20). When the inflation override is absent, malformed,
 * or carries no `categoryRates`, the payload passes through untouched.
 *
 * Total / idempotent / never-throws: every branch returns a payload; a
 * payload already carrying only clean entries is rebuilt with the same
 * entries. The schema bump also drives the schema-ahead guard so a
 * pre-feature (v5) client safely rejects a v6 scenario (VersionBanner reload).
 */
/** Upper bound on a stored `categoryRates` map (DoS guard). Far above
 *  the seeded eight categories; a payload past it is truncated on upgrade. */
const MAX_CATEGORY_RATES_ENTRIES = 256;

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
  // No category map → already a valid v6 payload; pass through untouched.
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

/**
 * `account` v3 → v4: the account
 * gains an optional `contributionGrowthPct` field — the per-account
 * annual-increase rate for its planned contribution. The new field is
 * additive, so a v3 payload that never carried it is a valid v4 payload
 * as-is (absent → tracks-inflation default), making this an identity pass
 * for clean data.
 *
 * It is NOT a bare identity, though: an imported / tampered v3 payload may
 * already carry a `contributionGrowthPct` value (plaintext import bundles,
 * or a corrupt local payload). The value flows into the
 * `(1 + pct/100)^n` compounding helper, so a non-finite / out-of-band
 * value would overflow the projection + the reconciliation invariant
 * (CWE-20). This step SANITISES a pre-existing value at the migration
 * boundary — dropping it (→ tracks-inflation default) unless it is finite
 * and inside the accepted domain `(-100, 25]`. Mirrors the
 * `categoryRates` hardening in `migrateScenarioV5ToV6`.
 *
 * Total / idempotent / never-throws: every branch returns a payload.
 */
function migrateAccountV3ToV4(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!('contributionGrowthPct' in payload)) return payload;
  if (isValidContributionGrowthPct(payload.contributionGrowthPct)) {
    return payload;
  }
  // Non-finite / out-of-band stored value → drop to the tracks-inflation
  // default (absent).
  const next = { ...payload };
  delete next.contributionGrowthPct;
  return next;
}

/**
 * `account` v4 → v5: the account payload gains optional Roth
 * distribution-tax facts —
 *   `rothIraRegularContributionBasis`, `rothIraFirstContributionTaxYear`,
 *   `designatedRothBasis`, `designatedRothFirstParticipationTaxYear`.
 *
 * The fields are additive sparse-optional — a v4 payload that never carried them
 * is a valid v5 payload as-is (absent → conservative $0 basis / five-year rule
 * NOT satisfied, applied at the engine boundary; the migration never invents a
 * stored default). So the step is IDENTITY for clean data (returns the same
 * reference).
 *
 * It is NOT a bare identity: an imported / tampered v4 payload may already carry
 * these fields (plaintext import bundles, or a corrupt local
 * payload), and the values flow into the cents-based §408A ordering engine,
 * so a non-finite / negative amount or a bogus tax year is a CWE-20
 * hazard. This step SANITISES any pre-existing values at the migration boundary
 * — dropping negative / non-finite money and out-of-range / non-integer tax
 * years — mirroring the `contributionGrowthPct` v3→v4 hardening. The distinct
 * schema-ahead bump also guards a client built before the Roth engine from
 * mis-resolving a populated fact once the engine is active (a stale client would otherwise treat the whole
 * Roth balance as basis, understating tax — wrong-number class).
 *
 * The step originally also sanitised two per-transfer lot ARRAYS,
 * `rothIraConversionLots` and `designatedRothInPlanRolloverLots`. Both dated
 * facts moved to the annual balance rows and NOTHING reads those
 * keys any more, so the sanitiser was cleaning data no consumer can see. It is
 * gone: an old payload keeps whatever it stored, inert, which is the same
 * disposition the registry's intentional-omission note records for the removal.
 * A CWE-20 guard is only worth its cost where the value reaches an engine.
 *
 * Total / idempotent / never-throws: every branch returns a payload; a clean
 * payload is returned by reference.
 */
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

/**
 * `account` v5 → v6 (RMD engine):
 * the account payload gains the additive optional Required-Minimum-Distribution
 * profile facts —
 *   `rmdInheritedAccount`, `rmdCurrentEmployerPlan`, `rmdFivePercentOwner`,
 *   `rmdPlanRequiresDistributionAtStatutoryAge`, `rmdFirstYearDeferralElected`,
 *   `rmdSoleSpouseBeneficiary` (booleans),
 *   `rmdSpouseBeneficiaryBirthdate`, `rmdInheritedOwnerDeathDate`,
 *   `rmdOriginalOwnerBirthdate`, `rmdBeneficiaryBirthdate` (ISO `YYYY-MM-DD` dates),
 *   `rmdInheritedOwnerDiedOnOrAfterRbd` (boolean),
 *   `rmdBeneficiaryType` (a beneficiary-category enum), and
 *   `rmdBeneficiaryElection` (a post-death distribution-election enum — the
 *   affirmative 10-year-vs-life-expectancy choice the engine must never invent).
 *
 * The fields are additive sparse-optional — a v5 payload that never carried them
 * is a valid v6 payload as-is (absent → the one-sided conservative default at the
 * engine boundary; an INHERITED account with incomplete facts WITHHOLDS its RMD).
 * So the step is IDENTITY for clean data (returns the same reference), and it
 * NEVER INVENTS inherited beneficiary state — it only DROPS an invalid stored
 * value, never synthesises one (a missing beneficiary fact stays missing so the
 * engine withholds rather than guessing a distribution rule).
 *
 * It is NOT a bare identity: an imported / tampered v5 payload may already carry
 * these fields (plaintext import bundles, or a corrupt local
 * payload). The facts drive rule/table SELECTION and the still-working /
 * first-year-deferral logic once the engine is active, so a non-boolean flag,
 * a malformed / calendar-invalid date, or an unknown beneficiary category is a
 * CWE-20 hazard. This step SANITISES any pre-existing values at the migration
 * boundary — dropping non-boolean flags, calendar-invalid dates, and
 * out-of-vocabulary beneficiary categories — mirroring the `contributionGrowthPct`
 * v3→v4 and Roth-fact v4→v5 hardening. The distinct schema-ahead bump also guards
 * a client built before the RMD engine from mis-resolving a populated fact once the engine is active
 * (a stale client would otherwise ignore an inherited/still-working fact and
 * project the wrong required distribution — wrong-number class).
 *
 * Total / idempotent / never-throws: every branch returns a payload; a clean
 * payload is returned by reference.
 */
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

  // Boolean flag facts.
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

  // ISO `YYYY-MM-DD` date facts.
  for (const key of [
    'rmdSpouseBeneficiaryBirthdate',
    'rmdInheritedOwnerDeathDate',
    'rmdOriginalOwnerBirthdate',
    'rmdBeneficiaryBirthdate',
  ]) {
    dropIfInvalid(key, isValidRmdIsoDate(payload[key]));
  }

  // Beneficiary-category enum.
  dropIfInvalid('rmdBeneficiaryType', isValidRmdBeneficiaryType(payload.rmdBeneficiaryType));

  // Post-death distribution-election enum.
  dropIfInvalid('rmdBeneficiaryElection', isValidRmdBeneficiaryElection(payload.rmdBeneficiaryElection));

  return changed ? next : payload;
}


/**
 * `account` v6 → v7: the two Roth-basis
 * DOLLAR TOTALS — `rothIraRegularContributionBasis` and `designatedRothBasis` —
 * are removed from `AccountPayload` outright. Both engines read a basis DERIVED
 * from the recorded `accountBalance` contribution/withdrawal history, so
 * neither field is read any more; this step stops storing them. The two sibling year facts —
 * `rothIraFirstContributionTaxYear` and `designatedRothFirstParticipationTaxYear`
 * — are untouched.
 *
 * **Maps each key to `undefined`, never `delete`s it** — the next write drops
 * the key through JSON serialization anyway, and an older snapshot that still
 * carries it keeps its key set (matching `migrateAccountBalanceV1ToV2`). Total, idempotent, and never throws: a
 * non-object / null / array payload passes through untouched, a payload
 * carrying neither key is returned BY REFERENCE (identity — the overwhelming
 * majority of rows), and re-running the step on its own output changes
 * nothing: both keys are already `undefined`, so re-assigning them to
 * `undefined` a second time is a value no-op even though a fresh shallow copy
 * is allocated. Logs nothing — no balance or account-id values pass through
 * this step.
 *
 * **The bump is required, not optional**, despite the general precedent that
 * removing a field does not automatically bump the version (the retired
 * `rothIraConversionLots` / `designatedRothInPlanRolloverLots` keys left
 * `account` at v6 for exactly that reason). That precedent holds only while no
 * build reads the removed key; here one does. A build from before
 * the engine cutover reads an absent
 * `rothIraRegularContributionBasis` / `designatedRothBasis` as "conservative $0
 * basis" — a real, different number (wrong-number class), not an inert key. The
 * bump makes such a build refuse the row (`schemaVersion > current` →
 * `VersionBanner` reload) instead of silently re-pricing the household's Roth
 * tax. The retired lot keys' own no-bump disposition is UNCHANGED by this step
 * — it does not touch them.
 *
 * The stored values are gone for good on upgrade — no notice, no recovery path.
 */
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

/**
 * `scenario` v6 → v7: the
 * per-account contribution override
 * (`overrides.accountContributions.perAccount[id]`) gains an optional
 * `contributionGrowthPct` field — the per-scenario per-account
 * annual-increase rate. Additive (a v6 payload that never carried it is a
 * valid v7 payload), so this is an identity pass for clean data.
 *
 * Same sanitisation contract as the account v3→v4 step: a pre-existing
 * stored value on any per-account override entry is dropped unless it is
 * finite and inside `(-100, 25]`. Imported / tampered scenarios are
 * an unvalidated-number surface (CWE-20), and the value feeds the
 * compounding helper. Other override fields on each entry survive
 * unchanged.
 *
 * Total / idempotent / never-throws.
 */
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

/**
 * `scenario` v7 → v8: the scenario overrides gain an
 * optional sparse `accountFloors` section (per-account minimum-balance floor).
 * The new field is additive — a v7 payload that never carried it is a valid v8
 * payload as-is (absent `accountFloors` ⇒ no floor for any account, the correct
 * default), so this step is an IDENTITY pass. No data transform is needed: the
 * `floorDollars` / `hsaMode` CWE-20 sanitisation lives at the resolver boundary
 * (`resolveAccountFloorsForScenario`), not in this migration, mirroring the
 * `acaMarketplaceOptOutMemberIds` / `preRetirementRothConversions`
 * resolver-hardened precedent.
 *
 * The bump exists SOLELY to drive the schema-ahead guard: a pre-feature
 * (v7) client receiving a floored (v8) scenario via sync/import is rejected by
 * the `schemaVersion > current` check (VersionBanner reload) rather than
 * silently ignoring the floor and drawing the account below the user's intended
 * minimum. Floor mis-resolution is wrong-number-class (draws MORE than
 * intended), not safe-degrade — exactly the class the `contributionGrowthPct`
 * v6→v7 bump guarded against. Total, never throws.
 */
function migrateScenarioV7ToV8(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return payload;
}

/** The four named withdrawal strategies that survive the Combined Pot
 *  retirement (scenario v8→v9). Any other `.kind` (the retired Combined Pot
 *  kind, or a malformed/tampered value) coerces to `taxEfficient`. Also
 *  consumed by the import-boundary coercion in `lib/data-import.ts`. */
export const NAMED_WITHDRAWAL_STRATEGY_KINDS = new Set<string>([
  'taxEfficient',
  'proportional',
  'rothFirst',
  'customOrder',
]);

/**
 * `scenario` v8 → v9: the Combined Pot withdrawal
 * strategy is retired. This is an ACTIVE transformation (not identity):
 *   - absent `overrides.withdrawalStrategy` → `{ kind: 'taxEfficient' }` (the
 *     new default; the engine previously fell back to the retired kind for an
 *     absent strategy).
 *   - explicit retired Combined Pot kind → `{ kind: 'taxEfficient' }`.
 *   - a malformed `.kind` (non-object, missing kind, or any value outside the
 *     four named strategies) → `{ kind: 'taxEfficient' }` (CWE-20 coercion).
 *   - any of the four surviving named strategies → unchanged.
 * `magiCap` and every other override is PRESERVED as-is (a cap set under
 * the old Combined Pot scenario becomes active under taxEfficient).
 *
 * Total / idempotent / never-throws: a v9 payload re-run lands on the same
 * named strategy (a non-object `overrides` returns as-is, a missing strategy
 * gains `taxEfficient`, a present named strategy is left alone). The bump also
 * drives the schema-ahead guard so a pre-feature (v8) client rejects a v9
 * scenario rather than running the deleted strategy path.
 *
 * The resolver boundary (`data-import.ts`) applies the SAME
 * coercion so a v9 bundle carrying the retired kind is corrected even when the
 * schemaVersion-equals path skips this migration.
 */
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
  // Absent / retired-kind / malformed → taxEfficient.
  return {
    ...payload,
    overrides: {
      ...overridesRecord,
      withdrawalStrategy: { kind: 'taxEfficient' },
    },
  };
}

/**
 * `expenseCategory` v1 → v2: the category payload
 * gains an optional `isMedical?: boolean` marker. Additive — a v1 payload
 * that never carried it is a valid v2 payload as-is (absent ⇒ not medical),
 * making this an identity pass for clean data.
 *
 * It is NOT a bare identity: an imported / tampered v1 payload may already
 * carry a non-boolean `isMedical` (plaintext import bundles, or
 * a corrupt local payload validated only as `z.record(z.string(),
 * z.unknown())`). The flag becomes the canonical "is this medical?" signal
 * for the projection engine + future HSA routing, so a non-boolean value is
 * a CWE-20 hazard. This step SANITISES it at the boundary — DROPPING any
 * non-boolean `isMedical` (→ absent ⇒ not medical). Mirrors the
 * `contributionGrowthPct` hardening in `migrateAccountV3ToV4`.
 *
 * Total / idempotent / never-throws: every branch returns a payload.
 *
 * The migration is payload-only (it cannot see the aggregate id), so it
 * cannot flip the seeded `cat-medical` row's flag — the id-keyed backfill
 * in `lib/expense-categories-bootstrap.ts` does that; the two are
 * complementary.
 */
function migrateExpenseCategoryV1ToV2(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!('isMedical' in payload)) return payload;
  if (typeof payload.isMedical === 'boolean') return payload;
  // Non-boolean stored value → drop to the not-medical default (absent).
  const next = { ...payload };
  delete next.isMedical;
  return next;
}

/**
 * `accountBalance` v1 → v2 — the aggregate's first migration step.
 *
 * v2 adds two sparse-optional per-year Roth conversion amounts. A v1 record
 * predates both keys and therefore cannot carry them, so this is an IDENTITY
 * pass on every record stored by this app. It sanitises anyway because an
 * import bundle or a hand-edited payload can arrive carrying the keys with a
 * value the Roth engine must never read as money.
 *
 * An invalid amount is mapped to `undefined` and its key is KEPT — never
 * deleted (fields are removed only by mapping them to `undefined` — never
 * delete keys that older snapshots might still carry).
 * Total and idempotent: a payload that is not a plain object, or that carries
 * nothing to fix, is returned by reference and nothing throws.
 */
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



// Current schema version of every aggregate type. Shape changes bump
// `current` and add a migration entry.
//
// This block is also read TEXTUALLY (not imported) by
// scripts/check-schema-not-ahead.mjs, the deploy preflight that refuses to ship
// a build whose `current` versions are ahead of origin/main. Renaming or
// reshaping the declaration makes that guard throw rather than pass — update it
// (and scripts/test/schema-ahead-guard.test.mjs) in the same change.
const REGISTRY: Record<AggregateType, Registry> = {
  household: { current: 1, migrations: {} },
  householdMember: { current: 1, migrations: {} },
  // `account` schemaVersion stayed at 6 after the dated Roth facts moved to the
  // annual balance rows, which RETIRED `rothIraConversionLots` and
  // `designatedRothInPlanRolloverLots`. Nothing reads either key any more —
  // both dated Roth facts are derived from the annual balance rows — so a stored
  // payload that still carries one is inert, exactly the "well-defined absent
  // semantics" the `expense` / `discretionaryGlide` no-bump precedents rest on.
  // A step mapping the keys to `undefined` would be functionally a no-op —
  // re-saving an account already rebuilds the payload from scratch and drops
  // the stale key, with or without a migration step — so the schema-ahead
  // guard a bump buys protects nothing here, regardless of how many accounts
  // already carry the retired keys. Forward migration (AGENTS.md "Aggregate
  // schema evolution", step 3) is INTENTIONALLY OMITTED for these two keys.
  // Re-saving an account drops the stale key, because the editor rebuilds the
  // payload from scratch. Their disposition is UNCHANGED by the v6→v7 bump
  // below — that step does not touch them.
  // Revisit at the next `account` schema change. Reopen
  // trigger: any read path starts depending on `rothIraConversionLots` or
  // `designatedRothInPlanRolloverLots` again, or the account editor stops
  // rebuilding the payload from scratch (so a save no longer drops them) —
  // either makes a stored stale key observable, and the removal then needs a
  // bump plus a forward migration.
  // The v6→v7 step is the next `account` schema change the note above named as
  // the revisit trigger. The two retired lot keys above are NOT sanitised or
  // touched by `migrateAccountV6ToV7` — only the unrelated Roth-basis DOLLAR
  // TOTALS (`rothIraRegularContributionBasis` / `designatedRothBasis`) are
  // removed by that step, because an older build still reads THEM (see the
  // step's own docstring). The lot keys' no-bump disposition stands as
  // recorded above.
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
  // `accountBalance` schemaVersion intentionally stays at 2 after gaining the
  // per-year in-plan Roth rollover pair: additive sparse-optional with the same
  // absent-means-nothing-recorded semantics as the conversion pair, so no data
  // transform is needed. The runtime fact adapter re-validates every amount and
  // year at the consumption boundary regardless of schema version, which is what
  // actually guards an imported value — a migration sanitiser would duplicate it.
  // Forward migration INTENTIONALLY OMITTED (AGENTS.md "Aggregate schema
  // evolution", step 3). The v1→v2 step below predates this note.
  accountBalance: {
    current: 2,
    migrations: { 1: migrateAccountBalanceV1ToV2 },
  },
  socialSecurityBenefit: { current: 1, migrations: {} },
  expenseCategory: {
    current: 2,
    migrations: { 1: migrateExpenseCategoryV1ToV2 },
  },
  // `expense` schemaVersion intentionally stays at 1 after `hsaQualified`
  // was added: it is additive sparse-optional with well-defined absent
  // semantics (absent ⇒ not qualified) — no data transform is needed.
  // Mirrors the `discretionaryGlide` additive-optional precedent. Forward
  // migration is INTENTIONALLY OMITTED (AGENTS.md "Aggregate schema
  // evolution", step 3).
  expense: { current: 1, migrations: {} },
  incomeStream: { current: 1, migrations: {} },
  // `scenario` schemaVersion intentionally stays at 9 after the removal of the
  // `annualInvestmentCostPct` override: the key was sparse-optional and nothing reads it any more, so a copy
  // left in an already-synced payload is inert — `mergeFirstWins` carries
  // unknown keys into an object no consumer inspects. Bumping would only make
  // older clients REJECT newer scenarios for a key that no longer means
  // anything. Adding or removing a sparse-optional field needs no forward
  // migration. Forward migration is INTENTIONALLY OMITTED (AGENTS.md
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
      // Gap in the chain: fail open and pass through. The runtime never
      // blocks reads on a missing migration; warn so the dev notices.
      console.warn(
        `[migrations] Missing forward migration for ${type} v${v} → v${v + 1}; passing through`,
      );
      break;
    }
    result = fn(result);
  }
  return result as unknown as PayloadByType[T];
}
