/** Pins for MEDICARE_PREMIUMS, so a refresh that edits a figure without its
 *  citation fails here. */
import { describe, it, expect } from 'vitest';
import { IRMAA_TIERS } from './irmaa-tiers';
import { latestMedicarePremiums, MEDICARE_PREMIUMS } from './medicare-premiums';

describe('MEDICARE_PREMIUMS', () => {
  it('should_pin_the_published_Part_B_and_Part_D_premiums_for_2024_to_2026', () => {
    expect(MEDICARE_PREMIUMS.values).toEqual({
      2024: { partBStandardMonthly: 174.7, partDNationalBaseMonthly: 34.7 },
      2025: { partBStandardMonthly: 185, partDNationalBaseMonthly: 36.78 },
      2026: { partBStandardMonthly: 202.9, partDNationalBaseMonthly: 38.99 },
    });
  });

  it('should_pin_the_exact_asOfDate_and_jurisdiction', () => {
    expect(MEDICARE_PREMIUMS.metadata.asOfDate).toBe('2025-11-14');
    expect(MEDICARE_PREMIUMS.metadata.jurisdiction).toBe('US-federal');
  });

  it('should_cite_each_publication_in_publication_order', () => {
    const urls = MEDICARE_PREMIUMS.metadata.source.split(', ');
    expect(urls).toEqual([
      // Published 2023-07-31: 2024 Part D base premium.
      'https://www.cms.gov/files/document/july-31-2023-parts-c-d-announcement-pdf.pdf',
      // Published 2023-10-12: 2024 Part B premium.
      'https://www.cms.gov/newsroom/fact-sheets/2024-medicare-parts-b-premiums-and-deductibles',
      // Published 2024-07-29: 2025 Part D base premium.
      'https://www.cms.gov/files/document/july-29-2024-parts-c-d-announcement.pdf',
      // Published 2024-11-08: 2025 Part B premium.
      'https://www.cms.gov/newsroom/fact-sheets/2025-medicare-parts-b-premiums-and-deductibles',
      // Published 2025-07-28: 2026 Part D base premium.
      'https://www.cms.gov/files/document/july-28-2025-parts-c-d-announcement.pdf',
      // Published 2025-11-14: 2026 Part B premium (the snapshot's asOfDate).
      'https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles',
    ]);
  });

  it('should_agree_with_the_IRMAA_tier_2_Part_B_surcharge_each_year', () => {
    // The tier-2 Part B surcharge is 100% of the standard premium by
    // construction, so the two CMS tables cannot drift apart unseen.
    for (const [year, entry] of Object.entries(MEDICARE_PREMIUMS.values)) {
      expect(
        IRMAA_TIERS.values[Number(year)].bySingle[1].partBMonthly,
        `year ${year}`,
      ).toBe(entry.partBStandardMonthly);
    }
  });

  it('should_return_the_newest_year_with_its_figures', () => {
    expect(latestMedicarePremiums()).toEqual({
      year: 2026,
      partBStandardMonthly: 202.9,
      partDNationalBaseMonthly: 38.99,
    });
  });
});
