const { randomUUID } = require('crypto');
const repo = require('./repository');
const { buildInstalments, planView, reschedule, lateFeesDue, payoffQuote } = require('./schedule');
const { toCents, fromCents } = require('../shared/money');
const { today, addDays } = require('../shared/dates');
const { isAdmin, assertCanAccess } = require('../shared/auth');
const { putMetrics } = require('../shared/metrics');
const { badRequest, notFound, conflict, forbidden } = require('../shared/errors');
const { callService } = require('../shared/serviceClient');
const { publish } = require('../shared/events');

const STATUS = { ACTIVE: 'ACTIVE', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' };

// Works out who the plan belongs to. Users create plans for themselves;
// an admin may create one for any registered customer.
async function resolveOwner(user, ownerId) {
  if (!ownerId || ownerId === user.id) return { id: user.id, name: user.name, email: user.email };
  if (!isAdmin(user)) throw badRequest('Only an admin can create a plan for another user.', [{ field: 'ownerId', message: 'Leave ownerId empty.' }]);
  try {
    const { user: owner } = await callService('auth', 'GET', `/internal/users/${encodeURIComponent(ownerId)}`);
    return { id: owner.id, name: owner.name, email: owner.email };
  } catch (error) {
    if (error.status === 404) throw badRequest('No user has this id.', [{ field: 'ownerId', message: 'No user has this id.' }]);
    throw error;
  }
}

function checkPlanRules({ totalAmount, downPayment = 0, instalmentCount, startDate }) {
  const problems = [];
  const financed = toCents(totalAmount) - toCents(downPayment);
  if (financed <= 0) problems.push({ field: 'downPayment', message: 'downPayment must be less than totalAmount.' });
  else if (financed / instalmentCount < 100) problems.push({ field: 'instalmentCount', message: 'Each instalment must be at least 1.00.' });
  if (startDate < addDays(today(), -365)) problems.push({ field: 'startDate', message: 'startDate cannot be more than 1 year in the past.' });
  if (startDate > addDays(today(), 730)) problems.push({ field: 'startDate', message: 'startDate cannot be more than 2 years in the future.' });
  if (problems.length) throw badRequest('The plan breaks a business rule.', problems);
}

async function loadPlan(planId) {
  const plan = await repo.getPlan(planId);
  if (!plan) throw notFound('Plan');
  return plan;
}

async function viewOf(plan) {
  return planView(plan, await repo.getInstalments(plan.planId));
}

async function createPlan(user, input) {
  checkPlanRules(input);
  const owner = await resolveOwner(user, input.ownerId);
  const now = new Date().toISOString();
  const plan = {
    planId: randomUUID(),
    ownerId: owner.id,
    ownerName: owner.name,
    ownerEmail: owner.email,
    title: input.title,
    provider: input.provider,
    totalAmount: input.totalAmount,
    downPayment: input.downPayment || 0,
    instalmentCount: input.instalmentCount,
    frequency: input.frequency,
    startDate: input.startDate,
    annualRate: input.annualRate || 0,
    interestMethod: input.annualRate ? (input.interestMethod || 'REDUCING') : 'NONE',
    lateFeePolicy: input.lateFeePolicy || null,
    status: STATUS.ACTIVE,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now
  };
  const instalments = buildInstalments({
    amount: plan.totalAmount - plan.downPayment,
    count: plan.instalmentCount,
    frequency: plan.frequency,
    firstDue: plan.startDate,
    annualRate: plan.annualRate,
    interestMethod: plan.interestMethod
  });
  await repo.putPlan(plan);
  await repo.putInstalments(plan.planId, instalments);
  await publish('PlanCreated', {
    planId: plan.planId, ownerId: plan.ownerId, ownerEmail: plan.ownerEmail, ownerName: plan.ownerName, title: plan.title
  });
  return planView(plan, instalments);
}

async function getPlanFor(user, planId) {
  const plan = await loadPlan(planId);
  assertCanAccess(user, plan.ownerId);
  return viewOf(plan);
}

// Search and filter. Users only ever see their own plans.
async function searchPlans(user, filters) {
  let plans;
  if (!isAdmin(user)) plans = await repo.listPlansByOwner(user.id);
  else if (filters.ownerId) plans = await repo.listPlansByOwner(filters.ownerId);
  else plans = await repo.listAllPlans();

  let views = await Promise.all(plans.map(viewOf));
  const q = filters.q && filters.q.toLowerCase();
  views = views.filter((p) =>
    (!filters.status || p.status === filters.status) &&
    (!filters.provider || p.provider.toLowerCase() === filters.provider.toLowerCase()) &&
    (!q || p.title.toLowerCase().includes(q) || p.provider.toLowerCase().includes(q) || (p.ownerName || '').toLowerCase().includes(q)) &&
    (!filters.dueBefore || (p.nextDue && p.nextDue.dueDate <= filters.dueBefore)) &&
    (filters.overdue === undefined || p.isOverdue === filters.overdue)
  );

  const sorters = {
    nextDue: (a, b) => (a.nextDue ? a.nextDue.dueDate : '9999') .localeCompare(b.nextDue ? b.nextDue.dueDate : '9999'),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    remaining: (a, b) => b.remainingAmount - a.remainingAmount,
    title: (a, b) => a.title.localeCompare(b.title)
  };
  views.sort(sorters[filters.sort || 'nextDue']);
  // The list does not need every instalment, only its status strip (the "ribbon" on the page)
  return views.map(({ instalments, ...rest }) => ({ ...rest, ribbon: instalments.map((i) => i.status) }));
}

async function updatePlan(user, planId, changes) {
  const plan = await loadPlan(planId);
  assertCanAccess(user, plan.ownerId);
  if (plan.status !== STATUS.ACTIVE) throw conflict('PLAN_NOT_ACTIVE', `A ${plan.status.toLowerCase()} plan cannot be changed.`);

  // Interest method only matters when there is a rate
  if (changes.annualRate !== undefined || changes.interestMethod !== undefined) {
    const rate = changes.annualRate !== undefined ? changes.annualRate : plan.annualRate || 0;
    const current = plan.interestMethod && plan.interestMethod !== 'NONE' ? plan.interestMethod : 'REDUCING';
    changes.interestMethod = rate ? (changes.interestMethod || current) : 'NONE';
  }

  const instalments = await repo.getInstalments(planId);
  const anythingPaid = instalments.some((i) => toCents(i.amountPaid || 0) > 0);
  const moneyChanged = ['totalAmount', 'downPayment', 'startDate', 'annualRate', 'interestMethod']
    .some((f) => changes[f] !== undefined && changes[f] !== plan[f]);
  if (anythingPaid && moneyChanged) {
    throw conflict('PLAN_HAS_PAYMENTS', 'totalAmount, downPayment, startDate and the interest rate cannot change after a payment. You can still change instalmentCount, frequency and the late-fee policy.');
  }

  const next = { ...plan, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
  const scheduleChanged = moneyChanged || next.instalmentCount !== plan.instalmentCount || next.frequency !== plan.frequency;
  let fresh = null;
  let removed = [];

  if (scheduleChanged) {
    if (moneyChanged) {
      checkPlanRules(next);
      removed = instalments;
      fresh = buildInstalments({
        amount: next.totalAmount - next.downPayment, count: next.instalmentCount, frequency: next.frequency,
        firstDue: next.startDate, annualRate: next.annualRate || 0, interestMethod: next.interestMethod
      });
    } else {
      const result = reschedule({ plan: next, instalments, newCount: next.instalmentCount, newFrequency: next.frequency });
      if (result.error) throw badRequest(result.error, [{ field: 'instalmentCount', message: result.error }]);
      removed = result.removed;
      fresh = result.fresh;
    }
  }

  const fields = {
    title: next.title, provider: next.provider, totalAmount: next.totalAmount, downPayment: next.downPayment,
    startDate: next.startDate, instalmentCount: next.instalmentCount, frequency: next.frequency,
    annualRate: next.annualRate || 0, interestMethod: next.interestMethod || 'NONE',
    lateFeePolicy: next.lateFeePolicy === undefined ? null : next.lateFeePolicy,
    updatedAt: new Date().toISOString()
  };
  const saved = await repo.updatePlan(planId, fields, STATUS.ACTIVE);
  if (!saved) throw conflict('PLAN_CHANGED', 'The plan was changed by someone else. Reload and try again.');

  if (fresh) {
    await repo.deleteInstalments(planId, removed.map((i) => i.seq));
    await repo.putInstalments(planId, fresh);
    await publish('PlanRescheduled', { planId, ownerId: plan.ownerId });
  }
  return viewOf(saved);
}

// Status workflow: ACTIVE -> CANCELLED is the only change a person makes by hand.
// ACTIVE <-> COMPLETED happens automatically when payments cover every instalment.
async function changeStatus(user, planId, status) {
  const plan = await loadPlan(planId);
  assertCanAccess(user, plan.ownerId);
  if (status !== STATUS.CANCELLED) throw badRequest('Only CANCELLED can be set by hand.', [{ field: 'status', message: 'status must be CANCELLED.' }]);
  if (plan.status !== STATUS.ACTIVE) throw conflict('PLAN_NOT_ACTIVE', `Only an active plan can be cancelled (this one is ${plan.status}).`);
  const instalments = await repo.getInstalments(planId);
  if (instalments.some((i) => toCents(i.amountPaid || 0) > 0)) {
    throw conflict('PLAN_HAS_PAYMENTS', 'A plan with payments cannot be cancelled. An admin can reverse the payments first.');
  }
  const now = new Date().toISOString();
  const saved = await repo.updatePlan(planId, { status: STATUS.CANCELLED, cancelledAt: now, updatedAt: now }, STATUS.ACTIVE);
  if (!saved) throw conflict('PLAN_CHANGED', 'The plan was changed by someone else. Reload and try again.');
  await publish('PlanCancelled', { planId, ownerId: plan.ownerId });
  return planView(saved, instalments);
}

async function deletePlan(user, planId) {
  const plan = await loadPlan(planId);
  assertCanAccess(user, plan.ownerId);
  if (plan.status !== STATUS.CANCELLED) throw conflict('PLAN_NOT_CANCELLED', 'Cancel the plan before deleting it.');
  const instalments = await repo.getInstalments(planId);
  await repo.deleteInstalments(planId, instalments.map((i) => i.seq));
  await repo.deletePlan(planId);
  await publish('PlanDeleted', { planId, ownerId: plan.ownerId });
}

async function internalGet(planId) {
  return viewOf(await loadPlan(planId));
}

async function internalList({ ownerId, status }) {
  const plans = ownerId ? await repo.listPlansByOwner(ownerId) : await repo.listAllPlans();
  const chosen = plans.filter((p) => !status || p.status === status);
  return Promise.all(chosen.map(viewOf));
}

// Payments sends the paid amount of every instalment after it re-allocates the payments.
// This service stores them and moves the plan to COMPLETED (or back to ACTIVE after a reversal).
async function setPaidAmounts(planId, paid) {
  const plan = await loadPlan(planId);
  if (plan.status === STATUS.CANCELLED) throw conflict('PLAN_NOT_ACTIVE', 'This plan is cancelled.');
  const instalments = await repo.getInstalments(planId);
  const bySeq = new Map(instalments.map((i) => [i.seq, i]));
  for (const { seq, amountPaid } of paid) {
    const inst = bySeq.get(seq);
    if (!inst) throw badRequest(`Instalment ${seq} does not exist.`);
    if (amountPaid < 0 || toCents(amountPaid) > toCents(inst.amountDue)) throw badRequest(`Instalment ${seq} cannot have ${amountPaid} paid.`);
  }
  for (const { seq, amountPaid } of paid) {
    if (toCents(bySeq.get(seq).amountPaid || 0) !== toCents(amountPaid)) {
      await repo.setAmountPaid(planId, seq, amountPaid);
      bySeq.get(seq).amountPaid = amountPaid;
    }
  }
  const current = await syncCompletion(plan, [...bySeq.values()]);
  return planView(current, [...bySeq.values()]);
}

// ACTIVE -> COMPLETED when every instalment is paid; back to ACTIVE if a reversal reopens it
async function syncCompletion(plan, instalments) {
  const allPaid = instalments.every((i) => toCents(i.amountPaid || 0) >= toCents(i.amountDue));
  const now = new Date().toISOString();
  if (allPaid && plan.status === STATUS.ACTIVE) {
    const saved = await repo.updatePlan(plan.planId, { status: STATUS.COMPLETED, completedAt: now, updatedAt: now }) || plan;
    await publish('PlanCompleted', { planId: plan.planId, ownerId: plan.ownerId, ownerEmail: plan.ownerEmail, title: plan.title });
    return saved;
  }
  if (!allPaid && plan.status === STATUS.COMPLETED) {
    return await repo.updatePlan(plan.planId, { status: STATUS.ACTIVE, completedAt: null, updatedAt: now }) || plan;
  }
  return plan;
}

// Run once a day (started by the Reminders daily job). Charges one fee per instalment that is
// more than graceDays late, following each plan's own policy.
async function assessLateFees({ asOf = today() } = {}) {
  const plans = (await repo.listAllPlans()).filter((p) => p.status === STATUS.ACTIVE && p.lateFeePolicy && p.lateFeePolicy.value);
  const summary = { asOf, plansChecked: plans.length, feesApplied: 0, totalFees: 0, items: [] };
  let totalCents = 0;
  for (const plan of plans) {
    const instalments = await repo.getInstalments(plan.planId);
    const fees = lateFeesDue(plan, instalments, asOf);
    if (!fees.length) continue;
    const bySeq = new Map(instalments.map((i) => [i.seq, i]));
    for (const f of fees) {
      const inst = bySeq.get(f.seq);
      await repo.updateInstalment(plan.planId, f.seq, {
        lateFee: f.fee,
        amountDue: fromCents(toCents(inst.amountDue) + toCents(f.fee)),
        lateFeeAssessedOn: asOf
      });
      totalCents += toCents(f.fee);
      summary.items.push({ planId: plan.planId, title: plan.title, ownerName: plan.ownerName, ...f });
    }
    summary.feesApplied += fees.length;
    await publish('LateFeeApplied', {
      planId: plan.planId, ownerId: plan.ownerId, ownerEmail: plan.ownerEmail, ownerName: plan.ownerName, title: plan.title, asOf, fees
    });
  }
  summary.totalFees = fromCents(totalCents);
  await putMetrics({ LateFeesApplied: summary.feesApplied, LateFeesAmount: summary.totalFees });
  return summary;
}

// Admin only. Allowed while no part of the fee has been paid yet.
async function waiveLateFee(user, planId, seq, reason) {
  if (!isAdmin(user)) throw forbidden('Only an admin can waive a late fee.');
  const plan = await loadPlan(planId);
  if (plan.status !== STATUS.ACTIVE) throw conflict('PLAN_NOT_ACTIVE', 'Late fees can only be waived on an active plan.');
  const instalments = await repo.getInstalments(planId);
  const inst = instalments.find((i) => i.seq === seq);
  if (!inst) throw notFound('Instalment');
  if (!toCents(inst.lateFee || 0)) throw conflict('NO_LATE_FEE', 'This instalment has no late fee.');
  const newDue = toCents(inst.amountDue) - toCents(inst.lateFee);
  if (toCents(inst.amountPaid || 0) > newDue) throw conflict('FEE_ALREADY_PAID', 'Part of this late fee is already paid, so it cannot be waived.');
  const waiver = { amount: inst.lateFee, reason, by: user.id, byName: user.name, at: new Date().toISOString() };
  await repo.updateInstalment(planId, seq, { lateFee: 0, amountDue: fromCents(newDue), lateFeeWaived: waiver });
  Object.assign(inst, { lateFee: 0, amountDue: fromCents(newDue), lateFeeWaived: waiver });
  const current = await syncCompletion(plan, instalments);
  await publish('LateFeeWaived', { planId, ownerId: plan.ownerId, seq, amount: waiver.amount, reason });
  return planView(current, instalments);
}

async function getPayoffQuote(user, planId) {
  const plan = await loadPlan(planId);
  if (user) assertCanAccess(user, plan.ownerId);
  if (plan.status !== STATUS.ACTIVE) throw conflict('PLAN_NOT_ACTIVE', 'Only an active plan can be paid off.');
  return payoffQuote(await viewOf(plan));
}

// Called by Payments when a payoff payment is accepted: waives the future interest so the
// remaining balance becomes exactly the quoted amount. Refuses if the quote changed meanwhile.
async function settlePayoff(planId, expectedAmount) {
  const plan = await loadPlan(planId);
  if (plan.status !== STATUS.ACTIVE) throw conflict('PLAN_NOT_ACTIVE', 'Only an active plan can be paid off.');
  const view = await viewOf(plan);
  const quote = payoffQuote(view);
  if (toCents(quote.payoffAmount) !== toCents(expectedAmount)) {
    throw conflict('QUOTE_CHANGED', `The payoff amount is now ${quote.payoffAmount.toFixed(2)} (it was ${Number(expectedAmount).toFixed(2)}). Please submit a new payoff.`);
  }
  for (const line of quote.lines) {
    if (!line.interestWaived) continue;
    const inst = view.instalments.find((i) => i.seq === line.seq);
    await repo.updateInstalment(planId, line.seq, {
      interest: fromCents(toCents(inst.interest) - toCents(line.interestWaived)),
      amountDue: fromCents(toCents(inst.amountDue) - toCents(line.interestWaived)),
      interestWaived: line.interestWaived
    });
  }
  const saved = await repo.updatePlan(planId, { payoffSettledOn: quote.asOf, interestSaved: quote.interestSaved, updatedAt: new Date().toISOString() }) || plan;
  return viewOf(saved);
}

module.exports = {
  STATUS, createPlan, getPlanFor, searchPlans, updatePlan, changeStatus, deletePlan,
  internalGet, internalList, setPaidAmounts, assessLateFees, waiveLateFee, getPayoffQuote, settlePayoff
};
