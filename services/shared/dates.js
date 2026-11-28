// Date helpers. All due dates are plain calendar dates (YYYY-MM-DD), no time of day.
// "Today" is taken in the app's time zone (Africa/Cairo by default).

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Africa/Cairo';

function today(timeZone = APP_TIMEZONE) {
  // en-CA formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

const toUtc = (iso) => new Date(`${iso}T00:00:00Z`);
const toIso = (date) => date.toISOString().slice(0, 10);

function addDays(iso, days) {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

// Adds months and keeps the day of the month where possible.
// 31 Jan + 1 month = 28 Feb (or 29 in a leap year), never 3 March.
function addMonths(iso, months) {
  const d = toUtc(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target);
}

// Whole days from a to b (positive when b is later).
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);

const monthOf = (iso) => iso.slice(0, 7);

module.exports = { today, addDays, addMonths, daysBetween, monthOf, APP_TIMEZONE };
