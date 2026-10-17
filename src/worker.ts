// Worker のエントリ(docs/ARCHITECTURE.md 17.4)。wrangler.jsonc の "main" がこのファイルを指す。
// - fetch: Astro(@astrojs/cloudflare)の handle にそのまま委譲する(Astro 公式ガイドの「カスタムエントリ」の形。
//   https://docs.astro.build/en/guides/integrations-guide/cloudflare/ の Custom entrypoint API)
// - scheduled: Cron Trigger(wrangler.jsonc の triggers.crons。1 分ごと)。スコア記録のサンプル取得と掃除(17.3・17.7)。
//   処理の本体は src/lib/cron.ts(このファイルは呼び出しだけを持つ。runCron は例外を投げない)
// 秘密(パスワード・鍵・トークン)と接続先をログに出さない(5.7)。
import { handle } from '@astrojs/cloudflare/handler';
import { runCron } from './lib/cron';
import type { CronEnv } from './types/env';

export default {
  fetch: handle,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env as unknown as CronEnv, controller.scheduledTime));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
