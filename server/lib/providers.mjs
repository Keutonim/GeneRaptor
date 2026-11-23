/**
 * Provider registry + ProviderConfig resolution (M3; D9/D10).
 *
 * Four provider kinds, all speaking the OpenAI-compatible wire format
 * (`POST {base}/chat/completions`): the engine's single request layer stays
 * parameterized, not forked.
 *
 * Key storage (D10, docs/security.md §3): keys live in the local
 * ProviderConfig store (SQLite) with an env fallback per kind for
 * CI/headless runs. Resolution order per kind: env value WINS over the
 * local store (the UI field is read-only when env is set). Key values are
 * never returned to clients and never logged — consumers use the masked
 * descriptor (keyConfigured/keySource) or the value internally.
 *
 * Endpoint + key binding (SEC-02): the stored `baseUrl` is USER-SUPPLIED and
 * the environment key is NOT. The endpoint and the key are therefore resolved
 * together in server/lib/provider-url.mjs (the single policy point): a stored
 * URL never receives an environment key, the `custom` kind never uses an
 * environment key, and a fixed kind never uses a stored URL at all.
 *
 * Images (D9): covers require an images-capable provider. The capability is
 * a static per-kind fact here (routerai 'yes', ollama 'no', openrouter and
 * custom 'unknown' — depends on the endpoint/model). The UI never guesses
 * it; cover resolution fails with an honest machine code instead of
 * silently swapping providers.
 *
 * Key material at rest (SEC-04): a PERSISTED provider key is never written
 * as plaintext. Every write goes through server/lib/secret-store.mjs
 * (AES-256-GCM + a per-install 0600 key file next to the database), and
 * every read decrypts it. Rows written before that module existed hold
 * plaintext — they are migrated to ciphertext on read (idempotent) and the
 * old bytes are removed from the database file. The environment key path is
 * unchanged: an env key is never stored and never written to disk.
 */

/** Same placeholder predicate as server/lib/api-key-probe.mjs (kept local so this lib stays dependency-free). */
function isConfigured(value) {
  if (!value || typeof value !== 'string') return false;
  return !/^put_.*_here$|^change_me|^your_.*$/.test(value.trim());
}

/** Ordered provider kinds (first = default for env fallback). */
export const PROVIDER_KINDS = ['routerai', 'openrouter', 'ollama', 'custom'];

/**
 * Static registry per kind. `envBaseUrlKey` exists only where the project
 * already had an env override (ROUTERAI_ENDPOINT) — no new env vars are invented.
 */
/**
 * SEC-02: the endpoint policy + key binding live in one module — this file
 * only wires the registry, the DB row and the environment into it.
 */
import {
  FIXED_PROVIDER_KINDS,
  ProviderUrlError,
  bindProviderKey,
  isPrivateNetworkAllowed,
  resolveProviderTarget,
  validateProviderBaseUrl,
} from './provider-url.mjs';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  loadSecretKey,
  SecretStoreError,
} from './secret-store.mjs';

export const PROVIDER_REGISTRY = Object.freeze({
  routerai: Object.freeze({
    kind: 'routerai',
    label: 'RouterAI',
    defaultBaseUrl: 'https://routerai.ru/api/v1',
    envKey: 'ROUTERAI_API_KEY',
    envBaseUrlKey: 'ROUTERAI_ENDPOINT',
    keyOptional: false,
    imagesCapability: 'yes',
  }),
  openrouter: Object.freeze({
    kind: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    envBaseUrlKey: null,
    keyOptional: false,
    imagesCapability: 'unknown',
  }),
  ollama: Object.freeze({
    kind: 'ollama',
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    envKey: 'OLLAMA_API_KEY',
    envBaseUrlKey: null,
    keyOptional: true, // keyless local server is a valid configuration
    imagesCapability: 'no',
  }),
  custom: Object.freeze({
    kind: 'custom',
    label: 'Custom provider',
    defaultBaseUrl: '', // user-defined OpenAI-compatible base URL
    envKey: 'CUSTOM_API_KEY',
    envBaseUrlKey: null,
    keyOptional: true,
    imagesCapability: 'unknown',
  }),
});

export function isProviderKind(kind) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, kind);
}

