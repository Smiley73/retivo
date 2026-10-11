import { emailFingerprint } from './email-fingerprint.js';

describe('emailFingerprint', () => {
  it('returns exactly 16 lowercase hex chars', () => {
    const fp = emailFingerprint('alice@example.com');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toHaveLength(16);
  });

  it('normalizes trim + lowercase: same email yields the same fingerprint', () => {
    expect(emailFingerprint('alice@example.com')).toBe(
      emailFingerprint('  ALICE@EXAMPLE.COM  '),
    );
  });

  it('different emails yield different fingerprints', () => {
    expect(emailFingerprint('alice@example.com')).not.toBe(
      emailFingerprint('bob@example.com'),
    );
  });

  it('is deterministic across calls', () => {
    const a = emailFingerprint('alice@example.com');
    const b = emailFingerprint('alice@example.com');
    expect(a).toBe(b);
  });
});
