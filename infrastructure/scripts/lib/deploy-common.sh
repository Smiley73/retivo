#!/usr/bin/env bash
# deploy-common.sh — helpers shared by bootstrap-stack.sh (first bring-up)
# and deploy-stack.sh (steady-state redeploy). SOURCE this file; do not
# execute it.
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/lib/deploy-common.sh"
#   resolve_repo_paths "$SCRIPT_DIR"
#
# Functions read/set these globals, so the caller must keep them in scope:
#   INFRA_DIR, REPO_ROOT  — set by resolve_repo_paths
#   BUILD_ID              — set + exported by compute_build_id
#   PULUMI_BACKEND_URL    — derived + exported by resolve_backend_url
#   PULUMI_CONFIG_PASSPHRASE — fetched + exported by setup_pulumi_backend

# The project is single-region per account: bootstrap-stack.sh creates the
# state bucket and the per-stack SSM parameters in the region every stack's
# aws:region names. Derive that same region from the stack's config file
# (this runs before a stack is selected, so read the flat yaml directly).
# Falls back to us-east-1 only if the file is missing the key.
backend_region_for_stack() {
  local f="$INFRA_DIR/Pulumi.$1.yaml" r=""
  if [[ -f "$f" ]]; then
    r="$(sed -n 's/^  aws:region:[[:space:]]*//p' "$f" | tr -d "\"' " | head -1)"
  fi
  echo "${r:-us-east-1}"
}

# require <cmd> — fail fast if a CLI dependency is missing from PATH.
require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' CLI not found on PATH" >&2
    exit 1
  fi
}

# resolve_repo_paths <script_dir> — derive INFRA_DIR + REPO_ROOT from the
# calling script's own directory (scripts/ sits directly under infra/).
resolve_repo_paths() {
  local script_dir="$1"
  INFRA_DIR="$(cd "$script_dir/.." && pwd)"
  REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
}

# passphrase_ssm_param <stack> — the SSM SecureString holding the per-stack
# Pulumi passphrase. Keyed by <stack>, so it stays correct when dev and prod
# are deployed from one checkout. bootstrap-stack.sh creates it
# (lib/first-time-setup.sh); deploy-stack.sh only reads it.
passphrase_ssm_param() {
  echo "/retivo-pulumi/$1/passphrase"
}

# stored_passphrase <stack> — print the stored passphrase, or nothing when
# the parameter is absent (or unreadable). Never prints anything else.
stored_passphrase() {
  aws ssm get-parameter --name "$(passphrase_ssm_param "$1")" --with-decryption \
    --region "$(backend_region_for_stack "$1")" --query Parameter.Value --output text 2>/dev/null || echo ''
}

# refuse_passphrase_mismatch <stack> <stored> — an ambient passphrase (an
# operator export) wins over SSM — but a stale one left over from another
# account/stack decrypts nothing and Pulumi's "incorrect passphrase" error
# doesn't say why. Fail loud when both exist and differ. (Values are
# compared, never printed.)
refuse_passphrase_mismatch() {
  local pp_param stored="$2"
  pp_param="$(passphrase_ssm_param "$1")"
  if [[ -n "${PULUMI_CONFIG_PASSPHRASE:-}" && -n "$stored" && "$PULUMI_CONFIG_PASSPHRASE" != "$stored" ]]; then
    echo "error: the exported PULUMI_CONFIG_PASSPHRASE does not match $pp_param in SSM." >&2
    echo "       It is probably left over from another account or stack. Run:" >&2
    echo "         unset PULUMI_CONFIG_PASSPHRASE" >&2
    echo "       and re-run; this script fetches the right one from SSM itself." >&2
    exit 1
  fi
}

