// Fail-closed resolver for the one shared Lambda artifact in `apps/api/build/lambda/`, used by lambda.ts and signup-cascade.ts.

import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

const DEPLOYED_HANDLER_FILES = [
  "lambda.js",
  "compactor-lambda.js",
  "janitor-lambda.js",
  "signup-cascade-lambda.js",
  "account-snapshot-purge-lambda.js",
  "health-check-probe-lambda.js",
] as const;

function missingHandlerFiles(buildDir: string): string[] {
  return DEPLOYED_HANDLER_FILES.filter(
    (name) => !fs.existsSync(path.join(buildDir, name)),
  );
}

/**
 * Resolves the deployable artifact for a Lambda, failing closed: a FileArchive of `buildDir` only when every
 * deployed handler file is present, since a partial artifact would deploy a Lambda whose handler entry is
 * missing. Otherwise it throws on a real `pulumi up`, or returns `shellFallback` under `pulumi preview` only
 * so a fresh checkout can still preview.
 *
 * @param buildDir the shared `apps/api/build/lambda` directory
 * @param label name for messages (e.g. `api`, `signup-cascade`)
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
