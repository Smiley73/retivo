/**
 * ACA PTC calibration constants — applicable figure bands (IRS Rev Proc Table 2)
 * and federal poverty level parameters (HHS annual poverty guidelines).
 *
 * FPL carries all three HHS regional schedules: `base`/`increment` = the 48
 * contiguous states + DC (the live default), plus the higher `alaska` /
 * `hawaii` pairs (read by `fplDollarsForRegion` on the
 * live planning path whenever a scenario sets `acaFplRegion`).
 */

import type { CalibrationSnapshot } from './calibration';
import type { AcaPtcTable } from './aca-ptc';

// ---------------------------------------------------------------------------
// 2024 — IRA-expanded regime (§9661 ARPA as extended by Inflation Reduction Act)
// Source: IRS Rev Proc 2023-29, Table 2
// https://www.irs.gov/pub/irs-drop/rp-23-29.pdf
// FPL: HHS 2023 poverty guidelines (prior-year lag per Rev Proc 2014-37 §4.02)
// ---------------------------------------------------------------------------
const table2024: AcaPtcTable = {
  regime: 'ira-expanded',
  fpl: {
    // HHS 2023 48-state guidelines
    base: 14_580,
    increment: 5_140,
    // HHS 2023 Alaska / Hawaii guidelines. Source: 2023 HHS Poverty
    // Guidelines (Federal Register 88 FR 3424), confirmed against the
    // published notice text (only historical projection years use 2024).
    alaska: { base: 18_210, increment: 6_430 },
    hawaii: { base: 16_770, increment: 5_910 },
  },
  bands: [
    // 100-150%: 0% contribution (IRA-expanded floor elimination)
    { fplFloorPct: 100, fplCeilingPct: 150, floorContributionPct: 0, ceilingContributionPct: 0 },
    // 150-200%: 0% → 2%
    { fplFloorPct: 150, fplCeilingPct: 200, floorContributionPct: 0, ceilingContributionPct: 0.02 },
    // 200-250%: 2% → 4%
    { fplFloorPct: 200, fplCeilingPct: 250, floorContributionPct: 0.02, ceilingContributionPct: 0.04 },
    // 250-300%: 4% → 6%
    { fplFloorPct: 250, fplCeilingPct: 300, floorContributionPct: 0.04, ceilingContributionPct: 0.06 },
    // 300-400%: 6% → 8.5%
    { fplFloorPct: 300, fplCeilingPct: 400, floorContributionPct: 0.06, ceilingContributionPct: 0.085 },
    // 400%+: flat 8.5% cap (IRA-expanded — no cliff)
    { fplFloorPct: 400, fplCeilingPct: Infinity, floorContributionPct: 0.085, ceilingContributionPct: 0.085 },
  ],
};

// ---------------------------------------------------------------------------
// 2025 — IRA-expanded regime (same statutory authority, updated FPL)
// Source: IRS Rev Proc 2024-35, Table 2
// https://www.irs.gov/pub/irs-drop/rp-24-35.pdf
// FPL: HHS 2024 poverty guidelines (prior-year lag)
// ---------------------------------------------------------------------------
const table2025: AcaPtcTable = {
  regime: 'ira-expanded',
  fpl: {
    // HHS 2024 48-state guidelines
    base: 15_060,
    increment: 5_380,
    // HHS 2024 Alaska / Hawaii guidelines. Source: 2024 HHS Poverty
    // Guidelines (Federal Register 89 FR 2961), confirmed against the
    // published notice text.
    alaska: { base: 18_810, increment: 6_730 },
    hawaii: { base: 17_310, increment: 6_190 },
  },
  bands: [
    // Bands identical to 2024 under IRA-expanded (percentages unchanged by Rev Proc)
    { fplFloorPct: 100, fplCeilingPct: 150, floorContributionPct: 0, ceilingContributionPct: 0 },
    { fplFloorPct: 150, fplCeilingPct: 200, floorContributionPct: 0, ceilingContributionPct: 0.02 },
    { fplFloorPct: 200, fplCeilingPct: 250, floorContributionPct: 0.02, ceilingContributionPct: 0.04 },
    { fplFloorPct: 250, fplCeilingPct: 300, floorContributionPct: 0.04, ceilingContributionPct: 0.06 },
    { fplFloorPct: 300, fplCeilingPct: 400, floorContributionPct: 0.06, ceilingContributionPct: 0.085 },
    { fplFloorPct: 400, fplCeilingPct: Infinity, floorContributionPct: 0.085, ceilingContributionPct: 0.085 },
  ],
};

