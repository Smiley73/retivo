// Social Security benefit aggregate payload; per-scenario claim-age and COLA overrides live on `ScenarioOverrides`.

export interface SocialSecurityBenefitPayload extends Record<string, unknown> {
  householdMemberId: string;
  pia: number | null;
  piaAsOfDate: string | null;
  notes: string | null;
}
