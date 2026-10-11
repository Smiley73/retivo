import { escapeHtml } from './escape-html.js';

describe('escapeHtml', () => {
  it('escapes all five special characters in one pass', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('does not double-escape an ampersand that precedes another special character', () => {
    // A naive chained `.replace()` implementation that runs `<` before `&`
    // would turn `<` into `&lt;` and then re-escape that `&` into `&amp;lt;`.
    // The single-pass regex must not do that.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&<')).toBe('&amp;&lt;');
    expect(escapeHtml('A&B<C')).toBe('A&amp;B&lt;C');
  });

  it('leaves a string with no special characters untouched', () => {
    expect(escapeHtml('plain text, no markup')).toBe('plain text, no markup');
  });

  it('escapes a hostile quoted-local-part email address', () => {
    expect(escapeHtml('"<b>x</b>"@example.com')).toBe(
      '&quot;&lt;b&gt;x&lt;/b&gt;&quot;@example.com',
    );
  });
});
