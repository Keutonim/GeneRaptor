import { ValidationError } from './errors.mjs';

export { ValidationError };

/**
 * UUID v4 validation regex.
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID v4.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidUUID(str) {
  return typeof str === 'string' && UUID_V4_REGEX.test(str);
}

/**
 * Validate a source site id from query/body parameter.
 * Accepts sourceSiteId or sourceId alias.
 * @param {string|undefined} value
 * @returns {string|null} validated UUID or null if empty
 * @throws {ValidationError} if provided value is not a valid UUID
 */
export function validateSourceSiteId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError('sourceSiteId must be a string');
  }
  if (!isValidUUID(value)) {
    throw new ValidationError(`Invalid sourceSiteId: ${value}`);
  }
  return value;
}
