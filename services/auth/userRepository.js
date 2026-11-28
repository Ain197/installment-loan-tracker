// Users live in Neon Postgres when DATABASE_URL is set, otherwise in the DynamoDB table USERS_TABLE.
const { randomUUID } = require('crypto');

function createNeonRepository(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  let ready;

  // Creates the table the first time (same SQL as infra/neon/schema.sql)
  const ensureTable = () => {
    ready = ready || sql`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('USER', 'ADMIN')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    return ready;
  };

  const toUser = (row) => row && ({
    id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash,
    role: row.role, createdAt: new Date(row.created_at).toISOString()
  });

  return {
    kind: 'neon',
    async create({ name, email, passwordHash, role }) {
      await ensureTable();
      const id = randomUUID();
      const rows = await sql`
        INSERT INTO users (id, name, email, password_hash, role)
        VALUES (${id}, ${name}, ${email}, ${passwordHash}, ${role})
        ON CONFLICT (email) DO NOTHING
        RETURNING *`;
      return toUser(rows[0]) || null; // null = email already registered
    },
    async findByEmail(email) {
      await ensureTable();
      const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
      return toUser(rows[0]) || null;
    },
    async findById(id) {
      await ensureTable();
      const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
      return toUser(rows[0]) || null;
    },
    async list() {
      await ensureTable();
      const rows = await sql`SELECT * FROM users ORDER BY name`;
      return rows.map(toUser);
    }
  };
}

function createDynamoRepository() {
  const { PutCommand, GetCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const { db, readAll, table } = require('../shared/db');
  const TABLE = table('USERS_TABLE', 'LoanUsers');

  return {
    kind: 'dynamodb',
    async create({ name, email, passwordHash, role }) {
      if (await this.findByEmail(email)) return null;
      const user = { id: randomUUID(), name, email, passwordHash, role, createdAt: new Date().toISOString() };
      await db().send(new PutCommand({ TableName: TABLE, Item: user, ConditionExpression: 'attribute_not_exists(id)' }));
      return user;
    },
    async findByEmail(email) {
      const result = await db().send(new QueryCommand({
        TableName: TABLE, IndexName: 'email-index',
        KeyConditionExpression: 'email = :e', ExpressionAttributeValues: { ':e': email }
      }));
      return (result.Items && result.Items[0]) || null;
    },
    async findById(id) {
      const result = await db().send(new GetCommand({ TableName: TABLE, Key: { id } }));
      return result.Item || null;
    },
    async list() {
      const items = await readAll(ScanCommand, { TableName: TABLE });
      return items.sort((a, b) => a.name.localeCompare(b.name));
    }
  };
}

let repo;
function users() {
  repo = repo || (process.env.DATABASE_URL ? createNeonRepository(process.env.DATABASE_URL) : createDynamoRepository());
  return repo;
}

module.exports = { users };
