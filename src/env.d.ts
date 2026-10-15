/// <reference types="astro/client" />
// Worker のバインディング型を `cloudflare:workers` の env と Astro.locals に結び付ける。
// 型の正本は src/types/env.ts と src/types/api.ts(architect 管理)。

type OpsEnvType = import('./types/env').OpsEnv;
type SessionInfoType = import('./types/api').SessionInfo;

declare namespace Cloudflare {
  interface Env extends OpsEnvType {}
}

declare namespace App {
  interface Locals {
    /** middleware が設定する。未ログインなら null */
    session: SessionInfoType | null;
  }
}
