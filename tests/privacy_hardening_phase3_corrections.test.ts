import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PREBUILT_DATASETS, inferDatasetSchema } from '../src/services/sampleData';
import {
  profileDatasetSchema,
  formatSemanticSchemaPrompt,
  roundRangeBound,
} from '../src/services/schemaProfiler';
import { processNaturalLanguageQuery } from '../src/services/aiService';
import { DEFAULT_MODELS } from '../src/services/modelRegistry';
import { telemetryAuditor } from '../src/services/telemetryAuditor';
import type { AiProvider } from '../src/types';

const saasDataset = PREBUILT_DATASETS.saas.dataset;
const config = (provider: AiProvider = 'gemini') => ({
  provider,
  model: DEFAULT_MODELS[provider],
  key: 'test-key-not-real',
});

function providerOutOfScope(provider: AiProvider): Response {
  const content = JSON.stringify({ isOutOfScope: true, outOfScopeReason: 'Mock planner stopped before engine execution.' });
  return Response.json(provider === 'gemini'
    ? { candidates: [{ content: { parts: [{ text: content }] } }] }
    : { choices: [{ message: { content } }] });
}

function providerSql(provider: AiProvider, sql: string, queryPlan: Record<string, any> = {}): Response {
  const content = JSON.stringify({ sql, queryPlan });
  return Response.json(provider === 'gemini'
    ? { candidates: [{ content: { parts: [{ text: content }] } }] }
    : { choices: [{ message: { content } }] });
}

const strictPrompt = (rows: Record<string, any>[]) =>
  formatSemanticSchemaPrompt(profileDatasetSchema(inferDatasetSchema(rows, 'probe', 'Probe')), {
    strictZeroContentEgress: true,
    allowCategoricalEnums: false,
  });

const salaryRows = (count: number, start = 50000, step = 1000) =>
  Array.from({ length: count }, (_, i) => ({ team: `T${i % 3}`, salary_usd: start + i * step }));

describe('Privacy hardening phase 3 — rounding containment', () => {
  it('never moves a lower bound above the data or an upper bound below it', () => {
    const values = [
      1234.56, 98765.43, 0.1, 1.1, 999.9, 1000, 1000.1, -1234.56, -3.2, -0.4,
      0.30000000000000004, 7, 42.4242, 123456789.987,
    ];
    for (const value of values) {
      const down = roundRangeBound(value, 'down');
      const up = roundRangeBound(value, 'up');
      assert.ok(Number.isFinite(down), `down(${value}) is not finite`);
      assert.ok(Number.isFinite(up), `up(${value}) is not finite`);
      assert.ok(down <= value, `down(${value}) = ${down} exceeds the data`);
      assert.ok(up >= value, `up(${value}) = ${up} falls below the data`);
    }
  });

  it('keeps a value that is already at two significant figures unchanged', () => {
    assert.equal(roundRangeBound(34000, 'down'), 34000);
    assert.equal(roundRangeBound(34000, 'up'), 34000);
    assert.equal(roundRangeBound(1000, 'down'), 1000);
    assert.equal(roundRangeBound(1000, 'up'), 1000);
  });

  it('widens to the next step when the exact value is not representable at two significant figures', () => {
    const value = 0.30000000000000004;
    assert.equal(roundRangeBound(value, 'down'), 0.3);
    assert.equal(roundRangeBound(value, 'up'), 0.31);
    assert.ok(roundRangeBound(value, 'up') >= value);
  });

  it('handles powers of ten and their immediate neighbours', () => {
    assert.equal(roundRangeBound(999.9, 'up'), 1000);
    assert.ok(roundRangeBound(999.9, 'up') >= 999.9);
    assert.equal(roundRangeBound(1000.1, 'down'), 1000);
    assert.ok(roundRangeBound(1000.1, 'down') <= 1000.1);
  });

  it('contains negative and cross-zero bounds', () => {
    assert.ok(roundRangeBound(-3.2, 'down') <= -3.2);
    assert.ok(roundRangeBound(-3.2, 'up') >= -3.2);
    assert.ok(roundRangeBound(-3.2, 'down') < 0);
    assert.ok(roundRangeBound(4.7, 'up') > 0);
  });

  it('refuses to produce a non-finite bound instead of emitting Infinity', () => {
    const down = roundRangeBound(Number.MAX_VALUE, 'down');
    assert.ok(Number.isFinite(down));
    assert.ok(down <= Number.MAX_VALUE);
    assert.ok(Number.isNaN(roundRangeBound(Number.MAX_VALUE, 'up')));

    for (const direction of ['down', 'up'] as const) {
      const subnormal = roundRangeBound(5e-324, direction);
      assert.ok(Number.isNaN(subnormal), `subnormal ${direction} must be unrepresentable`);
    }
  });

  it('treats signed zero as zero', () => {
    assert.ok(Object.is(roundRangeBound(0, 'down'), 0));
    assert.ok(Object.is(roundRangeBound(-0, 'up'), 0) || Object.is(roundRangeBound(-0, 'up'), -0));
  });

  it('withholds an unrepresentable range instead of printing NaN or Infinity', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      team: `T${i % 3}`,
      salary_usd: i === 0 ? Number.MAX_VALUE : i,
    }));
    const prompt = strictPrompt(rows);
    assert.match(prompt, /Range: withheld, no safe rounded bound/i);
    assert.ok(!/Infinity|NaN/.test(prompt), 'the prompt must not carry a non-finite bound');
  });
});

