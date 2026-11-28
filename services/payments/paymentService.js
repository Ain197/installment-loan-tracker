// Payment status:
//   recorded by an ADMIN -> VERIFIED at once
//   recorded by a USER   -> PENDING -> VERIFIED (admin approves, receipt required)
//                                  -> REJECTED (admin, with a reason)
//                                  -> WITHDRAWN (the customer cancels it)
//   VERIFIED -> reversed (admin, within 24 h)
// Only VERIFIED, not reversed payments count towards the balance. Plans owns the instalments;
// this service works out how much of each is paid and sends that to Plans.
const { randomUUID } = require('crypto');
const repo = require('./repository');
const receipts = require('./receipts');
const { allocate } = require('./allocation');
const { toCents, fromCents } = require('../shared/money');
const { today, addDays, monthOf, addMonths: addMonthsIso } = require('../shared/dates');
const { isAdmin, assertCanAccess } = require('../shared/auth');
const { badRequest, notFound, conflict, forbidden } = require('../shared/errors');
const { callService } = require('../shared/serviceClient');
const { publish } = require('../shared/events');
const { putMetrics } = require('../shared/metrics');

const METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_WALLET', 'OTHER'];
const STATUS = { PENDING: 'PENDING', VERIFIED: 'VERIFIED', REJECTED: 'REJECTED', WITHDRAWN: 'WITHDRAWN' };
const REVERSAL_WINDOW_HOURS = 24;

const enc = encodeURIComponent;
const getPlan = async (planId) => (await callService('plans', 'GET', `/internal/plans/${enc(planId)}`)).plan;
const listPlans = async (query) => (await callService('plans', 'GET', `/internal/plans?${new URLSearchParams(query)}`)).plans;
const getQuote = async (planId) => (await callService('plans', 'GET', `/internal/plans/${enc(planId)}/payoff-quote`)).quote;
const settlePayoff = async (planId, expectedAmount) =>
  (await callService('plans', 'POST', `/internal/plans/${enc(planId)}/payoff-settlements`, { expectedAmount })).plan;
const savePaidAmounts = async (planId, paid) =>
  (await callService('plans', 'PUT', `/internal/plans/${enc(planId)}/paid-amounts`, { paid })).plan;

// Payments saved before the approval workflow have no status: they count as VERIFIED
const statusOf = (p) => p.status || STATUS.VERIFIED;
const counts = (p) => statusOf(p) === STATUS.VERIFIED && !p.reversed;
const validPayments = async (planId) => (await repo.listByPlan(planId)).filter(counts);
const pendingTotal = (payments) => payments.filter((p) => statusOf(p) === STATUS.PENDING).reduce((t, p) => t + toCents(p.amount), 0);

const balanceOf = (plan) => ({
  planId: plan.planId,
  title: plan.title,
  status: plan.status,
  totalAmount: plan.totalAmount,
  downPayment: plan.downPayment,
  financedAmount: plan.financedAmount,
  totalInterest: plan.totalInterest,
  totalLateFees: plan.totalLateFees,
  totalRepayable: plan.totalRepayable,
  paidAmount: plan.paidAmount,
  remainingAmount: plan.remainingAmount,
  principalRemaining: plan.principalRemaining,
  progressPercent: plan.progressPercent,
  counts: plan.counts,
  isOverdue: plan.isOverdue,
  nextDue: plan.nextDue
});

function checkDate(paidOn) {
  if (paidOn > today()) throw badRequest('The payment date cannot be in the future.', [{ field: 'paidOn', message: 'paidOn cannot be in the future.' }]);
  if (paidOn < addDays(today(), -365)) throw badRequest('The payment date is too old.', [{ field: 'paidOn', message: 'paidOn cannot be more than 1 year ago.' }]);
}

function checkActive(plan) {
  if (plan.status !== 'ACTIVE') {
    throw conflict('PLAN_NOT_ACTIVE', plan.status === 'COMPLETED' ? 'This plan is already fully paid.' : 'This plan is cancelled, so it cannot take payments.');
  }
}

