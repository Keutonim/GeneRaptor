// Unit tests for server/lib/cover-settings.mjs.
// Covers: defaults + configured flag, validation rejection matrix, cap=0 acceptance,
// saveCoverSettings create-then-update behaviour. Prisma is mocked — no live DB.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  coverSettings: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: { coverSettings: dbMocks.coverSettings },
}));

const {
  COVER_SETTINGS_DEFAULTS,
  validateCoverSettings,
  resolveCompressionModel,
  getCoverSettings,
  saveCoverSettings,
  CoverSettingsError,
} = await import('../../server/lib/cover-settings.mjs');
const { DEFAULT_COVER_SYSTEM_PROMPT } = await import('../../server/lib/cover-prompt.mjs');

function makeDbRow(overrides = {}) {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    enabled: true,
    model: 'qwen/qwen-image-2.1-pro',
    compressionModel: null,
    promptTemplate: DEFAULT_COVER_SYSTEM_PROMPT,
    aspectRatio: '16:9',
    resolution: '1K',
    quality: 'high',
    outputFormat: 'png',
    autoGenerate: false,
    monthlyCapRub: 300,
    updatedAt: new Date('2026-10-24T10:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('COVER_SETTINGS_DEFAULTS', () => {
  it('is frozen and carries the documented defaults', () => {
    expect(Object.isFrozen(COVER_SETTINGS_DEFAULTS)).toBe(true);
    expect(COVER_SETTINGS_DEFAULTS.enabled).toBe(true);
    expect(COVER_SETTINGS_DEFAULTS.model).toBe('qwen/qwen-image-2.1-pro');
    expect(COVER_SETTINGS_DEFAULTS.compressionModel).toBeNull();
    expect(COVER_SETTINGS_DEFAULTS.promptTemplate).toBe(DEFAULT_COVER_SYSTEM_PROMPT);
    expect(COVER_SETTINGS_DEFAULTS.aspectRatio).toBe('16:9');
    expect(COVER_SETTINGS_DEFAULTS.resolution).toBe('1K');
    expect(COVER_SETTINGS_DEFAULTS.quality).toBe('high');
    expect(COVER_SETTINGS_DEFAULTS.outputFormat).toBe('png');
    expect(COVER_SETTINGS_DEFAULTS.autoGenerate).toBe(false);
    expect(COVER_SETTINGS_DEFAULTS.monthlyCapRub).toBe(300);
  });
});

// Case 10: defaults + configured:false when no row exists.
describe('getCoverSettings', () => {
  it('returns defaults with configured:false when no row exists', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(null);

    const settings = await getCoverSettings();

    expect(settings.configured).toBe(false);
    expect(settings.enabled).toBe(true);
    expect(settings.model).toBe('qwen/qwen-image-2.1-pro');
    expect(settings.compressionModelSource).toBe('env');
    expect(settings.promptTemplate).toBe(DEFAULT_COVER_SYSTEM_PROMPT);
    expect(settings.aspectRatio).toBe('16:9');
    expect(settings.resolution).toBe('1K');
    expect(settings.quality).toBe('high');
    expect(settings.outputFormat).toBe('png');
    expect(settings.autoGenerate).toBe(false);
    expect(settings.monthlyCapRub).toBe(300);
    expect(typeof settings.monthlyCapRub).toBe('number');
  });

  it('reads the single row ordered by updatedAt desc', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(null);
    await getCoverSettings();
    expect(dbMocks.coverSettings.findFirst).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('returns stored values with configured:true, decimal cap as number, override source', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(
      makeDbRow({
        model: 'google/gemini-nano-banana-2.1',
        compressionModel: 'openai/gpt-x-mini',
        monthlyCapRub: { toNumber: () => 150, toString: () => '150' }, // Prisma Decimal stand-in
        autoGenerate: true,
      }),
    );

    const settings = await getCoverSettings();

    expect(settings.configured).toBe(true);
    expect(settings.model).toBe('google/gemini-nano-banana-2.1');
    expect(settings.compressionModel).toBe('openai/gpt-x-mini');
    expect(settings.compressionModelSource).toBe('override');
    expect(settings.monthlyCapRub).toBe(150);
    expect(typeof settings.monthlyCapRub).toBe('number');
    expect(settings.autoGenerate).toBe(true);
  });

  it('resolves compressionModel from env when no override stored', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(makeDbRow({ compressionModel: null }));
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'deepseek/deepseek-v4-pro');

    const settings = await getCoverSettings();

    expect(settings.compressionModel).toBe('deepseek/deepseek-v4-pro');
    expect(settings.compressionModelSource).toBe('env');
  });

  it('reflects env changes between calls (resolved at read time)', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(makeDbRow({ compressionModel: null }));
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'model-a/model-a');
    const first = await getCoverSettings();
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'model-b/model-b');
    const second = await getCoverSettings();

    expect(first.compressionModel).toBe('model-a/model-a');
    expect(second.compressionModel).toBe('model-b/model-b');
  });
});

