#!/usr/bin/env bash
# first-time-setup.sh — what bootstrap-stack.sh creates before its first
# `pulumi login` / `pulumi stack select`: the Pulumi state bucket, the
# per-stack passphrase, and the stack itself. SOURCE this file after
# lib/deploy-common.sh; do not execute it. Only bootstrap-stack.sh calls it —
# deploy-stack.sh never creates any of these.
#
#   first_time_setup <stack>   — idempotent; refuses (creating nothing) when
#                                it cannot settle on a passphrase safely
#   print_passphrase_notice    — the keep-exporting reminder, when it applies
#
# Needs from deploy-common.sh: INFRA_DIR, backend_region_for_stack,
# passphrase_ssm_param, stored_passphrase, refuse_passphrase_mismatch,
# resolve_backend_url.

PASSPHRASE_NOTICE=0

# probe_s3 <aws s3api args...> — returns 0 when found, 1 on Not Found, 2 on any
# other failure (Forbidden, wrong region, ...). Error text is left in PROBE_ERR.
probe_s3() {
  PROBE_ERR="$(aws s3api "$@" 2>&1 >/dev/null)" && return 0
  [[ "$PROBE_ERR" == *"Not Found"* || "$PROBE_ERR" == *"(404)"* ]] && return 1
  return 2
}

# harden_state_bucket <bucket> — (first_time_setup calls it only for a bucket it
# created or the derived retivo-pulumi-state-<account> one.) Versioning, AES256, public-access block,
# TLS-only policy, 90-day noncurrent-version expiry. Re-applied on every run
# so a first run that stopped partway is repaired by the next one.
harden_state_bucket() {
  local bucket="$1"
  aws s3api put-bucket-versioning --bucket "$bucket" \
    --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket "$bucket" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-public-access-block --bucket "$bucket" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-lifecycle-configuration --bucket "$bucket" \
    --lifecycle-configuration '{"Rules":[{"ID":"expire-noncurrent-state-versions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'
  aws s3api put-bucket-policy --bucket "$bucket" --policy "$(printf \
    '{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::%s","arn:aws:s3:::%s/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}' \
    "$bucket" "$bucket")"
  echo "    versioning + AES256 + public-access-block + TLS-only + 90d noncurrent expiry applied"
}

