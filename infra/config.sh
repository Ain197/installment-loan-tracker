#!/usr/bin/env bash
# Shared settings and helpers for every infra script. Each script does: source infra/config.sh
# Works in Git Bash on Windows and on macOS/Linux.

set -euo pipefail
export MSYS_NO_PATHCONV=1          # stop Git Bash from turning /api/... into C:/Program Files/...
export AWS_PAGER=""

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && pwd)"
# On Windows (Git Bash) the AWS CLI is a Windows program: give it C:/... paths, not /c/...
if command -v cygpath >/dev/null 2>&1; then
  INFRA_DIR="$(cygpath -m "$INFRA_DIR")"
  ROOT_DIR="$(cygpath -m "$ROOT_DIR")"
fi
TMP_DIR="$INFRA_DIR/.tmp"
mkdir -p "$TMP_DIR"

if [ ! -f "$INFRA_DIR/deploy.env" ]; then
  echo "Missing infra/deploy.env. Copy infra/deploy.env.example to infra/deploy.env and fill it in." >&2
  exit 1
fi
# Read KEY=VALUE lines literally (values like Neon URLs contain & and ?, so the file is NOT run as bash)
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"                                   # Windows line endings
  [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
  key="${line%%=*}"; key="${key//[[:space:]]/}"; value="${line#*=}"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
  export "$key=$value"
done < "$INFRA_DIR/deploy.env"
unset line key value

export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_REGION="$AWS_DEFAULT_REGION"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
unset AWS_PROFILE || true
REGION="$AWS_DEFAULT_REGION"

PREFIX="loan-tracker"
API_NAME="$PREFIX-http-api"
EVENT_BUS="$PREFIX-bus"
WEB_BUCKET="${WEB_BUCKET:-$PREFIX-web}"
RECEIPTS_BUCKET="${RECEIPTS_BUCKET:-$PREFIX-receipts}"
REMINDER_DLQ="$PREFIX-reminder-dlq"
ALERTS_TOPIC="$PREFIX-alerts"
ALERTS_INBOX="$PREFIX-alerts-inbox"           # SQS queue subscribed to the alerts topic (to read alerts in the demo)
METRICS_NAMESPACE="LoanTracker"
KMS_ALIAS="alias/$PREFIX-secrets"

# Secrets Manager: one JSON secret per purpose; each Lambda may read only the ones it needs
SECRET_APP="$PREFIX/app"                       # JWT_SECRET, INTERNAL_TOKEN (+ *_PREVIOUS after a rotation)
SECRET_NEON="$PREFIX/neon"                     # DATABASE_URL
SECRET_BREVO="$PREFIX/brevo"                   # BREVO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME
LAMBDA_RUNTIME="${LAMBDA_RUNTIME:-nodejs24.x}"

FN_AUTH="$PREFIX-auth"
FN_PLANS="$PREFIX-plans"
FN_PAYMENTS="$PREFIX-payments"
FN_REMINDERS="$PREFIX-reminders"

T_USERS="LoanUsers"
T_PLANS="LoanPlans"
T_INSTALMENTS="LoanInstalments"
T_PAYMENTS="LoanPayments"
T_RULES="LoanReminderRules"
T_NOTIFICATIONS="LoanNotifications"
T_RUNS="LoanReminderRuns"

WEBSITE_ORIGIN="${WEBSITE_ORIGIN:-http://localhost:4566}"
CORS_ORIGINS="${CORS_ORIGINS:-$WEBSITE_ORIGIN,http://localhost:3000}"

# Every AWS CLI call goes to Floci (explicit --endpoint-url works with AWS CLI v1 and v2)
awsl() { aws --endpoint-url "$AWS_ENDPOINT_URL" --region "$REGION" "$@"; }
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }

# Floci's account is 000000000000; asking the emulator keeps the scripts correct anywhere
ACCOUNT_ID="${ACCOUNT_ID:-$(awsl sts get-caller-identity --query Account --output text 2>/dev/null || echo 000000000000)}"

lambda_arn() { echo "arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$1"; }
table_arn()  { echo "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$1"; }
role_arn()   { echo "arn:aws:iam::$ACCOUNT_ID:role/$1"; }
# Secrets get a random suffix in their ARN, hence the trailing -*
secret_arn() { echo "arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:$1-*"; }
topic_arn()  { echo "arn:aws:sns:$REGION:$ACCOUNT_ID:$ALERTS_TOPIC"; }
secret_exists() { awsl secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1; }
kms_key_arn() { awsl kms describe-key --key-id "$KMS_ALIAS" --query KeyMetadata.Arn --output text 2>/dev/null || true; }

