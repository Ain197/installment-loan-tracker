// Business rules for reminders: rules per plan, the daily check, notification log, retries,
// and reactions to events from the other services.
const repo = require('./repository');
const { remindersDue, escalationsDue, ids, DEFAULT_DAYS, ESCALATION_DAYS } = require('./reminderLogic');
const { putMetrics } = require('../shared/metrics');
const { sendAlert } = require('../shared/alerts');
const { sendEmail, sendToDeadLetterQueue } = require('./email');
const { today, addDays, daysBetween } = require('../shared/dates');
const { isAdmin, assertCanAccess } = require('../shared/auth');
const { notFound, conflict } = require('../shared/errors');
const { callService } = require('../shared/serviceClient');

const money = (n) => `EGP ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const getPlan = async (planId) => (await callService('plans', 'GET', `/internal/plans/${encodeURIComponent(planId)}`)).plan;
const listPlans = async (query) => (await callService('plans', 'GET', `/internal/plans?${new URLSearchParams(query)}`)).plans;

function defaultRule(plan) {
  const now = new Date().toISOString();
  return {
    planId: plan.planId, ownerId: plan.ownerId, email: plan.ownerEmail, name: plan.ownerName || '',
    daysBefore: DEFAULT_DAYS(), enabled: true, overdueAlerts: true, paymentConfirmations: true,
    createdAt: now, updatedAt: now
  };
}

// ---- reminder rules ----

async function getRuleFor(user, planId) {
  const plan = await getPlan(planId);
  assertCanAccess(user, plan.ownerId);
  return (await repo.getRule(planId)) || repo.createRuleIfMissing(defaultRule(plan));
}

async function updateRule(user, planId, changes) {
  const plan = await getPlan(planId);
  assertCanAccess(user, plan.ownerId);
  if (plan.status !== 'ACTIVE') throw conflict('PLAN_NOT_ACTIVE', 'Reminders can only be changed for an active plan.');
  const current = (await repo.getRule(planId)) || defaultRule(plan);
  const rule = {
    ...current,
    ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
    updatedAt: new Date().toISOString()
  };
  rule.daysBefore = [...new Set(rule.daysBefore)].sort((a, b) => b - a);
  return repo.putRule(rule);
}

// ---- sending (shared by the daily check, events and retries) ----

function messageFor(n, plan) {
  const greeting = `Hello ${plan.ownerName || ''},`.replace(' ,', ',');
  if (n.type === 'DUE_SOON') {
    const when = n.daysUntil === 0 ? 'today' : n.daysUntil === 1 ? 'tomorrow' : `in ${n.daysUntil} days`;
    return {
      subject: `Reminder: ${plan.title} instalment #${n.seq} is due ${when} (${n.dueDate})`,
      heading: `Instalment due ${when}`,
      lines: [greeting, `Instalment #${n.seq} of "${plan.title}" (${plan.provider}) is due on ${n.dueDate}.`,
        `Amount to pay: ${money(n.amount)}. Remaining on this plan: ${money(plan.remainingAmount)}.`]
    };
  }
  if (n.type === 'OVERDUE') {
    return {
      subject: `Overdue: ${plan.title} instalment #${n.seq} was due on ${n.dueDate}`,
      heading: 'An instalment is overdue',
      lines: [greeting, `Instalment #${n.seq} of "${plan.title}" was due on ${n.dueDate} (${n.daysLate} day(s) ago) and is not fully paid.`,
        `Amount still due: ${money(n.amount)}. Please pay it as soon as you can.`]
    };
  }
  if (n.type === 'LATE_FEE') {
    return {
      subject: `Late fee added to ${plan.title}`,
      heading: 'A late fee was added',
      lines: [greeting, ...(n.fees || []).map((f) => `Instalment #${f.seq} (due ${f.dueDate}) is ${f.daysLate} day(s) late, so a late fee of ${money(f.fee)} was added.`),
        `Remaining on this plan: ${money(plan.remainingAmount)}. Paying the overdue instalments now avoids more problems.`]
    };
  }
  if (n.type === 'PAYMENT_REJECTED') {
    return {
      subject: `Payment not accepted: ${money(n.amount)} for ${plan.title}`,
      heading: 'Your payment was not accepted',
      lines: [greeting, `The payment of ${money(n.amount)} on ${n.paidOn} for "${plan.title}" was rejected by the lender.`,
        `Reason: ${n.reason}`, 'Please record the payment again with a clear receipt, or contact the lender.']
    };
  }
  if (n.type === 'ESCALATION') {
    return {
      subject: `Escalation: ${plan.ownerName || 'a customer'} is ${n.daysLate} days late on ${plan.title}`,
      heading: 'Long-overdue instalment',
      lines: [`Customer: ${plan.ownerName || ''} (${plan.ownerEmail || ''})`, `Plan: "${plan.title}" (${plan.provider})`,
        `Instalment #${n.seq} was due on ${n.dueDate} and is ${n.daysLate} days late. Still due: ${money(n.amount)}.`,
        `Remaining on the plan: ${money(plan.remainingAmount)}. Please contact the customer.`]
    };
  }
  if (n.type === 'PAYMENT_CONFIRMED') {
    return {
      subject: `Payment received: ${money(n.amount)} for ${plan.title}`,
      heading: 'Payment recorded',
      lines: [greeting, `A payment of ${money(n.amount)} on ${n.paidOn} was recorded for "${plan.title}".`,
        `Remaining balance: ${money(n.remainingAmount)}.`]
    };
  }
  return {
    subject: `Congratulations! ${plan.title} is fully paid`,
    heading: 'Plan fully paid',
    lines: [greeting, `Every instalment of "${plan.title}" (${plan.provider}) is now paid. Well done!`]
  };
}

