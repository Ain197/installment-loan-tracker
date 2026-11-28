
// Everything a user typed is escaped before it goes into HTML (never shown as HTML).
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = (n) => `EGP ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyShort = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : Math.round(n).toString());

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function relDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n > 1) return `in ${n} days`;
  if (n === -1) return '1 day late';
  return `${-n} days late`;
}

const LABELS = {
  WEEKLY: 'Weekly', BIWEEKLY: 'Every 2 weeks', MONTHLY: 'Monthly',
  DUE_SOON: 'Due soon', OVERDUE: 'Overdue', PAYMENT_CONFIRMED: 'Payment confirmed', PLAN_COMPLETED: 'Plan completed',
  BANK_TRANSFER: 'Bank transfer', MOBILE_WALLET: 'Mobile wallet', CASH: 'Cash', CARD: 'Card', OTHER: 'Other',
  LATE_FEE: 'Late fee', PAYMENT_REJECTED: 'Payment rejected', ESCALATION: 'Escalation',
  PENDING: 'Waiting for approval', VERIFIED: 'Verified', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn',
  REDUCING: 'Reducing balance', FLAT: 'Flat rate', NONE: 'No interest', PAYOFF: 'Early payoff', REGULAR: 'Payment'
};
const label = (v) => LABELS[v] || (v ? v.charAt(0) + v.slice(1).toLowerCase() : '');
const badge = (status, text) => `<span class="badge ${esc(status)}">${esc(text || label(status))}</span>`;
const progressBar = (pct) => `<div class="progress" title="${pct}% paid"><span style="width:${Math.min(100, Math.max(0, pct))}%"></span></div>`;

function toast(message, type = 'ok') {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
}

// Shows the API's field messages under the matching inputs, plus a toast with the main message.
function showError(err, form) {
  if (form) clearErrors(form);
  const unplaced = [];
  for (const d of (err.details || [])) {
    const input = form && form.querySelector(`[name="${d.field}"]`);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      const msg = document.createElement('div');
      msg.className = 'field-error';
      msg.textContent = d.message;
      input.insertAdjacentElement('afterend', msg);
    } else {
      unplaced.push(d.message);
    }
  }
  toast([err.message, ...unplaced].join(' '), 'error');
}
function clearErrors(form) {
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

// Reads a form into an object. Fields with data-type="number" become numbers; empty fields are left out.
function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    if (el.value === '') continue;
    out[el.name] = el.dataset.type === 'number' ? Number(el.value) : el.value.trim();
  }
  return out;
}

// Disables the submit button while a request runs, and reports errors on the form.
async function submitting(form, work) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  clearErrors(form);
  try { return await work(); } catch (err) { showError(err, form); return undefined; } finally { if (button) button.disabled = false; }
}

function requireLogin({ admin = false } = {}) {
  const session = Session.get();
  if (!session || !session.token) { window.location.href = 'index.html'; throw new Error('redirect'); }
  if (admin && session.user.role !== 'ADMIN') { window.location.href = 'dashboard.html'; throw new Error('redirect'); }
  return session.user;
}
const isAdminUser = () => { const s = Session.get(); return Boolean(s && s.user && s.user.role === 'ADMIN'); };

function renderNav(active) {
  const user = requireLogin();
  const links = [
    ['dashboard.html', 'Overview'], ['plans.html', 'Plans'], ['notifications.html', 'Emails'],
    ...(user.role === 'ADMIN' ? [['admin.html', 'Lender desk']] : [])
  ];
  document.body.classList.add('app');
  const aside = document.createElement('aside');
  aside.className = 'sidebar';
  aside.innerHTML = `
    <a class="brand" href="dashboard.html" aria-label="Loan Tracker home"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>Loan Tracker</a>
    <nav aria-label="Main">${links.map(([href, text]) => `<a href="${href}" class="${href === active ? 'active' : ''}" ${href === active ? 'aria-current="page"' : ''}>${text}<span class="count hidden" data-count="${href}"></span></a>`).join('')}</nav>
    <div class="who"><div><div class="name">${esc(user.name)}</div><div class="role">${user.role === 'ADMIN' ? 'Lender (admin)' : 'Customer'}</div></div>
    <button class="secondary small" id="logout">Log out</button></div>`;
  document.body.prepend(aside);
  aside.querySelector('#logout').addEventListener('click', () => { Session.clear(); window.location.href = 'index.html'; });
  // Pending approvals badge for the lender
  if (user.role === 'ADMIN') {
    api('GET', '/api/payments/pending').then(({ count }) => {
      const el = aside.querySelector('[data-count="admin.html"]');
      if (count && el) { el.textContent = count; el.classList.remove('hidden'); }
    }).catch(() => {});
  }
  return user;
}

// The instalment ribbon: one segment per instalment, coloured by status.
// The first not-yet-due unpaid segment is marked as "next".
function ribbon(statuses, { large = false } = {}) {
  if (!statuses || !statuses.length) return '';
  const nextIndex = statuses.findIndex((s) => s === 'UNPAID' || s === 'PARTIAL');
  const counts = statuses.reduce((c, s) => ({ ...c, [s]: (c[s] || 0) + 1 }), {});
  const title = `${counts.PAID || 0} paid, ${counts.PARTIAL || 0} partly paid, ${counts.OVERDUE || 0} overdue, ${(counts.UNPAID || 0)} still to pay`;
  return `<div class="ribbon ${large ? 'large' : ''}" role="img" aria-label="${title}" title="${title}">${statuses.map((s, i) =>
    `<span class="${i === nextIndex && s === 'UNPAID' ? 'NEXT' : s}" style="animation-delay:${i * 40}ms"></span>`).join('')}</div>`;
}

const RIBBON_LEGEND = `<div class="legend"><span><i style="background:var(--paid)"></i>Paid</span><span><i style="background:var(--due)"></i>Next due</span><span><i style="background:var(--late)"></i>Overdue</span><span><i style="background:var(--upcoming)"></i>Later</span></div>`;

// Fills a <tbody> or shows a friendly empty row
function fillRows(tbody, items, rowHtml, emptyText, colspan) {
  tbody.innerHTML = items.length ? items.map(rowHtml).join('') : `<tr><td colspan="${colspan}" class="empty">${esc(emptyText)}</td></tr>`;
}
