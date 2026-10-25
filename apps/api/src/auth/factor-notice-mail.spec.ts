// The pure factor-change notice mail builder: no SES, Moto or Nest wiring.
import { buildFactorNoticeMail, buildFactorUndoLink } from './factor-notice-mail.js';

describe('buildFactorNoticeMail', () => {
  it('escapes an HTML metacharacter carried into the link (webOrigin/token are attacker-adjacent-shaped in principle)', () => {
    const link = 'https://example.test/auth/factor-undo#u=<b>x</b>&t="quoted"';
    const mail = buildFactorNoticeMail({ kind: 'passkey_add', link });
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(mail.html).toContain('&quot;quoted&quot;');
  });

  it('does not escape the plain-text body', () => {
    const link = 'https://example.test/auth/factor-undo#u=<b>x</b>';
    const mail = buildFactorNoticeMail({ kind: 'passkey_add', link });
    expect(mail.text).toContain(link);
  });

  it('produces the right subject per kind', () => {
    expect(buildFactorNoticeMail({ kind: 'passkey_add', link: 'x' }).subject).toBe(
      'A passkey was added to your Retivo account',
    );
    expect(buildFactorNoticeMail({ kind: 'totp_add', link: 'x' }).subject).toBe(
      'An authenticator app was added to your Retivo account',
    );
    expect(buildFactorNoticeMail({ kind: 'passkey_remove', link: 'x' }).subject).toBe(
      'A passkey was removed from your Retivo account',
    );
    expect(buildFactorNoticeMail({ kind: 'totp_remove', link: 'x' }).subject).toBe(
      'Your authenticator app was turned off',
    );
  });

  it('an add-kind body promises the link removes/disables the new factor; a remove-kind body says it cannot be restored', () => {
    const add = buildFactorNoticeMail({ kind: 'passkey_add', link: 'x' });
    expect(add.text).toMatch(/remove the new passkey/i);
    const remove = buildFactorNoticeMail({ kind: 'passkey_remove', link: 'x' });
    expect(remove.text).toMatch(/can't put the passkey back/i);
  });
});

describe('buildFactorUndoLink', () => {
  it('produces a fragment-form link carrying userId, token, and kind — never a query string', () => {
    const link = buildFactorUndoLink('https://example.test', 'user-1', 'tok-1', 'totp_remove');
    expect(link).toBe(
      'https://example.test/auth/factor-undo#u=user-1&t=tok-1&k=totp_remove',
    );
    expect(link).not.toContain('?');
  });

  it('URL-encodes its components', () => {
    const link = buildFactorUndoLink('https://example.test', 'a b', 'c&d', 'passkey_add');
    expect(link).toContain('u=a%20b');
    expect(link).toContain('t=c%26d');
  });
});
