import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateSqlIntent, validateExecutionResult, checkMetricAvailability, escapeForLiteralRegex, buildValueMentionRegex } from '../src/services/validators';
import { selectDeterministicVisualization, formatHeaderName } from '../src/services/visualizationSelector';
import { formatMetricValue, generateEvidenceBasedSummary, classifyAnalyticalIntent } from '../src/services/summaryEngine';
import { parseQueryPlan } from '../src/services/queryPlan';
import { inferDatasetSchema, describeUploadAdjustments } from '../src/services/sampleData';
import { profileDatasetSchema, formatSemanticSchemaPrompt } from '../src/services/schemaProfiler';
import { redactCellValuesForEgress, isQueryOutOfScope, rankedRawColumn } from '../src/services/aiService';
import { telemetryAuditor } from '../src/services/telemetryAuditor';

const RECORDS = [
  { customer_id: 'C001', customer_name: 'Aster Labs', segment: 'Enterprise', plan: 'Business', city: 'Mumbai', mrr_usd: 2000, subscription_status: 'Active', support_tickets: 2, usage_pct: 92, acquisition_channel: 'Referral' },
  { customer_id: 'C002', customer_name: 'Bloom Retail', segment: 'Enterprise', plan: 'Growth', city: 'Delhi', mrr_usd: 1800, subscription_status: 'Active', support_tickets: 1, usage_pct: 88, acquisition_channel: 'Organic' },
  { customer_id: 'C003', customer_name: 'Cobalt Systems', segment: 'Enterprise', plan: 'Business', city: 'Chennai', mrr_usd: 2200, subscription_status: 'Active', support_tickets: 3, usage_pct: 76, acquisition_channel: 'Partner' },
  { customer_id: 'C004', customer_name: 'Delta Technologies', segment: 'Mid-Market', plan: 'Starter', city: 'Hyderabad', mrr_usd: 1500, subscription_status: 'Cancelled', support_tickets: 6, usage_pct: 40, acquisition_channel: 'Outbound' },
  { customer_id: 'C005', customer_name: 'Evergreen Group', segment: 'Enterprise', plan: 'Growth', city: 'Chennai', mrr_usd: 2500, subscription_status: 'Active', support_tickets: 7, usage_pct: 98, acquisition_channel: 'Referral' },
  { customer_id: 'C006', customer_name: 'Fernworks', segment: 'SMB', plan: 'Starter', city: 'Mumbai', mrr_usd: 300, subscription_status: 'Cancelled', support_tickets: 2, usage_pct: 22, acquisition_channel: 'Paid Search' },
  { customer_id: 'C007', customer_name: 'Glyph Studio', segment: 'Startup', plan: 'Starter', city: 'Bengaluru', mrr_usd: 100, subscription_status: 'Cancelled', support_tickets: 1, usage_pct: 18, acquisition_channel: 'Outbound' },
  { customer_id: 'C008', customer_name: 'Helix Data', segment: 'SMB', plan: 'Business', city: 'Delhi', mrr_usd: 1200, subscription_status: 'Active', support_tickets: 0, usage_pct: 61, acquisition_channel: 'Partner' },
];

const dataset = inferDatasetSchema(RECORDS, 'saas_accounts', 'SaaS Accounts');
const schema = profileDatasetSchema(dataset);

describe('Final release verification — validation false positives', () => {
  it('accepts a multi-dimension grouped breakdown instead of rejecting its grouping keys', () => {
    const plan = parseQueryPlan({
      intent: 'aggregate_by_dimension',
      dimensions: ['segment', 'acquisition_channel'],
      metric: 'mrr_usd',
      aggregation: 'SUM',
    });
    const sql = 'SELECT segment, acquisition_channel, SUM(mrr_usd) AS total_mrr FROM saas_accounts GROUP BY segment, acquisition_channel ORDER BY total_mrr DESC';
    const rows = [
      { segment: 'Enterprise', acquisition_channel: 'Referral', total_mrr: 4200 },
      { segment: 'Enterprise', acquisition_channel: 'Partner', total_mrr: 2100 },
      { segment: 'SMB', acquisition_channel: 'Referral', total_mrr: 900 },
    ];

    const intent = validateSqlIntent(sql, plan, schema, 'Compare customer segments and acquisition channels by MRR.');
    assert.deepEqual(intent.errors, [], `unexpected intent errors: ${intent.errors.join(' | ')}`);

    const result = validateExecutionResult(rows, Object.keys(rows[0]), plan, schema);
    assert.deepEqual(result.errors, []);
  });

  it('still rejects genuinely repeated grouping combinations', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment', 'city'], metric: 'mrr_usd', aggregation: 'SUM' });
    const rows = [
      { segment: 'Enterprise', city: 'Chennai', total_mrr: 100 },
      { segment: 'Enterprise', city: 'Chennai', total_mrr: 200 },
    ];
    const result = validateExecutionResult(rows, Object.keys(rows[0]), plan, schema);
    assert.ok(result.errors.some((e) => e.includes('Aggregation uniqueness violated')));
  });

  it('treats grouped category labels as output, not as requested filters', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['subscription_status'], metric: 'mrr_usd', aggregation: 'COUNT' });
    const sql = 'SELECT subscription_status, COUNT(*) AS customer_count FROM saas_accounts GROUP BY subscription_status';
    const val = validateSqlIntent(sql, plan, schema, 'How many customers have Active status vs Cancelled status?');
    assert.deepEqual(val.errors, [], `unexpected intent errors: ${val.errors.join(' | ')}`);
  });

  it('does not filter on a plan tier merely because the word "business" appears in prose', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['acquisition_channel'], metric: 'mrr_usd', aggregation: 'SUM' });
    const sql = 'SELECT acquisition_channel, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr FROM saas_accounts GROUP BY acquisition_channel';
    for (const question of [
      'Identify the biggest business risks visible in this dataset.',
      'Recommend five data-driven business actions based only on the available dataset.',
    ]) {
      const val = validateSqlIntent(sql, plan, schema, question);
      assert.deepEqual(val.errors, [], `unexpected errors for "${question}": ${val.errors.join(' | ')}`);
    }
  });

  it('reads the first ordering term as the analytical direction and ignores tie-breakers', () => {
    const plan = parseQueryPlan({ intent: 'filter_lookup', dimensions: ['customer_id'], metric: 'mrr_usd', ranking_direction: 'DESC' });
    const sql = "SELECT customer_id, mrr_usd FROM saas_accounts WHERE segment = 'Enterprise' ORDER BY mrr_usd DESC, customer_id ASC";
    const val = validateSqlIntent(sql, plan, schema, 'List all Enterprise customers, sorted by MRR from highest to lowest.');
    assert.deepEqual(val.errors, [], `unexpected errors: ${val.errors.join(' | ')}`);

    const ascVal = validateSqlIntent('SELECT customer_id FROM saas_accounts ORDER BY mrr_usd ASC LIMIT 5', parseQueryPlan({ intent: 'ranking', dimensions: ['customer_id'], metric: 'mrr_usd', ranking_direction: 'DESC', limit: 5 }), schema, 'Top 5 customers by MRR');
    assert.ok(ascVal.errors.some((e) => e.includes('DESC order')), `expected a direction mismatch, got: ${ascVal.errors.join(' | ')}`);
  });
});

