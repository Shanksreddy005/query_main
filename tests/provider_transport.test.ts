import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cancelActiveQueryProcessing, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, processNaturalLanguageQuery, setProviderRequestTimeoutForTesting } from '../src/services/aiService';
import { inferDatasetSchema } from '../src/services/sampleData';
import { DEFAULT_MODELS } from '../src/services/modelRegistry';
import { telemetryAuditor } from '../src/services/telemetryAuditor';
import type { AiProvider } from '../src/types';

const dataset = inferDatasetSchema([{ segment: 'Private Segment Sentinel', amount: 12 }], 'transport_fixture', 'Transport fixture');
const question = 'Show amount grouped by segment';
const config = (provider: AiProvider) => ({ provider, model: DEFAULT_MODELS[provider], key: 'test-key-not-real' });

function successfulResponse(provider: AiProvider): Response {
  const content = JSON.stringify({ isOutOfScope: true, outOfScopeReason: 'Mock planner stopped before engine execution.' });
  return Response.json(provider === 'gemini'
    ? { candidates: [{ content: { parts: [{ text: content }] } }] }
    : { choices: [{ message: { content } }] });
}

describe('Provider wire auditing and cancellation', { concurrency: false }, () => {
  for (const provider of ['gemini', 'groq', 'openai'] as const) {
    it(`${provider} audits the actual fetch body without transmitting dataset values or keys in URLs`, async (t) => {
      telemetryAuditor.clearHistory();
      telemetryAuditor.setCaptureWirePayloadForTesting(true);
      t.after(() => { telemetryAuditor.setCaptureWirePayloadForTesting(false); telemetryAuditor.clearHistory(); });
      let wire = '';
      t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
        assert.ok(!url.includes('test-key-not-real'));
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        wire = String(options.body);
        return successfulResponse(provider);
      });
      const result = await processNaturalLanguageQuery(question, dataset, config(provider));
      assert.equal(result.isOutOfScope, true);
      assert.ok(!wire.includes('Private Segment Sentinel'));
      const events = telemetryAuditor.getHistory();
      assert.equal(events.length, 1);
      assert.equal(events[0].wirePayloadString, wire);
      assert.equal(events[0].egressPayloadSizeBytes, new Blob([wire]).size);
      assert.equal(events[0].httpStatus, 200);
      assert.deepEqual(events[0].schemaAttributesIncluded, ['segment', 'amount']);
    });

    it(`${provider} does not retry authentication failures or retain reflected secrets`, async (t) => {
      telemetryAuditor.clearHistory();
      let attempts = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        attempts += 1;
        return new Response('reflected-secret-key Private Segment Sentinel', { status: 401 });
      });
      await assert.rejects(processNaturalLanguageQuery(question, dataset, config(provider)), (error: Error) => {
        assert.match(error.message, /401/);
        assert.match(error.message, /API key/i, 'auth failures must say the key was rejected');
        assert.match(error.message, /Settings/);
        assert.ok(!error.message.includes('reflected-secret'));
        return true;
      });
      assert.equal(attempts, 1);
      assert.equal(telemetryAuditor.getLatestEvent()?.httpStatus, 401);
      assert.ok(!JSON.stringify(telemetryAuditor.getHistory()).includes('reflected-secret'));
      telemetryAuditor.clearHistory();
    });
  }

  it('treats a Gemini 400 API_KEY_INVALID as a rejected key without retrying', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      attempts += 1;
      return Response.json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 });
    });
    await assert.rejects(processNaturalLanguageQuery(question, dataset, config('gemini')), /rejected the API key \(HTTP 400\)/);
    assert.equal(attempts, 1);
    telemetryAuditor.clearHistory();
  });

  it('retries malformed Gemini JSON but stays within three transport attempts', async (t) => {
    telemetryAuditor.clearHistory();
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      attempts += 1;
      return Response.json({ candidates: [{ content: { parts: [{ text: '{not valid JSON' }] } }] });
    });
    await assert.rejects(processNaturalLanguageQuery(question, dataset, config('gemini')), /malformed JSON/);
    assert.equal(attempts, 3);
    assert.equal(telemetryAuditor.getHistory().length, 3);
    telemetryAuditor.clearHistory();
  });

  it('cancelling an in-flight request aborts fetch and prevents subsequent attempts', async (t) => {
    telemetryAuditor.clearHistory();
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      attempts += 1;
      const pending = new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      });
      cancelActiveQueryProcessing();
      return pending;
    });
    await assert.rejects(processNaturalLanguageQuery(question, dataset, config('groq')), /cancelled/);
    assert.equal(attempts, 1);
    assert.equal(telemetryAuditor.getLatestEvent()?.error, 'Query cancelled.');
    telemetryAuditor.clearHistory();
  });

  it('aborts a provider request that never answers instead of hanging the query', async (t) => {
    setProviderRequestTimeoutForTesting(40);
    t.after(() => setProviderRequestTimeoutForTesting(null));
    let attempts = 0;
    const seen: { signal?: AbortSignal } = {};
    t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
      attempts += 1;
      seen.signal = options.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        (options.signal as AbortSignal).addEventListener('abort', () =>
          reject(new DOMException('Body Timeout Error', 'AbortError'))
        );
      });
    });

    await assert.rejects(processNaturalLanguageQuery(question, dataset, config('gemini')), (error: Error) => {
      assert.match(error.message, /did not respond within/);
      assert.match(error.message, /nothing was executed/i);
      return true;
    });
    assert.equal(attempts, 1, 'a timed-out dispatch must not fan out into a retry storm');
    assert.equal(seen.signal?.aborted, true, 'the deadline must reach the transport signal');
    assert.equal(telemetryAuditor.getLatestEvent()?.error, 'Provider request timed out.');
    telemetryAuditor.clearHistory();
  });

  it('keeps the default provider deadline above measured free-tier planning latency', () => {
    // Real gemini-3.6-flash planning calls took 13-45s; a 45s cap aborted healthy requests.
    assert.ok(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS >= 60000, `deadline ${DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS}ms is below observed latency`);
    assert.ok(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS <= 120000, 'a hung socket must still be cut off within two minutes');
  });

  it('reports a non-JSON provider body as a transport failure without echoing it', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      attempts += 1;
      return new Response('<html>gateway secret-trace-token kept out of the ui</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    await assert.rejects(processNaturalLanguageQuery(question, dataset, config('gemini')), (error: Error) => {
      assert.match(error.message, /not valid JSON/);
      assert.match(error.message, /No SQL was generated and nothing was executed/i);
      assert.ok(!error.message.includes('secret-trace-token'), 'the raw gateway body must not be echoed');
      assert.ok(!error.message.includes('Expected'), `the engine parser message leaked to the user: ${error.message}`);
      return true;
    });
    assert.equal(attempts, 3, 'malformed JSON must stay inside the bounded attempt budget');
    telemetryAuditor.clearHistory();
  });

  it('cancelling a retry notice stops the backoff before a second HTTP request', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      attempts += 1;
      return new Response('busy', { status: 503 });
    });
    await assert.rejects(processNaturalLanguageQuery(question, dataset, config('gemini'), (step) => {
      if (step.title === 'Transient Retry & Backoff' && /server is busy/.test(step.detail)) {
        cancelActiveQueryProcessing();
      }
    }), /cancelled/);
    assert.equal(attempts, 1);
    telemetryAuditor.clearHistory();
  });
});
