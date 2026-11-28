(function () {
  requireLogin({ admin: true });
  renderNav('admin.html');
  const $ = (id) => document.getElementById(id);
  const form = $('run-form');
  const rejectForm = $('reject-form');
  let rejectingId = null;
  form.asOf.value = todayIso();
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  async function loadPending() {
    try {
      const { payments, count } = await api('GET', '/api/payments/pending');
      $('pending-title').textContent = `Payments waiting for approval (${count})`;
      fillRows($('pending'), payments, (p) => `<tr>
        <td class="nowrap">${fmtDateTime(p.createdAt)}<div class="small muted">paid on ${fmtDate(p.paidOn)}</div></td>
        <td>${esc(p.ownerName || '')}<div class="small"><a href="plan.html?id=${encodeURIComponent(p.planId)}">${esc(p.planTitle || 'plan')}</a></div></td>
        <td class="num"><b>${money(p.amount)}</b><div class="small muted">${esc(label(p.method))}</div></td>
        <td>${badge(p.kind === 'PAYOFF' ? 'PAYOFF' : 'PENDING', label(p.kind))}</td>
        <td>${p.receipt ? `<button class="secondary small" data-receipt="${esc(p.paymentId)}">View</button>` : '<span class="small" style="color:var(--bad)">missing</span>'}</td>
        <td><div class="actions"><button class="small" data-approve="${esc(p.paymentId)}" ${p.receipt ? '' : 'disabled title="A receipt is required"'}>Approve</button>
          <button class="danger small" data-reject="${esc(p.paymentId)}">Reject</button></div></td></tr>`,
      'Nothing to approve.', 6);
    } catch (err) { showError(err); }
  }

  $('pending').addEventListener('click', async (e) => {
    const view = e.target.closest('[data-receipt]');
    const approve = e.target.closest('[data-approve]');
    const reject = e.target.closest('[data-reject]');
    if (view) {
      try {
        const { receipt } = await api('GET', `/api/payments/${encodeURIComponent(view.dataset.receipt)}/receipt`);
        const bytes = Uint8Array.from(atob(receipt.dataBase64), (c) => c.charCodeAt(0));
        window.open(URL.createObjectURL(new Blob([bytes], { type: receipt.contentType })), '_blank', 'noopener');
      } catch (err) { showError(err); }
    }
    if (approve) {
      approve.disabled = true;
      try {
        const data = await api('PATCH', `/api/payments/${encodeURIComponent(approve.dataset.approve)}/verification`, { decision: 'APPROVE' });
        toast(data.message);
        await Promise.all([loadPending(), loadOverdue()]);
      } catch (err) { showError(err); approve.disabled = false; }
    }
    if (reject) {
      rejectingId = reject.dataset.reject;
      rejectForm.reset();
      $('reject-dialog').showModal();
    }
  });

  rejectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(rejectForm, async () => {
      const data = await api('PATCH', `/api/payments/${encodeURIComponent(rejectingId)}/verification`, { decision: 'REJECT', reason: rejectForm.reason.value.trim() });
      toast(data.message);
      $('reject-dialog').close();
      await loadPending();
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { run, message } = await api('POST', '/api/reminder-runs', readForm(form));
      toast(message, run.failed ? 'error' : 'ok');
      $('run-result').innerHTML = `
        <p class="small"><b>${run.plansChecked}</b> active plans for ${fmtDate(run.asOf)} ·
        <b>${run.lateFees.applied}</b> late fee(s) (${money(run.lateFees.total)}) · <b>${run.sent}</b> email(s) sent ·
        <b>${run.alreadySent}</b> already sent · <b>${run.escalations}</b> escalation(s) · <b>${run.failed}</b> failed</p>
        ${run.errors.length ? `<p class="alert error small">${run.errors.map(esc).join('<br>')}</p>` : ''}
        ${run.results.length ? `<div class="table-wrap"><table><thead><tr><th>Plan</th><th>#</th><th>Type</th><th>Due</th><th>Result</th></tr></thead><tbody>
        ${run.results.map((r) => `<tr><td>${esc(r.planTitle)}</td><td>${r.seq || ''}</td><td>${badge(r.type)}</td><td>${fmtDate(r.dueDate)}</td>
          <td>${badge(r.status === 'ALREADY_SENT' ? 'SENDING' : r.status, r.status === 'ALREADY_SENT' ? 'Already sent' : undefined)}${r.error ? ` <span class="small">${esc(r.error)}</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted small">No emails were due on this date.</p>'}`;
      await Promise.all([loadMonitoring(), loadOverdue()]);
    });
  });

  async function loadMonitoring() {
    try {
      const { overview: o } = await api('GET', '/api/monitoring/overview');
      const byType = Object.entries(o.notifications.byType);
      $('mon-stats').innerHTML = `
        <div class="stat"><div class="label">Emails (7 days)</div><div class="value">${o.notifications.total}</div></div>
        <div class="stat ${o.notifications.failed ? 'bad' : ''}"><div class="label">Failed (7 days)</div><div class="value">${o.notifications.failed}</div></div>
        ${byType.map(([type, c]) => `<div class="stat"><div class="label">${esc(label(type))}</div><div class="value">${c.SENT || 0}<span class="small muted"> sent${c.FAILED ? `, ${c.FAILED} failed` : ''}</span></div></div>`).join('')}`;
      fillRows($('runs'), o.runs, (r) => `<tr><td class="nowrap">${fmtDateTime(r.finishedAt)}<div class="small muted">as of ${fmtDate(r.asOf)}</div></td>
        <td>${esc(r.trigger)}</td><td class="num">${r.lateFees ? r.lateFees.applied : 0}</td><td class="num">${r.sent}</td>
        <td class="num">${r.escalations || 0}</td><td class="num">${r.failed ? `<b style="color:var(--bad)">${r.failed}</b>` : 0}</td></tr>`, 'No runs yet.', 6);
      const s = o.settings;
      $('settings').innerHTML = [
        ['Escalate after', `${s.escalationDays} days late`], ['SNS alerts topic', s.alertsTopic], ['Alert email', s.alertEmail],
        ['CloudWatch metrics', s.metricsNamespace], ['Email provider', s.emailProvider]
      ].map(([k, v]) => `<tr><th style="text-transform:none">${k}</th><td>${esc(v)}</td></tr>`).join('');
    } catch (err) { showError(err); }
  }
  $('refresh-monitoring').addEventListener('click', loadMonitoring);

  async function loadOverdue() {
    try {
      const { plans } = await api('GET', '/api/plans?overdue=true&status=ACTIVE&sort=remaining');
      fillRows($('overdue'), plans, (p) => `<tr>
        <td>${esc(p.ownerName)}<div class="small muted">${esc(p.ownerEmail)}</div></td>
        <td><a href="plan.html?id=${encodeURIComponent(p.planId)}">${esc(p.title)}</a></td>
        <td>${badge('OVERDUE', `${p.counts.overdue} instalment(s), ${p.maxDaysLate} days`)}</td>
        <td>${p.totalLateFees ? money(p.totalLateFees) : '—'}</td>
        <td class="num">${money(p.remainingAmount)}</td></tr>`, 'No overdue plans.', 5);
    } catch (err) { showError(err); }
  }

  api('GET', '/api/users').then(({ users }) => {
    fillRows($('users'), users, (u) => `<tr>
      <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${badge(u.role === 'ADMIN' ? 'ADMIN' : 'ACTIVE', u.role === 'ADMIN' ? 'Admin' : 'User')}</td>
      <td>${fmtDate(u.createdAt)}</td></tr>`, 'No accounts.', 4);
  }).catch(showError);

  loadPending(); loadMonitoring(); loadOverdue();
})();
