import React from 'react';
import { render, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { ForcedThemeProvider, useTheme } from './ThemeContext';

afterEach(() => cleanup());

function Spy({ onValue }: { onValue: (v: ReturnType<typeof useTheme>) => void }) {
  onValue(useTheme());
  return null;
}

describe('ForcedThemeProvider', () => {
  it('exposes the forced resolvedTheme', () => {
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ForcedThemeProvider resolvedTheme="light">
        <Spy onValue={(v) => { captured = v; }} />
      </ForcedThemeProvider>,
    );
    expect(captured!.resolvedTheme).toBe('light');
    expect(captured!.theme).toBe('light');
  });

  it('setTheme is a no-op — resolvedTheme stays locked', () => {
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ForcedThemeProvider resolvedTheme="light">
        <Spy onValue={(v) => { captured = v; }} />
      </ForcedThemeProvider>,
    );
    act(() => { captured!.setTheme('dark'); });
    expect(captured!.resolvedTheme).toBe('light');
  });

  it('does not mutate document.documentElement.classList on mount', () => {
    const before = document.documentElement.className;
    render(
      <ForcedThemeProvider resolvedTheme="light">
        <div />
      </ForcedThemeProvider>,
    );
    expect(document.documentElement.className).toBe(before);
  });

  it('does not write to localStorage on mount', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <ForcedThemeProvider resolvedTheme="light">
        <div />
      </ForcedThemeProvider>,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
