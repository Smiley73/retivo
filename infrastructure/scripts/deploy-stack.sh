#!/usr/bin/env bash
# deploy-stack.sh — lean, repeatable deploy of an ALREADY-BOOTSTRAPPED stack.
#
# This is the steady-state redeploy, run from your machine. First-time
# bring-up (two-pass webOrigin dance, SSM secret rotation, SES verification,
# execute-api lockdown) stays in bootstrap-stack.sh — this script refuses to
# run against a stack that has not finished bootstrap.
#
# Usage:
#   ./infrastructure/scripts/deploy-stack.sh <stack>
#
# This is turnkey: setup_pulumi_backend (in lib/deploy-common.sh) logs in to
# the S3 state backend and fetches the per-stack passphrase from SSM, so you
# don't pre-set PULUMI_BACKEND_URL / PULUMI_CONFIG_PASSPHRASE (an
# already-exported value wins).
#
# Steps:
#   1. Tool preflight (pulumi, aws, pnpm, node, git on PATH).
#   2. Schema-ahead preflight — ABORTS the deploy, before any build and before
#      any AWS call, when this tree's aggregate schema versions are ahead of
#      origin/main (scripts/check-schema-not-ahead.mjs). ALLOW_SCHEMA_AHEAD=1
#      in the INVOKING environment downgrades it to a warning.
#   3. Backend login + passphrase, stack select, bootstrap guards.
#   4. Build the Lambda artifact + the SPA (shared helpers in
#      lib/deploy-common.sh — see there for the NODE_ENV rationale).
#   5. Single `pulumi up --yes`.
#   6. Full-dist SPA upload. Unlike bootstrap-stack.sh (which enumerates
#      assets/, fonts/, index.html, build-id.json and silently skips any
#      other file Vite copies from public/ — those 403 on CloudFront), this
#      syncs everything in dist/ with per-class cache-control.
#   7. CloudFront invalidation of /* (one path credit; immune to future
#      public/ additions). Fire-and-return — no propagation wait, no smoke
#      tests; `pulumi up` and the build steps already fail loudly on errors.
#
# NOTE: bootstrap-stack.sh (first bring-up) and a break-glass `pulumi up` do
# NOT run the schema-ahead preflight — only this script does.

set -euo pipefail

