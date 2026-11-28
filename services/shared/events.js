// Business events go to the EventBridge bus EVENT_BUS_NAME on Floci, or straight to the Reminders
// service when running locally. A failed publish is logged and never breaks the main action.
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const { callService } = require('./serviceClient');

const SOURCE = 'loan-tracker';
let client;

async function publish(detailType, detail) {
  try {
    const bus = process.env.EVENT_BUS_NAME;
    if (bus) {
      client = client || new EventBridgeClient({});
      const result = await client.send(new PutEventsCommand({
        Entries: [{ EventBusName: bus, Source: SOURCE, DetailType: detailType, Detail: JSON.stringify(detail) }]
      }));
      if (result.FailedEntryCount) console.error('[events] EventBridge rejected', detailType, result.Entries);
      else console.log(`[events] published ${detailType} to ${bus}`);
    } else if (process.env.EVENTS_MODE !== 'off') {
      await callService('reminders', 'POST', '/internal/events', { detailType, detail });
      console.log(`[events] delivered ${detailType} to reminders (local mode)`);
    }
  } catch (error) {
    console.error(`[events] could not publish ${detailType}:`, error.message);
  }
}

module.exports = { publish, SOURCE };
