/**
 * SEC-02 (CWE-918 / CWE-522) — the ONE place that resolves, validates and
 * authorizes an outbound provider URL, and the ONE place that binds a provider
 * key to that URL.
 *
 * Threat model (AppSec round, docs/security.md §3.3):
 *   the provider `baseUrl` stored in the local DB is USER-SUPPLIED, while the
 *   provider key may come from the server environment. Before this module a
 *   stored baseUrl silently overrode the canonical endpoint of a fixed kind and
 *   the environment key still won the key resolution — so the server sent
 *   `ROUTERAI_API_KEY` to whatever host the stored URL pointed at.
 *
 * Rules enforced here:
 *   1. only http/https URLs, and never with credentials embedded;
 *   2. the fixed kinds (routerai, openrouter) never take a user-supplied URL —
 *      their endpoint is the operator-controlled one (registry default or the
 *      kind's canonical env override);
 *   3. for the user-supplied kinds (custom, ollama) a loopback / private /
 *      link-local / CGNAT / metadata target is rejected, including a DNS name
 *      that resolves to one (DNS rebinding is only partially mitigated — the
 *      answer is validated right before the request and cached for 60 s);
 *   4. a host that cannot be resolved is REJECTED (fail closed);
 *   5. ollama may talk to a loopback address (a local inference server), but
 *      not to an arbitrary LAN host;
 *   6. GENERAPTOR_ALLOW_PRIVATE_NETWORK=true is the operator opt-in that lifts
 *      the private-network restriction for the user-supplied kinds;
 *   7. key/URL binding: an environment key is only ever used with an
 *      operator-controlled endpoint (registry default or canonical env
 *      override) and NEVER with a stored, user-supplied URL; the `custom` kind
 *      has no canonical endpoint, so it never uses an environment key at all;
 *      a stored key is only ever sent to the URL it was stored with.
 *
 * No secret values are logged or returned here — only machine codes and
 * human-readable reasons.
 */
import dnsPromises from 'node:dns/promises';
import net from 'node:net';

/** Machine-readable error: `code` is what the HTTP layer maps to a status. */
export class ProviderUrlError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProviderUrlError';
    this.code = code;
  }
}

/** Kinds whose endpoint is fixed by the project (never user-supplied). */
export const FIXED_PROVIDER_KINDS = Object.freeze(['routerai', 'openrouter']);

/** Cloud metadata hosts — never a legitimate provider endpoint. */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

/** DNS answers are reused for this long (mitigates resolver churn). */
const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map();

/**
 * The operator opt-in that allows the user-supplied kinds to reach a private
 * network (e.g. a self-hosted gateway on the LAN).
 */
export function isPrivateNetworkAllowed(env = process.env) {
  return String(env?.GENERAPTOR_ALLOW_PRIVATE_NETWORK ?? '').trim().toLowerCase() === 'true';
}

/** Classifies an IP literal: 'loopback' | 'private' | 'public' | 'unknown'. */
export function classifyIp(address) {
  const value = String(address || '').trim().toLowerCase();
  const version = net.isIP(value);
  if (version === 4) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0) return 'private'; // 0.0.0.0/8 "this network"
    if (a === 127) return 'loopback'; // 127.0.0.0/8
    if (a === 10) return 'private'; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
    if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
    if (a === 169 && b === 254) return 'private'; // 169.254.0.0/16 (link-local + metadata)
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64.0.0/10 (CGNAT)
    return 'public';
  }
  if (version === 6) {
    if (value === '::1') return 'loopback';
    if (value === '::') return 'private';
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyIp(mapped[1]);
    const first = Number.parseInt(value.split(':')[0] || '0', 16);
    if (!Number.isFinite(first)) return 'unknown';
    if (first >= 0xfe80 && first <= 0xfebf) return 'private'; // fe80::/10 link-local
    if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique-local
    return 'public';
  }
  return 'unknown';
}

/** Classifies a hostname: 'loopback' | 'private' | 'public' | 'unknown'. */
export function classifyHostname(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (!host) return 'unknown';
  if (METADATA_HOSTNAMES.has(host)) return 'private';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (net.isIP(host)) return classifyIp(host);
  return 'public';
}

/** Strips credentials/fragments/queries and normalizes the trailing slash. */
function normalizeProviderBaseUrl(url) {
  const clone = new URL(url.toString());
  clone.hash = '';
  clone.search = '';
  clone.pathname = clone.pathname.replace(/\/+$/, '');
  return clone.toString().replace(/\/+$/, '');
}