// Case 12: validation rejects invalid payloads with pinned machine codes.
describe('validateCoverSettings', () => {
  it('accepts a full valid object', () => {
    expect(
      validateCoverSettings({
        enabled: true,
        model: 'qwen/qwen-image-2.1-pro',
        compressionModel: 'deepseek/deepseek-v4-flash',
        promptTemplate: 'Template.',
        aspectRatio: '16:9',
        resolution: '1K',
        quality: 'high',
        outputFormat: 'png',
        autoGenerate: false,
        monthlyCapRub: 300,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects non-object input with cover_settings_unknown_field', () => {
    expect(validateCoverSettings('nope').code).toBe('cover_settings_unknown_field');
    expect(validateCoverSettings(null).code).toBe('cover_settings_unknown_field');
  });

  it('rejects unknown keys with cover_settings_unknown_field', () => {
    const result = validateCoverSettings({ bogus: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('cover_settings_unknown_field');
    expect(result.message).toContain('bogus');
  });

  it('skips meta fields id/updatedAt', () => {
    expect(
      validateCoverSettings({ id: 'x', updatedAt: new Date(), enabled: true }),
    ).toEqual({ ok: true });
  });

  it('rejects invalid enabled', () => {
    expect(validateCoverSettings({ enabled: 'yes' }).code).toBe('cover_settings_invalid_enabled');
  });

  it('rejects invalid model (empty or >200 chars)', () => {
    expect(validateCoverSettings({ model: '' }).code).toBe('cover_settings_invalid_model');
    expect(validateCoverSettings({ model: '   ' }).code).toBe('cover_settings_invalid_model');
    expect(validateCoverSettings({ model: 'x'.repeat(201) }).code).toBe('cover_settings_invalid_model');
    expect(validateCoverSettings({ model: 42 }).code).toBe('cover_settings_invalid_model');
  });

  it('rejects invalid compressionModel (empty string, too long, wrong type)', () => {
    expect(validateCoverSettings({ compressionModel: '' }).code).toBe(
      'cover_settings_invalid_compression_model',
    );
    expect(validateCoverSettings({ compressionModel: 'x'.repeat(201) }).code).toBe(
      'cover_settings_invalid_compression_model',
    );
    expect(validateCoverSettings({ compressionModel: 7 }).code).toBe(
      'cover_settings_invalid_compression_model',
    );
    // null means inherit — always valid.
    expect(validateCoverSettings({ compressionModel: null })).toEqual({ ok: true });
  });

  it('rejects invalid promptTemplate (empty or >8000 chars)', () => {
    expect(validateCoverSettings({ promptTemplate: '' }).code).toBe(
      'cover_settings_invalid_prompt_template',
    );
    expect(validateCoverSettings({ promptTemplate: ' '.repeat(5) }).code).toBe(
      'cover_settings_invalid_prompt_template',
    );
    expect(validateCoverSettings({ promptTemplate: 't'.repeat(8001) }).code).toBe(
      'cover_settings_invalid_prompt_template',
    );
    // 8000 exactly is fine.
    expect(validateCoverSettings({ promptTemplate: 't'.repeat(8000) })).toEqual({ ok: true });
  });

  it('rejects unsupported aspectRatio', () => {
    expect(validateCoverSettings({ aspectRatio: '5:7' }).code).toBe(
      'cover_settings_invalid_aspect_ratio',
    );
    expect(validateCoverSettings({ aspectRatio: '16-9' }).code).toBe(
      'cover_settings_invalid_aspect_ratio',
    );
  });

  it('accepts supported aspect ratios', () => {
    for (const ratio of ['1:1', '16:9', '9:16', '4:5', '21:9', '1:2', '2:1']) {
      expect(validateCoverSettings({ aspectRatio: ratio })).toEqual({ ok: true });
    }
  });

  it('rejects invalid resolution', () => {
    expect(validateCoverSettings({ resolution: '8K' }).code).toBe(
      'cover_settings_invalid_resolution',
    );
    expect(validateCoverSettings({ resolution: 1024 }).code).toBe(
      'cover_settings_invalid_resolution',
    );
    for (const value of ['512', '1K', '2K', '4K']) {
      expect(validateCoverSettings({ resolution: value })).toEqual({ ok: true });
    }
  });

  it('rejects invalid quality', () => {
    expect(validateCoverSettings({ quality: 'ultra' }).code).toBe('cover_settings_invalid_quality');
    for (const value of ['auto', 'low', 'medium', 'high']) {
      expect(validateCoverSettings({ quality: value })).toEqual({ ok: true });
    }
  });

  it('rejects invalid outputFormat', () => {
    expect(validateCoverSettings({ outputFormat: 'gif' }).code).toBe(
      'cover_settings_invalid_output_format',
    );
    for (const value of ['png', 'jpeg', 'webp']) {
      expect(validateCoverSettings({ outputFormat: value })).toEqual({ ok: true });
    }
  });

  it('rejects invalid autoGenerate', () => {
    expect(validateCoverSettings({ autoGenerate: 'no' }).code).toBe(
      'cover_settings_invalid_auto_generate',
    );
    expect(validateCoverSettings({ autoGenerate: false })).toEqual({ ok: true });
    expect(validateCoverSettings({ autoGenerate: true })).toEqual({ ok: true });
  });

  // Case 11 (cap boundary) — cap=0 is VALID and blocks generation downstream.
  it('accepts monthlyCapRub 0 (generation blocked) and rejects out-of-range/non-integer', () => {
    expect(validateCoverSettings({ monthlyCapRub: 0 })).toEqual({ ok: true });
    expect(validateCoverSettings({ monthlyCapRub: 100000 })).toEqual({ ok: true });
    for (const bad of [-1, 1.5, 100001, '300', null, NaN]) {
      expect(validateCoverSettings({ monthlyCapRub: bad }).code).toBe('cover_settings_invalid_cap');
    }
  });
});

describe('resolveCompressionModel', () => {
  it('returns stored override when present', () => {
    expect(resolveCompressionModel('openai/gpt-x-mini')).toBe('openai/gpt-x-mini');
  });

  it('falls back to env then to the hardcoded standard model', () => {
    vi.stubEnv('ROUTERAI_MODEL_STANDARD', 'env/model');
    expect(resolveCompressionModel(null)).toBe('env/model');
    expect(resolveCompressionModel('')).toBe('env/model');
    expect(resolveCompressionModel(undefined)).toBe('env/model');

    vi.stubEnv('ROUTERAI_MODEL_STANDARD', '');
    expect(resolveCompressionModel(null)).toBe('deepseek/deepseek-v4-flash');
  });
});

// Case 13: saveCoverSettings creates when absent, updates when present.
describe('saveCoverSettings', () => {
  it('creates a row when none exists and returns shaped settings', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(null);
    const created = makeDbRow({ model: 'google/gemini-nano-banana-2.1' });
    dbMocks.coverSettings.create.mockResolvedValue(created);

    const result = await saveCoverSettings({ model: 'google/gemini-nano-banana-2.1' });

    expect(dbMocks.coverSettings.create).toHaveBeenCalledTimes(1);
    const createArg = dbMocks.coverSettings.create.mock.calls[0][0];
    expect(createArg.data.model).toBe('google/gemini-nano-banana-2.1');
    // Only settings fields — never id/updatedAt/configured helpers.
    expect(createArg.data).not.toHaveProperty('id');
    expect(createArg.data).not.toHaveProperty('updatedAt');
    expect(createArg.data).not.toHaveProperty('configured');
    expect(createArg.data).not.toHaveProperty('compressionModelSource');
    // Merged over defaults so NOT NULL columns are always present.
    expect(createArg.data.promptTemplate).toBe(DEFAULT_COVER_SYSTEM_PROMPT);
    expect(createArg.data.monthlyCapRub).toBe(300);

    expect(result.configured).toBe(true);
    expect(result.model).toBe('google/gemini-nano-banana-2.1');
  });

  it('updates the existing row by id and bumps updatedAt', async () => {
    const existing = makeDbRow({ updatedAt: new Date('2026-10-01T00:00:00.000Z') });
    const updated = makeDbRow({
      model: 'google/gemini-3.1-flash-image',
      updatedAt: new Date('2026-10-24T12:00:00.000Z'),
    });
    dbMocks.coverSettings.findFirst.mockResolvedValue(existing);
    dbMocks.coverSettings.update.mockResolvedValue(updated);

    const result = await saveCoverSettings({ model: 'google/gemini-3.1-flash-image' });

    expect(dbMocks.coverSettings.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.coverSettings.create).not.toHaveBeenCalled();
    const updateArg = dbMocks.coverSettings.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: existing.id });
    expect(updateArg.data.model).toBe('google/gemini-3.1-flash-image');
    // Untouched fields keep the stored value, not the default.
    expect(updateArg.data.promptTemplate).toBe(existing.promptTemplate);
    expect(result.model).toBe('google/gemini-3.1-flash-image');
    expect(updated.updatedAt.getTime()).toBeGreaterThan(existing.updatedAt.getTime());
  });

  it('normalizes empty compressionModel to null (inherit)', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(null);
    dbMocks.coverSettings.create.mockResolvedValue(makeDbRow({ compressionModel: null }));

    await saveCoverSettings({ compressionModel: '' });

    const createArg = dbMocks.coverSettings.create.mock.calls[0][0];
    expect(createArg.data.compressionModel).toBeNull();
  });

  it('accepts a Prisma Decimal cap from the stored row when merging', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(
      makeDbRow({ monthlyCapRub: { toNumber: () => 250 } }),
    );
    dbMocks.coverSettings.update.mockResolvedValue(makeDbRow({ monthlyCapRub: 250, enabled: false }));

    const result = await saveCoverSettings({ enabled: false });

    const updateArg = dbMocks.coverSettings.update.mock.calls[0][0];
    expect(updateArg.data.monthlyCapRub).toBe(250);
    expect(result.enabled).toBe(false);
  });

  it('throws CoverSettingsError with pinned code on invalid patch', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(null);

    await expect(saveCoverSettings({ monthlyCapRub: -5 })).rejects.toMatchObject({
      name: 'CoverSettingsError',
      code: 'cover_settings_invalid_cap',
    });
    expect(dbMocks.coverSettings.create).not.toHaveBeenCalled();
    expect(dbMocks.coverSettings.update).not.toHaveBeenCalled();
  });

  it('throws CoverSettingsError with cover_settings_unknown_field on unknown patch keys', async () => {
    dbMocks.coverSettings.findFirst.mockResolvedValue(null);

    await expect(saveCoverSettings({ nope: true })).rejects.toBeInstanceOf(CoverSettingsError);
    await expect(saveCoverSettings({ nope: true })).rejects.toMatchObject({
      code: 'cover_settings_unknown_field',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  W «Автоматизация» (2026-10-27): CSS-фикс строки параметров обложки  */
/*  (owner-баг «съехавшее выпадающее меню типа файла»).      */
/*  Гвард-скан исходника компонента: все ЧЕТЫРЕ параметр-лейбла         */
/*  (Формат/Разрешение/Качество/Файл) используют общий параметр-класс   */
/*  с align-items/align-content: start, у блока «Файл» есть hint-строка; */
/*  размер самого контрола задаёт общий класс (.input/.select/…).      */
/*                                                                    */
/*  S5-ui: presentation переехала с инлайн-стилей на токены темы        */
/*  (src/styles/cover.css) — гвард проверяет новый носитель правила.   */
/* ------------------------------------------------------------------ */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('CoverSettings — параметр-лейблы без растяжения (CSS-фикс §7)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/CoverSettings.tsx'), 'utf8');
  const styles = readFileSync(resolve(process.cwd(), 'src/styles/cover.css'), 'utf8');

  it('параметр-блок объявлен c align-items:start и align-content:start', () => {
    const match = styles.match(/\.cover-settings__param \{([\s\S]*?)\}/);
    expect(match, '.cover-settings__param не найден в cover.css').toBeTruthy();
    expect(match[1]).toContain('display: grid');
    expect(match[1]).toContain('align-items: start');
    expect(match[1]).toContain('align-content: start');
    expect(match[1]).toContain('gap: var(--space-2)');
  });

  it('четыре параметр-лейбла используют общий класс, инлайн {display:grid, gap:6} удалён', () => {
    expect(source).toContain('<span className="field__label">Формат</span>');
    expect(source).toContain('<span className="field__label">Разрешение</span>');
    expect(source).toContain('<span className="field__label">Качество</span>');
    expect(source).toContain('<span className="field__label">Файл</span>');
    // Общий параметр-класс используется минимум 4 раза (Формат/Разрешение/Качество/Файл).
    const uses = source.match(/className="cover-settings__param"/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    // Старый инлайн-стиль и его константа в компоненте не остались.
    expect(source).not.toContain('paramLabelStyle');
    expect(source).not.toContain("<label style={{ display: 'grid', gap: 6 }}>");
  });

  it('блок «Файл» имеет hint-строку (он был единственным без неё — из-за этого и разъезжался)', () => {
    const fileBlock = source.match(/<span className="field__label">Файл<\/span>[\s\S]*?<\/label>/);
    expect(fileBlock, 'блок «Файл» не найден').toBeTruthy();
    expect(fileBlock[0]).toContain('Формат файла обложки: PNG, JPEG или WebP.');
  });

  it('размер контрола задаёт общий класс приложения (растяжение чинится только в блоке)', () => {
    expect(source).toContain('className="select"');
    expect(source).toContain('className="input"');
    expect(source).toContain('className="textarea"');
    // Инлайн-константы размеров в компоненте больше нет.
    expect(source).not.toContain('fieldStyle');
    // Общий контрол — ширина 100% и один размер по вертикали.
    expect(styles).not.toContain('fieldStyle');
  });
});
