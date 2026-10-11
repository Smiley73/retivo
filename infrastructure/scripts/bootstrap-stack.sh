#!/usr/bin/env bash
# bootstrap-stack.sh — first-time bring-up of a Pulumi stack.
#
# Usage:
#   ./scripts/bootstrap-stack.sh [stack-name] [--smoke|--no-smoke] [--yes|-y]
#                                [--lock-execute-api]
#                                [--allow-placeholder-ses]
#     stack-name : defaults to "dev"
#     --smoke    : run smoke tests after deploy without prompting
#     --no-smoke : skip smoke tests after deploy without prompting
#     --yes / -y : non-interactive mode. Auto-confirms every `pulumi up`
#                  (passes `--yes` through), defaults to running smoke
#                  tests if --smoke / --no-smoke wasn't specified, and
#                  never prompts on stdin. Use this in CI or when
#                  re-running a stack that you've already vetted.
#     --lock-execute-api :
#                  After smoke tests pass, disables the public API Gateway
#                  execute-api endpoint when retivo:apiDomainName is set.
#                  This is explicit because --yes alone must preserve the
#                  rollback path.
#     --allow-placeholder-ses :
#                  Override the fail-fast SES check. By default the
#                  script exits with code 1 when retivo:sesFromAddress
#                  is still the placeholder, so an unconfigured stack
#                  doesn't deploy for 5+ minutes only to discover signup
#                  mail won't deliver. This flag deploys with the placeholder
#                  anyway. No verification mail is sent from it and a
#                  deployed api never returns the verification token, so a
#                  new sign-up cannot verify its email or sign in until a
#                  real address is set and the stack is redeployed.
#   When --smoke / --no-smoke isn't set, the script prompts at the end
#   (TTY) or skips silently (non-TTY / CI / --yes).
#
# What it does:
#   0. First-time setup, before anything else (idempotent; see
#      lib/first-time-setup.sh): creates and hardens the Pulumi state bucket,
#      stores a generated per-stack passphrase at
#      /retivo-pulumi/<stack>/passphrase in SSM (SecureString), and runs
#      `pulumi stack init`. It needs only Pulumi.<stack>.yaml copied from its
#      .example. An exported PULUMI_CONFIG_PASSPHRASE is used as given and
#      nothing is stored — keep exporting it for every later bootstrap and
#      deploy. A stack that already has state but no passphrase is refused
#      before anything is created.
#   1. Builds the Lambda artifact from apps/api (`pnpm build:lambda`)
#      so the Pulumi stack deploys the real NestJS API instead of the
#      placeholder shell that answers 501.
#   2. Rotates the SSM placeholders into real secrets — JWT signing
#      keys + refresh-secret + edge-shared-secret. Pulumi marks `value`
#      as `ignoreChanges`, so future `pulumi up` runs leave them alone.
#   3. Pass 1 — `pulumi up` with the placeholder webOrigin already in
#      Pulumi.<stack>.yaml. CORS / Origin enforcement is dormant on the
#      very first deploy because nothing is hitting the SPA yet.
#   4. Reads the cloudfrontDomain stack output. For stacks with a custom
#      web domain and no explicit webOrigin, sets webOrigin to that
#      custom origin. For stacks without a custom web domain, updates
#      webOrigin to the CloudFront default domain and runs pass 2 to push
#      the real origin into the API Lambda env var and API Gateway CORS.
#   5. If smoke tests pass and the operator confirms (or passes
#      --lock-execute-api), disables the public execute-api endpoint and
#      verifies CloudFront still reaches the API.
#
# Why two passes: API Gateway's CORS config and the Lambda's WEB_ORIGIN
# env var both consume `webOrigin`, but the CloudFront default domain
# only exists after the distribution is created. Wiring CF.domainName
# back into APIGW would create a real dependency cycle (CF→APIGW→CF).
#
# When you have a custom domain in `retivo:domainName`, an explicit
# `retivo:webOrigin` still wins. If webOrigin is empty, the script
# derives `https://<domainName>` and applies it on pass 2.

set -euo pipefail

# The whole body is one brace block so bash parses the entire file before
# executing any of it. Without this, a `git pull` (or editor save) landing
# while the script runs shifts the byte offsets under the running bash,
# which resumes parsing mid-token and dies with a nonsense syntax error.
{

# Parse args. The first positional that isn't a flag is the stack name.
STACK=""
RUN_SMOKE=""
NON_INTERACTIVE=0
LOCK_EXECUTE_API=0
ALLOW_PLACEHOLDER_SES=0
for arg in "$@"; do
  case "$arg" in
    --smoke) RUN_SMOKE="yes" ;;
    --no-smoke) RUN_SMOKE="no" ;;
    --yes|-y) NON_INTERACTIVE=1 ;;
    --lock-execute-api) LOCK_EXECUTE_API=1 ;;
    --allow-placeholder-ses) ALLOW_PLACEHOLDER_SES=1 ;;
    --*|-?) echo "error: unknown flag '$arg'" >&2; exit 2 ;;
    *)
      if [[ -z "$STACK" ]]; then STACK="$arg"
      else echo "error: unexpected extra argument '$arg'" >&2; exit 2
      fi
      ;;
  esac
