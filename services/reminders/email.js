// External API: Brevo transactional email (https://developers.brevo.com/reference/sendtransacemail).
// The API key lives only in the environment (BREVO_API_KEY), never in the code or the repository.
// Without a key (e.g. in tests) emails are written to the log instead, and marked provider "console".
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
let sqs;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Turns a message into a simple HTML email (all user text is escaped)
function render({ heading, lines, footer }) {
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1f2937">
<h2 style="color:#0f766e">${escapeHtml(heading)}</h2>
${lines.map((l) => `<p style="font-size:15px;line-height:1.5">${escapeHtml(l)}</p>`).join('\n')}
<p style="font-size:12px;color:#6b7280;margin-top:24px">${escapeHtml(footer || 'Installment & Loan Tracker — you get this email because reminders are on for this plan.')}</p>
</div>`;
  const text = [heading, '', ...lines, '', footer || 'Installment & Loan Tracker'].join('\n');
  return { html, text };
}

async function sendEmail({ to, toName, subject, heading, lines }) {
  const { html, text } = render({ heading, lines });
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(`[email:console] to=${to} subject="${subject}"\n${text}`);
    return { ok: true, provider: 'console', messageId: `console-${Date.now()}` };
  }
  try {
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: process.env.EMAIL_FROM, name: process.env.EMAIL_FROM_NAME || 'Loan Tracker' },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        subject,
        htmlContent: html,
        textContent: text
      }),
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, provider: 'brevo', error: `Brevo ${res.status}: ${body.message || body.code || 'error'}` };
    return { ok: true, provider: 'brevo', messageId: body.messageId };
  } catch (error) {
    return { ok: false, provider: 'brevo', error: `Brevo unreachable: ${error.message}` };
  }
}

// Failed sends also go to the SQS dead-letter queue (REMINDER_DLQ_URL), so they can be inspected
// or processed later. Not having a queue (e.g. on your PC) is fine.
async function sendToDeadLetterQueue(message) {
  const url = process.env.REMINDER_DLQ_URL;
  if (!url) return;
  try {
    // useQueueUrlAsEndpoint: false -> always talk to the configured endpoint (Floci), even if the
    // queue URL says "localhost", which means something else inside the Lambda container
    sqs = sqs || new SQSClient({ useQueueUrlAsEndpoint: false });
    await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(message) }));
  } catch (error) {
    console.error('[email] could not write to the dead-letter queue:', error.message);
  }
}

module.exports = { sendEmail, sendToDeadLetterQueue, escapeHtml };
