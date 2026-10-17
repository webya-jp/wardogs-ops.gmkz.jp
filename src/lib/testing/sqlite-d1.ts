// テスト専用: Node の node:sqlite を D1 の最小互換(prepare / bind / first / run / all / batch)で包む。
// マイグレーション(db/migrations/0001_init.sql、0002_servers.sql、0003_recordings.sql)を順に適用する。
// batch は 1 トランザクション(途中で失敗したら全体を取り消す。D1 の db.batch() と同じ前提。要確認 M-2)。
// @types/node を入れていないため、型は any で受ける(本番コードからは import しない)

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MIGRATIONS = ['0001_init.sql', '0002_servers.sql', '0003_recordings.sql'] as const;

export async function makeD1(opts: { migrations?: readonly string[] } = {}): Promise<D1Database> {
  const mod: any = await import(/* @vite-ignore */ `node:${'sqlite'}`);
  const nodeFs: any = await import(/* @vite-ignore */ `node:${'fs'}`);
  const raw = new mod.DatabaseSync(':memory:');
  for (const file of opts.migrations ?? MIGRATIONS) {
    raw.exec(nodeFs.readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf-8'));
  }
  const make = (sql: string, args: unknown[]): any => ({
    sql,
    args,
    bind: (...a: unknown[]) => make(sql, a),
    async first() {
      return raw.prepare(sql).get(...args) ?? null;
    },
    async run() {
      const r = raw.prepare(sql).run(...args);
      return { success: true, results: [], meta: { changes: Number(r.changes) } };
    },
    async all() {
      return { success: true, results: raw.prepare(sql).all(...args), meta: {} };
    },
  });
  const db = {
    prepare: (sql: string) => make(sql, []),
    async batch(stmts: any[]) {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ success: true, results: raw.prepare(s.sql).all(...s.args), meta: {} }));
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return db as unknown as D1Database;
}