# IAM statements every service needs to read its secrets (and decrypt them with the KMS key)
# usage: secrets_statements SECRET_NAME [SECRET_NAME ...]   -> JSON fragment
secrets_statements() {
  local arns="" s
  for s in "$@"; do arns="$arns\"$(secret_arn "$s")\","; done
  local key; key="$(kms_key_arn)"; [ -z "$key" ] || [ "$key" = "None" ] && key="arn:aws:kms:$REGION:$ACCOUNT_ID:key/*"
  printf '{ "Sid": "ReadOwnSecrets", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": [%s] },\n' "${arns%,}"
  printf '  { "Sid": "DecryptSecrets", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "%s",\n' "$key"
  printf '    "Condition": { "StringEquals": { "kms:ViaService": "secretsmanager.%s.amazonaws.com" } } },\n' "$REGION"
  printf '  { "Sid": "Metrics", "Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",\n'
  printf '    "Condition": { "StringEquals": { "cloudwatch:namespace": "%s" } } },' "$METRICS_NAMESPACE"
}

# Creates a pay-per-request DynamoDB table if it does not exist.
# usage: ensure_table NAME "attr-definitions" "key-schema" ['gsi-json']
ensure_table() {
  local name="$1" attrs="$2" keys="$3" gsi="${4:-}"
  if awsl dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then ok "table $name exists"; return; fi
  if [ -n "$gsi" ]; then
    printf '%s' "$gsi" > "$TMP_DIR/gsi-$name.json"
    awsl dynamodb create-table --table-name "$name" --billing-mode PAY_PER_REQUEST \
      --attribute-definitions $attrs --key-schema $keys \
      --global-secondary-indexes "file://$TMP_DIR/gsi-$name.json" >/dev/null
  else
    awsl dynamodb create-table --table-name "$name" --billing-mode PAY_PER_REQUEST \
      --attribute-definitions $attrs --key-schema $keys >/dev/null
  fi
  awsl dynamodb wait table-exists --table-name "$name"
  ok "table $name created"
}

# Creates (or updates) an IAM role for a Lambda function with an inline least-privilege policy.
# usage: ensure_lambda_role ROLE_NAME POLICY_JSON_FILE
ensure_lambda_role() {
  local role="$1" policy_file="$2"
  cat > "$TMP_DIR/trust-lambda.json" <<'JSON'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
JSON
  if ! awsl iam get-role --role-name "$role" >/dev/null 2>&1; then
    awsl iam create-role --role-name "$role" --assume-role-policy-document "file://$TMP_DIR/trust-lambda.json" >/dev/null
    ok "role $role created"
  else
    ok "role $role exists"
  fi
  awsl iam put-role-policy --role-name "$role" --policy-name "$role-policy" --policy-document "file://$policy_file"
  ok "policy $role-policy attached (least privilege)"
}

# Writes the Lambda environment as JSON (node does the escaping, so URLs with ? and & are safe).
# usage: lambda_env_file OUTFILE NAME=value NAME=value ...
lambda_env_file() {
  local out="$1"; shift
  node -e '
    const vars = {};
    for (const pair of process.argv.slice(1)) {
      const i = pair.indexOf("=");
      const value = pair.slice(i + 1);
      if (value !== "") vars[pair.slice(0, i)] = value;
    }
    process.stdout.write(JSON.stringify({ Variables: vars }));
  ' "$@" > "$out"
}

# Secret names a service may read: the app secret always, Neon/Brevo only if they were created
# usage: secret_ids neon|brevo|...  -> "loan-tracker/app,loan-tracker/neon"
secret_ids() {
  local ids="$SECRET_APP" want
  for want in "$@"; do
    case "$want" in
      neon)  secret_exists "$SECRET_NEON"  && ids="$ids,$SECRET_NEON" ;;
      brevo) secret_exists "$SECRET_BREVO" && ids="$ids,$SECRET_BREVO" ;;
    esac
  done
  echo "$ids"
}

