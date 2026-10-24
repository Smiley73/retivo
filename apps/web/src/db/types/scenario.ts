// Scenario aggregate payload; its override tree lives in `scenario-overrides.ts`.

import type { ScenarioOverrides } from './scenario-overrides';

export interface ScenarioPayload extends Record<string, unknown> {
  name: string;
  /**
   * Single-line elaboration of the intent (max 200 chars, not inherited, empty when unset); sits between `name` and
   * `notes`.
   */
  description: string;
  parentScenarioId: string | null;
  isPrimary: boolean;
  notes: string;
  overrides: ScenarioOverrides;
}
