// ヘッダータブとサイドバーの縦ナビの定義(docs/ARCHITECTURE.md 9.0・9.2)。
// タブと縦ナビは同じ配列から作り、ラベルも同じキー(tabs.*)を使う(呼び名が食い違わないように)。
// 縦ナビをやめる場合は inSidebar を false にするだけでよい(要確認 U-16)。
import type { MessageKey } from '../i18n';

export type NavId = 'overview' | 'players' | 'bans' | 'audit' | 'settings' | 'killfeed';

export interface NavItem {
  id: NavId;
  href: string;
  label: MessageKey;
  /** サイドバーの縦ナビ(幅 1024px 以上)にも出す */
  inSidebar: boolean;
  /** 「準備中」の印を付ける */
  comingSoon: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', href: '/', label: 'tabs.overview', inSidebar: true, comingSoon: false },
  { id: 'players', href: '/players', label: 'tabs.players', inSidebar: true, comingSoon: false },
  { id: 'bans', href: '/bans', label: 'tabs.bans', inSidebar: true, comingSoon: false },
  { id: 'audit', href: '/audit', label: 'tabs.audit', inSidebar: true, comingSoon: false },
  { id: 'settings', href: '/servers', label: 'tabs.settings', inSidebar: true, comingSoon: false },
  { id: 'killfeed', href: '/killfeed', label: 'tabs.killfeed', inSidebar: false, comingSoon: true },
];

/** ページ内リンクに選択中のサーバーを付ける(docs/ARCHITECTURE.md 15.5)。hash は ? の後ろに付ける */
export function hrefWithServer(href: string, serverId: string | null, hash = ''): string {
  const q = serverId ? `?server=${encodeURIComponent(serverId)}` : '';
  return `${href}${q}${hash}`;
}
