// Creates any missing DynamoDB tables; safe to run many times (npm run tables).
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const tables = require('./tables');

async function createTables(client = new DynamoDBClient({}), log = console.log) {
  for (const { owner, env, ...definition } of tables) {
    const TableName = process.env[env] || definition.TableName;
    try {
      await client.send(new DescribeTableCommand({ TableName }));
      log(`exists   ${TableName} (${owner})`);
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
      await client.send(new CreateTableCommand({ ...definition, TableName, BillingMode: 'PAY_PER_REQUEST' }));
      log(`created  ${TableName} (${owner})`);
    }
  }
}

if (require.main === module) {
  createTables().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { createTables };
