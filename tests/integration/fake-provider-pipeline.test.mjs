/**
 * M3 integration tests against a REAL fake OpenAI-compatible server
 * (two kinds: with /models and without /models).
 *
 * Covered ACs:
 *   1. engine full role-pipeline run completes — every role of the current
 *      agent catalog executes through the real engine call path
 *      (buildRoleExecutionPayload → callRouterAIWithFallbackChain → SSE or
 *      JSON parsing) against a local fake provider, with the provider's
 *      tier assignments pinned per role; run against BOTH fake kinds;
 *   2. ping returns ok/warning/error with latency — probeOpenAICompatible
 *      over real loopback HTTP: ok via GET /models, ok via the 1-token chat
 *      fallback when /models is absent, error on 401;
 *   3. model ping exercises EXACTLY the chosen model (chat/completions);
 *   4. switching the active ProviderConfig row changes engine resolution;
 *   5. env-fallback works headless: no DB rows + ROUTERAI_ENDPOINT/API_KEY
 *      → the engine calls the env endpoint with the env key.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/client';

import { agentRoleData } from '../../server/agent-role-data.mjs';
import { callRouterAIWithFallbackChain } from '../../server/agent-role-execution.mjs';
import { probeOpenAICompatible } from '../../server/lib/api-key-probe.mjs';

const prisma = new PrismaClient({ log: ['error'] });

const ENV_KEYS = [
  'ROUTERAI_API_KEY',
  'ROUTERAI_ENDPOINT',
  'ROUTERAI_MODEL_CRITICAL',
  'ROUTERAI_MODEL_GENERATION',
  'ROUTERAI_MODEL_STANDARD',
  'OPENROUTER_API_KEY',
  'OLLAMA_API_KEY',
  'CUSTOM_API_KEY',
];

/**
 * Fake OpenAI-compatible provider on 127.0.0.1 (ephemeral port).
 *
 * opts.withModels — GET /v1/models serves the catalog; otherwise 404 (the
 *   "without /models" kind: probe must fall back to a 1-token chat).
 * opts.requireKey — when set, requests with a different/absent Bearer get
 *   401 (auth-failure probe path).
 * opts.catalog — model ids listed by /models.
 */
