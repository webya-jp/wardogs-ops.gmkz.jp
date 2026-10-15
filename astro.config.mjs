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
  integrations: [react()],
  adapter: cloudflare({
    // 画像の変換は使わない(Images バインディングや sharp を要求しない)
    imageService: 'passthrough',
  }),
});
