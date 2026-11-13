import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { executeValidatedSql } from '../src/services/sqlEngine';
import { PREBUILT_DATASETS, inferDatasetSchema } from '../src/services/sampleData';
import { profileDatasetSchema } from '../src/services/schemaProfiler';
import { parseQueryPlan, type QueryPlan } from '../src/services/queryPlan';
import { validateExecutionResult, validateSqlIntent } from '../src/services/validators';
import { constructSqlFromPlan } from '../src/services/sqlBlueprints';
import { telemetryAuditor } from '../src/services/telemetryAuditor';
import { getDeterministicCuratedQuery } from '../src/services/aiService';

const dataset = PREBUILT_DATASETS.saas.dataset;
const schema = profileDatasetSchema(dataset);

// Execute blueprint regressions against local DuckDB WASM, not a SQL mock or
// the production browser-only execution path (whose guard remains tested below).
describe('SQL blueprint semantics and model-input boundary', () => {
  let connection: { query(sql: string): { toArray(): { toJSON(): Record<string, unknown> }[] }; close(): void };
  before(async () => {
    const require = createRequire(import.meta.url);
    const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
    const db = await duckdb.createDuckDB({ mvp: {
      mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'), mainWorker: '',
    } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    db.open({});
    connection = db.connect();
    connection.query(`CREATE TABLE records AS SELECT * FROM (VALUES
      ('East', 'Online', 'Alpha', 10.0::DOUBLE, '2025-01-01', TRUE, 'O''Brien'),
      ('East', 'Online', 'Alpha', 20.0, '2025-01-12', TRUE, 'O''Brien'),
      ('East', 'Online', 'Beta', 5.0, '2025-02-01', FALSE, 'Beta'),
      ('East', 'Store', 'Alpha', 7.0, '2025-01-20', TRUE, 'O''Brien'),
      ('East', 'Store', 'Beta', 15.0, '2025-02-02', TRUE, 'Beta'),
      ('West', 'Online', 'Alpha', 30.0, '2025-02-03', TRUE, NULL),
      ('West', 'Online', 'Beta', 12.0, '2025-02-04', FALSE, 'Beta'),
      ('West', 'Store', 'Gamma', 0.0, '2025-03-02', TRUE, 'Zero')
    ) AS data(region, channel, product, amount, occurred_on, active, note)`);
    connection.query('CREATE TABLE many_records AS SELECT range AS id FROM range(16)');
    connection.query(`CREATE TABLE "odd"" table" AS SELECT region AS "select", channel AS "channel.name", product AS "item""name", amount AS "net revenue", note AS "note text" FROM records`);
  });
  after(() => connection?.close());
  const rows = (sql: string) => connection.query(sql).toArray().map((row) =>
    Object.fromEntries(Object.entries(row.toJSON()).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])));
  const execute = (raw: unknown, table = 'records') => rows(constructSqlFromPlan(parseQueryPlan(raw), table));

  it('keeps filtered dimension lookups as duplicate detail rows with explicit sorting and limit', () => {
    const raw = { intent: 'filter_lookup', dimensions: ['product'], metric: 'amount', ranking_direction: 'ASC', limit: 2,
      filters: [{ column: 'note', operator: '=', value: "O'Brien" }] };
    const sql = constructSqlFromPlan(parseQueryPlan(raw), 'records');
    assert.doesNotMatch(sql, /GROUP BY|COUNT\(|SUM\(/);
    assert.deepEqual(rows(sql), [{ product: 'Alpha', amount: 7 }, { product: 'Alpha', amount: 10 }]);
    assert.equal(execute({ ...raw, limit: undefined }).length, 3);
  });

  it('does not impose an unrequested overview limit and preserves an explicit ascending ranking limit', () => {
    assert.equal(execute({ intent: 'overview' }, 'many_records').length, 16);
    assert.equal(execute({ intent: 'overview', dimensions: ['id'], limit: 3 }, 'many_records').length, 3);
    const sql = constructSqlFromPlan(parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'amount', ranking_direction: 'ASC', limit: 1 }), 'records');
    assert.deepEqual(rows(sql), [{ product: 'Gamma', total_amount: 0 }]);
  });

  it('does not invent a global ranking limit when the plan does not request one', () => {
    const sql = constructSqlFromPlan(parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'amount' }), 'records');
    assert.doesNotMatch(sql, /LIMIT/i);
    assert.equal(rows(sql).length, 3);
  });

  it('rejects nonadditive percentage denominators instead of presenting invalid shares', () => {
    for (const aggregation of ['AVG', 'MIN', 'MAX', 'COUNT_DISTINCT']) {
      assert.throws(() => constructSqlFromPlan(parseQueryPlan({ intent: 'percentage_of_total', dimensions: ['region'], metric: 'amount', aggregation }), 'records'), /additive/);
    }
  });

  it('limits a count distribution without silently changing it into a metric ranking', () => {
    const raw = { intent: 'distribution', dimensions: ['region', 'channel'], aggregation: 'COUNT', ranking_direction: 'ASC', limit: 1 };
    const sql = constructSqlFromPlan(parseQueryPlan(raw), 'records');
    assert.match(sql, /GROUP BY region, channel/);
    assert.doesNotMatch(sql, /sales|quantity/);
    assert.deepEqual(rows(sql), [{ region: 'West', channel: 'Store', row_count: 1, total_count: 1 }]);
  });

  it('preserves comparison dimensions, aggregation, filters, direction and limit', () => {
    assert.deepEqual(execute({ intent: 'comparison', dimensions: ['region', 'channel'], metric: 'amount', aggregation: 'AVG', ranking_direction: 'ASC', limit: 1,
      filters: [{ column: 'active', operator: '=', value: true }, { column: 'amount', operator: '>', value: 0 }] }),
    [{ region: 'East', channel: 'Store', row_count: 2, total_amount: 11 }]);
  });

  it('uses every partition and applies ascending per-group ranking before final ascending ordering', () => {
    const plan = parseQueryPlan({ intent: 'top_n_per_group', partition_by: ['region', 'channel'], item_entity: 'product', metric: 'amount', ranking_direction: 'ASC', limit: 1 });
    const original = JSON.stringify(plan);
    const sql = constructSqlFromPlan(plan, 'records');
    assert.match(sql, /PARTITION BY region, channel ORDER BY SUM\(amount\) ASC/);
    assert.deepEqual(rows(sql), [
      { region: 'West', channel: 'Store', product: 'Gamma', total_amount: 0 },
      { region: 'East', channel: 'Online', product: 'Beta', total_amount: 5 },
      { region: 'East', channel: 'Store', product: 'Alpha', total_amount: 7 },
      { region: 'West', channel: 'Online', product: 'Beta', total_amount: 12 },
    ]);
    assert.equal(JSON.stringify(plan), original);
    assert.equal(rows(constructSqlFromPlan({ ...plan, limit: 2 }, 'records')).length, 7);
  });

  it('preserves all percentage dimensions, filters, direction and limit against the full filtered denominator', () => {
    const raw = { intent: 'percentage_of_total', dimensions: ['region', 'channel'], metric: 'amount', ranking_direction: 'ASC', limit: 1,
      filters: [{ column: 'region', operator: '=', value: 'East' }, { column: 'active', operator: '=', value: true }] };
    assert.deepEqual(execute(raw), [{ region: 'East', channel: 'Store', category_total: 22, pct_of_total: 42.31 }]);
    assert.equal(execute({ ...raw, limit: undefined }).length, 2);
    assert.deepEqual(execute({ ...raw, filters: [{ column: 'amount', operator: '=', value: 0 }] }),
      [{ region: 'West', channel: 'Store', category_total: 0, pct_of_total: null }]);
  });

  it('generates typed IN literals, escapes quotes and keeps null equality semantics', () => {
    const sql = constructSqlFromPlan(parseQueryPlan({ intent: 'filter_lookup', dimensions: ['product', 'amount'], ranking_direction: 'ASC', filters: [
      { column: 'note', operator: 'IN', value: ["O'Brien", 'Beta'] },
      { column: 'amount', operator: 'IN', value: [7, 15] },
      { column: 'active', operator: 'IN', value: [true] },
    ] }), 'records');
    assert.match(sql, /note IN \('O''Brien', 'Beta'\)/);
    assert.deepEqual(rows(sql), [{ product: 'Alpha', amount: 7 }, { product: 'Beta', amount: 15 }]);
    assert.equal(execute({ intent: 'filter_lookup', filters: [{ column: 'note', operator: '=', value: null }] }).length, 1);
    assert.equal(execute({ intent: 'filter_lookup', filters: [{ column: 'note', operator: '!=', value: null }] }).length, 7);
    assert.equal(execute({ intent: 'filter_lookup', filters: [{ column: 'note', operator: 'IS NULL' }] }).length, 1);
    assert.equal(execute({ intent: 'filter_lookup', filters: [{ column: 'note', operator: 'IS NOT NULL' }] }).length, 7);
    assert.equal(execute({ intent: 'filter_lookup', filters: [{ column: 'product', operator: 'LIKE', value: 'Al%' }] }).length, 4);
  });

  it('emits valid COUNT DISTINCT and counts rows without invented metric columns', () => {
    assert.deepEqual(execute({ intent: 'aggregate_by_dimension', dimensions: ['region'], metric: 'product', aggregation: 'COUNT_DISTINCT' }),
      [{ region: 'West', row_count: 3, total_product: 3 }, { region: 'East', row_count: 5, total_product: 2 }]);
    for (const metric of [undefined, '*']) {
      assert.deepEqual(execute({ intent: 'overview', aggregation: 'COUNT', metric }), [{ total_count: 8 }]);
      assert.deepEqual(execute({ intent: 'ranking', dimensions: ['product'], aggregation: 'COUNT', metric, limit: 1 }), [{ product: 'Alpha', total_count: 4 }]);
      assert.deepEqual(execute({ intent: 'percentage_of_total', dimensions: ['product'], aggregation: 'COUNT', metric, limit: 1 }),
        [{ product: 'Alpha', category_total: 4, pct_of_total: 50 }]);
    }
  });

  it('quotes reserved, spaced, dotted and double-quote identifiers including aliases and table names', () => {
    assert.deepEqual(execute({ intent: 'top_n_per_group', partition_by: ['select', 'channel.name'], item_entity: 'item"name', metric: 'net revenue', ranking_direction: 'ASC', limit: 1 }, 'odd" table'), [
      { select: 'West', 'channel.name': 'Store', 'item"name': 'Gamma', 'total_net revenue': 0 },
      { select: 'East', 'channel.name': 'Online', 'item"name': 'Beta', 'total_net revenue': 5 },
      { select: 'East', 'channel.name': 'Store', 'item"name': 'Alpha', 'total_net revenue': 7 },
      { select: 'West', 'channel.name': 'Online', 'item"name': 'Beta', 'total_net revenue': 12 },
    ]);
    assert.deepEqual(execute({ intent: 'filter_lookup', dimensions: ['item"name'], filters: [{ column: 'note text', operator: '=', value: "O'Brien" }] }, 'odd" table'),
      [{ 'item"name': 'Alpha' }, { 'item"name': 'Alpha' }, { 'item"name': 'Alpha' }]);
    assert.deepEqual(execute({ intent: 'percentage_of_total', dimensions: ['select', 'channel.name'], metric: 'net revenue', limit: 1 }, 'odd" table'),
      [{ select: 'West', 'channel.name': 'Online', category_total: 42, pct_of_total: 42.42 }]);
  });

  it('preserves monthly time grain and additional dimensions despite a requested limit', () => {
    const sql = constructSqlFromPlan(parseQueryPlan({ intent: 'time_trend', dimensions: ['occurred_on', 'region'], metric: 'amount', time_grain: 'month', ranking_direction: 'ASC', limit: 2, filters: [{ column: 'region', operator: '=', value: 'East' }] }), 'records');
    assert.match(sql, /GROUP BY DATE_TRUNC\('month', CAST\(occurred_on AS TIMESTAMP\)\), region/);
    assert.deepEqual(rows(sql).map(({ occurred_on, ...row }) => ({ ...row, date: new Date(Number(occurred_on)).toISOString().slice(0, 10) })), [
      { region: 'East', row_count: 3, total_amount: 37, date: '2025-01-01' },
      { region: 'East', row_count: 2, total_amount: 20, date: '2025-02-01' },
    ]);
  });

  it('rejects missing required partitions, items, dimensions or metrics instead of guessing columns', () => {
    for (const raw of [
      { intent: 'top_n_per_group', item_entity: 'product', metric: 'amount' },
      { intent: 'top_n_per_group', partition_by: ['region'], metric: 'amount' },
      { intent: 'ranking', metric: 'amount' },
      { intent: 'ranking', dimensions: ['product'] },
      { intent: 'aggregate_by_dimension', metric: 'amount' },
      { intent: 'aggregate_by_dimension', dimensions: ['region'] },
      { intent: 'percentage_of_total', metric: 'amount' },
      { intent: 'percentage_of_total', dimensions: ['region'] },
      { intent: 'time_trend', dimensions: ['occurred_on'] },
      { intent: 'overview', aggregation: 'COUNT_DISTINCT' },
      { intent: 'ranking', dimensions: ['product'], metric: '*', aggregation: 'SUM' },
    ]) assert.throws(() => constructSqlFromPlan(parseQueryPlan(raw), 'records'), /requires|supports/);
  });

  it('rejects unsafe operators, literals, limits and SQL-control enum values before interpolation', () => {
    const base = parseQueryPlan({ intent: 'filter_lookup' });
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', '2; SELECT 1', null]) {
      assert.throws(() => constructSqlFromPlan({ ...base, limit } as QueryPlan, 'records'), /positive safe integer/);
    }
    for (const filter of [
      { column: 'amount', operator: '= 0 OR 1=1', value: 1 },
      ...[undefined, {}, [], NaN, Infinity, 'bad\0value'].map((value) => ({ column: 'amount', operator: '=', value })),
      ...[[], 'Alpha', [[1]], [{}], [undefined]].map((value) => ({ column: 'product', operator: 'IN', value })),
      { column: 'amount', operator: '>', value: null },
      { column: 'product', operator: 'LIKE', value: 1 },
    ]) assert.throws(() => constructSqlFromPlan({ ...base, filters: [filter] } as QueryPlan, 'records'), /Invalid|requires/);
    for (const override of [{ aggregation: 'SUM(amount))' }, { ranking_direction: 'ASC; SELECT 1' }, { time_grain: "month'); SELECT 1" }, { dimensions: ['bad\0name'] }]) {
      assert.throws(() => constructSqlFromPlan({ ...base, ...override } as QueryPlan, 'records'));
    }
    // A SQL-looking string is data, not an executable condition or statement.
    assert.deepEqual(execute({ intent: 'filter_lookup', filters: [{ column: 'note', operator: '=', value: "x' OR TRUE; SELECT 1" }] }), []);
  });
});