describe('Final release verification — undefined metrics and schema-honest guidance', () => {
  it('blocks LTV, CAC and ROI when no column defines them', () => {
    const check = checkMetricAvailability('Calculate customer lifetime value (LTV), customer acquisition cost (CAC) and return on investment (ROI).', schema);
    assert.equal(check.isAvailable, false);
    assert.ok(check.missingMetric?.includes('LTV'));
    assert.ok(check.missingMetric?.includes('CAC'));
    assert.ok(check.missingMetric?.includes('ROI'));
  });

  it('allows those metrics once the dataset actually measures them', () => {
    const withCosts = profileDatasetSchema(
      inferDatasetSchema(
        RECORDS.map((r) => ({ ...r, customer_lifetime_value: 40000, acquisition_cost: 900 })),
        'saas_accounts',
        'SaaS Accounts'
      )
    );
    const check = checkMetricAvailability('Compare lifetime value with acquisition cost per channel.', withCosts);
    assert.equal(check.isAvailable, true);
  });

  it('never cites a column that is absent from the schema in its guidance', () => {
    for (const question of [
      'Predict which customers are most likely to churn and rank them by churn probability.',
      'Calculate customer lifetime value (LTV) and return on investment (ROI).',
      'Show the top customers by lost MRR.',
    ]) {
      const check = checkMetricAvailability(question, schema);
      assert.equal(check.isAvailable, false, `expected a block for "${question}"`);
      const guidance = `${check.clarification} ${check.caveat}`;
      assert.ok(!guidance.includes('churn_status'), `"churn_status" is not a column of this dataset: ${guidance}`);
      assert.ok(!/"nps_score"|"lost_mrr"/.test(guidance), guidance);
      for (const cited of guidance.match(/"([a-z_0-9]+)"/g) || []) {
        const name = cited.replace(/"/g, '');
        assert.ok(schema.columns.some((c) => c.name === name), `guidance cites unknown column ${cited}`);
      }
    }
  });
});

describe('Final release verification — evidence-faithful narratives', () => {
  it('formats a ratio column as a percentage even when its label mentions MRR', () => {
    assert.equal(formatMetricValue(86.85, 'pct_of_total_mrr'), '86.85%');
    assert.equal(formatMetricValue(14000, 'total_mrr'), '$14,000');
  });

  it('classifies a computed share as a share, never as a record count', () => {
    const rows = [{ pct_of_total_mrr: 86.85 }];
    const summary = generateEvidenceBasedSummary(
      ctx('What share of total MRR comes from Enterprise and Mid-Market customers?', 'SELECT ROUND(100.0 * SUM(CASE WHEN segment IN (\'Enterprise\',\'Mid-Market\') THEN mrr_usd ELSE 0 END) / SUM(mrr_usd), 2) AS pct_of_total_mrr FROM saas_accounts', rows)
    );
    assert.ok(!/distinct (customers|records)/i.test(summary.summary || ''), summary.summary);
    assert.ok((summary.summary || '').includes('86.85%'), summary.summary);
  });

  it('reports every measure of a single-row KPI board', () => {
    const rows = [{ customer_count: 30, total_mrr: 23200, avg_mrr: 773.33, active_customers: 25, cancelled_customers: 5 }];
    const summary = generateEvidenceBasedSummary(
      ctx(
        'Generate an executive summary of the dataset, covering customer count, total MRR, subscription status and major revenue contributors.',
        'SELECT COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr, AVG(mrr_usd) AS avg_mrr, SUM(CASE WHEN subscription_status = \'Active\' THEN 1 ELSE 0 END) AS active_customers FROM saas_accounts',
        rows
      )
    );
    const text = JSON.stringify(summary);
    assert.ok(text.includes('$23,200'), text.slice(0, 400));
    assert.ok(text.includes('$773.33'), text.slice(0, 400));
    assert.ok(text.includes('83.3%'), text.slice(0, 400));
  });

  it('uses the record count, not the first column, for a pure ratio result', () => {
    const rows = [{ usage_pct: 83.33 }];
    const summary = generateEvidenceBasedSummary(
      ctx(
        'How many customers are active?',
        'SELECT ROUND(100.0 * SUM(CASE WHEN subscription_status = \'Active\' THEN 1 ELSE 0 END) / COUNT(*), 2) AS usage_pct FROM saas_accounts',
        rows,
        undefined,
        8
      )
    );
    assert.ok((summary.summary || '').includes('8'), summary.summary);
    assert.ok(!(summary.summary || '').includes('83.33 distinct'), summary.summary);
  });

  it('keeps support-ticket claims to results that actually contain tickets', () => {
    const rows = [
      { customer_id: 'C026', customer_name: 'Zenith Labs', usage_pct: 115, plan: 'Enterprise', segment: 'Enterprise' },
      { customer_id: 'C024', customer_name: 'Xenon Technologies', usage_pct: 110, plan: 'Growth', segment: 'Startup' },
    ];
    const summary = generateEvidenceBasedSummary(
      ctx(
        'Identify customers with usage percentages above 100% and explain what this indicates based on the available data.',
        'SELECT customer_id, customer_name, usage_pct, plan, segment FROM saas_accounts WHERE usage_pct > 100',
        rows
      )
    );
    const text = JSON.stringify(summary);
    assert.ok(!/support volume|support tickets|high-MRR customers/i.test(text), text.slice(0, 600));
  });
});

describe('Final release verification — runtime defects found in the 30-question benchmark', () => {
  it('writes the lost-MRR clarification without a duplicated conjunction or an invented column', () => {
    const res = checkMetricAvailability('Show me top 5 Enterprise customers by lost MRR with high support tickets', schema);
    assert.equal(res.isAvailable, false);
    const text = `${res.clarification} ${res.caveat}`;
    assert.ok(!/\band and\b|\bthe the\b|\bis is\b/i.test(text), text);
    assert.ok(text.includes('mrr_usd'), text);
    assert.ok(text.includes('subscription_status'), text);
    assert.ok(!text.includes('churn_status'), `must not cite a column this dataset lacks: ${text}`);
  });

  it('lists three missing derived metrics as a readable English series', () => {
    const res = checkMetricAvailability(
      'Calculate customer lifetime value (LTV), customer acquisition cost (CAC) and return on investment (ROI).',
      schema
    );
    assert.equal(res.isAvailable, false);
    assert.ok(
      res.clarification?.includes('customer lifetime value (LTV), customer acquisition cost (CAC) and return on investment (ROI)'),
      res.clarification
    );
  });

  it('labels every grouped row by all grouping dimensions, not the first one', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment', 'plan'], metric: 'mrr_usd', aggregation: 'SUM' });
    const rows = [
      { segment: 'Enterprise', plan: 'Enterprise', total_mrr: 14000 },
      { segment: 'Mid-Market', plan: 'Business', total_mrr: 3600 },
      { segment: 'Mid-Market', plan: 'Growth', total_mrr: 2550 },
      { segment: 'SMB', plan: 'Growth', total_mrr: 1200 },
    ];
    const summary = generateEvidenceBasedSummary(
      ctx('Show total MRR by segment and plan tier.', 'SELECT segment, plan, SUM(mrr_usd) AS total_mrr FROM saas_accounts GROUP BY segment, plan ORDER BY total_mrr DESC', rows, plan)
    );
    const text = JSON.stringify(summary);
    assert.ok(text.includes('Mid-Market / Business'), text.slice(0, 500));
    assert.ok(text.includes('Mid-Market / Growth'), text.slice(0, 500));
    assert.ok(!/total TOTAL/i.test(text), `duplicated label: ${text.slice(0, 500)}`);
    assert.ok(text.includes('across all 4 returned groups'), text.slice(0, 500));
  });

  it('never states a share of the result as a share of the dataset', () => {
    const plan = parseQueryPlan({ intent: 'filter_lookup', dimensions: ['customer_id', 'customer_name', 'mrr_usd'], metric: 'mrr_usd' });
    const rows = [
      { customer_id: 'C005', customer_name: 'Evergreen Group', mrr_usd: 2500 },
      { customer_id: 'C003', customer_name: 'Cedar Works', mrr_usd: 2200 },
      { customer_id: 'C026', customer_name: 'Zenith Labs', mrr_usd: 2100 },
      { customer_id: 'C001', customer_name: 'Aster Labs', mrr_usd: 2000 },
      { customer_id: 'C030', customer_name: 'Dynamo Group', mrr_usd: 1900 },
      { customer_id: 'C002', customer_name: 'BluePeak Systems', mrr_usd: 1800 },
      { customer_id: 'C004', customer_name: 'Delta Technologies', mrr_usd: 1500 },
    ];
    const summary = generateEvidenceBasedSummary(
      ctx('List all Enterprise customers, sorted by MRR from highest to lowest.', 'SELECT customer_id, customer_name, mrr_usd FROM saas_accounts WHERE segment = \'Enterprise\' ORDER BY mrr_usd DESC', rows, plan)
    );
    const text = JSON.stringify(summary);
    assert.ok(/of the MRR USD across all 7 returned groups/.test(text), text.slice(0, 600));
    assert.ok(!/higher average in/i.test(text), `average asserted without an average: ${text.slice(0, 600)}`);
    assert.ok((summary.limitations || []).join(' ').includes('rather than of the whole dataset'), text.slice(0, 800));
  });

  it('describes a highest/lowest pair as two extremes instead of calling the minimum rank two', () => {
    const plan = parseQueryPlan({ intent: 'ranking', dimensions: ['customer_id', 'customer_name', 'mrr_usd'], metric: 'mrr_usd', ranking_direction: 'DESC' });
    const rows = [
      { customer_id: 'C005', customer_name: 'Evergreen Group', mrr_usd: 2500, measure: 'highest_mrr' },
      { customer_id: 'C019', customer_name: 'Summit Technologies', mrr_usd: 100, measure: 'lowest_mrr' },
    ];
    const sql = 'SELECT customer_id, customer_name, mrr_usd, \'highest_mrr\' AS measure FROM saas_accounts ORDER BY mrr_usd DESC, customer_id ASC LIMIT 1 UNION ALL SELECT customer_id, customer_name, mrr_usd, \'lowest_mrr\' FROM saas_accounts ORDER BY mrr_usd ASC, customer_id ASC LIMIT 1';
    const summary = generateEvidenceBasedSummary(ctx('Which customer has the highest MRR, and which customer has the lowest MRR?', sql, rows, plan));
    const text = JSON.stringify(summary);
    assert.ok(!/ranks second/i.test(text), text.slice(0, 600));
    assert.ok(/highest mrr/i.test(text) && /lowest mrr/i.test(text), text.slice(0, 600));
    assert.ok(/tied/i.test(text), `the single-row-per-extreme tie risk must be disclosed: ${text.slice(0, 600)}`);
  });

  it('narrates a non-numeric ORDER BY as an ordering rather than an invented metric ranking', () => {
    const plan = parseQueryPlan({ intent: 'ranking', dimensions: ['customer_id', 'signup_date', 'mrr_usd'], metric: 'mrr_usd', ranking_direction: 'DESC', limit: 3 });
    const rows = [
      { customer_id: 'C030', signup_date: '2025-09-14', mrr_usd: 1900 },
      { customer_id: 'C029', signup_date: '2025-09-03', mrr_usd: 100 },
      { customer_id: 'C028', signup_date: '2025-08-20', mrr_usd: 300 },
    ];
    const summary = generateEvidenceBasedSummary(
      ctx('List the top 3 customers ordered by signup date.', 'SELECT customer_id, signup_date, mrr_usd FROM saas_accounts ORDER BY signup_date DESC LIMIT 3', rows, plan)
    );
    const text = JSON.stringify(summary);
    assert.ok((summary.overview || '').includes('signup date'), text.slice(0, 600));
    assert.ok(!/ranked by mrr/i.test(text), text.slice(0, 600));
    assert.ok((summary.findings || []).some((f) => f.includes('2025-09-14')), text.slice(0, 600));
  });

  it('names every executed filter and drops an irrelevant usage limitation', () => {
    const plan = parseQueryPlan({
      intent: 'filter_lookup',
      dimensions: ['customer_id', 'customer_name', 'support_tickets', 'usage_pct'],
      metric: 'support_tickets',
      filters: [{ column: 'support_tickets', operator: '>', value: 5 }, { column: 'usage_pct', operator: '<', value: 50 }],
    });
    const rows = [{ customer_id: 'C004', customer_name: 'Delta Technologies', support_tickets: 6, usage_pct: 40 }];
    const summary = generateEvidenceBasedSummary(
      ctx('Identify customers who have more than 5 support tickets and usage below 50%.', 'SELECT customer_id, customer_name, support_tickets, usage_pct FROM saas_accounts WHERE support_tickets > 5 AND usage_pct < 50', rows, plan)
    );
    const overview = summary.overview || '';
    assert.ok(overview.includes('support_tickets > 5') && overview.includes('usage_pct < 50'), overview);
    const limits = (summary.limitations || []).join(' ');
    assert.ok(!/above 100%/.test(limits), limits);
    assert.ok((summary.findings || []).some((f) => f.includes('Delta Technologies')), JSON.stringify(summary.findings));
  });

  it('only claims volume and revenue diverge when the two orderings really differ', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment'], metric: 'mrr_usd', aggregation: 'SUM' });
    const agreed = [
      { segment: 'Alpha', customer_count: 10, total_mrr: 1000 },
      { segment: 'Beta', customer_count: 5, total_mrr: 500 },
    ];
    const agreedText = JSON.stringify(
      generateEvidenceBasedSummary(ctx('Total MRR and customer count by segment.', 'SELECT segment, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr FROM saas_accounts GROUP BY segment', agreed, plan))
    );
    assert.ok(!/Customer volume does not directly scale with revenue/.test(agreedText), agreedText.slice(0, 600));

    const diverging = [
      { segment: 'Alpha', customer_count: 7, total_mrr: 14000 },
      { segment: 'Beta', customer_count: 9, total_mrr: 1950 },
    ];
    const divSummary = generateEvidenceBasedSummary(
      ctx('Total MRR and customer count by segment.', 'SELECT segment, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr FROM saas_accounts GROUP BY segment', diverging, plan)
    );
    const claim = (divSummary.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication)).join(' ');
    assert.ok(claim.includes('Customer volume does not directly scale with revenue'), claim);
    assert.ok(claim.includes('9 vs 7') && claim.includes('$14,000'), `the claim must cite the counted evidence: ${claim}`);
  });

  it('refuses to chart a candidate measure that the executed result does not contain', () => {
    const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment'], metric: 'mrr_usd', aggregation: 'SUM' });
    const rows = [{ segment: 'Enterprise', total_mrr: 4200 }, { segment: 'SMB', total_mrr: 900 }];
    const candidate: any = {
      type: 'bar',
      xAxisKey: 'segment',
      yAxisKey: 'support_tickets',
      title: 'Support Tickets by Segment',
      categoryLabel: 'Segment',
      metricLabel: 'Support Tickets',
      isAggregated: true,
    };
    const suggestion = selectDeterministicVisualization('Total MRR by segment.', plan, rows, Object.keys(rows[0]), schema, candidate);
    assert.ok(!suggestion || Object.keys(rows[0]).includes(suggestion.yAxisKey), JSON.stringify(suggestion));
  });

  it('does not present a date-ordered listing as a top-N measure chart', () => {
    const plan = parseQueryPlan({ intent: 'ranking', dimensions: ['customer_id', 'signup_date', 'mrr_usd'], metric: 'mrr_usd', ranking_direction: 'DESC', limit: 3 });
    const rows = [
      { customer_id: 'C030', signup_date: '2025-09-14', mrr_usd: 1900 },
      { customer_id: 'C029', signup_date: '2025-09-03', mrr_usd: 100 },
      { customer_id: 'C028', signup_date: '2025-08-20', mrr_usd: 300 },
    ];
    assert.equal(selectDeterministicVisualization('List the top 3 customers ordered by signup date.', plan, rows, Object.keys(rows[0]), schema), undefined);

    const rankedRows = [
      { customer_id: 'C005', customer_name: 'Evergreen Group', mrr_usd: 2500 },
      { customer_id: 'C003', customer_name: 'Cedar Works', mrr_usd: 2200 },
      { customer_id: 'C026', customer_name: 'Zenith Labs', mrr_usd: 2100 },
    ];
    const ranked = selectDeterministicVisualization('List the top 3 customers by MRR.', plan, rankedRows, Object.keys(rankedRows[0]), schema);
    assert.ok(ranked && /Top 3/i.test(ranked.title), JSON.stringify(ranked));
  });
});

