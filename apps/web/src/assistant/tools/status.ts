/**
 * `retivo_status`: whether the workspace is ready and what the answers rest on.
 * It reads no plan content, only the connection, the build, the engine and tax
 * table versions, how fresh the local data is and the sharing switches in effect.
 */
import { CLIENT_BUILD_ID } from '../../lib/build-id';
import { sanitizeClientName } from '../sharing/sanitize';
import { SHARING_SWITCHES } from '../sharing/switches';
import { defineTool } from './define';
import { engineVersion, localDateIso, taxTableFacts } from './facts';

export const retivoStatus = defineTool('retivo_status', (_args, env) => {
  const { connection } = env.context;
  const name = sanitizeClientName(connection.assistantName, env.masker);
  const { lastSyncedAt, pendingLocalChanges } = env.workspace.freshness;
  const tables = taxTableFacts(env.now.getFullYear());
  return {
    data: {
      connection: {
        state: 'connected',
        ...(name !== '' && { assistant: name }),
        ...(connection.pairedAt !== null && { connectedSince: new Date(connection.pairedAt).toISOString() }),
      },
      workspace: { state: 'unlocked' },
      app: { build: CLIENT_BUILD_ID, today: localDateIso(env.now) },
      engine: { engineVersion: engineVersion(), taxTableYear: tables.year, taxTableYearExtrapolated: tables.extrapolated },
      dataFreshness: {
        lastSyncedAt,
        pendingLocalChanges,
        meaning:
          pendingLocalChanges > 0
            ? 'The plan has edits on this device that have not synced yet; these answers include them.'
            : 'Every edit on this device has synced.',
      },
      sharing: Object.fromEntries(SHARING_SWITCHES.map((definition) => [definition.id, env.choices[definition.id]])),
    },
    assumptions: [
      tables.extrapolated
        ? `The built-in federal tax tables end at ${tables.year}; later years scale ${tables.year} forward.`
        : `The built-in federal tax tables run through ${tables.year}.`,
    ],
  };
});
