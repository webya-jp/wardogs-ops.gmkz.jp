// 書き込みボタンの可否(docs/ARCHITECTURE.md 6.4・7.4・9 章)。
// - features.writes が false(段階 1)→ 無効
// - capabilities が missing → 無効(理由を表示)
// - unknown → 有効のまま「未確認」と表示し、実行時のエラーで判断する
import type { CapabilitiesResponse, WriteAction } from '../../types/api';
import type { MessageKey } from '../../i18n';

export interface Gate {
  disabled: boolean;
  /** ボタンの近くに出す注記(無ければ null) */
  note: MessageKey | null;
}

export function gateFor(action: WriteAction, caps: CapabilitiesResponse | null, writesEnabled: boolean): Gate {
  if (!writesEnabled) return { disabled: true, note: 'gate.writesDisabled' };
  const state = caps?.write[action];
  if (state === 'missing') return { disabled: true, note: 'gate.missing' };
  if (state === 'unknown') return { disabled: false, note: 'gate.unknown' };
  return { disabled: false, note: null };
}

/** 一覧の上にまとめて出す注記(操作ごとに 1 行。注記の無い操作は出さない) */
export function gateNotes(
  actions: readonly WriteAction[],
  caps: CapabilitiesResponse | null,
  writesEnabled: boolean,
): { action: WriteAction; note: MessageKey }[] {
  if (!writesEnabled) return [];
  const out: { action: WriteAction; note: MessageKey }[] = [];
  for (const action of actions) {
    const g = gateFor(action, caps, writesEnabled);
    if (g.note) out.push({ action, note: g.note });
  }
  return out;
}
