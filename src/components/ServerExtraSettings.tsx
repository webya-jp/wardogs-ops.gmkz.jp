// 設定タブ(/servers)の、選択中のサーバーについての 2 節(docs/ARCHITECTURE.md 17.6・17.9、docs/API.md 7.2・7.3)。
// - スコア記録: 上限(空欄で既定 SCORE_CAP_DEFAULT)。PUT /api/servers/:id の scoreCap
// - キルフィード(観測モード): 受信の状況、受信用トークンの発行 / 再発行 / 取り消し、保存の有効・無効、ServerSettings.ini の案内
// トークンの平文は発行の応答でだけ返る。この画面の状態(メモリ)にだけ持ち、発行直後に 1 回だけ表示する(保存・ログ出力はしない)。
// ini の Url はパネル自身の origin(Astro.url.origin。ページから props で受ける)から組み立てる。
import { useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import {
  FEED_INGEST_PATH,
  FEED_RETENTION_DAYS,
  FEED_TOKEN_CACHE_SEC,
  SCORE_CAP_DEFAULT,
  SCORE_CAP_MAX,
  SCORE_CAP_MIN,
} from '../types/api';
import type {
  FeedTokenResponse,
  ServerFeedStatus,
  ServerMutationResponse,
  ServerSummary,
  UpdateFeedRequest,
  UpdateServerRequest,
} from '../types/api';
import { apiDelete, apiPost, apiPut } from './lib/api';
import type { ClientError } from './lib/api';
import { useResource } from './lib/hooks';
import type { I18n } from './lib/hooks';
import ErrorView, { fieldIssueText } from './ErrorView';
import FeedStatusView from './FeedStatusView';

interface Props {
  i18n: I18n;
  server: ServerSummary;
  /** パネルの URL(origin。末尾の / なし) */
  panelOrigin: string;
  /** 保存後にサーバー一覧を取り直す */
  onChanged: () => void;
}

export default function ServerExtraSettings({ i18n, server, panelOrigin, onChanged }: Props) {
  const { t } = i18n;
  return (
    <>
      <p className="alert">{t('settings.selectedServer', { name: server.name })}</p>
      <ScoreCapSection i18n={i18n} server={server} onChanged={onChanged} />
      <FeedSection i18n={i18n} server={server} panelOrigin={panelOrigin} onChanged={onChanged} />
    </>
  );
}

/** 上限の欄の文字列を API に送る値にする(空欄は null = 既定。数値にできなければそのまま送り、Worker の検証に任せる) */
function capValue(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  return (/^[0-9]+$/.test(s) ? Number(s) : s) as number;
}

function ScoreCapSection({ i18n, server, onChanged }: Omit<Props, 'panelOrigin'>) {
  const { t, num } = i18n;
  const current = server.scoreCap ?? null;
  const [value, setValue] = useState(current === null ? '' : String(current));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue(current === null ? '' : String(current));
  }, [server.id, current]);

  const onSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const body: UpdateServerRequest = { scoreCap: capValue(value) };
    const r = await apiPut<ServerMutationResponse>(`/api/servers/${encodeURIComponent(server.id)}`, body);
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setSaved(true);
    onChanged();
  };

  const inlineError = fieldIssueText('scoreCap', error, t);
  const currentText =
    current === null ? t('settings.recording.defaultValue', { default: num(SCORE_CAP_DEFAULT) }) : num(current);

  return (
    <section className="card" aria-labelledby="score-cap-title">
      <h2 id="score-cap-title">{t('settings.recording.section')}</h2>
      <p className="muted">{t('settings.recording.current', { value: currentText })}</p>
      <div aria-live="polite">
        {saved && <p className="alert alert-ok">{t('settings.recording.saved')}</p>}
        {error && <ErrorView error={error} t={t} lead={t('settings.recording.failed')} inlineFields={['scoreCap']} />}
      </div>
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="score-cap">{t('settings.recording.capLabel')}</label>
          <input
            id="score-cap"
            type="text"
            className="input-port"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            placeholder={String(SCORE_CAP_DEFAULT)}
            value={value}
            aria-invalid={inlineError ? true : undefined}
            aria-describedby="score-cap-help"
            onChange={(e) => setValue(e.target.value)}
          />
          {inlineError && (
            <small className="field-error" role="alert">
              {inlineError}
            </small>
          )}
          <small id="score-cap-help">
            {t('settings.recording.capHelp', { default: num(SCORE_CAP_DEFAULT), min: num(SCORE_CAP_MIN), max: num(SCORE_CAP_MAX) })}
          </small>
        </div>
        <div className="button-row tight">
          <button type="submit" className="button-primary" disabled={saving} aria-busy={saving}>
            {saving ? t('servers.form.saving') : t('settings.recording.save')}
          </button>
        </div>
      </form>
    </section>
  );
}

