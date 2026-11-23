// Runs on SQLite with the in-process runner (no external services).
/**
 * Integration tests: API ролей агентов (роуты ролей и их веса).
 *
 * GET    /api/settings/agent-roles      → 11 ролей каталога + effective systemPrompt
 * PUT    /api/settings/agent-roles      → сохранить правку промпта (upsert)
 * DELETE /api/settings/agent-roles/:id  → сброс к каталогу (идемпотентно)
 *
 * Рides the real generaptor_test Postgres через createTestApp (helpers.mjs);
 * таблица agent_role_settings чистится truncateAll между кейсами.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  autoGenerationQueue: { add: vi.fn(), removeRepeatable: vi.fn() },
  addJob: vi.fn(),
}));

import { createTestApp, startServer, testPrisma, truncateAll } from '../helpers.mjs';
import { agentRoleData } from '../../server/agent-role-data.mjs';

let server;
let baseUrl;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testPrisma.agentRoleSetting.deleteMany();
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
});

async function call(method, path, { body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

const BASE = '/api/settings/agent-roles';

// Валидный промпт владельца: длиннее 200 символов, без API-ключей.
const VALID_PROMPT = [
  'Ты авторский агент компании. Пиши статью от лица компании, опираясь только на карточку услуги.',
  'Соблюдай заданную структуру разделов, не выдумывай показания, противопоказания и регалии.',
  'Дополнительные требования к стилю изложения.',
].join(' ');

describe('GET /api/settings/agent-roles', () => {
  it('200 + 11 ролей каталога в порядке server/agent-role-data.mjs, все source=catalog', async () => {
    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.roles)).toBe(true);
    expect(body.data.roles).toHaveLength(11);
    expect(agentRoleData).toHaveLength(11);

    body.data.roles.forEach((role, index) => {
      expect(typeof role.id).toBe('string');
      expect(typeof role.nameRu).toBe('string');
      expect(typeof role.systemPrompt).toBe('string');
      expect(role.systemPrompt.length).toBeGreaterThan(0);
      expect(role.source).toBe('catalog');
      expect(role.updatedAt).toBeNull();
      // Порядок ролей совпадает со статическим каталогом.
      expect(role.id).toBe(agentRoleData[index].id);
    });
  });

  it('промпты приходят целиком (как в каталоге)', async () => {
    const { body } = await call('GET', BASE);
    const author = body.data.roles.find((r) => r.id === 'article-author');
    const catalog = agentRoleData.find((r) => r.id === 'article-author');

    expect(author.systemPrompt).toBe(catalog.systemPrompt);
  });
});

describe('PUT /api/settings/agent-roles', () => {
  it('валидный промпт → 200; GET показывает source=override и присланный текст', async () => {
    const put = await call('PUT', BASE, {
      body: { roleId: 'article-author', systemPrompt: VALID_PROMPT },
    });

    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    expect(put.body.data).toMatchObject({
      roleId: 'article-author',
      systemPrompt: VALID_PROMPT,
      source: 'override',
    });
    expect(typeof put.body.data.updatedAt).toBe('string');

    const get = await call('GET', BASE);
    const author = get.body.data.roles.find((r) => r.id === 'article-author');
    expect(author.source).toBe('override');
    expect(author.systemPrompt).toBe(VALID_PROMPT);
    expect(typeof author.updatedAt).toBe('string');

    // Строка действительно в БД.
    const row = await testPrisma.agentRoleSetting.findUnique({
      where: { roleId: 'article-author' },
    });
    expect(row).toBeTruthy();
    expect(row.systemPrompt).toBe(VALID_PROMPT);
  });

  it('неизвестный roleId → 400 «Неизвестная роль агента», в БД пусто', async () => {
    const { status, body } = await call('PUT', BASE, {
      body: { roleId: 'no-such-role', systemPrompt: VALID_PROMPT },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Неизвестная роль агента');

    const rows = await testPrisma.agentRoleSetting.findMany();
    expect(rows).toHaveLength(0);
  });

  it('слишком короткий промпт → 400, в БД пусто', async () => {
    const { status, body } = await call('PUT', BASE, {
      body: { roleId: 'article-author', systemPrompt: 'Слишком коротко.' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Промпт слишком короткий (минимум 200 символов)');

    const rows = await testPrisma.agentRoleSetting.findMany();
    expect(rows).toHaveLength(0);
  });

  it('fix1 QA-P2-2: промпт 8001 символ принимается — лимит поднят до 10000 (заводской промпт «Агента автора» 8308)', async () => {
    const { status, body } = await call('PUT', BASE, {
      body: { roleId: 'article-author', systemPrompt: 'я'.repeat(8001) },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ roleId: 'article-author', source: 'override' });

    const row = await testPrisma.agentRoleSetting.findUnique({
      where: { roleId: 'article-author' },
    });
    expect(row).toBeTruthy();
    expect(row.systemPrompt).toHaveLength(8001);
  });

  it('слишком длинный промпт (10001 > 10000) → 400, в БД пусто', async () => {
    const { status, body } = await call('PUT', BASE, {
      body: { roleId: 'article-author', systemPrompt: 'я'.repeat(10001) },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Промпт слишком длинный (максимум 10000 символов)');

    const rows = await testPrisma.agentRoleSetting.findMany();
    expect(rows).toHaveLength(0);
  });

  it('промпт с API-ключом → 400 «Промпт не должен содержать API-ключи»', async () => {
    const { status, body } = await call('PUT', BASE, {
      body: {
        roleId: 'article-author',
        systemPrompt: `${VALID_PROMPT} Используй ключ sk-abcdefghijklmnopqrstuvwxyz123456 для доступа.`,
      },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Промпт не должен содержать API-ключи');

    const rows = await testPrisma.agentRoleSetting.findMany();
    expect(rows).toHaveLength(0);
  });
});

describe('DELETE /api/settings/agent-roles/:roleId', () => {
  it('200 + GET снова показывает source=catalog и каталожный промпт', async () => {
    const put = await call('PUT', BASE, {
      body: { roleId: 'article-author', systemPrompt: VALID_PROMPT },
    });
    expect(put.status).toBe(200);

    const del = await call('DELETE', `${BASE}/article-author`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
    expect(del.body.data).toMatchObject({ roleId: 'article-author', source: 'catalog' });

    const get = await call('GET', BASE);
    const author = get.body.data.roles.find((r) => r.id === 'article-author');
    expect(author.source).toBe('catalog');
    expect(author.systemPrompt).toBe(
      agentRoleData.find((r) => r.id === 'article-author').systemPrompt
    );
    expect(author.updatedAt).toBeNull();

    const rows = await testPrisma.agentRoleSetting.findMany();
    expect(rows).toHaveLength(0);
  });

  it('идемпотентно: повторный DELETE без строки → тоже 200', async () => {
    const first = await call('DELETE', `${BASE}/humanizer`);
    expect(first.status).toBe(200);

    const second = await call('DELETE', `${BASE}/humanizer`);
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
  });

  it('неизвестный roleId → 404 «Неизвестная роль агента» (D4), БД не тронута', async () => {
    const del = await call('DELETE', `${BASE}/такой-роли-нет`);

    expect(del.status).toBe(404);
    expect(del.body.success).toBe(false);
    expect(del.body.error).toBe('Неизвестная роль агента');

    const rows = await testPrisma.agentRoleSetting.findMany();
    expect(rows).toHaveLength(0);
  });

  it('DELETE по id, которого нет в каталоге, не создаёт запись в БД', async () => {
    const del = await call('DELETE', `${BASE}/some-unknown-role`);

    expect(del.status).toBe(404);
    const rows = await testPrisma.agentRoleSetting.findMany();
    expect(rows).toHaveLength(0);
  });
});
