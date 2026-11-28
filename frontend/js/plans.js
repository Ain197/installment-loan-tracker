(function () {
  const user = renderNav('plans.html');
  const admin = user.role === 'ADMIN';
  const newCard = document.getElementById('new-card');
  const newForm = document.getElementById('new-form');
  const searchForm = document.getElementById('search-form');

  document.getElementById('legend').innerHTML = RIBBON_LEGEND;
  if (admin) document.querySelectorAll('.admin-only').forEach((el) => el.classList.remove('hidden'));
  newForm.startDate.value = todayIso();

  const openNew = (open) => { newCard.classList.toggle('hidden', !open); if (open) newForm.title.focus(); };
  document.getElementById('toggle-new').addEventListener('click', () => openNew(newCard.classList.contains('hidden')));
  document.getElementById('close-new').addEventListener('click', () => openNew(false));
  if (window.location.hash === '#new') openNew(true);

  const feesOn = document.getElementById('feesOn');
  const feeFields = document.getElementById('fee-fields');
  const syncFees = () => feeFields.querySelectorAll('input, select').forEach((el) => { el.disabled = !feesOn.checked; });
  feesOn.addEventListener('change', syncFees);
  syncFees();

  // Live estimate of one instalment (the server does the exact calculation)
  const PER_YEAR = { WEEKLY: 52, BIWEEKLY: 26, MONTHLY: 12 };
  function preview() {
    const P = Number(newForm.totalAmount.value || 0) - Number(newForm.downPayment.value || 0);
    const n = Number(newForm.instalmentCount.value || 0);
    const rate = Number(newForm.annualRate.value || 0) / 100;
    const ppy = PER_YEAR[newForm.frequency.value];
    let each = n > 0 ? P / n : 0;
    if (rate && n > 0) {
      each = newForm.interestMethod.value === 'FLAT'
        ? (P + P * rate * (n / ppy)) / n
        : (P * (rate / ppy)) / (1 - (1 + rate / ppy) ** -n);
    }
    document.getElementById('preview').textContent = P > 0 && n > 0
      ? `About ${money(each)} per instalment, ${label(newForm.frequency.value).toLowerCase()}${rate ? `; total interest about ${money(each * n - P)}` : ''}.` : '';
  }
  newForm.addEventListener('input', preview);
  newForm.addEventListener('change', preview);

  if (admin) {
    api('GET', '/api/users').then(({ users }) => {
      const select = newForm.ownerId;
      users.filter((u) => u.id !== user.id).forEach((u) => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = `${u.name} (${u.email})`;
        select.appendChild(opt);
      });
    }).catch(showError);
  }

  newForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(newForm, async () => {
      const body = readForm(newForm);
      delete body['lateFeePolicy.value'];
      if (!body.annualRate) delete body.interestMethod;
      if (feesOn.checked) {
        body.lateFeePolicy = {
          graceDays: Number(document.getElementById('graceDays').value),
          type: document.getElementById('feeType').value,
          value: Number(document.getElementById('feeValue').value)
        };
      }
      const data = await api('POST', '/api/plans', body);
      toast(data.message);
      window.location.href = `plan.html?id=${encodeURIComponent(data.plan.planId)}`;
    });
  });

  async function search() {
    const params = new URLSearchParams(Object.entries(readForm(searchForm)));
    const rows = document.getElementById('rows');
    try {
      const { plans, count } = await api('GET', `/api/plans?${params}`);
      document.getElementById('result-title').textContent = `${count} plan${count === 1 ? '' : 's'}`;
      fillRows(rows, plans, (p) => `<tr>
        <td><a href="plan.html?id=${encodeURIComponent(p.planId)}"><b>${esc(p.title)}</b></a><div class="small muted">${esc(p.provider)}</div></td>
        ${admin ? `<td>${esc(p.ownerName)}</td>` : ''}
        <td>${badge(p.status)} ${p.isOverdue ? badge('OVERDUE', `${p.counts.overdue} overdue`) : ''}</td>
        <td class="small">${p.instalmentCount} × ${label(p.frequency).toLowerCase()}<div class="muted">${money(p.totalAmount)}${p.annualRate ? ` · ${p.annualRate}% ${label(p.interestMethod).toLowerCase()}` : ''}${p.lateFeePolicy ? ' · late fees' : ''}</div></td>
        <td style="min-width:170px">${ribbon(p.ribbon)}<div class="small muted" style="margin-top:.35rem">${p.counts.paid} of ${p.instalmentCount} paid</div></td>
        <td class="nowrap">${p.nextDue ? `${fmtDate(p.nextDue.dueDate)}<div class="small muted">${money(p.nextDue.amountRemaining)}</div>` : '—'}</td>
        <td class="num money">${money(p.remainingAmount)}</td></tr>`,
      'No plans match these filters.', admin ? 7 : 6);
    } catch (err) { showError(err, searchForm); }
  }

  searchForm.addEventListener('submit', (e) => { e.preventDefault(); search(); });
  searchForm.addEventListener('reset', () => setTimeout(search, 0));
  search();
})();
