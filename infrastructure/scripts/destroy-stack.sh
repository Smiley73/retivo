#!/usr/bin/env bash
# destroy-stack.sh — tear down a deployed stack so it stops billing.
#
# Usage:
#   ./infrastructure/scripts/destroy-stack.sh <dev|prod>
#
# Automates docs/deploy.md "Tearing down" steps 1-4:
#   1. Backend login + passphrase from SSM (setup_pulumi_backend), stack select.
#   2. Asks you to type the stack name to confirm.
#   3. Empties every S3 bucket the stack owns (all object versions and delete
#      markers; the object-locked audit-log bucket with
#      --bypass-governance-retention). The bucket list comes from the stack's
#      state, so it covers the access-log bucket that has no stack output.
#   4. Lifts the web app bucket's protection, runs `pulumi destroy`, and on a
#      failure re-empties the buckets (the trail may have written new logs)
#      and retries once.
#   5. Removes the stack record, keeping Pulumi.<stack>.yaml so the stack can
#      be brought back with bootstrap-stack.sh. Its old encryptionsalt line is
#      dropped (bootstrap refuses it) unless the file holds secure: values.
#
# It deliberately leaves the shared Pulumi state bucket, the per-stack SSM
# passphrase, SES identities and (prod only) the backup vault alone — see the
# summary it prints at the end and docs/deploy.md step 5.

set -euo pipefail

# One brace block so bash parses the whole file before running any of it
# (see deploy-stack.sh).
{

STACK="${1:-}"
if [[ "$STACK" != "dev" && "$STACK" != "prod" ]]; then
  echo "usage: destroy-stack.sh <dev|prod>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-common.sh
source "$SCRIPT_DIR/lib/deploy-common.sh"
resolve_repo_paths "$SCRIPT_DIR"

require pulumi
require aws
require jq

cd "$INFRA_DIR"

setup_pulumi_backend "$STACK"

# The region below comes from this file; without it every bucket call would go
# to the us-east-1 fallback and miss.
if [[ ! -f "Pulumi.$STACK.yaml" ]]; then
  echo "error: Pulumi.$STACK.yaml not found in infrastructure/ — it names the stack's region" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "==> Selecting stack '$STACK'"
pulumi stack select "$STACK"

REGION="$(pulumi config get aws:region --stack "$STACK" 2>/dev/null || echo us-east-1)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

# list_buckets — "<name> <locked:true|false>" per S3 bucket in the stack state.
list_buckets() {
  pulumi stack export --stack "$STACK" | jq -r '
    .deployment.resources[]?
    | select(.type == "aws:s3/bucket:Bucket" or .type == "aws:s3/bucketV2:BucketV2")
    | select(.outputs.bucket != null)
    | "\(.outputs.bucket) \(.outputs.objectLockEnabled // false)"'
}

# empty_bucket <bucket> [extra delete-objects args] — delete every object
# version and delete marker, 1000 at a time. Only a bucket that is really gone
# (404) is skipped; any other head-bucket failure (403, wrong region, expired
# credentials) stops the script before anything is unprotected.
empty_bucket() {
  local bucket="$1" batch err
  if ! err="$(aws s3api head-bucket --bucket "$bucket" --region "$REGION" 2>&1 >/dev/null)"; then
    if [[ "$err" == *"Not Found"* || "$err" == *"(404)"* ]]; then
      echo "    $bucket: not found, skipping"
      return 0
    fi
    echo "error: cannot reach bucket $bucket in $REGION: $err" >&2
    return 1
  fi
  echo "    emptying $bucket"
  while :; do
    batch="$(aws s3api list-object-versions --bucket "$bucket" --region "$REGION" \
      --no-paginate --output json \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}')"
    [[ "$(jq '.Objects | length' <<<"$batch")" -eq 0 ]] && break
    jq -c '{Objects: .Objects}' <<<"$batch" >"$TMP"
    if ! aws s3api delete-objects --bucket "$bucket" --region "$REGION" \
        --delete "file://$TMP" --output json "${@:2}" \
        | jq -e '(.Errors // []) | length == 0' >/dev/null; then
      echo "error: deleting objects from $bucket failed" >&2
      return 1
    fi
  done
}

# empty_all_buckets <list> — empty each bucket in a list_buckets listing. The
# list is passed in (not read through a process substitution) so a failing
# list_buckets stops the script instead of silently emptying nothing.
empty_all_buckets() {
  local name locked
  echo
  echo "==> Emptying the stack's buckets"
  while read -r name locked; do
    [[ -z "$name" ]] && continue
    if [[ "$locked" == "true" ]]; then
      empty_bucket "$name" --bypass-governance-retention
    else
      empty_bucket "$name"
    fi
  done <<<"$1"
}

BUCKETS="$(list_buckets)"
echo
echo "About to DESTROY stack '$STACK' in account $ACCOUNT ($REGION)."
echo "Every resource goes, and these buckets are emptied first (no undo):"
if [[ -n "$BUCKETS" ]]; then
  sed 's/ .*//; s/^/  - /' <<<"$BUCKETS"
else
  echo "  (none)"
fi
read -r -p "Type the stack name ($STACK) to confirm: " answer || answer=""
if [[ "$answer" != "$STACK" ]]; then
  echo "Aborted; nothing was changed."
  exit 1
fi

empty_all_buckets "$BUCKETS"

echo
echo "==> Lifting resource protection"
pulumi state unprotect --all --stack "$STACK" --yes

echo
echo "==> pulumi destroy --stack $STACK"
if ! pulumi destroy --stack "$STACK" --yes; then
  echo
  # Usually a bucket refilled after it was emptied (the trail, or access logs
  # of the emptying itself). If this retry fails too, re-running the script is
  # safe: it continues from where the destroy stopped.
  echo "==> Destroy failed; re-emptying buckets and retrying once"
  REMAINING="$(list_buckets)"
  empty_all_buckets "$REMAINING"
  pulumi destroy --stack "$STACK" --yes
fi

echo
echo "==> Removing the stack record (keeping Pulumi.$STACK.yaml)"
pulumi stack rm "$STACK" --yes --preserve-config

# bootstrap-stack.sh refuses a fresh stack whose yaml still carries the old
# encryptionsalt. The salt only matters for `secure:` values, so drop it when
# there are none; otherwise leave it and say so.
YAML="Pulumi.$STACK.yaml"
if grep -q '^encryptionsalt:' "$YAML"; then
  if grep -q 'secure:' "$YAML"; then
    echo "    note: $YAML keeps its encryptionsalt because it holds secure: values;"
    echo "          bootstrap-stack.sh will refuse it until you remove both."
  else
    sed -i.bak '/^encryptionsalt:/d' "$YAML" && rm -f "$YAML.bak"
    echo "    removed the old encryptionsalt from $YAML so bootstrap-stack.sh can reuse it"
  fi
fi

echo
echo "Stack '$STACK' is destroyed. Left in place on purpose:"
echo "  - SSM passphrase $(passphrase_ssm_param "$STACK") and the shared state backend"
echo "    $PULUMI_BACKEND_URL (needed to bring a stack back or destroy another)."
echo "  - SES identities you verified (aws sesv2 list-email-identities --region $REGION)."
if [[ "$STACK" == "prod" ]]; then
  echo "  - The backup vault retivo-prod-backups and its recovery points, if backups were on."
fi
echo "See docs/deploy.md, \"Tearing down\" step 5, to remove those too."

exit
}
