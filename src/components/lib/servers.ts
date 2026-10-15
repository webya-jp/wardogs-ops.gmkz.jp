// サーバーの表示用の小さな関数(Astro ページと React アイランドの両方から使う。Worker 固有の API に依存しない)。
// 運営者が入力した表示名・ホスト名は翻訳しない(docs/ARCHITECTURE.md 13.1・15.11)。
import { WRITE_ACTIONS } from '../../types/api';
import type { AuditEntry, ServerSummary } from '../../types/api';
import type { MessageKey, Translator } from '../../i18n';

/** 画面に出すサーバー名(運営者が付けた表示名をそのまま出す) */
export function serverLabel(server: Pick<ServerSummary, 'name'>, _t?: Translator): string {
  return server.name;
}

/**
 * 操作ログの行のサーバー名(削除済み・改名後でも記録時点の名前を出す)。
 * serverId が null のとき: 書き込み操作の行(複数サーバー対応前の行)は「不明」、
 * login / logout・admin_register などサーバーに紐付かない行は「なし」(docs/API.md、src/types/api.ts AuditEntry)
 */
export function auditServerLabel(
  entry: Pick<AuditEntry, 'event' | 'serverId' | 'serverName'>,
  t: Translator,
): string {
  if (entry.serverName) return entry.serverName;
  if (entry.serverId) return t('server.idOnly', { id: entry.serverId });
  return (WRITE_ACTIONS as readonly string[]).includes(entry.event) ? t('common.unknown') : t('common.none');
}

/** 使えないサーバーの理由(使えるなら null) */
export function unusableReason(server: ServerSummary): MessageKey | null {
  if (server.usable) return null;
  if (!server.enabled) return 'server.unusable.disabled';
  if (server.needsPassword) return 'server.unusable.needsPassword';
  return 'server.unusable.other';
}
