/**
 * Express async handler wrapper.
 * Catches rejected promises from async route handlers and forwards them
 * to the next middleware (usually the global error handler).
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
