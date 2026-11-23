/**
 * M6 — страница настроек.
 *
 * Порядок разделов: «Провайдеры и ключи → Модели → Генерация обложек → Роли».
 * Панель обложки (src/components/CoverSettings.tsx) была мёртвым кодом;
 * теперь она смонтирована отдельной секцией рядом с «Моделями». Модель
 * обложки — один источник правды (cover_settings.model); строка cover в
 * «Моделях» — её производная.
 */
import React, { useState } from 'react';
import { CoverSettings } from '../../components/CoverSettings';
import { useI18n } from '../../i18n';
import { ModelsSection } from './ModelsSection';
import { ProvidersSection } from './ProvidersSection';
import { RolesSection } from './RolesSection';

export const SettingsView: React.FC = () => {
  const { t } = useI18n();
  // The cover panel signals a successful save; the Models table
  // re-reads its derived cover row so the two views never diverge.
  const [coverRefreshToken, setCoverRefreshToken] = useState(0);
  return (
    <div className="settings">
      <section className="settings__section" data-section="providers">
        <h2 className="section-title">{t('settings.providers.title')}</h2>
        <ProvidersSection />
      </section>

      <section className="settings__section" data-section="models">
        <h2 className="section-title">{t('settings.models.title')}</h2>
        <ModelsSection coverRefreshToken={coverRefreshToken} />
      </section>

      <section className="settings__section" data-section="cover">
        <h2 className="section-title">{t('settings.cover.title')}</h2>
        <p className="caption">{t('settings.cover.hint')}</p>
        <CoverSettings embedded onSaved={() => setCoverRefreshToken((v) => v + 1)} />
      </section>

      <section className="settings__section" data-section="roles">
        <h2 className="section-title">{t('settings.roles.title')}</h2>
        <RolesSection />
      </section>
    </div>
  );
};
