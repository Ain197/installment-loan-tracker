// Runs the services through their Lambda handlers with API Gateway, EventBridge and Invoke events.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mockClient } = require('aws-sdk-client-mock');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { startTestStack } = require('./helpers');
const { today, addDays } = require('../shared/dates');

const realLog = console.log;
if (process.env.TEST_LOGS !== '1') console.log = () => {};

let stack; let lambdaMock;
const handlers = {};

function httpEvent(method, path, { token, body, query = '' } = {}) {
  return {
    version: '2.0', routeKey: `${method} ${path}`, rawPath: path, rawQueryString: query,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    requestContext: { http: { method, path, sourceIp: '10.0.0.1' }, stage: '$default' },
    isBase64Encoded: false, body: body === undefined ? undefined : JSON.stringify(body)
  };
}
const call = async (service, ...args) => {
  const res = await handlers[service](httpEvent(...args), {});
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

before(async () => {
  stack = await startTestStack();
  // From now on, services call each other with Lambda Invoke (like on Floci)
  Object.assign(process.env, { AUTH_FUNCTION_NAME: 'lt-auth', PLANS_FUNCTION_NAME: 'lt-plans', PAYMENTS_FUNCTION_NAME: 'lt-payments', REMINDERS_FUNCTION_NAME: 'lt-reminders' });
  for (const s of ['auth', 'plans', 'payments', 'reminders']) handlers[s] = require(`../${s}/lambda`).handler;
  const byName = { 'lt-auth': 'auth', 'lt-plans': 'plans', 'lt-payments': 'payments', 'lt-reminders': 'reminders' };
  lambdaMock = mockClient(LambdaClient);
  lambdaMock.on(InvokeCommand).callsFake(async (input) => {
    const event = JSON.parse(Buffer.from(input.Payload).toString());
    const result = await handlers[byName[input.FunctionName]](event, {});
    return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(result)) };
  });
});
after(async () => {
  lambdaMock.restore();
  for (const k of ['AUTH_FUNCTION_NAME', 'PLANS_FUNCTION_NAME', 'PAYMENTS_FUNCTION_NAME', 'REMINDERS_FUNCTION_NAME']) delete process.env[k];
  await stack.stop();
  console.log = realLog;
});

describe('Lambda handlers (Floci mode)', () => {
  test('health answers runtime: lambda when AWS_LAMBDA_FUNCTION_NAME is set', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'lt-plans';
    const res = await call('plans', 'GET', '/api/health/plans');
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    assert.equal(res.status, 200);
    assert.equal(res.body.runtime, 'lambda');
  });

  test('full flow through API Gateway events and Lambda-to-Lambda calls', async () => {
    await call('auth', 'POST', '/api/auth/register', { body: { name: 'Lambda User', email: 'lambda@test.com', password: 'password123' } });
    const { body: login } = await call('auth', 'POST', '/api/auth/login', { body: { email: 'lambda@test.com', password: 'password123' } });
    const token = login.token;

    const created = await call('plans', 'POST', '/api/plans', { token, body: { title: 'Lambda plan', provider: 'Shop', totalAmount: 900, instalmentCount: 3, frequency: 'MONTHLY', startDate: addDays(today(), 1) } });
    assert.equal(created.status, 201);
    const planId = created.body.plan.planId;

    const found = await call('plans', 'GET', '/api/plans', { token, query: 'q=lambda' });
    assert.equal(found.body.count, 1);

    const paid = await call('payments', 'POST', `/api/plans/${planId}/payments`, { token, body: { amount: 450, paidOn: today(), method: 'CARD' } });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.payment.status, 'PENDING');
    const balance = await call('payments', 'GET', `/api/plans/${planId}/balance`, { token });
    assert.equal(balance.body.balance.pendingAmount, 450);
    assert.ok(lambdaMock.commandCalls(InvokeCommand).some((c) => c.args[0].input.FunctionName === 'lt-plans'));

    const rule = await call('reminders', 'GET', `/api/plans/${planId}/reminder-rule`, { token });
    assert.equal(rule.status, 200);
    assert.equal(rule.body.rule.email, 'lambda@test.com');
  });

  test('reminders handler accepts EventBridge events and the daily schedule event', async () => {
    const res = await handlers.reminders({ source: 'loan-tracker', 'detail-type': 'PlanCreated', detail: { planId: 'x1', ownerId: 'u1', ownerEmail: 'a@b.com', ownerName: 'A' } }, {});
    assert.equal(res.handled, true);
    const run = await handlers.reminders({ action: 'run-reminders' }, {});
    assert.equal(run.trigger, 'schedule');
    assert.ok(run.plansChecked >= 1);
    const ignored = await handlers.reminders({ hello: 'world' }, {});
    assert.equal(ignored.ignored, true);
  });

  test('internal routes cannot be reached without the internal token, even through Lambda', async () => {
    const res = await call('plans', 'GET', '/internal/plans');
    assert.equal(res.status, 403);
  });
});
