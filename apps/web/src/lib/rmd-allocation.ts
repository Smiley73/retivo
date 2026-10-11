/**
 * Per-account proportional RMD allocation using the largest-remainder method.
 *
 * Extracted from rmd.ts to keep that file within the shape limit.
 * The largest-remainder method guarantees every share ≥ 0; a Math.round-per-share
 * algorithm could produce negative shares when ownerRmdCents was small and the
 * last account absorbed a negative residue.
 *
 * Engine: apps/web/src/lib/rmd.ts
 */

/**
 * Proportionally allocate `ownerRmdCents` across `qualifyingBalances` using
 * the largest-remainder (Hamilton) method.
 *
 * Algorithm:
 * 1. Compute exact fractional share for each account.
 * 2. Floor every share to integer cents (sum ≤ ownerRmdCents).
 * 3. Distribute remaining cents one-at-a-time to accounts with the largest
 *    fractional remainders (ties broken by largest balance, then stable
 *    input order).
 *
 * Invariants:
 * - sum(result values) === ownerRmdCents exactly.
 * - Every allocated value ≥ 0 (no negative shares possible).
 */
export function allocateProportional(
  qualifyingBalances: Array<{ id: string; balanceCents: number }>,
  ownerRmdCents: number,
): Record<string, number> {
  if (qualifyingBalances.length === 0) return {};

  const total = qualifyingBalances.reduce((s, a) => s + a.balanceCents, 0);

  // Step 1 + 2: compute floored shares and fractional remainders
  const entries = qualifyingBalances.map((a, idx) => {
    const exact = (a.balanceCents / total) * ownerRmdCents;
    const floored = Math.floor(exact);
    return { id: a.id, balanceCents: a.balanceCents, floored, remainder: exact - floored, idx };
  });

  // Step 3: how many extra cents remain after flooring?
  const flooredSum = entries.reduce((s, e) => s + e.floored, 0);
  let residue = ownerRmdCents - flooredSum; // always ≥ 0

  // Sort by largest remainder, then largest balance, then original input order (stable).
  const sorted = [...entries].sort(
    (a, b) =>
      b.remainder - a.remainder ||
      b.balanceCents - a.balanceCents ||
      a.idx - b.idx,
  );

  const result: Record<string, number> = {};
  for (const e of entries) result[e.id] = e.floored;
  for (const e of sorted) {
    if (residue <= 0) break;
    result[e.id] += 1;
    residue -= 1;
  }

  return result;
}
