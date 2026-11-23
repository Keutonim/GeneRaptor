/**
 * SEC-02 (CWE-918 / CWE-522): the outbound provider URL policy — the ONE place
 * that resolves and validates a provider endpoint and binds a key to it.
 *
 * Contract under test (server/lib/provider-url.mjs):
 *   - validateProviderBaseUrl(kind, url): http/https only, no credentials in the
 *     URL, no loopback/private/link-local/CGNAT/metadata targets for the
 *     user-supplied kinds, no DNS name that resolves to a private address, and
 *     an unresolvable host is rejected (fail closed);
 *   - ollama may talk to a loopback address, but not to an arbitrary LAN host;
 *   - GENERAPTOR_ALLOW_PRIVATE_NETWORK=true is the operator opt-in for private
 *     targets;
 *   - resolveProviderTarget(...): picks the effective endpoint (canonical /
 *     env / stored), validates it and binds the key to it — an env key never
 *     goes to a stored (user-supplied) URL, the custom kind never uses an env
 *     key, and a stored key only goes to the URL stored with it.
 */
import { describe, expect, it } from 'vitest';

import {
  ProviderUrlError,
  classifyHostname,
  classifyIp,
  isPrivateNetworkAllowed,
  resolveProviderTarget,
  validateProviderBaseUrl,
} from '../../server/lib/provider-url.mjs';

/** DNS stub: a fixed address list per host (no real resolver in unit tests). */
function resolver(map) {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses;
  };
}

const PUBLIC = resolver({ 'example.com': ['93.184.216.34'], 'provider.test': ['203.0.113.10'] });
const PRIVATE_DNS = resolver({ 'sneaky.example': ['10.1.2.3'] });

describe('classifyIp / classifyHostname', () => {
  it('classifies loopback, private, link-local, CGNAT and metadata ranges', () => {
    expect(classifyIp('127.0.0.1')).toBe('loopback');
    expect(classifyIp('127.5.5.5')).toBe('loopback');
    expect(classifyIp('10.0.0.1')).toBe('private');
    expect(classifyIp('172.16.0.1')).toBe('private');
    expect(classifyIp('172.31.255.255')).toBe('private');
    expect(classifyIp('192.168.1.1')).toBe('private');
    expect(classifyIp('169.254.169.254')).toBe('private');
    expect(classifyIp('100.64.0.1')).toBe('private');
    expect(classifyIp('0.0.0.0')).toBe('private');
    expect(classifyIp('::1')).toBe('loopback');
    expect(classifyIp('fd00::1')).toBe('private');
    expect(classifyIp('fe80::1')).toBe('private');
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('93.184.216.34')).toBe('public');

    expect(classifyHostname('localhost')).toBe('loopback');
    expect(classifyHostname('metadata.google.internal')).toBe('private');
    expect(classifyHostname('example.com')).toBe('public');
  });
});

describe('validateProviderBaseUrl', () => {
  it('rejects a non-http(s) scheme, credentials in the URL and garbage', async () => {
    await expect(validateProviderBaseUrl('custom', 'ftp://example.com/v1')).rejects.toMatchObject({
      code: 'provider_url_scheme',
    });
    await expect(validateProviderBaseUrl('custom', 'http://user:pass@example.com/v1')).rejects.toMatchObject({
      code: 'provider_url_credentials',
    });
    await expect(validateProviderBaseUrl('custom', 'not a url')).rejects.toMatchObject({
      code: 'provider_url_invalid',
    });
    await expect(validateProviderBaseUrl('custom', '')).rejects.toBeInstanceOf(ProviderUrlError);
  });

  it('rejects loopback and private targets for the user-supplied kinds', async () => {
    await expect(validateProviderBaseUrl('custom', 'http://127.0.0.1:11434')).rejects.toMatchObject({
      code: 'provider_url_private',
    });
    await expect(validateProviderBaseUrl('custom', 'http://localhost:11434')).rejects.toMatchObject({
      code: 'provider_url_private',
    });
    await expect(validateProviderBaseUrl('custom', 'http://10.1.2.3/v1')).rejects.toMatchObject({
      code: 'provider_url_private',
    });
    await expect(validateProviderBaseUrl('custom', 'http://192.168.0.10:8080/v1')).rejects.toMatchObject({
      code: 'provider_url_private',
    });
    await expect(
      validateProviderBaseUrl('custom', 'http://169.254.169.254/latest/meta-data/'),
    ).rejects.toMatchObject({ code: 'provider_url_private' });
    await expect(
      validateProviderBaseUrl('custom', 'http://metadata.google.internal/computeMetadata/v1/'),
    ).rejects.toMatchObject({ code: 'provider_url_private' });
  });

  it('rejects a DNS name that resolves to a private address', async () => {
    await expect(
      validateProviderBaseUrl('custom', 'http://sneaky.example/v1', { resolveHost: PRIVATE_DNS }),
    ).rejects.toMatchObject({ code: 'provider_url_private' });
  });

  it('rejects an unresolvable host (fail closed)', async () => {
    await expect(
      validateProviderBaseUrl('custom', 'http://attacker.example/v1', { resolveHost: PUBLIC }),
    ).rejects.toMatchObject({ code: 'provider_url_unresolved' });
  });

  it('accepts a public host', async () => {
    const resolved = await validateProviderBaseUrl('custom', 'https://example.com/v1/', {
      resolveHost: PUBLIC,
    });
    expect(resolved.baseUrl).toBe('https://example.com/v1');
  });

  it('allows a loopback target for ollama but not for an arbitrary LAN host', async () => {
    const loopback = await validateProviderBaseUrl('ollama', 'http://127.0.0.1:11434/v1');
    expect(loopback.baseUrl).toBe('http://127.0.0.1:11434/v1');

    await expect(
      validateProviderBaseUrl('ollama', 'http://192.168.0.10:11434/v1'),
    ).rejects.toMatchObject({ code: 'provider_url_private' });
  });

  it('honours the GENERAPTOR_ALLOW_PRIVATE_NETWORK opt-in', async () => {
    const allowed = await validateProviderBaseUrl('custom', 'http://127.0.0.1:11434', {
      allowPrivateNetwork: true,
    });
    expect(allowed.baseUrl).toBe('http://127.0.0.1:11434');
  });
});

