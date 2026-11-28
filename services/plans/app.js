const { createApp } = require('../shared/http');
const { createChecker } = require('../shared/validate');
const { requireAuth, requireInternal } = require('../shared/auth');
const { badRequest } = require('../shared/errors');
const { FREQUENCIES, INTEREST_METHODS } = require('./schedule');
const service = require('./planService');

const MAX_AMOUNT = 100_000_000;

function readPlanInput(body, { partial }) {
  const check = createChecker(body);
  const required = !partial;
  const input = {
    title: check.text('title', { required, min: 2, max: 80 }),
    provider: check.text('provider', { required, min: 2, max: 80 }),
    totalAmount: check.number('totalAmount', { required, min: 1, max: MAX_AMOUNT, decimals: 2 }),
    downPayment: check.number('downPayment', { required: false, min: 0, max: MAX_AMOUNT, decimals: 2 }),
    instalmentCount: check.number('instalmentCount', { required, min: 1, max: 120, integer: true }),
    frequency: check.oneOf('frequency', FREQUENCIES, { required }),
    startDate: check.date('startDate', { required }),
    annualRate: check.number('annualRate', { required: false, min: 0, max: 100, decimals: 2 }),
    interestMethod: check.oneOf('interestMethod', INTEREST_METHODS, { required: false }),
    lateFeePolicy: readLateFeePolicy(check)
  };
  if (!partial) input.ownerId = check.text('ownerId', { required: false, max: 64 });
  check.done();
  if (partial && Object.values(input).every((v) => v === undefined)) {
    throw badRequest('Send at least one field to change.');
  }
  return input;
}

// lateFeePolicy: null (no fees) or { graceDays: 0-60, type: FIXED | PERCENT, value }
function readLateFeePolicy(check) {
  const raw = check.data.lateFeePolicy;
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) { check.add('lateFeePolicy', 'lateFeePolicy must be an object or null.'); return undefined; }
  const inner = createChecker(raw);
  const policy = {
    graceDays: inner.number('graceDays', { min: 0, max: 60, integer: true }),
    type: inner.oneOf('type', ['FIXED', 'PERCENT']),
    value: inner.number('value', { min: 0.01, max: 100_000, decimals: 2 })
  };
  if (policy.type === 'PERCENT' && policy.value > 25) inner.add('value', 'A percentage late fee can be at most 25%.');
  inner.problems.forEach((p) => check.add(`lateFeePolicy.${p.field}`, p.message));
  return inner.problems.length ? undefined : policy;
}

module.exports = createApp('plans', (app) => {
  app.post('/api/plans', requireAuth, async (req, res) => {
    const plan = await service.createPlan(req.user, readPlanInput(req.body, { partial: false }));
    res.status(201).json({ plan, message: `Plan created with ${plan.instalmentCount} instalments.` });
  });

  app.get('/api/plans', requireAuth, async (req, res) => {
    const check = createChecker(req.query);
    const filters = {
      status: check.oneOf('status', Object.values(service.STATUS), { required: false }),
      provider: check.text('provider', { required: false, max: 80 }),
      q: check.text('q', { required: false, max: 80 }),
      dueBefore: check.date('dueBefore', { required: false }),
      ownerId: check.text('ownerId', { required: false, max: 64 }),
      sort: check.oneOf('sort', ['nextDue', 'created', 'remaining', 'title'], { required: false })
    };
    const overdue = check.oneOf('overdue', ['true', 'false'], { required: false });
    check.done('Invalid search filters.');
    if (overdue !== undefined) filters.overdue = overdue === 'true';
    const plans = await service.searchPlans(req.user, filters);
    res.json({ plans, count: plans.length });
  });

  app.get('/api/plans/:planId', requireAuth, async (req, res) => {
    res.json({ plan: await service.getPlanFor(req.user, req.params.planId) });
  });

  app.put('/api/plans/:planId', requireAuth, async (req, res) => {
    const plan = await service.updatePlan(req.user, req.params.planId, readPlanInput(req.body, { partial: true }));
    res.json({ plan, message: 'Plan updated.' });
  });

  app.patch('/api/plans/:planId/status', requireAuth, async (req, res) => {
    const check = createChecker(req.body);
    const status = check.text('status', { max: 20 });
    check.done();
    const plan = await service.changeStatus(req.user, req.params.planId, status);
    res.json({ plan, message: 'Plan cancelled.' });
  });

  app.get('/api/plans/:planId/payoff-quote', requireAuth, async (req, res) => {
    res.json({ quote: await service.getPayoffQuote(req.user, req.params.planId) });
  });

  app.post('/api/plans/:planId/instalments/:seq/late-fee-waivers', requireAuth, async (req, res) => {
    const check = createChecker({ ...req.body, seq: req.params.seq });
    const seq = check.number('seq', { min: 1, max: 120, integer: true });
    const reason = check.text('reason', { min: 5, max: 200 });
    check.done();
    const plan = await service.waiveLateFee(req.user, req.params.planId, seq, reason);
    res.status(201).json({ plan, message: `Late fee on instalment #${seq} waived.` });
  });

  app.delete('/api/plans/:planId', requireAuth, async (req, res) => {
    await service.deletePlan(req.user, req.params.planId);
    res.status(204).end();
  });

  app.get('/internal/plans', requireInternal, async (req, res) => {
    res.json({ plans: await service.internalList({ ownerId: req.query.ownerId, status: req.query.status }) });
  });

  app.get('/internal/plans/:planId', requireInternal, async (req, res) => {
    res.json({ plan: await service.internalGet(req.params.planId) });
  });

  app.get('/internal/plans/:planId/payoff-quote', requireInternal, async (req, res) => {
    res.json({ quote: await service.getPayoffQuote(null, req.params.planId) });
  });

  app.post('/internal/plans/:planId/payoff-settlements', requireInternal, async (req, res) => {
    const amount = req.body && req.body.expectedAmount;
    if (typeof amount !== 'number') throw badRequest('expectedAmount is required.');
    res.json({ plan: await service.settlePayoff(req.params.planId, amount) });
  });

  // Started by the daily job in the Reminders service
  app.post('/internal/late-fee-runs', requireInternal, async (req, res) => {
    const asOf = req.body && req.body.asOf;
    res.json({ run: await service.assessLateFees(asOf ? { asOf } : {}) });
  });

  app.put('/internal/plans/:planId/paid-amounts', requireInternal, async (req, res) => {
    const paid = req.body && Array.isArray(req.body.paid) ? req.body.paid : null;
    if (!paid || !paid.every((p) => Number.isInteger(p.seq) && typeof p.amountPaid === 'number')) {
      throw badRequest('paid must be a list of { seq, amountPaid }.');
    }
    res.json({ plan: await service.setPaidAmounts(req.params.planId, paid) });
  });
});

