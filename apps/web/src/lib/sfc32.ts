/**
 * sfc32 — Small Fast Counting PRNG (Chris Doty-Humphrey).
 *
 * Period ~2^128. Passes TestU01 BigCrush. Pure 32-bit integer math —
 * deterministic across JS engines, browsers, and Node. Seeded from a
 * 32-bit integer via splitmix32 to produce the four state words.
 *
 * Used by the Monte Carlo engine for all random draws. Never use
 * Math.random or Web Crypto in hot paths — bit-identical reproducibility
 * is required.
 */

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi] (inclusive both sides). */
  uniformInt(lo: number, hi: number): number;
}

/**
 * splitmix32 — used to expand a 32-bit seed into the four state words
 * sfc32 needs. Stable, fast, well-distributed for seeding purposes.
 */
function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function sfc32Raw(a: number, b: number, c: number, d: number): () => number {
  let s0 = a | 0;
  let s1 = b | 0;
  let s2 = c | 0;
  let s3 = d | 0;
  return () => {
    s0 |= 0;
    s1 |= 0;
    s2 |= 0;
    s3 |= 0;
    const t = (((s0 + s1) | 0) + s3) | 0;
    s3 = (s3 + 1) | 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) | 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s2 = (s2 + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed: number): Rng {
  const sm = splitmix32(seed >>> 0);
  const raw = sfc32Raw(sm(), sm(), sm(), sm());
  return {
    next: raw,
    uniformInt(lo, hi) {
      if (hi < lo) {
        throw new RangeError(`uniformInt: hi (${hi}) < lo (${lo})`);
      }
      const span = hi - lo + 1;
      return lo + Math.floor(raw() * span);
    },
  };
}

/**
 * Derive a stable 32-bit seed from arbitrary input string. Used by the
 * Monte Carlo provider to produce the deterministic "Reset" seed from
 * the input hash. Not a cryptographic hash — just a stable spread.
 *
 * FNV-1a 32-bit. ~10 LOC, no external deps.
 */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
