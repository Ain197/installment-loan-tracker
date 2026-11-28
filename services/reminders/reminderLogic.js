const { daysBetween } = require('../shared/dates');

const DEFAULT_DAYS = () => (process.env.DEFAULT_REMINDER_DAYS || '3,1')
  .split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 30);

// Notification ids are built from what they are about, so the same reminder can never be
// stored (or sent) twice: running the check twice in one day sends nothing new.
const ids = {
  dueSoon: (planId, seq, dueDate, daysBefore) => `DUE#${planId}#${seq}#${dueDate}#${daysBefore}`,
  overdue: (planId, seq, dueDate) => `OVERDUE#${planId}#${seq}#${dueDate}`,
  payment: (paymentId) => `PAYMENT#${paymentId}`,
  completed: (planId) => `COMPLETED#${planId}`,
  lateFee: (planId, asOf) => `LATEFEE#${planId}#${asOf}`,
  rejected: (paymentId) => `REJECTED#${paymentId}`,
  escalation: (planId, seq, dueDate) => `ESCALATION#${planId}#${seq}#${dueDate}`
};

const ESCALATION_DAYS = () => Number(process.env.ESCALATION_DAYS || 14);

// Instalments so late that the lender must step in (one escalation per instalment)
function escalationsDue(plan) {
  if (plan.status !== 'ACTIVE') return [];
  return plan.instalments
    .filter((i) => i.status === 'OVERDUE' && (i.daysLate || 0) >= ESCALATION_DAYS())
    .map((i) => ({
      notificationId: ids.escalation(plan.planId, i.seq, i.dueDate),
      type: 'ESCALATION', seq: i.seq, dueDate: i.dueDate, daysLate: i.daysLate, amount: i.amountRemaining
    }));
}

// Rules:
//  - never remind about a paid instalment, a cancelled or a completed plan, or when the rule is off
//  - for an upcoming instalment use the smallest "days before" that has been reached, so a day
//    missed by the scheduler is caught up the next day (e.g. rule 3 and 1, due in 2 days -> the 3-day reminder)
//  - one "overdue" alert per missed instalment (if overdue alerts are on)
function remindersDue(plan, rule, asOf) {
  if (!rule || !rule.enabled || plan.status !== 'ACTIVE') return [];
  const thresholds = [...rule.daysBefore].sort((a, b) => a - b);
  const due = [];
  for (const inst of plan.instalments) {
    if (inst.status === 'PAID') continue;
    const daysUntil = daysBetween(asOf, inst.dueDate);
    if (daysUntil >= 0) {
      const daysBefore = thresholds.find((d) => d >= daysUntil);
      if (daysBefore === undefined) continue;
      due.push({
        notificationId: ids.dueSoon(plan.planId, inst.seq, inst.dueDate, daysBefore),
        type: 'DUE_SOON', seq: inst.seq, dueDate: inst.dueDate, daysBefore, daysUntil, amount: inst.amountRemaining
      });
    } else if (rule.overdueAlerts) {
      due.push({
        notificationId: ids.overdue(plan.planId, inst.seq, inst.dueDate),
        type: 'OVERDUE', seq: inst.seq, dueDate: inst.dueDate, daysLate: -daysUntil, amount: inst.amountRemaining
      });
    }
  }
  return due;
}

module.exports = { remindersDue, escalationsDue, ids, DEFAULT_DAYS, ESCALATION_DAYS };
