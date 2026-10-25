// HTML escaping for SES `Html.Data` mail bodies, so every interpolated value is escaped by construction.
// Not a URL sanitiser: mail links are built from operator config plus a token.

/** HTML-escapes a value in a single pass: `&` must be replaced in the same pass or entities double-escape. */
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
