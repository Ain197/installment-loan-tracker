(function () {
  const user = renderNav('dashboard.html');
  const admin = user.role === 'ADMIN';
  const $ = (id) => document.getElementById(id);
  $('greeting').textContent = admin ? 'Lender overview' : `Hello, ${user.name.split(' ')[0]}`;
  if (admin) {
    $('subtitle').textContent = 'Totals across all of your customers.';
    $('owner-col').classList.remove('hidden');
  }
  $('legend').innerHTML = RIBBON_LEGEND;
  const planLink = (id, title) => `<a href="plan.html?id=${encodeURIComponent(id)}">${esc(title)}</a>`;
  const monthName = (ym, style = 'long') => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', { month: style });

  async function loadSummary() {
    try {
      const { summary: s } = await api('GET', '/api/balances/summary');
      $('s-month-label').textContent = `Due in ${monthName(s.month)}`;
      $('s-month').innerHTML = `<small>EGP</small>${Number(s.dueThisMonth).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      $('s-remaining').textContent = money(s.totalRemaining);
      $('s-overdue').textContent = s.overdueInstalments ? `${money(s.overdueAmount)}` : 'Nothing';
      $('s-plans').textContent = `${s.activePlans}${s.completedPlans ? ` (+${s.completedPlans} paid off)` : ''}`;
      if (s.lateFeesCharged) { $('s-fees-box').classList.remove('hidden'); $('s-fees').textContent = money(s.lateFeesCharged); }
      if (s.pendingApprovals !== undefined) {
        $('s-pending-box').classList.remove('hidden');
        $('s-pending').textContent = `${s.pendingApprovals} payment${s.pendingApprovals === 1 ? '' : 's'}`;
      }

      const max = Math.max(1, ...s.dueByMonth.map((m) => m.amount));
      $('bars').innerHTML = s.dueByMonth.map((m, i) => `
        <div class="bar ${i === 0 ? 'now' : ''}" title="${monthName(m.month)}: ${money(m.amount)}">
          <span class="amt">${m.amount ? moneyShort(m.amount) : '—'}</span>
          <span class="col" style="height:${Math.round((m.amount / max) * 120)}px"></span>
          <span class="mon">${monthName(m.month, 'short')}</span>
        </div>`).join('');

      fillRows($('plans'), s.plans.filter((p) => p.status !== 'CANCELLED'), (p) => `<tr>
        <td>${planLink(p.planId, p.title)}<div class="small muted">${esc(p.provider)}${p.annualRate ? ` · ${p.annualRate}% interest` : ''}</div></td>
        ${admin ? `<td>${esc(p.ownerName)}</td>` : ''}
        <td style="min-width:180px">${ribbon(p.ribbon)}<div class="small muted" style="margin-top:.35rem">${p.status === 'COMPLETED' ? 'Paid off' : `${p.progressPercent}% paid`}</div></td>
        <td class="nowrap">${p.nextDue ? `${fmtDate(p.nextDue.dueDate)}<div class="small muted">${money(p.nextDue.amountRemaining)}</div>` : '—'}</td>
        <td class="num money">${money(p.remainingAmount)}</td></tr>`, 'No plans yet. Add your first plan to see its schedule here.', admin ? 5 : 4);
    } catch (err) { showError(err); }
  }

  async function loadUpcoming() {
    const days = $('days').value;
    try {
      const data = await api('GET', `/api/reminders/upcoming?days=${days}`);
      const row = (i) => `<tr>
        <td class="nowrap">${fmtDate(i.dueDate)}<div class="small ${i.daysUntil < 0 ? '' : 'muted'}" ${i.daysUntil < 0 ? 'style="color:var(--late)"' : ''}>${relDays(i.daysUntil)}</div></td>
        <td>${planLink(i.planId, i.planTitle)} <span class="small muted">#${i.seq}</span>${admin ? `<div class="small muted">${esc(i.ownerName)}</div>` : ''}</td>
        <td class="num">${money(i.amountRemaining)}</td></tr>`;
      fillRows($('upcoming'), data.upcoming, row, `Nothing is due in the next ${days} days.`, 3);
      fillRows($('overdue'), data.overdue, row, 'Nothing is overdue.', 3);
    } catch (err) { showError(err); }
  }

  async function loadNotes() {
    try {
      const { notifications } = await api('GET', '/api/notifications');
      fillRows($('notes'), notifications.slice(0, 5), (n) => `<tr>
        <td class="nowrap">${fmtDateTime(n.createdAt)}</td><td>${badge(n.type)}</td>
        <td>${planLink(n.planId, n.planTitle)}</td><td>${badge(n.status)}</td></tr>`, 'No emails sent yet.', 4);
    } catch (err) { showError(err); }
  }

  $('days').addEventListener('change', loadUpcoming);
  loadSummary(); loadUpcoming(); loadNotes();
})();
