import { useCallback, useEffect, useState } from 'react';
import { AppShell, type AppTab } from './app/AppShell';
import SessionGate from './components/SessionGate';
import { GenerationView } from './features/generation/GenerationView';
import { HistoryView } from './features/history/HistoryView';
import { SettingsView } from './features/settings/SettingsView';
import { subscribeUnauthorized } from './hooks/useApi';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './theme';
import { fetchAuthStatus, parseTokenFromHash } from './lib/session';

/**
 * Состояние access-gate (M4):
 *  - 'checking' — первичная проверка GET /api/auth/status при загрузке;
 *  - 'unauth'   — не авторизован → показываем SessionGate (весь экран);
 *  - 'auth'     — авторизован → основной контент приложения.
 *
 * Если лаунчер открыл приложение с токеном во фрагменте адреса,
 * автообмен выполняется сразу в SessionGate — без пробы статуса и без
 * единого поля ввода. Иначе решение принимается по ТЕЛУ ответа
 * (`authenticated === true`), а не по HTTP-коду: сервер всегда отвечает 200.
 *
 * Переход 'auth' → 'unauth' происходит, когда любой API-запрос вернул 401:
 * useApi дёргает подписанный коллбэк, SessionGate перемонтируется по key с
 * причиной 'session-expired'. Содержимое приложения рендерится только после
 * разблокировки.
 */
type AuthState = 'checking' | 'unauth' | 'auth';

function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [gateReason, setGateReason] = useState<'boot' | 'session-expired'>('boot');
  const [gateKey, setGateKey] = useState(0);
  const [tab, setTab] = useState<AppTab>('generation');
  const [articleId, setArticleId] = useState<string | null>(null);

  useEffect(() => {
    // Токен во фрагменте → автообмен в SessionGate, пробу статуса не делаем.
    if (parseTokenFromHash(window.location.hash)) {
      setAuth('unauth');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const authenticated = await fetchAuthStatus();
        if (cancelled) return;
        setAuth(authenticated ? 'auth' : 'unauth');
      } catch {
        // Сервер недоступен — считаем, что приложение уже открыто.
        if (!cancelled) setAuth('auth');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      subscribeUnauthorized(() => {
        setGateReason('session-expired');
        setGateKey((k) => k + 1);
        setAuth('unauth');
      }),
    [],
  );

  const openArticle = useCallback((id: string) => {
    setArticleId(id);
    setTab('generation');
  }, []);

  const handleAuthenticated = useCallback(() => setAuth('auth'), []);

  return (
    <I18nProvider>
      <ThemeProvider>
        {auth === 'checking' ? <div className="app-boot" aria-hidden="true" /> : null}
        {auth === 'unauth' ? (
          <SessionGate key={gateKey} reason={gateReason} onAuthenticated={handleAuthenticated} />
        ) : null}
        {auth === 'auth' ? (
          <AppShell activeTab={tab} onTabChange={setTab}>
            {tab === 'generation' ? (
              <GenerationView articleId={articleId} onArticleChange={setArticleId} />
            ) : null}
            {tab === 'history' ? <HistoryView onOpen={openArticle} /> : null}
            {tab === 'settings' ? <SettingsView /> : null}
          </AppShell>
        ) : null}
      </ThemeProvider>
    </I18nProvider>
  );
}

export default App;
