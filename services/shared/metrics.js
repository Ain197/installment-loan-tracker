// Custom CloudWatch metrics (namespace METRICS_NAMESPACE, e.g. "LoanTracker").
// Used for the dashboard of the daily run and for the alarm on failed reminder emails.
// Without METRICS_NAMESPACE (your PC, tests) the values are only written to the log.
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

let client;

// metrics: { RemindersSent: 3, RemindersFailed: 0, ... }  (unit: Count unless the name ends in Amount)
async function putMetrics(metrics, dimensions = {}) {
  const namespace = process.env.METRICS_NAMESPACE;
  const entries = Object.entries(metrics).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  if (!entries.length) return;
  if (!namespace) {
    console.log('[metrics]', JSON.stringify(Object.fromEntries(entries)));
    return;
  }
  try {
    client = client || new CloudWatchClient({});
    const Dimensions = Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value: String(Value) }));
    await client.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: entries.map(([MetricName, Value]) => ({
        MetricName, Value, Unit: MetricName.endsWith('Amount') ? 'None' : 'Count', Timestamp: new Date(),
        ...(Dimensions.length ? { Dimensions } : {})
      }))
    }));
  } catch (error) {
    console.error('[metrics] could not send metrics:', error.message);
  }
}

module.exports = { putMetrics };
