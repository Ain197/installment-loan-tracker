// Money is calculated in whole piastres (cents) so 0.1 + 0.2 problems never happen.
// Amounts are stored and returned as normal numbers with 2 decimals (e.g. 333.33).

const toCents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (cents) => Math.round(cents) / 100;
const sum = (amounts) => fromCents(amounts.reduce((total, a) => total + toCents(a), 0));

module.exports = { toCents, fromCents, sum };
