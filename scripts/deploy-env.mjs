// wrangler の環境(wrangler.jsonc の env.<name>)を指定してビルドとデプロイを行う。
// 使い方: pnpm run deploy:env <name>   例: pnpm run deploy:env gmkz
// Astro の Cloudflare アダプタはビルド時に CLOUDFLARE_ENV を見て dist/server/wrangler.json を生成するため、
// ビルドとデプロイの両方に同じ環境名を渡す必要がある。
import { spawnSync } from 'node:child_process';

const name = process.argv.slice(2).find((a) => a !== '--');
if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
  console.error('usage: pnpm run deploy:env -- <environment-name>');
  process.exit(2);
}
const env = { ...process.env, CLOUDFLARE_ENV: name };
const run = (cmd, args) => {
  // Windows では pnpm.cmd を解決するため shell を使う(引数は固定値のみ)
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('pnpm', ['exec', 'astro', 'build']);
run('pnpm', ['exec', 'wrangler', 'deploy', '--env', name]);
run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--env', name]);