// Claims the notification id (so it is never sent twice), sends the email, records the result.
async function deliver(n, plan, rule, { trigger, allowFailed = false } = {}) {
  const msg = messageFor(n, plan);
  const now = new Date().toISOString();
  const previous = allowFailed ? await repo.getNotification(n.notificationId) : null;
  const claimed = await repo.claimNotification({
    notificationId: n.notificationId, type: n.type, planId: plan.planId, ownerId: plan.ownerId,
    planTitle: plan.title, seq: n.seq, dueDate: n.dueDate, amount: n.amount, daysBefore: n.daysBefore,
    email: rule.email, subject: msg.subject, status: 'SENDING', trigger, attempts: previous ? previous.attempts || 0 : 0, createdAt: previous ? previous.createdAt : now,
    detail: { daysUntil: n.daysUntil, daysLate: n.daysLate, paidOn: n.paidOn, remainingAmount: n.remainingAmount, fees: n.fees, reason: n.reason }
  }, { allowFailed });
  if (!claimed) return { status: 'ALREADY_SENT', notificationId: n.notificationId };

  const result = await sendEmail({ to: rule.email, toName: plan.ownerName, subject: msg.subject, heading: msg.heading, lines: msg.lines });
  const saved = await repo.finishNotification(n.notificationId, {
    status: result.ok ? 'SENT' : 'FAILED',
    provider: result.provider,
    providerMessageId: result.messageId || null,
    error: result.ok ? null : result.error,
    attempts: ((previous && previous.attempts) || 0) + 1,
    sentAt: result.ok ? new Date().toISOString() : null
  });
  if (!result.ok) {
    console.error(`[reminders] email failed ${n.notificationId}: ${result.error}`);
    await sendToDeadLetterQueue({ notificationId: n.notificationId, planId: plan.planId, type: n.type, error: result.error });
  }
  return { status: saved.status, notificationId: n.notificationId, error: saved.error || undefined };
}

// ---- the daily check (EventBridge schedule, or an admin pressing "Run check now") ----

async function runCheck({ asOf = today(), trigger = 'schedule' } = {}) {
  const startedAt = new Date().toISOString();
  const summary = {
    asOf, trigger, plansChecked: 0, remindersDue: 0, sent: 0, alreadySent: 0, failed: 0, skippedNoRule: 0,
    lateFees: { applied: 0, total: 0 }, escalations: 0, errors: [], results: []
  };

  // Step 1: late fees (Plans service applies them; it announces LateFeeApplied for the emails)
  try {
    const { run } = await callService('plans', 'POST', '/internal/late-fee-runs', { asOf });
    summary.lateFees = { applied: run.feesApplied, total: run.totalFees };
  } catch (error) {
    summary.errors.push(`late fees: ${error.message}`);
  }

  // Step 2: reminders before due dates and overdue alerts for customers
  const plans = await listPlans({ status: 'ACTIVE' });
  summary.plansChecked = plans.length;
  for (const plan of plans) {
    let rule = await repo.getRule(plan.planId);
    if (!rule) rule = plan.ownerEmail ? await repo.createRuleIfMissing(defaultRule(plan)) : null;
    if (!rule) { summary.skippedNoRule += 1; continue; }
    for (const n of remindersDue(plan, rule, asOf)) {
      summary.remindersDue += 1;
      const outcome = await deliver(n, plan, rule, { trigger });
      count(summary, outcome);
      summary.results.push({ planTitle: plan.title, seq: n.seq, type: n.type, dueDate: n.dueDate, ...outcome });
    }
  }

  // Step 3: escalate long-overdue instalments to the lender (email + SNS alert)
  for (const plan of plans) {
    for (const n of escalationsDue(plan)) {
      const outcome = await escalate(n, plan, trigger);
      if (outcome.status === 'SENT') summary.escalations += 1;
      count(summary, outcome);
      summary.results.push({ planTitle: plan.title, seq: n.seq, type: n.type, dueDate: n.dueDate, ...outcome });
    }
  }

  // Step 4: metrics, alert on failures, run history
  const overdueInstalments = plans.reduce((t, p) => t + (p.counts ? p.counts.overdue : 0), 0);
  await putMetrics({
    RemindersSent: summary.sent, RemindersFailed: summary.failed, Escalations: summary.escalations,
    OverdueInstalments: overdueInstalments, ActivePlans: plans.length, LateFeesApplied: summary.lateFees.applied
  });
  if (summary.failed > 0 || summary.errors.length) {
    await sendAlert(`Loan Tracker: daily run ${asOf} had problems`, {
      failedEmails: summary.failed, errors: summary.errors,
      failed: summary.results.filter((r) => r.status === 'FAILED').map((r) => ({ plan: r.planTitle, seq: r.seq, type: r.type, error: r.error }))
    });
  }
  const finishedAt = new Date().toISOString();
  await repo.putRun({
    runId: `${finishedAt}#${trigger}`, startedAt, finishedAt, ...summary,
    results: summary.results.slice(0, 100)
  });
  console.log(`[reminders] run ${asOf} (${trigger}): ${summary.plansChecked} plans, ${summary.sent} sent, ${summary.alreadySent} already sent, ${summary.failed} failed, ${summary.lateFees.applied} late fees, ${summary.escalations} escalations`);
  return summary;
}

