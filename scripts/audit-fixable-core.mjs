// Pure decision logic for the dependency-audit gate. No I/O: the shell is scripts/audit-fixable.mjs and every branch here is
// unit-tested by scripts/test/audit-fixable-core.test.mjs.
//
// The gate fails on an advisory at or above the chosen severity that has a patched release, because only then is there
// something to upgrade to. An advisory with no patched release is reported, not failed. `pnpm audit --ignore-unfixable` is
// not used because it writes `ignoreCves` into pnpm-workspace.yaml, which dirties the tree and keeps the CVE ignored after
// a fix ships.

const SEVERITY_RANK = Object.freeze({ info: 0, low: 1, moderate: 2, high: 3, critical: 4 });

/** `pnpm audit --json` reports an advisory nobody has patched as `<0.0.0`; an empty value is treated the same way. */
export function hasPatch(advisory) {
  const patched = advisory?.patched_versions;
  return typeof patched === 'string' && patched.trim() !== '' && patched.trim() !== '<0.0.0';
}

/**
 * Splits a parsed `pnpm audit --json` report into the advisories that fail the gate and the ones only reported. Advisories
 * muted by `auditConfig.ignoreGhsas` are not in `advisories`, so they stay waived.
 */
export function classify(report, level = 'moderate') {
  if (!(level in SEVERITY_RANK)) throw new Error(`unknown audit level: ${level}`);
  if (report === null || typeof report !== 'object' || report.advisories === null || typeof report.advisories !== 'object') {
    throw new Error('not a pnpm audit report: no `advisories` object');
  }
  const failing = [];
  const unfixable = [];
  for (const advisory of Object.values(report.advisories)) {
    // An unknown severity is never silently dropped: it counts as the highest.
    const rank = SEVERITY_RANK[advisory.severity] ?? SEVERITY_RANK.critical;
    if (rank < SEVERITY_RANK[level]) continue;
    (hasPatch(advisory) ? failing : unfixable).push(advisory);
  }
  return { failing, unfixable };
}

export function describe(advisory) {
  const id = advisory.github_advisory_id ?? advisory.id;
  const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []);
  const where = paths.length > 0 ? ` via ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, +${paths.length - 3} more` : ''}` : '';
  return `${advisory.severity} ${advisory.module_name} ${advisory.vulnerable_versions} (${id}, patched: ${advisory.patched_versions || 'none'})${where}`;
}
