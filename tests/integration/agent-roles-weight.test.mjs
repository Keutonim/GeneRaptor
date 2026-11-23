/**
 * GET /api/settings/agent-roles must expose an explicit
 * role weight so the settings screen can render the 11-step chain without
 * re-deriving the order on the client.
 *
 * Contract:
 *  - every role of the catalogue carries a numeric `weight`;
 *  - the weight equals the 1-based position of the role in the chain;
 *  - the weight comes from the catalogue, so a user prompt override (PUT)
 *    cannot change it.
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

const VALID_PROMPT = [
  'Ты авторский агент компании. Пиши статью от лица компании, опираясь только на карточку услуги.',
  'Соблюдай заданную структуру разделов, не выдумывай показания, противопоказания и регалии.',
  'Дополнительные требования к стилю изложения.',
].join(' ');

describe('GET /api/settings/agent-roles — chain weight', () => {
  it('returns a numeric weight per role equal to its chain position', async () => {
    const { status, body } = await call('GET', BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.roles).toHaveLength(11);

    body.data.roles.forEach((role, index) => {
      expect(typeof role.weight).toBe('number');
      expect(Number.isInteger(role.weight)).toBe(true);
      expect(role.weight).toBe(index + 1);
      expect(role.weight).toBe(agentRoleData[index].weight);
    });
  });

  it('weights cover the whole 11-role chain in catalogue order', async () => {
    const { body } = await call('GET', BASE);

    expect(body.data.roles.map((role) => role.weight)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(body.data.roles.map((role) => role.id)).toEqual(
      agentRoleData.map((role) => role.id),
    );
  });

  it('a prompt override does not change the weight', async () => {
    const put = await call('PUT', BASE, {
      body: { roleId: 'article-author', systemPrompt: VALID_PROMPT },
    });
    expect(put.status).toBe(200);

    const { body } = await call('GET', BASE);
    const author = body.data.roles.find((role) => role.id === 'article-author');
    const catalogAuthor = agentRoleData.find((role) => role.id === 'article-author');

    expect(author.source).toBe('override');
    expect(catalogAuthor.weight).toBe(7);
    expect(author.weight).toBe(catalogAuthor.weight);
  });
});
