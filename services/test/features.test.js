// Interest, late fees, payoff, approval, escalation, secrets and metrics.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mockClient } = require('aws-sdk-client-mock');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const jwt = require('jsonwebtoken');
const { startTestStack } = require('./helpers');
const { today, addDays } = require('../shared/dates');
const { buildInstalments, lateFeesDue, payoffQuote, planView, paidSplit } = require('../plans/schedule');
const { escalationsDue } = require('../reminders/reminderLogic');

const realLog = console.log;
if (process.env.TEST_LOGS !== '1') console.log = () => {};
const sumCents = (list, f) => list.reduce((t, i) => t + Math.round(i[f] * 100), 0);

describe('Interest rules (unit)', () => {
  test('reducing balance: 10,000 over 12 months at 12% -> equal payments, exact principal', () => {
    const rows = buildInstalments({ amount: 10000, count: 12, frequency: 'MONTHLY', firstDue: '2027-01-15', annualRate: 12, interestMethod: 'REDUCING' });
    assert.equal(sumCents(rows, 'principal'), 1000000);
    assert.equal(rows[0].interest, 100); // 1% of 10,000 in the first month
    assert.equal(rows[0].amountDue, 888.49); // standard annuity payment
    assert.ok(rows.slice(0, 11).every((r) => r.amountDue === 888.49));
    assert.ok(rows[11].interest < rows[0].interest); // interest falls as the balance falls
    assert.equal(sumCents(rows, 'interest'), 66186); // 661.86 (the rounded 888.49 payment adds a cent)
    assert.ok(Math.abs(rows[11].amountDue - 888.49) < 0.05); // last payment absorbs the rounding
  });
  test('flat: 12,000 over 12 months at 10% -> 1,200 interest, 100 a month', () => {
    const rows = buildInstalments({ amount: 12000, count: 12, frequency: 'MONTHLY', firstDue: '2027-01-15', annualRate: 10, interestMethod: 'FLAT' });
    assert.ok(rows.every((r) => r.interest === 100 && r.principal === 1000 && r.amountDue === 1100));
  });
  test('weekly loans use 52 periods a year', () => {
    const rows = buildInstalments({ amount: 5200, count: 4, frequency: 'WEEKLY', firstDue: '2027-01-01', annualRate: 52, interestMethod: 'REDUCING' });
    assert.equal(rows[0].interest, 52); // 1% a week
  });
  test('money paid into an instalment covers fee, then interest, then principal', () => {
    assert.deepEqual(
      (({ toFee, toInterest, toPrincipal }) => ({ toFee, toInterest, toPrincipal }))(paidSplit({ principal: 100, interest: 10, lateFee: 5, amountDue: 115, amountPaid: 12 })),
      { toFee: 500, toInterest: 700, toPrincipal: 0 }
    );
  });
});

