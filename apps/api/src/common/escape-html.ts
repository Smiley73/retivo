/**
 * HTML-escape a value for interpolation into an SES `Html.Data` mail body.
 * Moved verbatim out of
 * `signup-approval.service.ts`, which previously defined its own private
 * copy — every mail-composing service now shares this one so the rule
 * ("every interpolated value in an HTML mail body is escaped") holds by
 * construction for new templates too, not just the ones that remembered.
 *
 * Not a URL sanitiser — it does not reject a `javascript:` scheme or
 * anything else scheme-related. Every link composed into a mail body here is
 * built from operator config plus a token, never from unconstrained user
 * input, so that is out of scope for this helper.
 *
 * Single-pass regex is deliberate: `&` must be replaced first (inside the
 * same pass) or every other entity double-escapes (`<` → `&amp;lt;`).
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
