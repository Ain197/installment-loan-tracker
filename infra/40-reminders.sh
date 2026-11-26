#!/usr/bin/env bash
# Service 3 — Reminders, Notifications & Monitoring (Student C)
# The daily job: late fees (via Plans) -> reminders -> escalations -> metrics -> alerts -> run history.
# AWS services: DynamoDB (LoanReminderRules, LoanNotifications, LoanReminderRuns), SQS (dead-letter
#               queue for failed emails + alerts inbox), SNS (alerts topic), CloudWatch (Logs, custom
#               metrics, alarm), EventBridge (rule + Scheduler), IAM, Lambda, API Gateway,
#               Secrets Manager + KMS. External API: Brevo email.
source "$(dirname "$0")/config.sh"

say "Reminders: DynamoDB tables"
ensure_table "$T_RULES" "AttributeName=planId,AttributeType=S" "AttributeName=planId,KeyType=HASH"
ensure_table "$T_NOTIFICATIONS" \
  "AttributeName=notificationId,AttributeType=S AttributeName=ownerId,AttributeType=S AttributeName=planId,AttributeType=S AttributeName=createdAt,AttributeType=S" \
  "AttributeName=notificationId,KeyType=HASH" \
  '[{"IndexName":"ownerId-index","KeySchema":[{"AttributeName":"ownerId","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
    {"IndexName":"planId-index","KeySchema":[{"AttributeName":"planId","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'

ensure_table "$T_RUNS" "AttributeName=runId,AttributeType=S" "AttributeName=runId,KeyType=HASH"

say "Reminders: SNS alerts topic for the lender (+ an SQS inbox subscribed to it)"
TOPIC_ARN="$(awsl sns create-topic --name "$ALERTS_TOPIC" --query TopicArn --output text)"
ok "topic $ALERTS_TOPIC ($TOPIC_ARN)"
INBOX_URL="$(awsl sqs create-queue --queue-name "$ALERTS_INBOX" --query QueueUrl --output text)"
INBOX_ARN="$(awsl sqs get-queue-attributes --queue-url "$INBOX_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)"
node -e '
  const [queue, topic, file] = process.argv.slice(1);
  const policy = { Version: "2012-10-17", Statement: [{ Sid: "FromAlertsTopic", Effect: "Allow", Principal: { Service: "sns.amazonaws.com" },
    Action: "sqs:SendMessage", Resource: queue, Condition: { ArnEquals: { "aws:SourceArn": topic } } }] };
  require("fs").writeFileSync(file, JSON.stringify({ Policy: JSON.stringify(policy) }));
' "$INBOX_ARN" "$TOPIC_ARN" "$TMP_DIR/inbox-attrs.json"
awsl sqs set-queue-attributes --queue-url "$INBOX_URL" --attributes "file://$TMP_DIR/inbox-attrs.json"
if ! awsl sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query 'Subscriptions[].Endpoint' --output text | grep -q "$INBOX_ARN"; then
  awsl sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$INBOX_ARN" >/dev/null
fi
ok "queue $ALERTS_INBOX receives every alert (read them with: bash infra/alerts.sh)"

say "Reminders: SQS dead-letter queue for emails that failed"
DLQ_URL="$(awsl sqs create-queue --queue-name "$REMINDER_DLQ" --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)"
ok "queue $REMINDER_DLQ ($DLQ_URL)"

say "Reminders: IAM role (its tables, its queue, calling Plans)"
cat > "$TMP_DIR/policy-reminders.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  $(secrets_statements "$SECRET_APP" "$SECRET_BREVO")
  { "Sid": "ReminderTables", "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"],
    "Resource": ["$(table_arn "$T_RULES")", "$(table_arn "$T_NOTIFICATIONS")", "$(table_arn "$T_NOTIFICATIONS")/index/*", "$(table_arn "$T_RUNS")"] },
  { "Sid": "Alerts", "Effect": "Allow", "Action": "sns:Publish", "Resource": "$TOPIC_ARN" },
  { "Sid": "DeadLetterQueue", "Effect": "Allow", "Action": "sqs:SendMessage",
    "Resource": "arn:aws:sqs:$REGION:$ACCOUNT_ID:$REMINDER_DLQ" },
  { "Sid": "CallPlans", "Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "$(lambda_arn "$FN_PLANS")" },
  { "Sid": "Logs", "Effect": "Allow",
    "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*" } ] }
JSON
ensure_lambda_role "$FN_REMINDERS-role" "$TMP_DIR/policy-reminders.json"

say "Reminders: Lambda function"
mapfile -t ENV_LINES < <(common_env
  echo "SECRET_IDS=$(secret_ids brevo)"
  echo "REMINDER_RULES_TABLE=$T_RULES"; echo "NOTIFICATIONS_TABLE=$T_NOTIFICATIONS"; echo "REMINDER_RUNS_TABLE=$T_RUNS"
  echo "REMINDER_DLQ_URL=$DLQ_URL"; echo "DEFAULT_REMINDER_DAYS=${DEFAULT_REMINDER_DAYS:-3,1}"
  echo "ALERTS_TOPIC_ARN=$TOPIC_ARN"; echo "ALERT_EMAIL=${ALERT_EMAIL:-}"; echo "ESCALATION_DAYS=${ESCALATION_DAYS:-14}")
lambda_env_file "$TMP_DIR/env-reminders.json" "${ENV_LINES[@]}"
deploy_lambda "$FN_REMINDERS" reminders "$FN_REMINDERS-role" "$TMP_DIR/env-reminders.json"
secret_exists "$SECRET_BREVO" && ok "emails go through Brevo (key in $SECRET_BREVO)" || warn "no Brevo secret: emails are only written to CloudWatch Logs"

