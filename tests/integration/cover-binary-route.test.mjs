/**
 * The cover binary route (docs/ui-design.md §12).
 *
 * GET /api/articles/:id/cover serves the stored cover bytes with the right
 * content type; POST on the same path triggers the generation. The DB keeps
 * the file reference (cover_file), the bytes live under <data-dir>/covers/.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestApp, startServer, truncateAll, testPrisma } from '../helpers.mjs';
import { COVERS_DIR_NAME } from '../../server/lib/cover-store.mjs';

const IMAGE_BYTES = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic bytes

let server;
let baseUrl;
let dataDir;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await truncateAll();
  dataDir = mkdtempSync(join(tmpdir(), 'gr-cover-route-'));
  vi.stubEnv('GENERAPTOR_DATA_DIR', dataDir);
  mkdirSync(join(dataDir, COVERS_DIR_NAME), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/articles/:id/cover', () => {
  it('serves the stored cover bytes with the right content type', async () => {
    const article = await testPrisma.article.create({
      data: { topic: 'Чистка лица', targetLength: 1000 },
    });
    const filename = `${article.id}-1.png`;
    writeFileSync(join(dataDir, COVERS_DIR_NAME, filename), IMAGE_BYTES);
    await testPrisma.article.update({
      where: { id: article.id },
      data: {
        coverFile: filename,
        coverUrl: `/api/articles/${article.id}/cover`,
        coverModel: 'qwen/qwen-image-2.1-pro',
      },
    });

    const res = await fetch(`${baseUrl}/api/articles/${article.id}/cover`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(IMAGE_BYTES)).toBe(true);
  });

  it('answers 404 with a machine code when the article has no cover', async () => {
    const article = await testPrisma.article.create({
      data: { topic: 'Без обложки', targetLength: 1000 },
    });

    const res = await fetch(`${baseUrl}/api/articles/${article.id}/cover`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('cover_not_found');
  });

  it('answers 404 when the file behind the reference is gone', async () => {
    const article = await testPrisma.article.create({
      data: { topic: 'Потерянный файл', targetLength: 1000 },
    });
    await testPrisma.article.update({
      where: { id: article.id },
      data: { coverFile: `${article.id}-9.png`, coverUrl: `/api/articles/${article.id}/cover` },
    });

    const res = await fetch(`${baseUrl}/api/articles/${article.id}/cover`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('cover_not_found');
  });

  it('answers 400 for a malformed article id', async () => {
    const res = await fetch(`${baseUrl}/api/articles/not-a-uuid/cover`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('cover_invalid_article_id');
  });
});
