import { describe, expect, it } from 'vitest';
import { safeRedirect, safeReturnTo } from './safe-redirect';

// Jsdom's default document origin.
const TRUSTED_ORIGIN = window.location.origin;

describe('safeRedirect', () => {
  describe('accepted targets are returned byte-identical', () => {
    it.each([
      ['a plain route', '/income'],
      ['a nested route', '/accounts/123/balances'],
      ['a route with a query string', '/expenses?x=1'],
      ['a route with a hash', '/dashboard#section-2'],
      // The canonical Edit link's `returnTo` decodes to a path whose own query value is percent-encoded, so it survives the outer URL parse.
      ['the focus-restore shape (percent-encoded query value)', '/expenses?focusExpenseId=abc%2F123'],
    ])('%s', (_label, target) => {
      expect(safeRedirect(target)).toBe(target);
    });
  });

  describe('rejected targets fall back to the default', () => {
    it.each([
      ['an absolute URL on another origin', 'https://evil.example/steal'],
      ['a protocol-relative URL', '//evil.example'],
      ['the /\\ escape', '/\\evil.example'],
      ['a javascript: URI', 'javascript:alert(1)'],
      ['a data: URI', 'data:text/html,evil'],
      // Same-origin absolute URLs are rejected too: the consumer contract requires a leading `/`.
      ['an absolute URL on the app\'s own origin', `${TRUSTED_ORIGIN}/dashboard`],
      // The WHATWG URL parser strips tab/LF/CR before resolving the authority, so each of these looks like a same-origin path by prefix but resolves to `//evil.example`.
      ['a tab that turns the target protocol-relative', '/\t/evil.example'],
      ['a newline that turns the target protocol-relative', '/\n/evil.example'],
      ['a carriage return that turns the target protocol-relative', '/\r/evil.example'],
      ['a representative other C0 control character', '/\x01evil.example'],
      ['DEL', '/\x7Fevil.example'],
    ])('%s', (_label, target) => {
      expect(safeRedirect(target)).toBe('/dashboard');
    });

    it('rejects null, undefined and empty', () => {
      expect(safeRedirect(null)).toBe('/dashboard');
      expect(safeRedirect(undefined)).toBe('/dashboard');
      expect(safeRedirect('')).toBe('/dashboard');
    });
  });

  describe('percent-encoded variants resolve to the trusted origin', () => {
    it.each([
      ['an encoded slash pair', '/%2F%2Fevil.example'],
      ['an encoded control character', '/foo%09bar'],
    ])('%s is accepted', (_label, target) => {
      const result = safeRedirect(target);
      // Assert the resolved origin, not the string shape: an identity assertion would pass even if the parser decoded the escape before comparing origins.
      expect(new URL(result, TRUSTED_ORIGIN).origin).toBe(TRUSTED_ORIGIN);
      expect(result).toBe(target);
    });
  });
});

describe('safeReturnTo', () => {
  it('accepts a safe returnTo unchanged', () => {
    expect(safeReturnTo('/expenses?x=1', '/expenses')).toBe('/expenses?x=1');
  });

  it('falls back to the page-local default whenever safeRedirect would rewrite the value', () => {
    expect(safeReturnTo('//evil.example', '/income')).toBe('/income');
    expect(safeReturnTo('https://evil.example', '/income')).toBe('/income');
    expect(safeReturnTo('/\t/evil.example', '/income')).toBe('/income');
    expect(safeReturnTo(null, '/income')).toBe('/income');
  });
});
