// サイドバーのサーバーカードの動的項目と試合の要点、モバイルの要約行(docs/ARCHITECTURE.md 9.2・9.3・9.5)。
// - /api/status はメイン(StatusPanel)と共有のストアから読む(useSharedStatus。二重に取得しない)
// - 表示名・ホスト名:ポートは SSR の ctx から props で受け取る(/api/servers は呼ばない)
// - ゲーム内サーバー名・マップ id・experiences・陣営名は RCON の生データ、表示名・ホスト名は運営者の入力なので翻訳しない
// - 接続状態は文言 + 記号(CSS の data-state)で示し、色だけに頼らない。読み上げは状態の文言が変わったときだけ
import { SIDEBAR_FACTION_LIMIT } from '../types/api';
import type { ServerId } from '../types/api';
import type { MessageKey } from '../i18n';
import { useI18n } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { useSharedStatus } from './lib/status-store';

interface Props extends I18nProps {
  serverId: ServerId;
  /** 運営者が付けた表示名 */
  displayName: string;
  host: string;
  port: number;
}

type StateKind = 'loading' | 'ok' | 'unreachable' | 'authFailed' | 'rateLimited' | 'error';

const STATE_KEY: Record<StateKind, MessageKey> = {
  loading: 'sidebar.state.loading',
  ok: 'sidebar.state.ok',
  unreachable: 'sidebar.state.unreachable',
  authFailed: 'sidebar.state.authFailed',
  rateLimited: 'sidebar.state.rateLimited',
  error: 'sidebar.state.error',
};

export default function SidebarStatus({ language, timeZone, serverId, displayName, host, port }: Props) {
  const { t, time, num } = useI18n({ language, timeZone });
  const status = useSharedStatus(serverId);
  const s = status.data;
  const err = status.error;

  let kind: StateKind;
  if (!err) kind = s ? 'ok' : 'loading';
  else if (err.code === 'RCON_UNREACHABLE' || err.code === 'RCON_TIMEOUT') kind = 'unreachable';
  else if (err.code === 'RCON_AUTH_FAILED') kind = 'authFailed';
  else if (err.code === 'RCON_RATE_LIMITED') kind = 'rateLimited';
  else kind = 'error';

  const stateText = t(STATE_KEY[kind]);
  const playersText = s ? t('sidebar.card.playersValue', { current: num(s.players.current), max: num(s.players.max) }) : null;
  const modes = (s?.experiences ?? []).filter((m) => m !== '');

  const scores = s?.factionScores ?? [];
  const shownScores = scores.slice(0, SIDEBAR_FACTION_LIMIT);
  const moreFactions = scores.length - shownScores.length;
  const nextMap = s ? (s.rotation.nextMapName ?? s.rotation.nextMap ?? null) : null;
  const nowIndex = s?.rotation.nowIndex ?? null;
  const count = s?.rotation.count ?? null;
  const rotationText =
    nowIndex === null
      ? null
      : count !== null
        ? t('sidebar.match.rotationValue', { now: num(nowIndex + 1), count: num(count) })
        : t('sidebar.match.rotationIndexOnly', { now: num(nowIndex + 1) });
  const hasMatch = shownScores.length > 0 || nextMap !== null || rotationText !== null;

  return (
    <>
      {/* モバイル(1024px 未満)で閉じているときだけ見える 1 行の要約 */}
      <p className="sidebar-summary">
        <span className="sidebar-summary-name">
          {s
            ? t('sidebar.summary', { name: displayName, current: num(s.players.current), max: num(s.players.max) })
            : displayName}
        </span>
        <span className="sidebar-state-mark" data-state={kind}>
          {stateText}
        </span>
      </p>

      <section className="sidebar-section sidebar-card" aria-labelledby="sidebar-card-title">
        <h2 id="sidebar-card-title">{t('sidebar.card.title')}</h2>
        <dl className="sidebar-kv">
          <dt>{t('sidebar.card.displayName')}</dt>
          <dd>{displayName}</dd>
          {s && (
            <>
              <dt>{t('sidebar.card.gameName')}</dt>
              <dd>{s.serverName ?? t('common.unknown')}</dd>
              <dt>{t('sidebar.card.map')}</dt>
              <dd className="mono">{s.map ?? t('common.unknown')}</dd>
              <dt>{t('sidebar.card.players')}</dt>
              <dd>{playersText}</dd>
              {modes.length > 0 && (
                <>
                  <dt>{t('sidebar.card.mode')}</dt>
                  <dd>{modes.join(t('status.listSeparator'))}</dd>
                </>
              )}
            </>
          )}
          <dt>{t('sidebar.card.endpoint')}</dt>
          <dd className="mono endpoint">{t('sidebar.card.endpointValue', { host, port })}</dd>
        </dl>
        <p className="sidebar-state">
          <span className="sidebar-state-mark" data-state={kind} role="status">
            {stateText}
          </span>
          {kind === 'rateLimited' && typeof err?.retryAfterSec === 'number' && (
            <span className="muted"> {t('sidebar.state.rateLimitedRetry', { seconds: num(err.retryAfterSec) })}</span>
          )}
        </p>
        {kind === 'authFailed' && (
          <p>
            <a href={`/servers?server=${encodeURIComponent(serverId)}`}>{t('server.toSettings')}</a>
          </p>
        )}
        {err && s && <p className="muted">{t('common.staleData')}</p>}
        {status.updatedAt !== null && <p className="muted">{t('sidebar.updated', { time: time(status.updatedAt) })}</p>}
      </section>

      {hasMatch && (
        <section className="sidebar-section sidebar-match" aria-labelledby="sidebar-match-title">
          <h2 id="sidebar-match-title">{t('sidebar.match.title')}</h2>
          <dl className="sidebar-kv">
            {shownScores.length > 0 && (
              <>
                <dt>{t('sidebar.match.scores')}</dt>
                <dd>
                  <ul className="sidebar-scores">
                    {shownScores.map((f, i) => (
                      <li key={i}>
                        <span>{f.faction ?? t('common.unknown')}</span>
                        <span className="num">{num(f.score)}</span>
                      </li>
                    ))}
                  </ul>
                  {moreFactions > 0 && <span className="muted">{t('sidebar.match.moreFactions', { n: num(moreFactions) })}</span>}
                </dd>
              </>
            )}
            {nextMap !== null && (
              <>
                <dt>{t('sidebar.match.nextMap')}</dt>
                <dd>{nextMap}</dd>
              </>
            )}
            {rotationText !== null && (
              <>
                <dt>{t('sidebar.match.rotation')}</dt>
                <dd>{rotationText}</dd>
              </>
            )}
          </dl>
        </section>
      )}
    </>
  );
}
