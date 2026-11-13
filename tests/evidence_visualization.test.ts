import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectDeterministicVisualization } from '../src/services/visualizationSelector';
import { generateEvidenceBasedSummary } from '../src/services/summaryEngine';
import { parseQueryPlan } from '../src/services/queryPlan';
import { PREBUILT_DATASETS } from '../src/services/sampleData';
import { profileDatasetSchema } from '../src/services/schemaProfiler';

const schema = profileDatasetSchema(PREBUILT_DATASETS.ecommerce.dataset);

describe('Evidence-aligned visualization and grouped narratives', () => {
  it('does not chart a single aggregate against itself', () => {
    const chart = selectDeterministicVisualization('Total sales', parseQueryPlan({ intent: 'overview', metric: 'sales' }), [{ total_sales: 100 }], ['total_sales'], schema, { type: 'bar', xAxisKey: 'total_sales', yAxisKey: 'total_sales', title: 'Misleading self comparison' });
    assert.equal(chart, undefined);
  });

  it('uses the requested quantity rather than a secondary revenue measure', () => {
    const plan = parseQueryPlan({ intent: 'top_n_per_group', partition_by: ['region'], item_entity: 'product', dimensions: ['region', 'product'], metric: 'quantity', limit: 1 });
    const rows = [{ region: 'West', product: 'Laptop', total_sales: 3798, total_units_sold: 3 }];
    const columns = Object.keys(rows[0]);
    const chart = selectDeterministicVisualization('Most sold product in each region', plan, rows, columns, schema, { type: 'bar', xAxisKey: 'region', yAxisKey: 'total_sales', title: 'Revenue leader' });
    assert.equal(chart?.yAxisKey, 'total_units_sold');
    assert.equal(chart?.isAggregated, true);
    assert.ok(!chart?.title.includes('Revenue leader'));
    const insight = generateEvidenceBasedSummary({ question: 'Most sold product in each region', sql: 'SELECT region, product, SUM(quantity) AS total_units_sold, SUM(sales) AS total_sales FROM orders GROUP BY region, product', status: 'verified', rows, columns, rowCount: rows.length, tableName: 'orders', datasetName: 'Fixture', queryPlan: plan, semanticSchema: schema });
    assert.match(insight.summary || '', /total[_ ]units[_ ]sold/i);
    assert.ok(!insight.summary?.includes('3,798'));
    assert.ok(!JSON.stringify(insight.business_implications).includes('concentration'));
  });

  it('does not collapse multiple ranked items within a group into one misleading bar', () => {
    const plan = parseQueryPlan({ intent: 'top_n_per_group', partition_by: ['region'], item_entity: 'product', dimensions: ['region', 'product'], metric: 'quantity', limit: 2 });
    const rows = [{ region: 'West', product: 'A', total_quantity: 8 }, { region: 'West', product: 'B', total_quantity: 4 }];
    assert.equal(selectDeterministicVisualization('Top 2 products in each region', plan, rows, Object.keys(rows[0]), schema), undefined);
  });

  it('does not label limited dimension aggregates as top-ranked entities', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['region'], metric: 'sales', limit: 2 });
    const rows = [{ region: 'West', total_sales: 12 }, { region: 'East', total_sales: 4 }];
    const chart = selectDeterministicVisualization('Sales by region', plan, rows, Object.keys(rows[0]), schema);
    assert.equal(chart?.isAggregated, true);
    assert.ok(!chart?.title.startsWith('Top'));
  });

  it('labels ascending rankings as bottom, not top', () => {
    const plan = parseQueryPlan({ intent: 'ranking', dimensions: ['product'], metric: 'sales', ranking_direction: 'ASC', limit: 2 });
    const rows = [{ product: 'A', total_sales: 1 }, { product: 'B', total_sales: 2 }];
    assert.match(selectDeterministicVisualization('Bottom 2 products by sales', plan, rows, Object.keys(rows[0]), schema)?.title || '', /^Bottom 2/);
  });
});
