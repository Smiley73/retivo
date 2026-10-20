/** Command-line parsing for the bin: `--origin <origin>` (required) and `--port <port>`. */
import { parseArgs } from 'node:util';
import { DEFAULT_BRIDGE_PORT, assertSafeOrigin, assertSafePort } from '@retirement/assistant-protocol';

export const USAGE = 'Usage: retivo-mcp-bridge --origin <origin> [--port <port>]\n';

export type ParsedArgs = { ok: true; origin: string; port: number } | { ok: false; message: string };

export function parseBridgeArgs(argv: readonly string[]): ParsedArgs {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { origin: { type: 'string' }, port: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    });
    if (values.origin === undefined) return { ok: false, message: 'Missing --origin.' };
    assertSafeOrigin(values.origin);
    const port = values.port === undefined ? DEFAULT_BRIDGE_PORT : Number(values.port);
    assertSafePort(port);
    return { ok: true, origin: values.origin, port };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Invalid arguments.' };
  }
}
