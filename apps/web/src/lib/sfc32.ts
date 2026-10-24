// sfc32 PRNG (Chris Doty-Humphrey), seeded from a 32-bit integer via splitmix32. Pure 32-bit math, so draws are bit-identical across engines.
// The Monte Carlo engine uses it for every random draw; never `Math.random` or Web Crypto in hot paths.

export interface Rng {
  next(): number;
  uniformInt(lo: number, hi: number): number;
}

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

/** A stable 32-bit seed from a string (FNV-1a), for the provider's deterministic "Reset" seed. Not cryptographic. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
