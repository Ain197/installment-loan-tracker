#!/usr/bin/env bash
# Deletes everything this project created on Floci (to start again from zero).
source "$(dirname "$0")/config.sh"
set +e
say "Deleting the Loan Tracker resources from Floci"
API="$(api_id)"; [ -n "$API" ] && [ "$API" != "None" ] && awsl apigatewayv2 delete-api --api-id "$API" && ok "API deleted"
awsl scheduler delete-schedule --name "$PREFIX-daily-reminders" >/dev/null 2>&1 && ok "schedule deleted"
for rule in "$PREFIX-daily-reminders"; do
  awsl events remove-targets --rule "$rule" --ids daily-check >/dev/null 2>&1; awsl events delete-rule --name "$rule" >/dev/null 2>&1
done
awsl events remove-targets --rule "$PREFIX-events-to-reminders" --event-bus-name "$EVENT_BUS" --ids reminders-lambda >/dev/null 2>&1
awsl events delete-rule --name "$PREFIX-events-to-reminders" --event-bus-name "$EVENT_BUS" >/dev/null 2>&1
awsl events delete-event-bus --name "$EVENT_BUS" >/dev/null 2>&1 && ok "event bus deleted"
for fn in "$FN_AUTH" "$FN_PLANS" "$FN_PAYMENTS" "$FN_REMINDERS"; do
  awsl lambda delete-function --function-name "$fn" >/dev/null 2>&1 && ok "lambda $fn deleted"
  awsl iam delete-role-policy --role-name "$fn-role" --policy-name "$fn-role-policy" >/dev/null 2>&1
  awsl iam delete-role --role-name "$fn-role" >/dev/null 2>&1
done
awsl iam delete-role-policy --role-name "$PREFIX-scheduler-role" --policy-name "$PREFIX-scheduler-role-policy" >/dev/null 2>&1
awsl iam delete-role --role-name "$PREFIX-scheduler-role" >/dev/null 2>&1
for t in "$T_USERS" "$T_PLANS" "$T_INSTALMENTS" "$T_PAYMENTS" "$T_RULES" "$T_NOTIFICATIONS" "$T_RUNS"; do
  awsl dynamodb delete-table --table-name "$t" >/dev/null 2>&1 && ok "table $t deleted"
done
Q="$(awsl sqs get-queue-url --queue-name "$REMINDER_DLQ" --query QueueUrl --output text 2>/dev/null)"; [ -n "$Q" ] && awsl sqs delete-queue --queue-url "$Q" && ok "queue deleted"
awsl cloudwatch delete-alarms --alarm-names "$PREFIX-reminder-emails-failing" >/dev/null 2>&1 && ok "alarm deleted"
awsl sns delete-topic --topic-arn "$(topic_arn)" >/dev/null 2>&1 && ok "alerts topic deleted"
Q="$(awsl sqs get-queue-url --queue-name "$ALERTS_INBOX" --query QueueUrl --output text 2>/dev/null)"; [ -n "$Q" ] && awsl sqs delete-queue --queue-url "$Q" && ok "alerts inbox deleted"
for s in "$SECRET_APP" "$SECRET_NEON" "$SECRET_BREVO"; do
  awsl secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery >/dev/null 2>&1 && ok "secret $s deleted"
done
K="$(kms_key_arn)"; if [ -n "$K" ] && [ "$K" != "None" ]; then
  awsl kms delete-alias --alias-name "$KMS_ALIAS" >/dev/null 2>&1
  awsl kms schedule-key-deletion --key-id "$K" --pending-window-in-days 7 >/dev/null 2>&1 && ok "KMS key scheduled for deletion"
fi
awsl s3 rb "s3://$WEB_BUCKET" --force >/dev/null 2>&1 && ok "bucket $WEB_BUCKET deleted"
awsl s3 rb "s3://$RECEIPTS_BUCKET" --force >/dev/null 2>&1 && ok "bucket $RECEIPTS_BUCKET deleted"
echo "Done. Run bash infra/deploy-all.sh to build everything again."
