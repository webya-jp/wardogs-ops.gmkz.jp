// 設定タブ(/servers)の「サーバー」の節。docs/ARCHITECTURE.md 9.4・15.7、docs/API.md 7 章。手動更新。
// - #add で開いたときは追加フォームを開いて最初の欄にフォーカスする
// - 一覧: 表示名、ホスト名:ポート、有効/無効、直近の接続テスト、パスワードの再入力が必要・短め
// - 操作: 編集・接続テスト・有効化/無効化・削除
// - 追加・編集フォームは 4 項目(表示名 / ホスト名 / ポート / RCON パスワード)。保存後に接続テストの結果を出す
// - 削除は確認ダイアログで表示名を入力させ、confirmName として送る
// 運営者が入力した表示名・ホスト名と、RCON が返したサーバー名は翻訳しない。RCON パスワードは画面に表示しない(API も返さない)。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { SERVER_HOST_MAX_LENGTH, SERVER_NAME_MAX_LENGTH, SERVER_PASSWORD_MAX_LENGTH } from '../types/api';
import type {
  CreateServerRequest,
  DeleteServerResponse,
  ServerMutationResponse,
  ServerSummary,
  ServerTestResult,
  ServersResponse,
  UpdateServerRequest,
} from '../types/api';
import { apiDelete, apiPost, apiPut } from './lib/api';
import type { ClientError } from './lib/api';
import { useI18n, useResource } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { isMessageKey } from './lib/keys';
import { serverLabel } from './lib/servers';
import ErrorView, { errorText, fieldIssueText } from './ErrorView';

type Props = I18nProps;

type FormMode = { type: 'add' } | { type: 'edit'; server: ServerSummary };

interface FormValues {
  name: string;
  host: string;
  port: string;
  password: string;
}

/** 画面上部に出す直近の操作結果 */
interface Outcome {
  kind: 'ok' | 'error';
  text: string;
  /** 接続テストの結果(行わなかった場合は null) */
  test?: ServerTestResult | null;
  /** 保存を伴う操作か(接続テスト失敗時に「保存はされています」を添える) */
  saved?: boolean;
  error?: ClientError;
  /** 状態画面を開くリンク(追加・保存したサーバー) */
  openId?: string;
}

const EMPTY: FormValues = { name: '', host: '', port: '', password: '' };
const FORM_FIELDS = ['name', 'host', 'port', 'password'] as const;
const HINT_CODES = new Set(['RCON_UNREACHABLE', 'RCON_AUTH_FAILED', 'RCON_TIMEOUT']);

/** ポート欄の文字列を API に送る値にする(数値にできなければそのまま送り、Worker の検証に任せる) */
function portValue(raw: string): number {
  const s = raw.trim();
  return (/^[0-9]+$/.test(s) ? Number(s) : s) as number;
}