// Re-allocates every counting payment (plus `extra`, if given) over the instalments and saves
// the result in Plans. Returns the updated plan and each payment's new allocation.
async function applyAllocation(plan, extra) {
  const all = [...(await validPayments(plan.planId)), ...(extra ? [extra] : [])];
  const result = allocate(plan.instalments, all);
  if (result.unused > 0) throw badRequest('The amount is more than the remaining balance.', [{ field: 'amount', message: 'Too much.' }]);
  const updatedPlan = await savePaidAmounts(plan.planId, result.paid);
  for (const p of all) {
    if (extra && p.paymentId === extra.paymentId) continue;
    const applied = result.appliedTo[p.paymentId];
    if (JSON.stringify(applied) !== JSON.stringify(p.appliedTo)) await repo.updatePayment(p.paymentId, { appliedTo: applied });
  }
  return { updatedPlan, appliedTo: result.appliedTo };
}

async function announceVerified(payment, plan, updatedPlan) {
  await publish('PaymentRecorded', {
    paymentId: payment.paymentId, planId: plan.planId, ownerId: plan.ownerId, ownerEmail: plan.ownerEmail, ownerName: plan.ownerName,
    title: plan.title, amount: payment.amount, paidOn: payment.paidOn, kind: payment.kind, appliedTo: payment.appliedTo,
    remainingAmount: updatedPlan.remainingAmount, planCompleted: updatedPlan.status === 'COMPLETED'
  });
  await putMetrics({ PaymentsVerified: 1, PaymentsAmount: payment.amount });
}

async function recordPayment(user, planId, { amount, paidOn, method, note }) {
  const plan = await getPlan(planId);
  assertCanAccess(user, plan.ownerId);
  checkActive(plan);
  checkDate(paidOn);
  const pending = pendingTotal(await repo.listByPlan(planId));
  const available = toCents(plan.remainingAmount) - pending;
  if (toCents(amount) > available) {
    const extra = pending ? ` (${fromCents(pending).toFixed(2)} is already waiting for approval)` : '';
    throw badRequest(`The amount is more than what is left to pay: ${fromCents(available).toFixed(2)}${extra}.`,
      [{ field: 'amount', message: `amount cannot be more than ${fromCents(available).toFixed(2)}.` }]);
  }
  const payment = newPayment(user, plan, { amount, paidOn, method, note, kind: 'REGULAR' });
  return isAdmin(user) ? verifyNow(payment, plan) : submitForApproval(payment, plan);
}

function newPayment(user, plan, { amount, paidOn, method, note, kind, quote }) {
  return {
    paymentId: randomUUID(), planId: plan.planId, ownerId: plan.ownerId, planTitle: plan.title, ownerName: plan.ownerName,
    amount, paidOn, method, note: note || '', kind, ...(quote ? { payoffQuote: quote } : {}),
    status: isAdmin(user) ? STATUS.VERIFIED : STATUS.PENDING,
    reversed: false, appliedTo: [],
    recordedBy: user.id, recordedByName: user.name, recordedByRole: user.role,
    createdAt: new Date().toISOString()
  };
}

async function verifyNow(payment, plan, reviewer) {
  if (payment.kind === 'PAYOFF') plan = await settlePayoff(plan.planId, payment.amount);
  const { updatedPlan, appliedTo } = await applyAllocation(plan, payment);
  payment.appliedTo = appliedTo[payment.paymentId];
  payment.status = STATUS.VERIFIED;
  if (reviewer) Object.assign(payment, { verifiedBy: reviewer.id, verifiedByName: reviewer.name, verifiedAt: new Date().toISOString() });
  try {
    if (reviewer) {
      const saved = await repo.updatePayment(payment.paymentId,
        { status: STATUS.VERIFIED, appliedTo: payment.appliedTo, verifiedBy: reviewer.id, verifiedByName: reviewer.name, verifiedAt: payment.verifiedAt },
        'attribute_exists(paymentId) AND #st = :pending', { ':pending': STATUS.PENDING }, { '#st': 'status' });
      if (!saved) throw conflict('NOT_PENDING', 'This payment was already reviewed.');
    } else {
      await repo.putPayment(payment);
    }
  } catch (error) {
    // put the plan back as it was before this payment
    await savePaidAmounts(plan.planId, plan.instalments.map((i) => ({ seq: i.seq, amountPaid: i.amountPaid })));
    throw error;
  }
  await announceVerified(payment, plan, updatedPlan);
  const message = updatedPlan.status === 'COMPLETED'
    ? 'Payment recorded. This plan is now fully paid!'
    : `Payment recorded. Remaining balance: ${updatedPlan.remainingAmount.toFixed(2)}.`;
  return { payment, balance: balanceOf(updatedPlan), message };
}

