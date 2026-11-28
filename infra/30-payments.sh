#!/usr/bin/env bash
# Payments service: approval workflow, early payoff, receipts and reversal.
# DynamoDB (LoanPayments + status index), private S3 bucket, IAM, Lambda, API Gateway, EventBridge,
# Secrets Manager, CloudWatch.
source "$(dirname "$0")/config.sh"

say "Payments: DynamoDB table"
ensure_table "$T_PAYMENTS" \
  "AttributeName=paymentId,AttributeType=S AttributeName=planId,AttributeType=S AttributeName=createdAt,AttributeType=S AttributeName=status,AttributeType=S" \
  "AttributeName=paymentId,KeyType=HASH" \
  '[{"IndexName":"planId-index","KeySchema":[{"AttributeName":"planId","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
    {"IndexName":"status-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'

say "Payments: private S3 bucket for receipts"
if awsl s3api head-bucket --bucket "$RECEIPTS_BUCKET" >/dev/null 2>&1; then ok "bucket $RECEIPTS_BUCKET exists"
else awsl s3 mb "s3://$RECEIPTS_BUCKET" >/dev/null; ok "bucket $RECEIPTS_BUCKET created"; fi
awsl s3api put-public-access-block --bucket "$RECEIPTS_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  >/dev/null 2>&1 && ok "public access blocked" || warn "public access block not supported by this Floci version (bucket is still private)"

say "Payments: IAM role (its table, receipt files only, its events, calling Plans)"
cat > "$TMP_DIR/policy-payments.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  $(secrets_statements "$SECRET_APP")
  { "Sid": "PaymentsTable", "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
    "Resource": ["$(table_arn "$T_PAYMENTS")", "$(table_arn "$T_PAYMENTS")/index/*"] },
  { "Sid": "ReceiptFiles", "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"],
    "Resource": "arn:aws:s3:::$RECEIPTS_BUCKET/receipts/*" },
  { "Sid": "PublishEvents", "Effect": "Allow", "Action": "events:PutEvents",
    "Resource": "arn:aws:events:$REGION:$ACCOUNT_ID:event-bus/$EVENT_BUS" },
  { "Sid": "CallPlans", "Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "$(lambda_arn "$FN_PLANS")" },
  { "Sid": "Logs", "Effect": "Allow",
    "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*" } ] }
JSON
ensure_lambda_role "$FN_PAYMENTS-role" "$TMP_DIR/policy-payments.json"

say "Payments: Lambda function"
mapfile -t ENV_LINES < <(common_env; echo "SECRET_IDS=$(secret_ids)"; echo "PAYMENTS_TABLE=$T_PAYMENTS"; echo "RECEIPTS_BUCKET=$RECEIPTS_BUCKET")
lambda_env_file "$TMP_DIR/env-payments.json" "${ENV_LINES[@]}"
deploy_lambda "$FN_PAYMENTS" payments "$FN_PAYMENTS-role" "$TMP_DIR/env-payments.json"

say "Payments: API routes"
connect_routes "$FN_PAYMENTS" \
  "GET /api/health/payments" \
  "POST /api/plans/{planId}/payments" "GET /api/plans/{planId}/payments" \
  "GET /api/plans/{planId}/balance" "GET /api/balances/summary" \
  "POST /api/payments/{paymentId}/receipt" "GET /api/payments/{paymentId}/receipt" \
  "PATCH /api/payments/{paymentId}/reversal" "POST /api/plans/{planId}/payoffs" \
  "GET /api/payments/pending" "PATCH /api/payments/{paymentId}/verification" "DELETE /api/payments/{paymentId}"
