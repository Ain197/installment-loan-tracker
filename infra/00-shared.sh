#!/usr/bin/env bash
# Shared resources used by all services: the HTTP API (API Gateway), the event bus
# (EventBridge) and the website bucket (S3). Run once before the service scripts.
source "$(dirname "$0")/config.sh"

say "Floci check"
awsl sts get-caller-identity --query Account --output text >/dev/null \
  || { echo "Floci is not answering on $AWS_ENDPOINT_URL. Start Docker Desktop and Floci first." >&2; exit 1; }
ok "Floci is running on $AWS_ENDPOINT_URL (account $ACCOUNT_ID)"

say "API Gateway: one HTTP API for the whole app"
API_ID="$(api_id)"
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID="$(awsl apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId --output text)"
  ok "API $API_NAME created ($API_ID)"
else
  ok "API $API_NAME exists ($API_ID)"
fi
if ! awsl apigatewayv2 get-stages --api-id "$API_ID" --query 'Items[].StageName' --output text | grep -q '\$default'; then
  awsl apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy >/dev/null
  ok "stage \$default created (auto-deploy)"
fi
ok "API address: $(api_url)"

say "EventBridge: event bus for PlanCreated, PaymentRecorded, ..."
if awsl events describe-event-bus --name "$EVENT_BUS" >/dev/null 2>&1; then ok "bus $EVENT_BUS exists"
else awsl events create-event-bus --name "$EVENT_BUS" >/dev/null; ok "bus $EVENT_BUS created"; fi

say "S3: website bucket"
if awsl s3api head-bucket --bucket "$WEB_BUCKET" >/dev/null 2>&1; then ok "bucket $WEB_BUCKET exists"
else awsl s3 mb "s3://$WEB_BUCKET" >/dev/null; ok "bucket $WEB_BUCKET created"; fi
# Anyone may READ the website files (only this bucket; the receipts bucket stays private)
cat > "$TMP_DIR/web-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "PublicReadWebsite", "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$WEB_BUCKET/*" } ] }
JSON
awsl s3api put-bucket-policy --bucket "$WEB_BUCKET" --policy "file://$TMP_DIR/web-policy.json" >/dev/null 2>&1 \
  && ok "website files are publicly readable" || warn "could not set the bucket policy (fine on Floci)"