function count(summary, outcome) {
  if (outcome.status === 'SENT') summary.sent += 1;
  else if (outcome.status === 'ALREADY_SENT') summary.alreadySent += 1;
  else summary.failed += 1;
}

// Escalations go to the lender: ALERT_EMAIL (by email) and the SNS alerts topic
async function escalate(n, plan, trigger) {
  const adminEmail = process.env.ALERT_EMAIL;
  const msg = messageFor(n, plan);
  const claimed = await repo.claimNotification({
    notificationId: n.notificationId, type: n.type, planId: plan.planId, ownerId: plan.ownerId, planTitle: plan.title,
    seq: n.seq, dueDate: n.dueDate, amount: n.amount, email: adminEmail || '(SNS only)', subject: msg.subject,
    status: 'SENDING', trigger, attempts: 0, createdAt: new Date().toISOString(), detail: { daysLate: n.daysLate }
  });
  if (!claimed) return { status: 'ALREADY_SENT', notificationId: n.notificationId };
  const alert = await sendAlert(msg.subject, msg.lines.join('\n'));
  const email = adminEmail ? await sendEmail({ to: adminEmail, subject: msg.subject, heading: msg.heading, lines: msg.lines }) : { ok: true, provider: 'sns' };
  const ok = email.ok;
  const saved = await repo.finishNotification(n.notificationId, {
    status: ok ? 'SENT' : 'FAILED', provider: adminEmail ? `${email.provider}+sns` : 'sns',
    providerMessageId: email.messageId || alert.messageId || null, error: ok ? null : email.error, attempts: 1,
    sentAt: ok ? new Date().toISOString() : null
  });
  return { status: saved.status, notificationId: n.notificationId, error: saved.error || undefined };
}

async function listRuns(limit = 20) {
  const runs = await repo.listRuns();
  return runs.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, limit)
    .map(({ results, ...run }) => ({ ...run, resultsCount: (results || []).length }));
}

// Admin monitoring page: last runs + what happened to emails in the last 7 days
async function monitoringOverview() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const recent = (await repo.listAll()).filter((n) => n.createdAt >= since);
  const byType = {};
  for (const n of recent) {
    byType[n.type] = byType[n.type] || { SENT: 0, FAILED: 0, SENDING: 0 };
    byType[n.type][n.status] = (byType[n.type][n.status] || 0) + 1;
  }
  return {
    since,
    runs: await listRuns(10),
    notifications: { total: recent.length, failed: recent.filter((n) => n.status === 'FAILED').length, byType },
    settings: {
      escalationDays: ESCALATION_DAYS(),
      alertsTopic: process.env.ALERTS_TOPIC_ARN ? 'configured' : 'not configured (alerts only logged)',
      alertEmail: process.env.ALERT_EMAIL ? 'configured' : 'not set',
      metricsNamespace: process.env.METRICS_NAMESPACE || 'off (metrics only logged)',
      emailProvider: process.env.BREVO_API_KEY ? 'brevo' : 'console (no API key)'
    }
  };
}

// ---- dashboard and log ----

