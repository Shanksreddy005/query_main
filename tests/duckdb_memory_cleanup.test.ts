import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { swapActiveTable } from '../src/services/sqlEngine';

const require = createRequire(import.meta.url);

async function realEngine() {
  const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const duckdb = require(entry);
  const dist = path.dirname(entry);
  const db = await duckdb.createDuckDB(
    { mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' }, eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' } },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME
  );
  await db.instantiate();
  return { db, conn: db.connect() };
}

describe('DuckDB registration releases what it replaces', () => {
  it('keeps one table and no staging files across uploads and dataset switches', async () => {
    const engine = await realEngine();
    const rows = (tag: string) => JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, tag })));
    const tables = () => engine.conn.query('SELECT table_name FROM duckdb_tables() ORDER BY 1').toArray().map((r: any) => r.table_name);
    const staging = () => engine.db.globFiles('qm_stage_*.json').map((f: any) => f.fileName);

    await swapActiveTable(engine, null, 'alpha', rows('a'), 'qm_stage_1.json');
    await swapActiveTable(engine, 'alpha', 'beta', rows('b'), 'qm_stage_2.json');
    assert.deepEqual(tables(), ['beta', 'dataset'], 'switching datasets must drop the previous table');

    await swapActiveTable(engine, 'beta', 'beta', rows('c'), 'qm_stage_3.json');
    assert.deepEqual(tables(), ['beta', 'dataset']);
    assert.deepEqual(staging(), [], 'staging JSON copies must not stay resident');

    const tag = engine.conn.query('SELECT DISTINCT tag FROM dataset').toArray().map((r: any) => r.tag);
    assert.deepEqual(tag, ['c'], 'the alias must point at the newest upload');
    assert.equal(Number(engine.conn.query('SELECT COUNT(*) AS n FROM beta').toArray()[0].n), 200);
  });
});
