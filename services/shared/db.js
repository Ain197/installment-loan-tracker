// No keys in the code: Lambda uses its IAM role, a local run uses the Floci settings in .env.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

let client;

function db() {
  if (!client) {
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true }
    });
  }
  return client;
}

// Reads every page of a Query or Scan (DynamoDB returns at most 1 MB per call).
// Usage: readAll(QueryCommand, { TableName, KeyConditionExpression, ... })
async function readAll(CommandClass, firstInput) {
  const items = [];
  let input = firstInput;
  for (;;) {
    const result = await db().send(new CommandClass(input));
    items.push(...(result.Items || []));
    if (!result.LastEvaluatedKey) return items;
    input = { ...input, ExclusiveStartKey: result.LastEvaluatedKey };
  }
}

// Table names come from environment variables, with defaults that match infra/config.sh.
const table = (envName, fallback) => process.env[envName] || fallback;

module.exports = { db, readAll, table };