async function upcoming(user, days) {
  const plans = await listPlans(isAdmin(user) ? { status: 'ACTIVE' } : { ownerId: user.id, status: 'ACTIVE' });
  const asOf = today();
  const until = addDays(asOf, days);
  const due = [];
  const overdue = [];
  for (const plan of plans) {
    for (const inst of plan.instalments) {
      if (inst.status === 'PAID') continue;
      const item = {
        planId: plan.planId, planTitle: plan.title, provider: plan.provider, ownerName: plan.ownerName,
        seq: inst.seq, dueDate: inst.dueDate, amountRemaining: inst.amountRemaining, status: inst.status,
        daysUntil: daysBetween(asOf, inst.dueDate)
      };
      if (inst.status === 'OVERDUE') overdue.push(item);
      else if (inst.dueDate <= until) due.push(item);
    }
  }
  due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { asOf, days, upcoming: due, overdue };
}

async function listNotifications(user, { planId, status, type }) {
  let items;
  if (planId) {
    const plan = await getPlan(planId);
    assertCanAccess(user, plan.ownerId);
    items = await repo.listByPlan(planId);
  } else {
    items = isAdmin(user) ? await repo.listAll() : await repo.listByOwner(user.id);
  }
  return items
    .filter((n) => (!status || n.status === status) && (!type || n.type === type))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200);
}

async function retry(user, notificationId) {
  const existing = await repo.getNotification(notificationId);
  if (!existing) throw notFound('Notification');
  assertCanAccess(user, existing.ownerId);
  if (existing.type === 'ESCALATION') throw conflict('NOT_RETRYABLE', 'Escalations are lender alerts; they are also on the SNS alerts topic.');
  if (existing.status !== 'FAILED') throw conflict('NOT_FAILED', `Only failed notifications can be retried (this one is ${existing.status}).`);
  const plan = await getPlan(existing.planId);
  const rule = (await repo.getRule(existing.planId)) || defaultRule(plan);
  const n = { notificationId, type: existing.type, seq: existing.seq, dueDate: existing.dueDate, amount: existing.amount, daysBefore: existing.daysBefore, ...(existing.detail || {}) };
  const outcome = await deliver(n, plan, rule, { trigger: 'retry', allowFailed: true });
  if (outcome.status === 'ALREADY_SENT') throw conflict('NOT_FAILED', 'This notification is no longer failed.');
  return repo.getNotification(notificationId);
}

// ---- events from Plans and Payments ----

async function handleEvent(detailType, detail) {
  switch (detailType) {
    case 'PlanCreated':
      await repo.createRuleIfMissing(defaultRule({ planId: detail.planId, ownerId: detail.ownerId, ownerEmail: detail.ownerEmail, ownerName: detail.ownerName }));
      return { handled: true };
    case 'PlanCancelled': {
      const rule = await repo.getRule(detail.planId);
      if (rule) await repo.putRule({ ...rule, enabled: false, updatedAt: new Date().toISOString() });
      return { handled: true };
    }
    case 'PlanDeleted':
      await repo.deleteRule(detail.planId);
      return { handled: true };
    case 'LateFeeApplied':
    case 'PaymentRejected': {
      const rule = await repo.getRule(detail.planId);
      if (!rule || !rule.enabled) return { handled: true, sent: false };
      const plan = await getPlan(detail.planId);
      const n = detailType === 'LateFeeApplied'
        ? { notificationId: ids.lateFee(detail.planId, detail.asOf), type: 'LATE_FEE', fees: detail.fees, amount: detail.fees.reduce((t, f) => t + f.fee, 0) }
        : { notificationId: ids.rejected(detail.paymentId), type: 'PAYMENT_REJECTED', amount: detail.amount, paidOn: detail.paidOn, reason: detail.reason };
      const outcome = await deliver(n, plan, rule, { trigger: 'event' });
      return { handled: true, ...outcome };
    }
    case 'PaymentRecorded':
    case 'PlanCompleted': {
      const rule = await repo.getRule(detail.planId);
      if (!rule || !rule.enabled || rule.paymentConfirmations === false) return { handled: true, sent: false };
      const plan = await getPlan(detail.planId);
      const n = detailType === 'PaymentRecorded'
        ? { notificationId: ids.payment(detail.paymentId), type: 'PAYMENT_CONFIRMED', amount: detail.amount, paidOn: detail.paidOn, remainingAmount: detail.remainingAmount }
        : { notificationId: ids.completed(detail.planId), type: 'PLAN_COMPLETED' };
      const outcome = await deliver(n, plan, rule, { trigger: 'event' });
      return { handled: true, ...outcome };
    }
    default:
      console.log(`[reminders] event ${detailType} noted`);
      return { handled: false };
  }
}

module.exports = { getRuleFor, updateRule, runCheck, listRuns, monitoringOverview, upcoming, listNotifications, retry, handleEvent };
