/**
 * M6 — pure helper of the Settings → «Модели» table (docs/ui-design.md §8).
 *
 * Контракт под тестом: текстовые уровни (critical/generation/standard)
 * выводятся из каталога моделей провайдеров; число ролей на уровень считается
 * по локальному каталогу ролей (11 ролей: 4 critical, 5 generation, 2 standard).
 * S5 T6: строка cover — ПРОИЗВОДНАЯ от cover_settings.model (единственный
 * применяемый источник), а не от provider.models.cover; без загруженных
 * настроек обложки строки cover нет.
 */
import { describe, it, expect } from 'vitest';
import {
  buildModelRows,
  roleCountsByTier,
} from '../../src/features/settings/helpers/models';
import { agentRoles } from '../../src/data/agentRoles';

const PROVIDERS = [
  {
    kind: 'routerai',
    label: 'RouterAI',
    baseUrl: 'https://routerai.ru/api/v1',
    enabled: true,
    keyConfigured: true,
    keySource: 'local',
    envKey: 'ROUTERAI_API_KEY',
    keyOptional: false,
    imagesCapability: 'yes',
    models: {
      critical: 'qwen/qwen3.7-plus',
      generation: 'qwen/qwen3.6-flash',
      standard: 'deepseek/deepseek-v4-flash',
      cover: 'qwen/qwen-image-2.1-pro',
    },
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434',
    enabled: false,
    keyConfigured: false,
    keySource: 'none',
    envKey: null,
    keyOptional: true,
    imagesCapability: 'no',
    models: {},
  },
];

describe('roleCountsByTier — сколько ролей работает на уровне', () => {
  it('считает 4 critical, 5 generation, 2 standard по каталогу ролей', () => {
    expect(roleCountsByTier(agentRoles)).toEqual({ critical: 4, generation: 5, standard: 2 });
  });
});

describe('buildModelRows — таблица моделей', () => {
  it('даёт по строке на каждый уровень: critical, generation, standard, обложка', () => {
    const rows = buildModelRows(PROVIDERS, roleCountsByTier(agentRoles), 'qwen/qwen-image-2.1-pro');
    expect(rows.map((r) => r.tier)).toEqual(['critical', 'generation', 'standard', 'cover']);
    expect(rows[0].model).toBe('qwen/qwen3.7-plus');
    expect(rows[0].provider).toBe('RouterAI');
    expect(rows[0].roles).toBe(4);
    expect(rows[3].model).toBe('qwen/qwen-image-2.1-pro');
    expect(rows[3].derived).toBe(true);
    expect(rows[3].roles).toBe(0);
  });

  it('пустой каталог провайдеров без настроек обложки даёт пустую таблицу', () => {
    expect(buildModelRows([], roleCountsByTier(agentRoles))).toEqual([]);
    expect(buildModelRows([], roleCountsByTier(agentRoles), null)).toEqual([]);
  });

  it('строка cover следует за настройками обложки, а не за пином провайдера (S5 T6)', () => {
    // The provider pins legacy/cover-model, the settings say settings/cover-model.
    const rows = buildModelRows(PROVIDERS, { critical: 1, generation: 1, standard: 1 }, 'settings/cover-model');
    const cover = rows.find((r) => r.tier === 'cover');
    expect(cover?.model).toBe('settings/cover-model');
    expect(cover?.provider).toBe('RouterAI');
    expect(rows.find((r) => r.tier === 'standard')?.model).toBe('deepseek/deepseek-v4-flash');
  });

  it('без загруженных настроек обложки строки cover нет (честная деградация)', () => {
    const rows = buildModelRows(PROVIDERS, roleCountsByTier(agentRoles), null);
    expect(rows.map((r) => r.tier)).toEqual(['critical', 'generation', 'standard']);
  });
});