/**
 * Structural validation of a provider URL: parseable, http/https, no embedded
 * credentials. Used for every endpoint, trusted or not.
 */
export function parseProviderBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new ProviderUrlError('provider_url_required', 'Адрес провайдера не задан');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderUrlError('provider_url_invalid', 'Адрес провайдера не является корректным URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderUrlError('provider_url_scheme', 'Адрес провайдера должен использовать http или https');
  }
  if (url.username || url.password) {
    throw new ProviderUrlError('provider_url_credentials', 'Адрес провайдера не должен содержать логин или пароль');
  }
  return url;
}

/**
 * Structural validation of an OPERATOR-controlled endpoint (registry default
 * or the kind's canonical env override). Such an endpoint is trusted — it is
 * not user input — but it still must be a clean http(s) URL.
 */
export function assertTrustedProviderEndpoint(raw) {
  return normalizeProviderBaseUrl(parseProviderBaseUrl(raw));
}

/** DNS lookup with a short cache; unresolvable hosts are rejected. */
async function resolveHostAddresses(hostname, resolveHost) {
  if (typeof resolveHost === 'function') {
    let addresses;
    try {
      addresses = await resolveHost(hostname);
    } catch {
      addresses = null;
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new ProviderUrlError('provider_url_unresolved', 'Не удалось определить адрес провайдера');
    }
    return addresses.map(String);
  }

  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.addresses;

  let addresses;
  try {
    const entries = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
    addresses = entries.map((entry) => entry.address);
  } catch {
    addresses = [];
  }
  if (!addresses.length) {
    throw new ProviderUrlError('provider_url_unresolved', 'Не удалось определить адрес провайдера');
  }
  dnsCache.set(hostname, { addresses, expires: Date.now() + DNS_CACHE_TTL_MS });
  return addresses;
}

/**
 * Full validation of a USER-SUPPLIED provider URL (the stored baseUrl).
 *
 * @param {string} kind      provider kind ('custom', 'ollama', …)
 * @param {string} rawUrl    the URL to validate
 * @param {object} [options]
 * @param {boolean} [options.allowPrivateNetwork] operator opt-in
 * @param {Function} [options.resolveHost] DNS stub (tests)
 * @returns {Promise<{baseUrl: string, hostname: string, classification: string, addresses?: string[]}>}
 */
export async function validateProviderBaseUrl(kind, rawUrl, options = {}) {
  const url = parseProviderBaseUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const classification = classifyHostname(hostname);

  if (classification === 'private' && !allowPrivateNetwork) {
    throw new ProviderUrlError('provider_url_private', 'Адрес провайдера указывает на внутреннюю сеть');
  }

  if (classification === 'loopback') {
    // ollama is a local inference server — loopback is its normal address.
    if (kind !== 'ollama' && !allowPrivateNetwork) {
      throw new ProviderUrlError('provider_url_private', 'Локальный адрес провайдера запрещён');
    }
    return { baseUrl: normalizeProviderBaseUrl(url), hostname, classification };
  }

  const addresses = await resolveHostAddresses(hostname, options.resolveHost);
  for (const address of addresses) {
    const addressClass = classifyIp(address);
    if (addressClass === 'public') continue;
    if (allowPrivateNetwork) continue;
    if (kind === 'ollama' && addressClass === 'loopback') continue;
    throw new ProviderUrlError('provider_url_private', 'Адрес провайдера указывает на внутреннюю сеть');
  }

  return { baseUrl: normalizeProviderBaseUrl(url), hostname, classification, addresses };
}

/**
 * Binds a provider key to the endpoint it may be sent to.
 *
 * @param {object} params
 * @param {string} params.kind
 * @param {boolean} params.fixed          fixed kind (routerai/openrouter)
 * @param {string} params.endpointSource  'canonical' | 'env' | 'stored'
 * @param {string} [params.storedApiKey]
 * @param {string} [params.envApiKey]
 * @returns {{value: string, source: 'env' | 'local' | 'none'}}
 */
