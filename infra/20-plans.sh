#!/usr/bin/env bash
# Plans service: schedules with interest, late fees and early payoff.
# DynamoDB (LoanPlans, LoanInstalments), IAM, Lambda, API Gateway, EventBridge, Secrets Manager, CloudWatch.
source "$(dirname "$0")/config.sh"

say "Plans: DynamoDB tables"
ensure_table "$T_PLANS" \
  "AttributeName=planId,AttributeType=S AttributeName=ownerId,AttributeType=S AttributeName=createdAt,AttributeType=S" \
  "AttributeName=planId,KeyType=HASH" \
  '[{"IndexName":"ownerId-index","KeySchema":[{"AttributeName":"ownerId","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'
ensure_table "$T_INSTALMENTS" \
  "AttributeName=planId,AttributeType=S AttributeName=seq,AttributeType=N" \
  "AttributeName=planId,KeyType=HASH AttributeName=seq,KeyType=RANGE"

say "Plans: IAM role (only its own tables, its events, and calling Auth)"
cat > "$TMP_DIR/policy-plans.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  $(secrets_statements "$SECRET_APP")
  { "Sid": "PlanTables", "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
               "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem"],
    "Resource": ["$(table_arn "$T_PLANS")", "$(table_arn "$T_PLANS")/index/*", "$(table_arn "$T_INSTALMENTS")"] },
  { "Sid": "PublishEvents", "Effect": "Allow", "Action": "events:PutEvents",
    "Resource": "arn:aws:events:$REGION:$ACCOUNT_ID:event-bus/$EVENT_BUS" },
  { "Sid": "CallAuth", "Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "$(lambda_arn "$FN_AUTH")" },
  { "Sid": "Logs", "Effect": "Allow",
    "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*" } ] }
JSON
ensure_lambda_role "$FN_PLANS-role" "$TMP_DIR/policy-plans.json"

say "Plans: Lambda function"
mapfile -t ENV_LINES < <(common_env; echo "SECRET_IDS=$(secret_ids)"; echo "PLANS_TABLE=$T_PLANS"; echo "INSTALMENTS_TABLE=$T_INSTALMENTS")
lambda_env_file "$TMP_DIR/env-plans.json" "${ENV_LINES[@]}"
deploy_lambda "$FN_PLANS" plans "$FN_PLANS-role" "$TMP_DIR/env-plans.json"

say "Plans: API routes"
connect_routes "$FN_PLANS" \
  "GET /api/health/plans" \
  "POST /api/plans" "GET /api/plans" \
  "GET /api/plans/{planId}" "PUT /api/plans/{planId}" "DELETE /api/plans/{planId}" \
  "PATCH /api/plans/{planId}/status" "GET /api/plans/{planId}/payoff-quote" \
  "POST /api/plans/{planId}/instalments/{seq}/late-fee-waivers"