function ctx(question: string, sql: string, rows: Record<string, any>[], plan?: any, rowCount?: number) {
  return {
    question,
    sql,
    status: 'verified' as const,
    rows,
    columns: Object.keys(rows[0] || {}),
    rowCount: rowCount ?? rows.length,
    datasetName: dataset.name,
    tableName: dataset.tableName,
    queryPlan: plan,
    semanticSchema: schema,
  };
}

describe('Final release verification — grouped narrative labels and ties', () => {
  const twoDimPlan = parseQueryPlan({
    intent: 'aggregate_by_dimension',
    dimensions: ['segment', 'acquisition_channel'],
    metric: 'mrr_usd',
    aggregation: 'SUM',
  });

  it('never credits a two-column group total to one of its columns', () => {
    const rows = [
      { segment: 'Enterprise', acquisition_channel: 'Referral', total_mrr: 4500, customer_count: 2 },
      { segment: 'Enterprise', acquisition_channel: 'Partner', total_mrr: 4300, customer_count: 2 },
      { segment: 'SMB', acquisition_channel: 'Paid Search', total_mrr: 600, customer_count: 3 },
      { segment: 'Startup', acquisition_channel: 'Outbound', total_mrr: 300, customer_count: 1 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Compare customer segments and acquisition channels to identify which combinations contribute the most MRR.',
        'SELECT segment, acquisition_channel, SUM(mrr_usd) AS total_mrr, COUNT(*) AS customer_count FROM saas_accounts GROUP BY segment, acquisition_channel ORDER BY total_mrr DESC',
        rows, twoDimPlan)
    );
    const text = [s.overview, ...(s.findings || []), ...(s.performance_comparison || []), ...(s.business_implications || []), ...(s.recommended_actions || []).map((a) => a.action)].join(' ');

    assert.ok(text.includes('Enterprise / Referral'), `combination not labelled by both grouping columns: ${text}`);
    assert.ok(!/\bEnterprise (leads|is the strongest|generates|represents)/.test(text), `a combination total was attributed to the segment alone: ${text}`);
  });

  it('calls a shared maximum a tie instead of a lead', () => {
    const cityPlan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['city'], metric: 'mrr_usd', aggregation: 'SUM' });
    const rows = [
      { city: 'Chennai', customer_count: 6, total_mrr: 5700, avg_mrr: 950 },
      { city: 'Hyderabad', customer_count: 6, total_mrr: 5550, avg_mrr: 925 },
      { city: 'Mumbai', customer_count: 6, total_mrr: 4400, avg_mrr: 733.33 },
      { city: 'Bengaluru', customer_count: 6, total_mrr: 4350, avg_mrr: 725 },
      { city: 'Delhi', customer_count: 6, total_mrr: 3200, avg_mrr: 533.33 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Analyze customer distribution and total MRR across cities.',
        'SELECT city, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr, AVG(mrr_usd) AS avg_mrr FROM saas_accounts GROUP BY city ORDER BY total_mrr DESC',
        rows, cityPlan)
    );
    const findings = (s.findings || []).join(' ');

    assert.ok(!/leads in customer count/.test(findings), `a tie across all groups was narrated as a lead: ${findings}`);
    assert.ok(/does not separate them/.test(findings), `the shared count of 6 was not disclosed as non-differentiating: ${findings}`);
    assert.ok(/Chennai leads in total MRR/.test(findings), `the genuine revenue leader disappeared: ${findings}`);
  });

  it('derives average ratios from the returned rows rather than from named tiers', () => {
    const rows = [
      { segment: 'Enterprise', customer_count: 7, total_mrr: 14000, avg_mrr: 2000 },
      { segment: 'Mid-Market', customer_count: 4, total_mrr: 5950, avg_mrr: 1487.5 },
      { segment: 'SMB', customer_count: 9, total_mrr: 1950, avg_mrr: 216.67 },
      { segment: 'Startup', customer_count: 8, total_mrr: 1100, avg_mrr: 137.5 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Calculate the total MRR, average MRR and customer count for each customer segment.',
        'SELECT segment, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr, AVG(mrr_usd) AS avg_mrr FROM saas_accounts GROUP BY segment ORDER BY total_mrr DESC',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment'], metric: 'mrr_usd', aggregation: 'SUM' }))
    );
    const ratio = (s.findings || []).find((f) => f.includes('times that of'));

    assert.ok(ratio, `no average-spread finding was produced: ${(s.findings || []).join(' | ')}`);
    assert.ok(ratio.includes('Startup') && ratio.includes('14.5'), `ratio not anchored to the actual lowest row: ${ratio}`);
    assert.ok(!/SMB/.test(ratio), `the spread quoted a tier chosen by name rather than by value: ${ratio}`);
  });

  it('writes a three-way tie as an English series, not "a and b and c"', () => {
    const rows = [
      { acquisition_channel: 'Referral', customer_count: 7, cancelled_customers: 0, cancelled_mrr: 0, total_mrr: 7300 },
      { acquisition_channel: 'Organic', customer_count: 7, cancelled_customers: 1, cancelled_mrr: 1100, total_mrr: 4400 },
      { acquisition_channel: 'Paid Search', customer_count: 7, cancelled_customers: 0, cancelled_mrr: 0, total_mrr: 3600 },
      { acquisition_channel: 'Partner', customer_count: 5, cancelled_customers: 1, cancelled_mrr: 250, total_mrr: 6050 },
      { acquisition_channel: 'Outbound', customer_count: 4, cancelled_customers: 3, cancelled_mrr: 1750, total_mrr: 1850 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Identify the biggest business risks visible in this dataset. Support each risk with actual data.',
        'SELECT acquisition_channel, COUNT(*) AS customer_count, SUM(CASE WHEN subscription_status = \'Cancelled\' THEN 1 ELSE 0 END) AS cancelled_customers, SUM(CASE WHEN subscription_status = \'Cancelled\' THEN mrr_usd ELSE 0 END) AS cancelled_mrr, SUM(mrr_usd) AS total_mrr FROM querymind_sample_saas GROUP BY acquisition_channel ORDER BY cancelled_mrr DESC',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['acquisition_channel'], metric: 'mrr_usd', aggregation: 'SUM' }))
    );
    const text = [...(s.findings || []), ...(s.performance_comparison || [])].join(' ');

    assert.ok(/Referral, Organic and Paid Search are tied for the highest customer count at 7/.test(text), `three-way tie not written as a series: ${text}`);
    assert.ok(!text.includes(' and Referral and '), `serial "and" repeated: ${text}`);
    assert.ok(!/holds the largest customer volume/.test(text), `a shared maximum was described as a sole volume leader: ${text}`);
    assert.ok(!/leads in customer count/.test(text), `a tie across three groups was narrated as a lead: ${text}`);
  });

  it('only claims a volume/revenue inversion when the counts really differ', () => {
    const rows = [
      { acquisition_channel: 'Referral', customer_count: 7, total_mrr: 7300 },
      { acquisition_channel: 'Organic', customer_count: 7, total_mrr: 4400 },
      { acquisition_channel: 'Paid Search', customer_count: 7, total_mrr: 3600 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Identify the biggest business risks visible in this dataset.',
        'SELECT acquisition_channel, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr FROM querymind_sample_saas GROUP BY acquisition_channel',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['acquisition_channel'], metric: 'mrr_usd', aggregation: 'SUM' }))
    );
    const implications = (s.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication)).join(' ');

    assert.ok(!/ranks ahead of .* by customer count \((\d+) vs \1\)/.test(implications), `a tie was narrated as a rank inversion: ${implications}`);
    assert.ok(!implications.includes('Customer volume does not directly scale with revenue'), `inversion claimed with identical counts: ${implications}`);
  });

  it('only states a rank inversion when both the count and revenue directions hold', () => {
    const rows = [
      { acquisition_channel: 'Referral', customer_count: 7, total_mrr: 7300 },
      { acquisition_channel: 'Partner', customer_count: 5, total_mrr: 6050 },
      { acquisition_channel: 'Organic', customer_count: 7, total_mrr: 4400 },
      { acquisition_channel: 'Paid Search', customer_count: 7, total_mrr: 3600 },
      { acquisition_channel: 'Outbound', customer_count: 4, total_mrr: 1850 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Which acquisition channel delivers the most revenue per customer?',
        'SELECT acquisition_channel, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr FROM querymind_sample_saas GROUP BY acquisition_channel ORDER BY total_mrr DESC',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['acquisition_channel'], metric: 'mrr_usd', aggregation: 'SUM' }))
    );
    const implications = (s.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication)).join(' ');
    const byName = new Map(rows.map((r) => [r.acquisition_channel, r]));

    const claims = [...implications.matchAll(/ranks ahead of (.+?) by customer count \((\d+) vs (\d+)\) yet records less total MRR \(\$([\d,]+) vs \$([\d,]+)\)/g)];
    assert.ok(!/total mrr/.test(implications), `lower-case acronym would make the inversion check vacuous: ${implications}`);
    for (const claim of claims) {
      const [, bulkier, bulkierCount, richerCount, bulkierRev, richerRev] = claim;
      const num = (v: string) => Number(v.replace(/,/g, ''));
      assert.ok(byName.has(bulkier.trim()), `inversion named an unknown group: ${implications}`);
      assert.ok(num(bulkierCount) > num(richerCount), `inversion stated equal/backsided counts: ${implications}`);
      assert.ok(num(bulkierRev) < num(richerRev), `inversion claimed less revenue while quoting more: ${implications}`);
    }
    assert.ok(!implications.includes('Referral ranks ahead of Partner'), `a strictly larger revenue was narrated as smaller: ${implications}`);
  });

  it('names a usage percentage as usage, never as an activation rate', () => {
    const rows = [
      { segment: 'Enterprise', subscription_status: 'Active', customer_count: 6, total_mrr: 12500, avg_support_tickets: 2.5, avg_usage_pct: 88.1 },
      { segment: 'Enterprise', subscription_status: 'Cancelled', customer_count: 1, total_mrr: 1500, avg_support_tickets: 6, avg_usage_pct: 40 },
      { segment: 'Mid-Market', subscription_status: 'Active', customer_count: 5, total_mrr: 5050, avg_support_tickets: 2.2, avg_usage_pct: 71.4 },
      { segment: 'SMB', subscription_status: 'Active', customer_count: 8, total_mrr: 1800, avg_support_tickets: 1.6, avg_usage_pct: 44.8 },
      { segment: 'SMB', subscription_status: 'Cancelled', customer_count: 1, total_mrr: 150, avg_support_tickets: 4, avg_usage_pct: 20 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Recommend five data-driven business actions based only on the available dataset. Explain the evidence behind each recommendation.',
        'SELECT segment, subscription_status, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr, AVG(support_tickets) AS avg_support_tickets, AVG(usage_pct) AS avg_usage_pct FROM querymind_sample_saas GROUP BY segment, subscription_status ORDER BY total_mrr DESC',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment', 'subscription_status'], metric: 'mrr_usd', aggregation: 'SUM' }))
    );
    const text = [
      s.overview || '',
      ...(s.findings || []),
      ...(s.performance_comparison || []),
      ...(s.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication)),
      ...(s.recommended_actions || []).map((a) => `${a.action} ${a.reason}`),
    ].join(' ');

    assert.ok(!/activation|active customer|customers active|are active/i.test(text), `usage_pct was narrated as activation: ${text}`);
    assert.ok(text.includes('avg usage pct'), `the usage column was not named by its own header: ${text}`);
  });
});

