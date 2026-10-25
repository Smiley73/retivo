// BuildIdMiddleware stamps X-Build-Id on every response, which the web's version detector relies on.
import { BuildIdMiddleware } from './build-id.middleware.js';

describe('BuildIdMiddleware', () => {
  it('stamps X-Build-Id (default "dev") on the response and calls next()', () => {
    const setHeader = jest.fn();
    const next = jest.fn();
    const res = { setHeader } as unknown as Parameters<
      InstanceType<typeof BuildIdMiddleware>['use']
    >[1];
    new BuildIdMiddleware().use({} as never, res, next);
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Build-Id', 'dev');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