# Environment every function gets
common_env() {
  echo "NODE_ENV=production"
  # No secret VALUES here: only the names of the secrets this function reads from Secrets Manager
  echo "SECRETS_TTL_SECONDS=${SECRETS_TTL_SECONDS:-300}"
  echo "METRICS_NAMESPACE=$METRICS_NAMESPACE"
  echo "CORS_ORIGINS=$CORS_ORIGINS"
  echo "APP_TIMEZONE=${APP_TIMEZONE:-Africa/Cairo}"
  echo "EVENT_BUS_NAME=$EVENT_BUS"
  echo "AUTH_FUNCTION_NAME=$FN_AUTH"
  echo "PLANS_FUNCTION_NAME=$FN_PLANS"
  echo "PAYMENTS_FUNCTION_NAME=$FN_PAYMENTS"
  echo "REMINDERS_FUNCTION_NAME=$FN_REMINDERS"
  echo "RATE_LIMIT_PER_MINUTE=${RATE_LIMIT_PER_MINUTE:-300}"
  # Only if your Floci does not pass its address to Lambda containers (see README, troubleshooting)
  echo "AWS_ENDPOINT_URL=${LAMBDA_AWS_ENDPOINT:-}"
}

# Creates or updates a Lambda function from infra/.build/<service>.zip
# usage: deploy_lambda FUNCTION SERVICE ROLE ENV_FILE
deploy_lambda() {
  local fn="$1" service="$2" role="$3" env_file="$4"
  local zip="$INFRA_DIR/.build/$service.zip"
  [ -f "$zip" ] || node "$INFRA_DIR/build-zips.js" "$service"
  if awsl lambda get-function --function-name "$fn" >/dev/null 2>&1; then
    awsl lambda update-function-code --function-name "$fn" --zip-file "fileb://$zip" >/dev/null
    awsl lambda wait function-updated-v2 --function-name "$fn" 2>/dev/null || sleep 3
    awsl lambda update-function-configuration --function-name "$fn" --environment "file://$env_file" \
      --timeout 20 --memory-size 256 --handler "$service/lambda.handler" >/dev/null
    awsl lambda wait function-updated-v2 --function-name "$fn" 2>/dev/null || sleep 3
    ok "lambda $fn updated"
  else
    awsl lambda create-function --function-name "$fn" --runtime "$LAMBDA_RUNTIME" \
      --handler "$service/lambda.handler" --role "$(role_arn "$fn-role")" \
      --zip-file "fileb://$zip" --timeout 20 --memory-size 256 --environment "file://$env_file" >/dev/null
    awsl lambda wait function-active-v2 --function-name "$fn" 2>/dev/null || sleep 5
    ok "lambda $fn created"
  fi
}

# Finds the shared HTTP API created by 00-shared.sh
api_id() {
  awsl apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text
}

# Connects a list of routes ("METHOD /path") of the shared API to one Lambda function,
# adds the OPTIONS routes the browser needs for CORS, and lets API Gateway call the function.
# usage: connect_routes FUNCTION "GET /api/x" "POST /api/x" ...
connect_routes() {
  local fn="$1"; shift
  local api; api="$(api_id)"
  if [ -z "$api" ] || [ "$api" = "None" ]; then echo "Run infra/00-shared.sh first (no API named $API_NAME)." >&2; exit 1; fi
  local uri; uri="$(lambda_arn "$fn")"
  local integ
  integ="$(awsl apigatewayv2 get-integrations --api-id "$api" --query "Items[?IntegrationUri=='$uri'].IntegrationId | [0]" --output text)"
  if [ -z "$integ" ] || [ "$integ" = "None" ]; then
    integ="$(awsl apigatewayv2 create-integration --api-id "$api" --integration-type AWS_PROXY \
      --payload-format-version 2.0 --integration-uri "$uri" --query IntegrationId --output text)"
    ok "integration for $fn created ($integ)"
  fi
  local existing; existing="$(awsl apigatewayv2 get-routes --api-id "$api" --query 'Items[].RouteKey' --output text | tr '\t' '\n')"
  local route paths=""
  for route in "$@"; do
    paths="$paths"$'\n'"OPTIONS ${route#* }"
  done
  local all; all="$(printf '%s\n' "$@"; printf '%s\n' "$paths" | sed '/^$/d' | sort -u)"
  while IFS= read -r route; do
    [ -z "$route" ] && continue
    if printf '%s\n' "$existing" | grep -qxF "$route"; then continue; fi
    awsl apigatewayv2 create-route --api-id "$api" --route-key "$route" --target "integrations/$integ" >/dev/null
    ok "route $route"
  done <<< "$all"
  awsl lambda add-permission --function-name "$fn" --statement-id apigw-invoke \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$api/*" >/dev/null 2>&1 || true
  ok "API Gateway may invoke $fn"
}

api_url() { echo "http://$(api_id).execute-api.localhost.floci.io:4566"; }