describe('Final release verification — results that contain no revenue measure', () => {
  it('draws no revenue conclusion and leaves no empty value holes', () => {
    const rows = [
      { segment: 'Enterprise', customer_count: 2 },
      { segment: 'SMB', customer_count: 3 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('What is the total mrr by acquisition channel?',
        'SELECT segment, COUNT(*) AS customer_count FROM no_channel GROUP BY segment',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment'], metric: 'mrr_usd', aggregation: 'SUM' }))
    );
    const text = [
      s.overview || '',
      ...(s.findings || []),
      ...(s.performance_comparison || []),
      ...(s.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication)),
      ...(s.recommended_actions || []).map((a) => `${a.action} ${a.reason}`),
    ].join(' ');

    assert.ok(/no revenue measure/.test(text), `the missing revenue measure was not disclosed: ${text}`);
    assert.ok(!/(highest|most|leads|strongest|generates|contributes|increase|average|per customer)[^.;]*revenue/i.test(text), `a revenue conclusion was drawn with no revenue column: ${text}`);
    assert.ok(!/\bupselling\b|account expansion/i.test(text), `a revenue-driven action was recommended without revenue data: ${text}`);
    assert.ok(!/\(\s*\)/.test(text), `an empty value hole was rendered: ${text}`);
    assert.ok(!/\bundefined\b|NaN/.test(text), `unfilled placeholder reached the narrative: ${text}`);
    assert.ok(!/highest average customer count/i.test(text), `a count was described as an average: ${text}`);
    assert.ok(/customer count/.test(text), `the measure that exists was not named: ${text}`);
  });

  it('does not describe a shared maximum in the overview as one group leading', () => {
    const rows = [
      { segment: 'Enterprise', customer_count: 2 },
      { segment: 'SMB', customer_count: 2 },
      { segment: 'Startup', customer_count: 1 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('What is the customer count for each segment?',
        'SELECT segment, COUNT(*) AS customer_count FROM saas_accounts GROUP BY segment',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment'], metric: 'support_tickets', aggregation: 'COUNT' }))
    );
    const text = `${s.overview || ''} ${(s.findings || []).join(' ')}`;
    const implications = (s.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication)).join(' ');

    assert.ok(/Enterprise and SMB (are|are all) tied for the highest customer count at 2/.test(text), `tie not narrated as a tie: ${text}`);
    assert.ok(!/Enterprise has the highest customer count/.test(text), `a tied maximum was attributed to one group: ${text}`);
    assert.ok(/tied for the highest customer count \(2\)/.test(implications), `the implication named a single leader for a tie: ${implications}`);
    assert.ok(!/records the highest customer count \(2\)/.test(implications), `implication credited one group with a tied maximum: ${implications}`);
  });

  it('refuses to substitute a proxy measure when the dataset has no recurring revenue column', () => {
    const noRevenueRecords = [
      { customer_id: 'C1', segment: 'Enterprise', usage_pct: 80 },
      { customer_id: 'C2', segment: 'SMB', usage_pct: 40 },
      { customer_id: 'C3', segment: 'SMB', usage_pct: 55 },
    ];
    const noRevenueSchema = profileDatasetSchema(inferDatasetSchema(noRevenueRecords, 'no_mrr', 'No MRR'));
    const check = checkMetricAvailability('What is the total mrr_usd by segment?', noRevenueSchema);

    assert.equal(check.isAvailable, false, 'an MRR question on a dataset with no revenue column was treated as answerable');
    assert.match(String(check.clarification), /no recurring-revenue column/i);
    assert.match(String(check.clarification), /will be substituted/i);
    assert.match(String(check.clarification), /"usage_pct"/, 'the clarification must cite the columns that really exist');
    assert.ok(!String(check.clarification).includes('"mrr'), 'the clarification cited a phantom revenue column');

    const withRevenue = checkMetricAvailability('What is the total mrr_usd by segment?', schema);
    assert.equal(withRevenue.isAvailable, true, 'the guard must not fire when mrr_usd exists');
  });

  it('derives grouped limitations from the returned columns instead of assuming a churn dataset', () => {
    const rows = [
      { category: 'A', total_val: 60, record_count: 3 },
      { category: 'B', total_val: 30, record_count: 2 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('What is the total val by category?',
        'SELECT category, SUM(val) AS total_val, COUNT(*) AS record_count FROM nulls GROUP BY category',
        rows, parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['category'], metric: 'val', aggregation: 'SUM' }))
    );
    const limitations = (s.limitations || []).join(' ');
    const implications = (s.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication)).join(' ');

    assert.ok(!/loaded customer dataset/i.test(limitations), `the caveat invented a customer domain: ${limitations}`);
    assert.ok(!/acquisition costs|campaign expenditure/i.test(limitations), `marketing caveat applied to a non-channel grouping: ${limitations}`);
    assert.ok(!/no revenue measure/.test(implications), `a revenue disclaimer was added to a question that never asked for revenue: ${implications}`);
  });

  it('clarifies a measure stored as text instead of substituting another column', () => {
    const textMeasureRecords = [
      { id: 'R1', plan: 'A', mrr: '1,234' },
      { id: 'R2', plan: 'B', mrr: '200' },
      { id: 'R3', plan: 'A', mrr: '3,400' },
    ];
    const textSchema = profileDatasetSchema(inferDatasetSchema(textMeasureRecords, 'numstrings', 'Num Strings'));
    const check = checkMetricAvailability('What is the total mrr by plan?', textSchema);

    assert.equal(check.isAvailable, false, 'a text measure was treated as summable');
    assert.equal(check.missingMetric, 'mrr');
    assert.match(String(check.clarification), /stored as text/i);
    assert.match(String(check.clarification), /No other column will be substituted/i);

    const numericTarget = checkMetricAvailability('What is the total mrr by plan?', profileDatasetSchema(inferDatasetSchema([{ plan: 'A', mrr: 1234 }, { plan: 'B', mrr: 200 }], 'ok_numbers', 'Ok Numbers')));
    assert.equal(numericTarget.isAvailable, true, 'a numeric measure named after "total" must still run');

    const dimensionWord = checkMetricAvailability('What is the total customers by plan?', schema);
    assert.equal(dimensionWord.isAvailable, true, 'a non-column word after "total" must not trigger the text-measure guard');
  });
});

