// API tests over real HTTP (in-memory DynamoDB and S3, all services on one port).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestStack } = require('./helpers');
const { today, addDays } = require('../shared/dates');

const quiet = process.env.TEST_LOGS !== '1';
const realLog = console.log;
if (quiet) console.log = () => {};

let t; let user; let other; let admin;
const plan = (overrides = {}) => ({
  title: 'iPhone 16', provider: 'B.TECH', totalAmount: 6000, downPayment: 0,
  instalmentCount: 6, frequency: 'MONTHLY', startDate: addDays(today(), 1), ...overrides
});
const createPlan = async (token, overrides) => (await t.api('POST', '/api/plans', { token, body: plan(overrides) })).body.plan;
const pay = (token, planId, amount, extra = {}) =>
  t.api('POST', `/api/plans/${planId}/payments`, { token, body: { amount, paidOn: today(), method: 'CASH', ...extra } });

before(async () => {
  t = await startTestStack();
  user = await t.login('user@test.com', 'Mona Ali');
  other = await t.login('other@test.com', 'Omar Hassan');
  admin = await t.login('admin@test.com', 'Shop Admin');
});
after(async () => { await t.stop(); console.log = realLog; });

describe('Auth and security', () => {
  test('register gives USER role, ADMIN_EMAILS gives ADMIN, no password hash leaks', () => {
    assert.equal(user.user.role, 'USER');
    assert.equal(admin.user.role, 'ADMIN');
    assert.equal(user.user.passwordHash, undefined);
  });
  test('duplicate email -> 409; bad input -> 400 with field messages', async () => {
    assert.equal((await t.api('POST', '/api/auth/register', { body: { name: 'X Y', email: 'user@test.com', password: 'password123' } })).status, 409);
    const bad = await t.api('POST', '/api/auth/register', { body: { name: 'X', email: 'nope', password: 'short' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['email', 'name', 'password']);
  });
  test('wrong password -> 401 with a message that does not reveal which part was wrong', async () => {
    const res = await t.api('POST', '/api/auth/login', { body: { email: 'user@test.com', password: 'wrongpass1' } });
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /Email or password/);
  });
  test('no token -> 401, forged token -> 401', async () => {
    assert.equal((await t.api('GET', '/api/plans')).status, 401);
    assert.equal((await t.api('GET', '/api/plans', { token: 'abc.def.ghi' })).status, 401);
  });
  test('user calling an admin route -> 403', async () => {
    assert.equal((await t.api('GET', '/api/users', { token: user.token })).status, 403);
    assert.equal((await t.api('POST', '/api/reminder-runs', { token: user.token, body: {} })).status, 403);
    assert.equal((await t.api('GET', '/api/users', { token: admin.token })).status, 200);
  });
  test('non-JSON body -> 415, broken JSON -> 400', async () => {
    const text = await t.api('POST', '/api/plans', { token: user.token, body: 'title=x', headers: { 'content-type': 'text/plain' } });
    assert.equal(text.status, 415);
    const broken = await t.api('POST', '/api/plans', { token: user.token, body: '{"title":', headers: { 'content-type': 'application/json' } });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'INVALID_JSON');
  });
  test('internal routes refuse calls without the internal token', async () => {
    assert.equal((await t.api('GET', '/internal/plans')).status, 403);
  });
  test('security headers are set and CORS only allows our website', async () => {
    const ok = await t.api('GET', '/api/health', { headers: { origin: 'http://localhost:4566' } });
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:4566');
    const evil = await t.api('GET', '/api/health', { headers: { origin: 'http://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });
});

describe('Service 1: Plan & Schedule', () => {
  test('create -> 201 with a generated schedule that adds up to the total', async () => {
    const res = await t.api('POST', '/api/plans', { token: user.token, body: plan({ totalAmount: 1000, instalmentCount: 3 }) });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.plan.instalments.map((i) => i.amountDue), [333.33, 333.33, 333.34]);
    assert.equal(res.body.plan.status, 'ACTIVE');
    assert.equal(res.body.plan.remainingAmount, 1000);
  });
  test('business rules -> 400 (down payment >= total, 121 instalments, old start date)', async () => {
    const bad1 = await t.api('POST', '/api/plans', { token: user.token, body: plan({ downPayment: 6000 }) });
    assert.equal(bad1.status, 400);
    const bad2 = await t.api('POST', '/api/plans', { token: user.token, body: plan({ instalmentCount: 121 }) });
    assert.equal(bad2.status, 400);
    const bad3 = await t.api('POST', '/api/plans', { token: user.token, body: plan({ startDate: addDays(today(), -400) }) });
    assert.equal(bad3.status, 400);
    const bad4 = await t.api('POST', '/api/plans', { token: user.token, body: { title: 'x' } });
    assert.ok(bad4.body.error.details.length >= 5);
  });
  test('users only see their own plans; another user gets 403', async () => {
    const mine = await createPlan(user.token, { title: 'Fridge' });
    assert.equal((await t.api('GET', `/api/plans/${mine.planId}`, { token: other.token })).status, 403);
    const list = await t.api('GET', '/api/plans', { token: other.token });
    assert.ok(list.body.plans.every((p) => p.ownerId === other.user.id));
    assert.equal((await t.api('GET', `/api/plans/${mine.planId}`, { token: admin.token })).status, 200);
  });
  test('search by text, status and due-before; unknown id -> 404', async () => {
    await createPlan(user.token, { title: 'Samsung TV', provider: 'Raya' });
    const found = await t.api('GET', '/api/plans?q=samsung', { token: user.token });
    assert.equal(found.body.count, 1);
    assert.equal(found.body.plans[0].provider, 'Raya');
    const due = await t.api('GET', `/api/plans?dueBefore=${addDays(today(), 2)}&status=ACTIVE`, { token: user.token });
    assert.ok(due.body.count >= 1);
    assert.equal((await t.api('GET', '/api/plans?status=WRONG', { token: user.token })).status, 400);
    assert.equal((await t.api('GET', '/api/plans/does-not-exist', { token: user.token })).status, 404);
  });
  test('admin creates a plan for a customer; unknown customer -> 400; user cannot', async () => {
    const res = await t.api('POST', '/api/plans', { token: admin.token, body: plan({ ownerId: user.user.id, title: 'Washer' }) });
    assert.equal(res.status, 201);
    assert.equal(res.body.plan.ownerEmail, 'user@test.com');
    assert.equal((await t.api('POST', '/api/plans', { token: admin.token, body: plan({ ownerId: 'nobody' }) })).status, 400);
    assert.equal((await t.api('POST', '/api/plans', { token: user.token, body: plan({ ownerId: other.user.id }) })).status, 400);
  });
  test('reschedule keeps paid instalments; money fields locked after a payment', async () => {
    const p = await createPlan(user.token, { totalAmount: 3000, instalmentCount: 3 });
    await pay(admin.token, p.planId, 1000);
    const res = await t.api('PUT', `/api/plans/${p.planId}`, { token: user.token, body: { instalmentCount: 5 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plan.instalments.map((i) => i.amountDue), [1000, 500, 500, 500, 500]);
    assert.equal(res.body.plan.instalments[0].status, 'PAID');
    const locked = await t.api('PUT', `/api/plans/${p.planId}`, { token: user.token, body: { totalAmount: 5000 } });
    assert.equal(locked.status, 409);
  });
  test('status workflow: cancel only without payments, delete only when cancelled', async () => {
    const p = await createPlan(user.token);
    assert.equal((await t.api('DELETE', `/api/plans/${p.planId}`, { token: user.token })).status, 409);
    const cancelled = await t.api('PATCH', `/api/plans/${p.planId}/status`, { token: user.token, body: { status: 'CANCELLED' } });
    assert.equal(cancelled.body.plan.status, 'CANCELLED');
    assert.equal((await pay(admin.token, p.planId, 100)).status, 409);
    assert.equal((await t.api('DELETE', `/api/plans/${p.planId}`, { token: user.token })).status, 204);
    assert.equal((await t.api('GET', `/api/plans/${p.planId}`, { token: user.token })).status, 404);

    const withPay = await createPlan(user.token);
    await pay(admin.token, withPay.planId, 100);
    assert.equal((await t.api('PATCH', `/api/plans/${withPay.planId}/status`, { token: user.token, body: { status: 'CANCELLED' } })).status, 409);
  });
});

describe('Service 2: Payments & Balance', () => {
  test('payment rules: > remaining, future date, bad method, 0 amount -> 400', async () => {
    const p = await createPlan(user.token, { totalAmount: 1000, instalmentCount: 2 });
    assert.equal((await pay(admin.token, p.planId, 1000.01)).status, 400);
    assert.equal((await pay(admin.token, p.planId, 10, { paidOn: addDays(today(), 1) })).status, 400);
    assert.equal((await pay(admin.token, p.planId, 10, { method: 'GOLD' })).status, 400);
    assert.equal((await pay(admin.token, p.planId, 0)).status, 400);
    assert.equal((await pay(other.token, p.planId, 10)).status, 403);
  });
  test('paying everything completes the plan automatically; then no more payments', async () => {
    const p = await createPlan(user.token, { totalAmount: 1000, instalmentCount: 2 });
    const first = await pay(admin.token, p.planId, 600);
    assert.equal(first.body.balance.remainingAmount, 400);
    assert.deepEqual(first.body.payment.appliedTo, [{ seq: 1, amount: 500 }, { seq: 2, amount: 100 }]);
    const last = await pay(admin.token, p.planId, 400);
    assert.equal(last.body.balance.status, 'COMPLETED');
    assert.match(last.body.message, /fully paid/);
    assert.equal((await pay(admin.token, p.planId, 1)).status, 409);
  });
  test('history with filters and the dashboard summary', async () => {
    const p = await createPlan(user.token, { totalAmount: 900, instalmentCount: 3 });
    await pay(admin.token, p.planId, 100, { method: 'CARD' });
    await pay(admin.token, p.planId, 200, { method: 'CASH' });
    const card = await t.api('GET', `/api/plans/${p.planId}/payments?method=CARD`, { token: user.token });
    assert.equal(card.body.count, 1);
    const all = await t.api('GET', `/api/plans/${p.planId}/payments`, { token: user.token });
    assert.equal(all.body.total, 300);
    const summary = await t.api('GET', '/api/balances/summary', { token: user.token });
    assert.equal(summary.status, 200);
    assert.ok(summary.body.summary.activePlans >= 1);
    assert.ok(summary.body.summary.plans.every((x) => x.planId));
  });
  test('receipt upload to S3: real PDF accepted, fake or big files rejected, owner only', async () => {
    const p = await createPlan(user.token);
    const payment = (await pay(admin.token, p.planId, 100)).body.payment;
    const pdf = Buffer.from('%PDF-1.4 test receipt').toString('base64');
    const up = await t.api('POST', `/api/payments/${payment.paymentId}/receipt`, { token: user.token, body: { fileName: 'receipt 1.pdf', contentType: 'application/pdf', dataBase64: pdf } });
    assert.equal(up.status, 201);
    assert.equal(up.body.payment.receipt.fileName, 'receipt_1.pdf');
    assert.ok([...t.objects.keys()].some((k) => k.endsWith(`${payment.paymentId}/receipt_1.pdf`)));
    const down = await t.api('GET', `/api/payments/${payment.paymentId}/receipt`, { token: user.token });
    assert.equal(Buffer.from(down.body.receipt.dataBase64, 'base64').toString(), '%PDF-1.4 test receipt');
    const fake = await t.api('POST', `/api/payments/${payment.paymentId}/receipt`, { token: user.token, body: { fileName: 'x.png', contentType: 'image/png', dataBase64: pdf } });
    assert.equal(fake.status, 400);
    const big = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
    assert.equal((await t.api('POST', `/api/payments/${payment.paymentId}/receipt`, { token: user.token, body: { fileName: 'b.pdf', contentType: 'application/pdf', dataBase64: big } })).status, 400);
    assert.equal((await t.api('GET', `/api/payments/${payment.paymentId}/receipt`, { token: other.token })).status, 403);
  });
  test('reversal: admin only, re-allocates the rest, reopens a completed plan', async () => {
    const p = await createPlan(user.token, { totalAmount: 1000, instalmentCount: 2 });
    const a = (await pay(admin.token, p.planId, 300)).body.payment;
    const b = (await pay(admin.token, p.planId, 700)).body;
    assert.equal(b.balance.status, 'COMPLETED');
    assert.equal((await t.api('PATCH', `/api/payments/${a.paymentId}/reversal`, { token: user.token, body: { reason: 'Entered twice' } })).status, 403);
    assert.equal((await t.api('PATCH', `/api/payments/${a.paymentId}/reversal`, { token: admin.token, body: {} })).status, 400);
    const rev = await t.api('PATCH', `/api/payments/${a.paymentId}/reversal`, { token: admin.token, body: { reason: 'Entered by mistake' } });
    assert.equal(rev.status, 200);
    assert.equal(rev.body.balance.status, 'ACTIVE');
    assert.equal(rev.body.balance.remainingAmount, 300);
    const history = await t.api('GET', `/api/plans/${p.planId}/payments`, { token: user.token });
    assert.deepEqual(history.body.payments.map((x) => x.appliedTo), [[{ seq: 1, amount: 500 }, { seq: 2, amount: 200 }]]);
    assert.equal((await t.api('PATCH', `/api/payments/${a.paymentId}/reversal`, { token: admin.token, body: { reason: 'Entered by mistake' } })).status, 409);
  });
});

describe('Service 3: Reminders & Notifications', () => {
  test('a default rule is created by the PlanCreated event; owner can change it', async () => {
    const p = await createPlan(user.token);
    const rule = await t.api('GET', `/api/plans/${p.planId}/reminder-rule`, { token: user.token });
    assert.deepEqual(rule.body.rule.daysBefore, [3, 1]);
    assert.equal(rule.body.rule.email, 'user@test.com');
    const bad = await t.api('PUT', `/api/plans/${p.planId}/reminder-rule`, { token: user.token, body: { enabled: true, daysBefore: [45] } });
    assert.equal(bad.status, 400);
    const ok = await t.api('PUT', `/api/plans/${p.planId}/reminder-rule`, { token: user.token, body: { enabled: true, daysBefore: [1, 7, 7] } });
    assert.deepEqual(ok.body.rule.daysBefore, [7, 1]);
    assert.equal((await t.api('PUT', `/api/plans/${p.planId}/reminder-rule`, { token: other.token, body: { enabled: false, daysBefore: [1] } })).status, 403);
  });
  test('daily check sends each reminder once, skips paid instalments, and logs it', async () => {
    const p = await createPlan(user.token, { title: 'Laptop', totalAmount: 2000, instalmentCount: 2, startDate: addDays(today(), 1) });
    const run1 = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.equal(run1.status, 201);
    const mine = run1.body.run.results.filter((r) => r.planTitle === 'Laptop');
    assert.deepEqual(mine.map((r) => [r.type, r.seq, r.status]), [['DUE_SOON', 1, 'SENT']]);
    const run2 = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.ok(run2.body.run.results.filter((r) => r.planTitle === 'Laptop').every((r) => r.status === 'ALREADY_SENT'));

    await pay(admin.token, p.planId, 1000);
    const later = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: { asOf: addDays(today(), 1) } });
    assert.equal(later.body.run.results.filter((r) => r.planTitle === 'Laptop' && r.seq === 1).length, 0);

    const log = await t.api('GET', `/api/notifications?planId=${p.planId}`, { token: user.token });
    assert.deepEqual(log.body.notifications.map((n) => n.type).sort(), ['DUE_SOON', 'PAYMENT_CONFIRMED']);
  });
  test('overdue alert after the due date; upcoming dashboard lists due and overdue', async () => {
    await createPlan(other.token, { title: 'Old loan', totalAmount: 500, instalmentCount: 1, startDate: addDays(today(), -2) });
    const up = await t.api('GET', '/api/reminders/upcoming?days=30', { token: other.token });
    assert.equal(up.body.overdue.length, 1);
    assert.equal(up.body.overdue[0].daysUntil, -2);
    const run = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.ok(run.body.run.results.some((r) => r.planTitle === 'Old loan' && r.type === 'OVERDUE' && r.status === 'SENT'));
  });
  test('failed email is logged as FAILED and can be retried', async () => {
    const p = await createPlan(user.token, { title: 'Bike', totalAmount: 400, instalmentCount: 1, startDate: today() });
    process.env.BREVO_API_KEY = 'invalid-key';
    process.env.EMAIL_FROM = 'noreply@example.com';
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => (String(url).includes('brevo.com')
      ? new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 })
      : realFetch(url, opts));
    try {
      const run = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
      const bike = run.body.run.results.find((r) => r.planTitle === 'Bike');
      assert.equal(bike.status, 'FAILED');
      const failed = await t.api('GET', '/api/notifications?status=FAILED', { token: user.token });
      assert.ok(failed.body.notifications.some((n) => n.planId === p.planId && /Brevo 401/.test(n.error)));
      global.fetch = async (url, opts) => (String(url).includes('brevo.com')
        ? new Response(JSON.stringify({ messageId: '<ok@brevo>' }), { status: 201 })
        : realFetch(url, opts));
      const retry = await t.api('POST', `/api/notifications/${encodeURIComponent(bike.notificationId)}/retries`, { token: user.token });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.notification.status, 'SENT');
      assert.equal(retry.body.notification.attempts, 2);
      assert.equal((await t.api('POST', `/api/notifications/${encodeURIComponent(bike.notificationId)}/retries`, { token: user.token })).status, 409);
    } finally {
      global.fetch = realFetch;
      delete process.env.BREVO_API_KEY;
    }
  });
});

describe('Integrated scenario (the demo flow)', () => {
  test('create -> remind -> pay -> no repeat reminder -> pay rest -> completed + emails', async () => {
    const res = await t.api('POST', '/api/plans', { token: user.token, body: plan({ title: 'Demo phone', totalAmount: 6000, instalmentCount: 6, startDate: addDays(today(), 1) }) });
    const id = res.body.plan.planId;
    assert.equal(res.body.plan.instalments.length, 6);

    const run = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.ok(run.body.run.results.some((r) => r.planTitle === 'Demo phone' && r.type === 'DUE_SOON' && r.status === 'SENT'));

    const p1 = await pay(admin.token, id, 1500);
    assert.equal(p1.body.balance.remainingAmount, 4500);
    assert.deepEqual(p1.body.balance.counts, { paid: 1, partial: 1, unpaid: 4, overdue: 0 });

    const again = await t.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    assert.equal(again.body.run.results.filter((r) => r.planTitle === 'Demo phone' && r.status === 'SENT').length, 0);

    const p2 = await pay(admin.token, id, 4500);
    assert.equal(p2.body.balance.status, 'COMPLETED');

    const log = await t.api('GET', `/api/notifications?planId=${id}`, { token: user.token });
    const types = log.body.notifications.map((n) => n.type);
    assert.equal(types.filter((x) => x === 'PAYMENT_CONFIRMED').length, 2);
    assert.ok(types.includes('PLAN_COMPLETED'));
    assert.ok(types.includes('DUE_SOON'));
  });
});
