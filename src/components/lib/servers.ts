// サーバーの表示用の小さな関数(Astro ページと React アイランドの両方から使う。Worker 固有の API に依存しない)。
// 運営者が入力した表示名・ホスト名は翻訳しない(docs/ARCHITECTURE.md 13.1・15.11)。
import type { ServerId, ServerSummary } from '../../types/api';
import type { MessageKey, Translator } from '../../i18n';

/** 画面に出すサーバー名。既定サーバー(name が null)はカタログの「既定サーバー(Secrets)」 */
export function serverLabel(server: Pick<ServerSummary, 'name'>, t: Translator): string {
  return server.name ?? t('server.defaultName');
}

/** 操作ログの行のサーバー名(削除済み・改名後でも記録時点の名前を出す) */
export function auditServerLabel(serverId: ServerId | null | undefined, serverName: string | null | undefined, t: Translator): string {
  if (serverName) return serverName;
  if (serverId === 'default') return t('server.defaultName');
  if (serverId) return t('server.idOnly', { id: serverId });
  return t('common.none');
}

/** 使えないサーバーの理由(使えるなら null) */
export function unusableReason(server: ServerSummary): MessageKey | null {
  if (server.usable) return null;
  if (!server.enabled) return 'server.unusable.disabled';
  if (server.needsPassword) return 'server.unusable.needsPassword';
  if (server.secretsIssue) return 'server.unusable.secrets';
  return 'server.unusable.other';
}
