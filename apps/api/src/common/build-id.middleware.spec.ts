/**
 * Unit tests for BuildIdMiddleware. Asserts the response carries an
 * `X-Build-Id` header sourced from the module-load-time `process.env
 * .BUILD_ID`. The web's version detector relies on this header being
 * present on every API response.
 */
import { BUILD_ID, BuildIdMiddleware } from './build-id.middleware.js';

describe('BuildIdMiddleware', () => {
  it('defaults BUILD_ID to "dev" when the env var is unset', () => {
    // The constant is captured at module load; jest.setup.ts does not
    // set BUILD_ID, so the default path is what we'll see in tests.
    expect(BUILD_ID).toBe('dev');
  });

  it('stamps X-Build-Id on the response and calls next()', () => {
    const setHeader = jest.fn();
    const next = jest.fn();
    const res = { setHeader } as unknown as Parameters<
      InstanceType<typeof BuildIdMiddleware>['use']
    >[1];
    new BuildIdMiddleware().use({} as never, res, next);
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Build-Id', BUILD_ID);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
