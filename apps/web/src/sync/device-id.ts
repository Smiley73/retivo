/**
 * Module-scope registration of the canonical device id so non-React
 * helpers (mutation-queue, ad-hoc utilities) can stamp mutations with
 * the same id the JWT carries. Source of truth lives in AuthContext
 * (localStorage `retivo.auth.deviceId`); SyncProvider re-registers
 * it on mount so the queue and the push body cannot drift apart.
 *
 * The previous design read the deviceId from IndexedDB metadata,
 * falling back to a fresh `crypto.randomUUID()` when the meta record
 * was missing. On a fresh device that fallback produced a deviceId
 * that did not match the JWT claim, and the API returned 403
 * DEVICE_MISMATCH on the first push.
 */
let registered: string | null = null;

export function setRegisteredDeviceId(id: string): void {
  registered = id;
}

export function getRegisteredDeviceId(): string | null {
  return registered;
}
