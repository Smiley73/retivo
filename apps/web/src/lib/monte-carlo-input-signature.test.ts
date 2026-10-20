/**
 * Pins the Plan Stress Test signature string and the seed drawn from it. The
 * expected values were computed with the code as it stood in
 * `components/PlanStressTestSection.tsx`, before it moved here, over inputs that
 * exercise every folded field (ledger fingerprints, a glide path, events in
 * unsorted order, a set of excluded indices, guardrails, a tax context). Running
 * the same input twice would not notice a changed fold order; a frozen value does.
 *
 * The tax context is synthetic with fixed `asOfDate` strings, because the real
 * calibration bundle's dates are folded into the signature and would break the
 * pin at every yearly tax refresh.
 */
import { describe, expect, it } from 'vitest';
import type { MonteCarloInput } from './monte-carlo';
import { autoRunSeed, hashMcInput } from './monte-carlo-input-signature';
import { MC_PATH_COUNT } from './monte-carlo-scenario-input';
import { seedFromString } from './sfc32';

const arr = (n: number, f: (i: number) => number) => Float64Array.from({ length: n }, (_v, i) => f(i));

function buildSeedVectorInputs(): Array<{ name: string; input: MonteCarloInput; cbpFailed: boolean }> {
  const steps = 36;
  const full = {
    portfolioToday: 812_345.67,
    accountMcLedger: [
      {
        id: 'acct-a',
        ownerId: 'm1',
        initialPre: 500_000,
        initialPost: 0,
        contribPre: arr(steps, (i) => (i < 12 ? 1500 + i : 0)),
        contribPost: arr(steps, () => 0),
        deposit: arr(steps, (i) => (i >= 24 ? 250.5 : 0)),
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
        assetMixSeries: [
          { stocksPct: 60, bondsPct: 30, cashPct: 10 },
          { stocksPct: 55.5, bondsPct: 34.5, cashPct: 10 },
          { stocksPct: 50, bondsPct: 40, cashPct: 10 },
        ],
        cbpPlanningReturnPct: null,
        taxTreatment: 'PRE_TAX',
        accountType: 'TRADITIONAL_401K',
      },
      {
        id: 'acct-b',
        ownerId: 'm1',
        initialPre: 0,
        initialPost: 312_345.67,
        contribPre: arr(steps, () => 0),
        contribPost: arr(steps, (i) => (i < 12 ? 400 : 0)),
        deposit: arr(steps, () => 0),
        assetMix: { stocksPct: 80, bondsPct: 20, cashPct: 0 },
        assetMixSeries: null,
        cbpPlanningReturnPct: 4.5,
        taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE',
      },
    ],
    annualContribution: 21_000,
    firstYear: 2026,
    retirementYear: 2027,
    horizonYear: 2028,
    monthlyExpenseBase: arr(steps, (i) => 5000 + i),
    monthlyExpenseBucketsBase: undefined,
    ssByYear: [0, 20_000, 24_000],
    incomeByYear: [0, 0, 5_000],
    scenarioInflationPct: 2.5,
    primaryRetirementMonth0: 4,
    pathCount: 1000,
    seed: 1,
    strategyKind: 'taxEfficient',
    customTiers: undefined,
    excludedIndices: new Set([3, 1]),
    tracksInflationIncomeByYear: [false, true, false],
    events: [
      { month: 30, amount: 10_000, kind: 'lumpSum' },
      { month: 6, amount: -5_000, kind: 'lumpSum' },
    ],
    downturnGuardrails: { enabled: true, bandPct: 20 },
    guardrailEffectiveTaxRate: 0.12,
    guardrailBaselineRealNetNeedByYear: [60_000, 61_000, 62_500],
    guardrailBaselineTotalRealByYear: [70_000, 71_000, 72_500],
    guardrailEssentialRealByYear: [40_000, 40_000, 41_000],
    taxContext: {
      taxBundle: {
        federalTax: { metadata: { asOfDate: '2000-01-01' } },
        irmaa: { metadata: { asOfDate: '2000-02-02' } },
        acaPtc: { metadata: { asOfDate: '2000-03-03' } },
      },
      filingStatus: 'MFJ',
      householdSize: 2,
      members: [{ memberId: 'm1', isoBirthdate: '1965-03-15', onMedicare: false, hasAcaCoverage: true, extra: 'dropped' }],
      healthCoverageMonths: { perMember: { m1: { 2030: { marketplaceMonths: 7 } } } },
      magiBootstrapLookbackMinus2: 90_000,
    },
  } as unknown as MonteCarloInput;
  const bare = {
    portfolioToday: 250_000,
    accountMcLedger: [
      {
        id: 'only',
        ownerId: 'm1',
        initialPre: 0,
        initialPost: 250_000,
        contribPre: arr(steps, () => 0),
        contribPost: arr(steps, () => 0),
        deposit: arr(steps, () => 0),
        assetMix: { stocksPct: 50, bondsPct: 50, cashPct: 0 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE',
      },
    ],
    annualContribution: 0,
    firstYear: 2026,
    retirementYear: 2026,
    horizonYear: 2028,
    monthlyExpenseBase: arr(steps, () => 3000),
    ssByYear: [0, 0, 0],
    incomeByYear: [0, 0, 0],
    pathCount: 1000,
    seed: 1,
  } as unknown as MonteCarloInput;
  return [
    { name: 'full', input: full, cbpFailed: false },
    { name: 'full-cbp-failed', input: full, cbpFailed: true },
    { name: 'bare', input: bare, cbpFailed: false },
  ];
}

/** First 16 hex characters of the signature's SHA-256, so the long string is pinned without being pasted. */
async function digest(signature: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)));
  return Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const PINNED = {
  full: { digest: '2458dd525b5c08567691293d04990fc8', length: 2417, seed: 651895378 },
  'full-cbp-failed': { digest: 'cfe913c972c3a7ea8e76c40e0fbfd647', length: 2416, seed: 1672800711 },
  bare: { digest: 'e4363e2cc5d2f409c033c4783db2ca9e', length: 1205, seed: 2636599006 },
} as const;

