import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The e2e stack ports are parameterizable
// for the TEST STACK ONLY, so the acceptance gate can run on free ports
// without touching a foreign process. These are not product env vars: they
// are absent from .env.example and from the product docs. Without them the
// behavior is exactly as before (5173, proxy to 8787, no strictPort).
const E2E_API_PORT = Number(process.env.GENERAPTOR_E2E_API_PORT || 8787);
const E2E_UI_PORT_ENV = process.env.GENERAPTOR_E2E_UI_PORT;
const E2E_UI_PORT = Number(E2E_UI_PORT_ENV || 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback-only; `--host` on the launcher is the explicit
    // opt-in to expose the dev server.
    host: '127.0.0.1',
    port: E2E_UI_PORT,
    // Isolated e2e mode only: never silently slide to a neighbour port — that
    // would point Playwright at somebody else's application.
    ...(E2E_UI_PORT_ENV ? { strictPort: true } : {}),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${E2E_API_PORT}`,
        changeOrigin: true
      },
      // Stage 2: WebSocket proxy for real-time article-progress stream.
      // The dev server upgrades `/ws` connections and forwards them to the
      // API server. In production this is handled by the reverse proxy.
      '/ws': {
        target: `ws://127.0.0.1:${E2E_API_PORT}`,
        ws: true,
      }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  }
});
