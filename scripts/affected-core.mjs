// Pure, side-effect-free decision logic for the affected-test selector.
// No git, no I/O, no child_process — every branch here is unit-tested by
// scripts/test/affected-core.test.mjs. The I/O shell (scripts/test-affected.mjs)
// is the only place that touches git/the runners; it is deliberately untested.

const WEB_PREFIX = 'apps/web/';
const API_PREFIX = 'apps/api/';

// Recognized first-class source extensions. Anything that is NOT one of
// these, NOT a denylist path, and NOT a docs-only path escalates — the tool
// never silently runs nothing when it cannot reason about the blast radius.
const SOURCE_EXTS = ['.ts', '.tsx', '.mjs', '.cjs'];

// Docs-only set: a change set containing *only* these is a no-op.
// Matched by extension. Images count as docs (assets, never imported by code).
const DOC_EXTS = [
  '.md',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.avif',
  '.bmp',
];

function basename(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extname(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

// Broad-impact paths: a change to any of these invalidates the affected
// graph (lockfile, tsconfig, the test/build runner config + setup, the global
// stylesheet, the design-token source, the migration ladder). When one is in
// the change set the selector abandons selection and runs the full suite.
function isDenylisted(path) {
  const base = basename(path);
  if (base === 'pnpm-lock.yaml') return true;
  if (/^tsconfig.*\.json$/.test(base)) return true;
  if (/^vite\.config\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^vitest\.config\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^jest\.config\.[cm]?[jt]sx?$/.test(base)) return true;
  // Test runner setup files — a change here perturbs every suite in the package.
  if (path === 'apps/web/src/test/setup.ts') return true;
  if (path === 'apps/api/src/test/jest.setup.ts') return true;
  // Global, broadly-imported web sources whose blast radius the runner graph
  // cannot bound cheaply (every component reads tokens/styles; migrations gate
  // every aggregate). Also the AGENTS.md companion-edit hot files.
  if (path === 'apps/web/src/styles.css') return true;
  if (path === 'apps/web/src/lib/tokens.ts') return true;
  if (path === 'apps/web/src/db/migrations.ts') return true;
  return false;
}

function isDoc(path) {
  return DOC_EXTS.includes(extname(path));
}

function isSourceExt(path) {
  return SOURCE_EXTS.includes(extname(path));
}

/**
 * Classify a changed-path set into a run mode. Path-only and deterministic —
 * identical input always yields identical output regardless of how the paths
 * were obtained (basis resolution is the shell's concern).
 *
 * Precedence (safety-first; when blast radius is unknowable, escalate):
 *   1. any denylist path present                → escalate
 *   2. any non-doc, non-source-ext path         → escalate
 *      a source file outside apps/web|apps/api  → escalate (no spec maps it)
 *   3. change set is docs-only                  → noop
 *   4. otherwise                                → select (web/api buckets)
 *
 * Returned `webFiles` / `apiFiles` are package-relative (the `apps/web/` /
 * `apps/api/` prefix is stripped) so they can be handed straight to the
 * runners, which resolve filters against their own package root.
 *
 * @param {string[]} paths repo-root-relative changed paths
 * @returns {{ mode: 'select'|'escalate'|'noop', webFiles: string[], apiFiles: string[] }}
 */
export function classifyChange(paths) {
  const escalate = { mode: 'escalate', webFiles: [], apiFiles: [] };

  if (paths.some(isDenylisted)) return escalate;

  const webFiles = [];
  const apiFiles = [];
  let sawNonDoc = false;

  for (const path of paths) {
    if (isDoc(path)) continue;
    sawNonDoc = true;

    if (!isSourceExt(path)) return escalate; // unrecognized type

    if (path.startsWith(WEB_PREFIX)) {
      webFiles.push(path.slice(WEB_PREFIX.length));
    } else if (path.startsWith(API_PREFIX)) {
      apiFiles.push(path.slice(API_PREFIX.length));
    } else {
      return escalate; // source outside both packages: no spec maps it
    }
  }

  if (!sawNonDoc) return { mode: 'noop', webFiles: [], apiFiles: [] };
  return { mode: 'select', webFiles, apiFiles };
}

/**
 * Given the result of one instrumented runner invocation for a bucket,
 * decide whether that run's verdict can be trusted or the selector must
 * escalate to the full suite.
 *
 * A source-bearing bucket that matched zero suites means the runner's import
 * graph found no covering spec for the change — the only honest signal is the
 * full suite, never a `--passWithNoTests` green. An empty bucket (no source)
 * is a no-op for that runner, not an escalation.
 *
 * @param {{ hasSource: boolean, matchedCount: number }} probe
 * @returns {'run'|'escalate'}
 */
export function decideFromProbe({ hasSource, matchedCount }) {
  if (hasSource && matchedCount === 0) return 'escalate';
  return 'run';
}