describe('Late fee, payoff and escalation rules (unit)', () => {
  const plan = { planId: 'p', status: 'ACTIVE', totalAmount: 3000, lateFeePolicy: { graceDays: 3, type: 'FIXED', value: 50 } };
  const inst = [
    { seq: 1, dueDate: '2027-01-01', principal: 1000, interest: 0, amountDue: 1000, amountPaid: 1000 },
    { seq: 2, dueDate: '2027-01-10', principal: 1000, interest: 0, amountDue: 1000, amountPaid: 200 },
    { seq: 3, dueDate: '2027-01-20', principal: 1000, interest: 0, amountDue: 1000, amountPaid: 0 }
  ];
  test('no fee inside the grace period, one fixed fee after it, never on paid instalments', () => {
    assert.equal(lateFeesDue(plan, inst, '2027-01-13').length, 0);
    assert.deepEqual(lateFeesDue(plan, inst, '2027-01-14'), [{ seq: 2, dueDate: '2027-01-10', daysLate: 4, fee: 50 }]);
    assert.equal(lateFeesDue(plan, inst.map((i) => (i.seq === 2 ? { ...i, lateFee: 50 } : i)), '2027-01-14').length, 0);
  });
  test('percentage fee is taken from what is still unpaid', () => {
    const fees = lateFeesDue({ ...plan, lateFeePolicy: { graceDays: 0, type: 'PERCENT', value: 5 } }, inst, '2027-01-11');
    assert.deepEqual(fees.map((f) => f.fee), [40]); // 5% of 800
  });
  test('payoff: due instalments in full, future ones without their unpaid interest', () => {
    const rows = buildInstalments({ amount: 3000, count: 3, frequency: 'MONTHLY', firstDue: '2027-01-01', annualRate: 12, interestMethod: 'FLAT' });
    const view = planView({ planId: 'x', status: 'ACTIVE', totalAmount: 3000 }, rows, '2027-01-05');
    const q = payoffQuote(view, '2027-01-05');
    assert.equal(q.lines[0].interestWaived, 0);
    assert.equal(q.interestSaved, 60); // 2 future months × 30 interest (3,000 × 12% × 3/12 = 90 → 30 a month)
    assert.equal(q.payoffAmount, view.remainingAmount - 60);
  });
  test('escalation only for instalments at least ESCALATION_DAYS late', () => {
    const view = { planId: 'p', status: 'ACTIVE', instalments: [{ seq: 1, status: 'OVERDUE', daysLate: 13, dueDate: 'a' }, { seq: 2, status: 'OVERDUE', daysLate: 14, dueDate: 'b' }] };
    assert.deepEqual(escalationsDue(view).map((e) => e.seq), [2]);
  });
});