done
STACK="${STACK:-dev}"

# `pulumi up --yes` skips the interactive "Do you want to perform this
# update?" prompt. We pass the same flag through whenever non-interactive
# mode is on so a single invocation can deploy without any human input.
PULUMI_UP_FLAGS=()
if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
  PULUMI_UP_FLAGS+=("--yes")
  # Default smokes to "yes" when non-interactive; user can still
  # override with an explicit --no-smoke.
  if [[ -z "$RUN_SMOKE" ]]; then RUN_SMOKE="yes"; fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-common.sh
source "$SCRIPT_DIR/lib/deploy-common.sh"
resolve_repo_paths "$SCRIPT_DIR"

cd "$INFRA_DIR"

require pulumi
require aws
require pnpm
require openssl
# `jq` is needed to embed multi-line PEM strings into the JSON map for
# the JWT private/public-key SSM parameters.
require jq

# Create the state bucket, passphrase and stack when they don't exist yet.
# Must run before the login and `stack select` below, which need all three.
# shellcheck source=lib/first-time-setup.sh
source "$SCRIPT_DIR/lib/first-time-setup.sh"
first_time_setup "$STACK"

# Log in to the S3 state backend and fetch the per-stack passphrase.
# See deploy-common.sh.
setup_pulumi_backend "$STACK"

echo "==> Selecting stack '$STACK'"
pulumi stack select "$STACK"

REGION="$(pulumi config get aws:region --stack "$STACK" 2>/dev/null || echo us-east-1)"

# ANSI colors only when stdout is a TTY — keeps CI logs clean.
if [[ -t 1 ]]; then
  YELLOW=$'\033[1;33m'
  CYAN=$'\033[1;36m'
  RED=$'\033[1;31m'
  RESET=$'\033[0m'
else
  YELLOW=""; CYAN=""; RED=""; RESET=""
fi

# ---------------------------------------------------------------- fail-fast: SES
# Verify the operator has set a real `retivo:sesFromAddress` before
# we burn time on Lambda+SPA builds and a multi-minute pulumi up. The
# default placeholder address won't deliver mail and ships into prod
# would be a security/UX regression.
SES_FROM="$(pulumi config get retivo:sesFromAddress --stack "$STACK" 2>/dev/null || echo '')"
SES_PLACEHOLDER=0
if [[ -z "$SES_FROM" || "$SES_FROM" == "no-reply@example.invalid" ]]; then
  SES_PLACEHOLDER=1
  if [[ "$ALLOW_PLACEHOLDER_SES" -eq 1 ]]; then
    echo
    echo "${YELLOW}WARNING: retivo:sesFromAddress is the placeholder.${RESET}"
    echo "${YELLOW}Continuing because --allow-placeholder-ses was passed.${RESET}"
    echo "${YELLOW}No verification mail will be sent, and a deployed api never${RESET}"
    echo "${YELLOW}returns the verification token, so a new sign-up cannot verify${RESET}"
    echo "${YELLOW}its email or sign in until a real address is set.${RESET}"
  else
    echo >&2
    echo "${RED}error: retivo:sesFromAddress is the placeholder ('no-reply@example.invalid').${RESET}" >&2
    echo "${RED}Refusing to deploy — set a real address you control before re-running.${RESET}" >&2
    echo >&2
    echo "  ${CYAN}pulumi config set retivo:sesFromAddress you@example.com --stack $STACK${RESET}" >&2
    echo "  ${CYAN}./infrastructure/scripts/bootstrap-stack.sh $STACK${RESET}" >&2
    echo >&2
    echo "If you really need to deploy with the placeholder (dev-only, no" >&2
    echo "real mail), pass ${CYAN}--allow-placeholder-ses${RESET} to override:" >&2
    echo "  ${CYAN}./infrastructure/scripts/bootstrap-stack.sh $STACK --allow-placeholder-ses${RESET}" >&2
    exit 1
  fi
fi

build_lambda
compute_build_id
build_spa "$STACK"

echo
echo "==> Pass 1 — pulumi up with placeholder webOrigin"
echo "    (CORS/Origin enforcement is dormant on first deploy.)"
pulumi up --stack "$STACK" ${PULUMI_UP_FLAGS[@]+"${PULUMI_UP_FLAGS[@]}"}

