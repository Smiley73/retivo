import { MAIL_FROM_DISPLAY_NAME, formatMailSource } from './mail-source.js';

describe('formatMailSource', () => {
  it('puts the Retivo display name in front of the configured sender', () => {
    expect(MAIL_FROM_DISPLAY_NAME).toBe('Retivo');
    expect(formatMailSource('noreply@example.com')).toBe('Retivo <noreply@example.com>');
  });
});
