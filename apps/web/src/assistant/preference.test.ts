import { beforeEach, describe, expect, it } from 'vitest';
import { readAssistantOptIn, writeAssistantOptIn } from './preference';

describe('assistant opt-in preference', () => {
  beforeEach(() => localStorage.clear());

  it('is off by default', () => {
    expect(readAssistantOptIn('u-1')).toBe(false);
  });

  it('persists per user', () => {
    writeAssistantOptIn('u-1', true);
    expect(readAssistantOptIn('u-1')).toBe(true);
    expect(readAssistantOptIn('u-2')).toBe(false);
    writeAssistantOptIn('u-1', false);
    expect(readAssistantOptIn('u-1')).toBe(false);
  });

  it('never stores or reads an answer for nobody', () => {
    writeAssistantOptIn(null, true);
    expect(readAssistantOptIn(null)).toBe(false);
    expect(localStorage.length).toBe(0);
  });
});
