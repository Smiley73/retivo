/**
 * Deep structural equality for engine results (`DrawdownYear` rows hold Maps and
 * nested objects). Map and Set compare order-insensitively; `NaN` equals `NaN` and
 * `0` equals `-0` (the engine normalises `-0` in places); an own key holding
 * `undefined` equals an absent one. Acyclic data only.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true; // also 0 === -0
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    return elementsEqual(a as unknown as ArrayLike<unknown>, b as unknown as ArrayLike<unknown>);
  }
  if (Array.isArray(a) && Array.isArray(b)) return elementsEqual(a, b);
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !structurallyEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
  }
  return recordsEqual(a as Record<string, unknown>, b as Record<string, unknown>);
}

function elementsEqual(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!structurallyEqual(a[i], b[i])) return false;
  }
  return true;
}

function recordsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!structurallyEqual(a[key], b[key])) return false;
  }
  return true;
}
