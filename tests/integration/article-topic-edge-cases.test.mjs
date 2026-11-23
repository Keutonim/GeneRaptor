/**
 * Edge cases for POST /api/articles — the topic contract
 * (server/routes/articles.mjs, TOPIC_MAX_LENGTH = 200).
 *
 * The brief asks for the negative/edge topic cases to be covered:
 *   - an empty (blank) topic,
 *   - a very long topic (> TOPIC_MAX_LENGTH),
 *   - a unicode / Russian topic (must be ACCEPTED and stored verbatim).
 *
 * The boundary (exactly TOPIC_MAX_LENGTH) is pinned too: a limit that is
 * off-by-one in either direction is a silent product bug.
 *
 * Strategy: the real Express app on an ephemeral port + node fetch, the real
 * SQLite test DB (tests/global-setup.mjs). No supertest dependency.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, startServer, testPrisma, truncateAll } from '../helpers.mjs';

let server;
let baseUrl;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
});

/** POST helper — sends JSON and parses the JSON response. */
async function postArticle(body) {
  const res = await fetch(`${baseUrl}/api/articles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// A volume from the allowed set (server/lib/article-volume.mjs).
const VALID_VOLUME = 50000;
// The server-side limit (server/routes/articles.mjs).
const TOPIC_MAX_LENGTH = 200;

describe('POST /api/articles — topic edge cases', () => {
  it('rejects a blank (whitespace-only) topic with 400', async () => {
    const { status, body } = await postArticle({ topic: '   \n\t ', targetLength: VALID_VOLUME });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/Тема обязательна/);
  });

  it('rejects a topic longer than the limit with 400 and names the limit', async () => {
    const topic = 'я'.repeat(TOPIC_MAX_LENGTH + 1);
    const { status, body } = await postArticle({ topic, targetLength: VALID_VOLUME });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(`Тема слишком длинная (макс. ${TOPIC_MAX_LENGTH} символов)`);
  });

  it('accepts a topic of exactly the limit length (boundary)', async () => {
    const topic = 'я'.repeat(TOPIC_MAX_LENGTH);
    const { status } = await postArticle({ topic, targetLength: VALID_VOLUME });
    expect(status).toBe(201);
  });

  it('accepts a Russian / unicode topic and stores it verbatim', async () => {
    const topic = 'Лазерное омоложение кожи: мифы и реальность 🧬 — что говорит дерматолог';
    const { status, body } = await postArticle({ topic, targetLength: VALID_VOLUME });
    expect(status).toBe(201);
    expect(body?.data?.topic ?? body?.topic).toBe(topic);

    const stored = await testPrisma.article.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(stored.topic).toBe(topic);
  });

  it('trims the topic before storing it (leading/trailing whitespace)', async () => {
    const topic = '  Тема с пробелами по краям  ';
    const { status } = await postArticle({ topic, targetLength: VALID_VOLUME });
    expect(status).toBe(201);
    const stored = await testPrisma.article.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(stored.topic).toBe(topic.trim());
  });
});
