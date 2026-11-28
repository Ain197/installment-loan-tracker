const { createApp } = require('../shared/http');
const { createChecker } = require('../shared/validate');
const { requireAuth, requireRole, requireInternal, ROLES } = require('../shared/auth');
const { badRequest } = require('../shared/errors');
const service = require('./reminderService');

const TYPES = ['DUE_SOON', 'OVERDUE', 'LATE_FEE', 'PAYMENT_CONFIRMED', 'PAYMENT_REJECTED', 'PLAN_COMPLETED', 'ESCALATION'];

module.exports = createApp('reminders', (app) => {
  app.get('/api/plans/:planId/reminder-rule', requireAuth, async (req, res) => {
    res.json({ rule: await service.getRuleFor(req.user, req.params.planId) });
  });

  app.put('/api/plans/:planId/reminder-rule', requireAuth, async (req, res) => {
    const check = createChecker(req.body);
    const changes = {
      enabled: check.boolean('enabled'),
      email: check.email('email', { required: false }),
      overdueAlerts: check.boolean('overdueAlerts', { required: false }),
      paymentConfirmations: check.boolean('paymentConfirmations', { required: false })
    };
    const days = check.data.daysBefore;
    if (!Array.isArray(days) || days.length < 1 || days.length > 5 ||
        !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 30)) {
      check.add('daysBefore', 'daysBefore must be a list of 1 to 5 whole numbers between 0 and 30 (0 = on the due date).');
    } else {
      changes.daysBefore = days;
    }
    check.done();
    const rule = await service.updateRule(req.user, req.params.planId, changes);
    res.json({ rule, message: rule.enabled ? `Reminders on: ${rule.daysBefore.join(', ')} day(s) before each due date.` : 'Reminders are off for this plan.' });
  });

  app.get('/api/reminders/upcoming', requireAuth, async (req, res) => {
    const check = createChecker(req.query);
    const days = check.number('days', { required: false, min: 1, max: 90, integer: true });
    check.done();
    res.json(await service.upcoming(req.user, days || 7));
  });

  app.get('/api/notifications', requireAuth, async (req, res) => {
    const check = createChecker(req.query);
    const filters = {
      planId: check.text('planId', { required: false, max: 64 }),
      status: check.oneOf('status', ['SENT', 'FAILED', 'SENDING'], { required: false }),
      type: check.oneOf('type', TYPES, { required: false })
    };
    check.done('Invalid filters.');
    const notifications = await service.listNotifications(req.user, filters);
    res.json({ notifications, count: notifications.length });
  });

  app.post('/api/notifications/:notificationId/retries', requireAuth, async (req, res) => {
    const notification = await service.retry(req.user, req.params.notificationId);
    res.json({ notification, message: notification.status === 'SENT' ? 'Email sent.' : 'The email failed again. Check the error and try later.' });
  });

  app.post('/api/reminder-runs', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    const check = createChecker(req.body || {});
    const asOf = check.date('asOf', { required: false });
    check.done();
    const summary = await service.runCheck({ asOf, trigger: 'manual' });
    res.status(201).json({
      run: summary,
      message: `Daily run finished: ${summary.lateFees.applied} late fee(s), ${summary.sent} email(s) sent, ${summary.escalations} escalation(s), ${summary.failed} failed.`
    });
  });

  app.get('/api/reminder-runs', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    const runs = await service.listRuns(30);
    res.json({ runs, count: runs.length });
  });

  app.get('/api/monitoring/overview', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    res.json({ overview: await service.monitoringOverview() });
  });

  app.post('/internal/events', requireInternal, async (req, res) => {
    const { detailType, detail } = req.body || {};
    if (typeof detailType !== 'string' || !detail) throw badRequest('detailType and detail are required.');
    res.json(await service.handleEvent(detailType, detail));
  });
});
