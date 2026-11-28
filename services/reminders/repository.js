// LoanReminderRules   key: planId
// LoanNotifications   key: notificationId, indexes ownerId-index and planId-index (by createdAt)
const { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { db, readAll, table } = require('../shared/db');

const RULES = table('REMINDER_RULES_TABLE', 'LoanReminderRules');
const LOG = table('NOTIFICATIONS_TABLE', 'LoanNotifications');
const RUNS = table('REMINDER_RUNS_TABLE', 'LoanReminderRuns');

async function getRule(planId) {
  const result = await db().send(new GetCommand({ TableName: RULES, Key: { planId } }));
  return result.Item || null;
}

async function putRule(rule) {
  await db().send(new PutCommand({ TableName: RULES, Item: rule }));
  return rule;
}

// Creates the rule only if the plan has none yet (returns the existing one otherwise)
async function createRuleIfMissing(rule) {
  try {
    await db().send(new PutCommand({ TableName: RULES, Item: rule, ConditionExpression: 'attribute_not_exists(planId)' }));
    return rule;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return getRule(rule.planId);
    throw error;
  }
}

async function deleteRule(planId) {
  await db().send(new DeleteCommand({ TableName: RULES, Key: { planId } }));
}

async function getNotification(notificationId) {
  const result = await db().send(new GetCommand({ TableName: LOG, Key: { notificationId } }));
  return result.Item || null;
}

// "Claims" a notification before sending it. Fails (returns false) if it already exists,
// which is how a reminder is never sent twice. `allowFailed` lets a manual retry take over
// a FAILED one.
async function claimNotification(item, { allowFailed = false } = {}) {
  try {
    await db().send(new PutCommand({
      TableName: LOG,
      Item: item,
      ConditionExpression: allowFailed ? 'attribute_not_exists(notificationId) OR #s = :failed' : 'attribute_not_exists(notificationId)',
      ...(allowFailed ? { ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':failed': 'FAILED' } } : {})
    }));
    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

async function finishNotification(notificationId, fields) {
  const names = {};
  const values = {};
  const sets = Object.entries(fields).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  const result = await db().send(new UpdateCommand({
    TableName: LOG, Key: { notificationId },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW'
  }));
  return result.Attributes;
}

function listByOwner(ownerId) {
  return readAll(QueryCommand, {
    TableName: LOG, IndexName: 'ownerId-index', ScanIndexForward: false,
    KeyConditionExpression: 'ownerId = :o', ExpressionAttributeValues: { ':o': ownerId }
  });
}

function listByPlan(planId) {
  return readAll(QueryCommand, {
    TableName: LOG, IndexName: 'planId-index', ScanIndexForward: false,
    KeyConditionExpression: 'planId = :p', ExpressionAttributeValues: { ':p': planId }
  });
}

const listAll = () => readAll(ScanCommand, { TableName: LOG });

// History of the daily job (one item per run)
async function putRun(run) {
  await db().send(new PutCommand({ TableName: RUNS, Item: run }));
  return run;
}
const listRuns = () => readAll(ScanCommand, { TableName: RUNS });

module.exports = {
  getRule, putRule, createRuleIfMissing, deleteRule,
  getNotification, claimNotification, finishNotification, listByOwner, listByPlan, listAll, putRun, listRuns
};
