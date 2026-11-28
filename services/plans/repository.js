// Plans        key: planId            index ownerId-index (ownerId, createdAt)
// Instalments  key: planId + seq
const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand, BatchWriteCommand
} = require('@aws-sdk/lib-dynamodb');
const { db, readAll, table } = require('../shared/db');

const PLANS = table('PLANS_TABLE', 'LoanPlans');
const INSTALMENTS = table('INSTALMENTS_TABLE', 'LoanInstalments');

async function getPlan(planId) {
  const result = await db().send(new GetCommand({ TableName: PLANS, Key: { planId } }));
  return result.Item || null;
}

async function putPlan(plan) {
  await db().send(new PutCommand({ TableName: PLANS, Item: plan }));
  return plan;
}

// Changes some fields of a plan; `expectedStatus` makes the change fail if someone else
// changed the status in the meantime (optimistic check).
async function updatePlan(planId, fields, expectedStatus) {
  const names = {};
  const values = {};
  const sets = Object.entries(fields).map(([key, value], i) => {
    names[`#f${i}`] = key;
    values[`:v${i}`] = value;
    return `#f${i} = :v${i}`;
  });
  let condition = 'attribute_exists(planId)';
  if (expectedStatus) {
    names['#status'] = 'status';
    values[':expected'] = expectedStatus;
    condition += ' AND #status = :expected';
  }
  try {
    const result = await db().send(new UpdateCommand({
      TableName: PLANS, Key: { planId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: condition,
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

async function deletePlan(planId) {
  await db().send(new DeleteCommand({ TableName: PLANS, Key: { planId } }));
}

function listPlansByOwner(ownerId) {
  return readAll(QueryCommand, {
    TableName: PLANS, IndexName: 'ownerId-index',
    KeyConditionExpression: 'ownerId = :o', ExpressionAttributeValues: { ':o': ownerId }
  });
}

function listAllPlans() {
  return readAll(ScanCommand, { TableName: PLANS });
}

function getInstalments(planId) {
  return readAll(QueryCommand, {
    TableName: INSTALMENTS,
    KeyConditionExpression: 'planId = :p', ExpressionAttributeValues: { ':p': planId }
  });
}

// BatchWrite takes at most 25 items per call
async function batchWrite(requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = { [INSTALMENTS]: requests.slice(i, i + 25) };
    for (let attempt = 0; pending && pending[INSTALMENTS] && attempt < 5; attempt++) {
      const result = await db().send(new BatchWriteCommand({ RequestItems: pending }));
      pending = result.UnprocessedItems && Object.keys(result.UnprocessedItems).length ? result.UnprocessedItems : null;
    }
  }
}

const putInstalments = (planId, instalments) =>
  batchWrite(instalments.map((inst) => ({ PutRequest: { Item: { planId, ...inst } } })));

const deleteInstalments = (planId, seqs) =>
  batchWrite(seqs.map((seq) => ({ DeleteRequest: { Key: { planId, seq } } })));

// Changes some fields of one instalment (amountPaid, lateFee, amountDue, interest, ...)
async function updateInstalment(planId, seq, fields) {
  const names = {};
  const values = {};
  const sets = Object.entries(fields).map(([key, value], i) => {
    names[`#f${i}`] = key;
    values[`:v${i}`] = value;
    return `#f${i} = :v${i}`;
  });
  await db().send(new UpdateCommand({
    TableName: INSTALMENTS, Key: { planId, seq },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(planId)',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }));
}

const setAmountPaid = (planId, seq, amountPaid) => updateInstalment(planId, seq, { amountPaid });

module.exports = {
  getPlan, putPlan, updatePlan, deletePlan, listPlansByOwner, listAllPlans,
  getInstalments, putInstalments, deleteInstalments, setAmountPaid, updateInstalment
};
