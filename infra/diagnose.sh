#!/usr/bin/env bash
# Collects what is needed to debug the deploy on Floci. Output: infra/diagnose-log.txt
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
source infra/config.sh >/dev/null 2>&1 || true
set +e
API="$(aws --endpoint-url http://localhost:4566 --region us-east-1 apigatewayv2 get-apis --query "Items[?Name=='loan-tracker-http-api'].ApiId | [0]" --output text)"
HOST="$API.execute-api.localhost.floci.io"
echo "== $(date)  API=$API"
echo "== containers"; docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}}' | head -30
echo "== images"; docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | head -20
echo "== DNS"; nslookup "$HOST" 2>&1 | tail -4
echo "== curl by hostname (20 s max)"; curl -s -m 20 -o - -w '\nHTTP %{http_code} in %{time_total}s\n' "http://$HOST:4566/api/health/plans" 2>&1 | tail -5
echo "== curl via localhost + Host header (20 s max)"; curl -s -m 20 -H "Host: $HOST:4566" -o - -w '\nHTTP %{http_code} in %{time_total}s\n' "http://localhost:4566/api/health/plans" 2>&1 | tail -5
echo "== direct Lambda invoke of plans health (90 s max)"
printf '%s' '{"version":"2.0","rawPath":"/api/health/plans","rawQueryString":"","headers":{},"requestContext":{"http":{"method":"GET","path":"/api/health/plans","sourceIp":"1.1.1.1"}},"isBase64Encoded":false}' > infra/.tmp/diag-event.json
timeout 90 aws --endpoint-url http://localhost:4566 --region us-east-1 --cli-read-timeout 85 lambda invoke --function-name loan-tracker-plans \
  --cli-binary-format raw-in-base64-out --payload "file://$(cygpath -m "$PWD")/infra/.tmp/diag-event.json" "$(cygpath -m "$PWD")/infra/.tmp/diag-out.json" 2>&1
echo "exit=$?"; cat infra/.tmp/diag-out.json 2>/dev/null; echo
echo "== containers after invoke"; docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}}' | head -30
echo "== Floci log (last 80 lines)"; docker logs --tail 80 floci 2>&1
echo "== plans Lambda log"; aws --endpoint-url http://localhost:4566 --region us-east-1 logs tail /aws/lambda/loan-tracker-plans --since 30m 2>&1 | tail -30
echo "== done"
