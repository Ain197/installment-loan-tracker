// Collects every validation problem so the client sees them all at once.
const { badRequest } = require('./errors');

function createChecker(body) {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const problems = [];
  const add = (field, message) => problems.push({ field, message });

  return {
    data,
    problems,
    add,

    text(field, { required = true, min = 1, max = 200 } = {}) {
      const value = data[field];
      if (value === undefined || value === null || value === '') {
        if (required) add(field, `${field} is required.`);
        return undefined;
      }
      if (typeof value !== 'string') { add(field, `${field} must be text.`); return undefined; }
      const trimmed = value.trim();
      if (trimmed.length < min) add(field, `${field} must be at least ${min} characters.`);
      else if (trimmed.length > max) add(field, `${field} must be at most ${max} characters.`);
      return trimmed;
    },

    number(field, { required = true, min, max, integer = false, decimals } = {}) {
      const value = data[field];
      if (value === undefined || value === null || value === '') {
        if (required) add(field, `${field} is required.`);
        return undefined;
      }
      const num = typeof value === 'string' ? Number(value) : value;
      if (typeof num !== 'number' || !Number.isFinite(num)) { add(field, `${field} must be a number.`); return undefined; }
      if (integer && !Number.isInteger(num)) { add(field, `${field} must be a whole number.`); return undefined; }
      const scaled = decimals === undefined ? 0 : num * 10 ** decimals;
      if (decimals !== undefined && Math.abs(scaled - Math.round(scaled)) > 1e-6) {
        add(field, `${field} can have at most ${decimals} decimal places.`); return undefined;
      }
      if (min !== undefined && num < min) { add(field, `${field} must be at least ${min}.`); return undefined; }
      if (max !== undefined && num > max) { add(field, `${field} must be at most ${max}.`); return undefined; }
      return num;
    },

    oneOf(field, allowed, { required = true } = {}) {
      const value = data[field];
      if (value === undefined || value === null || value === '') {
        if (required) add(field, `${field} is required.`);
        return undefined;
      }
      if (!allowed.includes(value)) { add(field, `${field} must be one of: ${allowed.join(', ')}.`); return undefined; }
      return value;
    },

    date(field, { required = true } = {}) {
      const value = data[field];
      if (value === undefined || value === null || value === '') {
        if (required) add(field, `${field} is required.`);
        return undefined;
      }
      if (!isIsoDate(value)) { add(field, `${field} must be a date in the form YYYY-MM-DD.`); return undefined; }
      return value;
    },

    email(field, { required = true } = {}) {
      const value = this.text(field, { required, max: 254 });
      if (value === undefined) return undefined;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { add(field, `${field} must be a valid email address.`); return undefined; }
      return value.toLowerCase();
    },

    boolean(field, { required = true } = {}) {
      const value = data[field];
      if (value === undefined || value === null) {
        if (required) add(field, `${field} is required.`);
        return undefined;
      }
      if (typeof value !== 'boolean') { add(field, `${field} must be true or false.`); return undefined; }
      return value;
    },

    // Throws one 400 error listing every problem found so far.
    done(message = 'Some fields are missing or invalid.') {
      if (problems.length) throw badRequest(message, problems);
    }
  };
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

module.exports = { createChecker, isIsoDate };