describe('Privacy hardening phase 3 — range disclosure threshold', () => {
  it('applies the boundary at 24, 25 and 26 rows', () => {
    assert.match(strictPrompt(salaryRows(24, 50000, 1000)), /Range: withheld/i);

    const at25 = strictPrompt(salaryRows(25, 50000, 1000));
    const at26 = strictPrompt(salaryRows(26, 50000, 1000));
    assert.match(at25, /Range: 50000 to 74000/);
    assert.match(at26, /Range: 50000 to 75000/);
    assert.match(at25, /at least 25 rows/);
  });

  it('never emits a range for PII or identifier columns even above the threshold', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ssn: 100000000 + i,
      account_id: 900000 + i,
      salary_usd: 50000 + i * 1000,
    }));
    const prompt = strictPrompt(rows);
    const lineFor = (name: string) => prompt.split('\n').find((line) => line.includes(`"${name}"`)) || '';

    assert.ok(lineFor('ssn').includes('Protected PII'), 'a numeric PII column must be masked');
    assert.ok(!lineFor('ssn').includes('Range:'), 'a numeric PII column must not disclose a range');
    assert.ok(lineFor('account_id').includes('Entity Keys'), 'a numeric identifier must be masked');
    assert.ok(!lineFor('account_id').includes('Range:'), 'a numeric identifier must not disclose a range');
    assert.match(lineFor('salary_usd'), /Range: 50000 to 74000/);
  });
});

describe('Privacy hardening phase 3 — local column preflight', { concurrency: false }, () => {
  const flowRows = Array.from({ length: 12 }, (_, i) => ({
    order_id: `O-${i + 1}`,
    order_status: ['pending', 'done', 'queued', 'archived', 'in_progress'][i % 5],
    amount: 100 + i,
  }));
  const flowDataset = inferDatasetSchema(flowRows, 'flow_probe', 'Flow Probe');

  it('accepts an underscore cell value that is not among the sampled values', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const samples = flowDataset.columns.find((c) => c.name === 'order_status')!.sampleValues;
    assert.ok(!samples.includes('in_progress'), 'precondition: the value must sit outside the 4-value sample');

    const result = await processNaturalLanguageQuery('Show orders with status in_progress', flowDataset, config());

    assert.equal(calls, 1, 'a real cell value must not be rejected as an unknown column');
    assert.match(result.usedProvider, /GEMINI/i);
  });

  it('still rejects an underscore-shaped token that is neither a column nor a cell value', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Show orders by payment_state', flowDataset, config());

    assert.equal(calls, 0);
    assert.equal(result.isOutOfScope, true);
    assert.match(result.outOfScopeReason || '', /payment_state/);
  });

  it('rejects absent identifier-shaped columns without a provider call', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const risk = await processNaturalLanguageQuery('Show churn_risk by segment', saasDataset, config());
    const v2 = await processNaturalLanguageQuery('Show average nps_score_v2 by plan tier', saasDataset, config());

    assert.equal(calls, 0);
    assert.equal(risk.isOutOfScope, true);
    assert.match(risk.outOfScopeReason || '', /churn_status/);
    assert.equal(v2.isOutOfScope, true);
    assert.match(v2.outOfScopeReason || '', /nps_score/);
  });

  it('resolves a documented synonym by its identifier-shaped form', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    let wire = '';
    t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      calls += 1;
      wire = String(options.body);
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Show monthly_revenue by plan_tier', saasDataset, config());

    assert.equal(calls, 1, 'monthly_revenue must resolve through the synonym map to the stored mrr column');
    assert.match(result.usedProvider, /GEMINI/i);
    assert.ok(wire.includes('monthly_revenue'));
    assert.ok(wire.includes('mrr'), 'the schema carries the stored measure the synonym resolves to');
  });

  it('asks for clarification on an ambiguous fragment instead of guessing', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Show support_score by plan tier', saasDataset, config());
    const reason = result.outOfScopeReason || '';

    assert.equal(calls, 0);
    assert.equal(result.isOutOfScope, true);
    assert.match(reason, /support_tickets/);
    assert.match(reason, /nps_score/);
    assert.match(reason, /clarif|exact column|which/i);
  });

  it('keeps an ordinary analytical question eligible for planning', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('What is the average mrr by plan tier?', saasDataset, config());

    assert.equal(calls, 1);
    assert.match(result.usedProvider, /GEMINI/i);
  });
});

describe('Privacy hardening phase 3 — retry prompt redaction on the wire', { concurrency: false }, () => {
  it('redacts a quoted cell value from the second provider request', async (t) => {
    telemetryAuditor.clearHistory();
    const bodies: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      bodies.push(String(options.body));
      if (bodies.length === 1) {
        // Omits the priority value the question points at, so intent validation fails
        // with an error that quotes a real cell value from the dataset.
        return providerSql('gemini', 'SELECT AVG(hours) AS avg_hours FROM tickets_probe');
      }
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const rows = Array.from({ length: 30 }, (_, i) => ({
      team: `Team ${String.fromCharCode(65 + (i % 3))}`,
      priority: i === 0 ? 'Critical' : ['Low', 'Medium', 'High'][i % 3],
      hours: 5 + i,
    }));
    const dataset = inferDatasetSchema(rows, 'tickets_probe', 'Ticket Probe');

    const result = await processNaturalLanguageQuery(
      'Show average hours by priority for Critical tickets',
      dataset,
      config()
    );

    assert.equal(bodies.length, 2, 'the retry loop must make a second provider request');
    assert.match(result.usedProvider, /GEMINI/i);

    const retry = bodies[1];
    assert.match(retry, /PREVIOUS ATTEMPT FAILED VALIDATION/);
    assert.ok(retry.includes('cell value withheld'), 'the redactor placeholder must appear in the retry prompt');
    assert.ok(!retry.includes("'Critical'"), 'the quoted cell value must not travel in the retry prompt');
  });
});