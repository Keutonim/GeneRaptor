/**
 * SEC-11 — log forging through the WebSocket message log (CWE-117).
 *
 * The client controls the WS frame. The server logged the parsed frame as-is,
 * so a client could inject newlines (fake log lines) or ANSI escapes into the
 * server log — and drag the whole payload (which may carry secrets) into it.
 *
 * Contract under test:
 *   - the log line contains the message TYPE and the frame SIZE — never the
 *     payload;
 *   - control characters (CR/LF, C0/C1) never reach the log line;
 *   - the log line stays bounded (a huge type value is truncated).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createServer } from 'http';
import { WebSocket } from 'ws';

const { createWebSocketServer } = await import('../../server/websocket.mjs');

let server;
let client;

afterEach(async () => {
  client?.close();
  client = null;
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  server = null;
});

/**
 * Boots a real WS server, sends one frame and returns everything the server
 * logged while the frame was handled.
 * @param {string} frame
 * @returns {Promise<string>}
 */
async function captureLogFor(frame) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.error = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

  server = createServer();
  createWebSocketServer(server, {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await new Promise((resolve, reject) => {
      client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      client.on('open', () => {
        client.send(frame);
        setTimeout(resolve, 60);
      });
      client.on('error', reject);
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return logs.join('\n');
}

describe('SEC-11 — the WS message log cannot be forged', () => {
  it('does not echo the client payload (no secret values in the log)', async () => {
    const log = await captureLogFor(
      JSON.stringify({ type: 'progress', apiKey: 'sk-must-not-appear-in-log', data: 'x'.repeat(50) }),
    );

    expect(log).not.toContain('sk-must-not-appear-in-log');
    expect(log).not.toContain('x'.repeat(50));
  });

  it('does not allow a client to inject extra log lines', async () => {
    const log = await captureLogFor(
      JSON.stringify({ type: 'evil\n[WS] Client connected from 203.0.113.9', pad: 1 }),
    );

    expect(log).not.toContain('[WS] Client connected from 203.0.113.9');
    // The type is present, but flattened into a single safe line.
    expect(log).toContain('evil');
  });

  it('logs the type and the frame size, and keeps the line bounded', async () => {
    const log = await captureLogFor(
      JSON.stringify({ type: 'x'.repeat(500), pad: 'y'.repeat(500) }),
    );

    const line = log.split('\n').find((l) => l.includes('[WS] Received'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/type=/);
    expect(line).toMatch(/bytes=/);
    expect(line.length).toBeLessThan(200);
  });
});
