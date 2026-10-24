// Turns a balance and tax treatment into the pre/post buckets the kernel ledger consumes, shared by the deterministic and MC ledger builders.

import type { AccountPayload } from '../db/types';
import { assertNever } from './assert-never';

/**
 * Splits a balance into pre/post buckets by tax treatment: PRE_TAX all pre; POST_TAX,
 * HSA and ROTH all post; MIXED by `mixedBuckets` (the stored split), with a 50/50
 * fallback only when they are unavailable, since 50/50 discards real bucket data.
 */
export function splitInitialByTaxTreatment(
  total: number,
  taxTreatment: AccountPayload['taxTreatment'],
  mixedBuckets?: { preTax: number; postTax: number } | null,
): { initialPre: number; initialPost: number } {
  // HSA's balance is stored on the post-tax side; the pre-65 nonqualified penalty is enforced by account type in the tax pass, not by bucket.
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
      // Scaled to `total` so fp64 residue in the bucket sum cannot drift it.
      if (sum > 0) {
        const preShare = mixedBuckets.preTax / sum;
        const pre = total * preShare;
        return { initialPre: pre, initialPost: total - pre };
      }
    }
    // Last resort for callers that pass no buckets.
    const half = total / 2;
    return { initialPre: half, initialPost: total - half };
  }
  if (taxTreatment === 'PRE_TAX') {
    return { initialPre: total, initialPost: 0 };
  }
  return assertNever(taxTreatment);
}