type Pending = 'reissue' | 'revoke' | null;

/** 一時的な結果の表示 */
interface Notice {
  kind: 'ok' | 'error';
  text: string;
  error?: ClientError;
}

function FeedSection({ i18n, server, panelOrigin, onChanged }: Props) {
  const { t, time, num } = i18n;
  const feedPath = `/api/servers/${encodeURIComponent(server.id)}/feed`;
  const feed = useResource<ServerFeedStatus>(feedPath, null);
  const [status, setStatus] = useState<ServerFeedStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState<'token' | 'ini' | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const scrolled = useRef(false);

  // 取り直した状況を表示に使う(発行・取り消しの応答で更新した値は、次の取得で置き換わる)
  useEffect(() => {
    if (feed.data) setStatus(feed.data);
  }, [feed.data]);

  // 別のサーバーに切り替わったら、表示中のトークンを捨てる
  useEffect(() => {
    setToken(null);
    setStatus(null);
    setPending(null);
    setNotice(null);
  }, [server.id]);

  // キルフィードタブの案内(/servers#feed)から来たときは、この節を表示する
  useEffect(() => {
    if (scrolled.current || !status) return;
    if (window.location.hash === '#feed') {
      scrolled.current = true;
      sectionRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [status]);

  const configured = status?.configured === true;
  const base = panelOrigin.replace(/\/+$/, '');
  const ini = `[WDServerFeed]\nUrl=${base}\nToken=${token ?? t('feed.ini.tokenPlaceholder')}`;

  const copy = async (kind: 'token' | 'ini', text: string) => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setCopied(null);
      setCopyFailed(true);
    }
  };

  const issue = async () => {
    if (busy) return;
    const reissue = configured;
    setBusy(true);
    setNotice(null);
    setCopied(null);
    const r = await apiPost<FeedTokenResponse>(`/api/servers/${encodeURIComponent(server.id)}/feed-token`, {});
    setBusy(false);
    setPending(null);
    if (!r.ok) {
      setNotice({ kind: 'error', text: t('feed.failed'), error: r.error });
      return;
    }
    setToken(r.data.token);
    setStatus(r.data.status);
    setNotice({ kind: 'ok', text: t(r.data.reissued || reissue ? 'feed.token.reissued' : 'feed.token.issued') });
    onChanged();
  };

  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const r = await apiDelete<ServerFeedStatus>(`/api/servers/${encodeURIComponent(server.id)}/feed-token`, {});
    setBusy(false);
    setPending(null);
    if (!r.ok) {
      setNotice({ kind: 'error', text: t('feed.failed'), error: r.error });
      return;
    }
    setToken(null);
    setStatus(r.data);
    setNotice({ kind: 'ok', text: t('feed.token.revoked') });
    onChanged();
  };

  const setEnabled = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const body: UpdateFeedRequest = { enabled };
    const r = await apiPut<ServerFeedStatus>(feedPath, body);
    setBusy(false);
    if (!r.ok) {
      setNotice({ kind: 'error', text: t('feed.failed'), error: r.error });
      return;
    }
    setStatus(r.data);
    setNotice({ kind: 'ok', text: t('feed.enabled.saved') });
  };

  return (
    <section ref={sectionRef} id="feed" className="card feed-settings" aria-labelledby="feed-title">
      <div className="toolbar">
        <h2 id="feed-title">{t('feed.section')}</h2>
        <span className="spacer" />
        <button type="button" className="button-small" onClick={feed.refresh} disabled={feed.loading}>
          {feed.loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <p>{t('feed.intro', { days: num(FEED_RETENTION_DAYS) })}</p>
      <p className="muted">
        {feed.updatedAt !== null && <>{t('common.lastUpdated', { time: time(feed.updatedAt) })} </>}
        {t('common.manualRefresh')}
      </p>

      <div className="alert alert-warn">
        <p>
          <strong>{t('feed.notes.title')}</strong>
        </p>
        <ul>
          <li>{t('feed.notes.oneAtATime')}</li>
          <li>{t('feed.notes.removeUrl')}</li>
          <li>{t('feed.notes.metrics')}</li>
        </ul>
      </div>

      <div aria-live="polite">
        {notice?.kind === 'ok' && <p className="alert alert-ok">{notice.text}</p>}
        {notice?.kind === 'error' && notice.error && <ErrorView error={notice.error} t={t} lead={notice.text} />}
      </div>
      {feed.error && <ErrorView error={feed.error} t={t} />}
      {!status && !feed.error && <p aria-live="polite">{t('common.loading')}</p>}

      {status && (
        <>
          <h3>{t('feed.token.title')}</h3>
          {token && (
            <div className="alert alert-warn token-once">
              <p>
                <strong>{t('feed.token.onceWarning')}</strong>
              </p>
              <div className="field">
                <label htmlFor="feed-token">{t('feed.token.label')}</label>
                <div className="copy-row">
                  <input
                    id="feed-token"
                    type="text"
                    className="mono"
                    readOnly
                    value={token}
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={(e) => e.target.select()}
                  />
                  <button type="button" className="button-small" onClick={() => void copy('token', token)}>
                    {t('feed.copy')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!configured && (
            <div className="button-row tight">
              <button type="button" className="button-primary" onClick={() => void issue()} disabled={busy} aria-busy={busy}>
                {busy ? t('feed.token.issuing') : t('feed.token.issue')}
              </button>
            </div>
          )}
          {configured && (
            <>
              <div className="button-row tight">
                <button type="button" className="button-small" onClick={() => setPending('reissue')} disabled={busy || pending !== null}>
                  {t('feed.token.reissue')}
                </button>
                <span className="destructive-group push-end">
                  <button
                    type="button"
                    className="button-small button-outline-danger"
                    onClick={() => setPending('revoke')}
                    disabled={busy || pending !== null}
                  >
                    {t('feed.token.revoke')}
                  </button>
                </span>
              </div>
              {pending && (
                <div className={pending === 'revoke' ? 'alert alert-error' : 'alert alert-warn'} role="alertdialog" aria-labelledby="feed-pending-text">
                  <p id="feed-pending-text">
                    {pending === 'reissue'
                      ? t('feed.token.reissueConfirm', { seconds: num(FEED_TOKEN_CACHE_SEC) })
                      : t('feed.token.revokeConfirm')}
                  </p>
                  <div className="button-row tight">
                    <button type="button" onClick={() => setPending(null)} disabled={busy} autoFocus>
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      className={pending === 'revoke' ? 'button-danger push-end' : 'button-primary push-end'}
                      onClick={() => void (pending === 'revoke' ? revoke() : issue())}
                      disabled={busy}
                      aria-busy={busy}
                    >
                      {busy
                        ? t('feed.token.issuing')
                        : pending === 'revoke'
                          ? t('feed.token.revokeExecute')
                          : t('feed.token.reissueExecute')}
                    </button>
                  </div>
                </div>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={status.enabled}
                  disabled={busy}
                  aria-describedby="feed-enabled-help"
                  onChange={(e) => void setEnabled(e.target.checked)}
                />
                <span>{t('feed.enabled.label')}</span>
              </label>
              <p id="feed-enabled-help" className="action-help">
                {t('feed.enabled.help')}
              </p>
            </>
          )}

          <FeedStatusView i18n={i18n} status={status} />

          <h3>{t('feed.ini.title')}</h3>
          <p>{t('feed.ini.intro')}</p>
          <pre className="code-block" aria-label={t('feed.ini.title')}>
            {ini}
          </pre>
          <div className="button-row tight">
            <button type="button" className="button-small" onClick={() => void copy('ini', ini)}>
              {t('feed.copy')}
            </button>
          </div>
          <p className="muted">{t('feed.ini.urlNote', { path: FEED_INGEST_PATH })}</p>
          <p className="muted">{t('feed.ini.unverified')}</p>
          <p className="muted" aria-live="polite">
            {copied ? t('feed.copied') : ''}
          </p>
          {copyFailed && <p className="alert alert-warn">{t('feed.copyFailed')}</p>}
        </>
      )}
    </section>
  );
}
