/**
 * Validates and sanitizes redirect target strings.
 *
 * A target is safe only when it starts with exactly one `/` (never `//`,
 * which is protocol-relative), carries no C0 control character or DEL, and
 * — once resolved against the page's own origin by the same URL parser the
 * browser will eventually navigate with — resolves to that same origin. The
 * control-character check alone is not enough: the WHATWG URL parser strips
 * tab, LF and CR from a target *before* deciding where the authority begins,
 * so a target such as `/<TAB>/evil.example` looks like a same-origin path
 * under prefix matching while the browser actually navigates to
 * `//evil.example` on an attacker origin. Re-parsing the string the way the
 * consumer's navigation will parse it, and comparing the resulting origin,
 * is what actually closes that gap; the control-character rejection is the
 * cheap guard on top of it. Accepted targets are returned byte-identical to
 * the input — never a reserialized/reparsed form — because `safeReturnTo`
 * depends on that identity (see below).
 *
 * See CODING_STANDARDS.md Security & safety ("Validate redirect targets
 * from user input").
 */
const DEFAULT_REDIRECT = '/dashboard';

/** True when `value` contains a C0 control character (U+0000-U+001F) or DEL (U+007F). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * The origin this page is actually served from, read fresh on every call
 * (never cached at module scope — that would make the helper untestable
 * and wrong after a location change). Returns `null` when no trusted
 * origin can be established (no `document`, or an opaque `"null"` origin),
 * which fails the caller closed to `DEFAULT_REDIRECT`.
 */
function getTrustedOrigin(): string | null {
  if (typeof document === 'undefined' || !document.location) return null;
  const origin = document.location.origin;
  return origin && origin !== 'null' ? origin : null;
}

/**
 * Returns `target` if it is a safe relative path, otherwise `DEFAULT_REDIRECT`.
 *
 * Safe means:
 * - Starts with exactly one `/`. An absolute URL naming the app's own
 *   origin is same-origin but is not this contract — it is rejected too.
 * - Contains no C0 control character or DEL.
 * - Resolves, via the URL parser, to the page's own trusted origin.
 *
 * On success, returns the caller's original string unchanged — never a
 * reserialized destination — so `safeReturnTo`'s identity check stays valid.
 */
export function safeRedirect(target: string | null | undefined): string {
  if (!target) return DEFAULT_REDIRECT;
  if (!target.startsWith('/') || target.startsWith('//')) return DEFAULT_REDIRECT;
  if (hasControlCharacter(target)) return DEFAULT_REDIRECT;

  const trustedOrigin = getTrustedOrigin();
  if (!trustedOrigin) return DEFAULT_REDIRECT;

  let resolved: URL;
  try {
    resolved = new URL(target, trustedOrigin);
  } catch {
    return DEFAULT_REDIRECT;
  }

  return resolved.origin === trustedOrigin ? target : DEFAULT_REDIRECT;
}

/**
 * Validate a `returnTo` query param against `safeRedirect`, falling back
 * to the caller's page-local default instead of `DEFAULT_REDIRECT`. The
 * param is accepted only when it survives validation UNCHANGED — any
 * rewrite means it was unsafe, so the fallback wins.
 *
 * Extracted from the identical per-page copies in IncomeFormPage /
 * ExpenseFormPage.
 */
export function safeReturnTo(returnTo: string | null, fallback: string): string {
  return returnTo && safeRedirect(returnTo) === returnTo ? returnTo : fallback;
}
