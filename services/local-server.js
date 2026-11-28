// Local dev server: runs every service on one port and routes by path, like API Gateway on Floci.
const path = require('path');
const express = require('express');

const apps = {
  auth: require('./auth/app'),
  plans: require('./plans/app'),
  payments: require('./payments/app'),
  reminders: require('./reminders/app')
};

// First match wins, so the longer /api/plans/... paths come before /api/plans
const ROUTES = [
  [/^\/api\/health\/(auth|plans|payments|reminders)$/, (m) => m[1]],
  [/^\/api\/health$/, () => 'auth'],
  [/^\/api\/(auth|users)(\/|$)/, () => 'auth'],
  [/^\/internal\/users(\/|$)/, () => 'auth'],
  [/^\/api\/plans\/[^/]+\/(payments|balance|payoffs)$/, () => 'payments'],
  [/^\/api\/(payments|balances)(\/|$)/, () => 'payments'],
  [/^\/api\/plans\/[^/]+\/reminder-rule$/, () => 'reminders'],
  [/^\/api\/(reminders|notifications|reminder-runs|monitoring)(\/|$)/, () => 'reminders'],
  [/^\/internal\/(events|reminders)(\/|$)/, () => 'reminders'],
  [/^\/internal\/payments(\/|$)/, () => 'payments'],
  [/^\/internal\/late-fee-runs$/, () => 'plans'],
  [/^\/(api|internal)\/plans(\/|$)/, () => 'plans']
];

function createLocalServer() {
  const server = express();
  server.disable('x-powered-by');
  server.use((req, res, next) => {
    for (const [pattern, pick] of ROUTES) {
      const match = req.path.match(pattern);
      if (match) return apps[pick(match)](req, res, next);
    }
    return next();
  });
  server.use(express.static(path.join(__dirname, '..', 'frontend')));
  server.use((req, res) => res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}.` } }));
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createLocalServer().listen(port, () => {
    console.log(`Loan Tracker running on http://localhost:${port} (API + website)`);
    console.log(`DynamoDB/S3 endpoint: ${process.env.AWS_ENDPOINT_URL || '(AWS default)'}; users in ${process.env.DATABASE_URL ? 'Neon' : 'DynamoDB'}`);
  });
}

module.exports = { createLocalServer, ROUTES };
