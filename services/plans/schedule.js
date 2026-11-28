// Each instalment = principal + interest + lateFee = amountDue.
// Inside one instalment, money pays the late fee first, then the interest, then the principal.
const { toCents, fromCents } = require('../shared/money');
const { addDays, addMonths, daysBetween, today } = require('../shared/dates');

const FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY'];
const INTEREST_METHODS = ['REDUCING', 'FLAT'];
const PERIODS_PER_YEAR = { WEEKLY: 52, BIWEEKLY: 26, MONTHLY: 12 };

function dueDateAt(firstDue, frequency, index) {
  if (frequency === 'WEEKLY') return addDays(firstDue, 7 * index);
  if (frequency === 'BIWEEKLY') return addDays(firstDue, 14 * index);
  return addMonths(firstDue, index); // keeps the day: 31 Jan -> 28 Feb -> 31 Mar
}

// Splits cents into `count` equal parts, remainder on the last one (sum is always exact)
function split(cents, count) {
  const base = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? cents - base * (count - 1) : base));
}

// Interest + principal per instalment, in cents.
//  0 %       -> equal principal parts, no interest
//  FLAT      -> interest = principal × rate × years, spread evenly (simple, used by many shops)
//  REDUCING  -> standard amortised loan: equal payments, interest on the balance left each period
function amortise(principalCents, count, frequency, annualRate, method) {
  const ppy = PERIODS_PER_YEAR[frequency];
  if (!annualRate) return split(principalCents, count).map((p) => ({ principal: p, interest: 0 }));

  if (method === 'FLAT') {
    const interestCents = Math.round(principalCents * (annualRate / 100) * (count / ppy));
    const p = split(principalCents, count);
    const i = split(interestCents, count);
    return p.map((principal, k) => ({ principal, interest: i[k] }));
  }

  const r = annualRate / 100 / ppy;
  const payment = Math.round((principalCents * r) / (1 - (1 + r) ** -count));
  const rows = [];
  let balance = principalCents;
  for (let k = 0; k < count; k++) {
    const interest = Math.round(balance * r);
    const principal = k === count - 1 ? balance : Math.min(balance, payment - interest);
    rows.push({ principal, interest });
    balance -= principal;
  }
  return rows;
}

function buildInstalments({ amount, count, frequency, firstDue, firstSeq = 1, annualRate = 0, interestMethod = 'REDUCING' }) {
  return amortise(toCents(amount), count, frequency, annualRate, interestMethod).map((row, i) => ({
    seq: firstSeq + i,
    dueDate: dueDateAt(firstDue, frequency, i),
    principal: fromCents(row.principal),
    interest: fromCents(row.interest),
    lateFee: 0,
    amountDue: fromCents(row.principal + row.interest),
    amountPaid: 0
  }));
}

// Older records (before interest existed) only have amountDue: treat it all as principal
const parts = (inst) => ({
  principal: toCents(inst.principal ?? (inst.amountDue - (inst.lateFee || 0) - (inst.interest || 0))),
  interest: toCents(inst.interest || 0),
  lateFee: toCents(inst.lateFee || 0),
  paid: toCents(inst.amountPaid || 0)
});

// How the money paid into one instalment is split: fee first, then interest, then principal
function paidSplit(inst) {
  const p = parts(inst);
  const toFee = Math.min(p.paid, p.lateFee);
  const toInterest = Math.min(p.paid - toFee, p.interest);
  const toPrincipal = Math.min(p.paid - toFee - toInterest, p.principal);
  return { ...p, toFee, toInterest, toPrincipal };
}

function instalmentStatus(inst, asOf = today()) {
  const due = toCents(inst.amountDue);
  const paid = toCents(inst.amountPaid || 0);
  if (paid >= due) return 'PAID';
  if (inst.dueDate < asOf) return 'OVERDUE';
  if (paid > 0) return 'PARTIAL';
  return 'UNPAID';
}

// Everything the API shows about a plan: balance, interest, fees, progress, next due date.
// Balances are never stored; they are recalculated here every time.
function planView(plan, instalments, asOf = today()) {
  const sorted = [...instalments].sort((a, b) => a.seq - b.seq);
  const items = sorted.map((inst) => ({
    ...inst,
    principal: inst.principal ?? fromCents(parts(inst).principal),
    interest: inst.interest || 0,
    lateFee: inst.lateFee || 0,
    amountRemaining: fromCents(toCents(inst.amountDue) - toCents(inst.amountPaid || 0)),
    status: instalmentStatus(inst, asOf),
    daysLate: inst.dueDate < asOf && toCents(inst.amountPaid || 0) < toCents(inst.amountDue) ? daysBetween(inst.dueDate, asOf) : 0
  }));
  const sum = (fn) => items.reduce((t, i) => t + fn(i), 0);
  const dueCents = sum((i) => toCents(i.amountDue));
  const paidCents = sum((i) => toCents(i.amountPaid || 0));
  const next = items.find((i) => i.status !== 'PAID');
  const count = (status) => items.filter((i) => i.status === status).length;
  const overdueCount = count('OVERDUE');
  const principalLeft = sum((i) => { const s = paidSplit(i); return s.principal - s.toPrincipal; });

  return {
    ...plan,
    annualRate: plan.annualRate || 0,
    interestMethod: plan.interestMethod || 'NONE',
    financedAmount: fromCents(toCents(plan.totalAmount) - toCents(plan.downPayment || 0)),
    totalInterest: fromCents(sum((i) => toCents(i.interest))),
    totalLateFees: fromCents(sum((i) => toCents(i.lateFee))),
    totalRepayable: fromCents(dueCents),
    paidAmount: fromCents(paidCents + toCents(plan.downPayment || 0)),
    paidInstalmentsAmount: fromCents(paidCents),
    remainingAmount: fromCents(dueCents - paidCents),
    principalRemaining: fromCents(principalLeft),
    progressPercent: dueCents > 0 ? Math.floor((paidCents / dueCents) * 100) : 100,
    counts: { paid: count('PAID'), partial: count('PARTIAL'), unpaid: count('UNPAID'), overdue: overdueCount },
    isOverdue: plan.status === 'ACTIVE' && overdueCount > 0,
    maxDaysLate: Math.max(0, ...items.map((i) => i.daysLate)),
    nextDue: plan.status === 'ACTIVE' && next
      ? { seq: next.seq, dueDate: next.dueDate, amountRemaining: next.amountRemaining }
      : null,
    instalments: items
  };
}

