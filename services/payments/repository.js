// LoanPayments: key paymentId, index planId-index (planId, createdAt)
const { GetCommand, PutCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { db, readAll, table } = require('../shared/db');

const PAYMENTS = table('PAYMENTS_TABLE', 'LoanPayments');

async function getPayment(paymentId) {
  const result = await db().send(new GetCommand({ TableName: PAYMENTS, Key: { paymentId } }));
  return result.Item || null;
}

async function putPayment(payment) {
  await db().send(new PutCommand({ TableName: PAYMENTS, Item: payment, ConditionExpression: 'attribute_not_exists(paymentId)' }));
  return payment;
}

function listByPlan(planId) {
  return readAll(QueryCommand, {
    TableName: PAYMENTS, IndexName: 'planId-index',
    KeyConditionExpression: 'planId = :p', ExpressionAttributeValues: { ':p': planId }
  });
}

// `condition` (optional) is an extra DynamoDB condition; `conditionValues` holds its :values
// Payments waiting for an admin (index status-index: status + createdAt)
function listByStatus(status) {
  return readAll(QueryCommand, {
    TableName: PAYMENTS, IndexName: 'status-index',
    KeyConditionExpression: '#s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': status }
  });
}

async function updatePayment(paymentId, fields, condition, conditionValues = {}, conditionNames = {}) {
  const names = { ...conditionNames };
  const values = { ...conditionValues };
  const sets = Object.entries(fields).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  try {
    const result = await db().send(new UpdateCommand({
      TableName: PAYMENTS, Key: { paymentId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: condition || 'attribute_exists(paymentId)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    }));
    return result.Attributes;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

module.exports = { getPayment, putPayment, listByPlan, listByStatus, updatePayment };
