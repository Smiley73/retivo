/** Per-account proportional RMD allocation by largest remainder, which keeps every share >= 0. */

/**
 * Allocates `ownerRmdCents` across `qualifyingBalances`; shares sum to exactly `ownerRmdCents`.
 * Cents left after flooring go to the largest fractional remainders, ties by balance then input order.
 */
export function allocateProportional(
  qualifyingBalances: Array<{ id: string; balanceCents: number }>,
  ownerRmdCents: number,
): Record<string, number> {
  if (qualifyingBalances.length === 0) return {};

  const total = qualifyingBalances.reduce((s, a) => s + a.balanceCents, 0);

  const entries = qualifyingBalances.map((a, idx) => {
    const exact = (a.balanceCents / total) * ownerRmdCents;
    const floored = Math.floor(exact);
    return { id: a.id, balanceCents: a.balanceCents, floored, remainder: exact - floored, idx };
  });

  const flooredSum = entries.reduce((s, e) => s + e.floored, 0);
  let residue = ownerRmdCents - flooredSum; // always ≥ 0

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