/** Parses modelsJson into { critical?, generation?, standard?, cover? } — invalid JSON → {}. */
export function parseProviderModels(modelsJson) {
  if (!modelsJson || typeof modelsJson !== 'string') return {};
  let parsed;
  try {
    parsed = JSON.parse(modelsJson);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const models = {};
  for (const tier of ['critical', 'generation', 'standard', 'cover']) {
    const value = parsed[tier];
    if (typeof value === 'string' && value.trim()) models[tier] = value.trim();
  }
  return models;
}

/**
 * Key resolution per kind (D10 + SEC-02): the binding rules live in
 * server/lib/provider-url.mjs — the key is bound to the ENDPOINT it may be
 * sent to. This legacy 2-arg form assumes the canonical endpoint (the real
 * resolution happens in buildDescriptor, which knows the endpoint source) and
 * is kept for the callers that only need to know whether a key exists.
 * Never throws; returns the raw value for INTERNAL use only.
 */
export function resolveProviderKey(kind, row) {
  const meta = PROVIDER_REGISTRY[kind];
  const envApiKey = meta?.envKey && isConfigured(process.env[meta.envKey]) ? process.env[meta.envKey] : '';
  const raw = row?.apiKey && typeof row.apiKey === 'string' ? row.apiKey : '';
  // SEC-04: a stored key is ciphertext at rest — decrypt it for internal use.
  let storedApiKey = raw;
  if (isEncryptedSecret(raw)) {
    try {
      storedApiKey = decryptSecret(raw, loadSecretKey());
    } catch {
      storedApiKey = '';
    }
  }
  return bindProviderKey({
    kind,
    fixed: FIXED_PROVIDER_KINDS.includes(kind),
    endpointSource: 'canonical',
    storedApiKey,
    envApiKey,
  });
}

/**
 * Lazy Prisma reference (pattern of server/lib/agent-role-overrides.mjs):
 * the module must stay importable without a DB, and resolution must never
 * take the engine down — on any DB error callers fall back to env config.
 */
let prismaPromise = null;
function getPrisma() {
  if (!prismaPromise) {
    prismaPromise = import('../db.mjs').then((mod) => mod.prisma);
  }
  return prismaPromise;
}

async function findProviderRows() {
  const prisma = await getPrisma();
  return prisma.providerConfig.findMany({ orderBy: { createdAt: 'asc' } });
}

/**
 * SEC-04 — reads the stored key material of a row.
 *
 * Three cases:
 *   1. the row holds ciphertext → decrypt it with the per-install key file;
 *   2. the row holds LEGACY PLAINTEXT → use it for the caller and migrate
 *      the row to ciphertext right away (idempotent: the next read sees
 *      ciphertext and does nothing). The migration also removes the old
 *      plaintext bytes from the database file (VACUUM);
 *   3. the key file is missing/corrupt → the secret is NOT usable. The
 *      descriptor then simply has no key (fail closed) — a stored secret is
 *      never downgraded to plaintext.
 *
 * @param {{id?: string, apiKey?: string|null}|null|undefined} row
 * @returns {Promise<{ value: string, migrated: boolean, error: Error|null }>}
 */
async function readStoredSecret(row) {
  const raw = row?.apiKey && typeof row.apiKey === 'string' ? row.apiKey : '';
  if (!raw) return { value: '', migrated: false, error: null };
  try {
    if (isEncryptedSecret(raw)) {
      return { value: decryptSecret(raw, loadSecretKey()), migrated: false, error: null };
    }
    const encrypted = encryptSecret(raw, loadSecretKey());
    const prisma = await getPrisma();
    await prisma.providerConfig.update({ where: { id: row.id }, data: { apiKey: encrypted } });
    // The old plaintext must not survive in the database file (freed pages /
    // WAL images). VACUUM rewrites the file and drops the stale content.
    await prisma.$queryRawUnsafe('VACUUM').catch(() => {});
    return { value: raw, migrated: true, error: null };
  } catch (err) {
    console.warn(
      '[providers] stored provider key is unavailable:',
      err instanceof SecretStoreError ? err.code : 'unknown_error',
    );
    return { value: '', migrated: false, error: err };
  }
}

/**
 * Builds the full descriptor for a kind from registry + optional DB row + env.
 *
 * The endpoint and the key are resolved TOGETHER (SEC-02): a stored
 * (user-supplied) URL is validated by the policy and never receives an
 * environment key; a rejected endpoint yields an EMPTY descriptor that
 * carries the machine code — it must never become an outbound target.
 */
async function buildDescriptor(kind, row) {
  const meta = PROVIDER_REGISTRY[kind];
  const envBaseUrl = meta.envBaseUrlKey ? process.env[meta.envBaseUrlKey] : '';
  const envApiKey = meta.envKey && isConfigured(process.env[meta.envKey]) ? process.env[meta.envKey] : '';
  const fixed = FIXED_PROVIDER_KINDS.includes(kind);
  const base = {
    kind,
    label: meta.label,
    keyOptional: meta.keyOptional,
    imagesCapability: meta.imagesCapability,
    models: parseProviderModels(row?.modelsJson),
    enabled: Boolean(row?.enabled),
  };

  let target;
  try {
    // SEC-04: the stored key is decrypted (and legacy plaintext rows are
    // migrated to ciphertext) BEFORE it is bound to an endpoint.
    const storedSecret = await readStoredSecret(row);
    target = await resolveProviderTarget({
      kind,
      fixed,
      defaultBaseUrl: meta.defaultBaseUrl,
      envBaseUrl,
      storedBaseUrl: row?.baseUrl,
      storedApiKey: storedSecret.value,
      envApiKey,
      allowPrivateNetwork: isPrivateNetworkAllowed(process.env),
    });
  } catch (err) {
    const code = err?.code || 'provider_endpoint_rejected';
    // provider_url_required = «the user has not configured an endpoint yet»,
    // not a policy rejection.
    const rejected = code !== 'provider_url_required';
    return {
      ...base,
      baseUrl: '',
      apiKey: '',
      keySource: 'none',
      keyConfigured: false,
      endpointSource: rejected ? 'rejected' : 'none',
      endpointRejected: rejected,
      rejectionCode: code,
    };
  }

  return {
    ...base,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    keySource: target.keySource,
    keyConfigured: target.keyConfigured,
    endpointSource: target.source,
    endpointRejected: false,
    rejectionCode: null,
  };
}

/**
 * The active text provider:
 *   1. the single enabled ProviderConfig row (the write path keeps
 *      at-most-one enabled; on drift the earliest row wins — deterministic);
 *   2. env fallback headless: ROUTERAI_API_KEY (+ ROUTERAI_ENDPOINT and
 *      ROUTERAI_MODEL_* tier models) → a routerai descriptor;
 *   3. null when nothing at all is configured.
 */
export async function resolveActiveProvider() {
  const rows = await findProviderRows();
  const enabledRow = rows.find((row) => row.enabled && isProviderKind(row.kind));
  if (enabledRow) {
    const descriptor = await buildDescriptor(enabledRow.kind, enabledRow);
    // A rejected endpoint is never used as an outbound target (SEC-02).
    if (descriptor.endpointRejected) return null;
    return descriptor;
  }

  if (isConfigured(process.env.ROUTERAI_API_KEY)) {
    const descriptor = await buildDescriptor('routerai', null);
    descriptor.models = envTierModels();
    return descriptor;
  }
  return null;
}

/** Env-resolved tier models (ROUTERAI_MODEL_* — the original knobs, kept as the headless defaults). */
function envTierModels() {
  const models = {};
  const critical = process.env.ROUTERAI_MODEL_CRITICAL;
  const generation = process.env.ROUTERAI_MODEL_GENERATION;
  const standard = process.env.ROUTERAI_MODEL_STANDARD;
  if (typeof critical === 'string' && critical.trim()) models.critical = critical.trim();
  if (typeof generation === 'string' && generation.trim()) models.generation = generation.trim();
  if (typeof standard === 'string' && standard.trim()) models.standard = standard.trim();
  return models;
}

/**
 * Engine-facing resolution: NEVER throws and never returns null — the call
 * site keeps the original semantics (a missing key surfaces as an honest error at
 * call time, exactly like the old ROUTERAI_API_KEY guard). DB errors degrade
 * to the env-default routerai descriptor.
 */
export async function resolveActiveProviderForEngine() {
  try {
    const provider = await resolveActiveProvider();
    if (provider) return provider;
  } catch (err) {
    // Never log key material; the message here is a DB/IO error only.
    console.error('[Providers] active provider resolution failed, falling back to env:', err?.message || err);
  }
  const descriptor = await buildDescriptor('routerai', null);
  descriptor.models = envTierModels();
  return descriptor;
}

/**
 * Cover (images) provider resolution (D9): only images-capable providers may
 * produce covers. Candidates: enabled rows with capability 'yes'; the
 * routerai env fallback counts when no enabled row qualifies. Capability
 * 'unknown' (openrouter/custom) requires an explicit enabled row with a key.
 * Returns { ok:true, kind, label, baseUrl, apiKey, coverModel } or
 * { ok:false, code:'cover_provider_images_unsupported' } — honest machine
 * code, no silent model/provider swap.
 */
export async function resolveCoverProvider() {
  const rows = await findProviderRows();
  const candidate = rows.find(
    (row) =>
      row.enabled &&
      isProviderKind(row.kind) &&
      PROVIDER_REGISTRY[row.kind].imagesCapability === 'yes' &&
      resolveProviderKey(row.kind, row).value,
  );
  if (candidate) {
    const descriptor = await buildDescriptor(candidate.kind, candidate);
    if (!descriptor.endpointRejected && descriptor.apiKey) {
      return {
        ok: true,
        kind: descriptor.kind,
        label: descriptor.label,
        baseUrl: descriptor.baseUrl,
        apiKey: descriptor.apiKey,
        coverModel: descriptor.models.cover ?? null,
      };
    }
  }

  if (isConfigured(process.env.ROUTERAI_API_KEY)) {
    const descriptor = await buildDescriptor('routerai', null);
    if (!descriptor.endpointRejected && descriptor.apiKey) {
      return {
        ok: true,
        kind: 'routerai',
        label: descriptor.label,
        baseUrl: descriptor.baseUrl,
        apiKey: descriptor.apiKey,
        coverModel: null,
      };
    }
  }

  return { ok: false, code: 'cover_provider_images_unsupported' };
}

/**
 * Honest fail-fast for the engine call site when a key-required provider
 * has no key anywhere. For routerai the message is byte-identical to the
 * original guard («ROUTERAI_API_KEY не настроен. …»); other kinds name their
 * own env key.
 */
export function missingProviderKeyError(descriptor) {
  const meta = PROVIDER_REGISTRY[descriptor.kind] ?? PROVIDER_REGISTRY.routerai;
  return new Error(`${meta.envKey} не настроен. Проверьте переменные окружения.`);
}

/**
 * The provider's pinned model for a role's tier, or undefined when the
 * tier is not assigned (caller/env resolution then rules). Mirrors the
 * tier normalization of resolveRoleModel (legacy 'hard' → critical).
 */
export function pinnedTierModel(tier, models) {
  if (!models) return undefined;
  if (tier === 'critical' || tier === 'hard') return models.critical;
  if (tier === 'generation') return models.generation;
  if (tier === 'standard') return models.standard;
  return undefined;
}

/**
 * Client-safe shape: strips the key value, keeps the mask facts
 * (keyConfigured/keySource). Everything the settings UI is allowed to see.
 */
export function toPublicProvider(descriptor) {
  return {
    kind: descriptor.kind,
    label: descriptor.label,
    baseUrl: descriptor.baseUrl,
    enabled: descriptor.enabled,
    keyConfigured: descriptor.keyConfigured,
    keySource: descriptor.keySource,
    envKey: PROVIDER_REGISTRY[descriptor.kind].envKey,
    endpointSource: descriptor.endpointSource,
    endpointRejected: Boolean(descriptor.endpointRejected),
    keyOptional: descriptor.keyOptional,
    imagesCapability: descriptor.imagesCapability,
    models: descriptor.models,
  };
}

/* ------------------------------------------------------------------ */
/*  Masked storage API (D10, docs/security.md §3): read/write ProviderConfig */
/*  rows. Key VALUES cross neither boundary: reads return the public   */
/*  (masked) shape, the plaintext key lives only in the local store.   */
/* ------------------------------------------------------------------ */

/** Typed storage error; `code` is a machine string the routes map to HTTP 400. */
export class ProviderConfigError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProviderConfigError';
    this.code = code;
  }
}

