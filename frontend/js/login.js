(function () {
  if (Session.get()) { window.location.href = 'dashboard.html'; return; }

  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const notice = document.getElementById('notice');

  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    loginForm.classList.toggle('hidden', name !== 'login');
    registerForm.classList.toggle('hidden', name !== 'register');
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  if (new URLSearchParams(window.location.search).has('expired')) {
    notice.textContent = 'Your session ended. Please log in again.';
    notice.classList.remove('hidden');
  }

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(loginForm, async () => {
      const data = await api('POST', '/api/auth/login', readForm(loginForm));
      Session.save({ token: data.token, user: data.user });
      window.location.href = 'dashboard.html';
    });
  });

  registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(registerForm, async () => {
      const body = readForm(registerForm);
      const data = await api('POST', '/api/auth/register', body);
      toast(data.message);
      const login = await api('POST', '/api/auth/login', { email: body.email, password: body.password });
      Session.save({ token: login.token, user: login.user });
      window.location.href = 'dashboard.html';
    });
  });

  api('GET', '/api/health')
    .then((h) => { document.getElementById('api-status').textContent = `API online: ${h.runtime} (${h.environment})`; })
    .catch(() => { document.getElementById('api-status').textContent = 'API offline — start the backend or check js/config.js.'; });
})();
