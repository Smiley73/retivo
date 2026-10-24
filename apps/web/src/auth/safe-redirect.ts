// Validates redirect targets (CODING_STANDARDS.md "Validate redirect targets from user input").
// Accepted targets are returned byte-identical, never reserialized: `safeReturnTo` relies on that identity.
const DEFAULT_REDIRECT = '/dashboard';

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// Read per call, not cached at module scope. Null (no `document`, or an opaque "null" origin) fails the caller closed.
function getTrustedOrigin(): string | null {
  if (typeof document === 'undefined' || !document.location) return null;
  const origin = document.location.origin;
  return origin && origin !== 'null' ? origin : null;
}

/**
 * Returns `target` if it is a safe relative path, otherwise `DEFAULT_REDIRECT`. Safe means one leading `/` (not `//`),
 * no C0 control character or DEL, and the same origin once resolved by the URL parser. The parser strips tab, LF and CR
 * before locating the authority, so `/<TAB>/evil.example` passes prefix checks yet navigates to `//evil.example`.
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
 * `returnTo` if it survives `safeRedirect` unchanged (any rewrite means it was unsafe), else the page-local `fallback`.
 */
export function safeReturnTo(returnTo: string | null, fallback: string): string {
  return returnTo && safeRedirect(returnTo) === returnTo ? returnTo : fallback;
}
