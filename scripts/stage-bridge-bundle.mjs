#!/usr/bin/env node
/**
 * Puts the built bridge bundle into the SPA's `dist/` so the deploy scripts upload it with the rest
 * of the site (their catch-all `aws s3 sync` of `dist/`; a file anywhere else in the bucket is
 * deleted by the next deploy). `build_spa` runs it, and only for a stack whose build carries the
 * assistant bridge port, so a stack with the connector off serves nothing new.
 *
 *   node scripts/stage-bridge-bundle.mjs <bundle-dir> <spa-dist-dir>
 *
 * Writes three files into `<spa-dist-dir>`, named by `@retirement/assistant-protocol` (the Settings
 * card builds the same URLs from the same constants):
 *   retivo-mcp-bridge.mjs          the bundle, byte for byte
 *   retivo-mcp-bridge-notices.txt  the notices of everything embedded in it
 *   bridge.json                    { version, sha256, size } of the bundle, which the card reads
 *                                  to show the checksum a person verifies the download against
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const protocol = await import(pathToFileURL(join(repoRoot, 'packages', 'assistant-protocol', 'dist', 'index.js')).href);
const { BRIDGE_FILE, BRIDGE_NOTICES_FILE, BRIDGE_MANIFEST_FILE } = protocol;

const [bundleDir, distDir] = process.argv.slice(2);
if (bundleDir === undefined || distDir === undefined || process.argv.length !== 4) {
  console.error('usage: stage-bridge-bundle.mjs <bundle-dir> <spa-dist-dir>');
  process.exit(2);
}

// The bundler's own file names (apps/mcp-bridge/scripts/build-bundle.mjs).
const BUILT_BUNDLE = 'retivo-mcp-bridge.mjs';
const BUILT_NOTICES = 'THIRD-PARTY-NOTICES.txt';

for (const file of [join(bundleDir, BUILT_BUNDLE), join(bundleDir, BUILT_NOTICES)]) {
  if (!existsSync(file)) {
    console.error(`error: ${file} is missing; build the bridge first (pnpm --filter @retirement/mcp-bridge build).`);
    process.exit(1);
  }
}
if (!existsSync(distDir)) {
  console.error(`error: ${distDir} is missing; build the SPA first.`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'apps', 'mcp-bridge', 'package.json'), 'utf8'));
const bytes = readFileSync(join(bundleDir, BUILT_BUNDLE));
const manifest = { version, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };

copyFileSync(join(bundleDir, BUILT_BUNDLE), join(distDir, BRIDGE_FILE));
copyFileSync(join(bundleDir, BUILT_NOTICES), join(distDir, BRIDGE_NOTICES_FILE));
writeFileSync(join(distDir, BRIDGE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`    bridge ${manifest.version} sha256=${manifest.sha256} size=${manifest.size}`);
