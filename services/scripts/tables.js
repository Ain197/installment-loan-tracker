// DynamoDB table definitions (infra/*.sh creates the same tables).
const S = (name) => ({ AttributeName: name, AttributeType: 'S' });
const N = (name) => ({ AttributeName: name, AttributeType: 'N' });
const key = (hash, range) => [{ AttributeName: hash, KeyType: 'HASH' }, ...(range ? [{ AttributeName: range, KeyType: 'RANGE' }] : [])];
const index = (name, hash, range) => ({ IndexName: name, KeySchema: key(hash, range), Projection: { ProjectionType: 'ALL' } });

module.exports = [
  // Users: only used when DATABASE_URL (Neon) is not set
  { owner: 'auth', env: 'USERS_TABLE', TableName: 'LoanUsers', AttributeDefinitions: [S('id'), S('email')], KeySchema: key('id'), GlobalSecondaryIndexes: [index('email-index', 'email')] },
  { owner: 'plans', env: 'PLANS_TABLE', TableName: 'LoanPlans', AttributeDefinitions: [S('planId'), S('ownerId'), S('createdAt')], KeySchema: key('planId'), GlobalSecondaryIndexes: [index('ownerId-index', 'ownerId', 'createdAt')] },
  { owner: 'plans', env: 'INSTALMENTS_TABLE', TableName: 'LoanInstalments', AttributeDefinitions: [S('planId'), N('seq')], KeySchema: key('planId', 'seq') },
  { owner: 'payments', env: 'PAYMENTS_TABLE', TableName: 'LoanPayments', AttributeDefinitions: [S('paymentId'), S('planId'), S('createdAt'), S('status')], KeySchema: key('paymentId'), GlobalSecondaryIndexes: [index('planId-index', 'planId', 'createdAt'), index('status-index', 'status', 'createdAt')] },
  { owner: 'reminders', env: 'REMINDER_RULES_TABLE', TableName: 'LoanReminderRules', AttributeDefinitions: [S('planId')], KeySchema: key('planId') },
  { owner: 'reminders', env: 'REMINDER_RUNS_TABLE', TableName: 'LoanReminderRuns', AttributeDefinitions: [S('runId')], KeySchema: key('runId') },
  { owner: 'reminders', env: 'NOTIFICATIONS_TABLE', TableName: 'LoanNotifications', AttributeDefinitions: [S('notificationId'), S('ownerId'), S('planId'), S('createdAt')], KeySchema: key('notificationId'), GlobalSecondaryIndexes: [index('ownerId-index', 'ownerId', 'createdAt'), index('planId-index', 'planId', 'createdAt')] }
];
