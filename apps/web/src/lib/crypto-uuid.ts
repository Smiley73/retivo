/**
 * Random UUID for client-generated aggregate, mutation and device ids, from
 * `crypto.randomUUID()` or else a v4 built from `crypto.getRandomValues()`. It
 * throws when neither exists: degrading to a weak id is worse than failing loudly.
 */
export function cryptoUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(new ArrayBuffer(16));
    crypto.getRandomValues(bytes);
    // RFC 4122: version 4 in byte 6's high nibble, variant 10xx in byte 8.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('No secure random source available (crypto.randomUUID / crypto.getRandomValues)');
}