describe('isPrivateNetworkAllowed', () => {
  it('is true only for the exact opt-in value', () => {
    expect(isPrivateNetworkAllowed({ GENERAPTOR_ALLOW_PRIVATE_NETWORK: 'true' })).toBe(true);
    expect(isPrivateNetworkAllowed({ GENERAPTOR_ALLOW_PRIVATE_NETWORK: 'TRUE' })).toBe(true);
    expect(isPrivateNetworkAllowed({ GENERAPTOR_ALLOW_PRIVATE_NETWORK: '1' })).toBe(false);
    expect(isPrivateNetworkAllowed({})).toBe(false);
  });
});

describe('resolveProviderTarget — endpoint selection + key binding', () => {
  const base = {
    defaultBaseUrl: 'https://routerai.ru/api/v1',
    envBaseUrl: null,
    storedBaseUrl: null,
    storedApiKey: null,
    envApiKey: null,
    resolveHost: PUBLIC,
  };

  it('ignores a stored URL for a fixed kind and keeps the canonical endpoint', async () => {
    const target = await resolveProviderTarget({
      ...base,
      kind: 'routerai',
      storedBaseUrl: 'http://attacker.example/v1',
      envApiKey: 'env-secret',
    });

    expect(target.baseUrl).toBe('https://routerai.ru/api/v1');
    expect(target.source).toBe('canonical');
    expect(target.apiKey).toBe('env-secret');
    expect(target.keySource).toBe('env');
  });

  it('uses the operator env endpoint for a fixed kind and binds the env key to it', async () => {
    const target = await resolveProviderTarget({
      ...base,
      kind: 'routerai',
      envBaseUrl: 'http://127.0.0.1:9103/v1',
      envApiKey: 'env-secret',
    });

    expect(target.baseUrl).toBe('http://127.0.0.1:9103/v1');
    expect(target.source).toBe('env');
    expect(target.apiKey).toBe('env-secret');
  });

  it('never sends an env key to a stored (user-supplied) endpoint', async () => {
    const target = await resolveProviderTarget({
      ...base,
      kind: 'custom',
      storedBaseUrl: 'https://example.com/v1',
      storedApiKey: 'stored-secret',
      envApiKey: 'env-secret',
    });

    expect(target.source).toBe('stored');
    expect(target.apiKey).toBe('stored-secret');
    expect(target.keySource).toBe('local');
  });

  it('never uses an env key for the custom kind', async () => {
    const target = await resolveProviderTarget({
      ...base,
      kind: 'custom',
      defaultBaseUrl: '',
      storedBaseUrl: 'https://example.com/v1',
      envApiKey: 'env-secret',
    });

    expect(target.apiKey).toBe('');
    expect(target.keySource).toBe('none');
    expect(target.keyConfigured).toBe(false);
  });

  it('rejects a stored endpoint that the policy blocks', async () => {
    await expect(
      resolveProviderTarget({
        ...base,
        kind: 'custom',
        defaultBaseUrl: '',
        storedBaseUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toMatchObject({ code: 'provider_url_private' });
  });

  it('rejects a custom kind without any endpoint', async () => {
    await expect(
      resolveProviderTarget({ ...base, kind: 'custom', defaultBaseUrl: '' }),
    ).rejects.toMatchObject({ code: 'provider_url_required' });
  });
});