function requireProviderKind(kind) {
  if (!isProviderKind(kind)) {
    throw new ProviderConfigError('unknown_provider_kind', `Неизвестный провайдер: ${kind}`);
  }
}

/** The row of a kind (deterministic: earliest created) or null. */
async function findProviderRow(kind) {
  const prisma = await getPrisma();
  return prisma.providerConfig.findFirst({ where: { kind }, orderBy: { createdAt: 'asc' } });
}

/**
 * PUBLIC read (masked): one descriptor per registry kind, in PROVIDER_KINDS
 * order, merged with its DB row. Never contains key values.
 */
export async function listProviderDescriptors() {
  const rows = await findProviderRows();
  const descriptors = await Promise.all(
    PROVIDER_KINDS.map((kind) =>
      buildDescriptor(kind, rows.find((row) => row.kind === kind) ?? null),
    ),
  );
  return descriptors.map(toPublicProvider);
}

/**
 * INTERNAL read: full descriptor (incl. the resolved key value) for
 * server-side consumers only — probe, model catalog, engine wiring.
 * Never returned to a client by the routes.
 */
export async function getProviderDescriptor(kind) {
  requireProviderKind(kind);
  return await buildDescriptor(kind, await findProviderRow(kind));
}

/** Sanitizes a models patch into the stored shape {critical?,generation?,standard?,cover?}. */
function sanitizeModels(models) {
  const clean = {};
  if (!models || typeof models !== 'object' || Array.isArray(models)) return clean;
  for (const tier of ['critical', 'generation', 'standard', 'cover']) {
    const value = models[tier];
    if (typeof value === 'string' && value.trim()) clean[tier] = value.trim();
  }
  return clean;
}

