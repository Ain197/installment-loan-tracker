// Service 3 — Reminders & Notifications (Student C)
// Routes -> validation -> reminderService (business rules) -> repository (DynamoDB) + email (Brevo API).
const { createApp } = require('../shared/http');
const { createChecker } = require('../shared/validate');
const { requireAuth, requireRole, requireInternal, ROLES } = require('../shared/auth');
const { badRequest } = require('../shared/errors');
const service = require('./reminderService');

const TYPES = ['DUE_SOON', 'OVERDUE', 'LATE_FEE', 'PAYMENT_CONFIRMED', 'PAYMENT_REJECTED', 'PLAN_COMPLETED', 'ESCALATION'];

module.exports = createApp('reminders', (app) => {
  // GET /api/plans/:planId/reminder-rule
  app.get('/api/plans/:planId/reminder-rule', requireAuth, async (req, res) => {
    res.json({ rule: await service.getRuleFor(req.user, req.params.planId) });
  });

  // PUT /api/plans/:planId/reminder-rule { daysBefore: [3,1], enabled, email?, overdueAlerts?, paymentConfirmations? }
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

  // GET /api/reminders/upcoming?days=7 -> instalments due soon + overdue ones
  app.get('/api/reminders/upcoming', requireAuth, async (req, res) => {
    const check = createChecker(req.query);
    const days = check.number('days', { required: false, min: 1, max: 90, integer: true });
    check.done();
    res.json(await service.upcoming(req.user, days || 7));
  });

  // GET /api/notifications?planId=&status=&type= -> notification log (newest first)
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

  // POST /api/notifications/:notificationId/retries -> resend a FAILED notification
  app.post('/api/notifications/:notificationId/retries', requireAuth, async (req, res) => {
    const notification = await service.retry(req.user, req.params.notificationId);
    res.json({ notification, message: notification.status === 'SENT' ? 'Email sent.' : 'The email failed again. Check the error and try later.' });
  });

  // POST /api/reminder-runs { asOf? } (admin) -> run the daily check now
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

  // GET /api/reminder-runs (admin) -> history of the daily job
  app.get('/api/reminder-runs', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    const runs = await service.listRuns(30);
    res.json({ runs, count: runs.length });
  });

  // GET /api/monitoring/overview (admin) -> last runs, email stats, alert settings
  app.get('/api/monitoring/overview', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    res.json({ overview: await service.monitoringOverview() });
  });

  // ---- internal: events delivered without EventBridge (local mode) ----
  app.post('/internal/events', requireInternal, async (req, res) => {
    const { detailType, detail } = req.body || {};
    if (typeof detailType !== 'string' || !detail) throw badRequest('detailType and detail are required.');
    res.json(await service.handleEvent(detailType, detail));
  });
});
