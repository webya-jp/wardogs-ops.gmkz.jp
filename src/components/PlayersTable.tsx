// プレイヤー画面(/players)。/api/players を 30 秒ごとに取得し、行ごとに message / kick / ban を操作する(docs/ARCHITECTURE.md 9 章)。
// - Steam ID はログイン済みの運営者向けに全桁表示する(確定 U-3、docs/ARCHITECTURE.md 6.5)
// - STEAM_ID_PATTERN に合わない ID の行は表示だけして操作ボタンを無効にする
// - 破壊的操作(kick / ban)は行の末尾に、区切り線で他のボタンから離して置く。実行は必ず確認ダイアログを通す
// - プレイヤー名・陣営名は RCON の生データなので翻訳しない
import { useState } from 'react';
import { POLL_MIN_INTERVAL_SEC, STEAM_ID_PATTERN } from '../types/api';
import type { PlayersResponse } from '../types/api';
import { useCapabilities, useI18n, useResource } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { gateFor } from './lib/gate';
import { withServer } from './lib/api';
import ConfirmDialog from './ConfirmDialog';
import type { ActionRequestSpec, TargetServer } from './ConfirmDialog';
import ErrorView from './ErrorView';
import GateNotes from './GateNotes';

interface Props extends I18nProps {
  writesEnabled: boolean;
  /** 選択中のサーバー。すべての API 呼び出しに明示して送る(docs/ARCHITECTURE.md 15.5) */
  server: TargetServer;
}

const ACTIONS = ['message', 'kick', 'ban'] as const;

export default function PlayersTable({ language, timeZone, writesEnabled, server }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, num } = i18n;
  const players = useResource<PlayersResponse>(withServer('/api/players', server.id), POLL_MIN_INTERVAL_SEC);
  const caps = useCapabilities(server.id);
  const [request, setRequest] = useState<ActionRequestSpec | null>(null);

  const messageGate = gateFor('message', caps, writesEnabled);
  const kickGate = gateFor('kick', caps, writesEnabled);
  const banGate = gateFor('ban', caps, writesEnabled);
  const list = players.data?.players ?? [];

  return (
    <section aria-labelledby="players-title">
      <div className="toolbar">
        <h1 id="players-title">{t('players.title')}</h1>
        {players.data && <span className="badge">{t('players.count', { count: num(players.data.count) })}</span>}
        <span className="spacer" />
        <button type="button" className="button-small" onClick={players.refresh} disabled={players.loading}>
          {players.loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <p className="muted">
        {players.updatedAt !== null && <>{t('common.lastUpdated', { time: time(players.updatedAt) })} </>}
        {t('common.autoRefresh', { seconds: POLL_MIN_INTERVAL_SEC })}
      </p>
      <GateNotes actions={ACTIONS} caps={caps} writesEnabled={writesEnabled} t={t} />
      {players.error && (
        <>
          <ErrorView error={players.error} t={t} />
          {players.data && <p className="muted">{t('common.staleData')}</p>}
        </>
      )}
      {!players.data && !players.error && <p aria-live="polite">{t('common.loading')}</p>}
      {players.data && list.length === 0 && <p className="card">{t('players.empty')}</p>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th scope="col">{t('players.col.name')}</th>
                <th scope="col">{t('players.col.faction')}</th>
                <th scope="col">{t('players.col.kd')}</th>
                <th scope="col">{t('players.col.ping')}</th>
                <th scope="col">{t('players.col.steamId')}</th>
                <th scope="col">{t('players.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const validId = STEAM_ID_PATTERN.test(p.steamId);
                return (
                  <tr key={p.steamId}>
                    <td data-label={t('players.col.name')}>
                      <strong>{p.name}</strong>
                    </td>
                    <td data-label={t('players.col.faction')}>{p.faction ?? t('common.unknown')}</td>
                    <td data-label={t('players.col.kd')} className="num">
                      {t('players.kdValue', { kills: num(p.kills), deaths: num(p.deaths) })}
                    </td>
                    <td data-label={t('players.col.ping')} className="num">
                      {p.pingMs === null ? t('common.none') : t('players.pingValue', { ping: num(p.pingMs) })}
                    </td>
                    <td data-label={t('players.col.steamId')}>
                      <span className="steam-id">{p.steamId}</span>
                    </td>
                    <td className="actions">
                      {validId ? (
                        <div className="row-actions" role="group" aria-label={t('players.rowActions', { name: p.name })}>
                          <button
                            type="button"
                            className="button-small"
                            disabled={messageGate.disabled}
                            onClick={() => setRequest({ action: 'message', params: { steamId: p.steamId }, input: 'message', subject: { name: p.name, steamId: p.steamId } })}
                          >
                            {t('action.message')}
                          </button>
                          <span className="destructive-group">
                            <button
                              type="button"
                              className="button-small button-outline-danger"
                              disabled={kickGate.disabled}
                              onClick={() => setRequest({ action: 'kick', params: { steamId: p.steamId }, input: 'reason', subject: { name: p.name, steamId: p.steamId } })}
                            >
                              {t('action.kick')}
                            </button>
                            <button
                              type="button"
                              className="button-small button-outline-danger"
                              disabled={banGate.disabled}
                              onClick={() => setRequest({ action: 'ban', params: { steamId: p.steamId }, input: 'reason', subject: { name: p.name, steamId: p.steamId } })}
                            >
                              {t('action.ban')}
                            </button>
                          </span>
                        </div>
                      ) : (
                        <span className="muted">{t('players.invalidSteamId')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        i18n={i18n}
        server={server}
        request={request}
        onClose={() => setRequest(null)}
        onDone={(action) => {
          if (action === 'kick' || action === 'ban') players.refresh();
        }}
      />
    </section>
  );
}
