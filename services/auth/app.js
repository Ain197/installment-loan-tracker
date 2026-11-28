const { createApp } = require('../shared/http');
const { createChecker } = require('../shared/validate');
const { requireAuth, requireRole, requireInternal, ROLES } = require('../shared/auth');
const service = require('./authService');

module.exports = createApp('auth', (app) => {
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'pc', environment: process.env.NODE_ENV || 'development' });
  });

  app.post('/api/auth/register', async (req, res) => {
    const check = createChecker(req.body);
    const name = check.text('name', { min: 2, max: 80 });
    const email = check.email('email');
    const password = check.text('password', { min: 8, max: 72 });
    check.done();
    const user = await service.register({ name, email, password });
    res.status(201).json({ user, message: 'Account created. You can log in now.' });
  });

  app.post('/api/auth/login', async (req, res) => {
    const check = createChecker(req.body);
    const email = check.email('email');
    const password = check.text('password', { max: 72 });
    check.done();
    res.json(await service.login({ email, password }));
  });

  app.get('/api/auth/me', requireAuth, async (req, res) => {
    res.json({ user: await service.getUser(req.user.id) });
  });

  app.get('/api/users', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
    res.json({ users: await service.listUsers() });
  });

  // Internal: other services look up a user's name and email
  app.get('/internal/users/:userId', requireInternal, async (req, res) => {
    res.json({ user: await service.getUser(req.params.userId) });
  });
});
