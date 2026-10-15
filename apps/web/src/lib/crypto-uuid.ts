/**
 * Random identifier for client-generated aggregate IDs, sync mutation IDs and
 * device IDs. Always a UUID, always from the platform's secure random source.
 *
 * Uses `crypto.randomUUID()` when present; otherwise builds a version 4 UUID
 * from `crypto.getRandomValues()`. Throws when neither exists — a runtime
 * without WebCrypto has no CSPRNG, and degrading to a weak id is worse than
 * failing loudly. Every supported browser and Node 24 provide both.
 */
export function cryptoUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(new ArrayBuffer(16));
    crypto.getRandomValues(bytes);
    // RFC 4122: version 4 in the high nibble of byte 6, variant 10xx in byte 8.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('No secure random source available (crypto.randomUUID / crypto.getRandomValues)');
}