# resolve_backend_url <stack> — set + export PULUMI_BACKEND_URL.
#
#   * Read from a gitignored infrastructure/.deploy.env if present, else
#     derived from the caller's AWS account and persisted back to that file
#     (same convention as the README).
#   * An already-set env var is only overridden if the file re-defines the
#     same key, which is intended.
resolve_backend_url() {
  local stack="$1"
  local local_env_file="$INFRA_DIR/.deploy.env"
  local BACKEND_REGION
  BACKEND_REGION="$(backend_region_for_stack "$stack")"

  # Pull persisted values into the env (set -a exports plain KEY=value lines).
  if [[ -f "$local_env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$local_env_file"
    set +a
  fi

  # A persisted/ambient backend URL pointing at a different region than the
  # stack's aws:region is a stale leftover (e.g. from before a region change)
  # and S3 would answer it with a 301. Fail loud instead of logging into the
  # wrong place.
  if [[ -n "${PULUMI_BACKEND_URL:-}" && "$PULUMI_BACKEND_URL" != *"region=${BACKEND_REGION}"* ]]; then
    echo "error: PULUMI_BACKEND_URL ($PULUMI_BACKEND_URL) does not match this stack's aws:region ($BACKEND_REGION)." >&2
    echo "       If it came from $local_env_file, delete that file and re-run so the URL is re-derived." >&2
    exit 1
  fi

  if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
    local account_id
    account_id="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')"
    if [[ -z "$account_id" ]]; then
      echo "error: could not resolve AWS account (aws sts get-caller-identity failed)." >&2
      echo "       Configure AWS credentials, or set PULUMI_BACKEND_URL in $local_env_file." >&2
      exit 1
    fi
    PULUMI_BACKEND_URL="s3://retivo-pulumi-state-${account_id}?region=${BACKEND_REGION}"
    printf 'PULUMI_BACKEND_URL=%s\n' "$PULUMI_BACKEND_URL" >> "$local_env_file"
    echo "==> Persisted PULUMI_BACKEND_URL to $local_env_file"
  fi
  export PULUMI_BACKEND_URL
}

# setup_pulumi_backend <stack> — make local runs turnkey: persist + log in
# to the S3 state backend and fetch the per-stack passphrase, so neither
# script needs a manual `pulumi login` or a hand-exported passphrase.
#
# READ-ONLY: this never creates a bucket, a parameter or a stack. Those are
# bootstrap-stack.sh's first-time setup (lib/first-time-setup.sh), which runs
# before this on a bring-up.
#
# An already-exported PULUMI_BACKEND_URL or PULUMI_CONFIG_PASSPHRASE wins
# over the values derived or fetched below.
setup_pulumi_backend() {
  local stack="$1"
  resolve_backend_url "$stack"

  echo "==> pulumi login $PULUMI_BACKEND_URL"
  pulumi login "$PULUMI_BACKEND_URL" >/dev/null

  local pp_param pp
  pp_param="$(passphrase_ssm_param "$stack")"
  pp="$(stored_passphrase "$stack")"
  if [[ -n "${PULUMI_CONFIG_PASSPHRASE:-}" ]]; then
    refuse_passphrase_mismatch "$stack" "$pp"
  elif [[ -n "$pp" ]]; then
    export PULUMI_CONFIG_PASSPHRASE="$pp"
    echo "==> Fetched PULUMI_CONFIG_PASSPHRASE from SSM ($pp_param)"
  else
    echo "error: $pp_param not found in SSM ($(backend_region_for_stack "$stack")) and no PULUMI_CONFIG_PASSPHRASE is set." >&2
    echo "       Run infrastructure/scripts/bootstrap-stack.sh $stack first — it creates the per-stack passphrase." >&2
    exit 1
  fi
}

# build_lambda — compile the API Lambda artifact (the real NestJS API,
# not the placeholder shell that answers 501).
build_lambda() {
  echo
  echo "==> Building Lambda artifact (pnpm --filter @retirement/api build:lambda)"
  ( cd "$REPO_ROOT" && pnpm --filter @retirement/api build:lambda )
}

# compute_build_id — set + export BUILD_ID, the deploy fingerprint shared
# by the SPA bundle (VITE_BUILD_ID -> __BUILD_ID__ constant) and the api
# Lambda env (BUILD_ID -> X-Build-Id response header). The SPA's version
# detector compares them and prompts a reload on mismatch — see
# apps/web/src/lib/build-id.ts. A fresh id every run means any code change
# ships with a new fingerprint.
compute_build_id() {
  local git_sha
  git_sha="$(cd "$REPO_ROOT" && git rev-parse --short=12 HEAD 2>/dev/null || echo 'nogit')"
  BUILD_ID="${git_sha}-$(date -u +%Y%m%dT%H%M%SZ)"
  export BUILD_ID
  echo "    BUILD_ID=$BUILD_ID"
}

# build_spa <stack> — production SPA build against a same-origin API.
#
# NODE_ENV=production pins a real production build. A bare `vite build`
# (Vite 8 / rolldown) without it emits a DEV bundle: `import.meta.env.DEV`
# stays true, which leaves the seeded dev-credential literals in the JS.
# Pinning it here makes the build mode independent of the operator's ambient
# shell env.
#
# The stack decides which BETA FEATURES the bundle offers: the optional
# `retivo:betaFeatures` stack config (`all` | `none` | comma-separated
# feature ids; unset ⇒ `all`) is baked in as VITE_BETA_FEATURES — see
# apps/web/src/lib/feature-flags.ts. Flipping it is a config change + a
# redeploy, no code change.
#
# The stack also decides whether the bundle carries the AI assistant
# connector's bridge port: the optional `retivo:assistantBridgePort` stack
# config (an integer 1024-65535) is baked in as VITE_ASSISTANT_BRIDGE_PORT,
# and the same key adds the one `ws://127.0.0.1:<port>` entry to the CloudFront
# CSP (infrastructure/src/edge-functions.mjs), so the tab can only dial the
# address the CSP allows. Unlike betaFeatures, a MISSING key means OFF: the
# build gets no VITE_ASSISTANT_BRIDGE_PORT at all (not an empty one). Any other
# `pulumi config get` failure, or a value outside the range, aborts the deploy.
# The same key makes the build serve the bridge itself (stage_bridge_bundle).
#
# validate_beta_features <value> — the shared "is this a legal
# VITE_BETA_FEATURES value" check: `all`, `none`, or a comma-separated list of
# ids the registry in feature-flags.ts knows. Prints nothing on success;
# prints a specific message and returns 1 on an unknown id.
validate_beta_features() {
  local value="$1"
  if [[ "$value" != "all" && "$value" != "none" ]]; then
    local known id
    known="$(sed -n "s/^[[:space:]]*id: '\([a-z0-9-]*\)',\$/\1/p" "$REPO_ROOT/apps/web/src/lib/feature-flags.ts")"
    IFS=',' read -r -a ids <<< "$value"
    for id in "${ids[@]}"; do
      id="$(echo "$id" | tr -d '[:space:]')"
      [[ -z "$id" ]] && continue
      if ! grep -qx "$id" <<< "$known"; then
        echo "error: betaFeatures names an unknown beta feature '$id' (known: $(echo "$known" | tr '\n' ' '))" >&2
        return 1
      fi
    done
  fi
  return 0
}

# resolve_beta_features <stack> — print the value to bake in, read from the
# `retivo:betaFeatures` Pulumi stack config. ONLY a missing key defaults to
# `all`; any other `pulumi config get` failure (wrong stack, backend/passphrase
# trouble) aborts the deploy rather than silently shipping every beta feature.
# Used by build_spa, so by callers that already hold a live Pulumi/AWS
# session — bootstrap-stack.sh and deploy-stack.sh.
resolve_beta_features() {
  local stack="$1" value="" err
  err="$(mktemp)"
  if ! value="$(pulumi config get retivo:betaFeatures --stack "$stack" 2>"$err")"; then
    if grep -qi "not found" "$err"; then
      value="all"
    else
      echo "error: could not read retivo:betaFeatures for stack '$stack':" >&2
      cat "$err" >&2
      rm -f "$err"
      return 1
    fi
  fi
  rm -f "$err"
  value="${value:-all}"
  validate_beta_features "$value" || return 1
  echo "$value"
}

# resolve_assistant_bridge_port <stack> — print the port to bake in, read from
# the `retivo:assistantBridgePort` Pulumi stack config, or print nothing when
# the key is missing or blank (the connector is off). Only a "not found"
# failure counts as missing; any other `pulumi config get` failure (wrong
# stack, backend/passphrase trouble) aborts rather than silently shipping a
# stack without the connector its CSP may already allow. The range check
# mirrors parseAssistantBridgePort in infrastructure/src/config-helpers.mjs:
# a plain decimal integer, 1024-65535.
resolve_assistant_bridge_port() {
  local stack="$1" value="" err
  err="$(mktemp)"
  if ! value="$(pulumi config get retivo:assistantBridgePort --stack "$stack" 2>"$err")"; then
    if grep -qi "not found" "$err"; then
      value=""
    else
      echo "error: could not read retivo:assistantBridgePort for stack '$stack':" >&2
      cat "$err" >&2
      rm -f "$err"
      return 1
    fi
  fi
  rm -f "$err"
  # Trim surrounding whitespace only; an inner space stays and fails below.
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -z "$value" ]] && return 0
  # Strip leading zeros (bash would read 08000 as octal) and cap the length
  # before the arithmetic comparison.
  local digits="${value#"${value%%[!0]*}"}"
  if [[ ! "$value" =~ ^[0-9]+$ || ${#digits} -gt 5 || -z "$digits" ]] \
    || (( digits < 1024 || digits > 65535 )); then
    echo "error: retivo:assistantBridgePort must be an integer from 1024 to 65535 (got '$value') for stack '$stack'." >&2
    echo "       Run: pulumi config set retivo:assistantBridgePort 24580 --stack $stack, or remove it: pulumi config rm retivo:assistantBridgePort --stack $stack" >&2
    return 1
  fi
  echo "$digits"
}

# stage_bridge_bundle — build the local AI assistant bridge as one file and put it
# into the SPA's dist/ (retivo-mcp-bridge.mjs, its notices, and bridge.json with
# its SHA-256), so the deploy scripts' catch-all `aws s3 sync` of dist/ uploads it
# with the rest of the site. The Settings card tells the person to download the
# file from this site, check its checksum and have the agent run it with node. The
# protocol package is rebuilt first because the bridge embeds it. Output goes to
# the bridge's default build/ directory: an ambient BRIDGE_BUNDLE_OUTPUT_DIR (the
# contract test's hook) must not redirect a real deploy.
stage_bridge_bundle() {
  echo
  echo "==> Building the bridge file this site serves (pnpm --filter @retirement/mcp-bridge build)"
  ( cd "$REPO_ROOT" && env -u BRIDGE_BUNDLE_OUTPUT_DIR -u BRIDGE_BUNDLE_METAFILE \
      pnpm --filter @retirement/assistant-protocol --filter @retirement/mcp-bridge run build )
  ( cd "$REPO_ROOT" && node scripts/stage-bridge-bundle.mjs apps/mcp-bridge/build apps/web/dist )
}

# build_spa <stack> — build the SPA with the beta features chosen by the
# stack's `retivo:betaFeatures` config (see resolve_beta_features: a genuinely
# absent key defaults to `all`) and, only when the stack sets
# `retivo:assistantBridgePort`, the connector's bridge port (see
# resolve_assistant_bridge_port: a missing key adds nothing to the build).
build_spa() {
  local stack="$1"
  local beta_features bridge_port
  beta_features="$(resolve_beta_features "$stack")" || exit 1
  bridge_port="$(resolve_assistant_bridge_port "$stack")" || exit 1
  echo
  echo "==> Building SPA (pnpm --filter @retirement/web build) — same-origin API"
  echo "    VITE_BETA_FEATURES=$beta_features (retivo:betaFeatures)"
  local spa_env=(
    NODE_ENV=production
    VITE_API_BASE_URL=""
    VITE_BUILD_ID="$BUILD_ID"
    VITE_BETA_FEATURES="$beta_features"
  )
  if [[ -n "$bridge_port" ]]; then
    echo "    VITE_ASSISTANT_BRIDGE_PORT=$bridge_port (retivo:assistantBridgePort)"
    spa_env+=(VITE_ASSISTANT_BRIDGE_PORT="$bridge_port")
  fi
  # -u: an ambient VITE_ASSISTANT_BRIDGE_PORT in the operator's shell must not
  # reach a build whose stack leaves the connector off (its CSP would forbid it).
  ( cd "$REPO_ROOT" && env -u VITE_ASSISTANT_BRIDGE_PORT "${spa_env[@]}" pnpm --filter @retirement/web build )
  # Only a stack that carries the bridge port serves the bridge file, after the
  # web build (which empties dist/). With the connector off, dist/ is unchanged.
  if [[ -n "$bridge_port" ]]; then
    stage_bridge_bundle
  fi
}
