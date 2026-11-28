#!/usr/bin/env bash
# Smoke test of the deployed app on Floci: PASS/FAIL per check.
source "$(dirname "$0")/config.sh"
set +e
URL="$(api_url)"
PASS=0; FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then printf '   \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1));
  else printf '   \033[31mFAIL\033[0m %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
status() { curl -s -m 60 -o "$TMP_DIR/body.json" -w '%{http_code}' "$@"; }
field() { node -e 'try { const v = process.argv[2].split(".").reduce((o,k)=>o&&o[k], JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))); console.log(v ?? ""); } catch { console.log(""); }' "$TMP_DIR/body.json" "$1"; }

say "Checking $URL"
for s in auth plans payments reminders; do
  check "GET /api/health/$s answers from Lambda" "200" "$(status "$URL/api/health/$s")"
  check "  $s runtime is lambda" "lambda" "$(field runtime)"
  check "  $s reads its secrets from Secrets Manager" "secrets-manager" "$(field secrets.source)"
  ENVJSON="$(awsl lambda get-function-configuration --function-name "$PREFIX-$s" --query Environment.Variables --output json 2>/dev/null)"
  check "  no secret values in the $s Lambda environment" "0" "$(printf '%s' "$ENVJSON" | grep -cE '"(JWT_SECRET|INTERNAL_TOKEN|DATABASE_URL|BREVO_API_KEY)"')"
done

EMAIL="check-$(date +%s)@example.com"
check "POST /api/auth/register" "201" "$(status -X POST "$URL/api/auth/register" -H 'Content-Type: application/json' -d "{\"name\":\"Check User\",\"email\":\"$EMAIL\",\"password\":\"password123\"}")"
check "POST /api/auth/login" "200" "$(status -X POST "$URL/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}")"
TOKEN="$(field token)"
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
START="$(node -e 'const d=new Date(Date.now()+86400000);console.log(d.toISOString().slice(0,10))')"
TODAY="$(node -e 'console.log(new Date().toISOString().slice(0,10))')"

check "POST /api/plans (Plans -> Auth, DynamoDB, EventBridge)" "201" "$(status -X POST "$URL/api/plans" "${AUTH[@]}" -d "{\"title\":\"Check plan\",\"provider\":\"Check shop\",\"totalAmount\":3000,\"instalmentCount\":3,\"frequency\":\"MONTHLY\",\"startDate\":\"$START\"}")"
PLAN_ID="$(field plan.planId)"
check "  schedule has 3 instalments" "3" "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).plan.instalments.length)' "$TMP_DIR/body.json" 2>/dev/null)"
check "POST invalid plan -> 400" "400" "$(status -X POST "$URL/api/plans" "${AUTH[@]}" -d '{"title":"x"}')"
check "GET /api/plans without token -> 401" "401" "$(status "$URL/api/plans")"
check "POST payment by a customer (Payments -> Plans via Lambda invoke)" "201" "$(status -X POST "$URL/api/plans/$PLAN_ID/payments" "${AUTH[@]}" -d "{\"amount\":1500,\"paidOn\":\"$TODAY\",\"method\":\"CASH\"}")"
check "  it waits for admin approval" "PENDING" "$(field payment.status)"
PAYMENT_ID="$(field payment.paymentId)"
check "POST receipt to S3" "201" "$(status -X POST "$URL/api/payments/$PAYMENT_ID/receipt" "${AUTH[@]}" -d '{"fileName":"r.pdf","contentType":"application/pdf","dataBase64":"JVBERi0xLjQgY2hlY2s="}')"
check "GET receipt back from S3" "200" "$(status "$URL/api/payments/$PAYMENT_ID/receipt" "${AUTH[@]}")"
check "GET /api/plans/{id}/balance" "200" "$(status "$URL/api/plans/$PLAN_ID/balance" "${AUTH[@]}")"
check "  pending amount is 1500" "1500" "$(field balance.pendingAmount)"
check "GET /api/plans/{id}/payoff-quote" "200" "$(status "$URL/api/plans/$PLAN_ID/payoff-quote" "${AUTH[@]}")"
check "PATCH verification as a customer -> 403" "403" "$(status -X PATCH "$URL/api/payments/$PAYMENT_ID/verification" "${AUTH[@]}" -d '{"decision":"APPROVE"}')"
sleep 3   # EventBridge delivers PlanCreated / PaymentRecorded to Reminders asynchronously
check "GET reminder rule (created by the PlanCreated event)" "200" "$(status "$URL/api/plans/$PLAN_ID/reminder-rule" "${AUTH[@]}")"
check "  rule email is the owner" "$EMAIL" "$(field rule.email)"
check "GET /api/reminders/upcoming" "200" "$(status "$URL/api/reminders/upcoming?days=30" "${AUTH[@]}")"
check "GET /api/notifications" "200" "$(status "$URL/api/notifications?planId=$PLAN_ID" "${AUTH[@]}")"
check "GET /api/monitoring/overview as a customer -> 403" "403" "$(status "$URL/api/monitoring/overview" "${AUTH[@]}")"
check "POST /api/reminder-runs as a user -> 403" "403" "$(status -X POST "$URL/api/reminder-runs" "${AUTH[@]}" -d '{}')"
check "DELETE on an unknown route -> 404 from API Gateway" "404" "$(status -X DELETE "$URL/api/payments")"
CORS="$(curl -s -m 30 -o /dev/null -D - -X OPTIONS "$URL/api/plans" -H "Origin: $WEBSITE_ORIGIN" -H 'Access-Control-Request-Method: POST' | tr -d '\r' | grep -i '^access-control-allow-origin:' | awk '{print $2}')"
check "CORS allows the website ($WEBSITE_ORIGIN)" "$WEBSITE_ORIGIN" "$CORS"
EVIL="$(curl -s -m 30 -o /dev/null -D - -X OPTIONS "$URL/api/plans" -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: POST' | tr -d '\r' | grep -ci '^access-control-allow-origin:')"
check "CORS refuses other websites" "0" "$EVIL"
check "Website index.html on S3" "200" "$(status "$WEBSITE_ORIGIN/$WEB_BUCKET/index.html")"
check "Secret $SECRET_APP exists (KMS encrypted)" "true" "$(secret_exists "$SECRET_APP" && echo true || echo false)"
check "SNS alerts topic exists" "true" "$(awsl sns get-topic-attributes --topic-arn "$(topic_arn)" >/dev/null 2>&1 && echo true || echo false)"

echo
echo "   $PASS passed, $FAIL failed. Website: $WEBSITE_ORIGIN/$WEB_BUCKET/index.html"
[ "$FAIL" -eq 0 ] || echo "   Troubleshooting: README.md, and the logs: bash infra/logs.sh <service>"