describe('Final release verification — partial-success uploads disclose what was lost', () => {
  it('states the structural issues a malformed file caused instead of reporting a clean load', () => {
    const rows = [{ a: 1, b: null }];
    const issues = [
      { code: 'UnexpectedQuotes', message: 'Quotes around "unclosed" span multiple lines', row: 1 },
      { code: 'TooManyFields', message: 'Too many fields: expected 2, found 4', row: 2 },
      { code: 'UndelimitedContent', message: 'Too few fields: expected 2, found 1', row: 4 },
    ];
    const notice = describeUploadAdjustments(rows, issues, 'malformed');

    assert.ok(notice, 'a malformed file must produce a notice, not silence');
    assert.match(notice, /malformed/);
    assert.match(notice, /3 structural issue/);
    assert.match(notice, /Quotes around "unclosed" span multiple lines/);
    assert.match(notice, /missing or shifted/i);
    assert.equal(describeUploadAdjustments(rows, [], 'clean'), null, 'a clean parse must stay silent');
  });

  it('discloses header names the importer rewrote so queries use the stored names', () => {
    const rows = [{ 'Total MRR ($)': 100, 城市: 'Mumbai', plan: 'A' }];
    const notice = describeUploadAdjustments(rows, [], 'renamed');

    assert.ok(notice);
    assert.match(notice, /"Total MRR \(\$?\)" → "Total_MRR"/);
    assert.match(notice, /column name\(s\) were rewritten/i);
    assert.match(notice, /stored names/i);
  });

  it('discloses two headers that collapse onto one stored column', () => {
    const rows = [{ 'mrr usd': 100, mrr_usd: 200, plan: 'A' }];
    const notice = describeUploadAdjustments(rows, [], 'dupes');

    assert.ok(notice);
    assert.match(notice, /"mrr usd" and "mrr_usd"/);
    assert.match(notice, /only one set of values is kept/i);
    assert.match(notice, /was not loaded/i);
    assert.ok(!/rewritten/i.test(notice), 'a collapsed header must not also be reported as a plain rename');
  });

  it('says so when a file parses into zero data rows', () => {
    const notice = describeUploadAdjustments([], [], 'empty');

    assert.ok(notice);
    assert.match(notice, /no data rows/i);
    assert.match(notice, /loaded empty/i);
  });
});

describe('Final release verification — retrieval listings describe what was actually filtered', () => {
  const listingRows = [
    { customer_id: 'C001', customer_name: 'Aster Labs', mrr_usd: 2000 },
    { customer_id: 'C002', customer_name: 'BluePeak Systems', mrr_usd: 1800 },
    { customer_id: 'C003', customer_name: 'Cedar Works', mrr_usd: 2200 },
  ];
  const listingCols = ['customer_id', 'customer_name', 'mrr_usd'];

  it('does not call a recurring-revenue listing a time trend', () => {
    const category = classifyAnalyticalIntent(
      'List all customers with their monthly recurring revenue',
      'SELECT customer_id, customer_name, mrr_usd FROM accounts ORDER BY mrr_usd DESC',
      listingCols,
      listingRows
    );
    assert.notEqual(category, 'time_trend', 'the word "monthly" inside the measure name invented a time axis');

    const realTrend = classifyAnalyticalIntent(
      'Show the monthly revenue trend',
      'SELECT signup_month, total_mrr FROM monthly_revenue ORDER BY signup_month',
      ['signup_month', 'total_mrr'],
      [{ signup_month: '2026-01-01', total_mrr: 100 }, { signup_month: '2026-02-01', total_mrr: 120 }]
    );
    assert.equal(realTrend, 'time_trend', 'a result ordered along a month column must still classify as a trend');
  });

  it('states that an unfiltered listing applied no filter conditions', () => {
    const s = generateEvidenceBasedSummary(
      ctx(
        'List all customers with their monthly recurring revenue',
        'SELECT customer_id, customer_name, mrr_usd FROM accounts ORDER BY mrr_usd DESC',
        listingRows,
        parseQueryPlan({ intent: 'overview' }))
    );
    const overview = String(s.overview || '');
    assert.match(overview, /no filter conditions/i);
    assert.ok(!/specified filter criteria/i.test(overview), `the summary invented criteria: ${overview}`);
  });

  it('quotes the executed conditions when a listing really was filtered', () => {
    const s = generateEvidenceBasedSummary(
      ctx(
        'List customers with monthly recurring revenue above 1500',
        'SELECT customer_id, customer_name, mrr_usd FROM accounts WHERE mrr_usd > 1500',
        listingRows,
        parseQueryPlan({ intent: 'filter_lookup', filters: [{ column: 'mrr_usd', operator: '>', value: 1500 }] }))
    );
    const filtered = String(s.overview || '');
    assert.match(filtered, /mrr_usd > 1500/);
    assert.ok(!/no filter conditions/i.test(filtered));
  });
});

describe('Final release verification — blueprint fallback provenance', () => {
  it('marks blueprint-built results instead of presenting them as provider answers', () => {
    const service = fs.readFileSync('src/services/aiService.ts', 'utf-8');
    const view = fs.readFileSync('src/components/ResultsView.tsx', 'utf-8');

    assert.match(service, /title: 'Autonomous Blueprint Fallback'/, 'the service must report which builder produced the SQL');
    assert.match(view, /=== 'Autonomous Blueprint Fallback'/, 'the view must key on the same step title');
    assert.match(view, /usedBlueprintFallback && \(/, 'the provenance badge must be conditional, not decorative');
    assert.match(view, /no provider reply passed validation/i);
  });
});

describe('Final release verification — egress claims match the payload', () => {
  const buildPrompt = (rows: Record<string, any>[]) =>
    formatSemanticSchemaPrompt(profileDatasetSchema(inferDatasetSchema(rows, 'range_probe', 'Range Probe')), {
      strictZeroContentEgress: true,
      allowCategoricalEnums: false,
    });

  it('withholds numeric ranges from a table too small for a range to stay aggregate', () => {
    const tiny = buildPrompt([
      { employee: 'Ann', salary_usd: 120000 },
      { employee: 'Bob', salary_usd: 74000 },
    ]);
    assert.ok(!tiny.includes('120000'), `a 2-row table leaked its exact salary values as a range: ${tiny.slice(0, 400)}`);
    assert.ok(!tiny.includes('74000'), 'the lower bound leaked too');
    assert.match(tiny, /Range: withheld/i);
  });

  it('states the policy the payload actually applies once a table is large enough', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ team: `T${i % 3}`, salary_usd: 50000 + i * 1000 }));
    const prompt = buildPrompt(rows);
    assert.match(prompt, /STRICT ZERO-ROW EGRESS POLICY/);
    assert.match(prompt, /Range: 50000 to 79000/);
    assert.match(prompt, /at least 25 rows/);
    assert.ok(!prompt.includes('zero cell values'), 'the prompt may not claim more than it sends');
    assert.ok(!prompt.includes('"T0"'), 'categorical values stay synthetic under strict egress');
  });
});

