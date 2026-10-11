/**
 * Sanity fixture for the a11y test infrastructure.
 *
 * The suite below is `describe.skip` so it never runs in CI / local
 * `pnpm test`. To prove the axe assertion actually rejects violations
 * (e.g. after a jest-axe / axe-core upgrade, or while debugging a
 * test that mysteriously "passes"), drop the `.skip` and run:
 *
 *   pnpm --filter @retirement/web exec vitest run a11y-sanity
 *
 * Expected: one failing test reporting at least one violation (a
 * `<button>` with no accessible name fails `button-name`). Re-apply
 * `.skip` before committing.
 */
import { render } from '@testing-library/react';
import { describe, it } from 'vitest';
import { expectNoA11yViolations } from './a11y';

describe.skip('a11y sanity (un-skip manually to verify axe is live)', () => {
  it('fails when an obvious violation is present', async () => {
    const { container } = render(<button type="button" />);
    await expectNoA11yViolations(container);
  });
});