export default function ServersPanel({ language, timeZone }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, dateTime, num } = i18n;
  const list = useResource<ServersResponse>('/api/servers', null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [formError, setFormError] = useState<ClientError | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ServerSummary | null>(null);
  const formRef = useRef<HTMLElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);

  const data = list.data;
  const servers = data?.servers ?? [];
  const limit = data?.limit ?? 0;
  const limitReached = data !== null && servers.length >= limit;

  // サイドバーの「サーバーを追加」(/servers#add)から来たときは追加フォームを開き、最初の欄にフォーカスする(docs/ARCHITECTURE.md 9.2)
  const focusFirstField = useRef(false);
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash !== '#add') return;
      focusFirstField.current = true;
      setMode({ type: 'add' });
      setValues(EMPTY);
      setFormError(null);
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!mode) return;
    formRef.current?.scrollIntoView({ block: 'start' });
    if (focusFirstField.current) {
      focusFirstField.current = false;
      document.getElementById('server-name')?.focus();
    }
  }, [mode]);
  useEffect(() => {
    if (outcome) outcomeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [outcome]);

  const openAdd = () => {
    setMode({ type: 'add' });
    setValues(EMPTY);
    setFormError(null);
  };
  const openEdit = (server: ServerSummary) => {
    setMode({ type: 'edit', server });
    setValues({ name: server.name, host: server.host, port: String(server.port), password: '' });
    setFormError(null);
  };
  const closeForm = () => {
    if (saving) return;
    setMode(null);
    setValues(EMPTY);
    setFormError(null);
  };

  const editing = mode?.type === 'edit' ? mode.server : null;
  const endpointChanged =
    editing !== null && (values.host.trim().toLowerCase() !== editing.host || values.port.trim() !== String(editing.port));
  const passwordRequired = mode?.type === 'add' || endpointChanged || editing?.needsPassword === true;

  const onSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mode || saving) return;
    setSaving(true);
    setFormError(null);
    let r;
    if (mode.type === 'add') {
      const body: CreateServerRequest = {
        name: values.name,
        host: values.host,
        port: portValue(values.port),
        password: values.password,
      };
      r = await apiPost<ServerMutationResponse>('/api/servers', body);
    } else {
      const s = mode.server;
      const body: UpdateServerRequest = {};
      if (values.name !== s.name) body.name = values.name;
      if (values.host.trim().toLowerCase() !== s.host) body.host = values.host;
      if (values.port.trim() !== String(s.port)) body.port = portValue(values.port);
      if (values.password !== '') body.password = values.password;
      r = await apiPut<ServerMutationResponse>(`/api/servers/${encodeURIComponent(s.id)}`, body);
    }
    setSaving(false);
    if (!r.ok) {
      setFormError(r.error);
      return;
    }
    const name = serverLabel(r.data.server, t);
    setOutcome({
      kind: 'ok',
      text: t(mode.type === 'add' ? 'servers.result.added' : 'servers.result.updated', { name }),
      test: r.data.test,
      saved: true,
      openId: r.data.server.id,
    });
    setMode(null);
    setValues(EMPTY);
    list.refresh();
  };

  const runTest = useCallback(
    async (server: ServerSummary) => {
      if (busyId) return;
      setBusyId(server.id);
      const r = await apiPost<ServerMutationResponse>(`/api/servers/${encodeURIComponent(server.id)}/test`, {});
      setBusyId(null);
      const name = serverLabel(server, t);
      if (r.ok) setOutcome({ kind: 'ok', text: t('servers.test.title', { name }), test: r.data.test });
      else setOutcome({ kind: 'error', text: t('servers.result.failed', { name }), error: r.error });
      list.refresh();
    },
    [busyId, t, list],
  );

  const toggle = async (server: ServerSummary) => {
    if (busyId) return;
    setBusyId(server.id);
    const enabled = !server.enabled;
    const r = await apiPut<ServerMutationResponse>(`/api/servers/${encodeURIComponent(server.id)}`, { enabled });
    setBusyId(null);
    const name = serverLabel(server, t);
    if (r.ok) {
      setOutcome({
        kind: 'ok',
        text: t(enabled ? 'servers.result.enabled' : 'servers.result.disabled', { name }),
        test: r.data.test,
        saved: true,
      });
    } else {
      setOutcome({ kind: 'error', text: t('servers.result.failed', { name }), error: r.error });
    }
    list.refresh();
  };

  const statusCell = (s: ServerSummary) => (
    <div className="badge-list">
      <span className={s.enabled ? 'badge badge-ok' : 'badge'}>{t(s.enabled ? 'servers.state.enabled' : 'servers.state.disabled')}</span>
      {s.needsPassword && <span className="badge badge-error">{t('servers.state.needsPassword')}</span>}
      {s.passwordShort && (
        <span className="badge badge-warn" title={t('servers.state.passwordShortHelp')}>
          {t('servers.state.passwordShort')}
        </span>
      )}
    </div>
  );

  const lastTestCell = (s: ServerSummary) => {
    if (!s.lastTest) return <span className="muted">{t('servers.lastTest.none')}</span>;
    const ok = s.lastTest.result === 'ok';
    return (
      <>
        <span className={ok ? 'badge badge-ok' : 'badge badge-error'}>
          {t(ok ? 'servers.lastTest.ok' : 'servers.lastTest.failed')}
        </span>
        {!ok && <div className="muted">{errorText({ code: s.lastTest.result as ClientError['code'] }, t)}</div>}
        <div className="muted">{dateTime(s.lastTest.at)}</div>
      </>
    );
  };

  const renderTest = (test: ServerTestResult, saved: boolean) => {
    if (test.ok) {
      return (
        <div className="alert alert-ok">
          <p>
            <strong>{t('servers.test.ok')}</strong>
          </p>
          <p>
            {t('servers.test.okDetail', {
              name: test.serverName ?? t('common.unknown'),
              current: num(test.players.current),
              max: num(test.players.max),
            })}
          </p>
        </div>
      );
    }
    const code = test.code ?? 'RCON_ERROR';
    const hintKey = HINT_CODES.has(code) ? (`servers.test.hint.${code}` as const) : 'servers.test.hint.other';
    return (
      <div className="alert alert-warn">
        <p>
          <strong>{t('servers.test.failed')}</strong> {errorText({ code, retryAfterSec: test.retryAfterSec }, t)}
        </p>
        {test.rconMessage && (
          <p>
            {t('common.rconDetail')} <code>{test.rconMessage}</code>
          </p>
        )}
        {isMessageKey(hintKey) && <p>{t(hintKey)}</p>}
        {saved && <p>{t('servers.test.savedAnyway')}</p>}
      </div>
    );
  };

  const fieldError = (field: (typeof FORM_FIELDS)[number]) => fieldIssueText(field, formError, t);

  return (
    <>
    <h1>{t('tabs.settings')}</h1>
    <section aria-labelledby="servers-title">
      <div className="toolbar">
        <h2 id="servers-title">{t('servers.section')}</h2>
        {data && <span className="badge">{t('servers.count', { count: num(servers.length), limit: num(limit) })}</span>}
        <span className="spacer" />
        <button type="button" className="button-small" onClick={list.refresh} disabled={list.loading}>
          {list.loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <p>{t('servers.intro')}</p>
      <p className="muted">
        {list.updatedAt !== null && <>{t('common.lastUpdated', { time: time(list.updatedAt) })} </>}
        {t('common.manualRefresh')}
      </p>

      <div ref={outcomeRef} aria-live="polite">
        {outcome && (
          <div className="card outcome">
            {outcome.kind === 'ok' ? (
              <p className={outcome.test === undefined || outcome.test === null ? 'alert alert-ok' : undefined}>
                <strong>{outcome.text}</strong>
              </p>
            ) : (
              outcome.error && <ErrorView error={outcome.error} t={t} lead={outcome.text} />
            )}
            {outcome.test && renderTest(outcome.test, outcome.saved === true)}
            {outcome.kind === 'ok' && outcome.saved && outcome.test === null && <p className="muted">{t('servers.result.noTest')}</p>}
            <div className="button-row tight">
              {outcome.openId && (
                <a className="button" href={`/?server=${encodeURIComponent(outcome.openId)}`}>
                  {t('servers.result.open')}
                </a>
              )}
              <button type="button" className="button-small push-end" onClick={() => setOutcome(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        )}
      </div>

      {!mode && (
        <div className="button-row tight add-row">
          <button type="button" className="button-primary" onClick={openAdd} disabled={limitReached}>
            {t('servers.add')}
          </button>
          {limitReached && <span className="muted">{t('servers.limitReached', { limit: num(limit) })}</span>}
        </div>
      )}

      {mode && (
        <section ref={formRef} className="card server-form" aria-labelledby="server-form-title">
          <h3 id="server-form-title">
            {mode.type === 'add' ? t('servers.form.addTitle') : t('servers.form.editTitle', { name: serverLabel(mode.server, t) })}
          </h3>
          {editing?.needsPassword && <p className="alert alert-warn">{t('servers.form.passwordReenter')}</p>}
          {formError && <ErrorView error={formError} t={t} lead={t('servers.form.saveFailed')} inlineFields={FORM_FIELDS} />}
          <form onSubmit={(e) => void onSubmit(e)} noValidate>
            <div className="field">
              <label htmlFor="server-name">{t('field.name')}</label>
              <input
                id="server-name"
                type="text"
                value={values.name}
                maxLength={SERVER_NAME_MAX_LENGTH}
                autoComplete="off"
                required
                aria-invalid={fieldError('name') ? true : undefined}
                aria-describedby="server-name-help"
                onChange={(e) => setValues({ ...values, name: e.target.value })}
              />
              {fieldError('name') && <small className="field-error" role="alert">{fieldError('name')}</small>}
              <small id="server-name-help">{t('servers.form.nameHelp', { max: SERVER_NAME_MAX_LENGTH })}</small>
            </div>
            <div className="field">
              <label htmlFor="server-host">{t('field.host')}</label>
              <input
                id="server-host"
                type="text"
                value={values.host}
                maxLength={SERVER_HOST_MAX_LENGTH}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="url"
                required
                aria-invalid={fieldError('host') ? true : undefined}
                aria-describedby="server-host-help"
                onChange={(e) => setValues({ ...values, host: e.target.value })}
              />
              {fieldError('host') && <small className="field-error" role="alert">{fieldError('host')}</small>}
              <small id="server-host-help">{t('servers.form.hostHelp')}</small>
            </div>
            <div className="field">
              <label htmlFor="server-port">{t('field.port')}</label>
              <input
                id="server-port"
                type="text"
                className="input-port"
                value={values.port}
                maxLength={5}
                autoComplete="off"
                inputMode="numeric"
                required
                aria-invalid={fieldError('port') ? true : undefined}
                aria-describedby="server-port-help"
                onChange={(e) => setValues({ ...values, port: e.target.value })}
              />
              {fieldError('port') && <small className="field-error" role="alert">{fieldError('port')}</small>}
              <small id="server-port-help">{t('servers.form.portHelp')}</small>
            </div>
            <div className="field">
              <label htmlFor="server-password">{t('field.password')}</label>
              <input
                id="server-password"
                type="password"
                value={values.password}
                maxLength={SERVER_PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                required={passwordRequired}
                aria-invalid={fieldError('password') ? true : undefined}
                aria-describedby="server-password-help"
                onChange={(e) => setValues({ ...values, password: e.target.value })}
              />
              {fieldError('password') && <small className="field-error" role="alert">{fieldError('password')}</small>}
              <small id="server-password-help">
                {t('servers.form.passwordHelp')}
                {mode.type === 'edit' && <> {t('servers.form.passwordEditHelp')}</>}
              </small>
              {mode.type === 'edit' && endpointChanged && values.password === '' && (
                <small className="field-error">{t('validation.reenter_required')}</small>
              )}
            </div>
            <div className="button-row">
              <button type="button" onClick={closeForm} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="button-primary push-end" disabled={saving} aria-busy={saving}>
                {saving ? t('servers.form.saving') : t('servers.form.save')}
              </button>
            </div>
          </form>
        </section>
      )}

      {list.error && <ErrorView error={list.error} t={t} />}
      {!data && !list.error && <p aria-live="polite">{t('common.loading')}</p>}
      {data && servers.length === 0 && <p className="card">{t('servers.empty')}</p>}
      {servers.length > 0 && (
        <div className="table-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th scope="col">{t('servers.col.name')}</th>
                <th scope="col">{t('servers.col.endpoint')}</th>
                <th scope="col">{t('servers.col.state')}</th>
                <th scope="col">{t('servers.col.lastTest')}</th>
                <th scope="col">{t('servers.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const name = serverLabel(s, t);
                const busy = busyId === s.id;
                return (
                  <tr key={s.id}>
                    <td data-label={t('servers.col.name')}>
                      <strong>{name}</strong>
                    </td>
                    <td data-label={t('servers.col.endpoint')}>
                      <span className="mono">{t('servers.endpointValue', { host: s.host, port: String(s.port) })}</span>
                    </td>
                    <td data-label={t('servers.col.state')}>{statusCell(s)}</td>
                    <td data-label={t('servers.col.lastTest')}>{lastTestCell(s)}</td>
                    <td className="actions">
                      <div className="row-actions" role="group" aria-label={t('servers.rowActions', { name })}>
                        <button type="button" className="button-small" onClick={() => openEdit(s)} disabled={saving}>
                          {t('servers.action.edit')}
                        </button>
                        <button
                          type="button"
                          className="button-small"
                          onClick={() => void runTest(s)}
                          disabled={busyId !== null || s.needsPassword}
                          aria-busy={busy}
                        >
                          {busy ? t('servers.action.testing') : t('servers.action.test')}
                        </button>
                        <button type="button" className="button-small" onClick={() => void toggle(s)} disabled={busyId !== null}>
                          {t(s.enabled ? 'servers.action.disable' : 'servers.action.enable')}
                        </button>
                        <span className="destructive-group">
                          <button
                            type="button"
                            className="button-small button-outline-danger"
                            onClick={() => setDeleting(s)}
                            disabled={busyId !== null}
                          >
                            {t('servers.action.delete')}
                          </button>
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <DeleteDialog
        i18n={i18n}
        server={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(name) => {
          setDeleting(null);
          if (mode?.type === 'edit' && mode.server.id === deleting?.id) setMode(null);
          setOutcome({ kind: 'ok', text: t('servers.result.deleted', { name }) });
          list.refresh();
        }}
      />
    </section>
    </>
  );
}

interface DeleteDialogProps {
  i18n: ReturnType<typeof useI18n>;
  server: ServerSummary | null;
  onClose: () => void;
  onDeleted: (name: string) => void;
}

/** 削除の確認。表示名をそのまま入力させ、confirmName として送る(Worker で現在の表示名と照合) */
function DeleteDialog({ i18n, server, onClose, onDeleted }: DeleteDialogProps) {
  const { t } = i18n;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<ClientError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (server) {
      setText('');
      setError(null);
      setBusy(false);
      if (!dlg.open) dlg.showModal();
    } else if (dlg.open) {
      dlg.close();
    }
  }, [server]);

  if (!server) return <dialog ref={dialogRef} className="confirm-dialog" aria-hidden="true" />;
  const name = server.name ?? '';

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || text !== name) return;
    setBusy(true);
    setError(null);
    const r = await apiDelete<DeleteServerResponse>(`/api/servers/${encodeURIComponent(server.id)}`, { confirmName: text });
    setBusy(false);
    if (r.ok) onDeleted(name);
    else setError(r.error);
  };

  const inlineError = fieldIssueText('confirmName', error, t);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog is-destructive"
      aria-labelledby="delete-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h2 id="delete-title">{t('servers.delete.title')}</h2>
      <p className="confirm-sentence">{t('servers.delete.body', { name })}</p>
      {error && <ErrorView error={error} t={t} inlineFields={['confirmName']} />}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor="delete-confirm-name">{t('servers.delete.inputLabel', { name })}</label>
          <input
            id="delete-confirm-name"
            type="text"
            value={text}
            autoComplete="off"
            autoFocus
            aria-invalid={inlineError ? true : undefined}
            onChange={(e) => setText(e.target.value)}
          />
          {inlineError && (
            <small className="field-error" role="alert">
              {inlineError}
            </small>
          )}
        </div>
        <div className="button-row">
          <button type="button" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button-danger push-end" disabled={busy || text !== name} aria-busy={busy}>
            {busy ? t('servers.delete.deleting') : t('servers.delete.submit')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