describe('hashMcInput and autoRunSeed', () => {
  it.each(buildSeedVectorInputs())('$name reproduces the signature and seed computed before the move', async ({ name, input, cbpFailed }) => {
    const pinned = PINNED[name as keyof typeof PINNED];
    const signature = hashMcInput(input, cbpFailed);
    expect(signature).toHaveLength(pinned.length);
    expect(await digest(signature)).toBe(pinned.digest);
    expect(seedFromString(signature)).toBe(pinned.seed);
    expect(autoRunSeed(input, cbpFailed)).toBe(pinned.seed);
  });

  it('pins the exact signature of the small input, field order included', () => {
    const [, , bare] = buildSeedVectorInputs();
    expect(hashMcInput(bare!.input, false).startsWith('{"cbpFailed":false,"pathCount":10000,"portfolioToday":250000,"accountMcLedger":[{"id":"only"')).toBe(true);
    expect(hashMcInput(bare!.input, false).endsWith('"events":[],"taxFingerprint":null,"guardrailFingerprint":null}')).toBe(true);
  });

  it('stamps the shared path count, not the input’s own', () => {
    const [full] = buildSeedVectorInputs();
    const other = { ...full!.input, pathCount: 7 } as MonteCarloInput;
    expect(MC_PATH_COUNT).toBe(10_000);
    expect(hashMcInput(other, false)).toBe(hashMcInput(full!.input, false));
  });

  it('draws a different seed when the plan or the CBP flag changes', () => {
    const [full, failed] = buildSeedVectorInputs();
    expect(autoRunSeed(full!.input, false)).not.toBe(autoRunSeed(failed!.input, true));
    const edited = { ...full!.input, portfolioToday: full!.input.portfolioToday + 1 } as MonteCarloInput;
    expect(autoRunSeed(edited, false)).not.toBe(autoRunSeed(full!.input, false));
  });
});
