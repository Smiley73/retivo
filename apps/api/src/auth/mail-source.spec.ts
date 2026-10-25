import { formatMailSource } from './mail-source.js';

describe('formatMailSource', () => {
  it('puts the Retivo display name in front of the configured sender', () => {
    expect(formatMailSource('noreply@example.com')).toBe('Retivo <noreply@example.com>');
  });
});
