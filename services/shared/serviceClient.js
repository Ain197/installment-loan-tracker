// Calls another service's /internal routes: Lambda Invoke on Floci, HTTP locally (INTERNAL_TOKEN required).
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { AppError } = require('./errors');

let lambda;

const FUNCTION_ENV = {
  auth: 'AUTH_FUNCTION_NAME',
  plans: 'PLANS_FUNCTION_NAME',
  payments: 'PAYMENTS_FUNCTION_NAME',
  reminders: 'REMINDERS_FUNCTION_NAME'
};

async function callService(service, method, path, body) {
  const functionName = process.env[FUNCTION_ENV[service]];
  const response = functionName
    ? await invokeLambda(functionName, method, path, body)
    : await callHttp(method, path, body);

  if (response.status >= 400) {
    const err = response.body && response.body.error;
    if (response.status < 500 && err) throw new AppError(response.status, err.code, err.message, err.details);
    console.error(`[serviceClient] ${service} ${method} ${path} failed`, response.status, response.body);
    throw new AppError(502, 'DEPENDENCY_FAILED', `The ${service} service did not answer correctly. Please try again.`);
  }
  return response.body;
}

async function invokeLambda(functionName, method, path, body) {
  lambda = lambda || new LambdaClient({});
  const [rawPath, rawQueryString = ''] = path.split('?');
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString,
    headers: {
      'content-type': 'application/json',
      'x-internal-token': process.env.INTERNAL_TOKEN || ''
    },
    requestContext: { http: { method, path: rawPath, sourceIp: '127.0.0.1' } },
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body)
  };
  const result = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    Payload: Buffer.from(JSON.stringify(event))
  }));
  if (result.FunctionError) {
    console.error(`[serviceClient] ${functionName} error`, Buffer.from(result.Payload || []).toString());
    return { status: 502, body: null };
  }
  const payload = JSON.parse(Buffer.from(result.Payload).toString() || '{}');
  const text = payload.isBase64Encoded ? Buffer.from(payload.body || '', 'base64').toString() : payload.body;
  return { status: payload.statusCode || 500, body: text ? JSON.parse(text) : null };
}

async function callHttp(method, path, body) {
  const base = process.env.INTERNAL_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

module.exports = { callService };
