/**
 * Scenario aggregate payload. Its per-scenario override tree lives in
 * `scenario-overrides.ts`.
 */

import type { ScenarioOverrides } from './scenario-overrides';

export interface ScenarioPayload extends Record<string, unknown> {
  name: string;
  /** Single-line elaboration of the scenario's intent. Sits between
   *  `name` (short, used in tables / dropdowns) and `notes` (multi-line
   *  free-form). Max 200 chars. Does not inherit. Empty string when
   *  unset. */
  description: string;
  parentScenarioId: string | null;
  isPrimary: boolean;
  notes: string;
  overrides: ScenarioOverrides;
}
