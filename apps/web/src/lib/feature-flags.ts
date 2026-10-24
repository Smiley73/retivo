// Beta-feature registry and the build config deciding which features a build offers; a feature shows only when the build offers it and the user's preference is on.
// Promoting a feature out of beta means deleting its entry and its `betaFeature` references.

export type BetaFeatureId = 'projected-withdrawals' | 'guardrails' | 'ai-assistants';

export interface BetaFeature {
  readonly id: BetaFeatureId;
  readonly label: string;
  readonly pdfSectionIds: readonly string[];
  readonly owner: string;
  readonly since: string;
  /** ISO date by which the owner promotes or retires the feature; the registry test fails once it has passed. */
  readonly reviewBy: string;
}

export const BETA_FEATURES: readonly BetaFeature[] = [
  {
    id: 'projected-withdrawals',
    label: 'Projected withdrawals',
    pdfSectionIds: ['table-withdrawal-guidance'],
    owner: 'Smiley73',
    since: '2026-09-06',
    reviewBy: '2026-12-31',
  },
  {
    id: 'guardrails',
    label: 'Guardrails today',
    pdfSectionIds: [],
    owner: 'Smiley73',
    since: '2026-09-06',
    reviewBy: '2026-12-31',
  },
  {
    id: 'ai-assistants',
    label: 'AI assistants',
    pdfSectionIds: [],
    owner: 'Smiley73',
    since: '2026-10-19',
    reviewBy: '2027-01-31',
  },
];

const KNOWN_IDS: ReadonlySet<string> = new Set(BETA_FEATURES.map((f) => f.id));

function isBetaFeatureId(value: string): value is BetaFeatureId {
  return KNOWN_IDS.has(value);
}

export function betaFeature(id: BetaFeatureId): BetaFeature {
  const found = BETA_FEATURES.find((f) => f.id === id);
  if (!found) throw new Error(`Unknown beta feature: ${id}`);
  return found;
}

/**
 * Parses `VITE_BETA_FEATURES` into the offered ids: unset, blank or `all` offers
 * every feature, `none` offers none, else a comma-separated id list
 * (case-insensitive). Unknown ids go to `onUnknownId` and are ignored, so a typo
 * in a local `.env` hides that feature rather than breaking the app; deploys fail
 * loud on one in `build_spa`.
 */
export function parseBetaFeatureConfig(
  raw: string | undefined,
  onUnknownId: (id: string) => void = () => undefined,
): ReadonlySet<BetaFeatureId> {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'all') return KNOWN_IDS as ReadonlySet<BetaFeatureId>;
  if (value === 'none') return new Set();
  const offered = new Set<BetaFeatureId>();
  for (const part of value.split(',')) {
    const id = part.trim();
    if (id === '') continue;
    if (isBetaFeatureId(id)) offered.add(id);
    else onUnknownId(id);
  }
  return offered;
}

/** The beta features this build offers, resolved once at load; an unknown id warns, never throws, so the app still boots. */
export const OFFERED_BETA_FEATURE_IDS: ReadonlySet<BetaFeatureId> = parseBetaFeatureConfig(
  import.meta.env.VITE_BETA_FEATURES as string | undefined,
  (id) => console.warn(`[feature-flags] VITE_BETA_FEATURES names an unknown beta feature: "${id}"`),
);

/** PDF sections of every beta feature not visible under `isVisible`; the Report page hands this filter to the builder. */
export function hiddenBetaPdfSectionIds(
  isVisible: (id: BetaFeatureId) => boolean,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const feature of BETA_FEATURES) {
    if (isVisible(feature.id)) continue;
    for (const sectionId of feature.pdfSectionIds) hidden.add(sectionId);
  }
  return hidden;
}
