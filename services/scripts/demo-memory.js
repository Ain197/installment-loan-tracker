// npm run demo: the whole app without Floci (in-memory DynamoDB and S3, emails printed). Data is lost on exit.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-demo-secret-change-me-please';
process.env.INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'local-demo-internal-token';
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || 'admin@demo.com';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS || 'http://localhost:3000';

const { startTestStack } = require('../test/helpers');
const { today, addDays } = require('../shared/dates');

(async () => {
  const port = Number(process.env.PORT || 3000);
  const keep = { ...process.env };
  const stack = await startTestStack({ port });
  Object.assign(process.env, { JWT_SECRET: keep.JWT_SECRET, INTERNAL_TOKEN: keep.INTERNAL_TOKEN, ADMIN_EMAILS: keep.ADMIN_EMAILS, CORS_ORIGINS: keep.CORS_ORIGINS });

  if (process.env.SEED !== 'off') {
    const admin = await stack.login('admin@demo.com', 'Shop Admin', 'password123');
    const user = await stack.login('mona@demo.com', 'Mona Ali', 'password123');
    const mk = (token, body) => stack.api('POST', '/api/plans', { token, body });
    const pdf = Buffer.from('%PDF-1.4 demo receipt').toString('base64');
    const phone = (await mk(user.token, { title: 'iPhone 16', provider: 'B.TECH', totalAmount: 60000, downPayment: 6000, instalmentCount: 12, frequency: 'MONTHLY', startDate: addDays(today(), 2), annualRate: 18, interestMethod: 'FLAT', lateFeePolicy: { graceDays: 3, type: 'FIXED', value: 150 } })).body.plan;
    await stack.api('POST', `/api/plans/${phone.planId}/payments`, { token: admin.token, body: { amount: 5310, paidOn: today(), method: 'CARD', note: 'First instalment' } });
    const sub = (await stack.api('POST', `/api/plans/${phone.planId}/payments`, { token: user.token, body: { amount: 2000, paidOn: today(), method: 'MOBILE_WALLET', note: 'Part of the second one' } })).body.payment;
    await stack.api('POST', `/api/payments/${sub.paymentId}/receipt`, { token: user.token, body: { fileName: 'wallet.pdf', contentType: 'application/pdf', dataBase64: pdf } });
    await mk(user.token, { title: 'Course fees', provider: 'AUC', totalAmount: 18000, instalmentCount: 3, frequency: 'MONTHLY', startDate: addDays(today(), -10), lateFeePolicy: { graceDays: 5, type: 'PERCENT', value: 2 } });
    await mk(user.token, { title: 'Car loan', provider: 'NBE', totalAmount: 450000, downPayment: 90000, instalmentCount: 48, frequency: 'MONTHLY', startDate: addDays(today(), 20), annualRate: 21, interestMethod: 'REDUCING' });
    await mk(admin.token, { ownerId: user.user.id, title: 'Washing machine', provider: 'Raya', totalAmount: 15000, instalmentCount: 10, frequency: 'BIWEEKLY', startDate: addDays(today(), -18) });
    await stack.api('POST', '/api/reminder-runs', { token: admin.token, body: {} });
    console.log('\nDemo accounts: mona@demo.com / password123 (user), admin@demo.com / password123 (admin)');
  }
  console.log(`\nOpen ${stack.base.replace('127.0.0.1', 'localhost')} — press Ctrl+C to stop (data is not saved).`);
})();
