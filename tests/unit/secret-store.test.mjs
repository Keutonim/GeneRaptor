/**
 * SEC-04 — server/lib/secret-store.mjs unit contract.
 *
 *   - AES-256-GCM round trip, versioned storage format;
 *   - a foreign key cannot decrypt the payload (authenticated encryption);
 *   - the per-install key file is created once, reused afterwards and kept
 *     next to the database with 0600 on POSIX;
 *   - a legacy plaintext value is returned unchanged (the caller migrates it).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const store = await import('../../server/lib/secret-store.mjs');

const isPosix = process.platform !== 'win32';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'generaptor-secret-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envFor(dirPath) {
  return { DATABASE_URL: `file:${dirPath.replace(/\\/g, '/')}/generaptor.db` };
}

describe('SEC-04 — secret-store crypto', () => {
  it('round-trips a secret through AES-256-GCM', () => {
    const key = store.loadSecretKey(envFor(dir));
    const cipher = store.encryptSecret('sk-round-trip', key);

    expect(cipher).not.toContain('sk-round-trip');
    expect(store.isEncryptedSecret(cipher)).toBe(true);
    expect(cipher.startsWith('genr:v1:')).toBe(true);
    expect(store.decryptSecret(cipher, key)).toBe('sk-round-trip');
  });

  it('uses a fresh IV for every value (no ciphertext reuse)', () => {
    const key = store.loadSecretKey(envFor(dir));
    const a = store.encryptSecret('same-secret', key);
    const b = store.encryptSecret('same-secret', key);
    expect(a).not.toBe(b);
    expect(store.decryptSecret(a, key)).toBe('same-secret');
    expect(store.decryptSecret(b, key)).toBe('same-secret');
  });

  it('refuses to decrypt with a foreign key (GCM authentication)', () => {
    const key = store.loadSecretKey(envFor(dir));
    const otherDir = mkdtempSync(join(tmpdir(), 'generaptor-secret-other-'));
    try {
      const otherKey = store.loadSecretKey(envFor(otherDir));
      const cipher = store.encryptSecret('sk-secret', key);
      expect(() => store.decryptSecret(cipher, otherKey)).toThrow();
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('leaves a legacy plaintext value untouched (the caller migrates it)', () => {
    const key = store.loadSecretKey(envFor(dir));
    expect(store.isEncryptedSecret('sk-legacy-plaintext')).toBe(false);
    expect(store.decryptSecret('sk-legacy-plaintext', key)).toBe('sk-legacy-plaintext');
  });
});

describe('SEC-04 — per-install key file', () => {
  it('creates the key file next to the database and reuses it', () => {
    const env = envFor(dir);
    const keyPath = store.resolveSecretKeyPath(env);

    expect(existsSync(keyPath)).toBe(false);
    const key = store.loadSecretKey(env);
    expect(existsSync(keyPath)).toBe(true);

    const onDisk = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    expect(onDisk.equals(key)).toBe(true);
    // A second call returns the same key (one install = one key).
    expect(store.loadSecretKey(env).equals(key)).toBe(true);
  });

  it('keeps the key file at 0600 on POSIX', () => {
    const env = envFor(dir);
    const keyPath = store.resolveSecretKeyPath(env);
    store.loadSecretKey(env);
    if (!isPosix) return;
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('rejects a corrupted key file instead of silently resetting it', () => {
    const env = envFor(dir);
    const keyPath = store.resolveSecretKeyPath(env);
    writeFileSync(keyPath, 'not-a-valid-key', 'utf8');
    expect(() => store.loadSecretKey(env)).toThrow();
  });
});
