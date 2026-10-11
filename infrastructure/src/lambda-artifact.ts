// Shared fail-closed artifact resolver for every deployed Lambda.
//
// Every Lambda (the six in lambda.ts + the signup-cascade in
// signup-cascade.ts) deploys from ONE shared artifact at
// `apps/api/build/lambda/`, produced by `pnpm --filter @retirement/api
// build:lambda`. Pulumi picks the per-Lambda handler ENTRY from that single
// FileArchive, so a partial artifact — one containing a primary handler but
// missing a sibling handler file — would silently deploy a broken Lambda whose
// configured entry does not exist. Checking only one handler file's existence
// (the pre-fix behavior) does not catch that.
//
// `resolveLambdaArtifact()` enforces the full-coverage invariant: the
// FileArchive is returned ONLY when EVERY deployed handler file is present in
// the build directory. A partial artifact is rejected — on a real `pulumi up`
// it throws (naming `build:lambda`); under `pulumi preview`
// (`pulumi.runtime.isDryRun()`) it warns and returns the caller's shell
// fallback so a fresh checkout that hasn't run `build:lambda` can still
// preview. Both lambda.ts's `lambdaCode()` and signup-cascade.ts's
// `cascadeCode()` route through here so the guarantee is identical for all
// six handlers.

import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

/**
 * The six handler files Pulumi deploys from the shared artifact (five via
 * lambda.ts, one via signup-cascade.ts). All must exist in the build directory
 * for the artifact to be considered complete — Pulumi selects one of these as
 * each Lambda's handler entry. Mirrors `DEPLOYED_HANDLERS` in
 * scripts/test/lambda-artifact-contract.test.mjs.
 */
const DEPLOYED_HANDLER_FILES = [
  "lambda.js",
  "compactor-lambda.js",
  "janitor-lambda.js",
  "signup-cascade-lambda.js",
  "account-snapshot-purge-lambda.js",
  "health-check-probe-lambda.js",
] as const;

/** Returns the required handler files missing from `buildDir` (empty = complete). */
function missingHandlerFiles(buildDir: string): string[] {
  return DEPLOYED_HANDLER_FILES.filter(
    (name) => !fs.existsSync(path.join(buildDir, name)),
  );
}

/**
 * Resolves the deployable artifact for a Lambda under the full-coverage
 * fail-closed invariant. Returns a FileArchive of `buildDir` only when EVERY
 * deployed handler file is present; otherwise throws on a real `pulumi up`
 * (naming `build:lambda`) or returns the caller's `shellFallback` under
 * `pulumi preview` only.
 *
 * @param buildDir the shared `apps/api/build/lambda` directory
 * @param label human label for messages (e.g. `api`, `compactor`,
 *   `signup-cascade`)
 * @param shellFallback builds the preview-only placeholder archive
 */
export function resolveLambdaArtifact(
  buildDir: string,
  label: string,
  shellFallback: () => pulumi.asset.Archive,
): pulumi.asset.Archive {
  const missing = missingHandlerFiles(buildDir);
  if (missing.length === 0) {
    return new pulumi.asset.FileArchive(buildDir);
  }
  const detail = `apps/api/build/lambda is missing required handler file(s): ${missing.join(", ")}`;
  if (!pulumi.runtime.isDryRun()) {
    throw new Error(
      `${detail} — refusing to deploy the placeholder ${label} shell on a real \`pulumi up\`. Run \`pnpm --filter @retirement/api build:lambda\` first.`,
    );
  }
  pulumi.log.warn(
    `${detail} — deploying the placeholder ${label} shell for this \`pulumi preview\` only. Run \`pnpm --filter @retirement/api build:lambda\` before \`pulumi up\` to deploy the real handler.`,
  );
  return shellFallback();
}
