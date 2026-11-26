// Lambda entry point (handler = reminders/lambda.handler).
// This function is started by three different things:
//   1. API Gateway (HTTP request)       -> the Express app, like the other services
//   2. EventBridge rule (bus event)     -> PlanCreated, PaymentRecorded, ... from Plans and Payments
//   3. EventBridge Scheduler (daily)    -> { "action": "run-reminders" } runs the due-date check
const serverless = require('serverless-http');
const app = require('./app');
const service = require('./reminderService');
const { SOURCE } = require('../shared/events');
const { loadSecrets } = require('../shared/secrets');

const http = serverless(app);

module.exports.handler = async (event, context) => {
  if (event && (event.requestContext || event.httpMethod)) return http(event, context);

  // Events and the schedule do not go through Express, so load the secrets here
  await loadSecrets();

  if (event && event.source === SOURCE && event['detail-type']) {
    console.log(`[reminders] event ${event['detail-type']}`);
    return service.handleEvent(event['detail-type'], event.detail || {});
  }

  if (event && (event.action === 'run-reminders' || event['detail-type'] === 'Scheduled Event')) {
    return service.runCheck({ trigger: 'schedule', asOf: event.asOf });
  }

  console.warn('[reminders] unknown event', JSON.stringify(event).slice(0, 500));
  return { ignored: true };
};