# first_time_setup <stack>
first_time_setup() {
  local stack="$1" yaml="$INFRA_DIR/Pulumi.$1.yaml"
  PASSPHRASE_NOTICE=0

  # Before anything is created: a missing yaml would otherwise put the bucket
  # and the passphrase in the us-east-1 fallback region.
  if [[ ! -f "$yaml" ]]; then
    echo "error: $yaml not found." >&2
    echo "       Copy $yaml.example to it and fill it in, then re-run." >&2
    exit 1
  fi

  resolve_backend_url "$stack"

  local region account project
  region="$(backend_region_for_stack "$stack")"
  account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')"
  if [[ -z "$account" ]]; then
    echo "error: could not resolve AWS account (aws sts get-caller-identity failed)." >&2
    exit 1
  fi
  echo "==> First-time setup for stack '$stack': AWS account $account, region $region"
  project="$(sed -n 's/^name:[[:space:]]*//p' "$INFRA_DIR/Pulumi.yaml" | tr -d "\"' " | head -1)"

  # --- Probe first; every refusal below happens before anything is created.
  local bucket="" key="" is_s3=0 bucket_exists=0 has_state=0 state_desc rc=0
  if [[ "$PULUMI_BACKEND_URL" == s3://* ]]; then
    is_s3=1
    local rest="${PULUMI_BACKEND_URL#s3://}"
    rest="${rest%%\?*}"
    bucket="${rest%%/*}"
    if [[ "$rest" == */* ]]; then
      # Pulumi ignores leading/trailing slashes on the prefix; "s3://b/" is the bucket root.
      key="${rest#*/}"
      while [[ "$key" == /* ]]; do key="${key#/}"; done
      while [[ "$key" == */ ]]; do key="${key%/}"; done
      if [[ -n "$key" ]]; then key="$key/"; fi
    fi
    key="${key}.pulumi/stacks/$project/$stack.json"
    state_desc="s3://$bucket/$key"
    probe_s3 head-bucket --bucket "$bucket" || rc=$?
    if [[ "$rc" -eq 2 ]]; then
      echo "error: cannot use the state bucket '$bucket' named by PULUMI_BACKEND_URL: $PROBE_ERR" >&2
      echo "       If that URL came from $INFRA_DIR/.deploy.env it may be left over from another account." >&2
      echo "       Delete the file and re-run so the bucket name is derived for this account." >&2
      exit 1
    fi
    if [[ "$rc" -eq 0 ]]; then
      bucket_exists=1
      rc=0
      probe_s3 head-object --bucket "$bucket" --key "$key" || rc=$?
      if [[ "$rc" -eq 2 ]]; then
        echo "error: cannot check for existing state at $state_desc: $PROBE_ERR" >&2
        exit 1
      fi
      if [[ "$rc" -eq 0 ]]; then has_state=1; fi
    fi
  else
    # A backend the person chose themselves: leave it alone, only look for the stack.
    state_desc="stack '$stack' in $PULUMI_BACKEND_URL"
    local listing
    pulumi login "$PULUMI_BACKEND_URL" >/dev/null
    listing="$(cd "$INFRA_DIR" && pulumi stack ls --json)"
    if jq -e --arg s "$stack" 'any(.[]; (.name | split("/") | last) == $s)' <<< "$listing" >/dev/null; then
      has_state=1
    fi
  fi

  # --- Decide the passphrase (never printed).
  local pp_param stored exported=0 generated=""
  pp_param="$(passphrase_ssm_param "$stack")"
  stored="$(stored_passphrase "$stack")"
  if [[ -n "${PULUMI_CONFIG_PASSPHRASE:-}" ]]; then exported=1; fi
  refuse_passphrase_mismatch "$stack" "$stored"
  if [[ "$exported" -eq 1 ]]; then
    if [[ -z "$stored" ]]; then PASSPHRASE_NOTICE=1; fi
  elif [[ -n "$stored" ]]; then
    export PULUMI_CONFIG_PASSPHRASE="$stored"
    echo "==> Using the passphrase stored in SSM ($pp_param)"
  elif [[ "$has_state" -eq 1 ]]; then
    echo "error: $state_desc already exists, but its passphrase is missing:" >&2
    echo "       $pp_param is not in SSM ($region) and PULUMI_CONFIG_PASSPHRASE is not set." >&2
    echo "       Nothing was created or changed. Either:" >&2
    echo "         - export PULUMI_CONFIG_PASSPHRASE with the passphrase that state was created with, or" >&2
    echo "         - store it at $pp_param (SecureString, region $region), or" >&2
    echo "         - delete that state object if the stack is disposable, then re-run." >&2
    exit 1
  else
    generated="$(openssl rand -base64 32)"
    export PULUMI_CONFIG_PASSPHRASE="$generated"
  fi

  # A yaml kept from a wiped stack carries a salt for the old passphrase, and
  # `pulumi stack init` then fails with a bare "incorrect passphrase".
  if [[ "$has_state" -eq 0 && "$exported" -eq 0 ]] && grep -q '^encryptionsalt:' "$yaml"; then
    echo "error: $yaml has an 'encryptionsalt:' line left over from an earlier stack." >&2
    echo "       A new passphrase cannot open it. Delete that line from the file and re-run." >&2
    exit 1
  fi

  # --- Create.
  if [[ "$is_s3" -eq 1 ]]; then
    echo "==> State bucket s3://$bucket"
    if [[ "$bucket_exists" -eq 1 ]]; then
      echo "    exists; re-applying configuration"
    else
      # us-east-1 rejects a LocationConstraint; every other region requires one.
      if [[ "$region" == "us-east-1" ]]; then
        aws s3api create-bucket --bucket "$bucket" --region "$region" >/dev/null
      else
        aws s3api create-bucket --bucket "$bucket" --region "$region" \
          --create-bucket-configuration "LocationConstraint=$region" >/dev/null
      fi
      echo "    created"
    fi
    # Only a bucket this run created, or the one derived for this account, is
    # ours to rewrite: put-bucket-policy and the lifecycle call replace whatever
    # the owner of any other bucket already set.
    if [[ "$bucket_exists" -eq 0 || "$bucket" == "retivo-pulumi-state-${account}" ]]; then
      harden_state_bucket "$bucket"
    else
      echo "    not the bucket derived for this account; its policy and lifecycle rules are left unchanged"
    fi
  fi
  if [[ -n "$generated" ]]; then
    # No --overwrite: a concurrent or repeated run fails rather than clobber a
    # passphrase that already encrypts state.
    if ! aws ssm put-parameter --name "$pp_param" --type SecureString \
        --value "$generated" --region "$region" >/dev/null; then
      echo "error: could not store the new passphrase at $pp_param ($region). Nothing was initialised." >&2
      exit 1
    fi
    echo "==> Stored a new passphrase at $pp_param (SecureString, $region)"
  fi
  pulumi login "$PULUMI_BACKEND_URL" >/dev/null
  if [[ "$has_state" -eq 0 ]]; then
    echo "==> Initialising stack '$stack'"
    ( cd "$INFRA_DIR" && pulumi stack init "$stack" --secrets-provider passphrase )
    echo "==> Verifying the passphrase opens the new stack"
    ( cd "$INFRA_DIR" && pulumi stack export --stack "$stack" --show-secrets >/dev/null )
  fi
}

# print_passphrase_notice — when bootstrap used an exported passphrase and
# stored nothing, say it must be exported again every time.
print_passphrase_notice() {
  if [[ "$PASSPHRASE_NOTICE" -ne 1 ]]; then return 0; fi
  echo
  echo "NOTE: PULUMI_CONFIG_PASSPHRASE was used as you exported it, and nothing was stored in SSM."
  echo "      Keep exporting the same value for every later bootstrap and deploy; without it the"
  echo "      stack's secrets cannot be decrypted."
}
