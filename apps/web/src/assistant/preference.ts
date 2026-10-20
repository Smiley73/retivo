/**
 * The per-device opt-in for the AI assistant connector. Persisted in
 * localStorage keyed by user id exactly like the "Show beta features" switch
 * (`contexts/BetaFeaturesContext.tsx`), so it is per person and per device and
 * "Clear data on this device" already wipes it (blanket localStorage clear).
 * Off by default.
 */
const KEY_PREFIX = 'retivo.assistant.optIn.';

export function readAssistantOptIn(userId: string | null): boolean {
  if (userId === null || typeof localStorage === 'undefined') return false;
  return localStorage.getItem(`${KEY_PREFIX}${userId}`) === 'on';
}

export function writeAssistantOptIn(userId: string | null, on: boolean): void {
  if (userId === null || typeof localStorage === 'undefined') return;
  localStorage.setItem(`${KEY_PREFIX}${userId}`, on ? 'on' : 'off');
}
