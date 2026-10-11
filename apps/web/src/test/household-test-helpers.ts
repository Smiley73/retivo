/**
 * Shared household-member fixtures for page-render tests that need to force
 * the projection runner's `NoPrimaryRetirementError` empty-data path. Two sub-causes collapse to the SAME catch branch:
 *  - no primary member at all → `deleteAllHouseholdMembers`
 *  - a primary member with no resolvable retirement date →
 *    `blankPrimaryMemberBirthdate` (an empty birthdate makes
 *    `retirementDate()` throw inside `resolveMemberRetirementDates`, caught
 *    there and folded to `null` — see the `!primaryRetIso` branch in
 *    `balance-projection-runner-context.ts`).
 */
import { deleteAggregateLocally, listAggregates, putAggregate } from '../db/store';
import type { HouseholdMemberPayload } from '../db/types';

/** Delete every seeded household member. */
export async function deleteAllHouseholdMembers(): Promise<void> {
  const members = await listAggregates('householdMember');
  await Promise.all(
    members.map((m) => deleteAggregateLocally('householdMember', m.id)),
  );
}

/** Blank the primary member's birthdate so no retirement date resolves,
 *  leaving the primary member itself in place. */
export async function blankPrimaryMemberBirthdate(): Promise<void> {
  const members = await listAggregates('householdMember');
  const primary = members.find(
    (m) => (m.payload as HouseholdMemberPayload).isPrimary,
  );
  if (!primary) {
    throw new Error('blankPrimaryMemberBirthdate: no primary member seeded');
  }
  await putAggregate('householdMember', {
    ...primary,
    payload: { ...(primary.payload as HouseholdMemberPayload), birthdate: '' },
  });
}
