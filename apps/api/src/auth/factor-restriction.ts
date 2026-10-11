/**
 * The password-reset "restriction window" for newly-enrolled factors
 * (the compensating control for the reset→inbox-
 * takeover path). An
 * attacker who owns the mailbox resets the password, signs in, and satisfies
 * an emailed-code step-up (the floor for an account with no enrolled factor) —
 * step-up alone does not close that variant, because the emailed code IS
 * the thing that gets satisfied. This window is the compensating control.
 *
 * A factor enrolled while the window is open is durably marked restricted at
 * WRITE time (see `passkey.controller.ts#registerFinish` /
 * `mfa.controller.ts#mfaTotpEnrollConfirm`) — restriction is state on the
 * factor row, never re-derived from these timestamps at read time, so it
 * stays restricted after the window closes until an explicit
 * `confirm-restriction` lift.
 *
 * Window boundaries — the pending and completed branches are resolved
 * INDEPENDENTLY and unioned (never one superseding the other), because both
 * `User.currentResetToken` / `User.passwordResetRequestOpenedAt` are
 * overwritten by every new reset request (`resetSendUpdate`), including one
 * fired and abandoned AFTER an earlier reset already completed:
 *  - Opens when a reset is REQUESTED (`User.currentResetToken` set,
 *    `User.passwordResetRequestOpenedAt` stamped by `resetSendUpdate`).
 *    Bounded to `RESET_TTL_SEC` after the request even when the link is never
 *    consumed — the reset TOKEN's own TTL — so a stale/abandoned
 *    `currentResetToken` on a long-dormant account (nothing else clears it
 *    short of a consume) cannot restrict factors forever.
 *  - Closes `FACTOR_RESTRICTION_WINDOW_SEC` after the reset COMPLETES
 *    (`User.lastPasswordResetCompletedAt`, stamped by `resetConsumeUpdate`)
 *    — the inbox-takeover sign-in happens AFTER the request, so the window
 *    must stay open past consume, not just up to it. Evaluated against
 *    `User.lastPasswordResetCompletedRequestedAt` — the request instant
 *    `resetConsumeUpdate` durably pairs with the completion — NOT the
 *    current `passwordResetRequestOpenedAt`, so a later, never-consumed
 *    request can only ever widen this window, never end it early.
 */
import { RESET_TTL_SEC } from './password-reset.service.js';
import type { UserRow } from '../dynamo/types.js';

/**
 * Post-completion restriction window: 24 hours gives the legitimate owner a full day —
 * spanning at least one normal login — to notice the reset they didn't
 * request and act, while keeping the window tied to the actual reset event
 * rather than lingering indefinitely.
 */
export const FACTOR_RESTRICTION_WINDOW_SEC = 24 * 60 * 60;

/** The subset of `UserRow` {@link resolveOpenResetWindow} reads. */
export type ResetWindowUser = Pick<
  UserRow,
  | 'currentResetToken'
  | 'passwordResetRequestOpenedAt'
  | 'lastPasswordResetCompletedAt'
  | 'lastPasswordResetCompletedRequestedAt'
>;

/**
 * The still-open reset window, if any, that a factor enrolled at `nowMs`
 * falls inside — or `null` when none is open. `requestedAt` is the ISO stamp
 * of the reset REQUEST that opened it (never the completion time) —
 * `passkey.controller.ts` / `mfa.controller.ts` stamp it onto the newly-
 * restricted factor row so a later `confirm-restriction` lift can compare a
 * proving factor's own enrollment against the correct instant. When both the
 * pending and completed branches are open at once, the EARLIER of the two
 * `requestedAt`s is returned, so a later abandoned request can only widen
 * this comparison instant, never move it forward and let more factors
 * "predate" it.
 */
export function resolveOpenResetWindow(
  user: ResetWindowUser,
  nowMs: number,
): { requestedAt: string } | null {
  let openRequestedAt: string | null = null;
  let openRequestedMs = Infinity;
  const consider = (requestedAtIso: string, requestedMs: number): void => {
    if (requestedMs < openRequestedMs) {
      openRequestedAt = requestedAtIso;
      openRequestedMs = requestedMs;
    }
  };

  // Pending, unconsumed request — bounded to the reset token's own TTL so an
  // abandoned `currentResetToken` (only a successful consume ever clears it)
  // cannot keep the window open forever on a long-dormant account.
  const requestedAtIso = user.passwordResetRequestOpenedAt;
  if (requestedAtIso) {
    const requestedMs = Date.parse(requestedAtIso);
    if (
      Number.isFinite(requestedMs) &&
      user.currentResetToken &&
      nowMs - requestedMs < RESET_TTL_SEC * 1000
    ) {
      consider(requestedAtIso, requestedMs);
    }
  }

  // Completed reset, still inside the post-completion window. Resolved from
  // `lastPasswordResetCompletedRequestedAt` — the request instant
  // `resetConsumeUpdate` durably pairs with the completion — NEVER from the
  // current `passwordResetRequestOpenedAt` above, which a later, never-
  // consumed reset request overwrites. That decoupling is the whole point:
  // without it, a second, abandoned reset request would close this branch
  // early by making the completion look like it predates the (unrelated)
  // newer request. Falls back to the completion stamp itself for a row
  // written before this field existed.
  const completedAtIso = user.lastPasswordResetCompletedAt;
  if (completedAtIso) {
    const completedMs = Date.parse(completedAtIso);
    if (Number.isFinite(completedMs) && nowMs - completedMs < FACTOR_RESTRICTION_WINDOW_SEC * 1000) {
      const completedRequestedAtIso = user.lastPasswordResetCompletedRequestedAt ?? completedAtIso;
      const completedRequestedMs = Date.parse(completedRequestedAtIso);
      if (Number.isFinite(completedRequestedMs)) {
        consider(completedRequestedAtIso, completedRequestedMs);
      }
    }
  }

  return openRequestedAt !== null ? { requestedAt: openRequestedAt } : null;
}
