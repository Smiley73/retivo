// Per-browser flag (`retivo:primary-member-seeded:<householdId>`, value '1') that this browser saw the workspace populated or queued the seed.
// Zero members plus the flag is a deliberate "Delete workspace data": the demo prompt is offered and the member is not re-created. Only "Clear data on this device" removes it.

const PRIMARY_MEMBER_SEEDED_KEY_PREFIX = 'retivo:primary-member-seeded:';

function seededKey(householdId: string): string {
  return `${PRIMARY_MEMBER_SEEDED_KEY_PREFIX}${householdId}`;
}

export function hasPrimaryMemberSeeded(householdId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  return !!localStorage.getItem(seededKey(householdId));
}

export function markPrimaryMemberSeeded(householdId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(seededKey(householdId), '1');
}
