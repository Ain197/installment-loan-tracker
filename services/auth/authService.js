const bcrypt = require('bcryptjs');
const { users } = require('./userRepository');
const { signToken, ROLES } = require('../shared/auth');
const { conflict, unauthorized, notFound } = require('../shared/errors');

// Emails listed in ADMIN_EMAILS get the ADMIN role when they register (e.g. the lender's account).
function roleFor(email) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email) ? ROLES.ADMIN : ROLES.USER;
}

// Never send the password hash out of this service
const publicUser = ({ id, name, email, role, createdAt }) => ({ id, name, email, role, createdAt });

async function register({ name, email, password }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await users().create({ name, email, passwordHash, role: roleFor(email) });
  if (!user) throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Please log in.');
  return publicUser(user);
}

async function login({ email, password }) {
  const user = await users().findByEmail(email);
  // Same message for "no such email" and "wrong password", so the API does not reveal which emails exist
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw unauthorized('Email or password is incorrect.');
  }
  return { token: signToken(user), user: publicUser(user) };
}

async function getUser(id) {
  const user = await users().findById(id);
  if (!user) throw notFound('User');
  return publicUser(user);
}

async function listUsers() {
  return (await users().list()).map(publicUser);
}

module.exports = { register, login, getUser, listUsers, publicUser };
