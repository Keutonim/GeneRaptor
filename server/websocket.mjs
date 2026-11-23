import { WebSocketServer } from 'ws';
import { describeClientMessage, sanitizeLogText } from './lib/log-sanitize.mjs';

let wss = null;

/**
 * Create and attach a WebSocket server to the existing HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @param {object} [options] - forwarded to WebSocketServer. Pass `verifyClient`
 *   to gate the WS handshake (the access-gate cookie check in
 *   server/lib/auth.mjs::verifyWsConnection). WS upgrades bypass Express
 *   middleware, so verification must happen here at handshake time (R-01).
 */
export function createWebSocketServer(httpServer, options = {}) {
  wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    ...(options.verifyClient ? { verifyClient: options.verifyClient } : {}),
  });

  wss.on('connection', (ws, req) => {
    const clientIp = sanitizeLogText(req.socket.remoteAddress, 64);
    console.log(`[WS] Client connected from ${clientIp}`);

    ws.on('message', (data) => {
      const raw = typeof data?.toString === 'function' ? data.toString() : String(data ?? '');
      const bytes = Buffer.byteLength(raw, 'utf8');
      try {
        const message = JSON.parse(raw);
        // SEC-11: the frame is CLIENT-CONTROLLED. Only a bounded, sanitized
        // description reaches the log — never the payload (it may carry
        // secrets) and never a raw newline (log forging).
        console.log(`[WS] Received message ${describeClientMessage(message, bytes)}`);
        // Placeholder for future command handling (subscribe, ping, etc.)
      } catch (err) {
        // The parse error message may quote the client text — log the error
        // KIND and the frame size instead.
        console.error(`[WS] Invalid message format (bytes=${bytes}, reason=${err?.name || 'parse_error'})`);
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Client disconnected from ${clientIp}`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });

    // Send welcome message
    ws.send(
      JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })
    );
  });

  console.log('[WS] WebSocket server attached on /ws');
  return wss;
}

/**
 * Broadcast a progress update to all connected clients.
 * Clients can filter by articleId on their side.
 * @param {string} articleId
 * @param {object} payload - должен содержать type (например 'article-progress') и поля прогресса
 */
export function broadcastProgress(articleId, payload) {
  if (!wss) {
    console.warn('[WS] Server not initialized, skipping broadcast');
    return;
  }

  const message = JSON.stringify({
    ...payload,
    articleId,
    timestamp: new Date().toISOString(),
  });

  let sentCount = 0;
  let errorCount = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      try {
        client.send(message);
        sentCount++;
      } catch (err) {
        errorCount++;
        console.error(`[WS] Failed to send message to client:`, err.message);
      }
    }
  }

  console.log(
    `[WS] Progress broadcast to ${sentCount} clients for article ${articleId}` +
      (errorCount > 0 ? ` (${errorCount} errors)` : '')
  );
}

export { wss };