say "Reminders: API routes"
connect_routes "$FN_REMINDERS" \
  "GET /api/health/reminders" \
  "GET /api/plans/{planId}/reminder-rule" "PUT /api/plans/{planId}/reminder-rule" \
  "GET /api/reminders/upcoming" "GET /api/notifications" \
  "POST /api/notifications/{notificationId}/retries" "POST /api/reminder-runs" "GET /api/reminder-runs" \
  "GET /api/monitoring/overview"

say "Reminders: CloudWatch alarm on failed reminder emails -> SNS alerts topic"
awsl cloudwatch put-metric-alarm --alarm-name "$PREFIX-reminder-emails-failing" \
  --alarm-description "At least one reminder email failed in the last day" \
  --namespace "$METRICS_NAMESPACE" --metric-name RemindersFailed --statistic Sum \
  --period 86400 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC_ARN" \
  && ok "alarm $PREFIX-reminder-emails-failing" || warn "CloudWatch alarms not available in this Floci version"

say "Reminders: EventBridge rule (events from Plans and Payments -> this Lambda)"
awsl events put-rule --name "$PREFIX-events-to-reminders" --event-bus-name "$EVENT_BUS" \
  --event-pattern '{"source":["loan-tracker"]}' --state ENABLED >/dev/null
cat > "$TMP_DIR/targets.json" <<JSON
[{ "Id": "reminders-lambda", "Arn": "$(lambda_arn "$FN_REMINDERS")" }]
JSON
awsl events put-targets --rule "$PREFIX-events-to-reminders" --event-bus-name "$EVENT_BUS" --targets "file://$TMP_DIR/targets.json" >/dev/null
awsl lambda add-permission --function-name "$FN_REMINDERS" --statement-id events-invoke \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "arn:aws:events:$REGION:$ACCOUNT_ID:rule/$EVENT_BUS/$PREFIX-events-to-reminders" >/dev/null 2>&1 || true
ok "rule $PREFIX-events-to-reminders -> $FN_REMINDERS"

say "Reminders: daily schedule (EventBridge Scheduler)"
SCHED_ROLE="$PREFIX-scheduler-role"
cat > "$TMP_DIR/trust-scheduler.json" <<'JSON'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "Service": "scheduler.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
JSON
cat > "$TMP_DIR/policy-scheduler.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "$(lambda_arn "$FN_REMINDERS")" } ] }
JSON
awsl iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1 \
  || awsl iam create-role --role-name "$SCHED_ROLE" --assume-role-policy-document "file://$TMP_DIR/trust-scheduler.json" >/dev/null
awsl iam put-role-policy --role-name "$SCHED_ROLE" --policy-name "$SCHED_ROLE-policy" --policy-document "file://$TMP_DIR/policy-scheduler.json"
cat > "$TMP_DIR/schedule-target.json" <<JSON
{ "Arn": "$(lambda_arn "$FN_REMINDERS")", "RoleArn": "$(role_arn "$SCHED_ROLE")", "Input": "{\"action\":\"run-reminders\"}" }
JSON
CRON="${REMINDER_CRON:-cron(0 9 * * ? *)}"
SCHEDULE_NAME="$PREFIX-daily-reminders"
if awsl scheduler get-schedule --name "$SCHEDULE_NAME" >/dev/null 2>&1; then
  awsl scheduler update-schedule --name "$SCHEDULE_NAME" --schedule-expression "$CRON" \
    --schedule-expression-timezone "${APP_TIMEZONE:-Africa/Cairo}" --flexible-time-window Mode=OFF \
    --target "file://$TMP_DIR/schedule-target.json" >/dev/null && ok "schedule $SCHEDULE_NAME updated ($CRON)"
elif awsl scheduler create-schedule --name "$SCHEDULE_NAME" --schedule-expression "$CRON" \
    --schedule-expression-timezone "${APP_TIMEZONE:-Africa/Cairo}" --flexible-time-window Mode=OFF \
    --target "file://$TMP_DIR/schedule-target.json" >/dev/null 2>&1; then
  ok "schedule $SCHEDULE_NAME created ($CRON, ${APP_TIMEZONE:-Africa/Cairo})"
else
  # Fallback: a classic EventBridge scheduled rule on the default bus
  warn "EventBridge Scheduler not available, using a scheduled EventBridge rule instead"
  awsl events put-rule --name "$SCHEDULE_NAME" --schedule-expression "$CRON" --state ENABLED >/dev/null
  cat > "$TMP_DIR/rule-target.json" <<JSON
[{ "Id": "daily-check", "Arn": "$(lambda_arn "$FN_REMINDERS")", "Input": "{\"action\":\"run-reminders\"}" }]
JSON
  awsl events put-targets --rule "$SCHEDULE_NAME" --targets "file://$TMP_DIR/rule-target.json" >/dev/null
  awsl lambda add-permission --function-name "$FN_REMINDERS" --statement-id schedule-invoke \
    --action lambda:InvokeFunction --principal events.amazonaws.com \
    --source-arn "arn:aws:events:$REGION:$ACCOUNT_ID:rule/$SCHEDULE_NAME" >/dev/null 2>&1 || true
  ok "rule $SCHEDULE_NAME -> $FN_REMINDERS ($CRON, UTC)"
fi
echo "   You can always run the check by hand: Admin page > Run check now, or bash infra/run-reminders.sh"
