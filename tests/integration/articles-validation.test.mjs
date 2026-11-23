/**
 * Integration tests for POST /api/articles — topic-only creation with the
 * material-language parameter (docs/ui-design.md §5).
 *
 * Creation contract after M2:
 *   - { topic, targetLength, userNotes?, language? } ONLY — crawled sources
 *     (serviceId/specialistId/sourceSiteId) are gone; wordstat keys are gone.
 *   - language: 'ru' (default) | 'en' — stored with the article (D6 engine side).
 *
 * Strategy: real Express app on an ephemeral port (app.listen(0)) + node fetch,
 * real SQLite test DB (tests/global-setup.mjs). No supertest dependency.
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

// A topic long enough to pass the >=3 chars rule.
const VALID_TOPIC = 'Laser skin resurfacing: complete guide';
// A volume from the allowed set (server/lib/article-volume.mjs).
const VALID_VOLUME = 50000;

describe('POST /api/articles — topic-only creation (M2)', () => {
  it('creates an article from {topic, targetLength, userNotes} only -> 201', async () => {
    const { status, body } = await postArticle({
      topic: VALID_TOPIC,
      targetLength: VALID_VOLUME,
      userNotes: '  Focus on recovery time  ',
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.topic).toBe(VALID_TOPIC);
    expect(body.data.targetLength).toBe(VALID_VOLUME);
    // userNotes is stored trimmed
    expect(body.data.userNotes).toBe('Focus on recovery time');

    const row = await testPrisma.article.findFirst({ where: { topic: VALID_TOPIC } });
    expect(row).toBeTruthy();
    expect(row.userNotes).toBe('Focus on recovery time');
    expect(row.language).toBe('ru'); // D6 default
  });

  it('bare {topic, targetLength} (no userNotes) -> 201 with null userNotes', async () => {
    const { status } = await postArticle({
      topic: VALID_TOPIC,
      targetLength: VALID_VOLUME,
    });
    expect(status).toBe(201);
    const row = await testPrisma.article.findFirst({ where: { topic: VALID_TOPIC } });
    expect(row.userNotes).toBeNull();
  });

  it('no source/service/specialist is required anymore (the M2 gate removal)', async () => {
    // The old contract rejected this with «Укажите источник, услугу или
    // специалиста» — GeneRaptor creation is topic-only.
    const { status, body } = await postArticle({
      topic: VALID_TOPIC,
      targetLength: VALID_VOLUME,
    });
    expect(status).toBe(201);
    expect(body.error || '').not.toMatch(/источник/i);
  });

  it('rejects a missing topic (400)', async () => {
    const { status } = await postArticle({ targetLength: VALID_VOLUME });
    expect(status).toBe(400);
  });

  it('rejects a topic shorter than 3 characters (400)', async () => {
    const { status } = await postArticle({ topic: 'ab', targetLength: VALID_VOLUME });
    expect(status).toBe(400);
  });

  it('rejects a missing targetLength (400)', async () => {
    const { status } = await postArticle({ topic: VALID_TOPIC });
    expect(status).toBe(400);
  });

  it('rejects a targetLength outside the allowed volumes (400)', async () => {
    const { status } = await postArticle({ topic: VALID_TOPIC, targetLength: 12345 });
    expect(status).toBe(400);
  });
});

describe('POST /api/articles — language parameter (D6)', () => {
  it('language "en" is accepted and stored', async () => {
    const { status, body } = await postArticle({
      topic: VALID_TOPIC,
      targetLength: VALID_VOLUME,
      language: 'en',
    });
    expect(status).toBe(201);
    expect(body.data.language).toBe('en');
    const row = await testPrisma.article.findFirst({ where: { topic: VALID_TOPIC } });
    expect(row.language).toBe('en');
  });

  it('language defaults to "ru" when omitted', async () => {
    const { status, body } = await postArticle({
      topic: VALID_TOPIC,
      targetLength: VALID_VOLUME,
    });
    expect(status).toBe(201);
    expect(body.data.language).toBe('ru');
  });

  it('rejects an unsupported language (400)', async () => {
    const { status } = await postArticle({
      topic: VALID_TOPIC,
      targetLength: VALID_VOLUME,
      language: 'de',
    });
    expect(status).toBe(400);
  });
});

describe('POST /api/articles — userNotes (B3, unchanged)', () => {
  it('rejects userNotes over 1000 chars with USER_NOTES_TOO_LONG (400)', async () => {
    const { status, body } = await postArticle({
      topic: VALID_TOPIC,
      targetLength: VALID_VOLUME,
      userNotes: 'x'.repeat(1001),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('USER_NOTES_TOO_LONG');
  });
});
