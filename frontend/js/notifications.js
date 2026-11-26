// Notification log (GET /api/notifications) with retry for failed emails
(function () {
  renderNav('notifications.html');
  const form = document.getElementById('filter-form');
  const rows = document.getElementById('rows');

  async function load() {
    const params = new URLSearchParams(Object.entries(readForm(form)));
    try {
      const { notifications, count } = await api('GET', `/api/notifications?${params}`);
      document.getElementById('count').textContent = `${count} notification${count === 1 ? '' : 's'}`;
      fillRows(rows, notifications, (n) => `<tr>
        <td class="nowrap">${fmtDateTime(n.createdAt)}<div class="small muted">${esc(n.trigger || '')}</div></td>
        <td>${badge(n.type)}${n.seq ? ` <span class="small muted">#${n.seq}</span>` : ''}</td>
        <td><a href="plan.html?id=${encodeURIComponent(n.planId)}">${esc(n.planTitle)}</a><div class="small muted">${esc(n.subject)}</div></td>
        <td class="small">${esc(n.email)}<div class="muted">via ${esc(n.provider || '—')}</div></td>
        <td>${badge(n.status)}${n.attempts > 1 ? `<div class="small muted">${n.attempts} attempts</div>` : ''}${n.error ? `<div class="small" style="color:var(--bad)">${esc(n.error)}</div>` : ''}</td>
        <td>${n.status === 'FAILED' ? `<button class="small" data-retry="${esc(n.notificationId)}">Retry</button>` : ''}</td></tr>`,
      'No notifications match.', 6);
    } catch (err) { showError(err); }
  }

  rows.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-retry]');
    if (!button) return;
    button.disabled = true;
    try {
      const data = await api('POST', `/api/notifications/${encodeURIComponent(button.dataset.retry)}/retries`);
      toast(data.message, data.notification.status === 'SENT' ? 'ok' : 'error');
      await load();
    } catch (err) { showError(err); button.disabled = false; }
  });

  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
})();
