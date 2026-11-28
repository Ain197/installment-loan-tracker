// Express app shared by every service: security headers, CORS, logging, JSON bodies, rate limit, errors.
const express = require('express');
const cors = require('cors');
const { AppError } = require('./errors');
const { loadSecrets, secretsInfo } = require('./secrets');

function allowedOrigins() {
  return (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:4566')
    .split(',').map((o) => o.trim()).filter(Boolean);
}

// Very small fixed-window rate limiter (per client IP, in memory).
// Each Lambda instance keeps its own count.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = (req.get('x-forwarded-for') || req.ip || 'unknown').split(',')[0].trim();
    const entry = hits.get(ip);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(ip, { start: now, count: 1 });
      if (hits.size > 5000) hits.clear();
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - now) / 1000)));
      return next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many requests. Please wait a minute and try again.'));
    }
    return next();
  };
}

function createApp(serviceName, registerRoutes) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Security headers (what the helmet package would add)
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    });
    next();
  });

  // Only our own website may call the API from a browser
  app.use(cors({
    origin: allowedOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));

  // One log line per request: shows in the terminal on your PC and in CloudWatch Logs on Lambda
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`[${serviceName}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started} ms)`);
    });
    next();
  });

  // Make sure secrets from Secrets Manager are loaded (cached) before any route runs
  app.use(async (req, res, next) => {
    try { await loadSecrets(); next(); } catch (error) { next(error); }
  });

  app.use(rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_PER_MINUTE || 300)
  }));

  // Bodies must be JSON (415 otherwise), parsed by express.json
  app.use((req, res, next) => {
    const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding');
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && hasBody && !req.is('application/json')) {
      return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as JSON (Content-Type: application/json).'));
    }
    return next();
  });
  app.use(express.json({ limit: '4mb' }));

  app.get(`/api/health/${serviceName}`, (req, res) => {
    res.json({
      status: 'ok',
      service: serviceName,
      runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'pc',
      environment: process.env.NODE_ENV || 'development',
      secrets: secretsInfo()
    });
  });

  registerRoutes(app);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}.` } });
  });

  // Central error handler: known errors keep their status; anything else is a 500
  // with no internal details sent to the browser.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' } });
    }
    if (err instanceof AppError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.details) body.error.details = err.details;
      return res.status(err.status).json(body);
    }
    console.error(`[${serviceName}] Unexpected error:`, err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server. Please try again.' } });
  });

  return app;
}

module.exports = { createApp };