/**
 * Masked write: upsert the row of `kind`.
 *
 * patch.baseUrl  — string (normalized, trailing slashes dropped). For custom
 *                  a non-empty baseUrl is REQUIRED (registry default is '');
 *                  null/'' on other kinds falls back to the registry default.
 * patch.apiKey   — write-only: non-empty string stores; absent keeps; with
 *                  clearApiKey:true the stored key is dropped.
 * patch.enabled  — true makes this THE single active provider (every other
 *                  row is disabled); false just disables this row.
 * patch.models   — {critical?,generation?,standard?,cover?}; empty/blank
 *                  tiers are dropped.
 *
 * Returns the PUBLIC (masked) descriptor of the saved kind. Throws
 * ProviderConfigError with a machine code on validation failures.
 */
export async function saveProviderConfig(kind, patch = {}) {
  requireProviderKind(kind);
  const meta = PROVIDER_REGISTRY[kind];
  const prisma = await getPrisma();
  const row = await findProviderRow(kind);

  // baseUrl: explicit string wins; absent keeps the stored value.
  // SEC-02: a stored URL is USER-SUPPLIED — it is validated by the endpoint
  // policy BEFORE it is written, and a fixed kind never accepts one at all.
  let baseUrl = row?.baseUrl ?? null;
  if (typeof patch.baseUrl === 'string') {
    const candidate = patch.baseUrl.trim().replace(/\/+$/, '') || null;
    if (candidate) {
      if (FIXED_PROVIDER_KINDS.includes(kind)) {
        throw new ProviderConfigError(
          'provider_url_not_allowed',
          'Для этого провайдера адрес задаётся только через переменные окружения',
        );
      }
      try {
        await validateProviderBaseUrl(kind, candidate, {
          allowPrivateNetwork: isPrivateNetworkAllowed(process.env),
        });
      } catch (err) {
        if (err instanceof ProviderUrlError) {
          throw new ProviderConfigError(err.code, err.message);
        }
        throw err;
      }
      baseUrl = candidate;
    } else {
      baseUrl = null;
    }
  }
  if (FIXED_PROVIDER_KINDS.includes(kind)) baseUrl = null;

  if (meta.kind === 'custom' && !baseUrl) {
    throw new ProviderConfigError('custom_base_url_required', 'Custom-провайдер требует baseUrl');
  }

  // apiKey: write-only field. Never logged, never returned.
  // SEC-04: what lands in the database is ciphertext, never plaintext.
  let apiKey = row?.apiKey ?? null;
  if (patch.clearApiKey === true) apiKey = null;
  else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    try {
      apiKey = encryptSecret(patch.apiKey.trim(), loadSecretKey());
    } catch (err) {
      // Fail closed: without a usable key file we must NOT store the secret
      // in the clear, so the write is refused instead.
      throw new ProviderConfigError(
        err instanceof SecretStoreError ? err.code : 'secret_key_unavailable',
        'Ключ провайдера не сохранён: не удалось обеспечить шифрование хранилища',
      );
    }
  }

  // models: full replacement of the assignment set (absent keeps stored).
  let modelsJson = row?.modelsJson ?? null;
  if (patch.models !== undefined) {
    const clean = sanitizeModels(patch.models);
    modelsJson = Object.keys(clean).length ? JSON.stringify(clean) : null;
  }

  const enabled = patch.enabled === undefined ? Boolean(row?.enabled) : Boolean(patch.enabled);

  // Single active provider: enabling this kind disables every other row.
  if (enabled) {
    await prisma.providerConfig.updateMany({ data: { enabled: false } });
  }

  const data = { baseUrl, apiKey, enabled, modelsJson };
  const savedRow = row
    ? await prisma.providerConfig.update({ where: { id: row.id }, data })
    : await prisma.providerConfig.create({ data: { kind, ...data } });

  return toPublicProvider(await buildDescriptor(kind, savedRow));
}

