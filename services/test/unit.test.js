const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildInstalments, planView, reschedule } = require('../plans/schedule');
const { allocate } = require('../payments/allocation');
const { remindersDue } = require('../reminders/reminderLogic');
const { addMonths } = require('../shared/dates');
const { createChecker } = require('../shared/validate');

describe('Service 1 rules: schedule generation', () => {
  test('1000 over 3 instalments = 333.33, 333.33, 333.34 (remainder on the last)', () => {
    const list = buildInstalments({ amount: 1000, count: 3, frequency: 'MONTHLY', firstDue: '2026-01-10' });
    assert.deepEqual(list.map((i) => i.amountDue), [333.33, 333.33, 333.34]);
    assert.equal(list.reduce((t, i) => t + Math.round(i.amountDue * 100), 0), 100000);
  });

  test('monthly dates keep the day and clamp to the end of short months', () => {
    const list = buildInstalments({ amount: 300, count: 3, frequency: 'MONTHLY', firstDue: '2026-01-31' });
    assert.deepEqual(list.map((i) => i.dueDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29'); // leap year
  });

  test('weekly and bi-weekly schedules', () => {
    assert.deepEqual(buildInstalments({ amount: 200, count: 2, frequency: 'WEEKLY', firstDue: '2026-12-28' }).map((i) => i.dueDate), ['2026-12-28', '2027-01-04']);
    assert.deepEqual(buildInstalments({ amount: 200, count: 2, frequency: 'BIWEEKLY', firstDue: '2026-12-28' }).map((i) => i.dueDate), ['2026-12-28', '2027-01-11']);
  });

  test('plan view works out remaining balance, statuses and next due', () => {
    const plan = { planId: 'p', status: 'ACTIVE', totalAmount: 3000, downPayment: 0 };
    const inst = [
      { seq: 1, dueDate: '2026-01-01', amountDue: 1000, amountPaid: 1000 },
      { seq: 2, dueDate: '2026-02-01', amountDue: 1000, amountPaid: 400 },
      { seq: 3, dueDate: '2026-03-01', amountDue: 1000, amountPaid: 0 }
    ];
    const view = planView(plan, inst, '2026-02-15');
    assert.equal(view.remainingAmount, 1600);
    assert.deepEqual(view.instalments.map((i) => i.status), ['PAID', 'OVERDUE', 'UNPAID']);
    assert.deepEqual(view.nextDue, { seq: 2, dueDate: '2026-02-01', amountRemaining: 600 });
    assert.equal(view.isOverdue, true);
    assert.equal(view.progressPercent, 46);
  });

  test('reschedule keeps paid instalments and spreads the rest', () => {
    const plan = { totalAmount: 3000, downPayment: 0 };
    const inst = [
      { seq: 1, dueDate: '2026-01-01', amountDue: 1000, amountPaid: 1000 },
      { seq: 2, dueDate: '2026-02-01', amountDue: 1000, amountPaid: 0 },
      { seq: 3, dueDate: '2026-03-01', amountDue: 1000, amountPaid: 0 }
    ];
    const result = reschedule({ plan, instalments: inst, newCount: 5, newFrequency: 'MONTHLY' });
    assert.equal(result.locked.length, 1);
    assert.deepEqual(result.fresh.map((i) => [i.seq, i.dueDate, i.amountDue]),
      [[2, '2026-02-01', 500], [3, '2026-03-01', 500], [4, '2026-04-01', 500], [5, '2026-05-01', 500]]);
    assert.match(reschedule({ plan, instalments: inst, newCount: 1, newFrequency: 'MONTHLY' }).error, /at least 2/);
  });
});

describe('Service 2 rules: payment allocation', () => {
  const inst = [
    { seq: 1, amountDue: 1000 }, { seq: 2, amountDue: 1000 }, { seq: 3, amountDue: 1000 }
  ];
  test('oldest instalment first; overpayment rolls over; partial stays partial', () => {
    const r = allocate(inst, [{ paymentId: 'a', amount: 1500, createdAt: '1' }]);
    assert.deepEqual(r.paid.map((p) => p.amountPaid), [1000, 500, 0]);
    assert.deepEqual(r.appliedTo.a, [{ seq: 1, amount: 1000 }, { seq: 2, amount: 500 }]);
  });
  test('payments are applied in the order they were recorded', () => {
    const r = allocate(inst, [{ paymentId: 'b', amount: 700, createdAt: '2' }, { paymentId: 'a', amount: 600, createdAt: '1' }]);
    assert.deepEqual(r.appliedTo.a, [{ seq: 1, amount: 600 }]);
    assert.deepEqual(r.appliedTo.b, [{ seq: 1, amount: 400 }, { seq: 2, amount: 300 }]);
  });
  test('more money than owed is reported as unused', () => {
    assert.equal(allocate(inst, [{ paymentId: 'a', amount: 3000.01, createdAt: '1' }]).unused, 0.01);
  });
  test('cents are exact (0.1 + 0.2 style problems do not happen)', () => {
    const r = allocate([{ seq: 1, amountDue: 0.3 }], [{ paymentId: 'a', amount: 0.1, createdAt: '1' }, { paymentId: 'b', amount: 0.2, createdAt: '2' }]);
    assert.equal(r.paid[0].amountPaid, 0.3);
    assert.equal(r.unused, 0);
  });
});

describe('Service 3 rules: which reminders are due', () => {
  const plan = {
    planId: 'p', status: 'ACTIVE',
    instalments: [
      { seq: 1, dueDate: '2026-03-01', status: 'PAID', amountRemaining: 0 },
      { seq: 2, dueDate: '2026-03-04', status: 'UNPAID', amountRemaining: 100 },
      { seq: 3, dueDate: '2026-02-20', status: 'OVERDUE', amountRemaining: 50 },
      { seq: 4, dueDate: '2026-04-04', status: 'UNPAID', amountRemaining: 100 }
    ]
  };
  const rule = { enabled: true, daysBefore: [3, 1], overdueAlerts: true };

  test('3 days before -> one DUE_SOON; paid and far-away instalments are skipped; overdue alert once', () => {
    const due = remindersDue(plan, rule, '2026-03-01');
    assert.deepEqual(due.map((d) => [d.type, d.seq, d.daysBefore]), [['DUE_SOON', 2, 3], ['OVERDUE', 3, undefined]]);
  });
  test('a missed day is caught up with the nearest reminder (due in 2 days -> 3-day reminder id)', () => {
    const due = remindersDue(plan, rule, '2026-03-02');
    assert.equal(due[0].notificationId, 'DUE#p#2#2026-03-04#3');
  });
  test('same day twice -> same ids, so the log prevents a second email', () => {
    assert.deepEqual(remindersDue(plan, rule, '2026-03-03'), remindersDue(plan, rule, '2026-03-03'));
  });
  test('rule off, cancelled or completed plan -> no reminders', () => {
    assert.equal(remindersDue(plan, { ...rule, enabled: false }, '2026-03-01').length, 0);
    assert.equal(remindersDue({ ...plan, status: 'CANCELLED' }, rule, '2026-03-01').length, 0);
    assert.equal(remindersDue({ ...plan, status: 'COMPLETED' }, rule, '2026-03-01').length, 0);
  });
});

describe('Validation helper', () => {
  test('collects every problem with a message per field', () => {
    const check = createChecker({ title: '', totalAmount: 'abc', startDate: '2026-02-30' });
    check.text('title');
    check.number('totalAmount');
    check.date('startDate');
    assert.throws(() => check.done(), (err) => err.status === 400 && err.details.length === 3);
  });
  test('rejects more than 2 decimals', () => {
    const check = createChecker({ amount: 10.555 });
    check.number('amount', { decimals: 2 });
    assert.equal(check.problems.length, 1);
  });
});
