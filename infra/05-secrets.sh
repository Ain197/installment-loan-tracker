#!/usr/bin/env bash
# Secrets Manager + KMS: every secret the app uses lives here, encrypted with our own KMS key.
# The Lambda functions only get the secret NAMES and an IAM permission to read their own ones.
#
#   loan-tracker/app    JWT_SECRET, INTERNAL_TOKEN   (generated once; change them with rotate-secrets.sh)
#   loan-tracker/neon   DATABASE_URL                 (from infra/deploy.env, if set)
#   loan-tracker/brevo  BREVO_API_KEY, EMAIL_FROM... (from infra/deploy.env, if set)
source "$(dirname "$0")/config.sh"

say "KMS: customer key for the secrets"
KEY_ARN="$(kms_key_arn)"
if [ -z "$KEY_ARN" ] || [ "$KEY_ARN" = "None" ]; then
  KEY_ID="$(awsl kms create-key --description "Loan Tracker secrets" --query KeyMetadata.KeyId --output text)"
  awsl kms create-alias --alias-name "$KMS_ALIAS" --target-key-id "$KEY_ID"
  KEY_ARN="$(kms_key_arn)"
  ok "key created ($KMS_ALIAS)"
else
  ok "key $KMS_ALIAS exists"
fi

# Writes JSON built by node from NAME=value pairs (so special characters are escaped correctly)
json_of() { node -e 'const o={};for(const p of process.argv.slice(1)){const i=p.indexOf("=");const v=p.slice(i+1);if(v!=="")o[p.slice(0,i)]=v;}process.stdout.write(JSON.stringify(o));' "$@"; }
random_secret() { node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }

# usage: upsert_secret NAME DESCRIPTION JSON_FILE
upsert_secret() {
  local name="$1" desc="$2" file="$3"
  if secret_exists "$name"; then
    local current; current="$(awsl secretsmanager get-secret-value --secret-id "$name" --query SecretString --output text 2>/dev/null || true)"
    if [ "$current" = "$(cat "$file")" ]; then ok "secret $name unchanged"; return; fi
    awsl secretsmanager put-secret-value --secret-id "$name" --secret-string "file://$file" >/dev/null
    ok "secret $name updated (new version)"
  else
    awsl secretsmanager create-secret --name "$name" --description "$desc" --kms-key-id "$KMS_ALIAS" \
      --secret-string "file://$file" --tags Key=project,Value=loan-tracker >/dev/null
    ok "secret $name created (encrypted with $KMS_ALIAS)"
  fi
}

say "Secrets Manager: $SECRET_APP"
if secret_exists "$SECRET_APP"; then
  ok "secret $SECRET_APP exists (kept as is; use infra/rotate-secrets.sh to change it)"
else
  json_of "JWT_SECRET=${JWT_SECRET:-$(random_secret)}" "INTERNAL_TOKEN=${INTERNAL_TOKEN:-$(random_secret)}" > "$TMP_DIR/secret-app.json"
  upsert_secret "$SECRET_APP" "Login token signing key and service-to-service token" "$TMP_DIR/secret-app.json"
fi

say "Secrets Manager: $SECRET_NEON"
if [ -n "${DATABASE_URL:-}" ]; then
  json_of "DATABASE_URL=$DATABASE_URL" > "$TMP_DIR/secret-neon.json"
  upsert_secret "$SECRET_NEON" "Neon Postgres connection string (users)" "$TMP_DIR/secret-neon.json"
else
  warn "DATABASE_URL is empty in deploy.env: no Neon secret, users are stored in DynamoDB"
fi

say "Secrets Manager: $SECRET_BREVO"
if [ -n "${BREVO_API_KEY:-}" ]; then
  json_of "BREVO_API_KEY=$BREVO_API_KEY" "EMAIL_FROM=${EMAIL_FROM:-}" "EMAIL_FROM_NAME=${EMAIL_FROM_NAME:-Loan Tracker}" > "$TMP_DIR/secret-brevo.json"
  upsert_secret "$SECRET_BREVO" "Brevo email API key and sender" "$TMP_DIR/secret-brevo.json"
else
  warn "BREVO_API_KEY is empty in deploy.env: no Brevo secret, emails are only logged"
fi
rm -f "$TMP_DIR"/secret-*.json
echo "   Secret values never go into the Lambda environment, the code or git."