describe('API: advanced features', () => {
  let t; let user; let admin;
  const pdf = Buffer.from('%PDF-1.4 receipt').toString('base64');
  const createPlan = async (token, body) => (await t.api('POST', '/api/plans', {
    token, body: { title: 'Car loan', provider: 'NBE', totalAmount: 12000, instalmentCount: 12, frequency: 'MONTHLY', startDate: addDays(today(), 5), ...body }
  }));
  const submit = (token, planId, amount) => t.api('POST', `/api/plans/${planId}/payments`, { token, body: { amount, paidOn: today(), method: 'BANK_TRANSFER' } });
  const receipt = (token, paymentId) => t.api('POST', `/api/payments/${paymentId}/receipt`, { token, body: { fileName: 'r.pdf', contentType: 'application/pdf', dataBase64: pdf } });
  const decide = (token, paymentId, decision, reason) => t.api('PATCH', `/api/payments/${paymentId}/verification`, { token, body: { decision, ...(reason ? { reason } : {}) } });

  before(async () => {
    t = await startTestStack();
    user = await t.login('cust@test.com', 'Karim Adel');
    admin = await t.login('admin@test.com', 'Lender');
  });
  after(async () => { await t.stop(); });

  test('interest loan: totals, validation of rate and late-fee policy', async () => {
    const res = await createPlan(user.token, { annualRate: 12, interestMethod: 'REDUCING', lateFeePolicy: { graceDays: 3, type: 'PERCENT', value: 2 } });
    assert.equal(res.status, 201);
    const interestOfRows = res.body.plan.instalments.reduce((t, i) => t + Math.round(i.interest * 100), 0) / 100;
    assert.equal(res.body.plan.totalInterest, interestOfRows);
    assert.ok(res.body.plan.totalInterest > 0);
    assert.ok(res.body.plan.totalRepayable > 12000);
    assert.equal(res.body.plan.interestMethod, 'REDUCING');
    const badRate = await createPlan(user.token, { annualRate: 150 });
    assert.equal(badRate.status, 400);
    const badFee = await createPlan(user.token, { lateFeePolicy: { graceDays: 3, type: 'PERCENT', value: 40 } });
    assert.equal(badFee.status, 400);
    assert.ok(badFee.body.error.details.some((d) => d.field === 'lateFeePolicy.value'));
  });

  test('approval workflow: pending -> receipt required -> verified; balance only changes when verified', async () => {
    const planId = (await createPlan(user.token, { totalAmount: 3000, instalmentCount: 3 })).body.plan.planId;
    const sub = await submit(user.token, planId, 1000);
    assert.equal(sub.status, 201);
    assert.equal(sub.body.payment.status, 'PENDING');
    assert.match(sub.body.message, /verifies/);
    let bal = (await t.api('GET', `/api/plans/${planId}/balance`, { token: user.token })).body.balance;
    assert.equal(bal.remainingAmount, 3000);
    assert.equal(bal.pendingAmount, 1000);

    assert.equal((await submit(user.token, planId, 2500)).status, 400); // only 2,000 left after the pending 1,000
    assert.equal((await decide(user.token, sub.body.payment.paymentId, 'APPROVE')).status, 403);
    const noReceipt = await decide(admin.token, sub.body.payment.paymentId, 'APPROVE');
    assert.equal(noReceipt.status, 409);
    assert.equal(noReceipt.body.error.code, 'RECEIPT_REQUIRED');

    const queue = await t.api('GET', '/api/payments/pending', { token: admin.token });
    assert.ok(queue.body.payments.some((p) => p.paymentId === sub.body.payment.paymentId));

    await receipt(user.token, sub.body.payment.paymentId);
    const ok = await decide(admin.token, sub.body.payment.paymentId, 'APPROVE');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.payment.status, 'VERIFIED');
    assert.equal(ok.body.balance.remainingAmount, 2000);
    assert.equal((await decide(admin.token, sub.body.payment.paymentId, 'APPROVE')).status, 409);

    const log = await t.api('GET', `/api/notifications?planId=${planId}`, { token: user.token });
    assert.ok(log.body.notifications.some((n) => n.type === 'PAYMENT_CONFIRMED'));
  });

  test('reject needs a reason and emails the customer; withdraw removes a pending payment', async () => {
    const planId = (await createPlan(user.token, { totalAmount: 2000, instalmentCount: 2 })).body.plan.planId;
    const a = (await submit(user.token, planId, 500)).body.payment;
    assert.equal((await decide(admin.token, a.paymentId, 'REJECT')).status, 400);
    const rej = await decide(admin.token, a.paymentId, 'REJECT', 'Receipt is unreadable');
    assert.equal(rej.body.payment.status, 'REJECTED');
    const log = await t.api('GET', `/api/notifications?planId=${planId}&type=PAYMENT_REJECTED`, { token: user.token });
    assert.equal(log.body.count, 1);
    assert.equal(log.body.notifications[0].detail.reason, 'Receipt is unreadable');

    const b = (await submit(user.token, planId, 300)).body.payment;
    assert.equal((await t.api('DELETE', `/api/payments/${b.paymentId}`, { token: user.token })).status, 204);
    const bal = (await t.api('GET', `/api/plans/${planId}/balance`, { token: user.token })).body.balance;
    assert.equal(bal.pendingAmount, 0);
    assert.equal((await t.api('DELETE', `/api/payments/${b.paymentId}`, { token: user.token })).status, 409);
  });

  test('daily run applies late fees once, emails the customer, admin can waive', async () => {
    const res = await createPlan(user.token, {
      title: 'Late plan', totalAmount: 2000, instalmentCount: 2, startDate: addDays(today(), -10),
      lateFeePolicy: { graceDays: 3, type: 'FIXED', value: 50 }
    });
    const planId = res.body.plan.planId;
    const run = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.equal(run.status, 201);
    assert.ok(run.body.run.lateFees.applied >= 1);
    let plan = (await t.api('GET', `/api/plans/${planId}`, { token: user.token })).body.plan;
    assert.equal(plan.instalments[0].lateFee, 50);
    assert.equal(plan.instalments[0].amountDue, 1050);
    assert.equal(plan.remainingAmount, 2050);
    const again = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.equal(again.body.run.lateFees.applied, 0);
    const log = await t.api('GET', `/api/notifications?planId=${planId}&type=LATE_FEE`, { token: user.token });
    assert.equal(log.body.count, 1);

    assert.equal((await t.api('POST', `/api/plans/${planId}/instalments/1/late-fee-waivers`, { token: user.token, body: { reason: 'Bank holiday delay' } })).status, 403);
    const waived = await t.api('POST', `/api/plans/${planId}/instalments/1/late-fee-waivers`, { token: admin.token, body: { reason: 'Bank holiday delay' } });
    assert.equal(waived.status, 201);
    plan = waived.body.plan;
    assert.equal(plan.instalments[0].lateFee, 0);
    assert.equal(plan.remainingAmount, 2000);
    assert.equal((await t.api('POST', `/api/plans/${planId}/instalments/1/late-fee-waivers`, { token: admin.token, body: { reason: 'Bank holiday delay' } })).status, 409);
  });

  test('early payoff: quote waives future interest; admin payoff completes the plan', async () => {
    const planId = (await createPlan(user.token, { totalAmount: 6000, instalmentCount: 6, annualRate: 24, interestMethod: 'FLAT' })).body.plan.planId;
    const quote = (await t.api('GET', `/api/plans/${planId}/payoff-quote`, { token: user.token })).body.quote;
    assert.equal(quote.interestSaved, 720); // 6 future months × 120 interest
    assert.equal(quote.payoffAmount, 6000);
    const paid = await t.api('POST', `/api/plans/${planId}/payoffs`, { token: admin.token, body: { paidOn: today(), method: 'BANK_TRANSFER' } });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.payment.kind, 'PAYOFF');
    assert.equal(paid.body.balance.status, 'COMPLETED');
    assert.equal((await t.api('GET', `/api/plans/${planId}/payoff-quote`, { token: user.token })).status, 409);
    const rev = await t.api('PATCH', `/api/payments/${paid.body.payment.paymentId}/reversal`, { token: admin.token, body: { reason: 'Testing reversal' } });
    assert.equal(rev.status, 409);
  });

  test('customer payoff goes through approval', async () => {
    const planId = (await createPlan(user.token, { totalAmount: 1200, instalmentCount: 2, annualRate: 12, interestMethod: 'REDUCING' })).body.plan.planId;
    const sub = await t.api('POST', `/api/plans/${planId}/payoffs`, { token: user.token, body: { paidOn: today(), method: 'CARD' } });
    assert.equal(sub.body.payment.status, 'PENDING');
    assert.equal((await t.api('POST', `/api/plans/${planId}/payoffs`, { token: user.token, body: { paidOn: today(), method: 'CARD' } })).status, 409);
    await receipt(user.token, sub.body.payment.paymentId);
    const ok = await decide(admin.token, sub.body.payment.paymentId, 'APPROVE');
    assert.equal(ok.body.balance.status, 'COMPLETED');
  });

  test('escalation after 14 days late, run history and monitoring overview', async () => {
    await createPlan(user.token, { title: 'Very late', totalAmount: 1000, instalmentCount: 1, startDate: addDays(today(), -20) });
    const run = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.ok(run.body.run.results.some((r) => r.planTitle === 'Very late' && r.type === 'ESCALATION' && r.status === 'SENT'));
    assert.ok(run.body.run.escalations >= 1);
    const runs = await t.api('GET', '/api/reminder-runs', { token: admin.token });
    assert.ok(runs.body.count >= 1);
    assert.equal((await t.api('GET', '/api/reminder-runs', { token: user.token })).status, 403);
    const overview = await t.api('GET', '/api/monitoring/overview', { token: admin.token });
    assert.equal(overview.status, 200);
    assert.ok(overview.body.overview.notifications.byType.ESCALATION);
    assert.equal(overview.body.overview.settings.escalationDays, 14);
  });

  test('CloudWatch metrics and an SNS alert are sent when configured', async () => {
    const cw = mockClient(CloudWatchClient); cw.on(PutMetricDataCommand).resolves({});
    const sns = mockClient(SNSClient); sns.on(PublishCommand).resolves({ MessageId: 'm-1' });
    process.env.METRICS_NAMESPACE = 'LoanTracker';
    process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:loan-tracker-alerts';
    try {
      await createPlan(user.token, { title: 'Alert plan', totalAmount: 1000, instalmentCount: 1, startDate: addDays(today(), -30) });
      await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
      const metricNames = cw.commandCalls(PutMetricDataCommand).flatMap((c) => c.args[0].input.MetricData.map((m) => m.MetricName));
      assert.ok(metricNames.includes('RemindersSent') && metricNames.includes('OverdueInstalments'));
      assert.ok(cw.commandCalls(PutMetricDataCommand).every((c) => c.args[0].input.Namespace === 'LoanTracker'));
      assert.ok(sns.commandCalls(PublishCommand).some((c) => /Escalation/.test(c.args[0].input.Subject)));
    } finally {
      delete process.env.METRICS_NAMESPACE; delete process.env.ALERTS_TOPIC_ARN;
      cw.restore(); sns.restore();
    }
  });
});