// Rebuilds the unpaid part of a schedule. Instalments that already received money are locked;
// the principal still owed on the others is re-amortised over the new number of instalments.
function reschedule({ plan, instalments, newCount, newFrequency }) {
  const sorted = [...instalments].sort((a, b) => a.seq - b.seq);
  const locked = sorted.filter((i) => toCents(i.amountPaid || 0) > 0);
  const lockedSeqs = new Set(locked.map((i) => i.seq));
  const unlocked = sorted.filter((i) => !lockedSeqs.has(i.seq));
  if (unlocked.some((i) => toCents(i.lateFee || 0) > 0)) {
    return { error: 'An unpaid instalment has a late fee. Pay it (or ask an admin to waive it) before rescheduling.' };
  }
  const leftCents = unlocked.reduce((t, i) => t + parts(i).principal, 0);
  const newPartCount = newCount - locked.length;
  if (leftCents > 0 && newPartCount < 1) {
    return { error: `instalmentCount must be at least ${locked.length + 1}, because ${locked.length} instalment(s) already have payments.` };
  }
  if (leftCents > 0 && leftCents / newPartCount < 100) return { error: 'Each new instalment must be at least 1.00.' };
  const firstDue = unlocked.length ? unlocked[0].dueDate : dueDateAt(locked[locked.length - 1].dueDate, newFrequency, 1);
  const fresh = leftCents > 0
    ? buildInstalments({
      amount: fromCents(leftCents), count: newPartCount, frequency: newFrequency, firstDue,
      firstSeq: locked.length + 1, annualRate: plan.annualRate || 0, interestMethod: plan.interestMethod
    })
    : [];
  return { locked, removed: unlocked, fresh };
}

// policy: { graceDays: 0-30, type: 'FIXED' | 'PERCENT', value }  (PERCENT = % of what is still unpaid)
// One fee per instalment, charged once it is more than graceDays late and still not fully paid.
function lateFeesDue(plan, instalments, asOf) {
  const policy = plan.lateFeePolicy;
  if (!policy || !policy.value || plan.status !== 'ACTIVE') return [];
  const fees = [];
  for (const inst of instalments) {
    if (toCents(inst.lateFee || 0) > 0) continue;
    const remaining = toCents(inst.amountDue) - toCents(inst.amountPaid || 0);
    if (remaining <= 0) continue;
    const daysLate = daysBetween(inst.dueDate, asOf);
    if (daysLate <= policy.graceDays) continue;
    const feeCents = policy.type === 'PERCENT' ? Math.round((remaining * policy.value) / 100) : toCents(policy.value);
    if (feeCents > 0) fees.push({ seq: inst.seq, dueDate: inst.dueDate, daysLate, fee: fromCents(feeCents) });
  }
  return fees;
}

// Paying everything today: instalments already due are owed in full; for future ones only the
// principal is owed, so their unpaid interest is waived. Returns the amount and the saving.
function payoffQuote(planViewed, asOf = today()) {
  let owedCents = 0;
  let waivedCents = 0;
  const lines = [];
  for (const inst of planViewed.instalments) {
    const remaining = toCents(inst.amountDue) - toCents(inst.amountPaid || 0);
    if (remaining <= 0) continue;
    if (inst.dueDate <= asOf) {
      owedCents += remaining;
      lines.push({ seq: inst.seq, owed: fromCents(remaining), interestWaived: 0 });
    } else {
      const s = paidSplit(inst);
      const waived = s.interest - s.toInterest;
      owedCents += remaining - waived;
      waivedCents += waived;
      lines.push({ seq: inst.seq, owed: fromCents(remaining - waived), interestWaived: fromCents(waived) });
    }
  }
  return {
    planId: planViewed.planId, asOf, validOn: asOf,
    payoffAmount: fromCents(owedCents),
    interestSaved: fromCents(waivedCents),
    remainingIfNotPaidOff: planViewed.remainingAmount,
    lines
  };
}

module.exports = {
  FREQUENCIES, INTEREST_METHODS, PERIODS_PER_YEAR, dueDateAt, buildInstalments, instalmentStatus,
  planView, reschedule, lateFeesDue, payoffQuote, paidSplit
};