async function submitForApproval(payment, plan) {
  await repo.putPayment(payment);
  await publish('PaymentSubmitted', { paymentId: payment.paymentId, planId: plan.planId, ownerId: plan.ownerId, title: plan.title, amount: payment.amount });
  await putMetrics({ PaymentsSubmitted: 1 });
  return {
    payment,
    balance: balanceOf(plan),
    message: 'Payment submitted. Upload the receipt; it counts once an admin verifies it.'
  };
}

async function getPayoffQuote(user, planId) {
  const plan = await getPlan(planId);
  assertCanAccess(user, plan.ownerId);
  checkActive(plan);
  return getQuote(planId);
}

async function payOff(user, planId, { paidOn, method, note }) {
  const plan = await getPlan(planId);
  assertCanAccess(user, plan.ownerId);
  checkActive(plan);
  checkDate(paidOn);
  if (pendingTotal(await repo.listByPlan(planId)) > 0) {
    throw conflict('PAYMENT_PENDING', 'A payment for this plan is waiting for approval. Wait for it (or withdraw it) before paying off.');
  }
  const quote = await getQuote(planId);
  const payment = newPayment(user, plan, {
    amount: quote.payoffAmount, paidOn, method, note: note || 'Early payoff', kind: 'PAYOFF',
    quote: { amount: quote.payoffAmount, interestSaved: quote.interestSaved, quotedOn: quote.asOf }
  });
  return isAdmin(user) ? verifyNow(payment, plan) : submitForApproval(payment, plan);
}

