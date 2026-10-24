// Module-scope registry of the canonical device id so non-React helpers (mutation-queue) stamp the id the JWT carries.
// SyncProvider registers AuthContext's id on mount; a metadata-derived id could mismatch the JWT (`403 DEVICE_MISMATCH`).
let registered: string | null = null;

export function setRegisteredDeviceId(id: string): void {
  registered = id;
}

export function getRegisteredDeviceId(): string | null {
  return registered;
}
