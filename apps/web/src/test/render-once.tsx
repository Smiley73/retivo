import type { ReactNode } from 'react';
import { act } from '@testing-library/react';
import { createRoot } from 'react-dom/client';

/**
 * Mounts `ui` once for a whole describe of read-only checks. Testing
 * Library's `render` registers every mount for its automatic per-test
 * cleanup (`globals: true`), which would tear a `beforeAll` render down after
 * the first case; mounting through a bare root opts out, so the caller owns
 * the lifetime and must call `dispose()` in `afterAll`. Queries via `screen`
 * see the mounted tree exactly as they do after `render`.
 */
export function renderOnce(ui: ReactNode): {
  container: HTMLElement;
  dispose: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    dispose: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}