async function listPending() {
  const pending = await repo.listByStatus(STATUS.PENDING);
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function review(user, paymentId, { decision, reason }) {
  if (!isAdmin(user)) throw forbidden('Only an admin can verify payments.');
  const payment = await repo.getPayment(paymentId);
  if (!payment) throw notFound('Payment');
  if (statusOf(payment) !== STATUS.PENDING) throw conflict('NOT_PENDING', `This payment is ${statusOf(payment).toLowerCase()}, not waiting for approval.`);

  if (decision === 'REJECT') {
    const updated = await repo.updatePayment(paymentId,
      { status: STATUS.REJECTED, rejectionReason: reason, verifiedBy: user.id, verifiedByName: user.name, verifiedAt: new Date().toISOString() },
      'attribute_exists(paymentId) AND #st = :pending', { ':pending': STATUS.PENDING }, { '#st': 'status' });
    if (!updated) throw conflict('NOT_PENDING', 'This payment was already reviewed.');
    const plan = await getPlan(payment.planId);
    await publish('PaymentRejected', {
      paymentId, planId: payment.planId, ownerId: payment.ownerId, ownerEmail: plan.ownerEmail, ownerName: plan.ownerName,
      title: plan.title, amount: payment.amount, paidOn: payment.paidOn, reason
    });
    await putMetrics({ PaymentsRejected: 1 });
    return { payment: updated, balance: balanceOf(plan), message: 'Payment rejected. The customer will get an email with the reason.' };
  }

  if (!payment.receipt) throw conflict('RECEIPT_REQUIRED', 'A receipt is required before a customer payment can be verified.');
  const plan = await getPlan(payment.planId);
  checkActive(plan);
  if (payment.kind !== 'PAYOFF' && toCents(payment.amount) > toCents(plan.remainingAmount)) {
    throw conflict('AMOUNT_TOO_HIGH', `Only ${plan.remainingAmount.toFixed(2)} is left on this plan. Reject this payment and ask for a new one.`);
  }
  return verifyNow(payment, plan, user);
}

async function withdraw(user, paymentId) {
  const payment = await repo.getPayment(paymentId);
  if (!payment) throw notFound('Payment');
  assertCanAccess(user, payment.ownerId);
  if (statusOf(payment) !== STATUS.PENDING) throw conflict('NOT_PENDING', 'Only a payment waiting for approval can be withdrawn.');
  await repo.updatePayment(paymentId, { status: STATUS.WITHDRAWN, withdrawnAt: new Date().toISOString() });
}

async function getBalance(user, planId) {
  const plan = await getPlan(planId);
  assertCanAccess(user, plan.ownerId);
  const all = await repo.listByPlan(planId);
  const valid = all.filter(counts);
  return {
    ...balanceOf(plan),
    paymentsCount: valid.length,
    lastPaymentOn: valid.map((p) => p.paidOn).sort().pop() || null,
    pendingAmount: fromCents(pendingTotal(all)),
    pendingCount: all.filter((p) => statusOf(p) === STATUS.PENDING).length
  };
}

async function getSummary(user) {
  const plans = await listPlans(isAdmin(user) ? {} : { ownerId: user.id });
  const thisMonth = monthOf(today());
  // Unpaid amounts for this month and the next 5 (overdue money counts in this month)
  const months = Array.from({ length: 6 }, (_, i) => monthOf(addMonthsIso(today(), i)));
  const byMonth = Object.fromEntries(months.map((m) => [m, 0]));
  let dueThisMonth = 0; let overdueCents = 0; let remainingCents = 0; let overdueInstalments = 0; let feesCents = 0;
  const perPlan = plans.map((plan) => {
    if (plan.status === 'ACTIVE') {
      remainingCents += toCents(plan.remainingAmount);
      feesCents += toCents(plan.totalLateFees || 0);
      for (const inst of plan.instalments) {
        if (inst.status === 'PAID') continue;
        if (inst.status === 'OVERDUE') { overdueCents += toCents(inst.amountRemaining); overdueInstalments += 1; }
        if (monthOf(inst.dueDate) === thisMonth) dueThisMonth += toCents(inst.amountRemaining);
        const m = inst.status === 'OVERDUE' ? thisMonth : monthOf(inst.dueDate);
        if (m in byMonth) byMonth[m] += toCents(inst.amountRemaining);
      }
    }
    return {
      planId: plan.planId, title: plan.title, provider: plan.provider, ownerName: plan.ownerName,
      status: plan.status, remainingAmount: plan.remainingAmount, progressPercent: plan.progressPercent,
      annualRate: plan.annualRate || 0, nextDue: plan.nextDue, isOverdue: plan.isOverdue,
      ribbon: plan.instalments.map((i) => i.status)
    };
  });
  const pending = isAdmin(user) ? (await listPending()).length : undefined;
  return {
    month: thisMonth,
    activePlans: plans.filter((p) => p.status === 'ACTIVE').length,
    completedPlans: plans.filter((p) => p.status === 'COMPLETED').length,
    totalRemaining: fromCents(remainingCents),
    dueThisMonth: fromCents(dueThisMonth),
    overdueAmount: fromCents(overdueCents),
    overdueInstalments,
    lateFeesCharged: fromCents(feesCents),
    dueByMonth: months.map((m) => ({ month: m, amount: fromCents(byMonth[m]) })),
    ...(pending !== undefined ? { pendingApprovals: pending } : {}),
    plans: perPlan.sort((a, b) => (a.nextDue ? a.nextDue.dueDate : '9999').localeCompare(b.nextDue ? b.nextDue.dueDate : '9999'))
  };
}

async function listPayments(user, planId, { from, to, method, status, includeReversed }) {
  const plan = await getPlan(planId);
  assertCanAccess(user, plan.ownerId);
  const payments = (await repo.listByPlan(planId))
    .map((p) => ({ ...p, status: statusOf(p) }))
    .filter((p) => (includeReversed || !p.reversed) && (!status || p.status === status) &&
      (!from || p.paidOn >= from) && (!to || p.paidOn <= to) && (!method || p.method === method))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const total = fromCents(payments.filter(counts).reduce((t, p) => t + toCents(p.amount), 0));
  return { payments, count: payments.length, total };
}

async function loadPaymentFor(user, paymentId) {
  const payment = await repo.getPayment(paymentId);
  if (!payment) throw notFound('Payment');
  assertCanAccess(user, payment.ownerId);
  return payment;
}

async function attachReceipt(user, paymentId, file) {
  const payment = await loadPaymentFor(user, paymentId);
  if (payment.reversed) throw conflict('PAYMENT_REVERSED', 'This payment was reversed.');
  if ([STATUS.REJECTED, STATUS.WITHDRAWN].includes(statusOf(payment))) throw conflict('PAYMENT_CLOSED', `This payment was ${statusOf(payment).toLowerCase()}.`);
  const decoded = receipts.decodeReceipt(file);
  const saved = await receipts.saveReceipt(payment.planId, paymentId, decoded);
  return repo.updatePayment(paymentId, {
    receipt: { key: saved.key, fileName: decoded.safeName, contentType: decoded.contentType, size: saved.size, uploadedAt: new Date().toISOString() }
  });
}

async function getReceipt(user, paymentId) {
  const payment = await loadPaymentFor(user, paymentId);
  if (!payment.receipt) throw notFound('Receipt');
  const file = await receipts.loadReceipt(payment.receipt.key);
  return { fileName: payment.receipt.fileName, contentType: payment.receipt.contentType || file.contentType, dataBase64: file.dataBase64 };
}

async function reversePayment(user, paymentId, reason) {
  if (!isAdmin(user)) throw forbidden('Only an admin can reverse a payment.');
  const payment = await repo.getPayment(paymentId);
  if (!payment) throw notFound('Payment');
  if (payment.reversed) throw conflict('ALREADY_REVERSED', 'This payment was already reversed.');
  if (statusOf(payment) !== STATUS.VERIFIED) throw conflict('NOT_VERIFIED', 'Only a verified payment can be reversed.');
  if (payment.kind === 'PAYOFF') throw conflict('PAYOFF_FINAL', 'An early payoff cannot be reversed, because its waived interest is already settled.');
  const ageHours = (Date.now() - Date.parse(payment.verifiedAt || payment.createdAt)) / 3_600_000;
  if (ageHours > REVERSAL_WINDOW_HOURS) {
    throw conflict('REVERSAL_WINDOW_PASSED', `Payments can only be reversed within ${REVERSAL_WINDOW_HOURS} hours of being recorded.`);
  }
  const plan = await getPlan(payment.planId);
  if (plan.status === 'CANCELLED') throw conflict('PLAN_NOT_ACTIVE', 'This plan is cancelled.');

  const reversed = await repo.updatePayment(paymentId,
    { reversed: true, reversedAt: new Date().toISOString(), reversedBy: user.id, reversalReason: reason },
    'attribute_exists(paymentId) AND reversed = :no', { ':no': false });
  if (!reversed) throw conflict('ALREADY_REVERSED', 'This payment was already reversed.');

  const { updatedPlan } = await applyAllocation(plan);
  await publish('PaymentReversed', { paymentId, planId: payment.planId, ownerId: payment.ownerId, amount: payment.amount, reason });
  return { payment: reversed, balance: balanceOf(updatedPlan) };
}

module.exports = {
  METHODS, STATUS, recordPayment, getPayoffQuote, payOff, listPending, review, withdraw,
  getBalance, getSummary, listPayments, attachReceipt, getReceipt, reversePayment
};
