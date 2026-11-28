const { createApp } = require('../shared/http');
const { createChecker } = require('../shared/validate');
const { requireAuth, requireRole, ROLES } = require('../shared/auth');
const service = require('./paymentService');

module.exports = createApp('payments', (app) => {
  app.post('/api/plans/:planId/payments', requireAuth, async (req, res) => {
    const check = createChecker(req.body);
    const input = {
      amount: check.number('amount', { min: 0.01, max: 100_000_000, decimals: 2 }),
      paidOn: check.date('paidOn'),
      method: check.oneOf('method', service.METHODS),
      note: check.text('note', { required: false, max: 200 })
    };
    check.done();
    res.status(201).json(await service.recordPayment(req.user, req.params.planId, input));
  });

  app.post('/api/plans/:planId/payoffs', requireAuth, async (req, res) => {
    const check = createChecker(req.body);
    const input = {
      paidOn: check.date('paidOn'),
      method: check.oneOf('method', service.METHODS),
      note: check.text('note', { required: false, max: 200 })
    };
    check.done();
    res.status(201).json(await service.payOff(req.user, req.params.planId, input));
  });

  app.get('/api/payments/pending', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    const payments = await service.listPending();
    res.json({ payments, count: payments.length });
  });

  app.patch('/api/payments/:paymentId/verification', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    const check = createChecker(req.body);
    const decision = check.oneOf('decision', ['APPROVE', 'REJECT']);
    const reason = check.text('reason', { required: decision === 'REJECT', min: 5, max: 200 });
    check.done();
    res.json(await service.review(req.user, req.params.paymentId, { decision, reason }));
  });

  app.delete('/api/payments/:paymentId', requireAuth, async (req, res) => {
    await service.withdraw(req.user, req.params.paymentId);
    res.status(204).end();
  });

  app.get('/api/plans/:planId/payments', requireAuth, async (req, res) => {
    const check = createChecker(req.query);
    const filters = {
      from: check.date('from', { required: false }),
      to: check.date('to', { required: false }),
      method: check.oneOf('method', service.METHODS, { required: false }),
      status: check.oneOf('status', Object.values(service.STATUS), { required: false })
    };
    const includeReversed = check.oneOf('includeReversed', ['true', 'false'], { required: false });
    check.done('Invalid filters.');
    filters.includeReversed = includeReversed === 'true';
    res.json(await service.listPayments(req.user, req.params.planId, filters));
  });

  app.get('/api/plans/:planId/balance', requireAuth, async (req, res) => {
    res.json({ balance: await service.getBalance(req.user, req.params.planId) });
  });

  app.get('/api/balances/summary', requireAuth, async (req, res) => {
    res.json({ summary: await service.getSummary(req.user) });
  });

  app.post('/api/payments/:paymentId/receipt', requireAuth, async (req, res) => {
    const payment = await service.attachReceipt(req.user, req.params.paymentId, req.body || {});
    res.status(201).json({ payment, message: 'Receipt uploaded.' });
  });

  app.get('/api/payments/:paymentId/receipt', requireAuth, async (req, res) => {
    res.json({ receipt: await service.getReceipt(req.user, req.params.paymentId) });
  });

  app.patch('/api/payments/:paymentId/reversal', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    const check = createChecker(req.body);
    const reason = check.text('reason', { min: 5, max: 200 });
    check.done();
    const result = await service.reversePayment(req.user, req.params.paymentId, reason);
    res.json({ ...result, message: 'Payment reversed and the balance recalculated.' });
  });
});