async function startFakeProvider(opts = {}) {
  const { withModels = true, requireKey = null, catalog = ['fake-critical', 'fake-gen', 'fake-std'] } = opts;
  const requests = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let bodyJson = null;
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        bodyJson = null;
      }
      const auth = req.headers.authorization || null;
      requests.push({ method: req.method, url: req.url, auth, bodyJson });

      if (requireKey !== null && auth !== `Bearer ${requireKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }

      if (req.method === 'GET' && req.url.replace(/\/+$/, '') === '/v1/models') {
        if (!withModels) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'no /models endpoint' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: catalog.map((id) => ({ id, object: 'model' })) }));
        return;
      }

      if (req.method === 'POST' && req.url.replace(/\/+$/, '') === '/v1/chat/completions') {
        const model = bodyJson?.model ?? 'unknown';
        const content = `значимый ответ модели ${model}`;
        if (bodyJson?.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ id: 'fake-stream', model, choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'fake-stream', model, choices: [{ index: 0, delta: { content } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'fake-stream', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'fake-completion',
            model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const basePayloadFor = (roleId) => ({ model: 'env-default-model', stream: false, messages: [{ role: 'user', content: 'hi' }] });

let fakes = [];

beforeEach(async () => {
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
  // SEC-02: the fake provider lives on 127.0.0.1 — a stored loopback endpoint
  // is denied by default, so this suite models the operator opt-in.
  vi.stubEnv('GENERAPTOR_ALLOW_PRIVATE_NETWORK', 'true');
  await prisma.providerConfig.deleteMany();
  fakes = [];
});

afterEach(async () => {
  for (const fake of fakes) await fake.stop();
  vi.unstubAllEnvs();
  await prisma.providerConfig.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  const { prisma: sharedPrisma } = await import('../../server/db.mjs');
  await sharedPrisma.$disconnect();
});

/** Runs EVERY role of the current engine catalog through the real call path. */
async function runFullRolePipeline() {
  const outcomes = [];
  for (const role of agentRoleData) {
    const payload = basePayloadFor(role.id);
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };
    const result = await callRouterAIWithFallbackChain(payload, { roleId: role.id, chainInfo });
    outcomes.push({ role, result, chainInfo });
  }
  return outcomes;
}

describe('M3 AC: engine full role-pipeline against a fake provider', () => {
  it('completes every catalog role via a fake WITH /models, tier models pinned per provider assignment', async () => {
    const fake = await startFakeProvider({ withModels: true });
    fakes.push(fake);
    await prisma.providerConfig.create({
      data: {
        kind: 'custom',
        baseUrl: fake.baseUrl,
        apiKey: 'sk-fake-local-key',
        enabled: true,
        modelsJson: JSON.stringify({ critical: 'fake-critical', generation: 'fake-gen', standard: 'fake-std' }),
      },
    });

    const outcomes = await runFullRolePipeline();

    expect(agentRoleData.length).toBeGreaterThanOrEqual(11); // 13 pre-M2, 11 after
    for (const { role, result, chainInfo } of outcomes) {
      expect(result.status, `role ${role.id} HTTP status`).toBe(200);
      expect(chainInfo.model, `role ${role.id} executed a model`).toBeTruthy();
      // Tier pinning: the provider's assignment rules the role's tier.
      const expected =
        role.modelTier === 'critical' || role.modelTier === 'hard'
          ? 'fake-critical'
          : role.modelTier === 'generation'
            ? 'fake-gen'
            : role.modelTier === 'standard'
              ? 'fake-std'
              : chainInfo.model;
      expect(chainInfo.model, `role ${role.id} tier ${role.modelTier}`).toBe(expected);
    }
    // The engine really talked to the fake (stream and/or non-stream).
    const chatCalls = fake.requests.filter((r) => r.url.includes('/chat/completions'));
    expect(chatCalls.length).toBeGreaterThanOrEqual(agentRoleData.length);
    expect(fake.requests.some((r) => r.auth === 'Bearer sk-fake-local-key')).toBe(true);
  });

  it('completes every catalog role via a fake WITHOUT /models (no /models dependency in the hot path)', async () => {
    const fake = await startFakeProvider({ withModels: false });
    fakes.push(fake);
    await prisma.providerConfig.create({
      data: { kind: 'custom', baseUrl: fake.baseUrl, apiKey: 'k', enabled: true },
    });

    const outcomes = await runFullRolePipeline();

    for (const { role, result } of outcomes) {
      expect(result.status, `role ${role.id} HTTP status`).toBe(200);
    }
    expect(fake.requests.some((r) => r.method === 'GET' && r.url.includes('/models'))).toBe(false);
  });
});

describe('M3 AC: ping ok/warning/error + latency (real loopback HTTP)', () => {
  it('ok via GET /models when the endpoint exists', async () => {
    const fake = await startFakeProvider({ withModels: true, requireKey: 'sk-ping' });
    fakes.push(fake);

    const result = await probeOpenAICompatible('sk-ping', { baseUrl: fake.baseUrl, label: 'Fake' });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fake.requests.some((r) => r.method === 'GET' && r.url.includes('/models'))).toBe(true);
  });

  it('ok via the 1-token chat fallback when /models is absent (404)', async () => {
    const fake = await startFakeProvider({ withModels: false, requireKey: 'sk-ping' });
    fakes.push(fake);

    const result = await probeOpenAICompatible('sk-ping', {
      baseUrl: fake.baseUrl,
      label: 'Fake',
      fallbackModel: 'fake-std',
    });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    const chat = fake.requests.find((r) => r.url.includes('/chat/completions'));
    expect(chat).toBeTruthy();
    expect(chat.bodyJson.model).toBe('fake-std');
    expect(chat.bodyJson.max_tokens).toBe(1);
  });

  it('error on 401 (key rejected), latency present', async () => {
    const fake = await startFakeProvider({ withModels: true, requireKey: 'sk-right-key' });
    fakes.push(fake);

    const result = await probeOpenAICompatible('sk-wrong-key', { baseUrl: fake.baseUrl, label: 'Fake' });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.statusCode).toBe(401);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('M3 AC: model ping exercises the chosen model', () => {
  it('probes EXACTLY the requested model id through chat/completions', async () => {
    const fake = await startFakeProvider({ withModels: true, requireKey: 'sk-ping' });
    fakes.push(fake);

    const result = await probeOpenAICompatible('sk-ping', {
      baseUrl: fake.baseUrl,
      model: 'pinned-model-x',
      label: 'Fake',
    });

    expect(result.level).toBe('ok');
    const chat = fake.requests.filter((r) => r.url.includes('/chat/completions'));
    expect(chat).toHaveLength(1);
    expect(chat[0].bodyJson.model).toBe('pinned-model-x');
    expect(fake.requests.some((r) => r.url.includes('/models'))).toBe(false); // model ping skips /models
  });
});

describe('M3 AC: switching the active provider changes engine resolution', () => {
  it('callRouterAI retargets to the newly enabled provider row', async () => {
    const fakeA = await startFakeProvider({ withModels: true });
    const fakeB = await startFakeProvider({ withModels: true });
    fakes.push(fakeA, fakeB);

    await prisma.providerConfig.create({
      data: { kind: 'custom', baseUrl: fakeA.baseUrl, apiKey: 'key-a', enabled: true },
    });
    const first = await callRouterAIWithFallbackChain(basePayloadFor('factchecker'), { roleId: 'factchecker' });
    expect(first.status).toBe(200);
    expect(fakeA.requests.some((r) => r.url.includes('/chat/completions'))).toBe(true);

    // Switch: enable the second provider — the single-active write path.
    await prisma.providerConfig.updateMany({ data: { enabled: false } });
    await prisma.providerConfig.create({
      data: { kind: 'ollama', baseUrl: fakeB.baseUrl, enabled: true }, // keyless kind
    });
    const second = await callRouterAIWithFallbackChain(basePayloadFor('factchecker'), { roleId: 'factchecker' });
    expect(second.status).toBe(200);
    expect(fakeB.requests.some((r) => r.url.includes('/chat/completions'))).toBe(true);
    // The keyless provider was called WITHOUT an Authorization header.
    expect(fakeB.requests.every((r) => r.auth === null)).toBe(true);
  });
});

describe('M3 AC: env-fallback works headless', () => {
  it('no DB rows + ROUTERAI_ENDPOINT/ROUTERAI_API_KEY → engine calls the env endpoint with the env key', async () => {
    const fake = await startFakeProvider({ withModels: true, requireKey: 'sk-env-headless' });
    fakes.push(fake);

    vi.stubEnv('ROUTERAI_ENDPOINT', fake.baseUrl);
    vi.stubEnv('ROUTERAI_API_KEY', 'sk-env-headless');
    // No ProviderConfig rows at all (deleted in beforeEach) — headless.

    const result = await callRouterAIWithFallbackChain(basePayloadFor('seo-reviewer'), { roleId: 'seo-reviewer' });

    expect(result.status).toBe(200);
    const chat = fake.requests.find((r) => r.url.includes('/chat/completions'));
    expect(chat).toBeTruthy();
    expect(chat.auth).toBe('Bearer sk-env-headless');
  });
});
