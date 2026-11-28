// Every error the API returns has the same JSON shape:
//   { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
const unauthorized = (message = 'Please log in first.') => new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You are not allowed to do this.') => new AppError(403, 'FORBIDDEN', message);
const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
const conflict = (code, message) => new AppError(409, code, message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
