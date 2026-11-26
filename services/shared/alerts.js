// Operational alerts for the lender/admin on an SNS topic (ALERTS_TOPIC_ARN):
// long-overdue plans (escalations) and failed reminder emails. The CloudWatch alarm
// publishes to the same topic. Without a topic (your PC, tests) alerts are only logged.
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

let client;

async function sendAlert(subject, details) {
  const topic = process.env.ALERTS_TOPIC_ARN;
  const message = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
  if (!topic) {
    console.log(`[alert] ${subject}\n${message}`);
    return { sent: false };
  }
  try {
    client = client || new SNSClient({});
    const result = await client.send(new PublishCommand({ TopicArn: topic, Subject: subject.slice(0, 99), Message: message }));
    return { sent: true, messageId: result.MessageId };
  } catch (error) {
    console.error('[alert] could not publish to SNS:', error.message);
    return { sent: false, error: error.message };
  }
}

module.exports = { sendAlert };
