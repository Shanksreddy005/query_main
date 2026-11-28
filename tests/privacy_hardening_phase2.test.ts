import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PREBUILT_DATASETS, inferDatasetSchema } from '../src/services/sampleData';
import { profileDatasetSchema, formatSemanticSchemaPrompt } from '../src/services/schemaProfiler';
import { processNaturalLanguageQuery, redactCellValuesForEgress } from '../src/services/aiService';
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

const salaryRows = (count: number, start = 50000, step = 1000) =>
  Array.from({ length: count }, (_, i) => ({ team: `T${i % 3}`, salary_usd: start + i * step }));

const strictPrompt = (rows: Record<string, any>[]) =>
  formatSemanticSchemaPrompt(profileDatasetSchema(inferDatasetSchema(rows, 'probe', 'Probe')), {
    strictZeroContentEgress: true,
    allowCategoricalEnums: false,
  });

describe('Privacy hardening phase 2 — local column preflight', { concurrency: false }, () => {
  it('rejects an absent identifier-shaped column locally, without contacting a provider', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Show churn_risk by segment for the customers dataset', saasDataset, config());

    assert.equal(calls, 0, 'an unknown column must be refused before any provider dispatch');
    assert.equal(result.isOutOfScope, true);
    assert.match(result.outOfScopeReason || '', /churn_risk/);
    assert.match(result.outOfScopeReason || '', /not a column|is not a column/i);
    assert.match(result.outOfScopeReason || '', /churn_status/, 'the stored column that matches should be offered');
    assert.equal(result.sql, '');
  });

  it('rejects a near-miss column name locally, without contacting a provider', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('groq');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Show average nps_score_v2 by plan tier', saasDataset, config('groq'));

    assert.equal(calls, 0);
    assert.equal(result.isOutOfScope, true);
    assert.match(result.outOfScopeReason || '', /nps_score_v2/);
    assert.match(result.outOfScopeReason || '', /nps_score/, 'the real column is suggested instead of guessed');
    assert.equal(result.sql, '');
  });

  it('leaves a question that names an existing column eligible for AI planning', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    let wire = '';
    t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      calls += 1;
      wire = String(options.body);
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Show customers by signup_date', saasDataset, config());

    assert.equal(calls, 1, 'a real column must not be blocked locally');
    assert.match(result.usedProvider, /GEMINI/i);
    assert.ok(wire.includes('signup_date'));
  });

  it('accepts the documented revenue synonym when the table stores MRR', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    let wire = '';
    t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      calls += 1;
      wire = String(options.body);
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    await processNaturalLanguageQuery('Show monthly_revenue by plan_tier', saasDataset, config());

    assert.equal(calls, 1);
    assert.ok(wire.includes('monthly_revenue'));
    assert.ok(wire.includes('mrr'), 'the schema carries the mapped measure');
  });

  it('asks for clarification on an ambiguous column fragment instead of assuming one', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Show support_score by plan tier', saasDataset, config());

    assert.equal(calls, 0);
    assert.equal(result.isOutOfScope, true);
    const reason = result.outOfScopeReason || '';
    assert.match(reason, /support_score/);
    assert.match(reason, /support_tickets/);
    assert.match(reason, /nps_score/);
    assert.match(reason, /clarif|exact column|which/i, 'the reply must ask rather than choose');
    assert.equal(result.sql, '');
  });

  it('keeps a conversational-phrased analytical question on the AI path', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Why is Enterprise revenue so high?', saasDataset, config());

    assert.equal(calls, 1, 'a dataset metric and category must rescue the conversational opener');
    assert.match(result.usedProvider, /GEMINI/i);
  });

  it('still rejects out-of-domain trivia locally', async (t) => {
    telemetryAuditor.clearHistory();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return providerOutOfScope('gemini');
    });
    t.after(() => telemetryAuditor.clearHistory());

    const result = await processNaturalLanguageQuery('Tell me a skibidi toilet meme', saasDataset, config());

    assert.equal(calls, 0);
    assert.equal(result.isOutOfScope, true);
    assert.match(result.outOfScopeReason || '', /internet culture|memes/i);
  });
});