echo
echo "==> Rotating SSM placeholders into real secrets"
JWT_PRIVATE_BASE="/retivo/$STACK/auth/jwt-private-keys"
JWT_PUBLIC_BASE="/retivo/$STACK/auth/jwt-public-keys"
REFRESH_BASE="/retivo/$STACK/auth/refresh-secret"
EDGE_BASE="/retivo/$STACK/edge/shared-secret"

# Only rotate if the parameter is still the placeholder shipped by Pulumi
# (so re-running the script doesn't churn the keys and invalidate every
# active session).
needs_rotation() {
  local name="$1"
  local current
  current="$(aws ssm get-parameter --name "$name" --with-decryption --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo '')"
  case "$current" in
    *phase-1-placeholder*) return 0 ;;
    *) return 1 ;;
  esac
}

random_secret() {
  # 64 raw bytes → base64 strip padding/newlines → ~86 chars, well over the 32-char floor.
  openssl rand -base64 64 | tr -d '\n='
}

SECRETS_ROTATED=0

# Pure-shell helper: prints the age in whole months of a JWT kid (key-YYYYMM).
# Prints -1 if the kid cannot be parsed to a date.
jwt_key_age_months() {
  local kid="$1"
  # Validate and extract year+month from key-YYYYMM format.
  # Anchored to reject wrong prefixes, 7-digit suffixes, and invalid months.
  if [[ ! "$kid" =~ ^key-([12][0-9]{3})(0[1-9]|1[0-2])$ ]]; then
    echo -1
    return
  fi
  local ky km ny nm
  ky="${BASH_REMATCH[1]}"
  km=$((10#${BASH_REMATCH[2]}))   # strip leading zero: 09 → 9
  ny=$(date -u +%Y)
  nm=$((10#$(date -u +%m)))
  echo $(( (ny - ky) * 12 + (nm - km) ))
}

# JWT signing keys are an RSA-2048 keypair.
# Private + public live in two separate SSM SecureString parameters
# keyed by the same `kid`. Both placeholders rotate together — split
# state across the two parameters would be undetectable until tokens
# fail to verify.
if needs_rotation "$JWT_PRIVATE_BASE" || needs_rotation "$JWT_PUBLIC_BASE"; then
  KID="key-$(date -u +%Y%m)"
  KEYS_TMPDIR="$(mktemp -d)"
  trap '[[ -n "${KEYS_TMPDIR:-}" ]] && rm -rf "$KEYS_TMPDIR"' EXIT
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEYS_TMPDIR/private.pem" 2>/dev/null
  openssl rsa -in "$KEYS_TMPDIR/private.pem" -pubout -out "$KEYS_TMPDIR/public.pem" 2>/dev/null
  PRIVATE_JSON="$(jq -n --arg kid "$KID" --rawfile pem "$KEYS_TMPDIR/private.pem" '{($kid): $pem}')"
  PUBLIC_JSON="$(jq -n --arg kid "$KID" --rawfile pem "$KEYS_TMPDIR/public.pem" '{($kid): $pem}')"
  aws ssm put-parameter --name "$JWT_PRIVATE_BASE" --type SecureString --value "$PRIVATE_JSON" --overwrite --region "$REGION" >/dev/null
  aws ssm put-parameter --name "$JWT_PUBLIC_BASE"  --type SecureString --value "$PUBLIC_JSON"  --overwrite --region "$REGION" >/dev/null
  rm -rf "$KEYS_TMPDIR"
  unset KEYS_TMPDIR
  echo "    JWT RS256 keypair rotated (kid=$KID)"
  SECRETS_ROTATED=1
else
  echo "    JWT signing keys already set; skipping rotation"
fi

# --- JWT key-age warning (non-blocking) ---
_jwt_public_raw=$(aws ssm get-parameter \
  --name "${JWT_PUBLIC_BASE}" \
  --with-decryption \
  --region "$REGION" \
  --query Parameter.Value \
  --output text 2>/dev/null || true)
if [[ -n "$_jwt_public_raw" ]]; then
  _newest_kid=$(echo "$_jwt_public_raw" | jq -r 'keys | sort | last' 2>/dev/null || true)
  if [[ -z "$_newest_kid" || "$_newest_kid" == "null" ]]; then
    echo "⚠️  JWT key-age check: could not determine newest kid from jwt-public-keys — age undetermined. Rotate if overdue (see JWT signing-key rotation in AGENTS.md)."
  else
    _age_months=$(jwt_key_age_months "$_newest_kid")
    if [[ "$_age_months" -eq -1 ]]; then
      echo "⚠️  JWT key-age check: kid '$_newest_kid' does not match key-YYYYMM format — age undetermined. Rotate if overdue (see JWT signing-key rotation in AGENTS.md)."
    elif [[ "$_age_months" -gt 3 ]]; then
      echo "⚠️  JWT signing key ${_newest_kid} is ${_age_months} months old — rotate (see JWT signing-key rotation in AGENTS.md)"
    fi
  fi
fi

if needs_rotation "$REFRESH_BASE"; then
  aws ssm put-parameter --name "$REFRESH_BASE" --type SecureString --value "$(random_secret)" --overwrite --region "$REGION" >/dev/null
  echo "    refresh-secret rotated"
  SECRETS_ROTATED=1
else
  echo "    refresh-secret already set; skipping"
fi

if needs_rotation "$EDGE_BASE"; then
  aws ssm put-parameter --name "$EDGE_BASE" --type SecureString --value "$(random_secret)" --overwrite --region "$REGION" >/dev/null
  echo "    edge-shared-secret rotated"
  # Critical: CloudFront's origin custom header reads this value via a
  # Pulumi data source on every up. After rotating, pass 2 must run so
  # the distribution picks up the new secret — otherwise CF still
  # forwards the old (placeholder) secret and EdgeAuthMiddleware in the
  # api Lambda rejects every CF request.
  SECRETS_ROTATED=1
else
  echo "    edge-shared-secret already set; skipping"
fi

# ---------------------------------------------------------- SES sender verification
#
# Pulumi writes the configured `retivo:sesFromAddress` value into
# the SSM `/retivo/<stack>/ses/from-address` parameter, but SES
# itself still has to verify that address before any mail will deliver
# (sandbox mode == mandatory; production access == per-domain DKIM).
# The check + create-identity below is idempotent — it skips when the
# address is already SUCCESS-verified, and triggers the verification
# email otherwise. The user has to click the link in their inbox; the
# script doesn't block on that.
echo
echo "==> Checking SES sender verification"

if [[ "$SES_PLACEHOLDER" -eq 1 ]]; then
  echo "    Skipping — sesFromAddress is the placeholder (--allow-placeholder-ses)."
  echo "    No mail will deliver, so a new sign-up cannot verify its email or sign in until a real address is set."
else
  # A verified DOMAIN identity covers every address under it — the right
  # shape for a no-mailbox sender like noreply@, since address verification
  # needs a clickable link in an inbox. Check the exact address first (an
  # operator may have verified it directly), then the domain.
  SES_DOMAIN="${SES_FROM#*@}"
  SES_STATUS="$(aws sesv2 get-email-identity --email-identity "$SES_FROM" --region "$REGION" --query 'VerifiedForSendingStatus' --output text 2>/dev/null || echo 'NOT_FOUND')"
  DOMAIN_STATUS="$(aws sesv2 get-email-identity --email-identity "$SES_DOMAIN" --region "$REGION" --query 'VerifiedForSendingStatus' --output text 2>/dev/null || echo 'NOT_FOUND')"
  if [[ "$SES_STATUS" == "True" ]]; then
    echo "    $SES_FROM is verified for sending (address identity)."
  elif [[ "$DOMAIN_STATUS" == "True" ]]; then
    echo "    $SES_FROM is covered by the verified domain identity $SES_DOMAIN (DKIM)."
  elif [[ "$DOMAIN_STATUS" != "NOT_FOUND" ]]; then
    echo "    Domain identity $SES_DOMAIN exists but is not verified yet (VerifiedForSendingStatus=$DOMAIN_STATUS)."
    echo "    DKIM CNAME records must resolve before SES verifies it — usually minutes"
    echo "    after the records exist. Inspect with:"
    echo "      aws sesv2 get-email-identity --email-identity $SES_DOMAIN --region $REGION"
    echo "    Re-run this script (or just \`pulumi up\`) once it reports SUCCESS."
  else
    # No identity at all. If this account hosts the domain Route53 zone,
    # create the domain identity and its three DKIM CNAMEs right here;
    # otherwise fall back to the click-the-link address verification.
    ZONE_ID="$(aws route53 list-hosted-zones-by-name --dns-name "$SES_DOMAIN." \
      --query "HostedZones[?Name==\`$SES_DOMAIN.\`].Id" --output text 2>/dev/null | head -1)"
    ZONE_ID="${ZONE_ID##*/}"
    if [[ -n "$ZONE_ID" ]]; then
      echo "    Creating SES DOMAIN identity $SES_DOMAIN and its DKIM records in Route53 ($ZONE_ID)."
      aws sesv2 create-email-identity --email-identity "$SES_DOMAIN" --region "$REGION" >/dev/null
      for token in $(aws sesv2 get-email-identity --email-identity "$SES_DOMAIN" --region "$REGION" \
                       --query 'DkimAttributes.Tokens[]' --output text); do
        aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{
          \"Changes\": [{\"Action\": \"UPSERT\", \"ResourceRecordSet\": {
            \"Name\": \"${token}._domainkey.${SES_DOMAIN}\", \"Type\": \"CNAME\", \"TTL\": 1800,
            \"ResourceRecords\": [{\"Value\": \"${token}.dkim.amazonses.com\"}]}}]}" >/dev/null
      done
      echo "    DKIM CNAMEs upserted; SES usually verifies within minutes."
      echo "    Re-run this script (or just \`pulumi up\`) once verification completes."
    else
      echo "    $SES_FROM is not registered with SES and this account does not host the $SES_DOMAIN zone."
      echo "    Sending the address-verification email instead (needs a real inbox at that address)."
      aws sesv2 create-email-identity --email-identity "$SES_FROM" --region "$REGION" >/dev/null
      echo "    Check the inbox at $SES_FROM and click the AWS verification link, or create"
      echo "    the domain identity + DKIM records wherever the DNS for $SES_DOMAIN lives."
      echo "    Re-run this script (or just \`pulumi up\`) after verifying."
    fi
  fi

  # Sandbox mode: recipients also need to be verified. Surface the
  # account state so the operator knows test recipients need their own
  # SES identity before signup mail can deliver.
  PROD_ACCESS="$(aws sesv2 get-account --region "$REGION" --query 'ProductionAccessEnabled' --output text 2>/dev/null || echo 'unknown')"
  if [[ "$PROD_ACCESS" != "True" ]]; then
    echo
    echo "    Note: SES is in sandbox mode (ProductionAccessEnabled=$PROD_ACCESS)."
    echo "    You can only send to verified addresses. Verify each recipient with:"
    echo "      aws sesv2 create-email-identity --email-identity recipient@example.com --region $REGION"
    echo "    For unrestricted sending, request production access from the SES console."
  fi
fi

echo
echo "==> Reading cloudfrontDomain + spaBucket outputs"
CF_DOMAIN="$(pulumi stack output cloudfrontDomain --stack "$STACK")"
CF_DIST_ID="$(pulumi stack output cloudfrontDistributionId --stack "$STACK")"
SPA_BUCKET="$(pulumi stack output spaBucket --stack "$STACK")"
if [[ -z "$CF_DOMAIN" || -z "$SPA_BUCKET" ]]; then
  echo "error: stack outputs are empty — did pass 1 succeed?" >&2
  exit 1
fi
echo "    cloudfrontDomain = $CF_DOMAIN"
echo "    spaBucket        = $SPA_BUCKET"

CURRENT_ORIGIN="$(pulumi config get retivo:webOrigin --stack "$STACK" 2>/dev/null || true)"
CUSTOM_DOMAIN="$(pulumi config get retivo:domainName --stack "$STACK" 2>/dev/null || true)"
SPA_ORIGIN="$CURRENT_ORIGIN"

NEEDS_PASS_2=0
if [[ -n "$CUSTOM_DOMAIN" ]]; then
  NEW_ORIGIN="https://$CUSTOM_DOMAIN"
  if [[ -z "$CURRENT_ORIGIN" ]]; then
    echo
    echo "==> Setting retivo:webOrigin = $NEW_ORIGIN"
    pulumi config set retivo:webOrigin "$NEW_ORIGIN" --stack "$STACK"
    NEEDS_PASS_2=1
  else
    echo
    echo "==> Custom web domain configured ($CUSTOM_DOMAIN); preserving retivo:webOrigin"
    echo "    retivo:webOrigin = $CURRENT_ORIGIN"
  fi
  SPA_ORIGIN="${CURRENT_ORIGIN:-$NEW_ORIGIN}"
else
  NEW_ORIGIN="https://$CF_DOMAIN"
  SPA_ORIGIN="$NEW_ORIGIN"
  if [[ "$CURRENT_ORIGIN" != "$NEW_ORIGIN" ]]; then
    echo
    echo "==> Setting retivo:webOrigin = $NEW_ORIGIN"
    pulumi config set retivo:webOrigin "$NEW_ORIGIN" --stack "$STACK"
    NEEDS_PASS_2=1
  fi
fi
if [[ "$SECRETS_ROTATED" -eq 1 ]]; then
  NEEDS_PASS_2=1
fi

if [[ "$NEEDS_PASS_2" -eq 1 ]]; then
  echo
  echo "==> Pass 2 — pulumi up to apply rotated secrets and any webOrigin update"
  pulumi up --stack "$STACK" ${PULUMI_UP_FLAGS[@]+"${PULUMI_UP_FLAGS[@]}"}
else
  echo
  echo "==> No webOrigin change and no SSM rotation; skipping pass 2"
fi

echo
echo "==> Uploading SPA build to s3://$SPA_BUCKET"
# Hashed assets are immutable — long max-age. index.html must be fetched
# fresh every load (no-cache) so a new deploy picks up the new asset
# hashes immediately without waiting for the CDN TTL.
aws s3 sync "$REPO_ROOT/apps/web/dist/assets" "s3://$SPA_BUCKET/assets" \
  --region "$REGION" \
  --delete \
  --cache-control "public, max-age=31536000, immutable"
# Self-hosted fonts from the Vite public dir (apps/web/public/fonts → dist/fonts,
# served at /fonts/*). Stable (non-hashed) filenames,
# so a long but NOT-immutable max-age + the /fonts/* invalidation below lets a
# future font swap propagate. `dist/fonts` may be absent on an older build — the
# guard keeps the deploy working before the font assets exist.
if [[ -d "$REPO_ROOT/apps/web/dist/fonts" ]]; then
  aws s3 sync "$REPO_ROOT/apps/web/dist/fonts" "s3://$SPA_BUCKET/fonts" \
    --region "$REGION" \
    --delete \
    --cache-control "public, max-age=31536000"
fi
# Everything else Vite copied from public/ (favicon.svg, fonts, …).
# Stable-named files, so they need a moderate, revalidatable cache — same
# stance as deploy-stack.sh. Without this sync the files are simply absent
# from the bucket and 403 through CloudFront.
aws s3 sync "$REPO_ROOT/apps/web/dist" "s3://$SPA_BUCKET" \
  --region "$REGION" \
  --delete \
  --exclude "assets/*" --exclude "fonts/*" \
  --exclude "index.html" --exclude "build-id.json" \
  --exclude ".DS_Store" --exclude "*/.DS_Store" \
  --cache-control "public, max-age=3600"
aws s3 cp "$REPO_ROOT/apps/web/dist/index.html" "s3://$SPA_BUCKET/index.html" \
  --region "$REGION" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"
# Tiny manifest the SPA fetches to verify a fresh deploy is actually live
# on CloudFront before raising the "new version available" banner. Same
# no-cache stance as index.html so the verification probe sees the new
# bundle id within seconds of the invalidation completing. See
# apps/web/src/lib/build-id.ts.
aws s3 cp "$REPO_ROOT/apps/web/dist/build-id.json" "s3://$SPA_BUCKET/build-id.json" \
  --region "$REGION" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "application/json"

if [[ -n "$CF_DIST_ID" ]]; then
  echo
  echo "==> Invalidating CloudFront cache (/*)"
  # /* rather than a path list: the catch-all sync above uploads whatever
  # public/ holds, so an enumerated list would go stale the next time a
  # file is added there (exactly how favicon.svg got missed).
  aws cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' --output text >/dev/null
fi

echo
echo "==> Stack outputs"
pulumi stack output --stack "$STACK"

API_INVOKE="$(pulumi stack output apiGatewayInvokeUrl --stack "$STACK" 2>/dev/null || echo '')"

echo
echo "Bootstrap complete."
echo "  - SPA URL        : $SPA_ORIGIN/"
echo "  - APIGW direct   : ${API_INVOKE:-<none>}"
print_passphrase_notice
echo

# ---------------------------------------------------------------- smoke tests
#
# Three checks against the deployed dev stack:
#   1. SPA root      — GET /                    → 200 + content-type: text/html
#   2. API health    — GET /api/v1/health       → 200, body contains "status":"ok"
#   3. Build manifest — GET /build-id.json      → 200, body has the just-deployed BUILD_ID
#
# Test 3 verifies the version-banner verifier's premise: that the
# manifest CloudFront serves matches the freshly deployed bundle. It
# polls (≤ 30 s) because the CF invalidation kicked off above is
# asynchronous and the edge may briefly serve the previous deploy.
#
# Each test prints PASS or FAIL with the relevant response detail; if any
# fail, the script exits with a non-zero status so callers (CI, you)
# notice. Skipped entirely if the user declines the prompt or the
# script is run non-interactively without --smoke / --no-smoke.

# Honor an explicit --smoke / --no-smoke flag (parsed at the top);
# otherwise prompt when stdin is a TTY, default to skipping when not.
if [[ -z "$RUN_SMOKE" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Run smoke tests now? [Y/n] " reply
    case "$reply" in
      ""|y|Y|yes|YES) RUN_SMOKE="yes" ;;
      *) RUN_SMOKE="no" ;;
    esac
  else
    RUN_SMOKE="no"
  fi
fi

if [[ "$RUN_SMOKE" != "yes" ]]; then
  echo
  echo "Skipping smoke tests. Re-run with --smoke or:"
  echo
  echo "  curl -I \"$SPA_ORIGIN/\""
  echo "  curl -i \"$SPA_ORIGIN/api/v1/health\""
  echo "  curl -sS \"$SPA_ORIGIN/build-id.json\""
  if [[ -n "$(pulumi config get retivo:apiDomainName --stack "$STACK" 2>/dev/null || true)" ]]; then
    echo
    echo "execute-api lockdown skipped because smoke tests did not run."
    echo "Re-run from the repo root with:"
    echo "  ./infrastructure/scripts/bootstrap-stack.sh $STACK --smoke --lock-execute-api"
  fi
  exit 0
fi

echo
echo "==> Running smoke tests"

SMOKE_FAILURES=0
fail() {
  echo "    FAIL: $1"
  SMOKE_FAILURES=$((SMOKE_FAILURES + 1))
}

print_execute_api_rollback() {
  echo "    Rollback:"
  echo "      pulumi config set retivo:disableExecuteApiEndpoint false --stack $STACK"
  echo "      pulumi up --stack $STACK"
}

maybe_lock_execute_api_endpoint() {
  local api_domain
  local disabled
  local reply
  local cf_code
  local cf_body
  local api_host
  local api_id
  local disabled_state
  local direct_url
  local direct_code
  local direct_body

  api_domain="$(pulumi config get retivo:apiDomainName --stack "$STACK" 2>/dev/null || true)"
  if [[ -z "$api_domain" ]]; then
    echo
    echo "==> execute-api lockdown skipped"
    echo "    retivo:apiDomainName is empty; CloudFront still needs the execute-api origin."
    return
  fi

  disabled="$(pulumi config get retivo:disableExecuteApiEndpoint --stack "$STACK" 2>/dev/null || echo 'false')"
  case "$disabled" in
    true|True|TRUE)
      echo
      echo "==> execute-api lockdown already enabled"
      return
      ;;
  esac

  if [[ "$LOCK_EXECUTE_API" -ne 1 ]]; then
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
      echo
      echo "==> execute-api lockdown skipped"
      echo "    --yes does not imply disabling the public API Gateway endpoint."
      echo "    Re-run with --smoke --lock-execute-api after verifying the stack."
      return
    fi
    if [[ -t 0 ]]; then
      echo
      read -r -p "Disable public execute-api endpoint now? [y/N] " reply
      case "$reply" in
        y|Y|yes|YES) ;;
        *)
          echo "==> execute-api lockdown skipped"
          echo "    Re-run with --smoke --lock-execute-api when ready."
          return
          ;;
      esac
    else
      echo
      echo "==> execute-api lockdown skipped"
      echo "    Non-interactive run without --lock-execute-api."
      echo "    Re-run with --smoke --lock-execute-api when ready."
      return
    fi
  fi

  echo
  echo "==> Disabling public execute-api endpoint"
  pulumi config set retivo:disableExecuteApiEndpoint true --stack "$STACK"
  if ! pulumi up --stack "$STACK" ${PULUMI_UP_FLAGS[@]+"${PULUMI_UP_FLAGS[@]}"}; then
    echo "    FAIL: pulumi up failed after setting disableExecuteApiEndpoint=true."
    print_execute_api_rollback
    exit 1
  fi

  echo
  echo "==> Verifying execute-api lockdown"
  cf_code="$(curl -sS -o /tmp/lock-cloudfront-health.json -w '%{http_code}' "$SPA_ORIGIN/api/v1/health" || true)"
  if [[ "$cf_code" == "200" ]] && grep -q '"status":"ok"' /tmp/lock-cloudfront-health.json 2>/dev/null; then
    echo "    PASS: CloudFront /api/v1/health still returns 200."
  else
    cf_body="$(cat /tmp/lock-cloudfront-health.json 2>/dev/null || echo '<empty>')"
    echo "    FAIL: expected CloudFront health 200 + status:ok, got $cf_code / $cf_body"
    print_execute_api_rollback
    exit 1
  fi

  if [[ -z "$API_INVOKE" ]]; then
    echo "    FAIL: apiGatewayInvokeUrl output is empty; cannot verify API Gateway setting."
    print_execute_api_rollback
    exit 1
  fi

  api_host="${API_INVOKE#https://}"
  api_host="${api_host%%/*}"
  api_id="${api_host%%.*}"
  disabled_state="$(aws apigatewayv2 get-api \
    --api-id "$api_id" \
    --region "$REGION" \
    --query 'DisableExecuteApiEndpoint' \
    --output text 2>/dev/null || echo 'UNKNOWN')"
  if [[ "$disabled_state" == "True" ]]; then
    echo "    PASS: API Gateway reports DisableExecuteApiEndpoint=True."
  else
    echo "    FAIL: API Gateway DisableExecuteApiEndpoint=$disabled_state."
    print_execute_api_rollback
    exit 1
  fi

  direct_url="${API_INVOKE%/}/api/v1/health"
  direct_code="$(curl -sS -o /tmp/lock-direct-health.txt -w '%{http_code}' "$direct_url" || true)"
  direct_body="$(cat /tmp/lock-direct-health.txt 2>/dev/null || echo '<empty>')"
  if [[ "$direct_code" == "200" ]] && grep -q '"status":"ok"' /tmp/lock-direct-health.txt 2>/dev/null; then
    echo "    FAIL: direct execute-api health still returned normal liveness response."
    print_execute_api_rollback
    exit 1
  fi
  echo "    PASS: direct execute-api health no longer returns normal liveness ($direct_code / $direct_body)."
}

# 1) SPA root — expect 200 + text/html
echo
echo "  [1/4] GET $SPA_ORIGIN/ — SPA root"
SPA_RESP="$(curl -sS -o /tmp/smoke-spa.html -w '%{http_code}\t%{content_type}' "$SPA_ORIGIN/" 2>&1 || true)"
SPA_CODE="$(printf '%s' "$SPA_RESP" | awk -F'\t' '{print $1}')"
SPA_CT="$(printf '%s' "$SPA_RESP" | awk -F'\t' '{print $2}')"
if [[ "$SPA_CODE" == "200" ]] && [[ "$SPA_CT" == text/html* ]]; then
  echo "    PASS (200, $SPA_CT)"
else
  fail "expected 200 + text/html, got $SPA_CODE / $SPA_CT"
fi

# 2) API health — expect 200 + body matches "status":"ok"
echo
echo "  [2/4] GET $SPA_ORIGIN/api/v1/health — API health"
HEALTH_BODY="$(curl -sS -o /tmp/smoke-health.json -w '%{http_code}' "$SPA_ORIGIN/api/v1/health" || true)"
HEALTH_CODE="$HEALTH_BODY"
if [[ "$HEALTH_CODE" == "200" ]] && grep -q '"status":"ok"' /tmp/smoke-health.json 2>/dev/null; then
  echo "    PASS (200, $(cat /tmp/smoke-health.json))"
else
  fail "expected 200 + status:ok, got $HEALTH_CODE / $(cat /tmp/smoke-health.json 2>/dev/null || echo '<empty>')"
fi

# 3) Build manifest — verify the just-deployed BUILD_ID is what
#    CloudFront actually serves at /build-id.json. Polled because the
#    invalidation kicked off above is asynchronous; the edge may briefly
#    return the previous deploy's manifest. ≤ 6 attempts × ~5 s ≈ 30 s.
echo
echo "  [3/3] GET $SPA_ORIGIN/build-id.json — bundle build-id manifest"
BUILDID_OK=0
BUILDID_CODE=""
BUILDID_BODY=""
for attempt in 1 2 3 4 5 6; do
  BUILDID_CODE="$(curl -sS -o /tmp/smoke-build-id.json -w '%{http_code}' "$SPA_ORIGIN/build-id.json" || true)"
  BUILDID_BODY="$(cat /tmp/smoke-build-id.json 2>/dev/null || echo '<empty>')"
  if [[ "$BUILDID_CODE" == "200" ]] && grep -q "\"buildId\":\"$BUILD_ID\"" /tmp/smoke-build-id.json 2>/dev/null; then
    BUILDID_OK=1
    break
  fi
  if [[ "$attempt" -lt 6 ]]; then
    echo "    attempt $attempt/6: got $BUILDID_CODE / $BUILDID_BODY — waiting 5 s for CF invalidation…"
    sleep 5
  fi
done
if [[ "$BUILDID_OK" -eq 1 ]]; then
  echo "    PASS (200, $BUILDID_BODY)"
else
  fail "expected 200 + buildId:$BUILD_ID after 6 attempts, got $BUILDID_CODE / $BUILDID_BODY"
fi

echo
if [[ "$SMOKE_FAILURES" -gt 0 ]]; then
  echo "Smoke tests FAILED ($SMOKE_FAILURES of 3)."
  exit 1
fi
echo "Smoke tests PASSED (3/3)."

maybe_lock_execute_api_endpoint

# Final-line callout: repeat the SES placeholder warning so it's the
# last thing the operator reads, not buried mid-output.
if [[ "$SES_PLACEHOLDER" -eq 1 ]]; then
  echo
  echo "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo "${YELLOW}WARNING: SES from-address is still the placeholder.${RESET}"
  echo "${YELLOW}Real verification mail will not be sent until you fix this:${RESET}"
  echo "  ${CYAN}pulumi config set retivo:sesFromAddress you@example.com --stack $STACK${RESET}"
  echo "  ${CYAN}./infrastructure/scripts/bootstrap-stack.sh $STACK${RESET}"
  echo "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
fi

exit
}
