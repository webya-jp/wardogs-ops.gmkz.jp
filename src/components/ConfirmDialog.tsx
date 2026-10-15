// 書き込み操作の確認ダイアログ(prepare → 確認 → execute の二段階。docs/ARCHITECTURE.md 4.3・7.3、docs/API.md 4 章)。
// - 入力が要る操作(kick / ban の理由、個別メッセージの本文)は最初に入力欄を出す
// - 確認内容は prepare が返した正規化済み params と targetName から、カタログの confirm.<action> で組み立てる
// - destructive(ban / map / match_end)は強調し、確認チェックを入れるまで実行ボタンを押せない
// - 実行中は閉じられず、二重送信しない。RCON_TIMEOUT は「結果不明」として自動で再実行しない
// - 対象サーバー(server)を prepare・execute の両方に明示して送り、ダイアログにサーバー名を出す(docs/ARCHITECTURE.md 15.5・15.6)
import { useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { MESSAGE_MAX_LENGTH, REASON_MAX_LENGTH } from '../types/api';
import type { ExecuteRequest, ExecuteResponse, PrepareRequest, PrepareResponse, ServerId, WriteAction } from '../types/api';
import { apiPost } from './lib/api';
import type { ClientError } from './lib/api';
import type { I18n } from './lib/hooks';
import ErrorView, { fieldIssueText } from './ErrorView';

export type InputKind = 'reason' | 'message';

export interface ActionRequestSpec {
  action: WriteAction;
  /** 入力欄以外のパラメータ(steamId・map など) */
  params: Record<string, string>;
  /** 確認の前に入力させる項目 */
  input?: InputKind;
  /** 入力欄の上に出す対象の表示(一覧の行の値。確認段階では prepare 応答の targetName を使う) */
  subject?: { name: string; steamId: string };
}

export interface TargetServer {
  id: ServerId;
  /** 画面に出す名前(運営者が付けた表示名、または既定サーバーのカタログ文言) */
  label: string;
}

interface Props {
  i18n: I18n;
  /** 操作の対象サーバー(ページで選択中のもの) */
  server: TargetServer;
  request: ActionRequestSpec | null;
  /** map の id → displayName(RCON の生データ。表示用) */
  mapNames?: Record<string, string | null>;
  onClose: () => void;
  onDone: (action: WriteAction) => void;
}

type Step = 'input' | 'preparing' | 'confirm' | 'executing' | 'done' | 'failed';

/**
 * execute で応答を受け取れなかった(サーバー側で実行済みの可能性がある)コード。
 * 「結果不明」と表示し、再実行ボタンは出さない(新しい prepare は新しい nonce になり二重実行になり得るため)
 */
const UNKNOWN_RESULT: ReadonlySet<string> = new Set(['NETWORK', 'INTERNAL_ERROR', 'RCON_TIMEOUT']);
/** execute 後にやり直しを出さないコード(UNKNOWN_RESULT に加えて) */
const NO_RETRY: ReadonlySet<string> = new Set([...UNKNOWN_RESULT, 'ALREADY_EXECUTED']);

export default function ConfirmDialog({ i18n, server, request, mapNames = {}, onClose, onDone }: Props) {
  const { t, time } = i18n;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [step, setStep] = useState<Step>('input');
  const [text, setText] = useState('');
  const [prepared, setPrepared] = useState<PrepareResponse | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [failedPhase, setFailedPhase] = useState<'prepare' | 'execute'>('prepare');
  const [ack, setAck] = useState(false);

  const buildParams = (spec: ActionRequestSpec, value: string): Record<string, string> => {
    const params = { ...spec.params };
    if (spec.input === 'message') params.message = value;
    if (spec.input === 'reason' && value.trim() !== '') params.reason = value;
    return params;
  };

  const prepare = async (spec: ActionRequestSpec, value: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStep('preparing');
    setError(null);
    setAck(false);
    setPrepared(null);
    const body = { server: server.id, action: spec.action, params: buildParams(spec, value) } as PrepareRequest;
    const r = await apiPost<PrepareResponse>('/api/actions/prepare', body, ctrl.signal);
    if (ctrl.signal.aborted) return;
    if (r.ok) {
      setPrepared(r.data);
      setStep('confirm');
      return;
    }
    setError(r.error);
    if (spec.input && r.error.code === 'VALIDATION_FAILED') {
      setStep('input');
    } else {
      setFailedPhase('prepare');
      setStep('failed');
    }
  };

  // 開く・閉じる
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (request) {
      busy.current = false;
      setText('');
      setPrepared(null);
      setError(null);
      setAck(false);
      if (!dlg.open) dlg.showModal();
      if (request.input) setStep('input');
      else void prepare(request, '');
    } else if (dlg.open) {
      dlg.close();
    }
    return () => abortRef.current?.abort();
  }, [request]);

  if (!request) return <dialog ref={dialogRef} className="confirm-dialog" aria-hidden="true" />;

  const actionLabel = t(`action.${request.action}`);
  const destructive = prepared?.destructive === true;

  const close = () => {
    if (busy.current) return;
    abortRef.current?.abort();
    onClose();
  };

  const execute = async () => {
    if (!prepared || busy.current) return;
    if (destructive && !ack) return;
    busy.current = true;
    setStep('executing');
    setError(null);
    // server は prepare 応答の値(確認トークンに署名済み)を優先し、無ければページで選択中のもの
    const body = {
      server: prepared.server ?? server.id,
      action: prepared.action,
      params: prepared.params,
      confirmToken: prepared.confirmToken,
    } as ExecuteRequest;
    const r = await apiPost<ExecuteResponse>('/api/actions/execute', body);
    busy.current = false;
    if (r.ok) {
      setStep('done');
      onDone(prepared.action);
    } else {
      setError(r.error);
      setFailedPhase('execute');
      setStep('failed');
    }
  };

  const restart = () => {
    if (request.input) {
      setError(null);
      setPrepared(null);
      setStep('input');
    } else {
      void prepare(request, '');
    }
  };

  const onSubmitInput = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void prepare(request, text);
  };

  const p = (prepared?.params ?? {}) as Record<string, string | undefined>;
  const targetName = prepared?.targetName ?? t('confirm.unknownTarget');
  const mapId = p.map ?? '';
  const mapDisplay = mapNames[mapId] ?? null;

  const renderSummary = () => {
    if (!prepared) return null;
    return (
      <>
        <p className="confirm-sentence">
          {t(`confirm.${prepared.action}`, { target: targetName, map: mapDisplay ?? mapId })}
        </p>
        <dl className="kv">
          <dt>{t('confirm.server')}</dt>
          <dd>{server.label}</dd>
          <dt>{t('confirm.operation')}</dt>
          <dd>{t(`action.${prepared.action}`)}</dd>
          {p.steamId !== undefined && (
            <>
              <dt>{t('confirm.target')}</dt>
              <dd>{t('confirm.targetValue', { name: targetName, steamId: p.steamId })}</dd>
            </>
          )}
          {(prepared.action === 'kick' || prepared.action === 'ban') && (
            <>
              <dt>{t('confirm.reason')}</dt>
              <dd>{p.reason ? p.reason : t('confirm.noReason')}</dd>
            </>
          )}
          {p.message !== undefined && (
            <>
              <dt>{t('confirm.messageBody')}</dt>
              <dd>
                <div className="quote-box">{p.message}</div>
              </dd>
            </>
          )}
          {prepared.action === 'map' && (
            <>
              <dt>{t('confirm.mapLabel')}</dt>
              <dd>{mapDisplay ? t('confirm.mapValue', { name: mapDisplay, id: mapId }) : mapId}</dd>
            </>
          )}
        </dl>
      </>
    );
  };

  const inputId = 'confirm-input';
  const inputError = request.input ? fieldIssueText(request.input, error, t) : null;

  return (
    <dialog
      ref={dialogRef}
      className={destructive ? 'confirm-dialog is-destructive' : 'confirm-dialog'}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h2 id="confirm-title">
        {t('confirm.titleWithAction', { title: t('confirm.title'), action: actionLabel })}
      </h2>

      {step === 'input' && request.input && (
        <form onSubmit={onSubmitInput} noValidate>
          <dl className="kv">
            <dt>{t('confirm.server')}</dt>
            <dd>{server.label}</dd>
            {request.subject && (
              <>
                <dt>{t('confirm.target')}</dt>
                <dd>{t('confirm.targetValue', { name: request.subject.name, steamId: request.subject.steamId })}</dd>
              </>
            )}
          </dl>
          {error && <ErrorView error={error} t={t} inlineFields={[request.input]} />}
          <div className="field">
            <label htmlFor={inputId}>
              {request.input === 'reason'
                ? t('confirm.reasonLabel', { max: REASON_MAX_LENGTH })
                : t('confirm.messageLabel', { max: MESSAGE_MAX_LENGTH })}
            </label>
            <input
              id={inputId}
              type="text"
              value={text}
              autoFocus
              autoComplete="off"
              maxLength={request.input === 'reason' ? REASON_MAX_LENGTH : MESSAGE_MAX_LENGTH}
              required={request.input === 'message'}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? `${inputId}-error` : undefined}
              onChange={(e) => setText(e.target.value)}
            />
            {inputError && (
              <small id={`${inputId}-error`} role="alert">
                {inputError}
              </small>
            )}
          </div>
          <div className="button-row">
            <button type="button" onClick={close}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="button-primary push-end"
              disabled={request.input === 'message' && text.trim() === ''}
            >
              {t('confirm.next')}
            </button>
          </div>
        </form>
      )}

      {step === 'preparing' && (
        <>
          <p aria-live="polite">{t('confirm.preparing')}</p>
          <div className="button-row">
            <button type="button" onClick={close}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      )}

      {(step === 'confirm' || step === 'executing') && prepared && (
        <>
          {destructive && (
            <p className="alert alert-error">
              <strong>{t('confirm.destructive')}</strong>
            </p>
          )}
          {renderSummary()}
          <p className="muted">{t('confirm.expires', { time: time(prepared.expiresAt) })}</p>
          {destructive && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={ack}
                disabled={step === 'executing'}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>{t('confirm.acknowledge')}</span>
            </label>
          )}
          <div className="button-row">
            <button type="button" onClick={close} disabled={step === 'executing'} autoFocus>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={destructive ? 'button-danger push-end' : 'button-primary push-end'}
              disabled={step === 'executing' || (destructive && !ack)}
              aria-busy={step === 'executing'}
              onClick={() => void execute()}
            >
              {step === 'executing' ? t('confirm.executing') : t('confirm.execute')}
            </button>
          </div>
        </>
      )}

      {step === 'done' && prepared && (
        <>
          <p className="alert alert-ok" role="status">
            {t('confirm.success', { action: t(`action.${prepared.action}`) })}
          </p>
          <div className="button-row">
            <button type="button" className="button-primary" onClick={close} autoFocus>
              {t('common.close')}
            </button>
          </div>
        </>
      )}

      {step === 'failed' && error && failedPhase === 'execute' && UNKNOWN_RESULT.has(error.code) && (
        <>
          <div className="alert alert-warn" role="alert">
            <p>
              <strong>{t('confirm.unknownResult', { action: actionLabel })}</strong>
            </p>
            <p>{t('confirm.unknownResultHelp')}</p>
          </div>
          <div className="button-row">
            <button type="button" onClick={close} autoFocus>
              {t('common.close')}
            </button>
            <a className="button push-end" href={`/audit?server=${encodeURIComponent(server.id)}`}>
              {t('confirm.toAudit')}
            </a>
          </div>
        </>
      )}

      {step === 'failed' && error && !(failedPhase === 'execute' && UNKNOWN_RESULT.has(error.code)) && (
        <>
          <ErrorView
            error={error}
            t={t}
            lead={failedPhase === 'prepare' ? t('confirm.prepareFailed') : t('confirm.failed', { action: actionLabel })}
          />
          <div className="button-row">
            <button type="button" onClick={close} autoFocus>
              {t('common.close')}
            </button>
            {!(failedPhase === 'execute' && NO_RETRY.has(error.code)) && (
              <button type="button" className="push-end" onClick={restart}>
                {t('confirm.restart')}
              </button>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
