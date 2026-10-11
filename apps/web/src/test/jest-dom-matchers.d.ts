// vitest 5 moved custom-matcher typing from `Assertion` to `Matchers`; the
// jest-dom package's own vitest typings still augment the old interface, so its
// matchers (toBeInTheDocument, toHaveTextContent, ...) vanish from `expect`.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging: an empty body is the augmentation
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<T, R> {}
}