// ---------------------------------------------------------------------------
// 2026 — pre-ARPA regime (IRA-expanded expansion expires 2025 per statute)
// Source: IRS Rev Proc 2025-25, Table 2
// https://www.irs.gov/pub/irs-drop/rp-25-25.pdf
// FPL: HHS 2025 poverty guidelines (prior-year lag)
// ---------------------------------------------------------------------------
const table2026: AcaPtcTable = {
  regime: 'pre-arpa',
  fpl: {
    // HHS 2025 48-state guidelines
    base: 15_650,
    increment: 5_500,
    // HHS 2025 Alaska / Hawaii guidelines. Source: 2025 HHS Poverty
    // Guidelines (Federal Register 90 FR 5917, published 2025-01-17), confirmed
    // against the published notice text. This is the primary planning-year
    // region schedule (future projection years clamp to 2026).
    alaska: { base: 19_550, increment: 6_880 },
    hawaii: { base: 17_990, increment: 6_330 },
  },
  bands: [
    // Pre-ARPA 6-band schedule (no open-ended cap band; 400% cliff reinstated)
    // Rev Proc 2025-25 Table 2 values
    // 100-133%: flat 2.10%
    { fplFloorPct: 100, fplCeilingPct: 133, floorContributionPct: 0.0210, ceilingContributionPct: 0.0210 },
    // 133-150%: 3.14% → 4.19%
    { fplFloorPct: 133, fplCeilingPct: 150, floorContributionPct: 0.0314, ceilingContributionPct: 0.0419 },
    // 150-200%: 4.19% → 6.60%
    { fplFloorPct: 150, fplCeilingPct: 200, floorContributionPct: 0.0419, ceilingContributionPct: 0.0660 },
    // 200-250%: 6.60% → 8.44%
    { fplFloorPct: 200, fplCeilingPct: 250, floorContributionPct: 0.0660, ceilingContributionPct: 0.0844 },
    // 250-300%: 8.44% → 9.96%
    { fplFloorPct: 250, fplCeilingPct: 300, floorContributionPct: 0.0844, ceilingContributionPct: 0.0996 },
    // 300-400%: flat 9.96%
    { fplFloorPct: 300, fplCeilingPct: 400, floorContributionPct: 0.0996, ceilingContributionPct: 0.0996 },
    // No 400%+ band — pre-ARPA cliff: strictly above 400% → ineligible (engine handles)
  ],
};

// ---------------------------------------------------------------------------
// Exported snapshot
// ---------------------------------------------------------------------------

export const ACA_PTC_PARAMETERS: CalibrationSnapshot<AcaPtcTable> = {
  values: {
    2024: table2024,
    2025: table2025,
    2026: table2026,
  },
  metadata: {
    source:
      'https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/prior-hhs-poverty-guidelines-federal-register-references/2023-hhs-poverty-guidelines, https://www.irs.gov/pub/irs-drop/rp-23-29.pdf, https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/prior-hhs-poverty-guidelines-federal-register-references/2024-hhs-poverty-guidelines, https://www.irs.gov/pub/irs-drop/rp-24-35.pdf, https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/prior-hhs-poverty-guidelines-federal-register-references/2025-hhs-poverty-guidelines, https://www.irs.gov/pub/irs-drop/rp-25-25.pdf',
    asOfDate: '2025-08-04',
    jurisdiction: 'US-federal',
  },
};
