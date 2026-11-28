#!/usr/bin/env bash
# Downloads the Lambda runtime image Floci needs (once), and checks network/DNS. Log: infra/pull-log.txt
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
API="$(aws --endpoint-url http://localhost:4566 --region us-east-1 apigatewayv2 get-apis --query "Items[?Name=='loan-tracker-http-api'].ApiId | [0]" --output text 2>/dev/null)"
echo "== $(date)"
echo "== internet checks"
curl -s -m 15 -o /dev/null -w "  https://public.ecr.aws -> HTTP %{http_code} in %{time_total}s\n" https://public.ecr.aws/ || echo "  public.ecr.aws unreachable"
nslookup google.com 2>&1 | tail -3
echo "== API hostname (no Lambda involved)"
curl -s -m 15 -o /dev/null -w "  http://$API.execute-api.localhost.floci.io:4566/ -> HTTP %{http_code} in %{time_total}s\n" "http://$API.execute-api.localhost.floci.io:4566/does-not-exist" || echo "  hostname failed"
echo "== docker pull public.ecr.aws/lambda/nodejs:24 (can take several minutes)"
start=$(date +%s)
docker pull public.ecr.aws/lambda/nodejs:24 2>&1 | grep -vE "Waiting|Downloading|Extracting|Verifying" 
echo "  pull exit=${PIPESTATUS[0]} after $(( $(date +%s) - start ))s"
docker images public.ecr.aws/lambda/nodejs --format '  image: {{.Repository}}:{{.Tag}} {{.Size}}'
echo "== done"
