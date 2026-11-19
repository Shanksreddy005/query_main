import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateEvidenceBasedSummary, resolveRankedMetricColumn } from '../src/services/summaryEngine';
import { inferDatasetSchema, ECOMMERCE_SALES_DATA } from '../src/services/sampleData';
import { profileDatasetSchema } from '../src/services/schemaProfiler';
import { parseQueryPlan } from '../src/services/queryPlan';

// The defect these tests hold shut: a result ranked on one measure used to be described as a ranking
// on whatever revenue column the summary happened to find first, so "top products by profit" printed
// "ranked by total sales" next to profit figures. The measure named in the narrative has to come from
// the executed query, and when the executed query cannot be read the narrative has to say so.

const dataset = inferDatasetSchema(ECOMMERCE_SALES_DATA, 'orders', 'E-Commerce Sales & Profitability');
const schema = profileDatasetSchema(dataset);

interface Fixture {
  question: string;
  sql: string;
  columns: string[];
  rows: Record<string, any>[];
  plan?: any;
}

function summarise(fixture: Fixture) {
  return generateEvidenceBasedSummary({
    question: fixture.question,
    sql: fixture.sql,
    status: 'verified',
    rows: fixture.rows,
    columns: fixture.columns,
    rowCount: fixture.rows.length,
    datasetName: dataset.name,
    tableName: dataset.tableName,
    semanticSchema: schema,
    queryPlan: fixture.plan,
  });
}

function prose(summary: any): string {
  return [summary.overview, ...(summary.findings || []), ...(summary.limitations || [])].join('\n');
}

const PROFIT_ROWS = [
  { product: 'Office Storage', category: 'Technology', total_sales: 1200, total_profit: 3798, margin_pct: 37.5 },
  { product: 'Data Panel', category: 'Technology', total_sales: 5200, total_profit: 1820, margin_pct: 21.4 },
  { product: 'Pen Set', category: 'Technology', total_sales: 900, total_profit: 640, margin_pct: 18.2 },
];

const profitFixture: Fixture = {
  question: 'Top 5 products by total profit in Technology',
  sql: "SELECT product, category, ROUND(SUM(sales), 0) AS total_sales, ROUND(SUM(profit), 0) AS total_profit, ROUND((SUM(profit) / SUM(sales)) * 100, 1) AS margin_pct FROM orders WHERE category = 'Technology' GROUP BY product, category ORDER BY total_profit DESC LIMIT 5",
  columns: ['product', 'category', 'total_sales', 'total_profit', 'margin_pct'],
  rows: PROFIT_ROWS,
  plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product', 'category'], metric: 'profit', aggregation: 'SUM', ranking_direction: 'DESC', limit: 5 }),
};

const SALES_ROWS = [
  { product: 'Data Panel', total_sales: 5200, total_profit: 1820 },
  { product: 'Office Storage', total_sales: 1200, total_profit: 3798 },
  { product: 'Pen Set', total_sales: 900, total_profit: 640 },
];

const salesFixture: Fixture = {
  question: 'Top 3 products by total sales',
  sql: 'SELECT product, ROUND(SUM(sales), 0) AS total_sales, ROUND(SUM(profit), 0) AS total_profit FROM orders GROUP BY product ORDER BY total_sales DESC LIMIT 3',
  columns: ['product', 'total_sales', 'total_profit'],
  rows: SALES_ROWS,
  plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'sales', aggregation: 'SUM', ranking_direction: 'DESC', limit: 3 }),
};

