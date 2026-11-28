(function () {
  const user = renderNav('plans.html');
  const admin = user.role === 'ADMIN';
  const planId = new URLSearchParams(window.location.search).get('id');
  if (!planId) { window.location.href = 'plans.html'; return; }
  const base = `/api/plans/${encodeURIComponent(planId)}`;
  const DAY_OPTIONS = [0, 1, 2, 3, 5, 7, 14];

  let plan = null;
  let reasonAction = null; // what the reason dialog will do on submit

  const $ = (id) => document.getElementById(id);
  const payForm = $('pay-form');
  const ruleForm = $('rule-form');
  const editForm = $('edit-form');
  const reasonForm = $('reason-form');
  const payoffForm = $('payoff-form');
  payForm.paidOn.value = todayIso();
  payForm.paidOn.max = todayIso();
  $('p-paidOn').value = todayIso();
  $('approval-note').classList.toggle('hidden', admin);
  document.querySelectorAll('.customer-only').forEach((el) => el.classList.toggle('hidden', admin));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  async function loadPlan() {
    try {
      ({ plan } = await api('GET', base));
    } catch (err) {
      $('title').textContent = err.status === 404 ? 'Plan not found' : 'Cannot load this plan';
      showError(err);
      return;
    }
    document.title = `${plan.title} — Loan Tracker`;
    $('title').innerHTML = `${esc(plan.title)} ${badge(plan.status)} ${plan.isOverdue ? badge('OVERDUE', `${plan.maxDaysLate} days late`) : ''}`;
    const fee = plan.lateFeePolicy;
    $('meta').innerHTML = [
      `<span>Lender: <b>${esc(plan.provider)}</b></span>`,
      admin ? `<span>Customer: <b>${esc(plan.ownerName)}</b></span>` : '',
      `<span>Price: <b>${money(plan.totalAmount)}</b></span>`,
      plan.downPayment ? `<span>Down payment: <b>${money(plan.downPayment)}</b></span>` : '',
      `<span>${plan.instalmentCount} × ${esc(label(plan.frequency).toLowerCase())}</span>`,
      plan.annualRate ? `<span>Interest: <b>${plan.annualRate}%</b> ${esc(label(plan.interestMethod).toLowerCase())}</span>` : '<span>No interest</span>',
      fee ? `<span>Late fee: <b>${fee.type === 'PERCENT' ? `${fee.value}%` : money(fee.value)}</b> after ${fee.graceDays} day(s)</span>` : '',
      plan.interestSaved ? `<span>Paid off early, saved <b>${money(plan.interestSaved)}</b></span>` : ''
    ].join('');

    $('plan-ribbon').innerHTML = `${ribbon(plan.instalments.map((i) => i.status), { large: true })}${RIBBON_LEGEND}`;
    const anyPaid = plan.instalments.some((i) => i.amountPaid > 0);
    $('edit-btn').classList.toggle('hidden', plan.status !== 'ACTIVE');
    $('cancel-btn').classList.toggle('hidden', plan.status !== 'ACTIVE' || anyPaid);
    $('delete-btn').classList.toggle('hidden', plan.status !== 'CANCELLED');
    $('schedule-note').textContent = `${plan.counts.paid} paid · ${plan.counts.partial} partly paid · ${plan.counts.unpaid} unpaid · ${plan.counts.overdue} overdue`;

    fillRows($('schedule'), plan.instalments, (i) => `<tr>
      <td>${i.seq}</td><td class="nowrap">${fmtDate(i.dueDate)}${i.daysLate ? `<div class="small" style="color:var(--bad)">${i.daysLate} days late</div>` : ''}</td>
      <td class="num">${money(i.principal)}</td>
      <td class="num">${i.interest ? money(i.interest) : '—'}${i.interestWaived ? `<div class="small muted">−${money(i.interestWaived)} waived</div>` : ''}</td>
      <td class="num">${i.lateFee ? `<span style="color:var(--bad)">${money(i.lateFee)}</span>` : '—'}${i.lateFeeWaived ? `<div class="small muted">waived</div>` : ''}</td>
      <td class="num">${money(i.amountDue)}</td><td class="num">${money(i.amountPaid)}</td>
      <td class="num">${money(i.amountRemaining)}</td><td>${badge(i.status)}</td>
      <td>${admin && i.lateFee && plan.status === 'ACTIVE' ? `<button class="secondary small" data-waive="${i.seq}">Waive fee</button>` : ''}</td></tr>`, 'No instalments.', 10);

    const open = plan.status === 'ACTIVE';
    payForm.classList.toggle('hidden', !open);
    const closed = $('pay-closed');
    closed.classList.toggle('hidden', open);
    closed.textContent = plan.status === 'COMPLETED' ? 'This plan is fully paid.' : 'This plan is cancelled, so it takes no payments.';
    if (open && plan.nextDue && !payForm.amount.value) payForm.amount.value = plan.nextDue.amountRemaining.toFixed(2);
    ruleForm.querySelectorAll('input, button').forEach((el) => { el.disabled = !open; });
  }

  $('schedule').addEventListener('click', (e) => {
    const b = e.target.closest('[data-waive]');
    if (!b) return;
    openReason(`Waive late fee on instalment #${b.dataset.waive}`, 'The customer will no longer owe this fee.', 'Waive fee', async (reason) => {
      const data = await api('POST', `${base}/instalments/${b.dataset.waive}/late-fee-waivers`, { reason });
      toast(data.message);
    });
  });

  async function loadBalance() {
    try {
      const { balance: b } = await api('GET', `${base}/balance`);
      $('balance-badge').innerHTML = `${b.progressPercent}% paid`;
      $('balance').innerHTML = `
        ${progressBar(b.progressPercent)}
        <div style="margin-top:1rem">
          <div class="balance-line"><span>Amount financed</span><span>${money(b.financedAmount)}</span></div>
          ${b.totalInterest ? `<div class="balance-line"><span>+ Interest</span><span>${money(b.totalInterest)}</span></div>` : ''}
          ${b.totalLateFees ? `<div class="balance-line"><span>+ Late fees</span><span style="color:var(--bad)">${money(b.totalLateFees)}</span></div>` : ''}
          <div class="balance-line"><span>Paid</span><span>− ${money(b.paidAmount - (b.downPayment || 0))}</span></div>
          <div class="balance-line total"><span>Remaining</span><span>${money(b.remainingAmount)}</span></div>
          ${b.pendingCount ? `<div class="balance-line small" style="color:var(--warn)"><span>Waiting for approval (${b.pendingCount})</span><span>${money(b.pendingAmount)}</span></div>` : ''}
        </div>
        <p class="small muted" style="margin-bottom:0">${b.nextDue ? `Next: #${b.nextDue.seq} · ${money(b.nextDue.amountRemaining)} on ${fmtDate(b.nextDue.dueDate)}` : 'Nothing left to pay.'}
        · ${b.paymentsCount} verified payment(s)${b.lastPaymentOn ? `, last on ${fmtDate(b.lastPaymentOn)}` : ''}</p>`;
    } catch (err) { showError(err); }
  }

  async function loadPayments() {
    const showReversed = $('show-reversed').checked;
    try {
      const { payments } = await api('GET', `${base}/payments?includeReversed=${showReversed}`);
      fillRows($('payments'), payments, (p) => {
        const id = esc(p.paymentId);
        const applied = p.appliedTo && p.appliedTo.length && !p.reversed ? p.appliedTo.map((a) => `#${a.seq}: ${money(a.amount)}`).join('<br>') : '—';
        const closedStatus = ['REJECTED', 'WITHDRAWN'].includes(p.status) || p.reversed;
        const receipt = p.receipt
          ? `<button class="secondary small" data-receipt="${id}">View</button>`
          : (!closedStatus ? `<label class="button secondary small" style="margin:0">Upload<input type="file" class="hidden" data-upload="${id}" accept="application/pdf,image/png,image/jpeg"></label>` : '—');
        const ageHours = (Date.now() - Date.parse(p.verifiedAt || p.createdAt)) / 3600000;
        const actions = [];
        if (admin && p.status === 'PENDING') {
          actions.push(`<button class="small" data-approve="${id}">Approve</button>`, `<button class="danger small" data-reject="${id}">Reject</button>`);
        }
        if (!admin && p.status === 'PENDING') actions.push(`<button class="secondary small" data-withdraw="${id}">Withdraw</button>`);
        if (admin && p.status === 'VERIFIED' && !p.reversed && p.kind !== 'PAYOFF' && ageHours <= 24 && plan && plan.status !== 'CANCELLED') {
          actions.push(`<button class="danger small" data-reverse="${id}">Reverse</button>`);
        }
        const status = p.reversed ? badge('CANCELLED', 'Reversed') : badge(p.status);
        return `<tr>
          <td class="nowrap">${fmtDate(p.paidOn)}${p.kind === 'PAYOFF' ? `<div>${badge('PAYOFF')}</div>` : ''}</td>
          <td class="num">${p.reversed || closedStatus ? `<s>${money(p.amount)}</s>` : `<b>${money(p.amount)}</b>`}</td>
          <td>${status}${p.rejectionReason ? `<div class="small muted">${esc(p.rejectionReason)}</div>` : ''}${p.reversed ? `<div class="small muted">${esc(p.reversalReason)}</div>` : ''}
            ${p.recordedByRole === 'USER' && admin ? '<div class="small muted">by customer</div>' : ''}</td>
          <td>${esc(label(p.method))}${p.note ? `<div class="small muted">${esc(p.note)}</div>` : ''}</td>
          <td class="small">${applied}</td><td>${receipt}</td><td><div class="actions">${actions.join('')}</div></td></tr>`;
      }, 'No payments yet.', 7);
    } catch (err) { showError(err); }
  }

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });

  async function uploadReceipt(paymentId, file) {
    if (file.size > 2 * 1024 * 1024) throw Object.assign(new Error('The receipt is larger than 2 MB.'), { details: [] });
    const dataBase64 = await fileToBase64(file);
    return api('POST', `/api/payments/${encodeURIComponent(paymentId)}/receipt`, { fileName: file.name, contentType: file.type, dataBase64 });
  }

  payForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(payForm, async () => {
      const file = $('receipt').files[0];
      if (!admin && !file && !window.confirm('No receipt attached. The lender cannot approve the payment until you upload one. Continue?')) return;
      const data = await api('POST', `${base}/payments`, readForm(payForm));
      toast(data.message);
      if (file) {
        try { await uploadReceipt(data.payment.paymentId, file); toast('Receipt uploaded.'); } catch (err) { showError(err); }
      }
      payForm.reset();
      payForm.paidOn.value = todayIso();
      await refreshAll();
    });
  });

  // Early payoff (Plans gives the quote, Payments records the payoff)
  $('payoff-btn').addEventListener('click', async () => {
    $('payoff-dialog').showModal();
    $('quote').innerHTML = '<p class="muted">Getting today\'s payoff amount…</p>';
    try {
      const { quote } = await api('GET', `${base}/payoff-quote`);
      $('quote').innerHTML = `<div class="quote">Pay <b>${money(quote.payoffAmount)}</b> today to close this plan.
        <div class="small">Instead of ${money(quote.remainingIfNotPaidOff)} — you save <b style="font-size:1rem">${money(quote.interestSaved)}</b> of future interest.</div></div>
        ${admin ? '' : '<p class="small muted">The payoff waits for the lender\'s approval, with your receipt.</p>'}`;
    } catch (err) { $('quote').innerHTML = `<p class="alert error">${esc(err.message)}</p>`; }
  });

  payoffForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(payoffForm, async () => {
      const data = await api('POST', `${base}/payoffs`, readForm(payoffForm));
      const file = $('p-receipt').files[0];
      if (file) await uploadReceipt(data.payment.paymentId, file);
      toast(data.message);
      $('payoff-dialog').close();
      await refreshAll();
    });
  });

  $('payments').addEventListener('click', async (e) => {
    const target = (attr) => e.target.closest(`[data-${attr}]`);
    const view = target('receipt');
    if (view) {
      try {
        const { receipt } = await api('GET', `/api/payments/${encodeURIComponent(view.dataset.receipt)}/receipt`);
        const bytes = Uint8Array.from(atob(receipt.dataBase64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: receipt.contentType }));
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (err) { showError(err); }
      return;
    }
    const approve = target('approve');
    if (approve) {
      approve.disabled = true;
      try { const data = await api('PATCH', `/api/payments/${encodeURIComponent(approve.dataset.approve)}/verification`, { decision: 'APPROVE' }); toast(data.message); await refreshAll(); } catch (err) { showError(err); approve.disabled = false; }
      return;
    }
    const reject = target('reject');
    if (reject) {
      openReason('Reject payment', 'The customer gets an email with this reason.', 'Reject', async (reason) => {
        const data = await api('PATCH', `/api/payments/${encodeURIComponent(reject.dataset.reject)}/verification`, { decision: 'REJECT', reason });
        toast(data.message);
      });
      return;
    }
    const withdraw = target('withdraw');
    if (withdraw && window.confirm('Withdraw this payment? It will not be sent for approval.')) {
      try { await api('DELETE', `/api/payments/${encodeURIComponent(withdraw.dataset.withdraw)}`); toast('Payment withdrawn.'); await refreshAll(); } catch (err) { showError(err); }
      return;
    }
    const rev = target('reverse');
    if (rev) {
      openReason('Reverse payment', 'Admins can reverse a payment within 24 hours. The balance is recalculated from the other payments.', 'Reverse', async (reason) => {
        const data = await api('PATCH', `/api/payments/${encodeURIComponent(rev.dataset.reverse)}/reversal`, { reason });
        toast(data.message);
      });
    }
  });

  $('payments').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-upload]');
    if (!input || !input.files[0]) return;
    try { await uploadReceipt(input.dataset.upload, input.files[0]); toast('Receipt uploaded.'); await loadPayments(); } catch (err) { showError(err); }
  });
  $('show-reversed').addEventListener('change', loadPayments);

  // One dialog for every action that needs a reason (reject, reverse, waive)
  function openReason(title, note, button, action) {
    $('reason-title').textContent = title;
    $('reason-note').textContent = note;
    $('reason-submit').textContent = button;
    reasonForm.reset();
    clearErrors(reasonForm);
    reasonAction = action;
    $('reason-dialog').showModal();
  }
  reasonForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(reasonForm, async () => {
      await reasonAction(reasonForm.reason.value.trim());
      $('reason-dialog').close();
      await refreshAll();
    });
  });

  $('edit-btn').addEventListener('click', () => {
    const anyPaid = plan.instalments.some((i) => i.amountPaid > 0);
    editForm.title.value = plan.title;
    editForm.provider.value = plan.provider;
    editForm.instalmentCount.value = plan.instalmentCount;
    editForm.frequency.value = plan.frequency;
    editForm.totalAmount.value = plan.totalAmount;
    editForm.downPayment.value = plan.downPayment;
    editForm.startDate.value = plan.startDate;
    editForm.annualRate.value = plan.annualRate || 0;
    editForm.interestMethod.value = plan.interestMethod === 'FLAT' ? 'FLAT' : 'REDUCING';
    const fee = plan.lateFeePolicy;
    $('e-fees').checked = Boolean(fee);
    $('e-grace').value = fee ? fee.graceDays : 3;
    $('e-feetype').value = fee ? fee.type : 'FIXED';
    $('e-feevalue').value = fee ? fee.value : 50;
    editForm.querySelectorAll('.money-fields input, .money-fields select').forEach((el) => { el.disabled = anyPaid; });
    $('edit-note').textContent = anyPaid
      ? 'This plan has payments: paid instalments stay as they are, and the principal still owed is spread over the new number of instalments. The price and interest can no longer change.'
      : 'No payments yet, so the whole schedule will be rebuilt.';
    clearErrors(editForm);
    $('edit-dialog').showModal();
  });

  editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(editForm, async () => {
      const body = readForm(editForm);
      delete body['lateFeePolicy.value'];
      body.lateFeePolicy = $('e-fees').checked
        ? { graceDays: Number($('e-grace').value), type: $('e-feetype').value, value: Number($('e-feevalue').value) }
        : null;
      const data = await api('PUT', base, body);
      toast(data.message);
      $('edit-dialog').close();
      await refreshAll();
    });
  });

  $('cancel-btn').addEventListener('click', async () => {
    if (!window.confirm('Cancel this plan? Reminders will stop. This cannot be undone.')) return;
    try { const data = await api('PATCH', `${base}/status`, { status: 'CANCELLED' }); toast(data.message); await refreshAll(); } catch (err) { showError(err); }
  });

  $('delete-btn').addEventListener('click', async () => {
    if (!window.confirm('Delete this cancelled plan for good?')) return;
    try { await api('DELETE', base); toast('Plan deleted.'); window.location.href = 'plans.html'; } catch (err) { showError(err); }
  });

  async function loadRule() {
    try {
      const { rule } = await api('GET', `${base}/reminder-rule`);
      ruleForm.enabled.checked = rule.enabled;
      ruleForm.email.value = rule.email || '';
      ruleForm.overdueAlerts.checked = rule.overdueAlerts !== false;
      ruleForm.paymentConfirmations.checked = rule.paymentConfirmations !== false;
      const days = new Set(rule.daysBefore);
      $('day-options').innerHTML = DAY_OPTIONS.map((d) =>
        `<label class="check small"><input type="checkbox" value="${d}" data-day ${days.has(d) ? 'checked' : ''}> ${d === 0 ? 'On the day' : `${d} day${d > 1 ? 's' : ''}`}</label>`).join('');
      if (plan && plan.status !== 'ACTIVE') ruleForm.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    } catch (err) { showError(err); }
  }

  ruleForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(ruleForm, async () => {
      const body = {
        enabled: ruleForm.enabled.checked,
        daysBefore: [...ruleForm.querySelectorAll('[data-day]:checked')].map((el) => Number(el.value)),
        overdueAlerts: ruleForm.overdueAlerts.checked,
        paymentConfirmations: ruleForm.paymentConfirmations.checked
      };
      if (ruleForm.email.value.trim()) body.email = ruleForm.email.value.trim();
      const data = await api('PUT', `${base}/reminder-rule`, body);
      toast(data.message);
      await loadRule();
    });
  });

  async function loadNotes() {
    try {
      const { notifications } = await api('GET', `/api/notifications?planId=${encodeURIComponent(planId)}`);
      fillRows($('notes'), notifications.slice(0, 12), (n) => `<tr>
        <td class="nowrap">${fmtDateTime(n.createdAt)}</td>
        <td>${badge(n.type)}${n.seq ? ` <span class="small muted">#${n.seq}</span>` : ''}<div class="small muted">${esc(n.subject)}</div></td>
        <td>${badge(n.status)}</td></tr>`, 'No emails sent for this plan yet.', 3);
    } catch (err) { showError(err); }
  }

  async function refreshAll() {
    await loadPlan();
    await Promise.all([loadBalance(), loadPayments(), loadRule(), loadNotes()]);
  }
  refreshAll();
})();
