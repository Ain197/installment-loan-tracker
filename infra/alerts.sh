#!/usr/bin/env bash
# Shows the alerts the lender received on the SNS topic (read from the SQS inbox subscribed to it):
# escalations of long-overdue plans, failed reminder emails, and the CloudWatch alarm.
source "$(dirname "$0")/config.sh"
URL="$(awsl sqs get-queue-url --queue-name "$ALERTS_INBOX" --query QueueUrl --output text)"
say "Alerts in $ALERTS_INBOX"
awsl sqs receive-message --queue-url "$URL" --max-number-of-messages 10 --wait-time-seconds 2 --output json > "$TMP_DIR/alerts.json" || true
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "{}");
  const msgs = r.Messages || [];
  if (!msgs.length) console.log("   (no new alerts)");
  for (const m of msgs) {
    let b = {}; try { b = JSON.parse(m.Body); } catch { b = { Message: m.Body }; }
    console.log(`\n   Subject: ${b.Subject || "(none)"}\n   ${String(b.Message || "").split("\n").join("\n   ")}`);
  }
' "$TMP_DIR/alerts.json"
say "CloudWatch alarm"
awsl cloudwatch describe-alarms --alarm-names "$PREFIX-reminder-emails-failing" --query 'MetricAlarms[].[AlarmName,StateValue,StateReason]' --output text | sed 's/^/   /'