describe('Executive summary — the ranked metric comes from the executed query', () => {
  it('calls a profit ranking a profit ranking even though the same result carries a sales column', () => {
    const summary = summarise(profitFixture);
    const text = prose(summary);
    assert.match(text, /ranked by total profit/, text);
    assert.doesNotMatch(text, /ranked by total sales|ranked by sales/i, text);
    assert.match(summary.overview || '', /Office Storage leads with \$3,798/, summary.overview || '');
    assert.match(summary.findings?.[0] || '', /total profit \(ranking #1\)/, summary.findings?.[0] || '');
  });

  it('calls a sales ranking a sales ranking on the same products', () => {
    const summary = summarise(salesFixture);
    const text = prose(summary);
    assert.match(text, /ranked by total sales/, text);
    assert.doesNotMatch(text, /ranked by total profit|ranked by profit/i, text);
    assert.match(summary.overview || '', /Data Panel leads with \$5,200/, summary.overview || '');
  });

  it('follows the measure when only the ORDER BY changes', () => {
    const byProfit = summarise(profitFixture);
    const bySales = summarise(salesFixture);
    assert.match(byProfit.overview || '', /profit/);
    assert.match(bySales.overview || '', /sales/);
    assert.doesNotMatch(byProfit.overview || '', /sales/);
    assert.doesNotMatch(bySales.overview || '', /profit/);
  });

  it('names a quantity ranking by its projected measure, not by a money column', () => {
    const fixture: Fixture = {
      question: 'Top 3 products by units sold',
      sql: 'SELECT product, SUM(quantity) AS units, SUM(sales) AS total_sales FROM orders GROUP BY product ORDER BY quantity DESC LIMIT 3',
      columns: ['product', 'units', 'total_sales'],
      rows: [
        { product: 'Pen Set', units: 90, total_sales: 900 },
        { product: 'Data Panel', units: 40, total_sales: 5200 },
        { product: 'Office Storage', units: 12, total_sales: 1200 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'quantity', aggregation: 'SUM', ranking_direction: 'DESC', limit: 3 }),
    };
    const summary = summarise(fixture);
    const text = prose(summary);
    assert.match(text, /ranked by units/, text);
    assert.doesNotMatch(text, /ranked by total sales|ranked by sales/i, text);
    assert.match(summary.overview || '', /Pen Set leads with 90/, summary.overview || '');
  });

  it('names a row-level percentage ranking without money formatting', () => {
    const fixture: Fixture = {
      question: 'Orders with the highest discount',
      sql: 'SELECT order_id, product, discount_pct, profit FROM orders ORDER BY discount_pct DESC LIMIT 3',
      columns: ['order_id', 'product', 'discount_pct', 'profit'],
      rows: [
        { order_id: 'ORD-7009', product: 'Lockers', discount_pct: 0.3, profit: -80 },
        { order_id: 'ORD-7006', product: 'Tables', discount_pct: 0.25, profit: -45 },
        { order_id: 'ORD-7002', product: 'Phones', discount_pct: 0.15, profit: 300 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['order_id'], metric: 'discount_pct', ranking_direction: 'DESC', limit: 3 }),
    };
    const summary = summarise(fixture);
    const text = prose(summary);
    assert.match(text, /ranked by discount pct/, text);
    assert.doesNotMatch(text, /ranked by profit/i, text);
    assert.match(summary.overview || '', /ORD-7009 leads with 30%/, summary.overview || '');
  });

  it('reuses the same measure label in every finding it derives from it', () => {
    const summary = summarise(profitFixture);
    const findings = summary.findings || [];
    assert.ok(findings.length > 1, 'the ranking narrative produces more than one finding');
    for (const finding of findings) {
      assert.doesNotMatch(finding, /total sales|ranked by sales/i, finding);
    }
    assert.match(findings[1] || '', /\$1,820/, findings[1] || '');
  });
});

describe('Executive summary — ranking direction is read from the SQL', () => {
  it('describes an ascending ranking as lowest first', () => {
    const fixture: Fixture = {
      question: 'Products with the lowest total profit',
      sql: 'SELECT product, SUM(profit) AS total_profit FROM orders GROUP BY product ORDER BY total_profit ASC LIMIT 3',
      columns: ['product', 'total_profit'],
      rows: [
        { product: 'Pen Set', total_profit: 640 },
        { product: 'Data Panel', total_profit: 1820 },
        { product: 'Office Storage', total_profit: 3798 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'profit', aggregation: 'SUM', ranking_direction: 'ASC', limit: 3 }),
    };
    const summary = summarise(fixture);
    const text = prose(summary);
    assert.match(text, /ranked by total profit from lowest to highest/, text);
    assert.match(summary.overview || '', /Pen Set has the lowest at \$640/, summary.overview || '');
    assert.doesNotMatch(text, /leads with/, text);
  });

  it('treats an ORDER BY with no direction keyword as ascending, the SQL default', () => {
    const fixture: Fixture = {
      question: 'Products ordered by total profit',
      sql: 'SELECT product, SUM(profit) AS total_profit FROM orders GROUP BY product ORDER BY total_profit LIMIT 3',
      columns: ['product', 'total_profit'],
      rows: [
        { product: 'Pen Set', total_profit: 640 },
        { product: 'Data Panel', total_profit: 1820 },
        { product: 'Office Storage', total_profit: 3798 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'profit', aggregation: 'SUM', limit: 3 }),
    };
    const resolved = resolveRankedMetricColumn(fixture.sql, fixture.columns, fixture.plan);
    assert.strictEqual(resolved.column, 'total_profit');
    assert.strictEqual(resolved.direction, 'ASC');
    assert.match(prose(summarise(fixture)), /from lowest to highest/);
  });

  it('resolves a positional ORDER BY onto the projected measure', () => {
    const fixture: Fixture = {
      question: 'Top 2 products by total profit',
      sql: 'SELECT product, SUM(profit) AS total_profit FROM orders GROUP BY product ORDER BY 2 DESC LIMIT 2',
      columns: ['product', 'total_profit'],
      rows: [
        { product: 'Office Storage', total_profit: 3798 },
        { product: 'Data Panel', total_profit: 1820 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'profit', aggregation: 'SUM', ranking_direction: 'DESC', limit: 2 }),
    };
    const resolved = resolveRankedMetricColumn(fixture.sql, fixture.columns, fixture.plan);
    assert.deepStrictEqual(
      { column: resolved.column, direction: resolved.direction, basis: resolved.basis },
      { column: 'total_profit', direction: 'DESC', basis: 'order_by' }
    );
    assert.match(prose(summarise(fixture)), /ranked by total profit/);
  });
});

describe('Executive summary — multi-term and windowed ORDER BY clauses', () => {
  it('skips a sort key that carries no measure and names the measure behind it', () => {
    const fixture: Fixture = {
      question: 'Top 2 customers by MRR in each city',
      sql: 'WITH r AS (SELECT city, customer_name, SUM(mrr_usd) AS total_mrr FROM orders GROUP BY city, customer_name) SELECT city, customer_name, total_mrr FROM r ORDER BY city, total_mrr DESC',
      columns: ['city', 'customer_name', 'total_mrr'],
      rows: [
        { city: 'Bengaluru', customer_name: 'BluePeak Systems', total_mrr: 1800 },
        { city: 'Bengaluru', customer_name: 'Apex Systems', total_mrr: 1300 },
        { city: 'Chennai', customer_name: 'Evergreen Group', total_mrr: 2500 },
      ],
      plan: parseQueryPlan({
        intent: 'top_n_per_group', partition_by: ['city'], item_entity: 'customer_name',
        dimensions: ['city', 'customer_name'], metric: 'mrr_usd', ranking_direction: 'DESC', limit: 2,
      }),
    };
    const resolved = resolveRankedMetricColumn(
      fixture.sql, fixture.columns, fixture.plan, (column) => column === 'total_mrr'
    );
    assert.strictEqual(resolved.column, 'total_mrr', 'the city sort key must not become the ranked metric');
    assert.strictEqual(resolved.direction, 'DESC');
    const text = prose(summarise(fixture));
    assert.match(text, /ranked by total MRR/, text);
    assert.doesNotMatch(text, /ranked by city/i, text);
  });

  it('reads the measure out of a window function when the outer clause only sorts by rank', () => {
    const sql = 'WITH ranked_customers AS (SELECT product, category, SUM(profit) AS total_profit, ROW_NUMBER() OVER (PARTITION BY category ORDER BY SUM(profit) DESC) AS rank FROM orders GROUP BY product, category) SELECT product, category, total_profit, rank FROM ranked_customers WHERE rank <= 2 ORDER BY category, rank';
    const columns = ['product', 'category', 'total_profit', 'rank'];
    const rows = [
      { product: 'Office Storage', category: 'Technology', total_profit: 3798, rank: 1 },
      { product: 'Data Panel', category: 'Technology', total_profit: 1820, rank: 2 },
      { product: 'Pen Set', category: 'Furniture', total_profit: 640, rank: 1 },
    ];
    const plan = parseQueryPlan({
      intent: 'top_n_per_group', partition_by: ['category'], item_entity: 'product',
      dimensions: ['category', 'product'], metric: 'profit', aggregation: 'SUM', ranking_direction: 'DESC', limit: 2,
    });
    const resolved = resolveRankedMetricColumn(sql, columns, plan, (column) => column === 'total_profit');
    assert.strictEqual(resolved.column, 'total_profit', 'a window row counter is not a ranked measure');
    assert.strictEqual(resolved.direction, 'DESC');
    const text = prose(summarise({ question: 'Top 2 products by profit in each category', sql, columns, rows, plan }));
    assert.match(text, /ranked by total profit/, text);
    assert.doesNotMatch(text, /ranked by rank|ranked by category/i, text);
  });

  it('still reports a name sort as an ordering of records rather than a ranking', () => {
    const fixture: Fixture = {
      question: 'List the products',
      sql: 'SELECT product, category, SUM(profit) AS total_profit FROM orders GROUP BY product, category ORDER BY product LIMIT 3',
      columns: ['product', 'category', 'total_profit'],
      rows: [
        { product: 'Data Panel', category: 'Technology', total_profit: 1820 },
        { product: 'Office Storage', category: 'Technology', total_profit: 3798 },
        { product: 'Pen Set', category: 'Technology', total_profit: 640 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'profit', aggregation: 'SUM', limit: 3 }),
    };
    const text = prose(summarise(fixture));
    assert.match(text, /sorted by product in ASC order/, text);
    assert.doesNotMatch(text, /ranked by total profit|leads with/i, text);
  });
});

describe('Executive summary — an unidentifiable measure is reported as unidentifiable', () => {
  it('names no metric when the ORDER BY term maps onto several returned measures', () => {
    const fixture: Fixture = {
      question: 'Top products by profit',
      sql: 'SELECT product, SUM(profit) AS total_profit, ROUND(SUM(profit) / SUM(sales) * 100, 1) AS margin_pct FROM orders GROUP BY product ORDER BY profit DESC LIMIT 3',
      columns: ['product', 'total_profit', 'margin_pct'],
      rows: [
        { product: 'Office Storage', total_profit: 3798, margin_pct: 37.5 },
        { product: 'Data Panel', total_profit: 1820, margin_pct: 21.4 },
        { product: 'Pen Set', total_profit: 640, margin_pct: 18.2 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'profit', aggregation: 'SUM', ranking_direction: 'DESC', limit: 3 }),
    };
    const resolved = resolveRankedMetricColumn(
      fixture.sql, fixture.columns, fixture.plan, (column) => column !== 'product'
    );
    assert.strictEqual(resolved.column, undefined);
    assert.strictEqual(resolved.basis, 'unresolved');

    const summary = summarise(fixture);
    const text = prose(summary);
    assert.match(text, /names no ranked metric/, text);
    assert.doesNotMatch(text, /ranked by (total )?(profit|sales|margin)|leads with/i, text);
    assert.match(text, /total profit = \$3,798, margin pct = 37\.5%/, text);
    assert.ok((summary.limitations || []).some((l: string) => /cannot identify the measure/.test(l)), text);
    assert.strictEqual(summary.status, 'verified', 'an unreadable ranking metric does not invalidate the executed result');
  });

  it('refuses a leader claim when the result carries no ORDER BY term at all', () => {
    const fixture: Fixture = {
      question: 'Products by total profit',
      sql: 'SELECT product, SUM(profit) AS total_profit FROM orders GROUP BY product LIMIT 3',
      columns: ['product', 'total_profit'],
      rows: [
        { product: 'Office Storage', total_profit: 3798 },
        { product: 'Data Panel', total_profit: 1820 },
        { product: 'Pen Set', total_profit: 640 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'profit', aggregation: 'SUM', limit: 3 }),
    };
    const resolved = resolveRankedMetricColumn(fixture.sql, fixture.columns, fixture.plan);
    assert.strictEqual(resolved.basis, 'plan_metric', 'the plan may name the measure when nothing was ordered');
    assert.strictEqual(resolved.direction, undefined);

    const text = prose(summarise(fixture));
    assert.match(text, /carries no ORDER BY term/, text);
    assert.doesNotMatch(text, /leads with|lowest at|ranked by/, text);
  });

  it('reports the values it was given instead of inventing a metric when nothing resolves', () => {
    const fixture: Fixture = {
      question: 'Products by total profit',
      sql: 'SELECT product, SUM(profit) AS total_profit FROM orders GROUP BY product ORDER BY SUM(profit) - SUM(sales) DESC LIMIT 3',
      columns: ['product', 'total_profit'],
      rows: [
        { product: 'Office Storage', total_profit: 3798 },
        { product: 'Data Panel', total_profit: 1820 },
        { product: 'Pen Set', total_profit: 640 },
      ],
      plan: parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'profit', aggregation: 'SUM', ranking_direction: 'DESC', limit: 3 }),
    };
    const text = prose(summarise(fixture));
    assert.match(text, /names no ranked metric/, text);
    assert.doesNotMatch(text, /ranked by/i, text);
  });
});