describe('Privacy hardening phase 2 — numeric range disclosure', () => {
  it('withholds numeric ranges from datasets below the disclosure threshold', () => {
    const prompt = strictPrompt(salaryRows(12));
    assert.match(prompt, /Range: withheld/i);
    assert.ok(!prompt.includes('50000'), 'a sub-threshold table must not disclose an exact bound');
    assert.ok(!prompt.includes('61000'));
  });

  it('rounds disclosed ranges outward to two significant figures', () => {
    const rows = [
      ...salaryRows(28, 2000, 1000),
      { team: 'T0', salary_usd: 1234.56 },
      { team: 'T1', salary_usd: 98765.43 },
    ];
    const prompt = strictPrompt(rows);
    assert.ok(prompt.includes('Range: 1200 to 99000'), `expected the widened range, got: ${prompt.match(/Range:[^\]]*/)?.[0]}`);
    assert.ok(!prompt.includes('1234.56'), 'the exact minimum leaked');
    assert.ok(!prompt.includes('98765.43'), 'the exact maximum leaked');
  });

  it('applies the threshold boundary at exactly the configured row count', () => {
    const below = strictPrompt(salaryRows(24, 10000, 1000));
    const atBoundary = strictPrompt(salaryRows(25, 10000, 1000));

    assert.match(below, /Range: withheld/i);
    assert.ok(!below.includes('Range: 10000 to 34000'));
    assert.match(atBoundary, /Range: 10000 to 34000/);
    assert.match(atBoundary, /at least 25 rows/);
  });

  it('keeps PII, identifier and numeric-role protections in the prompt', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      customer_id: `C-${i + 1}`,
      email: `person${i + 1}@example.com`,
      phone_number: `555-010${i}`,
      salary_usd: 90000 + i,
    }));
    const prompt = strictPrompt(rows);

    assert.ok(!prompt.includes('person1@example.com'));
    assert.ok(!prompt.includes('555-0100'));
    assert.ok(!prompt.includes('C-1'));
    assert.match(prompt, /Protected PII: Synthetic values only/);
    assert.match(prompt, /Entity Keys: High cardinality identifier/);
    assert.match(prompt, /"salary_usd" \(number, role: MEASURE\)/);
    assert.match(prompt, /"customer_id" \(string, role: IDENTIFIER\)/);

    // Default options must equal the strict options the production planner passes.
    const defaultPrompt = formatSemanticSchemaPrompt(profileDatasetSchema(saasDataset));
    assert.match(defaultPrompt, /STRICT ZERO-ROW EGRESS POLICY/);
    assert.ok(!defaultPrompt.includes('Enterprise'), 'default format may not disclose real category values');
  });

  it('keeps retry prompts free of DuckDB-quoted cell values', () => {
    const source = fs.readFileSync('src/services/aiService.ts', 'utf-8');
    assert.match(
      source,
      /lastErrors\.map\(\(e\) => `- \$\{redactCellValuesForEgress\(e\)\}`\)/,
      'every error interpolated into the correction prompt must pass through the redactor'
    );
    const scrubbed = redactCellValuesForEgress("Conversion Error: Could not convert string 'Alpha' to INT64");
    assert.ok(!scrubbed.includes("'Alpha'"));
    assert.match(scrubbed, /cell value withheld/);
  });

  it('preserves each provider transport request contract', { concurrency: false }, async (t) => {
    telemetryAuditor.clearHistory();
    t.after(() => telemetryAuditor.clearHistory());

    const seen: Record<string, { url: string; headers: Record<string, string>; body: any }> = {};
    let currentProvider: AiProvider = 'gemini';
    t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      seen[currentProvider] = {
        url: String(url),
        headers: options.headers as Record<string, string>,
        body: JSON.parse(String(options.body)),
      };
      return providerOutOfScope(currentProvider);
    });

    for (const provider of ['gemini', 'groq', 'openai'] as const) {
      currentProvider = provider;
      await processNaturalLanguageQuery('Show total mrr by plan_tier', saasDataset, config(provider));
    }

    assert.match(seen.gemini.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/);
    assert.equal(seen.gemini.headers['x-goog-api-key'], 'test-key-not-real');
    assert.ok(seen.gemini.body.contents[0].parts[0].text.includes('STRICT ZERO-ROW EGRESS POLICY'));
    assert.equal(seen.gemini.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(seen.gemini.body.generationConfig.temperature, 0.1);

    for (const provider of ['groq', 'openai'] as const) {
      const wire = seen[provider];
      assert.equal(wire.headers.Authorization, 'Bearer test-key-not-real');
      assert.equal(wire.body.model, DEFAULT_MODELS[provider]);
      assert.deepEqual(wire.body.messages.map((m: any) => m.role), ['system', 'user']);
      assert.deepEqual(wire.body.response_format, { type: 'json_object' });
      assert.equal(wire.body.temperature, 0.1);
      assert.ok(wire.body.messages[0].content.includes('STRICT ZERO-ROW EGRESS POLICY'));
    }
  });
});
