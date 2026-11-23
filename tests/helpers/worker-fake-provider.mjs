/**
 * Test doubles for the REAL article-generation worker.
 *
 * `server/workers/article-generation.mjs` talks to RouterAI through an
 * OpenAI-compatible HTTP API. To exercise the worker end-to-end without real
 * keys and without touching the network we need three things:
 *
 *  1. a local fake provider (127.0.0.1, ephemeral port) that answers per role —
 *     every role prompt carries the marker «- Идентификатор роли: <id>», so the
 *     fake can serve the canned structured output of exactly that role;
 *  2. a fetch guard that hard-blocks every non-loopback request — the worker
 *     always runs its research stage (the web-search backends are NOT
 *     key-gated), so without a guard a test would try to reach the internet;
 *  3. role fixtures whose article body is longer than the production threshold
 *     (>500 chars) that the quality-gate branch uses to decide between
 *     `needs_review` and `failed`
 *     (`server/workers/article-generation.mjs:2206`).
 *
 * No production file is modified by this helper — it is test-only scaffolding.
 */
import { createServer } from 'node:http';

import { ALL_ROLE_IDS, roleOutputs } from '../fixtures/role-outputs.mjs';

export { ALL_ROLE_IDS };

/** Marker the worker puts into every role prompt (see buildRoleExecutionMessages). */
const ROLE_MARKER_RE = /Идентификатор\s+роли:\s*([a-z0-9][a-z0-9-]*)/i;

/**
 * Article body longer than the production threshold (>500 chars) used by the
 * quality-gate branch. The shared fixture body is 450 chars, which would push
 * the worker into the `failed` branch instead of `needs_review`.
 */
export const LONG_ARTICLE_MARKDOWN = [
  '# Имплантация зубов: полное руководство',
  '',
  '## Введение',
  '',
  'Имплантация — современный метод восстановления утраченных зубов. Титановый винт интегрируется в костную ткань и служит надёжной опорой для коронки, возвращая пациенту полноценную жевательную функцию и естественный вид.',
  '',
  '## Этапы лечения',
  '',
  '1. Консультация и компьютерная диагностика с расчётом объёма костной ткани.',
  '2. Хирургический этап — установка импланта под местной анестезией по навигационному шаблону.',
  '3. Ортопедический этап — установка абатмента и постоянной коронки из диоксида циркония.',
  '',
  '## Реабилитация',
  '',
  'После операции следует соблюдать рекомендации врача: ограничить нагрузку на челюсть в первые дни, тщательно соблюдать гигиену и приходить на контрольные осмотры в назначенные сроки. Процесс приживления занимает от 3 до 6 месяцев, поэтому врач наблюдает пациента до момента полной интеграции импланта.',
  '',
  '## Стоимость',
  '',
  'Итоговая стоимость складывается из выбранной имплантологической системы, хирургического шаблона, количества коронок и сопутствующих процедур. Точную смету пациент получает после диагностики и обсуждения плана лечения в компании.',
  '',
].join('\n');

/** FAQ block for the non-role «10 необычных вопросов» service call of the worker. */
export const FAQ_RESPONSE = {
  items: Array.from({ length: 10 }, (_, index) => ({
    question: `Вопрос ${index + 1} об имплантации зубов?`,
    answer: `Ответ ${index + 1}: это тестовый ответ осторожной стоматологической компании.`,
  })),
};

/**
 * Build per-role structured outputs for the fake provider.
 *
 * @param {{finalizationAllowed?: boolean}} [options]
 *   finalizationAllowed=false makes the quality-controller block finalization
 *   (the real quality gate of the worker).
 */
export function buildRoleOutputs({ finalizationAllowed = true } = {}) {
  const outputs = JSON.parse(JSON.stringify(roleOutputs));
  outputs['article-author'].articleMarkdownRu = LONG_ARTICLE_MARKDOWN;
  outputs.factchecker.checkedArticleMarkdownRu = LONG_ARTICLE_MARKDOWN;
  outputs.humanizer.finalArticleMarkdownRu = LONG_ARTICLE_MARKDOWN;
  outputs['quality-controller'].finalizationAllowed = finalizationAllowed;
  outputs['quality-controller'].criticalIssuesRu = finalizationAllowed
    ? []
    : ['Черновик требует доработки перед публикацией.'];
  return outputs;
}

/** Extract the role id from a chat-completions request body. */
export function extractRoleId(bodyJson) {
  const messages = Array.isArray(bodyJson?.messages) ? bodyJson.messages : [];
  for (const message of messages) {
    const content = typeof message?.content === 'string' ? message.content : '';
    const match = content.match(ROLE_MARKER_RE);
    if (match) return match[1];
  }
  return null;
}

/**
 * Start a local OpenAI-compatible fake provider.
 *
 * @param {(ctx: {roleId: string|null, bodyJson: object, index: number}) =>
 *   ({status?: number, json?: object, content?: string})} respond
 * @returns {Promise<{baseUrl: string, requests: object[], chatRequests: () => object[],
 *   roleCallCounts: () => Record<string, number>, stop: () => Promise<void>}>}
 */
export async function startRoleAwareFakeProvider({ respond }) {
  const requests = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let bodyJson = null;
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        bodyJson = null;
      }

      const roleId = extractRoleId(bodyJson);
      requests.push({
        method: req.method,
        url: req.url,
        roleId,
        model: bodyJson?.model ?? null,
        stream: Boolean(bodyJson?.stream),
        auth: req.headers.authorization || null,
        bodyJson,
      });

      if (req.method === 'GET' && req.url.replace(/\/+$/, '') === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: ['fake-critical', 'fake-gen', 'fake-std'].map((id) => ({ id, object: 'model' })),
          }),
        );
        return;
      }

      if (req.method === 'POST' && req.url.replace(/\/+$/, '') === '/v1/chat/completions') {
        const outcome = respond({ roleId, bodyJson, index: requests.length }) || {};
        const status = outcome.status ?? 200;
        const model = bodyJson?.model ?? 'fake-model';

        if (status >= 400) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(outcome.json ?? { error: { message: `fake provider error ${status}` } }));
          return;
        }

        const content = outcome.content ?? JSON.stringify(outcome.json ?? {});
        const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };

        if (bodyJson?.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({ id: 'fake-stream', model, choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ id: 'fake-stream', model, choices: [{ index: 0, delta: { content } }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ id: 'fake-stream', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
          );
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
            usage,
          }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const chatRequests = () => requests.filter((r) => r.url.includes('/chat/completions'));

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    chatRequests,
    roleCallCounts() {
      const counts = {};
      for (const request of chatRequests()) {
        const key = request.roleId ?? '(no-role)';
        counts[key] = (counts[key] || 0) + 1;
      }
      return counts;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Block every non-loopback HTTP request made by the worker under test.
 *
 * The research stage of the worker is not key-gated, so without this guard a
 * test run would reach the web-search backends over the real network.
 * Loopback (the fake provider) stays allowed.
 */
export function installLoopbackOnlyFetchGuard() {
  const originalFetch = globalThis.fetch;
  const blocked = [];

  globalThis.fetch = async function guardedFetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input?.url ?? String(input));
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = '';
    }

    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
      return originalFetch.call(globalThis, input, init);
    }

    blocked.push(url);
    // The message must NOT match the research modules' retryable-network-error
    // pattern (/fetch failed|ECONNRESET|...|network|terminated/i) — otherwise
    // the web-search backends would sleep through their exponential backoff and
    // the test would take tens of seconds instead of failing fast.
    throw new Error(`[test-guard] outbound request denied: ${url}`);
  };

  return {
    blocked,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