describe('Production remediation execution contract', () => {
  it('rejects destructive SQL before attempting engine execution', async () => {
    const result = await executeValidatedSql('DROP TABLE customers', dataset, parseQueryPlan({ intent: 'overview' }), 'Preview dataset');
    assert.equal(result.success, false);
    assert.deepEqual(result.passedChecks, []);
  });

  it('never verifies a query when the browser engine is unavailable', async () => {
    const result = await executeValidatedSql('SELECT * FROM customers', dataset, parseQueryPlan({ intent: 'overview' }), 'Show customers');
    assert.equal(result.success, false);
    assert.match(result.error!, /browser runtime/);
    assert.deepEqual(result.passedChecks, []);
  });

  it('permits requested filtered empty aggregates without relaxing the original plan', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['plan_tier'], metric: 'mrr', filters: [{ column: 'churn_status', operator: '=', value: 'Absent' }] });
    assert.equal(validateExecutionResult([], ['plan_tier', 'total_mrr'], plan, schema).valid, true);
    assert.equal(plan.filters?.[0].value, 'Absent');
  });

  it('still rejects empty unfiltered rankings on populated datasets', () => {
    const plan = parseQueryPlan({ intent: 'ranking', metric: 'mrr', dimensions: ['company_name'] });
    assert.equal(validateExecutionResult([], ['company_name', 'total_mrr'], plan, schema).valid, false);
  });

  it('does not apply descending ranking rules to laptop substrings', () => {
    const plan = parseQueryPlan({ intent: 'overview', dimensions: [] });
    const result = validateSqlIntent('SELECT company_name, mrr FROM customers ORDER BY company_name ASC', plan, schema, 'Show laptop sales');
    assert.equal(result.valid, true, result.errors.join('; '));
  });

  it('unrelated mrr datasets never receive a precomputed SaaS narrative', () => {
    const unrelated = inferDatasetSchema(Array.from({ length: 4000 }, (_, i) => ({ record_id: i, mrr: i + 1 })), 'uploaded', 'Unrelated data');
    for (const question of ['How many customers are present?', 'What is the total MRR?']) {
      const match = getDeterministicCuratedQuery(question, unrelated);
      assert.equal(match?.status, undefined);
      assert.ok(!match || match.insight.summary === '');
    }
  });

  it('dimension aggregation with a limit is not converted to an item ranking', () => {
    const sql = constructSqlFromPlan(parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['plan_tier'], metric: 'mrr', aggregation: 'SUM', limit: 2 }), 'customers');
    assert.match(sql, /COUNT\(\*\) AS row_count/);
    assert.match(sql, /GROUP BY plan_tier/);
    assert.match(sql, /LIMIT 2/);
  });

  it('percentage intent survives parsing and uses a protected denominator', () => {
    const plan = parseQueryPlan({ intent: 'percentage_of_total', dimensions: ['plan_tier'], metric: 'mrr' });
    assert.equal(plan.intent, 'percentage_of_total');
    assert.match(constructSqlFromPlan(plan, 'customers'), /NULLIF\(t.grand_total, 0\)/);
  });

  it('invokes the value scanner during recording and retains only field names', () => {
    telemetryAuditor.clearHistory();
    const id = telemetryAuditor.recordOutboundDispatch({ provider: 'gemini', model: 'test', endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/test:generateContent', userPrompt: 'test', systemPrompt: 'metadata', schemaColumns: ['name'], requestBody: { prompt: 'Secret Example Company' }, datasetRows: [{ name: 'Secret Example Company' }] });
    const event = telemetryAuditor.getHistory().find((entry) => entry.id === id)!;
    assert.equal(event.leakageAudit?.isSafe, false);
    assert.deepEqual(event.leakageAudit?.leakedFields, ['name']);
    assert.equal(event.wirePayloadString, undefined);
    assert.equal(event.dataRowsIncludedCount, null);
    telemetryAuditor.clearHistory();
  });

  it('missing dataset context and sampled checks never establish zero-row guarantees', () => {
    telemetryAuditor.clearHistory();
    telemetryAuditor.recordOutboundDispatch({ provider: 'groq', model: 'test', endpointUrl: 'https://api.groq.com/openai/v1/chat/completions', userPrompt: 'test', systemPrompt: 'metadata', schemaColumns: [], requestBody: {} });
    assert.equal(telemetryAuditor.getLatestEvent()?.leakageAudit, null);
    assert.equal(telemetryAuditor.getAuditStats().zeroRowGuaranteeStrict, false);
    telemetryAuditor.clearHistory();
  });
});
