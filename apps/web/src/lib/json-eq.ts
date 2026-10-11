/**
 * Structural JSON equality for payload fragments. `undefined` and `null`
 * compare equal (both serialize via `?? null`) because scenario-patch
 * deltas treat a missing optional and an explicit `null` clear-marker as
 * the same "absent" state at comparison time. Key order
 * matters (JSON.stringify is order-sensitive) — fine for the form-page
 * use case where both sides are built by the same code paths.
 *
 * Extracted from the identical per-page copies in IncomeFormPage /
 * ExpenseFormPage (code-quality remediation).
 */
export function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
