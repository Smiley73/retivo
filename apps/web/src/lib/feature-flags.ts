/**
 * Feature flags — the beta-feature registry and the build-time config that
 * decides which beta features a given build OFFERS.
 *
 * Two independent switches gate every beta feature:
 *   1. **Build config** (`VITE_BETA_FEATURES`, resolved at build time by Vite):
 *      which beta features this bundle offers at all. `all` (the default when
 *      unset/blank) offers every registered feature, `none` offers none, and a
 *      comma-separated id list offers exactly those. Deployed stacks thread it
 *      from the `retivo:betaFeatures` Pulumi stack config (deploy scripts).
 *   2. **User preference** ("Show beta features", Settings → Preferences, held
 *      in `BetaFeaturesContext`): whether this person wants to see the offered
 *      beta features. Off by default.
 *
 * A feature is VISIBLE only when both say yes. Hidden features drop out of the
 * sidebar, their routes render a gate notice, and their PDF sections are
 * omitted from the export.
 *
 * Promoting a feature out of beta = delete its registry entry (and the
 * `betaFeature` reference on its sidebar item / route gate). Nothing else
 * changes: the feature simply stops being flag-gated. Each entry records who
 * owns the flag, the date it entered beta, and the date by which the owner
 * must decide to promote or retire it (CODING_STANDARDS.md Definition of
 * Done: a feature flag carries an owner + a removal date). The registry test
 * fails once a `reviewBy` date is in the past, so a forgotten flag cannot
 * linger silently.
 *
 * Framework-free: pure data + parsing. The React side lives in
 * `contexts/BetaFeaturesContext.tsx`.
 */

/** Stable ids — referenced by sidebar items, route gates, and the config list. */
export type BetaFeatureId = 'projected-withdrawals' | 'guardrails' | 'ai-assistants';

export interface BetaFeature {
  readonly id: BetaFeatureId;
  /** Plain-language name — the sidebar label and the gate notice's page title. */
  readonly label: string;
  /** PDF export sections (manifest ids) that belong to this feature. */
  readonly pdfSectionIds: readonly string[];
  /** Who decides when the flag goes (GitHub handle). */
  readonly owner: string;
  /** ISO date the feature entered beta. */
  readonly since: string;
  /** ISO date by which the owner promotes or retires the feature; the
   *  registry test turns red once it has passed. */
  readonly reviewBy: string;
}

/** Every feature currently marked Beta, in display order. */
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

/** Registry lookup by id — the single source for a feature's label. */
export function betaFeature(id: BetaFeatureId): BetaFeature {
  const found = BETA_FEATURES.find((f) => f.id === id);
  if (!found) throw new Error(`Unknown beta feature: ${id}`);
  return found;
}

/**
 * Parse the `VITE_BETA_FEATURES` value into the set of OFFERED feature ids.
 * Unset / blank / `all` → every registered feature; `none` → empty; otherwise
 * a comma-separated id list (whitespace-tolerant, case-insensitive). Unknown
 * ids are reported through `onUnknownId` and otherwise ignored, so a typo in a
 * local `.env` degrades to "that feature is not offered" rather than a broken
 * app. (Deploys never get this far with a typo: `build_spa` validates the
 * stack config against this registry and fails the deploy loud.)
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

/**
 * The beta features this build offers — resolved once at module load from the
 * Vite-baked `VITE_BETA_FEATURES`. An unknown id is a config mistake worth a
 * console warning (never a throw: the app must still boot).
 */
export const OFFERED_BETA_FEATURE_IDS: ReadonlySet<BetaFeatureId> = parseBetaFeatureConfig(
  import.meta.env.VITE_BETA_FEATURES as string | undefined,
  (id) => console.warn(`[feature-flags] VITE_BETA_FEATURES names an unknown beta feature: "${id}"`),
);

/**
 * PDF export sections to omit — the sections of every beta feature that is
 * NOT visible under `isVisible`. The export's section manifest is fixed in
 * order; this is the filter the Report page hands to the builder.
 */
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