describe('Secrets Manager', () => {
  test('secrets are loaded into the environment, cached, and shown (names only) on health', async () => {
    // fresh copy of the module so its cache starts empty
    delete require.cache[require.resolve('../shared/secrets')];
    const { loadSecrets, secretsInfo } = require('../shared/secrets');
    const sm = mockClient(SecretsManagerClient);
    sm.on(GetSecretValueCommand, { SecretId: 'loan-tracker/app' }).resolves({ SecretString: JSON.stringify({ TEST_SECRET_A: 'value-a' }) });
    sm.on(GetSecretValueCommand, { SecretId: 'loan-tracker/brevo' }).resolves({ SecretString: JSON.stringify({ TEST_SECRET_B: 'value-b' }) });
    process.env.SECRET_IDS = 'loan-tracker/app, loan-tracker/brevo';
    try {
      await loadSecrets();
      await loadSecrets(); // cached: no second call
      assert.equal(process.env.TEST_SECRET_A, 'value-a');
      assert.equal(process.env.TEST_SECRET_B, 'value-b');
      assert.equal(sm.commandCalls(GetSecretValueCommand).length, 2);
      const info = secretsInfo();
      assert.equal(info.source, 'secrets-manager');
      assert.deepEqual(info.keys, ['TEST_SECRET_A', 'TEST_SECRET_B']);
      assert.ok(!JSON.stringify(info).includes('value-a'));
    } finally {
      delete process.env.SECRET_IDS; delete process.env.TEST_SECRET_A; delete process.env.TEST_SECRET_B;
      sm.restore();
    }
  });

  test('a failing Secrets Manager on a cold start is an error, not silent defaults', async () => {
    delete require.cache[require.resolve('../shared/secrets')];
    const { loadSecrets } = require('../shared/secrets');
    const sm = mockClient(SecretsManagerClient);
    sm.on(GetSecretValueCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    process.env.SECRET_IDS = 'loan-tracker/app';
    try {
      await assert.rejects(loadSecrets(), /denied/);
    } finally { delete process.env.SECRET_IDS; sm.restore(); }
  });

  test('JWT rotation: tokens signed with the previous secret stay valid until they expire', () => {
    const { verifyToken } = require('../shared/auth');
    const old = process.env.JWT_SECRET;
    const oldToken = jwt.sign({ sub: 'u1', role: 'USER' }, old, { issuer: 'loan-tracker' });
    process.env.JWT_SECRET = 'a-brand-new-secret-after-rotation';
    process.env.JWT_SECRET_PREVIOUS = old;
    try {
      assert.equal(verifyToken(oldToken).sub, 'u1');
      delete process.env.JWT_SECRET_PREVIOUS;
      assert.throws(() => verifyToken(oldToken));
    } finally { process.env.JWT_SECRET = old; }
  });
});

after(() => { console.log = realLog; });
