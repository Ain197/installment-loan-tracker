// JWT login tokens and role checks. The token carries the user's id, email, name and role.
const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('./errors');

const ROLES = { USER: 'USER', ADMIN: 'ADMIN' };

function secret(name = 'JWT_SECRET') {
  const value = process.env[name];
  if (name !== 'JWT_SECRET') return value && value.length >= 16 ? value : null;
  if (!value || value.length < 16) {
    throw new Error('JWT_SECRET is not set (or shorter than 16 characters). Put it in .env / the Lambda environment.');
  }
  return value;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    secret(),
    { expiresIn: process.env.TOKEN_TTL || '8h', issuer: 'loan-tracker' }
  );
}

// Accepts tokens signed with the current secret, or with the previous one during a rotation
// (infra/rotate-secrets.sh keeps the old value as JWT_SECRET_PREVIOUS), so nobody is logged out.
function verifyToken(token) {
  try {
    return jwt.verify(token, secret(), { issuer: 'loan-tracker' });
  } catch (error) {
    const previous = secret('JWT_SECRET_PREVIOUS');
    if (previous && error.name === 'JsonWebTokenError') return jwt.verify(token, previous, { issuer: 'loan-tracker' });
    throw error;
  }
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    const claims = verifyToken(token);
    req.user = { id: claims.sub, email: claims.email, name: claims.name, role: claims.role };
    return next();
  } catch (error) {
    if (error.message && error.message.startsWith('JWT_SECRET')) return next(error);
    return next(unauthorized('Your session has expired or is invalid. Please log in again.'));
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user && req.user.role) ? next() : next(forbidden('Only an admin can do this.'));

const isAdmin = (user) => Boolean(user && user.role === ROLES.ADMIN);

// Ownership rule shared by all services: users see only their own plans, admins see all.
function assertCanAccess(user, ownerId) {
  if (!isAdmin(user) && user.id !== ownerId) throw forbidden('This plan belongs to another user.');
}

// Routes under /internal are for service-to-service calls only.
// They are never added to API Gateway, and they also need the shared INTERNAL_TOKEN.
// During a rotation the previous token is accepted too, so services that still have the old
// value cached (up to SECRETS_TTL_SECONDS) keep working.
function requireInternal(req, res, next) {
  const given = req.get('x-internal-token');
  const accepted = [process.env.INTERNAL_TOKEN, process.env.INTERNAL_TOKEN_PREVIOUS].filter((t) => t && t.length >= 16);
  if (!given || !accepted.includes(given)) return next(forbidden('Internal route.'));
  return next();
}

module.exports = { ROLES, signToken, verifyToken, requireAuth, requireRole, isAdmin, assertCanAccess, requireInternal };
