/** JSON equality where `undefined` and `null` are equal (both mean "absent" in scenario-patch deltas); key order matters. */
export function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
