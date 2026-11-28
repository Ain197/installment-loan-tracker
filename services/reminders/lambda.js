// Started by API Gateway (HTTP), the EventBridge rule (events) or EventBridge Scheduler (daily run).
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
