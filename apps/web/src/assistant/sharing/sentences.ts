/**
 * The sentences the consent dialog and the Settings card both show. They live
 * here, in a module that imports neither, so the two surfaces cannot drift; the
 * rows that describe what they sent import the same constants.
 */

/** Shown in the dialog and on the Settings card. */
export const MODEL_PROVIDER_STATEMENT =
  'Anything the assistant reads goes to its model provider, unless it runs a local model.';

/** Shown in the dialog and on the Settings card. */
export const GENEROUS_DEFAULTS_STATEMENT =
  'The defaults are generous: everything you can share is on. Turn off whatever you would rather the assistant not see.';

export const NEVER_SHARED_HEADING = 'Never shared, whatever you choose';

/** What no switch can release; docs/security.md carries the authoritative list. */
export const NEVER_SHARED_ITEMS: readonly string[] = [
  'Email addresses',
  'Last names',
  'Your household name',
  'Your account record and your sign-in and security history',
  'Encryption keys and encrypted data',
  'Device identifiers',
];

export const SHARING_GROUP_HEADING = 'What the assistant may read';
export const SESSION_GROUP_HEADING = 'Session';

export const CONSENT_DIALOG_TITLE = 'Let this assistant read your plan?';
export const CONSENT_CHOICES_FIXED_STATEMENT =
  'These choices last until the assistant disconnects. To change them, disconnect and pair again.';

/** Shown in place of the assistant's name when the bridge did not report one. */
export const UNKNOWN_ASSISTANT_NAME = 'an assistant';

/** Label of the keep-signed-in switch, word for word. */
export const KEEP_SIGNED_IN_LABEL = 'Let assistant activity keep me signed in';

function minutesPhrase(idleMinutes: number | null): string {
  if (idleMinutes === null) return 'after a period';
  return idleMinutes === 1 ? 'after 1 minute' : `after ${idleMinutes} minutes`;
}

/**
 * The text under the keep-signed-in switch. `idleMinutes` is the configured idle timeout (what
 * `IdleTimer` reads), or `null` when this build has no idle sign-out.
 */
export function keepSignedInDescription(idleMinutes: number | null): string {
  return (
    `Off: Retivo signs you out ${minutesPhrase(idleMinutes)} without your own clicks or key presses, ` +
    'even while the assistant is working. ' +
    'On: each completed assistant request counts like a click, so an unattended assistant can keep this session open ' +
    'for as long as it keeps working, in every tab. ' +
    'Signing out, Disconnect, closing this tab and locking still end the session.'
  );
}

/** How the dialog names the assistant: its self-reported name is unverified. */
export function assistantIntroduction(clientName: string): string {
  const name = clientName === '' ? UNKNOWN_ASSISTANT_NAME : clientName;
  return `${name} wants to read your plan. The assistant reported this name itself, and Retivo cannot verify it.`;
}
