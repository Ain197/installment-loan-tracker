// Money always goes to the oldest unpaid instalment first; anything extra rolls over to the next one.
// The allocation is rebuilt from all valid payments each time, so a reversal is just a rebuild.
const { toCents, fromCents } = require('../shared/money');

function allocate(instalments, payments) {
  const slots = [...instalments]
    .sort((a, b) => a.seq - b.seq)
    .map((i) => ({ seq: i.seq, dueCents: toCents(i.amountDue), paidCents: 0 }));
  const appliedTo = {};
  let unusedCents = 0;

  const ordered = [...payments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const payment of ordered) {
    let left = toCents(payment.amount);
    appliedTo[payment.paymentId] = [];
    for (const slot of slots) {
      if (left === 0) break;
      const room = slot.dueCents - slot.paidCents;
      if (room <= 0) continue;
      const take = Math.min(room, left);
      slot.paidCents += take;
      left -= take;
      appliedTo[payment.paymentId].push({ seq: slot.seq, amount: fromCents(take) });
    }
    unusedCents += left;
  }

  return {
    paid: slots.map((s) => ({ seq: s.seq, amountPaid: fromCents(s.paidCents) })),
    appliedTo,
    unused: fromCents(unusedCents) // > 0 would mean more money than the plan owes
  };
}

module.exports = { allocate };