export function bindProviderKey({ kind, fixed, endpointSource, storedApiKey, envApiKey }) {
  const stored = typeof storedApiKey === 'string' && storedApiKey.trim() ? storedApiKey.trim() : '';
  const env = typeof envApiKey === 'string' && envApiKey.trim() ? envApiKey.trim() : '';

  // The custom kind has no canonical endpoint → an env key can never be bound
  // to one, so it is never used.
  if (kind === 'custom') {
    return stored ? { value: stored, source: 'local' } : { value: '', source: 'none' };
  }

  // A user-supplied endpoint only ever receives the key stored WITH it.
  if (endpointSource === 'stored') {
    return stored ? { value: stored, source: 'local' } : { value: '', source: 'none' };
  }

  // An operator endpoint (canonical env override) only ever receives the
  // operator key — a stored key stays bound to its own (canonical) URL.
  if (endpointSource === 'env') {
    return env ? { value: env, source: 'env' } : { value: '', source: 'none' };
  }

  if (env) return { value: env, source: 'env' };
  if (fixed && stored) return { value: stored, source: 'local' };
  if (stored) return { value: stored, source: 'local' };
  return { value: '', source: 'none' };
}

/**
 * Resolves the effective endpoint of a provider and the key bound to it.
 *
 * @returns {Promise<{baseUrl: string, source: 'canonical'|'env'|'stored', apiKey: string, keySource: 'env'|'local'|'none', keyConfigured: boolean}>}
 */
export async function resolveProviderTarget(options = {}) {
  const {
    kind,
    defaultBaseUrl = '',
    envBaseUrl = null,
    storedBaseUrl = null,
    storedApiKey = null,
    envApiKey = null,
    allowPrivateNetwork = isPrivateNetworkAllowed(process.env),
    resolveHost,
  } = options;
  const fixed = options.fixed ?? FIXED_PROVIDER_KINDS.includes(kind);

  const stored = typeof storedBaseUrl === 'string' && storedBaseUrl.trim() ? storedBaseUrl.trim() : '';
  const env = typeof envBaseUrl === 'string' && envBaseUrl.trim() ? envBaseUrl.trim() : '';

  if (fixed) {
    // A stored URL is IGNORED for a fixed kind (it may be a legacy row) — the
    // endpoint stays the operator-controlled one.
    const effective = env || String(defaultBaseUrl || '').trim();
    if (!effective) {
      throw new ProviderUrlError('provider_url_required', 'Адрес провайдера не задан');
    }
    const baseUrl = assertTrustedProviderEndpoint(effective);
    const key = bindProviderKey({
      kind,
      fixed: true,
      endpointSource: env ? 'env' : 'canonical',
      storedApiKey,
      envApiKey,
    });
    return {
      baseUrl,
      source: env ? 'env' : 'canonical',
      apiKey: key.value,
      keySource: key.source,
      keyConfigured: Boolean(key.value),
    };
  }

  const effective = stored || String(defaultBaseUrl || '').trim();
  if (!effective) {
    throw new ProviderUrlError('provider_url_required', 'Адрес провайдера не задан');
  }
  const validated = await validateProviderBaseUrl(kind, effective, { allowPrivateNetwork, resolveHost });
  const source = stored ? 'stored' : 'canonical';
  const key = bindProviderKey({ kind, fixed: false, endpointSource: source, storedApiKey, envApiKey });
  return {
    baseUrl: validated.baseUrl,
    source,
    apiKey: key.value,
    keySource: key.source,
    keyConfigured: Boolean(key.value),
  };
}

/**
 * Endpoint resolution for the probe path — the probe receives an endpoint and
 * must apply the same policy as every other outbound call.
 *
 * @param {object} params
 * @param {string} [params.kind]
 * @param {string} params.baseUrl
 * @param {'canonical'|'env'|'stored'} [params.endpointSource]
 */
export async function resolveProbeEndpoint({ kind, baseUrl, endpointSource = 'canonical', allowPrivateNetwork, resolveHost }) {
  if (!baseUrl) {
    throw new ProviderUrlError('provider_url_required', 'Адрес провайдера не задан');
  }
  if (endpointSource === 'stored') {
    if (!kind) {
      throw new ProviderUrlError('provider_url_required', 'Неизвестный тип провайдера');
    }
    const validated = await validateProviderBaseUrl(kind, baseUrl, {
      allowPrivateNetwork: allowPrivateNetwork ?? isPrivateNetworkAllowed(process.env),
      resolveHost,
    });
    return validated.baseUrl;
  }
  return assertTrustedProviderEndpoint(baseUrl);
}
