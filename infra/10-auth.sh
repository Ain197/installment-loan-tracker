#!/usr/bin/env bash
# Auth: users in Neon (DATABASE_URL) or the DynamoDB fallback table, IAM role, Lambda and API routes.
source "$(dirname "$0")/config.sh"

say "Auth: DynamoDB fallback table (used only when DATABASE_URL is empty)"
ensure_table "$T_USERS" "AttributeName=id,AttributeType=S AttributeName=email,AttributeType=S" \
  "AttributeName=id,KeyType=HASH" \
  '[{"IndexName":"email-index","KeySchema":[{"AttributeName":"email","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}]'
secret_exists "$SECRET_NEON" && ok "users will be stored in Neon Postgres (connection string in $SECRET_NEON)" || warn "no Neon secret: users go to DynamoDB $T_USERS"

say "Auth: IAM role (least privilege)"
cat > "$TMP_DIR/policy-auth.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  $(secrets_statements "$SECRET_APP" "$SECRET_NEON")
  { "Sid": "UsersTable", "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan"],
    "Resource": ["$(table_arn "$T_USERS")", "$(table_arn "$T_USERS")/index/*"] },
  { "Sid": "Logs", "Effect": "Allow",
    "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*" } ] }
JSON
ensure_lambda_role "$FN_AUTH-role" "$TMP_DIR/policy-auth.json"

say "Auth: Lambda function"
mapfile -t ENV_LINES < <(common_env; echo "SECRET_IDS=$(secret_ids neon)"; echo "USERS_TABLE=$T_USERS"; echo "ADMIN_EMAILS=${ADMIN_EMAILS:-}")
lambda_env_file "$TMP_DIR/env-auth.json" "${ENV_LINES[@]}"
deploy_lambda "$FN_AUTH" auth "$FN_AUTH-role" "$TMP_DIR/env-auth.json"

say "Auth: API routes"
connect_routes "$FN_AUTH" \
  "GET /api/health" "GET /api/health/auth" \
  "POST /api/auth/register" "POST /api/auth/login" "GET /api/auth/me" "GET /api/users"
