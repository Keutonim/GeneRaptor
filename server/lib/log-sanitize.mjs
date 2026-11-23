/**
 * SEC-11 — log sanitization for client-controlled text (CWE-117).
 *
 * Anything that reaches the server from a client can carry CR/LF, ANSI
 * escapes or other control characters. Writing such a value into a log line
 * lets the client forge log lines (log forging) or hide text. This module
 * is the single place that flattens and bounds a value before it is logged.
 *
 * Rules:
 *   - C0 controls (incl. CR/LF/TAB), DEL, C1 controls and the Unicode
 *     line/paragraph separators are replaced with a space — the text stays
 *     readable but can no longer break out of its log line;
 *   - the result is bounded (default 120 characters) and the truncation is
 *     visible ('…');
 *   - the value itself is never logged — only its TYPE and SIZE.
 */

/**
 * Flattens control characters and bounds the length of a value.
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeLogText(value, maxLength = 120) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 120;
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened;
}

/**
 * Flattens a value into a safe LOG TOKEN: control characters are dropped and
 * everything outside `[A-Za-z0-9._:-]` becomes '?'. A client can therefore
 * neither break the line nor imitate a log marker (`[WS] …`) — the value
 * stays readable (message types are plain identifiers) but harmless.
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeLogToken(value, maxLength = 64) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const safe = text.replace(/[^A-Za-z0-9._:-]/g, '?');
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 64;
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

/**
 * A short, safe description of a client frame: the message type (sanitized,
 * bounded) and the frame size. Never the payload.
 * @param {unknown} message - the parsed frame
 * @param {number} bytes - the raw frame size
 * @returns {string} e.g. 'type=progress bytes=42'
 */
export function describeClientMessage(message, bytes) {
  const rawType =
    message && typeof message === 'object' && typeof message.type === 'string'
      ? message.type
      : 'unknown';
  const type = sanitizeLogToken(rawType, 64).trim() || 'unknown';
  const size = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  return `type=${type} bytes=${size}`;
}
