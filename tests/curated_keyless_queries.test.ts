import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PREBUILT_DATASETS } from '../src/services/sampleData';
import { profileDatasetSchema } from '../src/services/schemaProfiler';
import { validateSqlIntent, checkMetricAvailability } from '../src/services/validators';
import { constructSqlFromPlan } from '../src/services/sqlBlueprints';
import { getDeterministicCuratedQuery } from '../src/services/aiService';
import { QueryPlan } from '../src/services/queryPlan';

const ecommerce = PREBUILT_DATASETS.ecommerce.dataset;
const ecommerceSchema = profileDatasetSchema(ecommerce);

// Plans are built as literals on purpose: parseQueryPlan() normalizes an omitted
// ranking_direction to 'DESC', but curated blueprints carry the raw optional field.
const rankingPlan = (overrides: Partial<QueryPlan> = {}): QueryPlan => ({
  intent: 'ranking',
  dimensions: ['product'],
  metric: 'profit',
  aggregation: 'SUM',
  limit: 5,
  explanation: 'Top 5 products by profit',
  ...overrides,
});

describe('Optional ranking_direction defaults to the DESC the blueprints emit', () => {
  const rankQuestion = 'Rank products by total profit';

  it('accepts a DESC ORDER BY when the plan omits the direction', () => {
    const sql = 'SELECT product, ROUND(SUM(profit), 2) AS total_profit FROM orders GROUP BY product ORDER BY total_profit DESC LIMIT 5';
    const result = validateSqlIntent(sql, rankingPlan(), ecommerceSchema, rankQuestion);

    assert.strictEqual(result.valid, true, `Unexpected errors: ${result.errors.join(', ')}`);
    assert.ok(result.passedChecks?.includes('Ranking direction (DESC) verified'));
  });

  it('still rejects an ASC ORDER BY when the plan omits the direction', () => {
    const sql = 'SELECT product, ROUND(SUM(profit), 2) AS total_profit FROM orders GROUP BY product ORDER BY total_profit ASC LIMIT 5';
    const result = validateSqlIntent(sql, rankingPlan(), ecommerceSchema, rankQuestion);

    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('requires DESC order') && e.includes('first ORDER BY term is ASC')),
      `Expected a DESC-direction error, got: ${result.errors.join(', ')}`
    );
    assert.ok(!result.errors.some((e) => e.includes('undefined')), 'Direction message must not leak an undefined value');
  });

  it('preserves an explicit ASC direction', () => {
    const sql = 'SELECT product, ROUND(SUM(profit), 2) AS total_profit FROM orders GROUP BY product ORDER BY total_profit ASC LIMIT 5';
    const plan = rankingPlan({ ranking_direction: 'ASC', explanation: 'Least profitable products' });
    const result = validateSqlIntent(sql, plan, ecommerceSchema, 'Rank products by profit from lowest upward');

    assert.strictEqual(result.valid, true, `Unexpected errors: ${result.errors.join(', ')}`);
    assert.ok(result.passedChecks?.includes('Ranking direction (ASC) verified'));
  });

  it('preserves an explicit DESC direction against ASC SQL', () => {
    const sql = 'SELECT product, ROUND(SUM(profit), 2) AS total_profit FROM orders GROUP BY product ORDER BY total_profit ASC LIMIT 5';
    const plan = rankingPlan({ ranking_direction: 'DESC' });
    const result = validateSqlIntent(sql, plan, ecommerceSchema, rankQuestion);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('requires DESC order')));
  });

  it('keeps the validator and constructSqlFromPlan on the same default', () => {
    const plan = rankingPlan();
    const sql = constructSqlFromPlan(plan, 'orders');

    assert.ok(/\bORDER BY total_profit DESC\b/.test(sql), `Blueprint should default to DESC: ${sql}`);
    const result = validateSqlIntent(sql, plan, ecommerceSchema, rankQuestion);
    assert.strictEqual(result.valid, true, `Deterministic SQL rejected its own plan: ${result.errors.join(', ')}`);
  });
});

