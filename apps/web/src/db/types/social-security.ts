/**
 * Social Security benefit aggregate payload. Per-scenario Social Security
 * claim-age / COLA overrides live on `ScenarioOverrides` (scenario-overrides.ts).
 */

export interface SocialSecurityBenefitPayload extends Record<string, unknown> {
  householdMemberId: string;
  pia: number | null;
  piaAsOfDate: string | null;
  notes: string | null;
}
