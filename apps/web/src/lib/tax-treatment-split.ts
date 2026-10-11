/**
 * Tax-treatment split helper — turns an at-retirement balance + tax
 * treatment into pre/post buckets the kernel ledger consumes.
 *
 * Shared by the deterministic-side per-account ledger builder
 * (`balance-projection-runner-context.ts`) and the MC bundle's
 * per-account ledger entry builder (`balance-projection-bundle.ts`).
 * Kept in one place so the two files cannot diverge.
 *
 * MIXED accounts must pass explicit `mixedBuckets` so the kernel
 * uses the actual stored split (e.g. 70/30 from `projOut.preTax` /
 * `projOut.postTax`). A 50/50 fallback discards the real bucket data
 * the upstream `project()` already computes.
 */
import type { AccountPayload } from '../db/types';
import { assertNever } from './assert-never';

/**
 * Split an at-retirement (or at-firstYear, for the MC ledger) balance
 * into pre/post buckets by the account's tax treatment.
 *  - PRE_TAX → all pre (mixedBuckets ignored).
 *  - POST_TAX / HSA / ROTH → all post (mixedBuckets ignored).
 *  - MIXED → use `mixedBuckets` when supplied (the actual stored
 *    split); fall back to 50/50 only when buckets are unavailable.
 *    The per-account drawdown kernel then evolves the split through
 *    drawdown via the current pre/post ratio (no entry-ratio freeze).
 */
export function splitInitialByTaxTreatment(
  total: number,
  taxTreatment: AccountPayload['taxTreatment'],
  mixedBuckets?: { preTax: number; postTax: number } | null,
): { initialPre: number; initialPost: number } {
  // POST_TAX, HSA, and ROTH all seed the whole balance into the post bucket:
  // the HSA's balance is stored on the post-tax side (matching `seedBuckets` in
  // projection.ts and the demo HSA data). Qualified HSA withdrawals carry no
  // income tax; the pre-65 nonqualified penalty is enforced by account TYPE in
  // the tax-integration pass, independent of which bucket holds the balance.
  // Roth is post-tax funded and tax-free at withdrawal — same all-post seeding.
  if (
    taxTreatment === 'POST_TAX' ||
    taxTreatment === 'HSA' ||
    taxTreatment === 'ROTH'
  ) {
    return { initialPre: 0, initialPost: total };
  }
  if (taxTreatment === 'MIXED') {
    if (mixedBuckets) {
      const sum = mixedBuckets.preTax + mixedBuckets.postTax;
      // Scale buckets to `total` so callers can pass at-retirement total
      // (projOut.total) + stored bucket split safely even when the
      // bucket sum drifts from `total` by fp64 residue.
      if (sum > 0) {
        const preShare = mixedBuckets.preTax / sum;
        const pre = total * preShare;
        return { initialPre: pre, initialPost: total - pre };
      }
    }
    // Last-resort fallback when MIXED but no bucket data, so callers that
    // pass no buckets still run.
    const half = total / 2;
    return { initialPre: half, initialPost: total - half };
  }
  // PRE_TAX: whole balance is pre-tax.
  if (taxTreatment === 'PRE_TAX') {
    return { initialPre: total, initialPost: 0 };
  }
  return assertNever(taxTreatment);
}
