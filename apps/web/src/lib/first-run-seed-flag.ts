/**
 * Per-browser "the primary member was seeded here" flag.
 *
 * `retivo:primary-member-seeded:<householdId>` (value `'1'`, no personal data)
 * records that this browser saw the workspace populated, or queued the primary
 * member seed. A workspace with zero members *and* the flag is a deliberate
 * "Delete workspace data" on this browser, so the first-run check offers the
 * demo prompt without asking the server and never re-creates the member.
 *
 * Nothing removes it except the wholesale "Clear data on this device" wipe
 * (`localStorage.clear`). "Delete workspace data" leaves it on purpose — that
 * is what makes the wipe stick.
 */
const PRIMARY_MEMBER_SEEDED_KEY_PREFIX = 'retivo:primary-member-seeded:';

function seededKey(householdId: string): string {
  return `${PRIMARY_MEMBER_SEEDED_KEY_PREFIX}${householdId}`;
}

/** True when this browser already saw the workspace populated or queued the seed. */
export function hasPrimaryMemberSeeded(householdId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  return !!localStorage.getItem(seededKey(householdId));
}

/** Record that this browser saw the workspace populated or queued the seed. */
export function markPrimaryMemberSeeded(householdId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(seededKey(householdId), '1');
}
