// @ts-check
// 構成方針は docs/ARCHITECTURE.md 第 3 章を参照。
// - output: 'server'。全ページを Worker で描画する(ログイン判定を全ページに掛けるため)
// - React は操作画面のアイランドだけに使う
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

export default defineConfig({
  output: 'server',
  trailingSlash: 'ignore',
  // Astro Sessions は使わない(SESSION KV バインディングを自動で作らせない)。ログイン状態は署名付き Cookie で持つ
  session: false,
  // Astro 標準の origin 検査は無効化し、middleware(src/lib/csrf.ts)で行う。docs/ARCHITECTURE.md 5.5。
  // 標準検査はフォーム形式の POST だけが対象で、middleware より先に本文を読まずに 403(セキュリティヘッダ無し)を返すため
  security: { checkOrigin: false },
  integrations: [react()],
  adapter: cloudflare({
    // 画像の変換は使わない(Images バインディングや sharp を要求しない)
    imageService: 'passthrough',
  }),
});