describe('Final release verification — privacy wording states what actually leaves', () => {
  const sources = {
    uploader: fs.readFileSync('src/components/CsvUploader.tsx', 'utf-8'),
    onboarding: fs.readFileSync('src/components/OnboardingModal.tsx', 'utf-8'),
    apiKey: fs.readFileSync('src/components/ApiKeyModal.tsx', 'utf-8'),
    auditor: fs.readFileSync('src/components/TelemetryAuditorModal.tsx', 'utf-8'),
  };

  it('retires every absolute claim the sampled network evidence cannot support', () => {
    const banned: Array<[string, RegExp]> = [
      ['CsvUploader', /100% private/i],
      ['CsvUploader', /No data ever leaves/i],
      ['OnboardingModal', /processed 100% locally/i],
      ['OnboardingModal', /Never uploaded to any backend/i],
      ['ApiKeyModal', /100% Client-Side Privacy Guarantee/i],
      ['ApiKeyModal', /never stored persistently/i],
      ['ApiKeyModal', /Zero-Backend Privacy Guarantee/i],
      ['TelemetryAuditorModal', /Zero-?Row Guarantee|Privacy Boundary Verification/i],
      ['TelemetryAuditorModal', /Categorical sample values are excluded/i],
    ];
    for (const [label, pattern] of banned) {
      assert.ok(!pattern.test(sources[label as keyof typeof sources]), `"${label}" still carries the claim ${pattern}`);
    }
  });

  it('tells the user the key is persisted when the remember option is on', () => {
    assert.match(sources.apiKey, /\{rememberKey \?/, 'key-storage wording must follow the actual opt-in');
    assert.match(sources.apiKey, /local storage/);
    assert.match(sources.apiKey, /sent only to the provider endpoint you selected/);
  });

  it('enumerates the statistics that are in fact transmitted', () => {
    for (const needle of [/Distinct-value counts per column/, /Numeric min\/max ranges/, /synthetic labels/, /Table name and total row count/]) {
      assert.match(sources.auditor, needle, `the egress list omits ${needle}`);
    }
    assert.match(sources.auditor, /datasetRowCount >= 25/, 'range disclosure must be stated conditionally, matching the profiler threshold');
    assert.match(sources.uploader, /aggregate statistics go only to the AI provider/i);
    assert.match(sources.onboarding, /rows are never sent anywhere/, 'upload screen must separate rows from statistics');
  });
});

describe('Final release verification — self-correction rounds carry no cell values', () => {
  it('withholds the cell value DuckDB quotes inside its runtime error', () => {
    const duckDbError = "Conversion Error: Could not convert string 'Alpha' to INT64 when casting from source column team";
    const scrubbed = redactCellValuesForEgress(duckDbError);
    assert.ok(!scrubbed.includes("'Alpha'"), `the offending value was still transmitted: ${scrubbed}`);
    assert.match(scrubbed, /cell value withheld/, 'the planner must still see that a string could not be cast');
    assert.match(scrubbed, /INT64 when casting from source column team/, 'the repairable part of the message survives');
    assert.equal(
      redactCellValuesForEgress('Intent Validation Error: Ranking queries require an ORDER BY clause.'),
      'Intent Validation Error: Ranking queries require an ORDER BY clause.',
      'value-free messages pass through untouched'
    );
  });

  it('scrubs only the egress copy of the error, leaving the local error text intact', () => {
    const service = fs.readFileSync('src/services/aiService.ts', 'utf-8');
    assert.match(
      service,
      /redactCellValuesForEgress\(e\)/,
      'the correction block must scrub every error it transmits'
    );
    assert.match(service, /lastErrors = \[execResult\.error \|\| 'Query verification failed\.'\]/,
      'the stored error stays verbatim so the UI and the final failure message keep their detail');
  });
});

describe('Final release verification — dataset values are never compiled as patterns', () => {
  const hostile = inferDatasetSchema([
    { id: 1, note: '+1+1' },
    { id: 2, note: '@SUM(1+9)*cmd' },
    { id: 3, note: 'a|b(c' },
    { id: 4, note: '[a-z]{2,}' },
    { id: 5, note: 'plain text' },
  ], 'formula_probe', 'Formula Probe');
  const hostileSchema = profileDatasetSchema(hostile);
  const plan = parseQueryPlan({ intent: 'filter_lookup', dimensions: ['note'] });

  it('validates a question that quotes a regex-broken cell value instead of throwing', () => {
    const run = () => validateSqlIntent(
      'SELECT id, note FROM dataset ORDER BY id',
      plan,
      hostileSchema,
      'list the note values where the note contains +1+1'
    );
    assert.doesNotThrow(run, 'a cell value such as "+1+1" must not reach the RegExp constructor as a pattern');
    const result = run();
    assert.ok(Array.isArray(result.errors));
  });

  it('still treats the value as a literal when it genuinely appears in the question', () => {
    assert.equal(escapeForLiteralRegex('+1+1'), '\\+1\\+1');
    const mention = buildValueMentionRegex('+1+1');
    assert.ok(mention.test('list the note values where the note contains +1+1'), 'the literal value is recognised');
    assert.ok(!buildValueMentionRegex('+1+1').test('the note contains 11'), 'quantifier meaning is not revived');
    assert.ok(buildValueMentionRegex('Mid-Market').test('split by mid-market'), 'separator flexibility is kept');
    assert.ok(buildValueMentionRegex('Paid Search').test('how much from paid search?'), 'word values still match at boundaries');
    assert.ok(!buildValueMentionRegex('Paid Search').test('unpaid searching'), 'a value inside a longer word is not a mention');
  });
});

describe('Final release verification — the leakage scan attributes matches to where they appear', () => {
  const rows = [{ row_id: 'R1', plan: 'Business', city: 'Chennai' }];
  const wrap = (schemaBlock: string, guidance: string) =>
    JSON.stringify({ prompt: `TABLE: "x"\nMEASURES / METRICS\n${schemaBlock}\nSQL GENERATION BLUEPRINTS\n${guidance}` });

  it('does not report a value that only appears in the fixed planner guidance', () => {
    const audit = telemetryAuditor.verifyPayloadDataLeakage(
      wrap('- "plan" (VARCHAR, role: DIMENSION) -> [Distinct: 3, Synthetic Types: "Category_A"]',
           'Do not suggest business actions that cannot be measured.'),
      rows
    );
    assert.equal(audit.scanScope, 'schema_block');
    assert.equal(audit.isSafe, true, `guidance wording is not dataset egress: ${audit.leakedFields.join(', ')}`);
    assert.deepEqual(audit.matchesOutsideSchema, ['plan="Business"'], 'the coincidence is still disclosed');
    assert.deepEqual(audit.leakedFields, []);
  });

  it('reports a value that sits inside the schema block, whatever the word is', () => {
    const audit = telemetryAuditor.verifyPayloadDataLeakage(
      wrap('- "plan" (VARCHAR, role: DIMENSION) -> [Categories: "Business"]', 'guidance text'),
      rows
    );
    assert.equal(audit.isSafe, false, 'synthetic masking failure must surface, not be allowlisted away');
    assert.deepEqual(audit.leakedFields, ['plan="Business"']);
  });

  it('falls back to scanning an unmarked payload instead of scanning nothing', () => {
    const audit = telemetryAuditor.verifyPayloadDataLeakage('{"prompt":"Filter where city is Chennai"}', rows);
    assert.equal(audit.scanScope, 'whole_payload');
    assert.equal(audit.isSafe, false);
    assert.deepEqual(audit.leakedFields, ['city="Chennai"']);
  });

  it('states the scan region and the separate match list in the audit view', () => {
    const view = fs.readFileSync('src/components/TelemetryAuditorModal.tsx', 'utf-8');
    assert.match(view, /appear inside the prompt's schema block/, 'a failure must name the region that leaked');
    assert.match(view, /matchesOutsideSchema\.length/, 'guidance-only coincidences are shown as such');
    assert.match(view, /provider retention are unverified/);
    assert.doesNotMatch(view, /BOILERPLATE_SKIPPED_WORDS/, 'no hand-maintained skip list may return');
  });
});

describe('Final release verification — display labels never expose SQL aliases', () => {
  const segmentRows = [
    { segment: 'Enterprise', customer_count: 7, total_mrr: 14000 },
    { segment: 'Mid-Market', customer_count: 6, total_mrr: 6150 },
    { segment: 'SMB', customer_count: 9, total_mrr: 1950 },
    { segment: 'Startup', customer_count: 8, total_mrr: 1100 },
  ];
  const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment'], metric: 'mrr_usd', aggregation: 'SUM' });

  it('writes measure acronyms in upper case throughout the briefing', () => {
    const s = generateEvidenceBasedSummary(
      ctx('Total MRR and customer count by segment.', 'SELECT segment, COUNT(*) AS customer_count, SUM(mrr_usd) AS total_mrr FROM saas_accounts GROUP BY segment ORDER BY total_mrr DESC', segmentRows, plan)
    );
    const prose = [
      s.summary,
      s.overview,
      ...(s.findings || []),
      ...(s.key_findings || []).flatMap((f) => [f.finding, f.evidence || '']),
      ...(s.performance_comparison || []),
      ...(s.limitations || []),
      ...(s.kpi_callouts || []).flatMap((k) => [k.label, k.context || '']),
    ].join('\n');
    assert.match(prose, /MRR/);
    assert.doesNotMatch(prose, /(^|[^_a-z])mrr([^_a-z]|$)/, `lower-case acronym leaked into prose:\n${prose}`);
    assert.match(prose, /14,000/, 'numbers are untouched');
  });

  it('keeps identifiers such as mrr_usd intact', () => {
    const s = generateEvidenceBasedSummary(
      ctx('List customers with mrr_usd above 1500.', "SELECT customer_id, mrr_usd FROM saas_accounts WHERE mrr_usd > 1500", [{ customer_id: 'C001', mrr_usd: 2000 }])
    );
    assert.doesNotMatch(JSON.stringify(s), /MRR_usd|mrr_USD/);
  });

  it('formats chart labels from aliases and the chart renders the formatted labels', () => {
    assert.equal(formatHeaderName('total_mrr'), 'Total MRR');
    assert.equal(formatHeaderName('avg_mrr_usd'), 'Avg MRR USD');
    assert.equal(formatHeaderName('customer_id'), 'Customer ID');
    assert.equal(formatHeaderName('acquisition_channel'), 'Acquisition Channel');
    assert.equal(formatHeaderName(''), '');
    const chart = fs.readFileSync('src/components/DataChart.tsx', 'utf-8');
    assert.doesNotMatch(chart, /\{yKey\} vs \{xKey\}/, 'subtitle must not print raw aliases');
    assert.doesNotMatch(chart, /bars on \{xKey\}/);
    assert.match(chart, /\{yLabel\} vs \{xLabel\}/);
  });

  it('labels bar percentages against the shown values, never as a share of the whole dataset', () => {
    // A top-5 chart showed "23.4% share" for a customer holding 10.8% of total MRR.
    const chart = fs.readFileSync('src/components/DataChart.tsx', 'utf-8');
    assert.doesNotMatch(chart, /% share/);
    assert.doesNotMatch(chart, /% of total/);
    assert.match(chart, /% of shown/);
    assert.match(chart, /values shown/);
  });
});

describe('Final release verification — the scope guard does not refuse analytics phrased as questions', () => {
  it('lets conversational openers through when they name the table\'s own columns', () => {
    for (const q of [
      'Who are the top 5 customers by MRR?',
      'Show the MRR trend by signup month',
      'Why is Enterprise MRR so high?',
      'Tell me about cancelled customers by segment',
    ]) {
      assert.equal(isQueryOutOfScope(q, dataset).outOfScope, false, `"${q}" is an analytical question about this table`);
    }
  });

  it('still refuses trivia, chit-chat and memes', () => {
    for (const q of [
      'Who is the president of India?',
      'Who are you?',
      'Why is the sky blue?',
      'Tell me a joke',
      'What is trending on twitter?',
      'What is the latest trend?',
      'How do I bake bread?',
    ]) {
      assert.equal(isQueryOutOfScope(q, dataset).outOfScope, true, `"${q}" must stay out of scope`);
    }
  });
});

describe('Final release verification — rankings explain the result instead of restating it', () => {
  const rankingPlan = parseQueryPlan({ intent: 'ranking', dimensions: ['customer_id', 'customer_name'], metric: 'mrr_usd', ranking_direction: 'DESC', limit: 3 });
  const top3 = [
    { customer_id: 'C005', customer_name: 'Evergreen Group', mrr_usd: 2500 },
    { customer_id: 'C003', customer_name: 'Cobalt Systems', mrr_usd: 2200 },
    { customer_id: 'C001', customer_name: 'Aster Labs', mrr_usd: 2000 },
  ];
  const sql = 'SELECT customer_id, customer_name, mrr_usd FROM saas_accounts ORDER BY mrr_usd DESC, customer_id ASC LIMIT 3';

  it('names records, quantifies the gaps and places the top N inside the whole population', () => {
    const population = RECORDS.reduce((acc, r) => acc + r.mrr_usd, 0);
    const s = generateEvidenceBasedSummary({
      ...ctx('Who are the top 3 customers by MRR?', sql, top3, rankingPlan),
      auxStats: { rankedColumn: 'mrr_usd', rankedPopulationTotal: population, rankedPopulationCount: RECORDS.length },
    });
    const text = [s.overview, ...(s.findings || []), ...(s.business_implications || []).map((i) => (typeof i === 'string' ? i : i.implication))].join('\n');
    assert.match(text, /Evergreen Group \(C005\)/, text);
    assert.doesNotMatch(text, /ranked by mrr_usd/, 'the raw alias must not reach the prose');
    assert.match(text, /\$300 \(12\.0%\) behind Evergreen Group/, text);
    assert.match(text, /1\.3x spread/, text);
    assert.match(text, /together they total \$6,700/, text);
    assert.match(text, /These 3 of 8 .* account for \$6,700 of \$11,600 total MRR USD \(57\.8%\) while making up 37\.5%/, text);
    assert.match(text, /concentrated/, text);
  });

  it('does not invent a population share when none was computed', () => {
    const s = generateEvidenceBasedSummary(ctx('Who are the top 3 customers by MRR?', sql, top3, rankingPlan));
    assert.doesNotMatch(JSON.stringify(s), /total MRR USD \(\d/);
    assert.ok((s.limitations || []).some((l) => /share of the overall total was not computed/.test(l)));
  });

  it('does not say the smallest value "leads" an ascending ranking', () => {
    const bottom = [
      { customer_id: 'C007', customer_name: 'Glyph Studio', mrr_usd: 100 },
      { customer_id: 'C006', customer_name: 'Fernworks', mrr_usd: 300 },
      { customer_id: 'C008', customer_name: 'Helix Data', mrr_usd: 1200 },
    ];
    const s = generateEvidenceBasedSummary(
      ctx('Which 3 customers have the lowest MRR?', 'SELECT customer_id, customer_name, mrr_usd FROM saas_accounts ORDER BY mrr_usd ASC LIMIT 3', bottom,
        parseQueryPlan({ intent: 'ranking', dimensions: ['customer_id', 'customer_name'], metric: 'mrr_usd', ranking_direction: 'ASC', limit: 3 }))
    );
    const text = [s.overview, ...(s.findings || [])].join('\n');
    assert.doesNotMatch(text, /Glyph Studio \(C007\) leads/, text);
    assert.match(text, /Glyph Studio \(C007\) has the lowest/, text);
    assert.match(text, /\$200 \(200\.0%\) above Glyph Studio/, text);
  });

  it('computes population totals only for plain row-level rankings', () => {
    const cols = ['customer_id', 'customer_name', 'mrr_usd'];
    assert.equal(rankedRawColumn(sql, cols, dataset), 'mrr_usd');
    assert.equal(rankedRawColumn("SELECT customer_id, mrr_usd FROM saas_accounts WHERE segment = 'SMB' ORDER BY mrr_usd DESC LIMIT 2", ['customer_id', 'mrr_usd'], dataset), 'mrr_usd');
    assert.equal(rankedRawColumn('SELECT customer_id, mrr_usd FROM saas_accounts ORDER BY mrr_usd DESC', ['customer_id', 'mrr_usd'], dataset), undefined, 'no LIMIT: nothing was left out');
    assert.equal(rankedRawColumn('SELECT segment, SUM(mrr_usd) AS mrr_usd FROM saas_accounts GROUP BY segment ORDER BY mrr_usd DESC LIMIT 2', ['segment', 'mrr_usd'], dataset), undefined);
    assert.equal(rankedRawColumn('SELECT customer_id, mrr_usd FROM (SELECT * FROM saas_accounts) ORDER BY mrr_usd DESC LIMIT 2', ['customer_id', 'mrr_usd'], dataset), undefined);
    assert.equal(rankedRawColumn('SELECT customer_id, customer_name FROM saas_accounts ORDER BY customer_name LIMIT 2', ['customer_id', 'customer_name'], dataset), undefined, 'text ordering is not a measure');
  });
});

describe('Final release verification — time trends are narrated as trends', () => {
  const monthly = [
    ['2025-01', 4, 3150], ['2025-02', 4, 2900], ['2025-03', 4, 3950], ['2025-04', 4, 2850], ['2025-05', 4, 3700],
    ['2025-06', 3, 550], ['2025-07', 2, 400], ['2025-08', 3, 3700], ['2025-09', 2, 2000],
  ].map(([signup_month, new_customers, total_mrr]) => ({ signup_month, new_customers, total_mrr }));
  const sql = "SELECT strftime(CAST(signup_date AS DATE), '%Y-%m') AS signup_month, COUNT(*) AS new_customers, SUM(mrr_usd) AS total_mrr FROM saas_accounts GROUP BY signup_month ORDER BY signup_month ASC";
  const plan = parseQueryPlan({ intent: 'time_trend', dimensions: ['signup_date'], metric: 'mrr_usd', aggregation: 'SUM', time_grain: 'month' });

  it('describes direction, turning points and drivers instead of ranking periods like segments', () => {
    const s = generateEvidenceBasedSummary(ctx('Show the MRR trend by signup month', sql, monthly, plan));
    const text = JSON.stringify(s);
    assert.match(s.overview || '', /\$3,150.*\$2,000.*36\.5%/, s.overview);
    assert.match(text, /2025-03/);
    assert.match(text, /2025-07/);
    assert.match(text, /2025-05 to 2025-06[^"]*\$3,150/, text);
    assert.match(text, /\$1,662\.50[^"]*\$3,212\.50[^"]*48\.2%/, text);
    assert.match(text, /volume/i, text);
    assert.match(text, /"New customers averaged 2\.5 per period/, 'findings start with a capital letter');
    assert.ok((s.limitations || []).some((l) => /cohort|signup/i.test(l)), 'signup axes must carry a cohort caveat');
    assert.doesNotMatch(text, /Prioritize 2025-\d\d retention/, 'periods are not accounts to retain');
  });

  it('formats currency with whole cents at every magnitude', () => {
    assert.equal(formatMetricValue(1662.5, 'total_mrr'), '$1,662.50');
    assert.equal(formatMetricValue(338.5, 'mrr_usd'), '$338.50');
    assert.equal(formatMetricValue(23200, 'total_mrr'), '$23,200');
    assert.equal(formatMetricValue(-1234.567, 'profit'), '-$1,234.57');
  });

  it('classifies a date-truncated GROUP BY as a time trend even without a plan', () => {
    assert.equal(classifyAnalyticalIntent('MRR by signup month', sql, ['signup_month', 'new_customers', 'total_mrr'], monthly), 'time_trend');
  });
});

describe('Final release verification — share-of-total columns are read as shares, not as extra metrics', () => {
  const sql = 'SELECT plan, SUM(mrr_usd) AS total_mrr, ROUND(100.0 * SUM(mrr_usd) / (SELECT SUM(mrr_usd) FROM saas_accounts), 1) AS pct_of_total_mrr FROM saas_accounts GROUP BY plan ORDER BY total_mrr DESC';
  const plan = parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['plan'], metric: 'mrr_usd', aggregation: 'SUM' });
  const rows = [
    { plan: 'Enterprise', total_mrr: 14000, pct_of_total_mrr: 60.3 },
    { plan: 'Growth', total_mrr: 4250, pct_of_total_mrr: 18.3 },
    { plan: 'Business', total_mrr: 3600, pct_of_total_mrr: 15.5 },
    { plan: 'Starter', total_mrr: 1350, pct_of_total_mrr: 5.8 },
  ];

  it('summarises concentration once and never treats the share as a rate to investigate', () => {
    const s = generateEvidenceBasedSummary(ctx('What share of total MRR does each plan contribute?', sql, rows, plan));
    const text = JSON.stringify(s);
    assert.match(text, /Enterprise and Growth together hold 78\.6% of the total; Starter holds the smallest share at 5\.8%/, text);
    assert.doesNotMatch(text, /leads in pct of total/i, text);
    assert.doesNotMatch(text, /Highest pct of total/i, text);
    assert.doesNotMatch(text, /gap in Starter|not lifecycle status/, text);
    assert.equal((s.findings || []).filter((f) => f.includes('60.3%')).length, 1, 'the leader share is stated once in the findings');
  });

  it('notes the remainder when the returned shares do not cover the whole', () => {
    const s = generateEvidenceBasedSummary(ctx('Share of MRR for the three largest plans', sql, rows.slice(0, 3), plan));
    assert.match(JSON.stringify(s), /add up to 94\.1%, so the remaining 5\.9% sits outside this result/);
  });
});

describe('Final release verification — grouped overviews never print raw column aliases', () => {
  it('names a total_mrr_usd column as "MRR USD" in the overview', () => {
    const rows = [
      { segment: 'Enterprise', row_count: 7, total_mrr_usd: 14000 },
      { segment: 'Mid-Market', row_count: 6, total_mrr_usd: 6150 },
      { segment: 'SMB', row_count: 9, total_mrr_usd: 1950 },
      { segment: 'Startup', row_count: 8, total_mrr_usd: 1100 },
    ];
    const s = generateEvidenceBasedSummary(ctx('Total MRR by segment',
      'SELECT segment, COUNT(*) AS row_count, ROUND(SUM(mrr_usd), 2) AS total_mrr_usd FROM saas_accounts GROUP BY segment ORDER BY total_mrr_usd DESC', rows,
      parseQueryPlan({ intent: 'aggregate_by_dimension', dimensions: ['segment'], metric: 'mrr_usd', aggregation: 'SUM' })));
    assert.doesNotMatch(s.overview || '', /[A-Z]+_[A-Z]+|\w_\w/, s.overview);
    assert.match(s.overview || '', /\$14,000 in MRR USD/, s.overview);
  });
});

describe('Final release verification — row counts do not invent an entity or distinctness', () => {
  const count = (sql: string, tableName: string) => generateEvidenceBasedSummary({
    question: 'Count the rows in the table', sql, status: 'verified', rows: [{ row_count: 3 }], columns: ['row_count'], rowCount: 1,
    datasetName: tableName, tableName, queryPlan: parseQueryPlan({ intent: 'aggregate', aggregation: 'COUNT' }),
  });

  it('calls rows of a sales table records and only says distinct for COUNT(DISTINCT)', () => {
    const plain = count('SELECT COUNT(*) AS row_count FROM regional_sales', 'regional_sales');
    assert.doesNotMatch(plain.overview || '', /orders|distinct/, plain.overview);
    assert.match(plain.overview || '', /3 records/, plain.overview);
    const distinct = count('SELECT COUNT(DISTINCT region) AS row_count FROM regional_sales', 'regional_sales');
    assert.match(distinct.overview || '', /3 distinct/, distinct.overview);
  });
});

describe('Real-provider findings — per-group ranking prose', () => {
  it('describes per-group rankings in readable labels, not raw SQL aliases', () => {
    // Replays the gemini-3.6-flash result for "top 2 customers by MRR in each city".
    const plan = parseQueryPlan({ intent: 'top_n_per_group', partition_by: ['city'], item_entity: 'customer_name', dimensions: ['city', 'customer_name'], metric: 'mrr_usd', ranking_direction: 'DESC', limit: 2 });
    const rows = [
      { city: 'Bengaluru', customer_name: 'BluePeak Systems', total_mrr: 1800 },
      { city: 'Bengaluru', customer_name: 'Apex Systems', total_mrr: 1300 },
      { city: 'Chennai', customer_name: 'Evergreen Group', total_mrr: 2500 },
      { city: 'Chennai', customer_name: 'Dynamo Group', total_mrr: 1900 },
    ];
    const sql = 'WITH r AS (SELECT city, customer_name, SUM(mrr_usd) AS total_mrr, ROW_NUMBER() OVER (PARTITION BY city ORDER BY SUM(mrr_usd) DESC) AS rank FROM dataset GROUP BY city, customer_name) SELECT city, customer_name, total_mrr FROM r WHERE rank <= 2 ORDER BY city, total_mrr DESC';
    const s = generateEvidenceBasedSummary(ctx('What are the top 2 customers by MRR in each city?', sql, rows, plan));
    const prose = [s.overview, ...(s.findings || [])].join('\n');
    assert.doesNotMatch(prose, /customer_name|total_mrr/, prose);
    assert.match(prose, /customer records within each city/, prose);
    assert.match(prose, /Chennai: Evergreen Group — \$2,500 in total MRR/, prose);
  });
});

describe('Real-provider findings — unfiltered multi-dimensional breakdown', () => {
  // Replays the gemini-3.6-flash result for "total MRR and customer count by segment and subscription status".
  const rows = [
    { segment: 'Enterprise', subscription_status: 'Active', total_mrr: 12500, customer_count: 6 },
    { segment: 'Mid-Market', subscription_status: 'Active', total_mrr: 5050, customer_count: 5 },
    { segment: 'SMB', subscription_status: 'Active', total_mrr: 1800, customer_count: 8 },
    { segment: 'Enterprise', subscription_status: 'Cancelled', total_mrr: 1500, customer_count: 1 },
    { segment: 'Mid-Market', subscription_status: 'Cancelled', total_mrr: 1100, customer_count: 1 },
    { segment: 'Startup', subscription_status: 'Active', total_mrr: 750, customer_count: 6 },
    { segment: 'Startup', subscription_status: 'Cancelled', total_mrr: 350, customer_count: 2 },
    { segment: 'SMB', subscription_status: 'Cancelled', total_mrr: 150, customer_count: 1 },
  ];
  const plan = parseQueryPlan({ intent: 'group_aggregate', dimensions: ['segment', 'subscription_status'], metric: 'mrr_usd' });
  const q = 'Break down total MRR and customer count by segment and subscription status';
  const base = 'SELECT segment, subscription_status, ROUND(SUM(mrr_usd), 2) AS total_mrr, COUNT(DISTINCT customer_id) AS customer_count FROM dataset GROUP BY segment, subscription_status';

  it('does not call an unfiltered result "filtered"', () => {
    const s = generateEvidenceBasedSummary(ctx(q, `${base} ORDER BY total_mrr DESC`, rows, plan));
    const lim = (s.limitations || []).join('\n');
    assert.doesNotMatch(lim, /filtered result/, lim);
    assert.doesNotMatch(lim, /narrative below/, lim);
    assert.match(lim, /shares of the \$23,200 returned across these groups/, lim);
  });

  it('still flags the share as partial when the SQL narrows the rows', () => {
    const s = generateEvidenceBasedSummary(ctx(q, `${base.replace(' GROUP BY', " WHERE city <> 'Delhi' GROUP BY")} ORDER BY total_mrr DESC`, rows, plan));
    assert.match((s.limitations || []).join('\n'), /in this filtered result rather than of the whole dataset/);
  });
});

describe('Real-provider findings — executive summary answers "how much they represent"', () => {
  const q = 'Give me an executive summary of our customer base: total customers, total MRR, cancelled customers and how much MRR they represent';
  const sql = "SELECT COUNT(customer_id) AS total_customers, ROUND(SUM(mrr_usd), 2) AS total_mrr, COUNT(CASE WHEN LOWER(subscription_status) IN ('cancelled') THEN 1 END) AS cancelled_customers, ROUND(SUM(CASE WHEN LOWER(subscription_status) IN ('cancelled') THEN mrr_usd ELSE 0 END), 2) AS cancelled_mrr FROM dataset";

  it('states the subset share of each total that the same row returned', () => {
    // Replays the gemini-3.6-flash result; 5/30 customers and $3,100/$23,200 MRR.
    const s = generateEvidenceBasedSummary(ctx(q, sql, [{ total_customers: 30, total_mrr: 23200, cancelled_customers: 5, cancelled_mrr: 3100 }]));
    const text = [s.overview, ...(s.findings || [])].join('\n');
    assert.match(text, /cancelled customers \(5\) are 16\.7% of total customers \(30\)/i, text);
    assert.match(text, /cancelled MRR \(\$3,100\) are 13\.4% of total MRR \(\$23,200\)/i, text);
  });

  it('never treats an average or a ratio as a share of the total', () => {
    const s = generateEvidenceBasedSummary(ctx('Average and total MRR', 'SELECT AVG(mrr_usd) AS avg_mrr, SUM(mrr_usd) AS total_mrr FROM dataset', [{ avg_mrr: 773.33, total_mrr: 23200 }]));
    assert.doesNotMatch(JSON.stringify(s), /% of total MRR/);
  });

  it('skips a "subset" that exceeds its total', () => {
    const s = generateEvidenceBasedSummary(ctx(q, sql, [{ total_customers: 3, cancelled_customers: 5 }]));
    assert.doesNotMatch(JSON.stringify(s), /% of total customers/);
  });
});

describe('Real-provider findings — lifecycle caveat names the actual gap', () => {
  // Both gemini-3.6-flash and openai/gpt-oss-120b said "no lifecycle column" for a dataset
  // whose subscription_status column was simply not in the grouped result.
  const plan = parseQueryPlan({ intent: 'group_aggregate', dimensions: ['segment'], metric: 'mrr_usd' });
  const sql = 'SELECT segment, ROUND(SUM(mrr_usd), 2) AS total_mrr, COUNT(DISTINCT customer_id) AS customer_count FROM dataset GROUP BY segment ORDER BY total_mrr DESC';
  const rows = [
    { segment: 'Enterprise', total_mrr: 14000, customer_count: 7 },
    { segment: 'Mid-Market', total_mrr: 6150, customer_count: 6 },
    { segment: 'SMB', total_mrr: 1950, customer_count: 9 },
    { segment: 'Startup', total_mrr: 1100, customer_count: 8 },
  ];
  const lifecycleCols = [{ ...schema.columns[0], name: 'subscription_status' }];

  it('says the grouped result omits the lifecycle column when the dataset has one', () => {
    const s = generateEvidenceBasedSummary({ ...ctx('Show total MRR and number of customers by segment', sql, rows, plan), semanticSchema: { ...schema, columns: [...schema.columns, ...lifecycleCols] } });
    const lim = (s.limitations || []).join('\n');
    assert.doesNotMatch(lim, /has no lifecycle column/, lim);
    assert.match(lim, /its groups do not carry subscription_status/, lim);
  });

  it('still says the dataset has no lifecycle column when it truly lacks one', () => {
    const s = generateEvidenceBasedSummary(ctx('Show total MRR and number of customers by segment', sql, rows, plan));
    const lim = (s.limitations || []).join('\n');
    if (!schema.columns.some((c) => /status|churn|retention|renewal|tenure|cancel/i.test(c.name))) {
      assert.match(lim, /has no lifecycle column/, lim);
    }
  });
});

describe('Real-provider findings — provider-chosen aliases do not change money formatting', () => {
  const plan = parseQueryPlan({ intent: 'group_aggregate', dimensions: ['plan'], metric: 'mrr_usd' });
  const rows = [
    { plan: 'Enterprise', plan_total: 14000, pct_of_total: 60.34 },
    { plan: 'Growth', plan_total: 4250, pct_of_total: 18.32 },
    { plan: 'Business', plan_total: 3600, pct_of_total: 15.52 },
    { plan: 'Starter', plan_total: 1350, pct_of_total: 5.82 },
  ];
  const q = 'What percentage of total MRR comes from each plan?';

  it('formats SUM(mrr_usd) AS plan_total as currency and keeps it as the revenue measure', () => {
    // Replays the openai/gpt-oss-120b result, which printed "14,000" and claimed no revenue measure.
    const sql = 'WITH totals AS (SELECT SUM(mrr_usd) AS grand_total FROM querymind_sample_saas), breakdown AS (SELECT plan, SUM(mrr_usd) AS plan_total FROM querymind_sample_saas GROUP BY plan) SELECT b.plan, b.plan_total, ROUND((b.plan_total / NULLIF(t.grand_total,0)) * 100, 2) AS pct_of_total FROM breakdown b, totals t ORDER BY b.plan_total DESC';
    const s = generateEvidenceBasedSummary(ctx(q, sql, rows, plan));
    const text = JSON.stringify(s);
    assert.match(text, /\$14,000/, text);
    assert.match(text, /\$4,250/, text);
    const bare = text.replace(/\$14,000/g, '');
    assert.doesNotMatch(bare, /14,000/, bare);
    assert.doesNotMatch(text, /contains no revenue measure/, text);
    assert.doesNotMatch(text, /no revenue conclusion/, text);
  });

  it('does not treat a count aliased like money as currency', () => {
    const sql = 'SELECT plan, COUNT(customer_id) AS customer_count FROM dataset GROUP BY plan';
    const s = generateEvidenceBasedSummary(ctx('Customers by plan', sql, [{ plan: 'Enterprise', customer_count: 7 }], plan));
    assert.doesNotMatch(JSON.stringify(s), /\$7\b/);
  });
});
