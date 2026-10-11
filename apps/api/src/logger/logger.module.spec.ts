/**
 * Unit test for the Lambda-freeze-safe log destination.
 *
 * A full black-box freeze/timing test is not reliably assertable in Jest, so
 * this asserts the load-bearing *construction* instead: the pino destination is
 * built as a SonicBoom sink on fd 1 with `sync: true`, which is what forces each
 * line to `fs.writeSync` before the Lambda handler returns (see
 * logger.module.ts `createSyncStdoutDestination`). The deployed-shape behavior
 * (JSON + redaction reaching the fd-1 sync sink) is covered by
 * ../test/structured-logging.spec.ts.
 */
import pino from 'pino';
import { createSyncStdoutDestination } from './logger.module.js';

describe('createSyncStdoutDestination', () => {
  it('constructs a synchronous fd-1 SonicBoom destination', () => {
    const spy = jest
      .spyOn(pino, 'destination')
      .mockReturnValue({} as ReturnType<typeof pino.destination>);
    try {
      createSyncStdoutDestination();
      expect(spy).toHaveBeenCalledWith({ dest: 1, sync: true });
    } finally {
      spy.mockRestore();
    }
  });
});