# The whole body is one brace block so bash parses the entire file before
# executing any of it. Without this, a `git pull` (or editor save) landing
# while the script runs shifts the byte offsets under the running bash,
# which resumes parsing mid-token and dies with a nonsense syntax error.
{

STACK="${1:-}"
if [[ "$STACK" != "dev" && "$STACK" != "prod" ]]; then
  echo "usage: deploy-stack.sh <dev|prod>" >&2
  exit 2
fi

# Captured from the INVOKING environment, before anything can source the
# gitignored infrastructure/.deploy.env (setup_pulumi_backend does, under
# `set -a`, which exports every key in it). A stale ALLOW_SCHEMA_AHEAD=1 line
# persisted in that file would otherwise disable the schema-ahead refusal for
# every deploy from this checkout — invisibly, and in every git worktree the
# file gets copied into. The override is a per-invocation decision only.
SCHEMA_AHEAD_OVERRIDE="${ALLOW_SCHEMA_AHEAD:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-common.sh
source "$SCRIPT_DIR/lib/deploy-common.sh"
resolve_repo_paths "$SCRIPT_DIR"

require pulumi
require aws
require pnpm
require node
require git

# Schema-ahead guard (both stacks — dev is where this bit us). A bundle whose
# aggregate schema versions are ahead of origin/main lets the target
# environment store rows no shipped bundle can read, which halts that
# workspace's sync permanently. Runs FIRST — before the backend login, the
# builds, and every AWS call — so a refusal costs nothing and changes nothing.
# The override is passed explicitly from the captured invocation value, so its
# meaning cannot be changed by a file sourced later.
echo "==> Preflight: aggregate schema versions vs origin/main"
if [[ "$SCHEMA_AHEAD_OVERRIDE" == "1" ]]; then
  echo "    ALLOW_SCHEMA_AHEAD=1 was set in the invoking environment — a schema-ahead build WILL be allowed to deploy."
fi
ALLOW_SCHEMA_AHEAD="$SCHEMA_AHEAD_OVERRIDE" node "$REPO_ROOT/scripts/check-schema-not-ahead.mjs"

cd "$INFRA_DIR"

# Persist + log in to the S3 state backend and fetch the per-stack
# passphrase, so the run is turnkey (no manual `pulumi login` or
# hand-exported passphrase). An already-exported PULUMI_BACKEND_URL or
# PULUMI_CONFIG_PASSPHRASE wins. See deploy-common.sh.
setup_pulumi_backend "$STACK"

if [[ ! -f "Pulumi.$STACK.yaml" ]]; then
  echo "error: Pulumi.$STACK.yaml not found in infrastructure/ — create it first (copy Pulumi.$STACK.yaml.example and edit it)" >&2
  exit 1
fi

echo "==> Selecting stack '$STACK'"
pulumi stack select "$STACK"

REGION="$(pulumi config get aws:region --stack "$STACK" 2>/dev/null || echo us-east-1)"

# Bootstrap guards: this script never does first bring-up. An empty
# webOrigin means the two-pass bootstrap hasn't happened; a placeholder
# SES sender on prod would ship broken signup mail.
WEB_ORIGIN="$(pulumi config get retivo:webOrigin --stack "$STACK" 2>/dev/null || echo '')"
if [[ -z "$WEB_ORIGIN" ]]; then
  echo "error: retivo:webOrigin is empty — run bootstrap-stack.sh for first bring-up" >&2
  exit 1
fi
if [[ "$STACK" == "prod" ]]; then
  SES_FROM="$(pulumi config get retivo:sesFromAddress --stack "$STACK" 2>/dev/null || echo '')"
  if [[ -z "$SES_FROM" || "$SES_FROM" == "no-reply@example.invalid" ]]; then
    echo "error: retivo:sesFromAddress is the placeholder on prod — refusing to deploy" >&2
    exit 1
  fi
fi

build_lambda
compute_build_id
build_spa "$STACK"

echo
echo "==> pulumi up --stack $STACK"
pulumi up --stack "$STACK" --yes

echo
echo "==> Reading stack outputs"
SPA_BUCKET="$(pulumi stack output spaBucket --stack "$STACK")"
CF_DIST_ID="$(pulumi stack output cloudfrontDistributionId --stack "$STACK")"
if [[ -z "$SPA_BUCKET" || -z "$CF_DIST_ID" ]]; then
  echo "error: spaBucket / cloudfrontDistributionId outputs are empty" >&2
  exit 1
fi
echo "    spaBucket  = $SPA_BUCKET"
echo "    distId     = $CF_DIST_ID"

DIST_DIR="$REPO_ROOT/apps/web/dist"

echo
echo "==> Uploading full dist/ to s3://$SPA_BUCKET"
# Hashed assets first so the HTML that references them never races them.
aws s3 sync "$DIST_DIR/assets" "s3://$SPA_BUCKET/assets" \
  --region "$REGION" --delete \
  --cache-control "public, max-age=31536000, immutable"
# Fonts: stable (non-hashed) names — long but NOT immutable so a swap can
# propagate.
if [[ -d "$DIST_DIR/fonts" ]]; then
  aws s3 sync "$DIST_DIR/fonts" "s3://$SPA_BUCKET/fonts" \
    --region "$REGION" --delete \
    --cache-control "public, max-age=31536000"
fi
# Everything else Vite copied from public/ (favicon.svg, fonts, …).
# Moderate cache: these are stable-named, so they must be revalidatable.
# bootstrap-stack.sh mirrors this sync.
aws s3 sync "$DIST_DIR" "s3://$SPA_BUCKET" \
  --region "$REGION" --delete \
  --exclude "assets/*" --exclude "fonts/*" \
  --exclude "index.html" --exclude "build-id.json" \
  --exclude ".DS_Store" --exclude "*/.DS_Store" \
  --cache-control "public, max-age=3600"
# index.html + build-id.json last, no-cache, so a new deploy is picked up
# immediately (see bootstrap-stack.sh for the version-banner rationale).
aws s3 cp "$DIST_DIR/index.html" "s3://$SPA_BUCKET/index.html" \
  --region "$REGION" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"
aws s3 cp "$DIST_DIR/build-id.json" "s3://$SPA_BUCKET/build-id.json" \
  --region "$REGION" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "application/json"

echo
echo "==> Invalidating CloudFront (/*)"
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)"
echo "    invalidation $INVALIDATION_ID created (not waiting for propagation)"

echo
echo "Deploy complete. BUILD_ID=$BUILD_ID"
echo "Verify when the edge has caught up (CF invalidation is async):"
echo "  curl -fsS $WEB_ORIGIN/build-id.json   # expect buildId:$BUILD_ID"
echo "  curl -fsS $WEB_ORIGIN/api/v1/health   # expect status:ok"

exit
}
