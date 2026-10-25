/**
 * ACA PTC applicable-percentage bands (IRS Rev Proc Table 2) and HHS federal poverty level parameters; the
 * `alaska` / `hawaii` pairs are read by `fplDollarsForRegion` when a scenario sets `acaFplRegion`.
 */

import type { CalibrationSnapshot } from './calibration';
import type { AcaPtcTable } from './aca-ptc';

// 2024, IRA-expanded regime (§9661 ARPA as extended by the Inflation Reduction Act): IRS Rev Proc 2023-29
// Table 2, https://www.irs.gov/pub/irs-drop/rp-23-29.pdf. FPL: HHS 2023 guidelines (prior-year lag, Rev Proc 2014-37 §4.02).
const table2024: AcaPtcTable = {
  regime: 'ira-expanded',
  fpl: {
    base: 14_580,
    increment: 5_140,
    // Alaska / Hawaii: 2023 HHS guidelines (88 FR 3424); only historical projection years use 2024.
    alaska: { base: 18_210, increment: 6_430 },
    hawaii: { base: 16_770, increment: 5_910 },
  },
  bands: [
    { fplFloorPct: 100, fplCeilingPct: 150, floorContributionPct: 0, ceilingContributionPct: 0 },
    { fplFloorPct: 150, fplCeilingPct: 200, floorContributionPct: 0, ceilingContributionPct: 0.02 },
    { fplFloorPct: 200, fplCeilingPct: 250, floorContributionPct: 0.02, ceilingContributionPct: 0.04 },
    { fplFloorPct: 250, fplCeilingPct: 300, floorContributionPct: 0.04, ceilingContributionPct: 0.06 },
    { fplFloorPct: 300, fplCeilingPct: 400, floorContributionPct: 0.06, ceilingContributionPct: 0.085 },
    // 400%+: flat 8.5% cap, no cliff.
    { fplFloorPct: 400, fplCeilingPct: Infinity, floorContributionPct: 0.085, ceilingContributionPct: 0.085 },
  ],
};

// 2025, IRA-expanded regime: IRS Rev Proc 2024-35 Table 2, https://www.irs.gov/pub/irs-drop/rp-24-35.pdf.
// FPL: HHS 2024 guidelines (prior-year lag).
const table2025: AcaPtcTable = {
  regime: 'ira-expanded',
  fpl: {
    base: 15_060,
    increment: 5_380,
    // Alaska / Hawaii: 2024 HHS guidelines (89 FR 2961).
    alaska: { base: 18_810, increment: 6_730 },
    hawaii: { base: 17_310, increment: 6_190 },
  },
  bands: [
    { fplFloorPct: 100, fplCeilingPct: 150, floorContributionPct: 0, ceilingContributionPct: 0 },
    { fplFloorPct: 150, fplCeilingPct: 200, floorContributionPct: 0, ceilingContributionPct: 0.02 },
    { fplFloorPct: 200, fplCeilingPct: 250, floorContributionPct: 0.02, ceilingContributionPct: 0.04 },
    { fplFloorPct: 250, fplCeilingPct: 300, floorContributionPct: 0.04, ceilingContributionPct: 0.06 },
    { fplFloorPct: 300, fplCeilingPct: 400, floorContributionPct: 0.06, ceilingContributionPct: 0.085 },
    { fplFloorPct: 400, fplCeilingPct: Infinity, floorContributionPct: 0.085, ceilingContributionPct: 0.085 },
  ],
};

// 2026, pre-ARPA regime (the IRA expansion expires after 2025): IRS Rev Proc 2025-25 Table 2,
// https://www.irs.gov/pub/irs-drop/rp-25-25.pdf. FPL: HHS 2025 guidelines (prior-year lag).
const table2026: AcaPtcTable = {
  regime: 'pre-arpa',
  fpl: {
    base: 15_650,
    increment: 5_500,
    // Alaska / Hawaii: 2025 HHS guidelines (90 FR 5917), the primary planning-year schedule (later years clamp to 2026).
    alaska: { base: 19_550, increment: 6_880 },
    hawaii: { base: 17_990, increment: 6_330 },
  },
  bands: [
    // Pre-ARPA 6-band schedule: no 400%+ band, so strictly above 400% is ineligible (the engine handles it).
    { fplFloorPct: 100, fplCeilingPct: 133, floorContributionPct: 0.0210, ceilingContributionPct: 0.0210 },
    { fplFloorPct: 133, fplCeilingPct: 150, floorContributionPct: 0.0314, ceilingContributionPct: 0.0419 },
    { fplFloorPct: 150, fplCeilingPct: 200, floorContributionPct: 0.0419, ceilingContributionPct: 0.0660 },
    { fplFloorPct: 200, fplCeilingPct: 250, floorContributionPct: 0.0660, ceilingContributionPct: 0.0844 },
    { fplFloorPct: 250, fplCeilingPct: 300, floorContributionPct: 0.0844, ceilingContributionPct: 0.0996 },
    { fplFloorPct: 300, fplCeilingPct: 400, floorContributionPct: 0.0996, ceilingContributionPct: 0.0996 },
  ],
};

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