describe('Executive summary — ranked metric resolver contract', () => {
  const columns = ['product', 'total_sales', 'total_profit'];

  it('prefers the ORDER BY alias over the plan metric', () => {
    const plan = parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'sales', aggregation: 'SUM', ranking_direction: 'DESC' });
    const resolved = resolveRankedMetricColumn(
      'SELECT product, SUM(sales) AS total_sales, SUM(profit) AS total_profit FROM orders GROUP BY product ORDER BY total_profit DESC',
      columns, plan, (column) => column !== 'product'
    );
    assert.strictEqual(resolved.column, 'total_profit');
    assert.strictEqual(resolved.basis, 'order_by');
  });

  it('reaches a projected measure through the source column named in ORDER BY', () => {
    const resolved = resolveRankedMetricColumn(
      'SELECT product, SUM(profit) AS total_profit FROM orders GROUP BY product ORDER BY profit DESC',
      ['product', 'total_profit'], undefined, () => true
    );
    assert.strictEqual(resolved.column, 'total_profit');
    assert.strictEqual(resolved.basis, 'projection');
  });

  it('never returns a column the query did not return', () => {
    const resolved = resolveRankedMetricColumn(
      'SELECT product, SUM(profit) AS total_profit FROM orders GROUP BY product ORDER BY order_date DESC',
      columns, undefined, () => true
    );
    assert.strictEqual(resolved.column, undefined);
    assert.strictEqual(resolved.basis, 'unresolved');
  });

  it('leaves the metric unnamed for a query with no projection to read', () => {
    const resolved = resolveRankedMetricColumn('SELECT * FROM orders', columns);
    assert.strictEqual(resolved.column, undefined);
    assert.strictEqual(resolved.basis, 'unresolved');
  });
});
