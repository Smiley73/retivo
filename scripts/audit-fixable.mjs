// Dependency-audit gate: fails only on advisories (at or above --audit-level) that have a patched release. Decision logic in
// scripts/audit-fixable-core.mjs. Usage: node scripts/audit-fixable.mjs [--prod] [--audit-level=moderate]
import { spawnSync } from 'node:child_process';
import { classify, describe } from './audit-fixable-core.mjs';

const args = process.argv.slice(2);
const prod = args.includes('--prod');
const level = args.find((arg) => arg.startsWith('--audit-level='))?.slice('--audit-level='.length) ?? 'moderate';

const run = spawnSync('pnpm', ['audit', '--json', ...(prod ? ['--prod'] : [])], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  // A registry or network error is not a clean audit: fail rather than pass on no information.
  console.error(`pnpm audit produced no JSON report (exit ${run.status}).\n${run.stderr ?? ''}`);
  process.exit(1);
}

const { failing, unfixable } = classify(report, level);
for (const advisory of unfixable) console.warn(`::warning::no patched release yet, not failing: ${describe(advisory)}`);
if (failing.length > 0) {
  for (const advisory of failing) console.error(`::error::fixable advisory: ${describe(advisory)}`);
  console.error(`${failing.length} advisory(ies) at ${level} or above have a patched release.`);
  process.exit(1);
}
console.log(`audit clean at ${level}+ (${unfixable.length} without a patched release reported above).`);
