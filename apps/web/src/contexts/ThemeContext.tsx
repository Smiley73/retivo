/**
 * Theme preference, persisted in localStorage (see "Theme" in
 * docs/ui-conventions.md).
 *
 * Read is synchronous on mount → no flash of incorrect theme. Storage
 * key includes the userId after login (anonymous before).
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const MEDIA_QUERY = '(prefers-color-scheme: dark)';
const STORAGE_KEY_PREFIX = 'retivo.theme.';
const ANON_KEY = `${STORAGE_KEY_PREFIX}anonymous`;

function resolveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return typeof window !== 'undefined' && window.matchMedia(MEDIA_QUERY).matches
    ? 'dark'
    : 'light';
}

function applyTheme(resolved: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

function readPreference(userId: string | null): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  const key = userId ? `${STORAGE_KEY_PREFIX}${userId}` : ANON_KEY;
  const stored = localStorage.getItem(key);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function writePreference(userId: string | null, theme: ThemePreference): void {
  if (typeof localStorage === 'undefined') return;
  const key = userId ? `${STORAGE_KEY_PREFIX}${userId}` : ANON_KEY;
  localStorage.setItem(key, theme);
}

interface ThemeProviderProps {
  children: React.ReactNode;
  /** Switches the storage key after login. Pass null when logged out. */
  userId?: string | null;
  /**
   * Locks the resolved palette to a fixed value for the subtree, bypassing
   * the localStorage preference / OS-media path. Used by the PDF render host
   * to force the print-safe LIGHT chart palette regardless of the app's active
   * theme (the print-safe chart palette). The nested
   * provider does NOT touch `document.documentElement` or localStorage, so the
   * surrounding app theme is untouched.
   */
  forcedResolvedTheme?: 'light' | 'dark';
}

export const ForcedThemeProvider: React.FC<{
  resolvedTheme: 'light' | 'dark';
  children: React.ReactNode;
}> = ({ resolvedTheme, children }) => (
  <ThemeContext.Provider
    value={{
      theme: resolvedTheme,
      resolvedTheme,
      // Locked subtree: setter is a no-op so a descendant control can't drift
      // the forced palette (the PDF capture must stay light-only).
      setTheme: () => undefined,
    }}
  >
    {children}
  </ThemeContext.Provider>
);

export const ThemeProvider: React.FC<ThemeProviderProps> = ({
  children,
  userId = null,
  forcedResolvedTheme,
}) => {
  if (forcedResolvedTheme) {
    return (
      <ForcedThemeProvider resolvedTheme={forcedResolvedTheme}>
        {children}
      </ForcedThemeProvider>
    );
  }
  return <ThemeProviderInner userId={userId}>{children}</ThemeProviderInner>;
};

const ThemeProviderInner: React.FC<{ userId: string | null; children: React.ReactNode }> = ({ children, userId }) => {
  // Synchronous initial state — read happens before first paint, so no flash.
  const initial = readPreference(userId);
  const [theme, setThemeState] = useState<ThemePreference>(initial);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveTheme(initial));

  // Apply on mount + on every theme change.
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Re-read when the user logs in / out (storage key flips).
  useEffect(() => {
    const next = readPreference(userId);
    setThemeState(next);
    setResolvedTheme(resolveTheme(next));
  }, [userId]);

  // Listen to OS preference changes only when in `system` mode.
  useEffect(() => {
    if (theme !== 'system') return;
    const mql = window.matchMedia(MEDIA_QUERY);
    const handler = () => setResolvedTheme(resolveTheme('system'));
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setThemeState(next);
      setResolvedTheme(resolveTheme(next));
      writePreference(userId, next);
    },
    [userId],
  );

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
