// Business events (PlanCreated, PaymentRecorded, ...) that other services react to.
//
// On Floci / AWS: published to the EventBridge bus named EVENT_BUS_NAME. An EventBridge rule
//   sends them to the Reminders Lambda (see infra/40-reminders.sh).
// On your PC:      there is no bus, so the event is delivered straight to the Reminders
//   service's internal route, which runs the same handler.
//
// Publishing never breaks the main action: if it fails, the error is logged and the
// payment or plan is still saved.
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
