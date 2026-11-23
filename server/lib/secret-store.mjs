/**
 * SEC-04 — provider secret material at rest.
 *
 * One decision in one place: every provider key that is PERSISTED goes
 * through this module. Nothing else in the codebase is allowed to write a
 * provider key into the database.
 *
 * Design:
 *   - AES-256-GCM (authenticated encryption) with a random 96-bit IV per
 *     value; the stored format is versioned: `genr:v1:<iv>:<tag>:<ciphertext>`
 *     (all base64). The version prefix is what makes a future migration
 *     possible without guessing.
 *   - The master key lives in a PER-INSTALL key file next to the SQLite
 *     database (`provider-secrets.key`), created on first use with 0600 on
 *     POSIX (Windows: best effort — NTFS ACLs are the real boundary there).
 *     The file is created atomically (temp file + rename) and the bytes that
 *     actually landed on disk are read back, so two processes racing on the
 *     same install always agree on the same key.
 *   - FAIL CLOSED: if the key file cannot be created or read, the caller must
 *     NOT fall back to storing plaintext. A provider key is then simply not
 *     stored (the settings route reports the error) — plaintext at rest is
 *     never an accepted fallback.
 *   - LEGACY ROWS: rows written before this module existed hold plaintext.
 *     They are migrated to ciphertext on read (see server/lib/providers.mjs)
 *     and the migration is idempotent.
 *
 * The key VALUE is never logged and never returned to a client.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';

export const SECRET_KEY_FILE_NAME = 'provider-secrets.key';
export const SECRET_PREFIX = 'genr:v1:';

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Typed failure — the caller decides what to do, there is no plaintext fallback. */
export class SecretStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

/**
 * Path of the per-install key file: next to the SQLite database when the
 * DATABASE_URL points at a local file, otherwise inside the data dir.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveSecretKeyPath(env = process.env) {
  const url = String(env.DATABASE_URL || '').trim();
  if (url.startsWith('file:')) {
    const raw = url.slice('file:'.length).split('?')[0];
    const absolute = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    return join(dirname(absolute), SECRET_KEY_FILE_NAME);
  }
  const dataDir =
    String(env.GENERAPTOR_DATA_DIR || '').trim() || join(homedir(), '.generaptor');
  return join(dataDir, SECRET_KEY_FILE_NAME);
}

/**
 * Best-effort 0600 on POSIX; a no-op on Windows (NTFS ACLs rule there).
 * @param {string} path
 */
export function hardenFileMode(path) {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows / unsupported filesystem — the mode is not the boundary there. */
  }
}

const keyCache = new Map();

/**
 * Loads (or creates) the per-install master key.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Buffer} 32 raw key bytes
 */
export function loadSecretKey(env = process.env) {
  const path = resolveSecretKeyPath(env);
  const cached = keyCache.get(path);
  if (cached) return cached;
  const key = existsSync(path) ? readKeyFile(path) : createKeyFile(path);
  keyCache.set(path, key);
  return key;
}

function readKeyFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SecretStoreError(
      'secret_key_unreadable',
      `Secret key file cannot be read: ${err.message}`,
    );
  }
  const key = Buffer.from(String(raw).trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretStoreError(
      'secret_key_corrupt',
      'Secret key file does not contain a valid 256-bit key',
    );
  }
  return key;
}

function createKeyFile(path) {
  const key = randomBytes(KEY_BYTES);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(tmp, path);
    } catch {
      // Another process won the creation race — take the key that is on disk.
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      return readKeyFile(path);
    }
    hardenFileMode(path);
    // Read back what actually landed on disk (never trust the local copy).
    return readKeyFile(path);
  } catch (err) {
    if (err instanceof SecretStoreError) throw err;
    throw new SecretStoreError(
      'secret_key_unavailable',
      `Secret key file cannot be created: ${err.message}`,
    );
  }
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the value is stored in the encrypted format
 */
export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/**
 * Encrypts a secret for storage.
 * @param {string} value
 * @param {Buffer} key
 * @returns {string} `genr:v1:<iv>:<tag>:<ciphertext>` (base64 parts)
 */
export function encryptSecret(value, key) {
  if (!value) return value;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_PREFIX + iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypts a stored secret. A value that is NOT in the encrypted format is
 * returned unchanged — that is the legacy plaintext row, and the caller
 * migrates it (server/lib/providers.mjs).
 * @param {string} value
 * @param {Buffer} key
 * @returns {string}
 */
export function decryptSecret(value, key) {
  if (!isEncryptedSecret(value)) return value;
  const parts = String(value).slice(SECRET_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new SecretStoreError('secret_payload_corrupt', 'Stored secret payload is malformed');
  }
  const [iv, tag, ciphertext] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretStoreError(
      'secret_decrypt_failed',
      'Stored secret cannot be decrypted with the local key file',
    );
  }
}
