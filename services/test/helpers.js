// In-memory DynamoDB and S3 with every service on one port; no Floci or internet needed.
const dynalite = require('dynalite');
const { mockClient } = require('aws-sdk-client-mock');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

async function startTestStack({ port = 0 } = {}) {
  const dbServer = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise((resolve) => dbServer.listen(0, resolve));
  const dbPort = dbServer.address().port;

  Object.assign(process.env, {
    AWS_ENDPOINT_URL: `http://127.0.0.1:${dbPort}`,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    JWT_SECRET: 'test-secret-that-is-long-enough',
    INTERNAL_TOKEN: 'test-internal-token',
    ADMIN_EMAILS: 'admin@test.com',
    RATE_LIMIT_PER_MINUTE: '100000',
    CORS_ORIGINS: 'http://localhost:4566'
  });
  delete process.env.DATABASE_URL;
  delete process.env.BREVO_API_KEY;
  delete process.env.EVENT_BUS_NAME;

  // Fake S3 that keeps objects in memory
  const objects = new Map();
  const s3 = mockClient(S3Client);
  s3.on(PutObjectCommand).callsFake((input) => {
    objects.set(`${input.Bucket}/${input.Key}`, { bytes: Buffer.from(input.Body), contentType: input.ContentType });
    return {};
  });
  s3.on(GetObjectCommand).callsFake((input) => {
    const obj = objects.get(`${input.Bucket}/${input.Key}`);
    if (!obj) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
    return { ContentType: obj.contentType, Body: { transformToByteArray: async () => new Uint8Array(obj.bytes) } };
  });

  const { createTables } = require('../scripts/create-tables');
  await createTables(undefined, () => {});

  const { createLocalServer } = require('../local-server');
  const server = createLocalServer().listen(port);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.INTERNAL_BASE_URL = base;

  async function api(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }

  async function login(email, name = 'Test User', password = 'password123') {
    await api('POST', '/api/auth/register', { body: { name, email, password } });
    const res = await api('POST', '/api/auth/login', { body: { email, password } });
    return res.body;
  }

  async function stop() {
    s3.restore();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => dbServer.close(resolve));
  }

  return { api, login, stop, base, objects };
}

module.exports = { startTestStack };
