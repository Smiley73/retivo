// Household and household-member aggregate payloads.

export interface HouseholdPayload extends Record<string, unknown> {
  name: string;
  currency: string;
  createdAt: string;
}

export interface HouseholdMemberPayload extends Record<string, unknown> {
  isPrimary: boolean;
  firstName: string;
  lastName: string;
  email: string;
  birthdate: string;
}
