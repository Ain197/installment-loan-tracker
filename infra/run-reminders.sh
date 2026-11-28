#!/usr/bin/env bash
# Runs the daily reminder check now, by invoking the Lambda exactly like the schedule does.
# Optional: bash infra/run-reminders.sh 2026-12-01   (pretend today is that date)
source "$(dirname "$0")/config.sh"
PAYLOAD='{"action":"run-reminders"}'
[ -n "${1:-}" ] && PAYLOAD="{\"action\":\"run-reminders\",\"asOf\":\"$1\"}"
printf '%s' "$PAYLOAD" > "$TMP_DIR/run-payload.json"
awsl lambda invoke --function-name "$FN_REMINDERS" --cli-binary-format raw-in-base64-out \
  --payload "file://$TMP_DIR/run-payload.json" "$TMP_DIR/run-result.json" >/dev/null
node -e 'const r = require(process.argv[1]); const { results, ...s } = r; console.log(s); console.table((results || []).map(({ planTitle, seq, type, status }) => ({ planTitle, seq, type, status })));' "$TMP_DIR/run-result.json"
