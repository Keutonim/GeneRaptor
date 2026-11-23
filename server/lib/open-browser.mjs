/**
 * Auto-open the default browser at the UI address.
 *
 * Pure decision + URL builder; the spawn wrapper and the readiness poll
 * accept injections so unit tests never open a real browser.
 *
 * Security notes:
 *   - the one-time token rides the URL FRAGMENT: a fragment is never
 *     serialized into the request line nor into Referer, so the HTTP logger
 *     (which prints req.url) cannot leak it;
 *   - a fixed reusable token is NEVER put into an address/history entry;
 *   - CI / headless / non-TTY / test environments are skipped silently;
 *   - a spawn failure is reported, never thrown — the launcher must survive.
 */
import { spawn } from 'child_process';

/**
 * Decide whether the launcher should open a browser at all.
 *
 * Guard order matters: the explicit operator flag wins over everything else,
 * so `--no-browser` is a reliable soft rollback.
 *
 * @param {{env?: Record<string,string|undefined>, isTTY?: boolean,
 *          noBrowserFlag?: boolean, ui?: {uiServed?: boolean, mode?: string}|null,
 *          tokenMode?: 'one-time'|'fixed'|'no-auth'}} input
 * @returns {{open: boolean, reason: string}}
 */
export function shouldAutoOpenBrowser({
  env = process.env,
  isTTY = Boolean(process.stdout.isTTY),
  noBrowserFlag = false,
  ui,
  tokenMode = 'one-time',
} = {}) {
  if (noBrowserFlag) return { open: false, reason: 'flag' };
  if (env.NODE_ENV === 'test') return { open: false, reason: 'test-env' };
  const ci = String(env.CI ?? '').trim().toLowerCase();
  if (ci && ci !== 'false' && ci !== '0') return { open: false, reason: 'ci' };
  if (!isTTY) return { open: false, reason: 'no-tty' };
  if (tokenMode === 'fixed') return { open: false, reason: 'fixed-token' };
  if (!ui?.uiServed || ui.mode === 'none' || ui.mode === 'dev-server-not-started') {
    return { open: false, reason: 'no-ui' };
  }
  return { open: true, reason: 'ok' };
}

/**
 * Build the address to open. The token (when present) is appended as a
 * fragment; trailing slashes are stripped so the result is always
 * `<uiUrl>/#token=<value>`.
 *
 * @param {{uiUrl?: string|null, token?: string|null}} input
 * @returns {string}
 */
export function buildAutoOpenUrl({ uiUrl, token = null }) {
  const base = String(uiUrl ?? '').replace(/\/+$/, '');
  return token ? `${base}/#token=${token}` : base;
}

/**
 * Open `url` in the default browser. Resolves `{ok:true}` once the helper
 * process spawned, `{ok:false,error}` on any failure — it never rejects.
 *
 * @param {string} url
 * @param {{platform?: string, spawnImpl?: Function}} [options]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const opts = { detached: true, stdio: 'ignore', shell: false };
  const [cmd, args] =
    platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnImpl(cmd, args, opts);
    } catch (err) {
      return resolve({ ok: false, error: String(err) });
    }
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }));
    proc.on('spawn', () => {
      proc.unref?.();
      resolve({ ok: true });
    });
  });
}

/**
 * Poll the UI address until it answers 2xx (or the deadline passes).
 * The browser must not open before the server can answer, otherwise the
 * first paint would be a connection-refused page.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, intervalMs?: number, fetchImpl?: Function, now?: Function}} [options]
 * @returns {Promise<boolean>}
 */
export async function waitForUiReady(url, {
  timeoutMs = 60_000,
  intervalMs = 500,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const res = await fetchImpl(url, { redirect: 'manual' });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}