describe('Shipped E-Commerce suggestions are answerable without an API key', () => {
  const questions = PREBUILT_DATASETS.ecommerce.promptSuggestions;

  for (const [index, question] of questions.entries()) {
    it(`blueprint ${index + 1} verifies: ${question}`, () => {
      const match = getDeterministicCuratedQuery(question, ecommerce);

      assert.ok(match, `No curated blueprint matched: ${question}`);
      assert.strictEqual(match!.usedProvider, 'QueryMind Verified Blueprint Engine');
      const result = validateSqlIntent(match!.sql, match!.queryPlan!, ecommerceSchema, question);
      assert.strictEqual(result.valid, true, `Rejected by the contract: ${result.errors.join('; ')}`);
      assert.match(match!.sql.trim(), /^(SELECT|WITH)\b/i);
    });
  }

  it('returns the five requested analytical shapes', () => {
    const [topTechnology, byRegion, lossProducts, byCategory, orderAudit] = questions.map(
      (q) => getDeterministicCuratedQuery(q, ecommerce)!
    );

    assert.ok(topTechnology.sql.includes(`category = 'Technology'`), 'Top-N must stay filtered to the named category');
    assert.ok(topTechnology.sql.includes('LIMIT 5'));
    assert.ok(byRegion.sql.includes('GROUP BY region'));
    assert.ok(lossProducts.sql.includes('HAVING SUM(profit) < 0'));
    assert.ok(byCategory.sql.includes('GROUP BY category') && byCategory.sql.includes('ORDER BY total_profit DESC'));
    assert.ok(orderAudit.sql.includes('discount_pct > 0.15') && orderAudit.sql.includes('profit < 0'));
    assert.ok(!orderAudit.sql.includes('GROUP BY'), 'Record-level audit must not collapse orders into aggregates');
  });

  it('reads the discount threshold from the question instead of hard-coding it', () => {
    const percent = getDeterministicCuratedQuery(
      'Show all orders with discounts greater than 20% and negative profit',
      ecommerce
    )!;
    const worded = getDeterministicCuratedQuery('Show orders with discount above 25 percent and negative profit', ecommerce)!;
    const fractional = getDeterministicCuratedQuery('List orders where discount is above 0.15 and profit negative', ecommerce);

    assert.strictEqual(percent.queryPlan?.filters?.[0].value, 0.2);
    assert.ok(percent.sql.includes('discount_pct > 0.2'));
    assert.ok(worded.sql.includes('discount_pct > 0.25'));
    // Punctuation is stripped before matching, so "0.15" would read as 0. Guessing a filter the
    // user did not ask for is worse than routing the question to the provider path.
    assert.strictEqual(fractional, null);
  });

  it('leaves unmapped questions to the provider path', () => {
    assert.strictEqual(getDeterministicCuratedQuery('What is the average quantity per order?', ecommerce), null);
    assert.strictEqual(getDeterministicCuratedQuery('Top 5 products in the Yachts category by profit', ecommerce), null);
  });

  it('does not hijack the region or category blueprints', () => {
    const region = getDeterministicCuratedQuery('Show total sales, total profit, and average discount by region', ecommerce)!;
    assert.ok(region.sql.includes('GROUP BY region') && !region.sql.includes('GROUP BY category'));

    const furniture = getDeterministicCuratedQuery('What are the top 5 most profitable products in Furniture?', ecommerce)!;
    assert.ok(furniture.sql.includes(`category = 'Furniture'`), 'Category top-N must not fall into the performance comparison');
    assert.strictEqual(furniture.queryPlan?.ranking_direction, 'DESC');
  });

  it('keeps the SaaS blueprints reachable without a key', () => {
    const saas = PREBUILT_DATASETS.saas.dataset;
    const schema = profileDatasetSchema(saas);
    const matched = PREBUILT_DATASETS.saas.promptSuggestions
      .map((q) => ({ q, match: getDeterministicCuratedQuery(q, saas) }))
      .filter((entry) => entry.match !== null);

    assert.ok(matched.length >= 4, `Expected most SaaS suggestions to be curated, got ${matched.length}`);
    for (const { q, match } of matched) {
      const result = validateSqlIntent(match!.sql, match!.queryPlan!, schema, q);
      if (!result.valid) {
        // The only tolerated rejection is the honest undefined-metric clarification,
        // which answers the user instead of demanding an API key.
        assert.strictEqual(
          checkMetricAvailability(q, schema).isAvailable,
          false,
          `SaaS blueprint failed validation for an unrelated reason: ${result.errors.join('; ')}`
        );
      }
    }
  });
});
