// テスト専用: Node の node:sqlite を D1 の最小互換(prepare / bind / first / run / all / batch)で包む。
// @types/node を入れていないため、型は any で受ける(本番コードからは import しない)

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function makeD1(): Promise<D1Database> {
  const mod: any = await import(/* @vite-ignore */ `node:${'sqlite'}`);
  const nodeFs: any = await import(/* @vite-ignore */ `node:${'fs'}`);
  const raw = new mod.DatabaseSync(':memory:');
  raw.exec(nodeFs.readFileSync(new URL('../../../db/migrations/0001_init.sql', import.meta.url), 'utf-8'));
  const make = (sql: string, args: unknown[]): any => ({
    sql,
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
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return db as unknown as D1Database;
}
