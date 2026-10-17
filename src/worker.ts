// Worker のエントリ(docs/ARCHITECTURE.md 17.4)。wrangler.jsonc の "main" がこのファイルを指す。
// - fetch: Astro(@astrojs/cloudflare)の handle にそのまま委譲する(Astro 公式ガイドの「カスタムエントリ」の形。
//   https://docs.astro.build/en/guides/integrations-guide/cloudflare/ の Custom entrypoint API)
// - scheduled: Cron Trigger(wrangler.jsonc の triggers.crons。1 分ごと)。スコア記録のサンプル取得と掃除(17.3・17.7)。
//   処理の本体は backend が src/lib/cron.ts に実装し、ここから呼ぶ(このファイルは呼び出しだけを持つ)
// 秘密(パスワード・鍵・トークン)と接続先をログに出さない(5.7)。
import { handle } from '@astrojs/cloudflare/handler';

export default {
  fetch: handle,
  async scheduled(controller, _env, _ctx) {
    // backend の実装後: ctx.waitUntil(runCron(env, controller.scheduledTime)) に置き換える(17.11)。
    // 実装前は何もしない(記録中のサーバーが無いのと同じ。RCON も D1 も呼ばない)
    void controller.scheduledTime;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
